import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export async function verifyDeployment(url, attempts = 24) {
  const token = readFileSync('.secrets/meta-verify-token','utf8');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
      if (!health.ok || !(await health.json()).ok) throw new Error('health_not_ready');
      const verify = new URL(`${url}/webhooks/instagram`);
      verify.searchParams.set('hub.mode','subscribe');
      verify.searchParams.set('hub.challenge','deployment-check');
      verify.searchParams.set('hub.verify_token',token);
      const handshake = await fetch(verify, { signal: AbortSignal.timeout(10_000) });
      if (!handshake.ok || await handshake.text() !== 'deployment-check') throw new Error('verification_not_ready');
      const unauthorized = await fetch(`${url}/admin/status`, { signal: AbortSignal.timeout(10_000) });
      if (unauthorized.status !== 401) throw new Error('admin_authentication_check_failed');
      console.log(`Verified health, Meta GET handshake and admin protection: ${url}`);
      return;
    } catch {
      if (attempt === attempts) throw new Error('Deployment is saved; public TLS/DNS or verification is not ready. Retry npm run verify:deployment.');
      if (attempt === 1 || attempt % 6 === 0) console.log(`Waiting for new Worker DNS/TLS and verification (${attempt}/${attempts})...`);
      await setTimeout(5000);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  try { await verifyDeployment(config.vars.PUBLIC_BASE_URL); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
