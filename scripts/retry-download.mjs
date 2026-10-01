import { readFileSync } from 'node:fs';

try {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const token = readFileSync('.secrets/admin-token', 'utf8').trim();
  async function request(path, body) {
    const response = await fetch(config.vars.PUBLIC_BASE_URL + '/admin/' + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'download_retry_failed');
    return result;
  }
  const jobId = process.argv[2] || (await request('status')).jobs?.[0]?.id;
  if (!/^[a-f0-9]{64}$/.test(jobId ?? '')) throw new Error('No recent job; supply its job hash.');
  console.log(JSON.stringify(await request('jobs/retry-download', { jobId }), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
