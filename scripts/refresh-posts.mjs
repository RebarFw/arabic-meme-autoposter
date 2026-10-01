import { readFileSync } from 'node:fs';

try {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const token = readFileSync('.secrets/admin-token', 'utf8').trim();
  const jobId = process.argv[2];
  if (!/^[a-f0-9]{64}$/.test(jobId ?? '')) throw new Error('Supply the existing job hash.');
  const response = await fetch(config.vars.PUBLIC_BASE_URL + '/admin/jobs/refresh-posts', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'post_refresh_failed');
  console.log(JSON.stringify({ checked: result.checked === true, jobId }, null, 2));
} catch { console.error('post_refresh_failed'); process.exitCode = 1; }
