import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CF_STOP, cleanupCloudflareReservations, cloudflareCapacity, refreshCloudflareUsage, reserveCloudflareMedia, withCloudflareR2Guard } from '../src/cloudflare-usage';
import { enqueue, processJob, saveSetting } from '../src/jobs';
import worker from '../src/index';
import type { Env } from '../src/types';
import { probeCloudflareGuard } from '../src/cloudflare-probe';
import { storeVideo } from '../src/media';

const bindings: Env = { ...env, CLOUDFLARE_USAGE_GUARD: 'true', CLOUDFLARE_USAGE_TOKEN: 'fake-cloudflare-read-only-token' };
const video = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
const key = 'arabic-meme-autoposter/' + 'a'.repeat(64) + '.mp4';
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM cloudflare_usage_daily'), env.DB.prepare('DELETE FROM cloudflare_r2_daily'), env.DB.prepare('DELETE FROM cloudflare_media_reservations'), env.DB.prepare('UPDATE cloudflare_usage_state SET snapshot_json=NULL,refreshed_at=0,lease_until=0,last_error_code=NULL')]);
});
afterEach(() => vi.restoreAllMocks());

function mockUsage({ workers = 1000, writes = 1000, reads = 10000, a = 100, b = 1000, bytes = 0, nonfree = false } = {}) {
  const day = new Date().toISOString().slice(0,10);
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake-cloudflare-read-only-token');
    const query = JSON.parse(String(init?.body)).query;
    expect(query).not.toContain('objectName');
    expect(query).not.toContain('scriptName:');
    return Response.json({ data: { viewer: { accounts: [{
      workersInvocationsAdaptive: [{ sum: { requests: workers } }],
      d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: reads, rowsWritten: writes } }],
      d1StorageAdaptiveGroups: [{ dimensions: { databaseId: bindings.CLOUDFLARE_DATABASE_ID }, max: { databaseSizeBytes: 65536 } }],
      r2OperationsAdaptiveGroups: [{ dimensions: { date: day, actionType: 'PutObject', storageClass: 'Standard' }, sum: { requests: a } }, { dimensions: { date: day, actionType: 'HeadObject', storageClass: 'Standard' }, sum: { requests: b } }, { dimensions: { date: day, actionType: 'DeleteObject', storageClass: 'Standard' }, sum: { requests: 2_000_000 } }],
      r2StorageAdaptiveGroups: [{ dimensions: { bucketName: 'arabic-meme-autoposter-media', storageClass: 'Standard' }, max: { payloadSize: bytes, metadataSize: 0 } }, { dimensions: { bucketName: 'other-bucket', storageClass: 'InfrequentAccess' }, max: { payloadSize: nonfree ? 1 : 0, metadataSize: 0 } }],
    }] } }, errors: null });
  });
}

it('reads account-wide usage, caches it, excludes free deletes and reports a 90 percent target', async () => {
  const fetcher = mockUsage();
  const status = await cloudflareCapacity(bindings);
  expect(status).toMatchObject({ enabled: true, allowed: true, targetPercent: 90, usage: { workers: 1000, rowsRead: 10000, rowsWritten: 1000, r2A: 100, r2B: 1000 } });
  await cloudflareCapacity(bindings);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(status)).not.toContain('fake-cloudflare');
  expect(JSON.stringify(status)).not.toContain('other-bucket');
});

it('latches a daily stop, retains the high watermark, and resumes on the next verified UTC day', async () => {
  mockUsage({ workers: CF_STOP.workers });
  expect(await cloudflareCapacity(bindings)).toMatchObject({ allowed: false, code: 'cloudflare_workers_daily_pause' });
  vi.restoreAllMocks(); mockUsage({ workers: 1 });
  await refreshCloudflareUsage(bindings, true);
  expect((await cloudflareCapacity(bindings)).allowed).toBe(false);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0,10);
  await env.DB.prepare('UPDATE cloudflare_usage_daily SET day=?').bind(yesterday).run();
  await refreshCloudflareUsage(bindings, true);
  expect((await cloudflareCapacity(bindings)).allowed).toBe(true);
});

it('pauses for each daily D1 meter with room for operations already in progress', async () => {
  for (const options of [{ writes: CF_STOP.rowsWritten - 50 }, { reads: CF_STOP.rowsRead - 500 }]) {
    mockUsage(options);
    expect((await cloudflareCapacity(bindings)).allowed).toBe(false);
    await env.DB.prepare('DELETE FROM cloudflare_usage_daily').run();
    vi.restoreAllMocks();
    await env.DB.prepare('UPDATE cloudflare_usage_state SET refreshed_at=0').run();
  }
});

it('fails closed on partial GraphQL responses, outages, absent credentials and nonfree storage', async () => {
  await expect(cloudflareCapacity({ ...bindings, CLOUDFLARE_USAGE_TOKEN: undefined })).rejects.toThrow('cloudflare_usage_not_configured');
  const fetcher = mockUsage({ nonfree: true });
  await expect(cloudflareCapacity(bindings)).rejects.toThrow('cloudflare_nonfree_storage');
  fetcher.mockResolvedValue(Response.json({ data: { viewer: { accounts: [{}] } }, errors: [{ message: 'private provider message' }] }));
  await expect(cloudflareCapacity(bindings)).rejects.toThrow('cloudflare_usage_api_error');
  fetcher.mockRejectedValue(new Error('network outage'));
  await expect(cloudflareCapacity(bindings)).rejects.toThrow('cloudflare_usage_unavailable');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM cloudflare_r2_daily').first('n')).toBe(0);
});

it('atomically reserves R2 operations before issuing them, including failed calls', async () => {
  mockUsage({ b: CF_STOP.r2B - 2 });
  const guarded = withCloudflareR2Guard(bindings);
  await refreshCloudflareUsage(bindings);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => guarded.MEDIA.head(key)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  for (const result of results) if (result.status === 'rejected') expect(result.reason.code).toBe('cloudflare_r2_class_b_pause');
  expect(await env.DB.prepare('SELECT own_b FROM cloudflare_r2_daily').first('own_b')).toBe(1);
  expect(await env.DB.prepare('SELECT own_a FROM cloudflare_r2_daily').first('own_a')).toBe(0);
});

it('cancels the upload producer if an R2 quota reservation rejects before consuming the stream', async () => {
  mockUsage({ a: CF_STOP.r2A });
  const guarded = withCloudflareR2Guard(bindings);
  await expect(storeVideo(guarded, new Response(video, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '24' } }), key, Date.now() + 60_000)).rejects.toThrow('cloudflare_r2_class_a_pause');
  expect(await env.MEDIA.head(key)).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM cloudflare_media_reservations').first('n')).toBe(0);
});

it('avoids counting local operations twice when later analytics catches up and never refunds unknown failures', async () => {
  mockUsage({ b: 0 });
  await withCloudflareR2Guard(bindings).MEDIA.head(key);
  vi.restoreAllMocks(); mockUsage({ b: 1 });
  await refreshCloudflareUsage(bindings, true);
  expect((await cloudflareCapacity(bindings)).usage?.r2B).toBe(1);
  await withCloudflareR2Guard(bindings).MEDIA.head(key);
  expect((await cloudflareCapacity(bindings)).usage?.r2B).toBe(2);
});

it('reserves storage concurrently, forces Standard, and permits cleanup after a quota stop', async () => {
  mockUsage({ bytes: CF_STOP.r2Bytes - 30 });
  const guarded = withCloudflareR2Guard(bindings);
  const results = await Promise.allSettled([reserveCloudflareMedia(guarded, key, video.length, Date.now() - 1), reserveCloudflareMedia(guarded, key + '2', video.length, Date.now() - 1)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const reservation = await env.DB.prepare('SELECT object_key FROM cloudflare_media_reservations').first<string>('object_key');
  expect(reservation).toBeTruthy();
  await guarded.MEDIA.put(reservation!, video, { storageClass: 'Standard' });
  expect((await cloudflareCapacity(guarded)).allowed).toBe(false);
  await cleanupCloudflareReservations(guarded);
  expect(await env.MEDIA.head(reservation!)).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM cloudflare_media_reservations').first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT own_a FROM cloudflare_r2_daily').first('own_a')).toBe(1);
  await expect(guarded.MEDIA.put('unreserved', video)).rejects.toThrow('cloudflare_media_not_reserved');
});

it('does not ingest or alter publishing jobs during a pause, keeps health working, and protects the usage endpoint', async () => {
  const fetcher = mockUsage({ writes: CF_STOP.rowsWritten });
  await expect(enqueue(bindings, { messageId: 'quota-new-message', senderId: '111', recipientId: '222', timestamp: Date.now(), kind: 'reel' })).rejects.toThrow('cloudflare_d1_writes_daily_pause');
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source_json LIKE '%quota-new-message%'").first('n')).toBe(0);
  const ctx = createExecutionContext();
  worker.scheduled({} as ScheduledController, bindings, ctx);
  await waitOnExecutionContext(ctx);
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const route of ['usage', 'validate', 'probe']) {
    const response = await worker.fetch(new Request('https://worker.example/admin/cloudflare/' + route, { method: route === 'probe' ? 'POST' : 'GET' }), bindings, ctx);
    expect(response.status).toBe(401);
  }
  const health = await worker.fetch(new Request('https://worker.example/health'), bindings, ctx);
  expect(health.status).toBe(200);
});

it('preserves a download job and its retry allowance when quota is exhausted during the transfer', async () => {
  const fetcher = mockUsage();
  const usageFetch = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (input, init) => {
    if (String(input) === 'https://lookaside.fbsbx.com/quota-test.mp4') {
      // Another invocation exhausted the operation budget after this job's
      // starting check but before its upload could reserve an R2 operation.
      await env.DB.prepare('UPDATE cloudflare_r2_daily SET own_a=?').bind(CF_STOP.r2A).run();
      return new Response(video, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '24' } });
    }
    return usageFetch(input, init);
  });
  await saveSetting(env, 'channels', [{ id: 'ig', service: 'instagram' }, { id: 'tt', service: 'tiktok' }]);
  const guarded = withCloudflareR2Guard({ ...bindings, BUFFER_API_KEY: 'fake-buffer' });
  const id = await enqueue(guarded, { messageId: 'quota-during-transfer', senderId: '111', recipientId: '222', timestamp: Date.now(), attachmentUrl: 'https://lookaside.fbsbx.com/quota-test.mp4', kind: 'reel' });
  await processJob(guarded, id);
  expect(await env.DB.prepare('SELECT state,attempts,error_code,lease_until FROM jobs WHERE id=?').bind(id).first()).toEqual({ state: 'pending', attempts: 0, error_code: 'cloudflare_r2_class_a_pause', lease_until: 0 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE job_id=?').bind(id).first('n')).toBe(0);
  expect(await env.MEDIA.head(`arabic-meme-autoposter/${id}.mp4`)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('streams the real guarded R2 binding, verifies reads and physically deletes a diagnostic object without posts', async () => {
  const fetcher = mockUsage();
  expect(await probeCloudflareGuard(withCloudflareR2Guard(bindings))).toEqual({ guardedUploadVerified: true, guardedReadVerified: true, bytes: 24, physicalDeletionVerified: true, postsCreated: 0 });
  expect(await env.DB.prepare('SELECT own_a,own_b FROM cloudflare_r2_daily').first()).toEqual({ own_a: 1, own_b: 3 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM cloudflare_media_reservations').first('n')).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
