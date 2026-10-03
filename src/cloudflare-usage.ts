import { limitedBytes } from './security';
import { AppError, errorCode, type Env } from './types';

export const CF_STOP = { workers: 90_000, rowsRead: 4_500_000, rowsWritten: 90_000, d1Bytes: 4_500_000_000, databaseBytes: 450_000_000, r2A: 900_000, r2B: 9_000_000, r2Bytes: 9_000_000_000 };
const DAY = 86400_000;
const CACHE_MS = 60_000;
interface State { snapshot_json: string | null; refreshed_at: number; lease_until: number; last_error_code: string | null; }
interface Snapshot { checkedAt: number; day: string; workers: number; rowsRead: number; rowsWritten: number; d1Bytes: number; databaseBytes: number; r2Bytes: number; storageBasis?: 'operator_verified_empty_account'; }
interface Daily { day: string; workers: number; rows_read: number; rows_written: number; blocked: number; stop_code: string | null; }
type Row = { sum?: Record<string, unknown>; max?: Record<string, unknown>; dimensions?: Record<string, unknown> };
const classA = new Set(['ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload', 'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration']);
const classB = new Set(['HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors', 'GetBucketLifecycleConfiguration']);
const free = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);
const date = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);
const enabled = (env: Env) => env.CLOUDFLARE_USAGE_GUARD === 'true';
const guardedBuckets = new WeakSet<R2Bucket>();

export class CloudflareUsageError extends AppError {
  constructor(public readonly facts: { permissionDenied: boolean; queryLimit: boolean; schemaRejected: boolean; fields: string[]; codes: (string | number)[]; accountCount: number | null; errorWords: string[] }) { super('cloudflare_usage_api_error'); }
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AppError('cloudflare_usage_invalid');
  return value;
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value) || value.length >= 1000 || value.some(r => !r || typeof r !== 'object')) throw new AppError('cloudflare_usage_incomplete');
  return value;
}
function total(values: number[]) { const n = values.reduce((a, b) => a + b, 0); return count(n); }
async function apiSnapshot(env: Env): Promise<{ snapshot: Snapshot; operations: Map<string, { a: number; b: number }> }> {
  const token = env.CLOUDFLARE_USAGE_TOKEN?.trim();
  if (!token || !/^[A-Za-z0-9_-]{20,256}$/.test(token) || !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) throw new AppError('cloudflare_usage_not_configured');
  const now = Date.now(), today = date(now), from = new Date(now - 31 * DAY).toISOString(), to = new Date(now).toISOString();
  // These fields were introspected and tested against this account's real API.
  // No script/database/bucket filter: shared account usage must count.
  const query = `query MemeAutoposterFreeUsage { viewer { accounts(filter:{accountTag:"${env.CLOUDFLARE_ACCOUNT_ID}"}) {
    workersInvocationsAdaptive(limit:1,filter:{datetime_geq:"${today}T00:00:00Z",datetime_leq:"${to}"}) {sum {requests}}
    d1AnalyticsAdaptiveGroups(limit:1,filter:{date_geq:"${today}",date_leq:"${today}"}) {sum {rowsRead rowsWritten}}
    d1StorageAdaptiveGroups(limit:1000,filter:{date_geq:"${today}"}) {max {databaseSizeBytes} dimensions {databaseId}}
    r2OperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${from}",datetime_leq:"${to}"}) {sum {requests} dimensions {date actionType storageClass}}
    r2StorageAdaptiveGroups(limit:1000,filter:{datetime_geq:"${today}T00:00:00Z",datetime_leq:"${to}"}) {max {payloadSize metadataSize} dimensions {bucketName storageClass}}
  } } }`;
  let response: Response;
  try { response = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) }); }
  catch { throw new AppError('cloudflare_usage_unavailable', true); }
  if (!response.ok) { await response.body?.cancel(); throw new AppError(`cloudflare_usage_http_${response.status}`, true); }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(await limitedBytes(response.body, 1_000_000))); } catch { throw new AppError('cloudflare_usage_invalid'); }
  // GraphQL can return HTTP 200 with errors/partial results. Never treat that as zero.
  if ((data.errors && (!Array.isArray(data.errors) || data.errors.length)) || !Array.isArray(data.data?.viewer?.accounts) || data.data.viewer.accounts.length !== 1) {
    const errors: { message?: unknown; code?: unknown; extensions?: { code?: unknown } }[] = Array.isArray(data.errors) ? data.errors : [];
    const messages = errors.map(e => typeof e.message === 'string' ? e.message : '').join(' ');
    const fields = ['workersInvocationsAdaptive', 'd1AnalyticsAdaptiveGroups', 'd1StorageAdaptiveGroups', 'r2OperationsAdaptiveGroups', 'r2StorageAdaptiveGroups'].filter(name => messages.includes(name));
    const codes = errors.map(e => e.extensions?.code ?? e.code).filter((c): c is string | number => typeof c === 'number' && Number.isSafeInteger(c) || typeof c === 'string' && /^(?:[A-Z_]{1,64}|\d{1,6})$/.test(c));
    const accountCount = Array.isArray(data.data?.viewer?.accounts) ? data.data.viewer.accounts.length : null;
    const errorWords = (messages.toLowerCase().match(/[a-z]+/g) ?? []).filter(word => ['authentication','authorization','unauthorized','account','token','error','failed','invalid','expired','permission','denied','access','forbidden','allowed','supported','limit','duration','range','exceeded','query','parsing','disabled','enabled','zone','cannot','not','missing','api','key','user','scope'].includes(word));
    // Fixed classifications and known field names only; provider text may
    // include private inputs. Never return/log raw error messages.
    throw new CloudflareUsageError({ permissionDenied: accountCount === 0 || /permission|authenticat|authoriz|access denied|not allowed to access|does not have access/i.test(messages), queryLimit: /limit|maximum|time range|duration|too (?:large|old)|retention/i.test(messages), schemaRejected: /unknown|cannot query|error parsing|invalid/i.test(messages), fields, codes, accountCount, errorWords: [...new Set(errorWords)] });
  }
  const account = data.data.viewer.accounts[0];
  const workers = total(rows(account.workersInvocationsAdaptive).map(r => count(r.sum?.requests)));
  const reads = total(rows(account.d1AnalyticsAdaptiveGroups).map(r => count(r.sum?.rowsRead)));
  const writes = total(rows(account.d1AnalyticsAdaptiveGroups).map(r => count(r.sum?.rowsWritten)));
  const databases = rows(account.d1StorageAdaptiveGroups);
  if (!databases.some(r => r.dimensions?.databaseId === env.CLOUDFLARE_DATABASE_ID)) throw new AppError('cloudflare_database_usage_missing');
  const d1Bytes = total(databases.map(r => count(r.max?.databaseSizeBytes)));
  const databaseBytes = count(databases.find(r => r.dimensions?.databaseId === env.CLOUDFLARE_DATABASE_ID)?.max?.databaseSizeBytes);
  const storage = rows(account.r2StorageAdaptiveGroups);
  if (!storage.some(r => r.dimensions?.bucketName === 'arabic-meme-autoposter-media' && r.dimensions?.storageClass === 'Standard')) throw new AppError('cloudflare_bucket_usage_missing');
  for (const r of storage) if (r.dimensions?.storageClass !== 'Standard' && count(r.max?.payloadSize) > 0) throw new AppError('cloudflare_nonfree_storage');
  const r2Bytes = total(storage.map(r => count(r.max?.payloadSize) + count(r.max?.metadataSize)));
  const operations = new Map<string, { a: number; b: number }>();
  operations.set(today, { a: 0, b: 0 });
  for (const r of rows(account.r2OperationsAdaptiveGroups)) {
    const n = count(r.sum?.requests), operation = r.dimensions?.actionType, day = r.dimensions?.date;
    if (typeof operation !== 'string' || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < date(now - 31 * DAY) || day > today) throw new AppError('cloudflare_usage_invalid');
    if (r.dimensions?.storageClass !== 'Standard' && n > 0) throw new AppError('cloudflare_nonfree_storage');
    const entry = operations.get(day) ?? { a: 0, b: 0 };
    if (!free.has(operation)) {
      // Unknown/new operation names conservatively count against both classes.
      if (classA.has(operation) || !classB.has(operation)) entry.a += n;
      if (classB.has(operation) || !classA.has(operation)) entry.b += n;
    }
    count(entry.a); count(entry.b); operations.set(day, entry);
  }
  return { snapshot: { checkedAt: now, day: today, workers, rowsRead: reads, rowsWritten: writes, d1Bytes, databaseBytes, r2Bytes }, operations };
}

export async function refreshCloudflareUsage(env: Env, force = false): Promise<Snapshot | undefined> {
  if (!enabled(env)) return;
  const now = Date.now();
  const state = await env.DB.prepare('SELECT * FROM cloudflare_usage_state WHERE id=1').first<State>();
  if (!state) throw new AppError('cloudflare_usage_schema_missing');
  if (!force && state.snapshot_json && now - state.refreshed_at < CACHE_MS && JSON.parse(state.snapshot_json).day === date(now)) {
    if (state.last_error_code) throw new AppError('cloudflare_usage_stale');
    return JSON.parse(state.snapshot_json) as Snapshot;
  }
  const lease = await env.DB.prepare('UPDATE cloudflare_usage_state SET lease_until=? WHERE id=1 AND lease_until<=? RETURNING id').bind(now + 30_000, now).first();
  if (!lease) throw new AppError('cloudflare_usage_refresh_busy', true);
  try {
    const { snapshot, operations } = await apiSnapshot(env);
    const statements = [...operations].map(([day, n]) => env.DB.prepare(`INSERT INTO cloudflare_r2_daily(day,base_a,base_b,reported_a,reported_b) VALUES(?,?,?,?,?)
      ON CONFLICT(day) DO UPDATE SET reported_a=MAX(reported_a,excluded.reported_a),reported_b=MAX(reported_b,excluded.reported_b)
      WHERE excluded.reported_a>reported_a OR excluded.reported_b>reported_b`).bind(day, n.a, n.b, n.a, n.b));
    statements.push(env.DB.prepare(`INSERT INTO cloudflare_usage_daily(day,workers,rows_read,rows_written) VALUES(?,?,?,?)
      ON CONFLICT(day) DO UPDATE SET workers=MAX(workers,excluded.workers),rows_read=MAX(rows_read,excluded.rows_read),rows_written=MAX(rows_written,excluded.rows_written)
      WHERE excluded.workers>workers OR excluded.rows_read>rows_read OR excluded.rows_written>rows_written`).bind(snapshot.day, snapshot.workers, snapshot.rowsRead, snapshot.rowsWritten));
    statements.push(env.DB.prepare('UPDATE cloudflare_usage_state SET snapshot_json=?,refreshed_at=?,lease_until=0,last_error_code=NULL WHERE id=1').bind(JSON.stringify(snapshot), now));
    await env.DB.batch(statements);
    return snapshot;
  } catch (error) {
    await env.DB.prepare('UPDATE cloudflare_usage_state SET lease_until=0,last_error_code=? WHERE id=1').bind(errorCode(error)).run();
    throw error;
  }
}

async function snapshot(env: Env): Promise<Snapshot> {
  const data = await refreshCloudflareUsage(env);
  if (!data || Date.now() - data.checkedAt > CACHE_MS || data.day !== date()) throw new AppError('cloudflare_usage_stale');
  return data;
}

export async function cloudflareCapacity(env: Env) {
  if (!enabled(env)) return { enabled: false, allowed: true, code: null as string | null };
  const data = await snapshot(env);
  // Read all current counters in one database snapshot rather than three
  // separate round trips. Reservations and sticky stops remain authoritative.
  const daily = await env.DB.prepare(`SELECT daily.*,r2.a,r2.b,media.bytes AS reserved_bytes FROM cloudflare_usage_daily AS daily
    CROSS JOIN (SELECT COALESCE(SUM(MAX(base_a+own_a,reported_a)),0) AS a,COALESCE(SUM(MAX(base_b+own_b,reported_b)),0) AS b FROM cloudflare_r2_daily WHERE day>=?) AS r2
    CROSS JOIN (SELECT COALESCE(SUM(bytes),0) AS bytes FROM cloudflare_media_reservations) AS media WHERE daily.day=?`)
    .bind(date(Date.now() - 31 * DAY), data.day).first<Daily & { a: number; b: number; reserved_bytes: number }>();
  if (!daily) throw new AppError('cloudflare_usage_schema_missing');
  const r2 = { a: daily.a, b: daily.b }, reservedBytes = daily.reserved_bytes;
  // Room for work already in flight; these are projections, not a claim of an
  // exact billing meter. R2 calls additionally require atomic reservations.
  let code = daily.blocked ? daily.stop_code : daily.workers + 10 >= CF_STOP.workers ? 'cloudflare_workers_daily_pause' :
    daily.rows_read + 1000 >= CF_STOP.rowsRead ? 'cloudflare_d1_reads_daily_pause' : daily.rows_written + 100 >= CF_STOP.rowsWritten ? 'cloudflare_d1_writes_daily_pause' :
    data.d1Bytes + 1_000_000 >= CF_STOP.d1Bytes || data.databaseBytes + 1_000_000 >= CF_STOP.databaseBytes ? 'cloudflare_d1_storage_pause' :
    r2.a + 10 >= CF_STOP.r2A ? 'cloudflare_r2_class_a_pause' : r2.b + 20 >= CF_STOP.r2B ? 'cloudflare_r2_class_b_pause' :
    data.r2Bytes + reservedBytes + Math.min(Number(env.MAX_VIDEO_BYTES) || 26_214_400, 100_000_000) >= CF_STOP.r2Bytes ? 'cloudflare_r2_storage_pause' : null;
  if (code?.includes('_daily_pause') && !daily.blocked) {
    await env.DB.prepare('UPDATE cloudflare_usage_daily SET blocked=1,stop_code=? WHERE day=?').bind(code, data.day).run();
  }
  if (daily.blocked) code = daily.stop_code;
  return { enabled: true, allowed: !code, code, targetPercent: 90, measuredAt: new Date(data.checkedAt).toISOString(), meter: 'analytics_estimate_with_local_r2_reservations', limits: CF_STOP,
    storageBasis: data.storageBasis === 'operator_verified_empty_account' ? data.storageBasis : 'account_analytics',
    usage: { workers: daily.workers, rowsRead: daily.rows_read, rowsWritten: daily.rows_written, d1Bytes: data.d1Bytes, databaseBytes: data.databaseBytes, r2A: r2.a, r2B: r2.b, r2PeakBytes: data.r2Bytes, reservedMediaBytes: reservedBytes }, dailyResetAt: new Date(Date.parse(data.day) + DAY).toISOString(), r2WindowDays: 31 };
}

export async function requireCloudflareCapacity(env: Env) {
  const capacity = await cloudflareCapacity(env);
  if (!capacity.allowed) throw new AppError(capacity.code ?? 'cloudflare_usage_paused', true);
}

async function reserveR2(env: Env, kind: 'a' | 'b'): Promise<void> {
  if (!enabled(env)) return;
  await snapshot(env);
  const column = kind === 'a' ? 'own_a' : 'own_b', limit = kind === 'a' ? CF_STOP.r2A : CF_STOP.r2B;
  const updated = await env.DB.prepare(`UPDATE cloudflare_r2_daily SET ${column}=${column}+1 WHERE day=?
    AND (SELECT COALESCE(SUM(MAX(base_${kind}+own_${kind},reported_${kind})),0) FROM cloudflare_r2_daily WHERE day>=?)+1<? RETURNING day`)
    .bind(date(), date(Date.now() - 31 * DAY), limit).first();
  if (!updated) throw new AppError(`cloudflare_r2_class_${kind}_pause`, true);
}

export async function reserveCloudflareMedia(env: Env, key: string, bytes: number, expiresAt: number): Promise<void> {
  if (!enabled(env)) return;
  const data = await snapshot(env);
  const existing = await env.DB.prepare('SELECT bytes FROM cloudflare_media_reservations WHERE object_key=?').bind(key).first<{ bytes: number }>();
  if (existing) { if (existing.bytes !== bytes) throw new AppError('cloudflare_media_reservation_conflict'); return; }
  const result = await env.DB.prepare(`INSERT INTO cloudflare_media_reservations(object_key,bytes,expires_at) SELECT ?,?,?
    WHERE (SELECT COALESCE(SUM(bytes),0) FROM cloudflare_media_reservations)+?+?<? RETURNING object_key`)
    .bind(key, count(bytes), expiresAt, data.r2Bytes, bytes, CF_STOP.r2Bytes).first();
  if (!result) throw new AppError('cloudflare_r2_storage_pause', true);
}

export function withCloudflareR2Guard(env: Env): Env {
  if (!enabled(env) || guardedBuckets.has(env.MEDIA)) return env;
  const original = env.MEDIA;
  const guarded = new Proxy(original, { get(target, property) {
    if (property === 'get' || property === 'head' || property === 'list' || property === 'put') return async (...args: unknown[]) => {
      if (property === 'put') {
        const reservation = await env.DB.prepare('SELECT bytes FROM cloudflare_media_reservations WHERE object_key=?').bind(String(args[0])).first();
        if (!reservation) throw new AppError('cloudflare_media_not_reserved');
        const options = args[2] as R2PutOptions | undefined;
        if (options?.storageClass && options.storageClass !== 'Standard') throw new AppError('cloudflare_nonfree_storage');
        args[2] = { ...options, storageClass: 'Standard' };
      }
      await reserveR2(env, property === 'list' || property === 'put' ? 'a' : 'b');
      return Reflect.apply(Reflect.get(target, property), target, args);
    };
    if (property === 'delete') return async (keys: string | string[]) => {
      // DeleteObject is free and remains available even during a quota pause.
      await original.delete(keys);
      for (const key of typeof keys === 'string' ? [keys] : keys) await env.DB.prepare('DELETE FROM cloudflare_media_reservations WHERE object_key=?').bind(key).run();
    };
    if (property === 'createMultipartUpload' || property === 'resumeMultipartUpload') return () => { throw new AppError('cloudflare_multipart_not_supported'); };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  guardedBuckets.add(guarded);
  return { ...env, MEDIA: guarded };
}

export async function cleanupCloudflareReservations(env: Env): Promise<void> {
  if (!enabled(env)) return;
  const expired = (await env.DB.prepare('SELECT object_key FROM cloudflare_media_reservations WHERE expires_at<=? LIMIT 20').bind(Date.now()).all<{ object_key: string }>()).results;
  // Known keys can be deleted without a charged ListObjects operation. A
  // failed deletion keeps its reservation; lifecycle remains a fallback.
  for (const item of expired) await env.MEDIA.delete(item.object_key);
}
