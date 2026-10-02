import { BufferClient, definiteBufferRejection } from './buffer';
import { senderAllowed } from './senders';
import { createCaption } from './caption';
import { cloudflareCapacity, requireCloudflareCapacity } from './cloudflare-usage';
import { downloadVideo } from './downloaders';
import { notifyOwner } from './meta';
import { storeVideo, temporaryMediaUrl } from './media';
import { META_MEDIA_HOSTS, reelUrl, secureUrl, sha256 } from './security';
import { AppError, errorCode, log, type Channel, type Delivery, type Env, type Job, type ReelSource } from './types';

export async function settings<T>(env: Env, key: string): Promise<T | null> {
  const result = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return result ? JSON.parse(result.value) as T : null;
}

export async function saveSetting(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, JSON.stringify(value)).run();
}

export async function enqueue(env: Env, source: ReelSource): Promise<string> {
  await requireCloudflareCapacity(env);
  if (!senderAllowed(env, source.senderId)) throw new AppError('sender_not_authorized');
  const messageHash = await sha256(`${source.recipientId}:${source.messageId}`);
  const existing = await env.DB.prepare('SELECT job_id FROM message_tombstones WHERE message_hash=?').bind(messageHash).first<{ job_id: string }>();
  if (existing) return existing.job_id;
  const canonical = reelUrl(source.reelUrl);
  const reelKey = canonical ? `reel:${new URL(canonical).pathname.split('/')[2]}` : source.mediaId ? `media:${source.mediaId}` : `message:${source.messageId}`;
  const jobId = await sha256(`${source.recipientId}:${reelKey}`);
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO message_tombstones(message_hash,job_id,created_at) VALUES (?,?,?)').bind(messageHash, jobId, now),
    env.DB.prepare(`INSERT OR IGNORE INTO jobs(id, source_json, recipient_id, next_run_at, created_at, updated_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM message_tombstones WHERE message_hash=? AND job_id=?)`)
      .bind(jobId, JSON.stringify(source), source.recipientId, now, now, now, messageHash, jobId),
  ]);
  const result = results[1]!;
  log(result.meta.changes ? 'job_received' : 'duplicate_ignored', { job: jobId });
  return (await env.DB.prepare('SELECT job_id FROM message_tombstones WHERE message_hash=?').bind(messageHash).first<{ job_id: string }>())!.job_id;
}

export async function retryDownload(env: Env, id: string, resolved?: { reelUrl: string; videoUrl: string }): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new AppError('invalid_job_id');
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first<Job>();
  if (!job?.source_json) throw new AppError('download_retry_not_safe');
  const source: ReelSource = JSON.parse(job.source_json);
  const recipients = await settings<string[]>(env, 'recipient_ids');
  if (source.kind !== 'reel' || !senderAllowed(env, source.senderId) || !recipients?.includes(source.recipientId) || !Number.isFinite(source.timestamp) || source.timestamp < Date.now() - 48 * 3600_000 || source.timestamp > Date.now() + 300_000) throw new AppError('download_retry_not_safe');
  let updatedSource = job.source_json;
  if (resolved) {
    const original = reelUrl(source.reelUrl);
    if (!original || reelUrl(resolved.reelUrl) !== original) throw new AppError('recovery_reel_mismatch');
    const videoUrl = secureUrl(resolved.videoUrl, META_MEDIA_HOSTS);
    // This is an operator-provided resolution of the EXISTING authorized DM,
    // never a new upload trigger. Normal downloader validation still applies.
    updatedSource = JSON.stringify({ ...source, attachmentUrl: videoUrl.href });
  }
  // Reuse the same permanent job. A Buffer reservation of ANY state makes
  // this operation unavailable; uncertain submissions must be reconciled.
  const now = Date.now();
  const result = await env.DB.prepare(`UPDATE jobs SET source_json=?,state='pending',error_code=NULL,attempts=0,next_run_at=?,lease_token=NULL,lease_until=0,updated_at=?
    WHERE id=? AND state='attention' AND object_key IS NULL AND lease_until<=? AND source_json=?
    AND NOT EXISTS (SELECT 1 FROM deliveries WHERE job_id=?)`)
    .bind(updatedSource, now, now, id, now, job.source_json, id).run();
  if (!result.meta.changes) throw new AppError('download_retry_not_safe');
  log('download_retry_queued', { job: id });
}

export async function refreshPosts(env: Env, id: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new AppError('invalid_job_id');
  // Expedite only the read/reconciliation stage. Existing reservations and
  // permanent job state prevent this control from ever creating another post.
  const now = Date.now();
  const result = await env.DB.prepare("UPDATE jobs SET next_run_at=? WHERE id=? AND state='waiting' AND lease_until<=?")
    .bind(now, id, now).run();
  if (!result.meta.changes) throw new AppError('post_refresh_not_available');
  await processJob(env, id);
}

export async function retryRejectedDelivery(env: Env, id: string, service: string): Promise<void> {
  await requireCloudflareCapacity(env);
  if (!/^[a-f0-9]{64}$/.test(id) || !['instagram', 'tiktok'].includes(service)) throw new AppError('delivery_retry_not_safe');
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first<Job>();
  if (!job?.source_json || job.state !== 'failed' || job.object_key || job.media_token || job.lease_until > Date.now()) throw new AppError('delivery_retry_not_safe');
  const source: ReelSource = JSON.parse(job.source_json);
  const recipients = await settings<string[]>(env, 'recipient_ids');
  if (source.kind !== 'reel' || !senderAllowed(env, source.senderId) || !recipients?.includes(source.recipientId) || !Number.isFinite(source.timestamp) || source.timestamp < Date.now() - 48 * 3600_000 || source.timestamp > Date.now() + 300_000) throw new AppError('delivery_retry_not_safe');
  const rows = await deliveries(env, id), rejected = rows.find(row => row.service === service), sent = rows.find(row => row.service !== service);
  if (rows.length !== 2 || rejected?.state !== 'failed' || rejected.post_id || !definiteBufferRejection(rejected.error_code) || sent?.state !== 'accepted' || sent.post_status !== 'sent' || !sent.post_id) throw new AppError('delivery_retry_not_safe');
  const client = new BufferClient(env), pair = await client.discoverChannels();
  if (rows.some(row => !pair.some(channel => channel.service === row.service && channel.id === row.channel_id))) throw new AppError('buffer_channel_identity_mismatch');
  const published = await client.post(sent.post_id);
  if (published.id !== sent.post_id || published.status !== 'sent' || published.schedulingType !== 'automatic') throw new AppError('delivery_retry_not_safe');
  const now = Date.now(), reservation = crypto.randomUUID();
  // Transactional reservation excludes cron and concurrent operator retries.
  // Keep the successful delivery and every dedupe tombstone untouched.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE jobs SET lease_token=?,lease_until=? WHERE id=? AND state='failed' AND source_json=? AND object_key IS NULL AND media_token IS NULL AND lease_until<=?
      AND EXISTS (SELECT 1 FROM deliveries WHERE job_id=? AND service=? AND state='failed' AND post_id IS NULL AND error_code=?)
      AND EXISTS (SELECT 1 FROM deliveries WHERE job_id=? AND service=? AND state='accepted' AND post_status='sent' AND post_id=?)`)
      .bind(reservation, now + 180_000, id, job.source_json, now, id, service, rejected.error_code, id, sent.service, sent.post_id),
    env.DB.prepare(`UPDATE deliveries SET state='pending',error_code=NULL,updated_at=? WHERE job_id=? AND service=? AND state='failed' AND post_id IS NULL AND error_code=?
      AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND lease_token=?)`)
      .bind(now, id, service, rejected.error_code, id, reservation),
    env.DB.prepare(`UPDATE jobs SET state='pending',error_code=NULL,attempts=0,next_run_at=?,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_token=?
      AND EXISTS (SELECT 1 FROM deliveries WHERE job_id=? AND service=? AND state='pending' AND post_id IS NULL)`)
      .bind(now, now, id, reservation, id, service),
  ]);
  if (results.some(result => result.meta.changes !== 1)) throw new AppError('delivery_retry_not_safe');
  log('rejected_delivery_retry_queued', { job: id, service });
}

export async function claimJob(env: Env, id: string, now = Date.now()): Promise<Job | null> {
  const lease = crypto.randomUUID();
  return env.DB.prepare(`UPDATE jobs SET lease_token=?, lease_until=?, updated_at=?
    WHERE id=? AND state IN ('pending','ready','waiting') AND next_run_at<=? AND lease_until<=? RETURNING *`)
    .bind(lease, now + 180_000, now, id, now, now).first<Job>();
}

async function updateJob(env: Env, job: Job, state: string, code: string | null = null, delay = 0): Promise<void> {
  const now = Date.now();
  await env.DB.prepare('UPDATE jobs SET state=?, error_code=?, next_run_at=?, lease_token=NULL, lease_until=0, updated_at=? WHERE id=? AND lease_token=?')
    .bind(state, code, now + delay, now, job.id, job.lease_token).run();
}

async function removeMedia(env: Env, job: Job): Promise<void> {
  if (job.object_key) await env.MEDIA.delete(job.object_key);
  await env.DB.prepare('UPDATE jobs SET object_key=NULL, media_token=NULL, media_expires_at=NULL WHERE id=?').bind(job.id).run();
}

async function download(env: Env, job: Job): Promise<void> {
  if (!job.source_json) throw new AppError('job_source_missing');
  const channels = await settings<Channel[]>(env, 'channels');
  if (!channels || channels.length !== 2) throw new AppError('channels_not_configured', true);
  const source: ReelSource = JSON.parse(job.source_json);
  if (!senderAllowed(env, source.senderId)) throw new AppError('sender_not_authorized');
  const caption = job.caption ?? await createCaption(job.id);
  const key = `arabic-meme-autoposter/${job.id}.mp4`;
  const token = crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-','');
  const ttl = Math.min(Math.max(Number(env.MEDIA_TTL_SECONDS) || 86400, 3600), 172800);
  const expires = Date.now() + ttl * 1000;
  // Persist cleanup info before upload; a killed invocation cannot leave an untracked object.
  const prepared = await env.DB.prepare('UPDATE jobs SET object_key=?, media_token=?, media_expires_at=?, caption=?, attempts=attempts+1 WHERE id=? AND lease_token=?')
    .bind(key, token, expires, caption, job.id, job.lease_token).run();
  if (!prepared.meta.changes) return;
  const video = await downloadVideo(source, env, job.id);
  const bytes = await storeVideo(env, video.response, key, expires);
  await env.DB.batch(channels.map(c => env.DB.prepare('INSERT OR IGNORE INTO deliveries(job_id, service, channel_id, updated_at) VALUES (?,?,?,?)').bind(job.id, c.service, c.id, Date.now())));
  log('media_stored', { job: job.id, provider: video.provider, bytes });
  await updateJob(env, job, 'ready');
}

async function deliveries(env: Env, id: string): Promise<Delivery[]> {
  return (await env.DB.prepare('SELECT * FROM deliveries WHERE job_id=? ORDER BY service').bind(id).all<Delivery>()).results;
}

async function publish(env: Env, job: Job): Promise<void> {
  if (!job.object_key || !job.media_expires_at || job.media_expires_at <= Date.now() || !await env.MEDIA.head(job.object_key)) throw new AppError('media_missing_or_expired');
  const client = new BufferClient(env);
  if (env.EXPECTED_INSTAGRAM_CHANNEL_ID || env.EXPECTED_TIKTOK_CHANNEL_ID) await client.discoverChannels();
  for (const delivery of await deliveries(env, job.id)) {
    if (delivery.state !== 'pending') continue;
    // Atomic permanent reservation BEFORE calling Buffer. An expired lease cannot re-submit.
    const reserved = await env.DB.prepare(`UPDATE deliveries SET state='submitting', updated_at=? WHERE job_id=? AND service=? AND state='pending'
      AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND lease_until>?)`)
      .bind(Date.now(), job.id, delivery.service, job.id, job.lease_token, Date.now()).run();
    if (!reserved.meta.changes) continue;
    try {
      const post = await client.publish(delivery.channel_id, delivery.service, job.caption!, temporaryMediaUrl(env, job));
      const state = post.schedulingType !== 'automatic' || !['scheduled','sending','sent'].includes(post.status) ? 'failed' : 'accepted';
      await env.DB.prepare('UPDATE deliveries SET state=?, post_id=?, post_status=?, error_code=?, updated_at=? WHERE job_id=? AND service=?')
        .bind(state, post.id, post.status, state === 'failed' ? 'buffer_not_automatic' : null, Date.now(), job.id, delivery.service).run();
      log('buffer_accepted', { job: job.id, service: delivery.service });
    } catch (error) {
      const code = errorCode(error);
      await env.DB.prepare('UPDATE deliveries SET state=?, error_code=?, updated_at=? WHERE job_id=? AND service=?')
        .bind(definiteBufferRejection(code) ? 'failed' : 'unknown', code, Date.now(), job.id, delivery.service).run();
      log('buffer_submit_failed', { job: job.id, service: delivery.service, code });
    }
  }
  const current = await deliveries(env, job.id);
  if (current.length !== 2) throw new AppError('deliveries_missing');
  log('buffer_submission_summary', { job: job.id, bothAccepted: current.every(d => d.state === 'accepted') });
  await updateJob(env, job, 'waiting', null, 60_000);
}

async function checkPosts(env: Env, job: Job): Promise<void> {
  const client = new BufferClient(env);
  for (const delivery of await deliveries(env, job.id)) {
    if (delivery.state !== 'accepted' || !delivery.post_id || delivery.post_status === 'sent') continue;
    const post = await client.post(delivery.post_id);
    const failed = post.schedulingType !== 'automatic' || ['error','draft','needs_approval'].includes(post.status);
    await env.DB.prepare('UPDATE deliveries SET post_status=?, state=?, error_code=?, updated_at=? WHERE job_id=? AND service=?')
      .bind(post.status, failed ? 'failed' : 'accepted', failed ? 'buffer_publish_failed' : null, Date.now(), job.id, delivery.service).run();
  }
  const current = await deliveries(env, job.id);
  if (current.length === 2 && current.every(d => d.state === 'accepted' && d.post_status === 'sent')) {
    await removeMedia(env, job);
    await updateJob(env, job, 'completed');
    log('job_completed', { job: job.id, bothPublished: true });
    // Notification failure must never cause a post or a job retry.
    if (!job.notified && job.source_json && env.ENABLE_OWNER_DM === 'true') {
      const source: ReelSource = JSON.parse(job.source_json);
      try { await notifyOwner(env, job.recipient_id, source.timestamp, source.senderId); }
      catch (error) { log('owner_notification_failed', { job: job.id, code: errorCode(error) }); }
      await env.DB.prepare('UPDATE jobs SET notified=1 WHERE id=?').bind(job.id).run();
    }
    return;
  }
  const needsMedia = current.some(d => d.state === 'accepted' && d.post_status !== 'sent');
  const unknown = current.some(d => ['unknown','submitting'].includes(d.state));
  if (!needsMedia && !unknown) {
    await removeMedia(env, job);
    await updateJob(env, job, 'failed', 'one_or_both_posts_failed');
  } else if (!needsMedia && unknown) {
    await updateJob(env, job, 'attention', 'buffer_submission_uncertain');
    log('job_needs_attention', { job: job.id, code: 'buffer_submission_uncertain' });
  } else await updateJob(env, job, 'waiting', unknown ? 'buffer_submission_uncertain' : null, Date.now() - job.created_at > 600_000 ? 3600_000 : 60_000);
}

export async function processJob(env: Env, id: string): Promise<void> {
  if (!env.BUFFER_API_KEY || !env.PUBLIC_BASE_URL || env.REPOST_PERMISSION_CONFIRMED !== 'true') return;
  if (!(await cloudflareCapacity(env)).allowed) return;
  // Process short stages immediately; durable cron recovery handles slow/killed invocations.
  for (let i = 0; i < 3; i++) {
    const job = await claimJob(env, id);
    if (!job) return;
    try {
      if (job.state === 'pending') await download(env, job);
      else if (job.state === 'ready') await publish(env, job);
      else await checkPosts(env, job);
    } catch (error) {
      const code = errorCode(error);
      if (code.startsWith('cloudflare_')) {
        // A concurrent quota reservation can stop a stage after its initial
        // capacity check. Preserve it for resumption and keep retry allowance.
        if (job.state === 'pending') await env.DB.prepare('UPDATE jobs SET attempts=? WHERE id=? AND lease_token=?').bind(job.attempts, job.id, job.lease_token).run();
        await updateJob(env, job, job.state, code, 60_000);
        log('job_quota_paused', { job: job.id, stage: job.state, code });
        return;
      }
      const retry = (!(error instanceof AppError) || error.retryable) && (job.state !== 'pending' || job.attempts < 4);
      log('job_stage_failed', { job: job.id, stage: job.state, code: errorCode(error), retry });
      // Re-read cleanup metadata written during this stage.
      const latest = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(job.id).first<Job>();
      if (!retry && job.state === 'pending' && latest) await removeMedia(env, latest);
      const delay = job.state === 'waiting' ? 3600_000 : Math.min(3600_000, 60_000 * 2 ** job.attempts);
      await updateJob(env, job, retry ? job.state : 'attention', errorCode(error), retry ? delay : 0);
      return;
    }
  }
}

export async function maintenance(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM settings WHERE key IN ('owner_setup','friend_setup') AND json_extract(value, '$.expiresAt')<=?").bind(now).run();
  const expired = (await env.DB.prepare('SELECT * FROM jobs WHERE media_expires_at<=? AND object_key IS NOT NULL LIMIT 20').bind(now).all<Job>()).results;
  for (const job of expired) {
    await removeMedia(env, job);
    if (job.state !== 'completed' && job.state !== 'failed') {
      await env.DB.prepare("UPDATE jobs SET state='attention', error_code='media_expired', updated_at=? WHERE id=?").bind(now, job.id).run();
    }
    log('expired_media_deleted', { job: job.id });
  }
  // Age out pre-upload/failed jobs and erase private source URLs, but retain dedupe tombstones forever.
  await env.DB.prepare("UPDATE jobs SET state='attention', error_code='job_stuck', lease_until=0 WHERE state IN ('pending','ready','waiting') AND created_at<?").bind(now - 48 * 3600_000).run();
  await env.DB.prepare("UPDATE jobs SET source_json=NULL, caption=NULL WHERE state IN ('completed','failed','attention') AND updated_at<? AND source_json IS NOT NULL").bind(now - 48 * 3600_000).run();
  const lastSweep = await settings<number>(env, 'last_media_sweep') ?? 0;
  if (now - lastSweep >= 3600_000) {
    const cursor = await settings<string>(env, 'media_sweep_cursor');
    const page = await env.MEDIA.list({ prefix: 'arabic-meme-autoposter/', limit: 100, include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
    const expiredKeys = page.objects.filter(o => Number(o.customMetadata?.expiresAt || o.uploaded.getTime() + 48 * 3600_000) <= now).map(o => o.key);
    if (expiredKeys.length) await env.MEDIA.delete(expiredKeys);
    await saveSetting(env, 'media_sweep_cursor', page.truncated ? page.cursor : null);
    await saveSetting(env, 'last_media_sweep', now);
  }
  const due = (await env.DB.prepare("SELECT id FROM jobs WHERE state IN ('pending','ready','waiting') AND next_run_at<=? AND lease_until<=? ORDER BY next_run_at LIMIT 3").bind(now,now).all<{ id: string }>()).results;
  for (const job of due) await processJob(env, job.id);
}
