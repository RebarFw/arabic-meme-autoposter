import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { maintenance, settings } from '../src/jobs';
import type { Env } from '../src/types';

const unconfigured = (): Env => ({ ...env, META_ACCESS_TOKEN: 'fake-meta', OWNER_IG_SENDER_ID: undefined, BUFFER_API_KEY: undefined });
const auth = { Authorization: 'Bearer test-admin' };
async function call(path: string, init: RequestInit = {}, bindings: Env = unconfigured()) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('https://worker.example' + path, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function start() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: '222', user_id: '222', username: 'memes' }));
  const response = await call('/admin/owner/start', { method: 'POST', headers: auth });
  expect(response.status).toBe(200);
  return await response.json() as { message: string; expiresAt: number };
}
function payload(message: string, senderId = '111') {
  return { object: 'instagram', entry: [{ id: '222', messaging: [{ sender: { id: senderId }, recipient: { id: '222' }, timestamp: Date.now(), message: { mid: 'setup-mid', text: message, is_echo: false } }] }] };
}
async function send(body: unknown, authentic = true, bindings = unconfigured()) {
  const text = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-app-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  const signature = authentic ? Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('') : '0'.repeat(64);
  return call('/webhooks/instagram', { method: 'POST', body: text, headers: { 'x-hub-signature-256': 'sha256=' + signature } }, bindings);
}
async function status() {
  return await (await call('/admin/owner/status', { headers: auth })).json() as { matched: boolean; expired: boolean; senderId?: string };
}
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM deliveries'), env.DB.prepare('DELETE FROM message_tombstones'), env.DB.prepare('DELETE FROM jobs'), env.DB.prepare('DELETE FROM settings')]);
});
afterEach(() => vi.restoreAllMocks());

describe('one-time approved sender setup', () => {
  it('protects every administrative setup operation before calling Meta', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const [path, method] of [['start', 'POST'], ['status', 'GET'], ['diagnose', 'GET'], ['finish', 'POST']]) {
      expect((await call('/admin/owner/' + path, { method })).status).toBe(401);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('stores only the hash of an expiring challenge', async () => {
    const challenge = await start();
    expect(challenge.message).toMatch(/^meme-setup:[a-f0-9]{64}$/);
    expect(challenge.expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
    const stored = await settings<{ hash: string }>(unconfigured(), 'owner_setup');
    expect(stored?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(challenge.message);
  });
  it('rejects forged signatures and authentic DMs with the wrong challenge', async () => {
    const challenge = await start();
    expect((await send(payload(challenge.message), false)).status).toBe(403);
    expect((await send(payload('meme-setup:' + '0'.repeat(64)))).status).toBe(200);
    expect((await status()).matched).toBe(false);
  });
  it('uses a signed challenge DM to identify a sender without publishing or exposing the ID publicly', async () => {
    const challenge = await start();
    const fetcher = vi.mocked(globalThis.fetch);
    fetcher.mockClear();
    const response = await send(payload(challenge.message));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, ownerSetup: true });
    expect((await status()).senderId).toBe('111');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>())?.n).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await call('/admin/owner/status')).status).toBe(401);
  });
  it('ignores echoes, other recipients, stale messages and missing message IDs', async () => {
    const challenge = await start();
    const invalid = [payload(challenge.message), payload(challenge.message), payload(challenge.message), payload(challenge.message)];
    invalid[0]!.entry[0]!.messaging[0]!.message.is_echo = true;
    invalid[1]!.entry[0]!.messaging[0]!.recipient.id = '999';
    invalid[2]!.entry[0]!.messaging[0]!.timestamp -= 60_000;
    invalid[3]!.entry[0]!.messaging[0]!.message.mid = '';
    for (const body of invalid) expect((await send(body)).status).toBe(200);
    expect((await status()).matched).toBe(false);
  });
  it('keeps exactly one sender when deliveries race and acknowledges duplicate delivery', async () => {
    const challenge = await start();
    await Promise.all(['111', '333'].map(sender => send(payload(challenge.message, sender))));
    const winner = (await status()).senderId;
    expect(['111', '333']).toContain(winner);
    expect((await send(payload(challenge.message, winner))).status).toBe(200);
    expect((await send(payload(challenge.message, winner === '111' ? '333' : '111'))).status).toBe(200);
    expect((await status()).senderId).toBe(winner);
  });
  it('invalidates an old challenge when an authenticated operator starts again', async () => {
    const old = await start();
    vi.restoreAllMocks();
    const current = await start();
    expect((await send(payload(old.message))).status).toBe(200);
    expect((await status()).matched).toBe(false);
    expect((await send(payload(current.message))).status).toBe(200);
  });
  it('rejects expired challenges and removes their proof during cleanup', async () => {
    const challenge = await start();
    await env.DB.prepare("UPDATE settings SET value=json_set(value, '$.expiresAt', ?) WHERE key='owner_setup'").bind(Date.now() - 1).run();
    expect((await send(payload(challenge.message))).status).toBe(200);
    expect((await status()).expired).toBe(true);
    await maintenance(unconfigured());
    expect(await settings(unconfigured(), 'owner_setup')).toBeNull();
  });
  it('removes setup proof only after the exact matched sender is installed as a secret', async () => {
    const challenge = await start();
    await send(payload(challenge.message));
    for (const owner of [undefined, '333']) {
      const response = await call('/admin/owner/finish', { method: 'POST', headers: auth }, { ...unconfigured(), OWNER_IG_SENDER_ID: owner });
      expect(response.status).toBe(503);
      expect((await status()).matched).toBe(true);
    }
    const response = await call('/admin/owner/finish', { method: 'POST', headers: auth }, { ...unconfigured(), OWNER_IG_SENDER_ID: '111' });
    expect(response.status).toBe(200);
    expect(await settings(unconfigured(), 'owner_setup')).toBeNull();
  });
  it('never rebinds an already configured owner', async () => {
    const challenge = await start();
    const configured = { ...unconfigured(), OWNER_IG_SENDER_ID: '111', BUFFER_API_KEY: 'fake-buffer' };
    expect((await call('/admin/owner/start', { method: 'POST', headers: auth }, configured)).status).toBe(503);
    await send(payload(challenge.message, '333'), true, configured);
    expect((await status()).matched).toBe(false);
  });
  it('diagnoses the pending DM through Meta without storing message content or authorizing its sender', async () => {
    const challenge = await start();
    const fetcher = vi.mocked(globalThis.fetch);
    fetcher.mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/me/conversations')) return Response.json({ data: [{ id: 'conversation-1' }] });
      if (url.includes('/conversation-1?')) return Response.json({ messages: { data: [{ id: 'message-1', created_time: new Date().toISOString() }] } });
      if (url.includes('/message-1?')) return Response.json({ message: challenge.message, from: { id: '111' }, to: { data: [{ id: '222' }] } });
      throw new Error('Unexpected Meta request');
    });
    const response = await call('/admin/owner/diagnose', { headers: auth });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ challengeFound: true, exactText: true, recipientMatches: true, senderPresent: true, webhookVerified: false });
    expect(JSON.stringify(result)).not.toContain(challenge.message);
    expect(JSON.stringify(result)).not.toContain('111');
    expect((await status()).matched).toBe(false);
    expect(JSON.stringify(await settings(unconfigured(), 'owner_setup'))).not.toContain(challenge.message);
  });
  it('ignores old API messages and detects line breaks without accepting a webhook or binding a sender', async () => {
    const challenge = await start();
    const fetcher = vi.mocked(globalThis.fetch);
    fetcher.mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/me/conversations')) return Response.json({ data: [{ id: 'conversation-1' }] });
      if (url.includes('/conversation-1?')) return Response.json({ messages: { data: [
        { id: 'old', created_time: new Date(Date.now() - 60_000).toISOString() },
        { id: 'current', created_time: new Date().toISOString() },
      ] } });
      expect(url).not.toContain('/old?');
      return Response.json({ message: challenge.message.replace('meme-setup:', 'meme-\nsetup:'), from: { id: '111' }, to: { data: [{ id: '999' }] } });
    });
    const response = await call('/admin/owner/diagnose', { headers: auth });
    expect(await response.json()).toMatchObject({ challengeFound: true, exactText: false, recipientMatches: false, webhookVerified: false });
    expect((await status()).matched).toBe(false);
  });
});
