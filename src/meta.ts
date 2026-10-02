import { AppError, type Env, type ReelSource } from './types';
import { limitedBytes, META_MEDIA_HOSTS, reelUrl, secureUrl } from './security';
import { senderAllowed } from './senders';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const id = (value: unknown): string | undefined => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value) ? value : undefined;

export function metaAccessToken(env: Env): string {
  if (!env.META_ACCESS_TOKEN) throw new AppError('missing_meta_access_token');
  let token = env.META_ACCESS_TOKEN.trim();
  // Wrangler may receive a token copied with matching enclosing quotes.
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) token = token.slice(1, -1).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new AppError('invalid_meta_access_token_format');
  return token;
}

export function parseMessages(payload: unknown, owner: string | string[], recipients: string[], now = Date.now()): ReelSource[] {
  const allowlist = Array.isArray(owner) ? owner : [owner];
  const root = record(payload);
  if (root.object !== 'instagram' || !Array.isArray(root.entry)) return [];
  const sources: ReelSource[] = [];
  for (const rawEntry of root.entry.slice(0, 100)) {
    const entry = record(rawEntry);
    if (!Array.isArray(entry.messaging)) continue;
    for (const rawEvent of entry.messaging.slice(0, 100)) {
      const event = record(rawEvent);
      const senderId = id(record(event.sender).id);
      const recipientId = id(record(event.recipient).id);
      const message = record(event.message);
      const messageId = id(message.mid);
      if (!senderId || !allowlist.includes(senderId) || !recipientId || !recipients.includes(recipientId) || entry.id !== recipientId || !messageId || message.is_echo || message.is_self || message.is_deleted || message.is_unsupported) continue;
      if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp) || event.timestamp < now - 48 * 3600_000 || event.timestamp > now + 300_000) continue;
      const text = typeof message.text === 'string' ? message.text.slice(0, 2000) : '';
      const links = text.match(/https:\/\/[^\s<>]+/g) ?? [];
      const reels = [...new Set(links.map(link => reelUrl(link.replace(/[),.!?]+$/, ''))).filter((url): url is string => !!url))];
      if (reels.length > 1) continue;
      let attachmentUrl: string | undefined;
      let mediaId: string | undefined;
      let title: string | undefined;
      let kind: ReelSource['kind'] = reels.length ? 'reel' : 'shared-post';
      let foundShare = false;
      let ambiguous = false;
      if (Array.isArray(message.attachments)) {
        for (const rawAttachment of message.attachments.slice(0, 10)) {
          const attachment = record(rawAttachment);
          if (!['share','ig_post','ig_reel','reel'].includes(String(attachment.type))) continue;
          const data = record(attachment.payload);
          const candidateId = id(data.ig_post_media_id ?? data.id);
          if (mediaId && candidateId && mediaId !== candidateId) { ambiguous = true; break; }
          mediaId ??= candidateId;
          if (typeof data.title === 'string') title = data.title;
          if (attachment.type === 'ig_reel' || attachment.type === 'reel') kind = 'reel';
          if (typeof data.url !== 'string') continue;
          const candidateReel = reelUrl(data.url);
          if (candidateReel) {
            if (reels[0] && reels[0] !== candidateReel) { ambiguous = true; break; }
            reels[0] = candidateReel;
            kind = 'reel';
            foundShare = true;
          } else {
            try {
              const candidate = secureUrl(data.url, META_MEDIA_HOSTS).toString();
              if (attachmentUrl && attachmentUrl !== candidate && !candidateId) { ambiguous = true; break; }
              attachmentUrl ??= candidate;
              foundShare = true;
            } catch { /* Reject unsafe attachments without fetching them. */ }
          }
        }
      }
      if (!ambiguous && (foundShare || reels[0])) sources.push({ messageId, senderId, recipientId, timestamp: event.timestamp, reelUrl: reels[0], attachmentUrl, mediaId, title, kind });
    }
  }
  return sources;
}

export async function metaRequest<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const token = metaAccessToken(env);
  if (!/^v\d+\.0$/.test(env.META_API_VERSION)) throw new AppError('invalid_meta_version');
  let response: Response;
  try {
    response = await fetch(`https://graph.instagram.com/${env.META_API_VERSION}/${path}`, {
      ...init, redirect: 'manual', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
    });
  } catch { throw new AppError('meta_network_error', true); }
  if (!response.ok) { await response.body?.cancel(); throw new AppError(`meta_http_${response.status}`, response.status === 429 || response.status >= 500); }
  const bytes = await limitedBytes(response.body, 128_000);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; } catch { throw new AppError('meta_invalid_response'); }
}

export async function notifyOwner(env: Env, recipientId: string, timestamp: number, senderId: string): Promise<void> {
  if (env.ENABLE_OWNER_DM !== 'true' || !senderAllowed(env, senderId) || Date.now() - timestamp > 23 * 3600_000) return;
  await metaRequest(env, `${encodeURIComponent(recipientId)}/messages`, {
    method: 'POST', body: JSON.stringify({ recipient: { id: senderId }, message: { text: '✅ نزل على إنستغرام وتيك توك' } }),
  });
}
