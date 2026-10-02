import { readFileSync } from 'node:fs';

try {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const admin = readFileSync('.secrets/admin-token', 'utf8').trim();
  const [jobId, service] = process.argv.slice(2);
  if (!/^[a-f0-9]{64}$/.test(jobId ?? '') || !['instagram', 'tiktok'].includes(service)) throw new Error('Supply JOB_HASH and instagram or tiktok.');
  const response = await fetch(config.vars.PUBLIC_BASE_URL + '/admin/jobs/retry-rejected-delivery', {
    method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, service }), redirect: 'error', signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'delivery_retry_failed');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
