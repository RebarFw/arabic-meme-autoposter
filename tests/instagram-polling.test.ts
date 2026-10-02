import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseApiMessage } from '../src/instagram-api';
import { probeApifyDownload } from '../src/download-diagnostics';
import { pollInstagram, pollingStatus } from '../src/instagram-polling';
import { importOwnerSetup } from '../src/owner-setup';
import { enqueue, processJob, refreshPosts, retryDownload, saveSetting, settings } from '../src/jobs';
import { sha256 } from '../src/security';
import worker from '../src/index';
import type { Channel, Env } from '../src/types';
import { apifyGuardResponse } from './apify-fixture';

const bindings = (): Env => ({ ...env, INGEST_MODE: 'polling', META_ACCESS_TOKEN: 'fake-meta', BUFFER_API_KEY: 'fake-buffer' });
const channels: Channel[] = [
  { id: 'ig', name: 'memes', service: 'instagram', serviceId: '222', organizationId: 'org', isDisconnected: false, isLocked: false },
  { id: 'tt', name: 'memes', service: 'tiktok', serviceId: '333', organizationId: 'org', isDisconnected: false, isLocked: false },
];
const mp4 = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
const message = (overrides: Record<string, unknown> = {}) => ({
  id: 'message-1', created_time: new Date(Date.now() - 1000).toISOString(), from: { id: '111', username: 'owner' }, to: { data: [{ id: '444' }] }, message: '',
  shares: { data: [{ type: 'ig_reel', id: 'media-1', url: 'https://lookaside.fbsbx.com/reel.mp4', name: 'clip' }] }, ...overrides,
});
async function countJobs() { return (await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>())!.n; }
async function due() { await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.nextAt',0) WHERE key='instagram_poll'").run(); }

function mockApi(items = [message()]) {
  let creates = 0;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('/me?')) return Response.json({ id: '444', user_id: '222', username: 'memes' });
    if (url.includes('/me/conversations?')) return Response.json({ data: [{ id: 'conversation-1', updated_time: 'version-1' }] });
    if (url.includes('/conversation-1?')) return Response.json({ messages: { data: items.map(m => ({ id: m.id, created_time: m.created_time })) } });
    const found = items.find(item => url.includes('/' + item.id + '?'));
    if (found) return Response.json(found);
    if (url.includes('fbsbx.com')) return new Response(mp4, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(mp4.length) } });
    if (url === 'https://api.buffer.com') {
      const body = JSON.parse(String(init?.body));
      if (!body.query.includes('mutation')) return Response.json({ data: { post: { id: body.variables.input.id, status: 'sent', schedulingType: 'automatic' } } });
      expect(body.variables.input.mode).toBe('shareNow');
      return Response.json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'post-' + ++creates, status: 'sending', schedulingType: 'automatic' } } } });
    }
    throw new Error('Unexpected request');
  });
  return { fetcher, creates: () => creates };
}
beforeEach(async () => {
  const objects = await env.MEDIA.list(); if (objects.objects.length) await env.MEDIA.delete(objects.objects.map(o => o.key));
  await env.DB.batch([env.DB.prepare('DELETE FROM deliveries'), env.DB.prepare('DELETE FROM message_tombstones'), env.DB.prepare('DELETE FROM jobs'), env.DB.prepare('DELETE FROM settings'), env.DB.prepare('DELETE FROM apify_budget')]);
  await saveSetting(env, 'channels', channels);
  await saveSetting(env, 'recipient_ids', ['222', '444']);
  await saveSetting(env, 'instagram_poll', { startedAt: Date.now() - 60_000, seen: [], versions: {} });
});
afterEach(() => vi.restoreAllMocks());

describe('Meta API message parsing', () => {
  it('requires the exact owner, correct recipient and a new message, and canonicalizes the recipient', () => {
    const parsed = parseApiMessage(message(), '111', ['222', '444'], Date.now() - 60_000);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ recipientId: '222', messageId: 'message-1', kind: 'reel', mediaId: 'media-1' });
    expect(parseApiMessage(message(), '999', ['222', '444'], 0)).toEqual([]);
    expect(parseApiMessage(message(), '111', ['555'], 0)).toEqual([]);
    expect(parseApiMessage(message(), '111', ['222', '444'], Date.now())).toEqual([]);
  });
  it('ignores uploaded videos, stories, unsafe URLs and ambiguous multiple shares', () => {
    expect(parseApiMessage(message({ shares: {}, attachments: { data: [{ video_data: { url: 'https://lookaside.fbsbx.com/upload.mp4' } }] } }), '111', ['444'], 0)).toEqual([]);
    expect(parseApiMessage(message({ shares: { data: [{ type: 'story', url: 'https://lookaside.fbsbx.com/a' }] } }), '111', ['444'], 0)).toEqual([]);
    expect(parseApiMessage(message({ shares: { data: [{ type: 'reel', url: 'https://evil.example/video' }] } }), '111', ['444'], 0)).toEqual([]);
    expect(parseApiMessage(message({ shares: { data: [{ type: 'reel', id: 'a', url: 'https://lookaside.fbsbx.com/a' }, { type: 'reel', id: 'b', url: 'https://lookaside.fbsbx.com/b' }] } }), '111', ['444'], 0)).toEqual([]);
  });
  it('accepts the actual Instagram Login link-only Reel share while rejecting unrelated links and declared stories', () => {
    const parsed = parseApiMessage(message({ shares: { data: [{ link: 'https://www.instagram.com/reel/ABC_123/?igsh=tracking' }] } }), '111', ['444'], 0);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ kind: 'reel', reelUrl: 'https://www.instagram.com/reel/ABC_123/' });
    for (const share of [{ link: 'https://evil.example/reel/ABC/' }, { link: 'https://www.instagram.com/p/ABC/' }, { type: 'story', link: 'https://www.instagram.com/reel/ABC/' }]) {
      expect(parseApiMessage(message({ shares: { data: [share] } }), '111', ['444'], 0)).toEqual([]);
    }
  });
});

describe('durable owner-only polling', () => {
  it('creates both immediate posts once and avoids detail reads for an unchanged conversation', async () => {
    const api = mockApi();
    await pollInstagram(bindings());
    expect(api.creates()).toBe(2);
    expect(await countJobs()).toBe(1);
    expect((await pollingStatus(bindings())).received).toBe(1);
    api.fetcher.mockClear();
    await due();
    await pollInstagram(bindings());
    expect(api.creates()).toBe(2);
    expect(api.fetcher).toHaveBeenCalledTimes(3);
    expect(api.fetcher.mock.calls.filter(([url]) => String(url).includes('/me/conversations?')).map(([url]) => new URL(String(url)).searchParams.get('user_id')).sort()).toEqual(['111', '777']);
  });
  it('leases polling atomically so simultaneous invocations do not duplicate API reads or posts', async () => {
    const api = mockApi();
    await Promise.all(Array.from({ length: 5 }, () => pollInstagram(bindings())));
    expect(api.creates()).toBe(2);
    expect(api.fetcher.mock.calls.filter(([url]) => String(url).includes('/me/conversations?'))).toHaveLength(2);
  });
  it('finds a new DM even when the conversation updated_time has not changed', async () => {
    const items = [message()];
    const api = mockApi(items);
    await pollInstagram(bindings());
    items.push(message({ id: 'message-2', shares: { data: [{ type: 'ig_reel', id: 'media-2', url: 'https://lookaside.fbsbx.com/reel.mp4', name: 'clip' }] } }));
    api.fetcher.mockClear();
    await due();
    await pollInstagram(bindings());
    expect(api.creates()).toBe(4);
    expect(await countJobs()).toBe(2);
    const details = api.fetcher.mock.calls.filter(([url]) => /\/message-\d\?/.test(String(url)));
    expect(details).toHaveLength(1);
    expect(String(details[0]![0])).toContain('/message-2?');
  });
  it('rechecks ignored messages after a parser upgrade without recreating existing posts', async () => {
    const api = mockApi();
    await pollInstagram(bindings());
    await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.formatVersion',1,'$.nextAt',0) WHERE key='instagram_poll'").run();
    await pollInstagram(bindings());
    expect(api.creates()).toBe(2);
    expect(await countJobs()).toBe(1);
    expect(api.fetcher.mock.calls.filter(([url]) => /\/message-1\?/.test(String(url)))).toHaveLength(2);
  });
  it('resolves a native link-only share through the optional provider and publishes both channels once', async () => {
    const api = mockApi([message({ shares: { data: [{ link: 'https://www.instagram.com/reel/ABCdef123/' }] } })]);
    const original = api.fetcher.getMockImplementation()!;
    const texts: string[] = [];
    api.fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes('www.instagram.com/reel/')) return new Response('<html></html>');
      const guard = apifyGuardResponse(input); if (guard) return guard;
      if (String(input).includes('api.apify.com')) return Response.json([{ shortCode: 'ABCdef123', type: 'Video', productType: 'clips', videoUrl: 'https://lookaside.fbsbx.com/reel.mp4', caption: '  Original @creator.one 😂\n\n#Same #نفسه  ' }]);
      if (String(input) === 'https://api.buffer.com' && JSON.parse(String(init?.body)).query.includes('mutation')) texts.push(JSON.parse(String(init?.body)).variables.input.text);
      return original(input, init);
    });
    const configured: Env = { ...bindings(), DOWNLOADER_PROVIDER: 'apify', DOWNLOADER_API_KEY: 'fake-apify-api-key' };
    await pollInstagram(configured);
    await due();
    await pollInstagram(configured);
    expect(api.creates()).toBe(2);
    expect(texts).toEqual(['  Original  😂\n\n#Same #نفسه  ', '  Original  😂\n\n#Same #نفسه  ']);
    expect(await countJobs()).toBe(1);
    expect(api.fetcher.mock.calls.filter(([url]) => String(url).includes('api.apify.com/v2/actors/'))).toHaveLength(1);
  });
  it('publishes a native share through a free third-party fallback once even after repeated polling and job processing', async () => {
    const api = mockApi([message({ shares: { data: [{ link: 'https://www.instagram.com/reel/ABCdef123/', name: 'Original @creator #Same' }] } })]);
    const original = api.fetcher.getMockImplementation()!;
    api.fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes('www.instagram.com/reel/')) return new Response('<html></html>');
      if (String(input).includes('api.videodropper.app')) return Response.json({ video: [{ video: 'https://lookaside.fbsbx.com/reel.mp4' }] });
      return original(input, init);
    });
    const configured: Env = { ...bindings(), THIRD_PARTY_DOWNLOADER_PROVIDERS: 'videodropper,fastdl,savefrom,snapinsta' };
    await pollInstagram(configured);
    await due(); await pollInstagram(configured);
    const id = await env.DB.prepare('SELECT id FROM jobs LIMIT 1').first<string>('id');
    await processJob(configured, id!);
    expect(api.creates()).toBe(2);
    expect(await countJobs()).toBe(1);
    expect(api.fetcher.mock.calls.filter(([url]) => String(url).includes('api.videodropper.app'))).toHaveLength(1);
  });
  it('ignores stranger DMs even if Meta returns them in the owner-filtered conversation', async () => {
    const api = mockApi([message({ from: { id: '999', username: 'stranger' } })]);
    await pollInstagram(bindings());
    expect(await countJobs()).toBe(0);
    expect(api.creates()).toBe(0);
  });
  it('starts at activation and never posts old history or future-dated messages', async () => {
    const api = mockApi([message({ created_time: new Date(Date.now() - 3600_000).toISOString() }), message({ id: 'future', created_time: new Date(Date.now() + 3600_000).toISOString() })]);
    await pollInstagram(bindings());
    expect(await countJobs()).toBe(0);
    expect(api.creates()).toBe(0);
  });
  it('backs off on API failure without consuming a message or losing durable configuration', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 429 }));
    await pollInstagram(bindings());
    expect((await pollingStatus(bindings())).lastErrorCode).toBe('meta_http_429');
    expect((await pollingStatus(bindings())).nextAt).toBeGreaterThan(Date.now() + 100_000);
    await pollInstagram(bindings());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await countJobs()).toBe(0);
  });
  it('cannot fetch DMs or publish without configuration or in webhook mode', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const incomplete of [{ OWNER_IG_SENDER_ID: undefined }, { BUFFER_API_KEY: undefined }, { INGEST_MODE: 'webhook' as const }]) {
      await pollInstagram({ ...bindings(), ...incomplete });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await countJobs()).toBe(0);
  });
  it('acknowledges a signed webhook without creating a second ingestion path in polling mode', async () => {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: '222', messaging: [{ sender: { id: '111' }, recipient: { id: '222' }, timestamp: Date.now(), message: { mid: 'message-1', attachments: [{ type: 'reel', payload: { url: 'https://lookaside.fbsbx.com/reel.mp4' } }] } }] }] });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-app-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    const signature = 'sha256=' + [...hash].map(n => n.toString(16).padStart(2, '0')).join('');
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('https://worker.example/webhooks/instagram', { method: 'POST', body, headers: { 'x-hub-signature-256': signature } }), bindings(), ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await countJobs()).toBe(0);
  });
});

describe('authenticated API owner identification', () => {
  const code = 'meme-setup:' + 'a'.repeat(64);
  const selection = async () => ({ username: 'owner', challengeHash: await sha256(code) });
  async function pending() {
    await saveSetting(env, 'owner_setup', { hash: await sha256(code), createdAt: Date.now() - 60000, expiresAt: Date.now() + 15 * 60000, recipients: ['222','444'], senderId: null, matchedAt: null });
  }
  it('identifies the selected sender from the exact setup DM without publishing and preserves the proof only until secret installation', async () => {
    await pending();
    const api = mockApi([message({ message: code })]);
    const result = await importOwnerSetup({ ...bindings(), OWNER_IG_SENDER_ID: undefined }, await selection());
    expect(result).toEqual({ matched: true, verifiedBy: 'api', username: 'owner' });
    const proof = await settings<{ senderId: string; verifiedBy: string }>(bindings(), 'owner_setup');
    expect(proof?.senderId).toBe('111');
    expect(proof?.verifiedBy).toBe('api');
    expect(JSON.stringify(proof)).not.toContain(code);
    expect(await countJobs()).toBe(0);
    expect(api.creates()).toBe(0);
  });
  it('requires username, code and recipient to match and never rebinds an installed owner', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(importOwnerSetup(bindings(), await selection())).rejects.toThrow('owner_already_configured');
    expect(fetcher).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    for (const overrides of [{ from: { id: '999', username: 'stranger' } }, { message: 'wrong' }, { to: { data: [{ id: '555' }] } }]) {
      await pending();
      mockApi([message({ message: code, ...overrides })]);
      await expect(importOwnerSetup({ ...bindings(), OWNER_IG_SENDER_ID: undefined }, await selection())).rejects.toThrow('owner_api_proof_not_found');
      vi.restoreAllMocks();
    }
    expect((await settings<{senderId: string | null}>(bindings(), 'owner_setup'))?.senderId).toBeNull();
  });
  it('protects owner import and polling controls with admin authorization', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const [path, method] of [['owner/import', 'POST'], ['poll', 'POST'], ['poll/validate', 'GET'], ['download/diagnose', 'GET'], ['download/probe-apify', 'POST'], ['apify/budget', 'GET'], ['apify/enforce-limit', 'POST'], ['jobs/retry-download', 'POST'], ['jobs/refresh-posts', 'POST'], ['jobs/retry-rejected-delivery', 'POST']]) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request('https://worker.example/admin/' + path, { method }), bindings(), ctx);
      expect(response.status).toBe(401);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('safe pre-publication download recovery', () => {
  it('tests a full Apify download of an existing completed Reel without touching job, posts or R2', async () => {
    const source = parseApiMessage(message({ id: 'probe-existing-completed', shares: { data: [{ link: 'https://www.instagram.com/reel/ABCdef123/' }] } }), '111', ['222', '444'], 0)[0]!;
    const id = await enqueue(bindings(), source);
    await env.DB.prepare("UPDATE jobs SET state='completed' WHERE id=?").bind(id).run();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const guard = apifyGuardResponse(input); if (guard) return guard;
      if (String(input).includes('api.apify.com')) return Response.json([{ shortCode: 'ABCdef123', type: 'Video', productType: 'clips', videoUrl: 'https://lookaside.fbsbx.com/reel.mp4' }]);
      if (String(input).includes('fbsbx.com')) return new Response(mp4, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(mp4.length) } });
      throw new Error('Unexpected API');
    });
    const configured: Env = { ...bindings(), DOWNLOADER_PROVIDER: 'apify', DOWNLOADER_API_KEY: 'fake-apify-api-key' };
    expect(await probeApifyDownload(configured)).toMatchObject({ resolved: true, bytes: mp4.length, fullDownloadVerified: true });
    expect(await env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(id).first('state')).toBe('completed');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries').first('n')).toBe(0);
    expect(await env.MEDIA.head(`arabic-meme-autoposter/${id}.mp4`)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(5);
    await expect(probeApifyDownload({ ...configured, OWNER_IG_SENDER_ID: '999' })).rejects.toThrow('download_probe_not_safe');
    expect(fetcher).toHaveBeenCalledTimes(5);
    fetcher.mockImplementation(async input => apifyGuardResponse(input) ?? (String(input).includes('api.apify.com')
      ? Response.json([{ shortCode: 'ABCdef123', type: 'Video', productType: 'clips', videoUrl: 'https://lookaside.fbsbx.com/reel.mp4' }])
      : new Response(mp4.subarray(0, 12), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(mp4.length) } })));
    expect(await probeApifyDownload(configured)).toMatchObject({ resolved: false, code: 'video_length_mismatch' });
  });
  it('reuses the original job and prevents retries after any Buffer reservation', async () => {
    const api = mockApi();
    const source = parseApiMessage(message(), '111', ['222', '444'], 0)[0]!;
    const id = await enqueue(bindings(), source);
    await env.DB.prepare("UPDATE jobs SET state='attention', error_code='no_downloader_could_resolve_reel' WHERE id=?").bind(id).run();
    await retryDownload(bindings(), id);
    await processJob(bindings(), id);
    expect(await countJobs()).toBe(1);
    expect(api.creates()).toBe(2);
    await env.DB.prepare("UPDATE jobs SET state='attention',object_key=NULL WHERE id=?").bind(id).run();
    await expect(retryDownload(bindings(), id)).rejects.toThrow('download_retry_not_safe');
    expect(api.creates()).toBe(2);
  });
  it('rejects stale jobs and jobs belonging to a different sender', async () => {
    const source = parseApiMessage(message(), '111', ['222', '444'], 0)[0]!;
    await expect(enqueue(bindings(), { ...source, senderId: '999' })).rejects.toThrow('sender_not_authorized');
    for (const override of [{ timestamp: Date.now() - 49 * 3600_000 }, { timestamp: Date.now() + 3600_000 }]) {
      const id = await enqueue(bindings(), { ...source, mediaId: crypto.randomUUID(), ...override, messageId: crypto.randomUUID() });
      await env.DB.prepare("UPDATE jobs SET state='attention' WHERE id=?").bind(id).run();
      await expect(retryDownload(bindings(), id)).rejects.toThrow('download_retry_not_safe');
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries').first('n')).toBe(0);
  });
  it('recovers a resolved native Reel once, confirms both sent posts and deletes private media', async () => {
    const api = mockApi();
    const source = parseApiMessage(message({ shares: { data: [{ link: 'https://www.instagram.com/reel/ABCdef123/', name: 'Original @creator #Same' }] } }), '111', ['222', '444'], 0)[0]!;
    const id = await enqueue(bindings(), source);
    await env.DB.prepare("UPDATE jobs SET state='attention' WHERE id=?").bind(id).run();
    const resolved = { reelUrl: source.reelUrl!, videoUrl: 'https://lookaside.fbsbx.com/reel.mp4' };
    const attempts = await Promise.allSettled([retryDownload(bindings(), id, resolved), retryDownload(bindings(), id, resolved)]);
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    await processJob(bindings(), id);
    expect(api.creates()).toBe(2);
    expect(await env.MEDIA.head(`arabic-meme-autoposter/${id}.mp4`)).not.toBeNull();
    await refreshPosts(bindings(), id);
    expect(await env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(id).first('state')).toBe('completed');
    expect(await env.MEDIA.head(`arabic-meme-autoposter/${id}.mp4`)).toBeNull();
    await expect(refreshPosts(bindings(), id)).rejects.toThrow('post_refresh_not_available');
    await expect(retryDownload(bindings(), id, resolved)).rejects.toThrow('download_retry_not_safe');
    await enqueue(bindings(), source); await processJob(bindings(), id);
    expect(api.creates()).toBe(2);
    expect(await countJobs()).toBe(1);
  });
  it('rejects mismatched Reels and unsafe recovery URLs without changing the stored DM or fetching', async () => {
    const api = mockApi();
    const source = parseApiMessage(message({ shares: { data: [{ link: 'https://www.instagram.com/reel/ABCdef123/' }] } }), '111', ['222', '444'], 0)[0]!;
    const id = await enqueue(bindings(), source);
    await env.DB.prepare("UPDATE jobs SET state='attention' WHERE id=?").bind(id).run();
    await expect(retryDownload(bindings(), id, { reelUrl: 'https://www.instagram.com/reel/Different/', videoUrl: 'https://lookaside.fbsbx.com/reel.mp4' })).rejects.toThrow('recovery_reel_mismatch');
    for (const videoUrl of ['http://lookaside.fbsbx.com/video.mp4', 'https://cdninstagram.com.evil.example/video.mp4', 'https://token@lookaside.fbsbx.com/video.mp4', 'https://127.0.0.1/video.mp4']) {
      await expect(retryDownload(bindings(), id, { reelUrl: source.reelUrl!, videoUrl })).rejects.toThrow('untrusted_url');
    }
    expect(await env.DB.prepare('SELECT source_json FROM jobs WHERE id=?').bind(id).first('source_json')).toBe(JSON.stringify(source));
    expect(api.fetcher).not.toHaveBeenCalled();
    expect(api.creates()).toBe(0);
  });
  it('does not count a sent reminder as successful automatic publishing', async () => {
    const api = mockApi();
    const original = api.fetcher.getMockImplementation()!;
    api.fetcher.mockImplementation(async (input, init) => {
      if (String(input) === 'https://api.buffer.com' && !JSON.parse(String(init?.body)).query.includes('mutation')) {
        return Response.json({ data: { post: { id: 'post', status: 'sent', schedulingType: 'notification' } } });
      }
      return original(input, init);
    });
    const id = await enqueue(bindings(), parseApiMessage(message(), '111', ['222', '444'], 0)[0]!);
    await processJob(bindings(), id);
    await refreshPosts(bindings(), id);
    expect(await env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(id).first('state')).toBe('failed');
    expect(api.creates()).toBe(2);
    expect(await env.MEDIA.head(`arabic-meme-autoposter/${id}.mp4`)).toBeNull();
  });
});
