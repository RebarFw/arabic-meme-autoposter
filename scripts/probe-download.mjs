import { readFileSync } from 'node:fs';

try {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const token = readFileSync('.secrets/admin-token', 'utf8').trim();
  const known = ['videodropper', 'fastdl', 'savefrom', 'snapinsta'];
  const selected = process.argv[2] ? [process.argv[2]] : known;
  if (selected.some(name => !known.includes(name))) throw new Error('Unknown downloader provider.');
  for (const provider of selected) {
    const response = await fetch(config.vars.PUBLIC_BASE_URL + '/admin/download/probe', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(35_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'download_probe_failed');
    // The Worker returns fixed facts/codes only, never URLs or credentials.
    console.log(JSON.stringify(result));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
