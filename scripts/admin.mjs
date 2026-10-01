import { readFileSync } from 'node:fs';

try {
  const config = JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  const command = process.argv[2];
  const commands = { setup: { path: 'setup', method: 'POST' }, status: { path: 'status', method: 'GET' }, 'meta:diagnose': { path: 'meta/diagnose', method: 'GET' }, 'meta:subscribe': { path: 'meta/subscribe', method: 'POST' }, poll: { path: 'poll', method: 'POST' }, 'polling:validate': { path: 'poll/validate', method: 'GET' }, 'download:diagnose': { path: 'download/diagnose', method: 'GET' }, 'cloudflare:probe': { path: 'cloudflare/probe', method: 'POST' }, 'cloudflare:validate': { path: 'cloudflare/validate', method: 'GET' }, 'cloudflare:usage': { path: 'cloudflare/usage', method: 'GET' }, 'apify:budget': { path: 'apify/budget', method: 'GET' }, 'apify:enforce-limit': { path: 'apify/enforce-limit', method: 'POST' } };
  const operation = commands[command];
  if (!operation) throw new Error('Use ' + Object.keys(commands).join(', ') + '.');
  if (command === 'download:diagnose' && ['post','embed'].includes(process.argv[3])) operation.path += '?route=' + process.argv[3];
  const token = readFileSync('.secrets/admin-token','utf8').trim();
  const response = await fetch(`${config.vars.PUBLIC_BASE_URL}/admin/${operation.path}`, { method: operation.method, headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  const result = await response.json();
  if (!response.ok) {
    if (command === 'cloudflare:validate' && result.facts) console.error(JSON.stringify(result.facts, null, 2));
    throw new Error(result.error || 'Admin request failed.');
  }
  console.log(JSON.stringify(result,null,2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
