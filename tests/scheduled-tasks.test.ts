import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { enqueue, processJob, saveSetting } from '../src/jobs';
import { runScheduledTasks } from '../src/scheduled-tasks';
import type { Env } from '../src/types';

const bindings = (): Env => ({ ...env, INGEST_MODE: 'polling', META_ACCESS_TOKEN: 'fake-meta', BUFFER_API_KEY: 'fake-buffer' });
const video = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
beforeEach(async () => {
  await env.DB.batch(['deliveries','message_tombstones','jobs','settings'].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  const objects = await env.MEDIA.list(); if (objects.objects.length) await env.MEDIA.delete(objects.objects.map(o => o.key));
  await saveSetting(env, 'channels', ['instagram','tiktok'].map((service, i) => ({ id: service, service, name: 'memes', serviceId: String(222 + i), organizationId: 'org', isDisconnected: false, isLocked: false })));
  await saveSetting(env, 'recipient_ids', ['222']);
  await saveSetting(env, 'instagram_poll', { startedAt: Date.now() - 60000, seen: [], versions: {} });
});
afterEach(() => vi.restoreAllMocks());

it('publishes and reconciles through separate authenticated cloud tasks, preserving captions and deduplication', async () => {
  const tasks: string[] = [];
  const senders: string[] = [];
  let posts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://worker.example') {
      tasks.push(url.pathname);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-admin');
      expect(init?.redirect).toBe('manual');
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(url, init), bindings(), ctx);
      await waitOnExecutionContext(ctx);
      return response;
    }
    if (url.pathname.endsWith('/me/conversations')) {
      senders.push(url.searchParams.get('user_id')!);
      return Response.json({ data: [{ id: 'conversation-1' }] });
    }
    if (url.pathname.endsWith('/conversation-1')) return Response.json({ messages: { data: [1,2].map(n => ({ id: `dm-${n}`, created_time: new Date(Date.now() - 1000).toISOString() })) } });
    if (/\/dm-\d$/.test(url.pathname)) return Response.json({ id: url.pathname.split('/').pop(), created_time: new Date(Date.now() - 1000).toISOString(), from: { id: '111' }, to: { data: [{ id: '222' }] }, shares: { data: [{ type: 'ig_reel', id: 'same-reel', url: 'https://lookaside.fbsbx.com/reel.mp4', name: 'Original @creator #Same' }] } });
    if (url.hostname === 'lookaside.fbsbx.com') return new Response(video, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.length) } });
    if (url.hostname === 'api.buffer.com') {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes('mutation')) {
        expect(body.variables.input.text).toBe('Original  #Same');
        return Response.json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'post-' + ++posts, status: 'sending', schedulingType: 'automatic' } } } });
      }
      return Response.json({ data: { post: { id: body.variables.input.id, status: 'sent', schedulingType: 'automatic' } } });
    }
    throw new Error('Unexpected request');
  });
  await runScheduledTasks(bindings());
  expect(senders).toEqual(['111']);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first('n')).toBe(1);
  expect(posts).toBe(2);
  expect(tasks.filter(path => path === '/admin/tasks/job')).toHaveLength(3);
  expect(await env.DB.prepare('SELECT state FROM jobs').first('state')).toBe('waiting');
  await env.DB.prepare("UPDATE jobs SET next_run_at=0 WHERE state='waiting'").run();
  await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.nextAt',0) WHERE key='instagram_poll'").run();
  await runScheduledTasks(bindings());
  expect(senders).toEqual(['111','777']);
  expect(posts).toBe(2);
  expect(await env.DB.prepare('SELECT state FROM jobs').first('state')).toBe('completed');
  expect((await env.MEDIA.list()).objects).toHaveLength(0);
});

it('stops all ingest and publishing tasks when the free usage guard pauses', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ allowed: false, code: 'cloudflare_d1_writes_daily_pause' }));
  await runScheduledTasks(bindings());
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]![0])).toBe('https://worker.example/admin/cloudflare/usage');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first('n')).toBe(0);
});

it('continues durable job recovery when the polling invocation fails', async () => {
  const paths: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path === '/admin/cloudflare/usage') return Response.json({ allowed: true });
    if (path === '/admin/tasks/poll') return new Response('resource limit', { status: 500 });
    return Response.json({ jobIds: [] });
  });
  await runScheduledTasks(bindings());
  expect(paths).toEqual(['/admin/cloudflare/usage','/admin/tasks/poll','/admin/tasks/maintenance']);
});

it('authenticates every task endpoint before database reads, external requests or publishing', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  for (const path of ['poll','enqueue','job','maintenance','cleanup-reservations']) {
    const ctx = createExecutionContext();
    expect((await worker.fetch(new Request('https://worker.example/admin/tasks/' + path, { method: 'POST' }), bindings(), ctx)).status).toBe(401);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('checks both slow publishing channels once before backing off instead of exhausting the free Buffer quota', async () => {
  const id = await enqueue(bindings(), { kind: 'reel', messageId: 'slow-posts', senderId: '111', recipientId: '222', timestamp: Date.now(), reelUrl: 'https://www.instagram.com/reel/SlowPosts/' });
  await env.DB.prepare("UPDATE jobs SET state='waiting',next_run_at=0 WHERE id=?").bind(id).run();
  for (const service of ['instagram','tiktok']) await env.DB.prepare("INSERT INTO deliveries(job_id,service,channel_id,state,post_id,post_status,updated_at) VALUES (?,?,?,'accepted',?,'sending',?)").bind(id, service, service, 'post-' + service, Date.now() - 120000).run();
  const checked: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const postId = JSON.parse(String(init?.body)).variables.input.id; checked.push(postId);
    return Response.json({ data: { post: { id: postId, status: 'sending', schedulingType: 'automatic' } } });
  });
  for (let attempt = 0; attempt < 3; attempt++) await processJob(bindings(), id, 1, 1);
  expect(checked.sort()).toEqual(['post-instagram','post-tiktok']);
  expect(await env.DB.prepare('SELECT next_run_at FROM jobs WHERE id=?').bind(id).first<number>('next_run_at')).toBeGreaterThan(Date.now() + 50000);
});
