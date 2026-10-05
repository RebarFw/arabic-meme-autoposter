import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { asyncApifyItems } from '../src/apify-download';
import { downloadVideo } from '../src/downloaders';
import { enqueue, processJob, saveSetting, settings } from '../src/jobs';
import { DownloadDeferred, type Env, type ReelSource } from '../src/types';
import { apifyGuardResponse } from './apify-fixture';

const bindings: Env = { ...env, APIFY_ASYNC_DOWNLOADS: 'true', DOWNLOADER_PROVIDER: 'apify', DOWNLOADER_API_KEY: 'fake-apify-api-key', BUFFER_API_KEY: 'fake-buffer', ALLOW_PUBLIC_PAGE_DOWNLOADER: 'false', THIRD_PARTY_DOWNLOADER_PROVIDERS: '' };
const source = (): ReelSource => ({ kind: 'reel', messageId: 'slow-reel', senderId: '777', recipientId: '222', timestamp: Date.now(), reelUrl: 'https://www.instagram.com/reel/SlowReel123/' });
const id = 'a'.repeat(64);
const item = { shortCode: 'SlowReel123', type: 'Video', productType: 'clips', videoUrl: 'https://scontent.cdninstagram.com/clip.mp4', caption: '  Original @creator 😂\n#Same  ' };
const mp4 = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
beforeEach(async () => {
  await env.DB.batch(['deliveries','message_tombstones','jobs','settings','apify_budget'].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  const objects = await env.MEDIA.list(); if (objects.objects.length) await env.MEDIA.delete(objects.objects.map(o => o.key));
  await saveSetting(env, 'channels', ['instagram','tiktok'].map((service, i) => ({ id: service, service, name: 'memes', serviceId: String(222 + i), organizationId: 'org', isDisconnected: false, isLocked: false })));
  await saveSetting(env, 'recipient_ids', ['222']);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function providerMock() {
  const control = { status: 'RUNNING', starts: 0, creates: 0, polls: 0 };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const guard = apifyGuardResponse(input); if (guard) return guard;
    const url = new URL(String(input));
    if (url.pathname === '/v2/actors/apify~instagram-reel-scraper/runs' && init?.method === 'POST') {
      expect(url.searchParams.get('timeout')).toBe('600');
      expect(url.searchParams.get('maxTotalChargeUsd')).toBe('0.0073');
      expect(url.searchParams.get('maxItems')).toBe('1');
      expect(url.searchParams.has('token')).toBe(false);
      expect(JSON.parse(String(init.body))).toMatchObject({ username: [source().reelUrl], includeSharesCount: false, includeTranscript: false, includeDownloadedVideo: false });
      return Response.json({ data: { id: 'run' + ++control.starts, defaultDatasetId: 'data' + control.starts, status: 'READY' } });
    }
    if (/\/actor-runs\/run\d$/.test(url.pathname)) {
      control.polls++;
      const number = url.pathname.match(/run(\d)$/)![1];
      return Response.json({ data: { id: 'run' + number, defaultDatasetId: 'data' + number, status: control.status } });
    }
    if (/\/datasets\/data\d\/items$/.test(url.pathname)) return Response.json([item]);
    if (url.hostname === 'scontent.cdninstagram.com') {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return new Response(mp4, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(mp4.length) } });
    }
    if (url.hostname === 'api.buffer.com') {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes('mutation')) {
        expect(body.variables.input.text).toBe('  Original  😂\n#Same  ');
        return Response.json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'post' + ++control.creates, status: 'sending', schedulingType: 'automatic' } } } });
      }
      return Response.json({ data: { post: { id: body.variables.input.id, status: 'sent', schedulingType: 'automatic' } } });
    }
    throw new Error('Unexpected request');
  });
  return { control, fetcher };
}

it('starts once under concurrent callers and resumes the same run after more than five polling invocations', async () => {
  const { control } = providerMock();
  const dm = source();
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => asyncApifyItems(dm, bindings, id)));
  expect(attempts.every(result => result.status === 'rejected' && result.reason instanceof DownloadDeferred)).toBe(true);
  expect(control.starts).toBe(1);
  for (let poll = 0; poll < 6; poll++) await expect(asyncApifyItems(dm, bindings, id)).rejects.toBeInstanceOf(DownloadDeferred);
  expect(control.starts).toBe(1);
  control.status = 'SUCCEEDED';
  expect(await asyncApifyItems(dm, bindings, id)).toEqual([item]);
  expect(await env.DB.prepare('SELECT runs FROM apify_budget').first('runs')).toBe(1);
});

it('keeps slow downloads pending without exhausting attempts, then publishes exactly once and deletes media', async () => {
  const { control } = providerMock();
  const jobId = await enqueue(bindings, source());
  for (let poll = 0; poll < 7; poll++) {
    await env.DB.prepare('UPDATE jobs SET next_run_at=0 WHERE id=?').bind(jobId).run();
    if (poll) await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.nextAt',0) WHERE key=?").bind('apify_download:' + jobId).run();
    await processJob(bindings, jobId);
    expect(await env.DB.prepare('SELECT state,attempts,object_key FROM jobs WHERE id=?').bind(jobId).first()).toMatchObject({ state: 'pending', attempts: 0, object_key: null });
  }
  expect(control.starts).toBe(1); expect(control.creates).toBe(0);
  control.status = 'SUCCEEDED';
  await env.DB.prepare('UPDATE jobs SET next_run_at=0 WHERE id=?').bind(jobId).run();
  await processJob(bindings, jobId);
  expect(control.creates).toBe(2);
  await env.DB.prepare('UPDATE jobs SET next_run_at=0 WHERE id=?').bind(jobId).run();
  await processJob(bindings, jobId);
  expect(await env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(jobId).first('state')).toBe('completed');
  expect(await env.MEDIA.head(`arabic-meme-autoposter/${jobId}.mp4`)).toBeNull();
  await enqueue(bindings, source()); await processJob(bindings, jobId);
  expect(control.creates).toBe(2); expect(control.starts).toBe(1);
});

it('backs off timed-out cloud runs and starts at most three capped attempts', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { control } = providerMock(); const dm = source();
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(asyncApifyItems(dm, bindings, id)).rejects.toBeInstanceOf(DownloadDeferred);
    vi.setSystemTime(Date.now() + 610000);
    control.status = 'TIMED-OUT';
    if (attempt < 2) {
      await expect(asyncApifyItems(dm, bindings, id)).rejects.toMatchObject({ code: 'apify_run_timed_out' });
      await expect(asyncApifyItems(dm, bindings, id)).rejects.toBeInstanceOf(DownloadDeferred);
      const record = await settings<{ nextAt: number }>(bindings, 'apify_download:' + id);
      vi.setSystemTime(record!.nextAt + 1);
    } else await expect(asyncApifyItems(dm, bindings, id)).rejects.toMatchObject({ code: 'apify_run_timed_out', retryable: false });
  }
  expect(control.starts).toBe(3);
  expect(await env.DB.prepare('SELECT runs FROM apify_budget').first('runs')).toBe(3);
});

it('reconciles an ambiguous start without creating or reserving another run', async () => {
  const { fetcher, control } = providerMock(); const original = fetcher.getMockImplementation()!; const dm = source();
  fetcher.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/apify~instagram-reel-scraper/runs')) {
      if (init?.method === 'POST') { control.starts++; throw new Error('Lost acknowledgement'); }
      return Response.json({ data: { items: [{ id: 'run1', defaultDatasetId: 'data1', defaultKeyValueStoreId: 'store1', startedAt: new Date().toISOString(), options: { timeoutSecs: 600, maxTotalChargeUsd: 0.0073 } }] } });
    }
    if (url.pathname.endsWith('/records/INPUT')) return Response.json({ username: [dm.reelUrl] });
    return original(input, init);
  });
  await expect(asyncApifyItems(dm, bindings, id)).rejects.toMatchObject({ code: 'apify_start_uncertain' });
  await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.nextAt',0) WHERE key=?").bind('apify_download:' + id).run();
  control.status = 'SUCCEEDED';
  expect(await asyncApifyItems(dm, bindings, id)).toEqual([item]);
  expect(control.starts).toBe(1);
  expect(await env.DB.prepare('SELECT runs FROM apify_budget').first('runs')).toBe(1);
});

it('fails closed before an Actor start on a paid plan and preserves the real timeout error', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).endsWith('/users/me')) return Response.json({ data: { id: 'fake-user', plan: { tier: 'STARTER', monthlyBasePriceUsd: 19, monthlyUsageCreditsUsd: 19 } } });
    return apifyGuardResponse(input)!;
  });
  await expect(asyncApifyItems(source(), bindings, id)).rejects.toThrow('apify_free_plan_required');
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/actors/'))).toBe(false);
  fetcher.mockImplementation(async input => apifyGuardResponse(input) ?? new Response(null, { status: 408 }));
  await expect(downloadVideo(source(), { ...bindings, APIFY_ASYNC_DOWNLOADS: 'false', ALLOW_PUBLIC_PAGE_DOWNLOADER: 'true' }, 'probe', undefined, true)).rejects.toMatchObject({ code: 'apify_http_408', retryable: true });
});

it('waits at the concurrency ceiling without spending another credit reservation', async () => {
  const { control } = providerMock();
  for (let number = 1; number <= 4; number++) await expect(asyncApifyItems(source(), bindings, String(number).padStart(64,'0'))).rejects.toBeInstanceOf(DownloadDeferred);
  await expect(asyncApifyItems(source(), bindings, '5'.padStart(64,'0'))).rejects.toMatchObject({ code: 'apify_concurrency_wait' });
  expect(control.starts).toBe(4);
  expect(await env.DB.prepare('SELECT runs,reserved_microusd FROM apify_budget').first()).toEqual({ runs: 4, reserved_microusd: 29200 });
});
