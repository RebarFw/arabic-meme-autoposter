import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveVideoDropper } from './local-downloaders/videodropper.mjs';

const run = promisify(execFile);
let stage = 'configuration';
try {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const token = readFileSync('.secrets/admin-token', 'utf8').trim();
  const base = new URL(config.vars.PUBLIC_BASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error();
  async function admin(path, body) {
    let response;
    try {
      response = await fetch(base.href.replace(/\/$/, '') + '/admin/' + path, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error(); }
    const result = await response.json();
    if (!response.ok) throw new Error();
    return result;
  }
  stage = 'job_status';
  const status = await admin('status');
  const id = process.argv[2] || status.jobs?.[0]?.id;
  const job = status.jobs?.find(j => j.id === id);
  if (!/^[a-f0-9]{64}$/.test(id ?? '') || job?.state !== 'attention' || status.deliveries?.some(d => d.job_id === id)) throw new Error();
  stage = 'source_read';
  // Capture D1 output in memory; never print DM data, signed URLs or CLI errors.
  const { stdout } = await run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'arabic-meme-autoposter-jobs', '--remote', '--json', '--command', `SELECT source_json FROM jobs WHERE id='${id}'`], { windowsHide: true, maxBuffer: 500_000 });
  const source = JSON.parse(JSON.parse(stdout)[0].results[0].source_json);
  const url = new URL(source.reelUrl);
  const match = /^\/reels?\/([A-Za-z0-9_-]{5,80})\/?$/.exec(url.pathname);
  if (source.kind !== 'reel' || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !['instagram.com', 'www.instagram.com'].includes(url.hostname) || !match) throw new Error();
  const reelUrl = `https://www.instagram.com/reel/${match[1]}/`;
  stage = 'local_resolution';
  const videoUrl = await resolveVideoDropper(reelUrl);
  stage = 'protected_recovery';
  const result = await admin('jobs/retry-download', { jobId: id, resolved: { reelUrl, videoUrl } });
  console.log(JSON.stringify({ queued: result.queued === true, jobId: id, resolution: 'local-videodropper', downloadAndPublish: 'worker' }, null, 2));
} catch {
  console.error(JSON.stringify({ error: 'local_recovery_failed', stage }));
  process.exitCode = 1;
}
