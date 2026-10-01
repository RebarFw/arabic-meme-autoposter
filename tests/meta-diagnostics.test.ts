import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';

const token = 'fake-instagram-access-token';
const bindings: Env = { ...env, META_ACCESS_TOKEN: token, BUFFER_API_KEY: undefined };
async function call(path: string, method = 'GET', authorized = true, config = bindings) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request('https://worker.example' + path, { method, headers: authorized ? { Authorization: 'Bearer test-admin' } : {} }), config, context);
  await waitOnExecutionContext(context);
  return response;
}
afterEach(() => vi.restoreAllMocks());

it('keeps authenticated Meta recovery reads available while a broken analytics reader blocks setup mutations', async () => {
  const guarded = { ...bindings, CLOUDFLARE_USAGE_GUARD: 'true', CLOUDFLARE_USAGE_TOKEN: 'fake-cloudflare-reader' };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).startsWith('https://api.cloudflare.com/')) return Response.json({ errors: [{ message: 'not authorized for account' }] });
    expect(new URL(String(input)).origin).toBe('https://graph.instagram.com');
    expect(init?.method).not.toBe('POST');
    if (String(input).includes('/me?')) return Response.json({ id: '456', user_id: '123', username: 'memepage' });
    return Response.json({ data: [] });
  });
  expect((await call('/admin/meta/diagnose', 'GET', false, guarded)).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await call('/admin/meta/diagnose', 'GET', true, guarded)).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const path of ['/admin/setup', '/admin/meta/subscribe', '/admin/owner/start', '/admin/owner/finish']) {
    const response = await call(path, 'POST', true, guarded);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('cloudflare_usage_api_error');
  }
  expect(fetcher.mock.calls.filter(([input]) => String(input).startsWith('https://graph.instagram.com/'))).toHaveLength(3);
});

it('redacts both approved sender IDs and the analytics reader from echoed provider errors', async () => {
  const guardedSecrets = { ...bindings, OWNER_IG_SENDER_ID: '10101010101010', FRIEND_IG_SENDER_ID: '20202020202020', CLOUDFLARE_USAGE_TOKEN: 'fake-analytics-reader-secret' };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { code: 190, message: `${guardedSecrets.OWNER_IG_SENDER_ID} ${guardedSecrets.FRIEND_IG_SENDER_ID} ${guardedSecrets.CLOUDFLARE_USAGE_TOKEN}` } }, { status: 401 }));
  const text = await (await call('/admin/meta/diagnose', 'GET', true, guardedSecrets)).text();
  expect(text).toContain('"code":190');
  for (const secret of [guardedSecrets.OWNER_IG_SENDER_ID, guardedSecrets.FRIEND_IG_SENDER_ID, guardedSecrets.CLOUDFLARE_USAGE_TOKEN]) expect(text).not.toContain(secret);
});

it('protects Meta diagnostics and subscription mutations before any external requests', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  expect((await call('/admin/meta/diagnose', 'GET', false)).status).toBe(401);
  expect((await call('/admin/meta/subscribe', 'POST', false)).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await call('/admin/meta/subscribe', 'GET')).status).toBe(404);
  expect((await call('/admin/meta/diagnose', 'GET', true, { ...bindings, META_ACCESS_TOKEN: undefined })).status).toBe(503);
  expect(fetcher).not.toHaveBeenCalled();
});

it('reports messaging authorization errors and existing account subscription without requiring Buffer', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(new URL(String(input)).origin).toBe('https://graph.instagram.com');
    expect(init?.headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${token}` }));
    expect(init?.redirect).toBe('manual');
    expect(init?.method).not.toBe('POST');
    if (String(input).includes('/me?')) return Response.json({ id: '456', user_id: '123', username: 'memepage' });
    if (String(input).includes('/me/conversations?')) return Response.json({ error: { code: 10, message: 'Application does not have permission for this action' } }, { status: 403 });
    return Response.json({ data: [{ id: '987', name: 'Arabic Meme Autoposter', subscribed_fields: ['comments'] }] });
  });
  const response = await call('/admin/meta/diagnose');
  expect(response.status).toBe(200);
  const body = await response.json() as { account: { id: string }; permissions: { required: Record<string, string> }; subscriptionBefore: { apps: { id: string; fields: string[] }[] } };
  expect(body.account.id).toBe('123');
  expect(body.permissions.required).toEqual({ instagram_business_basic: 'verified_by_api', instagram_business_manage_messages: 'unknown' });
  expect(body.subscriptionBefore.apps).toEqual([{ id: '987', name: 'Arabic Meme Autoposter', fields: ['comments'] }]);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('rejects API redirects without forwarding the access token', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    expect(init?.redirect).toBe('manual');
    return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/' } });
  });
  const response = await call('/admin/meta/subscribe', 'POST');
  const text = await response.text();
  expect(text).toContain('"httpStatus":302');
  expect(text).not.toContain(token);
  expect(text).not.toContain('untrusted.example');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('detects a literal Ctrl+V stored instead of a token without querying Meta or returning the secret', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const response = await call('/admin/meta/diagnose', 'GET', true, { ...bindings, META_ACCESS_TOKEN: String.fromCharCode(22) });
  const body = await response.json() as { error: string; tokenFormatting: { nonTokenCharacterCodes: string[] } };
  expect(body.error).toBe('invalid_meta_access_token_format');
  expect(body.tokenFormatting.nonTokenCharacterCodes).toEqual(['U+0016']);
  expect(fetcher).not.toHaveBeenCalled();
});

it('accepts matching enclosing quotes while redacting the normalized token in Meta errors', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    expect(init?.headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${token}` }));
    return Response.json({ error: { code: 190, message: `Invalid ${token}` } }, { status: 401 });
  });
  const response = await call('/admin/meta/diagnose', 'GET', true, { ...bindings, META_ACCESS_TOKEN: ` "${token}" ` });
  const text = await response.text();
  expect(text).toContain('"code":190');
  expect(text).not.toContain(token);
});

it('creates and reads back the subscription while preserving existing fields and avoiding unsupported scope conclusions', async () => {
  let created = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).includes('/me?')) return Response.json({ data: [{ id: '456', user_id: '123', username: 'memepage' }] });
    if (String(input).includes('/me/conversations?')) return Response.json({ error: { code: 100, message: 'Request failed', type: 'OAuthException' } }, { status: 400 });
    if (init?.method === 'POST') {
      expect(String(input)).toMatch(/\/123\/subscribed_apps$/);
      expect(new URLSearchParams(String(init.body)).get('subscribed_fields')).toBe('messages,comments');
      created = true;
      return Response.json({ success: true });
    }
    return Response.json({ data: [{ id: '987', name: 'Arabic Meme Autoposter', subscribed_fields: created ? ['messages', 'comments'] : ['comments'] }] });
  });
  const response = await call('/admin/meta/subscribe', 'POST');
  const body = await response.json() as { permissions: { required: Record<string, string> }; subscriptionCreate: { success: boolean }; subscriptionAfter: { apps: { fields: string[] }[] }; appReview: string };
  expect(body.permissions.required.instagram_business_manage_messages).toBe('unknown');
  expect(body.subscriptionCreate.success).toBe(true);
  expect(body.subscriptionAfter.apps[0]?.fields).toContain('messages');
  expect(body.appReview).toContain('Not blocking this account subscription');
});

it('verifies basic and messaging access through documented API calls without exposing conversation IDs or claiming a scopes list', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).includes('/me?')) return Response.json({ id: '456', user_id: '123', username: 'memepage' });
    if (String(input).includes('/me/conversations?')) return Response.json({ data: [{ id: 'private-conversation-id' }] });
    return Response.json({ data: [{ id: '987', subscribed_fields: ['messages'] }] });
  });
  const response = await call('/admin/meta/diagnose');
  const text = await response.text();
  const body = JSON.parse(text) as { permissions: { required: Record<string, string>; scopesEnumerated: boolean; messaging: { httpStatus: number } } };
  expect(body.permissions.required).toEqual({ instagram_business_basic: 'verified_by_api', instagram_business_manage_messages: 'verified_by_api' });
  expect(body.permissions.scopesEnumerated).toBe(false);
  expect(body.permissions.messaging.httpStatus).toBe(200);
  expect(text).not.toContain('private-conversation-id');
});

it('keeps Meta error codes and trace IDs but redacts echoed secrets and never logs raw API errors', async () => {
  const logger = vi.spyOn(console, 'log');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: { code: 190, error_subcode: 463, type: 'OAuthException', fbtrace_id: 'trace-123', message: `Expired ${token} https://graph.instagram.com/me?access_token=${token}` } }, { status: 400 }));
  const response = await call('/admin/meta/subscribe', 'POST');
  const text = await response.text();
  expect(text).toContain('"code":190');
  expect(text).toContain('"subcode":463');
  expect(text).toContain('trace-123');
  expect(text).toContain('[redacted]');
  expect(text).not.toContain(token);
  expect(text).not.toContain('access_token=');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(logger).not.toHaveBeenCalled();
});
