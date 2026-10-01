import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloudflareApi } from './cloudflare-api.mjs';
import { deploymentAccount } from './cloudflare-auth.mjs';

const count = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('bootstrap_invalid_meter');
  return value;
};
const rows = value => {
  if (!Array.isArray(value) || value.length >= 1000) throw new Error('bootstrap_incomplete_meter');
  return value;
};
const total = (values, field) => count(rows(values).reduce((sum, row) => sum + count(row.sum?.[field]), 0));

// Manual deployment recovery only. Live GraphQL authorization and every usage
// dataset must succeed. Direct storage reads fill the newly created resources'
// reporting gap only on an otherwise empty, isolated Arabic account. This does
// not extend the Worker's normal 60-second cache or clear a latched stop.
export async function bootstrapCloudflareUsage() {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const accountId = deploymentAccount(), databaseId = config.vars.CLOUDFLARE_DATABASE_ID;
  if (config.vars.CLOUDFLARE_USAGE_GUARD !== 'true' || !/^[a-f0-9-]{36}$/.test(databaseId)) throw new Error('bootstrap_not_configured');
  const started = Date.now(), day = new Date(started).toISOString().slice(0, 10);
  const to = new Date(started).toISOString(), from = new Date(started - 31 * 86400000).toISOString();
  const token = readFileSync('.secrets/cloudflare-usage-token.txt', 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error('bootstrap_invalid_reader');
  const query = `{viewer{accounts(filter:{accountTag:"${accountId}"}){
    workersInvocationsAdaptive(limit:1,filter:{datetime_geq:"${day}T00:00:00Z",datetime_leq:"${to}"}){sum{requests}}
    d1AnalyticsAdaptiveGroups(limit:1,filter:{date_geq:"${day}",date_leq:"${day}"}){sum{rowsRead rowsWritten}}
    d1StorageAdaptiveGroups(limit:1000,filter:{date_geq:"${day}"}){max{databaseSizeBytes} dimensions{databaseId}}
    r2OperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${from}",datetime_leq:"${to}"}){sum{requests} dimensions{date storageClass}}
    r2StorageAdaptiveGroups(limit:1000,filter:{datetime_geq:"${day}T00:00:00Z",datetime_leq:"${to}"}){max{payloadSize metadataSize} dimensions{bucketName storageClass}}
  }}}`;
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  if (!response.ok || Buffer.byteLength(text) > 1000000) throw new Error('bootstrap_analytics_unavailable');
  const data = JSON.parse(text);
  if (data.errors && (!Array.isArray(data.errors) || data.errors.length) || !Array.isArray(data.data?.viewer?.accounts) || data.data.viewer.accounts.length !== 1) throw new Error('bootstrap_analytics_unavailable');
  const meters = data.data.viewer.accounts[0];
  const databaseStorage = rows(meters.d1StorageAdaptiveGroups), mediaStorage = rows(meters.r2StorageAdaptiveGroups);
  const [scripts, databases, buckets, database, objects, jobs] = await Promise.all([
    cloudflareApi(accountId, '/workers/scripts'), cloudflareApi(accountId, '/d1/database'), cloudflareApi(accountId, '/r2/buckets'),
    cloudflareApi(accountId, `/d1/database/${databaseId}`), cloudflareApi(accountId, '/r2/buckets/arabic-meme-autoposter-media/objects?limit=1'),
    cloudflareApi(accountId, `/d1/database/${databaseId}/query`, { method: 'POST', body: JSON.stringify({ sql: 'SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM deliveries) AS deliveries, (SELECT COUNT(*) FROM cloudflare_media_reservations) AS reservations' }) }),
  ]);
  if (scripts.length !== 1 || scripts[0].id !== 'arabic-meme-autoposter' || databases.length !== 1 || databases[0].uuid !== databaseId || database.uuid !== databaseId || database.name !== 'arabic-meme-autoposter-jobs' || buckets.buckets?.length !== 1 || buckets.buckets[0].name !== 'arabic-meme-autoposter-media') throw new Error('bootstrap_requires_isolated_arabic_account');
  if (!Array.isArray(objects) || objects.length !== 0 || jobs[0]?.results?.[0]?.jobs !== 0 || jobs[0]?.results?.[0]?.deliveries !== 0 || jobs[0]?.results?.[0]?.reservations !== 0) throw new Error('bootstrap_requires_no_jobs_or_media');
  if (databaseStorage.some(row => row.dimensions?.databaseId !== databaseId) || mediaStorage.some(row => row.dimensions?.bucketName !== 'arabic-meme-autoposter-media' || row.dimensions?.storageClass !== 'Standard' && count(row.max?.payloadSize) + count(row.max?.metadataSize) > 0)) throw new Error('bootstrap_unexpected_storage');
  const databaseBytes = count(Math.max(count(database.file_size), ...databaseStorage.map(row => count(row.max?.databaseSizeBytes))) + 1000000);
  const r2Bytes = count(Math.max(0, ...mediaStorage.map(row => count(row.max?.payloadSize) + count(row.max?.metadataSize))) + 1000000);
  // Extra headroom conservatively covers provisioning and delayed invocations.
  const workers = count(total(meters.workersInvocationsAdaptive, 'requests') + 1000);
  const reads = count(total(meters.d1AnalyticsAdaptiveGroups, 'rowsRead') + 10000), writes = count(total(meters.d1AnalyticsAdaptiveGroups, 'rowsWritten') + 1000);
  const operations = new Map([[day, 100]]);
  for (const row of rows(meters.r2OperationsAdaptiveGroups)) {
    const date = row.dimensions?.date;
    if (row.dimensions?.storageClass !== 'Standard' && count(row.sum?.requests) > 0 || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from.slice(0, 10) || date > day) throw new Error('bootstrap_invalid_operations');
    operations.set(date, count((operations.get(date) ?? 0) + count(row.sum?.requests)));
  }
  // Count every observed R2 request in both classes, including free deletes.
  if (workers + 10 >= 90000 || reads + 1000 >= 4500000 || writes + 100 >= 90000 || databaseBytes + 1000000 >= 450000000 || r2Bytes + 26214400 >= 9000000000 || [...operations.values()].reduce((a,b)=>a+b,0) + 20 >= 900000) throw new Error('bootstrap_capacity_not_safe');
  if (Date.now() - started > 30000 || new Date().toISOString().slice(0, 10) !== day) throw new Error('bootstrap_measurement_expired');
  const snapshot = { checkedAt: started, day, workers, rowsRead: reads, rowsWritten: writes, d1Bytes: databaseBytes, databaseBytes, r2Bytes, storageBasis: 'operator_verified_empty_account' };
  const statements = [
    `INSERT INTO cloudflare_usage_daily(day,workers,rows_read,rows_written) VALUES('${day}',${workers},${reads},${writes}) ON CONFLICT(day) DO UPDATE SET workers=MAX(workers,excluded.workers),rows_read=MAX(rows_read,excluded.rows_read),rows_written=MAX(rows_written,excluded.rows_written)`,
    ...[...operations].map(([date,n]) => `INSERT INTO cloudflare_r2_daily(day,base_a,base_b,reported_a,reported_b,own_a,own_b) VALUES('${date}',${n},${n},${n},${n},10,10) ON CONFLICT(day) DO UPDATE SET reported_a=MAX(reported_a,excluded.reported_a),reported_b=MAX(reported_b,excluded.reported_b),own_a=own_a+10,own_b=own_b+10`),
    `UPDATE cloudflare_usage_state SET snapshot_json='${JSON.stringify(snapshot)}',refreshed_at=${started},last_error_code=NULL WHERE id=1 AND lease_until<=${started}`,
  ];
  const applied = await cloudflareApi(accountId, `/d1/database/${databaseId}/query`, { method: 'POST', body: JSON.stringify({ sql: statements.join(';') }) });
  if (applied.at(-1)?.meta?.changes !== 1) throw new Error('bootstrap_reader_busy');
  mkdirSync('.local', { recursive: true });
  writeFileSync('.local/cloudflare-bootstrap.json', JSON.stringify({ accountId, databaseId, measuredAt: to, expiresAt: new Date(started + 60000).toISOString(), verifiedEmptyMedia: true, conservativeDatabaseBytes: databaseBytes }, null, 2));
  return { measured: true, storageBasis: snapshot.storageBasis, expiresAt: new Date(started + 60000).toISOString(), guardDisabled: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await bootstrapCloudflareUsage(), null, 2)); }
  catch { console.error('Verified startup measurement failed; the guard remains closed. Provider output was suppressed.'); process.exitCode = 1; }
}
