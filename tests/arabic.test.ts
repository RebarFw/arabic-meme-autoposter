import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { createCaption } from '../src/caption';
import { BufferClient } from '../src/buffer';
import { enqueue, maintenance, processJob, saveSetting, settings } from '../src/jobs';
import { parseApiMessage } from '../src/instagram-api';
import { pollInstagram } from '../src/instagram-polling';
import { acceptOwnerSetup, finishOwnerSetup, importOwnerSetup, ownerSetupStatus, startOwnerSetup } from '../src/owner-setup';
import { approvedSenders } from '../src/senders';
import type { Channel, Env, ReelSource } from '../src/types';

const bindings = (): Env => ({ ...env, META_ACCESS_TOKEN: 'fake-meta', BUFFER_API_KEY: 'fake-buffer' });
const channels: Channel[] = [
  { id: 'ig', service: 'instagram', name: 'arabic_ig', serviceId: '222', organizationId: 'org', isDisconnected: false, isLocked: false },
  { id: 'tt', service: 'tiktok', name: 'arabic_tt', serviceId: 'tiktok-id', organizationId: 'org', isDisconnected: false, isLocked: false, metadata: { defaultToReminders: false } },
];
const mp4 = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
const source = (senderId = '111', messageId = 'message-a', shortcode = 'SameReel'): ReelSource => ({ senderId, messageId, recipientId: '222', timestamp: Date.now(), kind: 'reel', reelUrl: `https://www.instagram.com/reel/${shortcode}/`, attachmentUrl: 'https://lookaside.fbsbx.com/reel.mp4' });
const empty = (): Env => ({ ...bindings(), OWNER_IG_SENDER_ID: undefined, FRIEND_IG_SENDER_ID: undefined });
const setupPayload = (text: string, sender = '111') => ({ object: 'instagram', entry: [{ id: '222', messaging: [{ sender: { id: sender }, recipient: { id: '222' }, timestamp: Date.now(), message: { mid: crypto.randomUUID(), text } }] }] });

beforeEach(async () => {
  await env.DB.batch(['message_tombstones', 'deliveries', 'jobs', 'settings'].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  const page = await env.MEDIA.list(); if (page.objects.length) await env.MEDIA.delete(page.objects.map(o => o.key));
  await saveSetting(env, 'recipient_ids', ['222']); await saveSetting(env, 'channels', channels);
});
afterEach(() => vi.restoreAllMocks());

function socialMock(failTiktok = false) {
  const created: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).includes('fbsbx.com')) return new Response(mp4, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(mp4.length) } });
    const body = JSON.parse(String(init?.body));
    if (body.query.includes('mutation')) {
      const service = body.variables.input.channelId;
      created.push(service);
      if (failTiktok && service === 'tt') return Response.json({ data: { createPost: { __typename: 'InvalidInputError', message: 'rejected' } } });
      return Response.json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'post-' + service, status: 'sending', schedulingType: 'automatic' } } } });
    }
    return Response.json({ data: { post: { id: body.variables.input.id, status: 'sent', schedulingType: 'automatic' } } });
  });
  return created;
}

describe('exact two-person allowlist and permanent Reel deduplication', () => {
  it.each(['111', '777'])('accepts sender %s from Meta and creates one job', async sender => {
    const message = { id: 'dm-' + sender, created_time: new Date().toISOString(), from: { id: sender, username: 'untrusted' }, to: { data: [{ id: '222' }] }, shares: { data: [{ link: 'https://www.instagram.com/reel/SameReel/' }] } };
    const parsed = parseApiMessage(message, approvedSenders(bindings()), ['222'], 0);
    expect(parsed).toHaveLength(1);
    await enqueue(bindings(), parsed[0]!);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first('n')).toBe(1);
  });
  it('ignores an unknown sender even if they copy an approved username', async () => {
    const message = { id: 'stranger', created_time: new Date().toISOString(), from: { id: '999', username: 'rebarfw' }, to: { data: [{ id: '222' }] }, shares: { data: [{ link: 'https://www.instagram.com/reel/SameReel/' }] } };
    expect(parseApiMessage(message, approvedSenders(bindings()), ['222'], 0)).toEqual([]);
    await expect(enqueue(bindings(), source('999'))).rejects.toThrow('sender_not_authorized');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first('n')).toBe(0);
  });
  it('publishes a Reel once across both approved people, duplicate deliveries and simultaneous retries', async () => {
    const creates = socialMock();
    const requests = [source(), source('777', 'message-b'), source('111', 'message-c')];
    const ids = await Promise.all(requests.map(item => enqueue(bindings(), item)));
    expect(new Set(ids).size).toBe(1);
    await Promise.all(ids.map(id => processJob(bindings(), id)));
    expect(creates.sort()).toEqual(['ig', 'tt']);
    await env.DB.prepare('UPDATE jobs SET next_run_at=0').run();
    await processJob(bindings(), ids[0]!);
    expect(await env.DB.prepare('SELECT state FROM jobs').first('state')).toBe('completed');
    expect(await env.MEDIA.head(`arabic-meme-autoposter/${ids[0]}.mp4`)).toBeNull();
    // Erasing source contents does not erase either kind of tombstone.
    await env.DB.prepare('UPDATE jobs SET updated_at=?').bind(Date.now() - 49 * 3600_000).run();
    await maintenance({ ...bindings(), BUFFER_API_KEY: undefined });
    expect(await env.DB.prepare('SELECT source_json FROM jobs').first('source_json')).toBeNull();
    expect(await enqueue(bindings(), source('777', 'message-d'))).toBe(ids[0]);
    await processJob(bindings(), ids[0]!);
    expect(creates).toHaveLength(2);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM message_tombstones').first('n')).toBe(4);
  });
  it('never duplicates the successful network after a failure on the other network', async () => {
    const creates = socialMock(true), id = await enqueue(bindings(), source('777'));
    await processJob(bindings(), id);
    await env.DB.prepare('UPDATE jobs SET next_run_at=0').run();
    await processJob(bindings(), id); await processJob(bindings(), id);
    expect(creates.sort()).toEqual(['ig', 'tt']);
    expect(await env.DB.prepare('SELECT state FROM jobs').first('state')).toBe('failed');
    expect(await env.MEDIA.head(`arabic-meme-autoposter/${id}.mp4`)).toBeNull();
  });
  it('requires two distinct IDs and keeps publishing closed during partial setup', async () => {
    expect(() => approvedSenders({ ...bindings(), FRIEND_IG_SENDER_ID: '111' })).toThrow('invalid_sender_allowlist');
    await expect(enqueue({ ...bindings(), FRIEND_IG_SENDER_ID: undefined }, source())).rejects.toThrow('sender_not_authorized');
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await pollInstagram({ ...bindings(), INGEST_MODE: 'polling', FRIEND_IG_SENDER_ID: undefined });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds and fairly polls both 1-to-1 conversations with one shared D1 state', async () => {
    const active = { ...bindings(), INGEST_MODE: 'polling' as const };
    await saveSetting(env, 'instagram_poll', { startedAt: Date.now() - 60000, seen: [] });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/me/conversations')) return Response.json({ data: [{ id: 'conversation-' + url.searchParams.get('user_id') }] });
      if (url.pathname.includes('/conversation-')) return Response.json({ messages: { data: Array.from({ length: 4 }, (_, i) => ({ id: url.pathname.split('/').at(-1) + '-message-' + i, created_time: new Date(Date.now() - 1000).toISOString() })) } });
      // Even copied usernames in an approved conversation cannot authorize a stranger.
      return Response.json({ id: url.pathname.split('/').at(-1), created_time: new Date().toISOString(), from: { id: '999', username: 'rebarfw' }, to: { data: [{ id: '222' }] }, shares: { data: [{ link: 'https://www.instagram.com/reel/SameReel/' }] } });
    });
    await pollInstagram(active);
    const first = await settings<{ inspected: number; seen: string[]; nextSender: number }>(env, 'instagram_poll');
    expect(first).toMatchObject({ inspected: 6, nextSender: 1 }); expect(first!.seen).toHaveLength(6);
    await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.nextAt',0) WHERE key='instagram_poll'").run();
    await pollInstagram(active);
    expect((await settings<{ inspected: number; seen: string[] }>(env, 'instagram_poll'))).toMatchObject({ inspected: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'instagram_poll%'").first('n')).toBe(1);
    fetcher.mockClear();
    await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.nextAt',0) WHERE key='instagram_poll'").run();
    await pollInstagram(active);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first('n')).toBe(0);
  });
});

describe('independent, one-time sender setup proofs', () => {
  it('binds both people separately, rejects a third slot and does not authorize a display name', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: '222', user_id: '222', username: 'arabic_ig' }));
    const a = await startOwnerSetup(empty(), 'owner'), b = await startOwnerSetup(empty(), 'friend');
    expect(a.message).not.toBe(b.message);
    await acceptOwnerSetup(empty(), setupPayload(a.message, '111'));
    expect((await ownerSetupStatus(empty(), 'friend')).matched).toBe(false);
    expect(await acceptOwnerSetup(empty(), setupPayload(b.message, '111'))).toBe(false);
    expect(await acceptOwnerSetup(empty(), setupPayload(b.message, '777'))).toBe(true);
    const installed = { ...empty(), OWNER_IG_SENDER_ID: '111', FRIEND_IG_SENDER_ID: '777' };
    await finishOwnerSetup(installed, 'owner'); await finishOwnerSetup(installed, 'friend');
    expect(approvedSenders(installed)).toEqual(['111', '777']);
    expect(await settings(installed, 'owner_setup')).toBeNull(); expect(await settings(installed, 'friend_setup')).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first('n')).toBe(0);
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('https://worker.example/admin/owner/start?slot=third', { method: 'POST', headers: { Authorization: 'Bearer test-admin' } }), installed, ctx);
    await waitOnExecutionContext(ctx); expect(response.status).toBe(503);
  });
  it('cannot import a self-chosen challenge, a stale proof or a replaced challenge', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: '222', username: 'arabic_ig' }));
    await expect(importOwnerSetup({ ...empty(), INGEST_MODE: 'polling' }, { challengeHash: 'a'.repeat(64) }, 'friend')).rejects.toThrow('owner_setup_expired');
    expect(fetcher).not.toHaveBeenCalled();
    await startOwnerSetup(empty(), 'friend');
    await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.expiresAt',0) WHERE key='friend_setup'").run();
    await expect(importOwnerSetup({ ...empty(), INGEST_MODE: 'polling' }, { challengeHash: 'a'.repeat(64) }, 'friend')).rejects.toThrow('owner_setup_expired');
  });
});

describe('Arabic captions, Buffer identity and secret protection', () => {
  it('generates stable short colloquial Arabic captions with appropriate hashtags', async () => {
    const captions = await Promise.all(Array.from({ length: 24 }, (_, i) => createCaption('job-' + i)));
    expect(new Set(captions).size).toBeGreaterThan(3);
    for (const caption of captions) {
      expect(caption.split('\n')[0]).toMatch(/[\u0600-\u06ff]/);
      expect(caption.split('\n')[0]!.length).toBeLessThan(40);
      expect(caption).toContain('#ميمز_عربي'); expect(caption).toContain('#memes');
      expect(caption).not.toContain('had to share');
    }
    expect(await createCaption('job-1')).toBe(await createCaption('job-1'));
  });
  it('fails closed for an incorrect, disconnected or reminder-only Buffer pair', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const pinned: Env = { ...bindings(), EXPECTED_INSTAGRAM_CHANNEL_ID: 'ig', EXPECTED_TIKTOK_CHANNEL_ID: 'tt', EXPECTED_INSTAGRAM_USERNAME: 'arabic_ig', EXPECTED_TIKTOK_USERNAME: 'arabic_tt' };
    for (const pair of [channels.map(c => ({ ...c, id: 'wrong' })), channels.map(c => ({ ...c, isDisconnected: true })), channels.map(c => ({ ...c, metadata: { defaultToReminders: true } }))]) {
      fetcher.mockImplementation(async (_input, init) => JSON.parse(String(init?.body)).query.includes('organizations') ? Response.json({ data: { account: { organizations: [{ id: 'org' }] } } }) : Response.json({ data: { channels: pair } }));
      await expect(new BufferClient(pinned).discoverChannels()).rejects.toThrow();
    }
    fetcher.mockClear();
    await expect(new BufferClient(pinned).publish('wrong', 'instagram', 'caption', 'https://worker.example/media')).rejects.toThrow('buffer_channel_identity_mismatch');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not expose credential-bearing provider errors in logs or API responses', async () => {
    const sentinel = 'PRIVATE_TOKEN_DO_NOT_LOG';
    const logger = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ errors: [{ message: sentinel }], data: null }));
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('https://worker.example/admin/setup', { method: 'POST', headers: { Authorization: 'Bearer test-admin' } }), { ...bindings(), BUFFER_API_KEY: sentinel }, ctx);
    await waitOnExecutionContext(ctx);
    expect(await response.text()).not.toContain(sentinel);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(sentinel);
  });
});
