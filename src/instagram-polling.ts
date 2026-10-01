import { apiConversations, apiId, apiItems, apiMessage, apiMessageList, apiObject, apiTimestamp, parseApiMessage } from './instagram-api';
import { evidence, inspect } from './meta-diagnostics';
import { reelUrl } from './security';
import { enqueue, processJob, settings } from './jobs';
import { sha256 } from './security';
import { AppError, errorCode, log, type Env } from './types';
import { cloudflareCapacity } from './cloudflare-usage';
import { approvedSenders, sendersReady } from './senders';

interface PollState {
  startedAt: number;
  formatVersion?: number;
  leaseToken?: string | null;
  leaseUntil?: number;
  nextAt?: number;
  lastSuccessAt?: number;
  lastErrorCode?: string | null;
  errors?: number;
  seen?: string[];
  versions?: Record<string, string>;
  inspected?: number;
  received?: number;
  nextSender?: number;
}
// A parsing change rechecks the bounded recent IDs. Permanent D1 job tombstones
// still prevent external posts from being created again for an existing DM.
const POLL_FORMAT_VERSION = 3;

export async function initializePolling(env: Env): Promise<void> {
  if (env.INGEST_MODE !== 'polling' || !sendersReady(env)) return;
  await env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('instagram_poll',?)")
    .bind(JSON.stringify({ startedAt: Date.now(), formatVersion: POLL_FORMAT_VERSION, seen: [], versions: {} } satisfies PollState)).run();
}

export async function pollingStatus(env: Env) {
  const state = await settings<PollState>(env, 'instagram_poll');
  return { mode: env.INGEST_MODE ?? 'webhook', initialized: !!state, startedAt: state?.startedAt, lastSuccessAt: state?.lastSuccessAt, nextAt: state?.nextAt, lastErrorCode: state?.lastErrorCode, inspected: state?.inspected ?? 0, received: state?.received ?? 0 };
}

export async function validatePolling(env: Env) {
  if (!sendersReady(env)) throw new AppError('two_senders_not_configured');
  const conversations = [];
  for (const [index, sender] of approvedSenders(env).entries()) conversations.push({ slot: index === 0 ? 'owner' : 'friend', ...await validateConversation(env, sender) });
  return { allowlistCount: 2, conversations };
}

async function validateConversation(env: Env, sender: string) {
  const conversations = await apiConversations(env, sender);
  if (!conversations.length) return { ownerConversationFound: false, messageFieldsReadable: false };
  const messages = await apiMessageList(env, apiId(conversations[0]!.id)!);
  const latest = messages.sort((a, b) => apiTimestamp(b.created_time) - apiTimestamp(a.created_time))[0];
  if (!latest) return { ownerConversationFound: true, messageFieldsReadable: false };
  const message = await apiMessage(env, apiId(latest.id)!, true);
  const messageId = encodeURIComponent(apiId(latest.id)!);
  const [attachments, shareEdge, linkShare] = await Promise.all([
    inspect(env, `${messageId}?fields=id,attachments{file_url,image_data,video_data,generic_template,name,id}`),
    inspect(env, `${messageId}/shares?fields=type,url,id,name`),
    inspect(env, `${messageId}?fields=shares{link}`),
  ]);
  const recipients = await settings<string[]>(env, 'recipient_ids') ?? [];
  const shareItems = apiItems(message.shares);
  const attachmentItems = apiItems(attachments.body.attachments);
  // Fixed structural facts only. Do not return contents, sender/message IDs,
  // signed CDN URLs, names or generic template text to the diagnostic client.
  return {
    ownerConversationFound: true, messageFieldsReadable: true, sharesFieldAccepted: true, sharedMediaPresent: Object.hasOwn(message, 'shares'),
    latest: { createdAt: Number.isFinite(apiTimestamp(message.created_time)) ? new Date(apiTimestamp(message.created_time)).toISOString() : undefined, fromOwner: apiObject(message.from).id === sender, toOwnAccount: apiItems(message.to).some(item => recipients.includes(String(item.id))), textLength: typeof message.message === 'string' ? message.message.length : 0, textHasReelUrl: typeof message.message === 'string' && /https:\/\/(?:www\.)?instagram\.com\/reels?\//.test(message.message), parsedReels: parseApiMessage(message, approvedSenders(env), recipients, 0).length },
    shares: { count: shareItems.length, types: shareItems.map(item => ['post', 'reel', 'ig_post', 'ig_reel'].includes(String(item.type)) ? item.type : 'other'), hasReelPermalink: shareItems.some(item => !!reelUrl(item.link) || !!reelUrl(item.url)) },
    attachments: { ...evidence(attachments), count: attachmentItems.length, items: attachmentItems.map(item => ({ fileUrl: typeof item.file_url === 'string', videoData: !!item.video_data, imageData: !!item.image_data, genericTemplate: !!item.generic_template, fields: ['file_url', 'video_data', 'image_data', 'generic_template', 'id', 'name'].filter(key => Object.hasOwn(item, key)) })) },
    sharesEdge: { ...evidence(shareEdge), count: apiItems(shareEdge.body.data).length },
    linkShare: { ...evidence(linkShare), count: apiItems(linkShare.body.shares).length, hasReelPermalink: apiItems(linkShare.body.shares).some(item => !!reelUrl(item.link)) },
  };
}

export async function pollInstagram(env: Env): Promise<void> {
  if (env.INGEST_MODE !== 'polling') return;
  if (!(await cloudflareCapacity(env)).allowed) return;
  await initializePolling(env);
  if (!sendersReady(env) || !env.META_ACCESS_TOKEN || !env.BUFFER_API_KEY || env.REPOST_PERMISSION_CONFIRMED !== 'true') return;
  const recipients = await settings<string[]>(env, 'recipient_ids');
  if (!recipients?.length || !await settings(env, 'channels')) return;
  const now = Date.now();
  const lease = crypto.randomUUID();
  const row = await env.DB.prepare(`UPDATE settings SET value=json_set(value, '$.leaseToken', ?, '$.leaseUntil', ?)
    WHERE key='instagram_poll' AND COALESCE(json_extract(value,'$.leaseUntil'),0)<=?
    AND COALESCE(json_extract(value,'$.nextAt'),0)<=? RETURNING value`)
    .bind(lease, now + 180_000, now, now).first<{ value: string }>();
  if (!row) return;
  const state: PollState = JSON.parse(row.value);
  const seen = new Set(state.formatVersion === POLL_FORMAT_VERSION ? state.seen ?? [] : []);
  const versions = { ...state.versions };
  let inspected = 0;
  let received = 0;
  const jobIds: string[] = [];
  try {
    const allowlist = approvedSenders(env);
    const ordered = state.nextSender === 1 ? [...allowlist].reverse() : allowlist;
    const conversations = [];
    const conversationIds = new Set<string>();
    for (const sender of ordered) {
      const found = await apiConversations(env, sender);
      if (found.length > 1) throw new AppError('approved_conversation_ambiguous');
      for (const conversation of found) {
        const id = apiId(conversation.id)!;
        if (!conversationIds.has(id)) { conversations.push(conversation); conversationIds.add(id); }
      }
    }
    let bounded = false;
    for (const conversation of conversations) {
      const id = apiId(conversation.id)!;
      const key = await sha256(id);
      const version = typeof conversation.updated_time === 'string' ? conversation.updated_time : undefined;
      // Always refresh the recent IDs. Meta's second-resolution updated_time
      // can stay equal when another DM arrives during the previous scan.
      // Only unseen messages require a detail read, so quiet polling is two
      // small GETs per minute for the single approved conversation.
      const messages = (await apiMessageList(env, id)).sort((a, b) => apiTimestamp(a.created_time) - apiTimestamp(b.created_time));
      let conversationReads = 0;
      for (const entry of messages) {
        const timestamp = apiTimestamp(entry.created_time);
        if (!Number.isFinite(timestamp) || timestamp < Math.max(state.startedAt, now - 48 * 3600_000)) continue;
        const messageId = apiId(entry.id)!;
        const hash = await sha256(messageId);
        if (seen.has(hash)) continue;
        if (inspected >= 6) { bounded = true; break; }
        if (conversationReads >= 3) break;
        const message = await apiMessage(env, messageId, true);
        conversationReads++;
        inspected++;
        const sources = parseApiMessage(message, allowlist, recipients, state.startedAt, now);
        for (const source of sources) { jobIds.push(await enqueue(env, source)); received++; }
        // Persist only after jobs are durable. A failure before this save
        // simply repeats idempotent INSERT OR IGNORE on the next invocation.
        seen.add(hash);
      }
      if (bounded) break;
      if (version) versions[key] = version;
    }
    const updated: PollState = { ...state, nextSender: state.nextSender === 1 ? 0 : 1, formatVersion: POLL_FORMAT_VERSION, seen: [...seen].slice(-120), versions, leaseToken: null, leaseUntil: 0, nextAt: (Math.floor(now / 60_000) + 1) * 60_000, errors: 0, lastErrorCode: null, lastSuccessAt: Date.now(), inspected, received };
    await env.DB.prepare("UPDATE settings SET value=? WHERE key='instagram_poll' AND json_extract(value,'$.leaseToken')=?").bind(JSON.stringify(updated), lease).run();
    if (inspected || received) log('instagram_poll', { inspected, received });
  } catch (error) {
    const errors = Math.min((state.errors ?? 0) + 1, 6);
    const code = errorCode(error);
    const updated: PollState = { ...state, formatVersion: POLL_FORMAT_VERSION, seen: [...seen].slice(-120), versions, leaseToken: null, leaseUntil: 0, nextAt: now + Math.min(3600_000, 60_000 * 2 ** errors), errors, lastErrorCode: code, inspected, received };
    await env.DB.prepare("UPDATE settings SET value=? WHERE key='instagram_poll' AND json_extract(value,'$.leaseToken')=?").bind(JSON.stringify(updated), lease).run();
    log('instagram_poll_failed', { code });
  }
  for (const id of [...new Set(jobIds)]) await processJob(env, id);
}
