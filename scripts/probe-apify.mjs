import { readFileSync } from 'node:fs';

try {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const token = readFileSync('.secrets/admin-token', 'utf8').trim();
  const response = await fetch(config.vars.PUBLIC_BASE_URL + '/admin/download/probe-apify', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000), headers: { Authorization: `Bearer ${token}` },
  });
  const result = await response.json();
  if (!response.ok) throw new Error();
  console.log(JSON.stringify(result, null, 2));
  if (!result.resolved || !result.fullDownloadVerified) process.exitCode = 1;
} catch { console.error('apify_probe_failed'); process.exitCode = 1; }
