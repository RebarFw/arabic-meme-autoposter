import { BufferClient } from './buffer';
import { apifyBudgetStatus } from './apify-budget';
import { CloudflareUsageError, cleanupCloudflareReservations, cloudflareCapacity, requireCloudflareCapacity, withCloudflareR2Guard } from './cloudflare-usage';
import { probeCloudflareGuard } from './cloudflare-probe';
import { diagnoseDownload, probeApifyDownload, probeThirdPartyDownload } from './download-diagnostics';
import { enqueue, maintenance, processJob, refreshPosts, retryDownload, saveSetting, settings } from './jobs';
import { metaRequest, parseMessages } from './meta';
import { diagnoseMeta } from './meta-diagnostics';
import { acceptOwnerSetup, diagnoseOwnerSetup, finishOwnerSetup, importOwnerSetup, ownerSetupStatus, startOwnerSetup } from './owner-setup';
import { serveMedia } from './media';
import { initializePolling, pollInstagram, pollingStatus, validatePolling } from './instagram-polling';
import { privacyResponse } from './privacy';
import { approvedSenders, senderSlot, sendersReady } from './senders';
import { constantTimeEqual, limitedBytes, validSignature } from './security';
import { AppError, errorCode, log, type Channel, type Env } from './types';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function admin(request: Request, env: Env, path: string): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  if (!env.ADMIN_TOKEN || !auth.startsWith('Bearer ') || !await constantTimeEqual(auth.slice(7), env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
  const slot = senderSlot(new URL(request.url).searchParams.get('slot'));
  if (path === '/admin/cloudflare/usage' && request.method === 'GET') return json(await cloudflareCapacity(env));
  if (path === '/admin/cloudflare/validate' && request.method === 'GET') {
    try { return json(await cloudflareCapacity({ ...env, CLOUDFLARE_USAGE_GUARD: 'true' })); }
    catch (error) { if (error instanceof CloudflareUsageError) return json({ error: error.code, facts: error.facts }, 503); throw error; }
  }
  if (path === '/admin/cloudflare/probe' && request.method === 'POST') return json(await probeCloudflareGuard(env));
  // Operator recovery reads only Meta; it does not use D1, R2 or publishing.
  // Keep this diagnostic available when the analytics reader needs repair.
  if (path === '/admin/meta/diagnose' && request.method === 'GET') return json(await diagnoseMeta(env));
  if (!['/admin/status', '/admin/apify/budget', '/admin/owner/status'].includes(path)) await requireCloudflareCapacity(env);
  if (path === '/admin/owner/start' && request.method === 'POST') return json(await startOwnerSetup(env, slot));
  if (path === '/admin/owner/import' && request.method === 'POST') return json(await importOwnerSetup(env, JSON.parse(new TextDecoder().decode(await limitedBytes(request.body, 2048))), slot));
  if (path === '/admin/owner/status' && request.method === 'GET') return json(await ownerSetupStatus(env, slot));
  if (path === '/admin/owner/diagnose' && request.method === 'GET') return json(await diagnoseOwnerSetup(env, slot));
  if (path === '/admin/owner/finish' && request.method === 'POST') { await finishOwnerSetup(env, slot); if (sendersReady(env)) await initializePolling(env); return json({ installed: true, slot, allowlistCount: approvedSenders(env).length }); }
  if (path === '/admin/poll' && request.method === 'POST') { await pollInstagram(env); return json(await pollingStatus(env)); }
  if (path === '/admin/poll/validate' && request.method === 'GET') return json(await validatePolling(env));
  if (path === '/admin/jobs/retry-download' && request.method === 'POST') {
    const body = JSON.parse(new TextDecoder().decode(await limitedBytes(request.body, 8192)));
    let resolved: { reelUrl: string; videoUrl: string } | undefined;
    if (body?.resolved !== undefined) {
      if (typeof body.resolved?.reelUrl !== 'string' || typeof body.resolved?.videoUrl !== 'string') throw new AppError('invalid_recovery_source');
      resolved = { reelUrl: body.resolved.reelUrl, videoUrl: body.resolved.videoUrl };
    }
    await retryDownload(env, typeof body?.jobId === 'string' ? body.jobId : '', resolved);
    return json({ queued: true, jobId: body.jobId });
  }
  if (path === '/admin/jobs/refresh-posts' && request.method === 'POST') {
    const body = JSON.parse(new TextDecoder().decode(await limitedBytes(request.body, 1024)));
    await refreshPosts(env, typeof body?.jobId === 'string' ? body.jobId : '');
    return json({ checked: true, jobId: body.jobId });
  }
  if (path === '/admin/download/diagnose' && request.method === 'GET') {
    const route = new URL(request.url).searchParams.get('route');
    return json(await diagnoseDownload(env, route === 'post' || route === 'embed' ? route : 'reel'));
  }
  if (path === '/admin/download/probe' && request.method === 'POST') {
    const body = JSON.parse(new TextDecoder().decode(await limitedBytes(request.body, 512)));
    return json(await probeThirdPartyDownload(env, typeof body?.provider === 'string' ? body.provider : ''));
  }
  if (path === '/admin/download/probe-apify' && request.method === 'POST') return json(await probeApifyDownload(env));
  if (path === '/admin/apify/budget' && request.method === 'GET') return json(await apifyBudgetStatus(env));
  if (path === '/admin/apify/enforce-limit' && request.method === 'POST') return json(await apifyBudgetStatus(env, true));
  if (path === '/admin/meta/subscribe' && request.method === 'POST') return json(await diagnoseMeta(env, true));
  if (path === '/admin/setup' && request.method === 'POST') {
    const channels = await new BufferClient(env).discoverChannels();
    let recipients = [channels[0].serviceId];
    if (env.META_ACCESS_TOKEN) {
      const me = await metaRequest<{ id?: string; user_id?: string; username?: string }>(env, 'me?fields=id,user_id,username');
      if (!me.username || me.username.toLowerCase().replace(/^@/, '') !== channels[0].name.toLowerCase().replace(/^@/, '')) throw new AppError('meta_buffer_account_mismatch');
      if (![me.id, me.user_id].includes(channels[0].serviceId)) throw new AppError('meta_buffer_account_id_mismatch');
      recipients = [...new Set([me.user_id, me.id, channels[0].serviceId].filter((id): id is string => !!id))];
    }
    if (recipients.some(id => !/^\d+$/.test(id))) throw new AppError('invalid_instagram_account_id');
    await saveSetting(env, 'channels', channels);
    await saveSetting(env, 'recipient_ids', recipients);
    if (env.META_ACCESS_TOKEN) {
      const subscription = await metaRequest<{ success?: boolean }>(env, `${encodeURIComponent(recipients[0]!)}/subscribed_apps`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'subscribed_fields=messages',
      });
      if (!subscription.success) throw new AppError('meta_subscription_failed');
    }
    return json({ channels: channels.map(c => ({ service: c.service, id: c.id, name: c.name })), recipients, metaSubscribed: !!env.META_ACCESS_TOKEN, webhook: `${env.PUBLIC_BASE_URL}/webhooks/instagram` });
  }
  if (path === '/admin/status' && request.method === 'GET') {
    const jobs = await env.DB.prepare('SELECT id,state,error_code,created_at,updated_at FROM jobs ORDER BY created_at DESC LIMIT 20').all();
    const deliveryRows = await env.DB.prepare('SELECT job_id,service,state,post_id,post_status,error_code FROM deliveries WHERE job_id IN (SELECT id FROM jobs ORDER BY created_at DESC LIMIT 20)').all();
    return json({ configured: { buffer: !!env.BUFFER_API_KEY, metaSecret: !!env.META_APP_SECRET, metaAccess: !!env.META_ACCESS_TOKEN, owner: !!env.OWNER_IG_SENDER_ID, friend: !!env.FRIEND_IG_SENDER_ID, allowlistCount: approvedSenders(env).length, publishingReady: sendersReady(env), channels: !!await settings<Channel[]>(env,'channels') }, polling: await pollingStatus(env), jobs: jobs.results, deliveries: deliveryRows.results });
  }
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env = withCloudflareR2Guard(env);
    const path = new URL(request.url).pathname;
    try {
      if (path === '/privacy' || path === '/privacy/') return privacyResponse(request.method);
      if (path === '/health' && ['GET','HEAD'].includes(request.method)) return json({ ok: true, service: 'arabic-meme-autoposter' });
      if (path.startsWith('/admin/')) return await admin(request, env, path);
      const media = /^\/media\/([a-f0-9]{64})\.mp4$/.exec(path);
      if (media && ['GET','HEAD'].includes(request.method)) return await serveMedia(request, env, media[1]!);
      if (path !== '/webhooks/instagram') return json({ error: 'not_found' },404);
      if (request.method === 'GET') {
        const params = new URL(request.url).searchParams;
        const token = params.get('hub.verify_token') ?? '';
        const challenge = params.get('hub.challenge');
        if (!env.META_VERIFY_TOKEN) return json({ error: 'verification_not_configured' },503);
        if (params.get('hub.mode') !== 'subscribe' || !challenge || challenge.length > 1024 || !await constantTimeEqual(token, env.META_VERIFY_TOKEN)) return json({ error: 'forbidden' },403);
        return new Response(challenge, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
      }
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' },405);
      if (!env.META_APP_SECRET) return json({ error: 'signature_not_configured' },503);
      if (Number(request.headers.get('content-length')) > 256_000) return json({ error: 'body_too_large' },413);
      const body = await limitedBytes(request.body, 256_000);
      if (!await validSignature(body, request.headers.get('x-hub-signature-256'), env.META_APP_SECRET)) { log('webhook_signature_rejected'); return json({ error: 'invalid_signature' },403); }
      log('webhook_authenticated');
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(body)); } catch { return json({ error: 'invalid_json' },400); }
      if (await acceptOwnerSetup(env, payload)) return json({ received: true, ownerSetup: true });
      if (env.INGEST_MODE === 'polling') return json({ received: true, ingestMode: 'polling' });
      // Until an owner is explicitly installed, no inbound event is authorized
      // to publish. Acknowledge synthetic tests and irrelevant notifications;
      // making Meta retry these cannot improve setup and creates a retry storm.
      if (!sendersReady(env)) return json({ received: true, publishingReady: false });
      const recipients = await settings<string[]>(env, 'recipient_ids');
      if (!recipients) return json({ error: 'publishing_not_configured' },503);
      const sources = parseMessages(payload, approvedSenders(env), recipients);
      // Only an approved, relevant Reel needs a retry during a configuration
      // outage. Stranger DMs and synthetic samples always create zero jobs.
      if (sources.length && (!env.BUFFER_API_KEY || !env.PUBLIC_BASE_URL || env.REPOST_PERMISSION_CONFIRMED !== 'true')) return json({ error: 'publishing_not_configured' },503);
      // Acknowledge only after all jobs are durable. Meta retries are INSERT OR IGNORE.
      const jobIds: string[] = [];
      for (const source of sources) jobIds.push(await enqueue(env, { ...source, recipientId: recipients[0]! }));
      if (jobIds.length) ctx.waitUntil((async () => {
        for (const jobId of [...new Set(jobIds)]) await processJob(env, jobId);
      })().catch(error => log('background_failed', { code: errorCode(error) })));
      return json({ received: true });
    } catch (error) {
      const code = errorCode(error);
      log('request_failed', { code });
      return json({ error: code }, code === 'body_too_large' ? 413 : 503);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    env = withCloudflareR2Guard(env);
    ctx.waitUntil((async () => {
      const capacity = await cloudflareCapacity(env);
      if (!capacity.allowed) {
        // R2 operations/storage can pause while free deletes remain useful.
        // If the daily Workers/D1 budget is low, leave cleanup to lifecycle.
        if (capacity.code?.startsWith('cloudflare_r2_')) await cleanupCloudflareReservations(env);
        log('cloudflare_quota_paused', { code: capacity.code }); return;
      }
      await initializePolling(env); await pollInstagram(env); await maintenance(env);
    })().catch(error => log('maintenance_failed', { code: errorCode(error) })));
  },
} satisfies ExportedHandler<Env>;
