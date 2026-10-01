import { metaRequest } from './meta';
import { saveSetting, settings } from './jobs';
import { constantTimeEqual, sha256 } from './security';
import { AppError, log, type Env } from './types';
import { apiConversations, apiId, apiMessage, apiMessageList, apiObject, apiItems, apiTimestamp } from './instagram-api';
import { approvedSenders, senderForSlot, type SenderSlot } from './senders';

interface OwnerSetup {
  hash: string; createdAt: number; expiresAt: number; recipients: string[];
  senderId: string | null; matchedAt: number | null; verifiedBy?: 'webhook' | 'api';
}
const setupKey = (slot: SenderSlot) => slot === 'owner' ? 'owner_setup' : 'friend_setup';
const identifier = (value: unknown): string | undefined => typeof value === 'string' && /^\d{1,40}$/.test(value) ? value : undefined;
const otherSlot = (slot: SenderSlot): SenderSlot => slot === 'owner' ? 'friend' : 'owner';

async function account(env: Env) {
  const response = await metaRequest<Record<string, unknown>>(env, 'me?fields=id,user_id,username');
  const me = Array.isArray(response.data) ? apiObject(response.data[0]) : response;
  const recipients = [...new Set([identifier(me.user_id), identifier(me.id)].filter((id): id is string => !!id))];
  if (!recipients.length || typeof me.username !== 'string' || !/^[A-Za-z0-9._]{1,40}$/.test(me.username)) throw new AppError('invalid_instagram_account');
  if (env.EXPECTED_INSTAGRAM_USERNAME && me.username.toLowerCase() !== env.EXPECTED_INSTAGRAM_USERNAME.toLowerCase()) throw new AppError('meta_account_mismatch');
  return { recipients, username: me.username };
}

export async function startOwnerSetup(env: Env, slot: SenderSlot = 'owner') {
  if (senderForSlot(env, slot)) throw new AppError('owner_already_configured');
  if (!env.META_APP_SECRET) throw new AppError('missing_meta_app_secret');
  const { recipients, username } = await account(env);
  const message = 'meme-setup:' + crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const now = Date.now();
  await saveSetting(env, setupKey(slot), { hash: await sha256(message), createdAt: now, expiresAt: now + 15 * 60_000, recipients, senderId: null, matchedAt: null } satisfies OwnerSetup);
  return { slot, username, message, expiresAt: now + 15 * 60_000 };
}

async function recordProof(env: Env, slot: SenderSlot, pending: OwnerSetup, senderId: string, verifiedBy: 'webhook' | 'api'): Promise<boolean> {
  if (senderId === senderForSlot(env, otherSlot(slot)) || pending.recipients.includes(senderId)) return false;
  if (pending.senderId) return pending.senderId === senderId;
  // Each challenge binds one sender. Separate proofs cannot bind the same person.
  const result = await env.DB.prepare(`UPDATE settings SET value=json_set(value, '$.senderId', ?, '$.matchedAt', ?, '$.verifiedBy', ?)
    WHERE key=? AND json_extract(value,'$.hash')=? AND json_extract(value,'$.senderId') IS NULL
    AND json_extract(value,'$.expiresAt')>? AND NOT EXISTS (
      SELECT 1 FROM settings WHERE key=? AND json_extract(value,'$.senderId')=? AND json_extract(value,'$.expiresAt')>?)`)
    .bind(senderId, Date.now(), verifiedBy, setupKey(slot), pending.hash, Date.now(), setupKey(otherSlot(slot)), senderId, Date.now()).run();
  if (result.meta.changes) log('sender_setup_verified', { slot, verifiedBy });
  return !!result.meta.changes;
}

// Caller validates the Meta signature first. Setup DMs never create jobs.
export async function acceptOwnerSetup(env: Env, payload: unknown): Promise<boolean> {
  const root = apiObject(payload);
  if (root.object !== 'instagram' || !Array.isArray(root.entry)) return false;
  for (const slot of ['owner', 'friend'] as const) {
    if (senderForSlot(env, slot)) continue;
    const pending = await settings<OwnerSetup>(env, setupKey(slot));
    if (!pending || pending.expiresAt <= Date.now()) continue;
    let candidates = 0;
    for (const entry of root.entry.slice(0, 100).map(apiObject)) {
      if (!Array.isArray(entry.messaging)) continue;
      for (const event of entry.messaging.slice(0, 100).map(apiObject)) {
        const senderId = identifier(apiObject(event.sender).id), recipientId = identifier(apiObject(event.recipient).id);
        const message = apiObject(event.message), text = typeof message.text === 'string' ? message.text.trim() : '';
        if (!senderId || !recipientId || !pending.recipients.includes(recipientId) || entry.id !== recipientId || message.is_echo || message.is_self || message.is_deleted || message.is_unsupported || !apiId(message.mid)) continue;
        if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp) || event.timestamp < pending.createdAt - 30_000 || event.timestamp > Date.now() + 300_000) continue;
        if (!/^meme-setup:[a-f0-9]{64}$/.test(text)) continue;
        if (++candidates > 8) return false;
        if (await constantTimeEqual(await sha256(text), pending.hash)) return recordProof(env, slot, pending, senderId, 'webhook');
      }
    }
  }
  return false;
}

export async function ownerSetupStatus(env: Env, slot: SenderSlot = 'owner') {
  const pending = await settings<OwnerSetup>(env, setupKey(slot));
  const installed = !!senderForSlot(env, slot), allowlistCount = approvedSenders(env).length;
  if (!pending || pending.expiresAt <= Date.now()) return { slot, installed, allowlistCount, matched: false, expired: true };
  // Actual ID is returned only to the authenticated local secret installer.
  return { slot, installed, allowlistCount, matched: !!pending.senderId, expired: false, senderId: pending.senderId ?? undefined, matchedAt: pending.matchedAt ?? undefined, expiresAt: pending.expiresAt, verifiedBy: pending.verifiedBy ?? 'webhook' };
}

export async function importOwnerSetup(env: Env, input: unknown, slot: SenderSlot = 'owner') {
  if (senderForSlot(env, slot)) throw new AppError('owner_already_configured');
  if (env.INGEST_MODE !== 'polling') throw new AppError('owner_api_import_requires_polling');
  const { username, challengeHash } = apiObject(input);
  if (username !== undefined && (typeof username !== 'string' || !/^[A-Za-z0-9._]{1,30}$/.test(username)) || typeof challengeHash !== 'string' || !/^[a-f0-9]{64}$/.test(challengeHash)) throw new AppError('invalid_owner_api_selection');
  const pending = await settings<OwnerSetup>(env, setupKey(slot));
  if (!pending || pending.expiresAt <= Date.now() || !await constantTimeEqual(challengeHash, pending.hash)) throw new AppError('owner_setup_expired');
  const { recipients } = await account(env);
  if (recipients.length !== pending.recipients.length || !recipients.every(id => pending.recipients.includes(id))) throw new AppError('meta_account_mismatch');
  let inspected = 0;
  for (const conversation of await apiConversations(env)) {
    for (const entry of await apiMessageList(env, apiId(conversation.id)!)) {
      const timestamp = apiTimestamp(entry.created_time);
      if (!Number.isFinite(timestamp) || timestamp < pending.createdAt - 30_000 || timestamp > Date.now() + 300_000) continue;
      if (++inspected > 20) throw new AppError('owner_api_proof_not_found');
      const message = await apiMessage(env, apiId(entry.id)!);
      const sender = apiObject(message.from), senderId = identifier(sender.id);
      const text = typeof message.message === 'string' ? message.message.trim() : '';
      const created = apiTimestamp(message.created_time);
      if (!senderId || recipients.includes(senderId) || !Number.isFinite(created) || created < pending.createdAt - 30_000 || created > Date.now() + 300_000) continue;
      // Username is an optional extra check, never authorization.
      if (username && (typeof sender.username !== 'string' || sender.username.toLowerCase() !== String(username).toLowerCase())) continue;
      if (!/^meme-setup:[a-f0-9]{64}$/.test(text) || !await constantTimeEqual(await sha256(text), pending.hash)) continue;
      if (!apiItems(message.to).some(recipient => recipients.includes(identifier(recipient.id) ?? ''))) continue;
      if (!await recordProof(env, slot, pending, senderId, 'api')) throw new AppError('sender_setup_conflict');
      return { matched: true, verifiedBy: 'api', ...(username ? { username } : {}) };
    }
  }
  throw new AppError('owner_api_proof_not_found');
}

export async function diagnoseOwnerSetup(env: Env, slot: SenderSlot = 'owner') {
  const pending = await settings<OwnerSetup>(env, setupKey(slot));
  if (!pending || pending.expiresAt <= Date.now()) throw new AppError('owner_setup_expired');
  let inspectedMessages = 0, inspectedConversations = 0;
  for (const conversation of await apiConversations(env)) {
    inspectedConversations++;
    for (const entry of await apiMessageList(env, apiId(conversation.id)!)) {
      const created = apiTimestamp(entry.created_time);
      if (!Number.isFinite(created) || created < pending.createdAt - 30_000 || created > Date.now() + 300_000) continue;
      if (++inspectedMessages > 20) return { conversationsReadable: true, inspectedConversations, inspectedMessages: 20, challengeFound: false, bounded: true };
      const message = await apiMessage(env, apiId(entry.id)!);
      const text = typeof message.message === 'string' ? message.message.trim() : '';
      if (!await constantTimeEqual(await sha256(text.replace(/\s/g, '')), pending.hash)) continue;
      return { conversationsReadable: true, inspectedConversations, inspectedMessages, challengeFound: true, exactText: await constantTimeEqual(await sha256(text), pending.hash), recipientMatches: apiItems(message.to).some(recipient => pending.recipients.includes(identifier(recipient.id) ?? '')), senderPresent: !!identifier(apiObject(message.from).id), createdAt: created, webhookVerified: !!pending.senderId };
    }
  }
  return { conversationsReadable: true, inspectedConversations, inspectedMessages, challengeFound: false, webhookVerified: !!pending.senderId };
}

export async function finishOwnerSetup(env: Env, slot: SenderSlot = 'owner'): Promise<void> {
  const pending = await settings<OwnerSetup>(env, setupKey(slot)), installed = senderForSlot(env, slot);
  if (!pending?.senderId || pending.expiresAt <= Date.now() || !installed || !await constantTimeEqual(pending.senderId, installed) || installed === senderForSlot(env, otherSlot(slot))) throw new AppError('owner_installation_not_confirmed');
  approvedSenders(env);
  await env.DB.prepare('DELETE FROM settings WHERE key=? AND json_extract(value,\'$.hash\')=?').bind(setupKey(slot), pending.hash).run();
}
