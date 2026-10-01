import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { wrangler } from './wrangler.mjs';

try {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const slot = process.argv[3] === 'friend' ? 'friend' : 'owner';
  const secretName = slot === 'friend' ? 'FRIEND_IG_SENDER_ID' : 'OWNER_IG_SENDER_ID';
  const admin = readFileSync('.secrets/admin-token', 'utf8').trim();
  async function request(action, method, body) {
    const response = await fetch(`${config.vars.PUBLIC_BASE_URL}/admin/owner/${action}?slot=${slot}`, { method, redirect: 'error', signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${admin}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'owner_setup_failed');
    return result;
  }
  const command = process.argv[2];
  if (command === 'import') {
    const saved = existsSync(`.local/sender-challenge-${slot}.json`) ? JSON.parse(readFileSync(`.local/sender-challenge-${slot}.json`, 'utf8')) : {};
    const username = process.argv[4]?.replace(/^@/, '') ?? (slot === 'owner' ? 'rebarfw' : undefined);
    const challenge = process.argv[5] ?? saved.message ?? '';
    if (username !== undefined && !/^[A-Za-z0-9._]{1,30}$/.test(username) || !/^meme-setup:[a-f0-9]{64}$/.test(challenge)) throw new Error('Issue owner:start for this slot first, or supply PERSONAL_USERNAME SETUP_DM_CODE.');
    console.log(JSON.stringify(await request('import', 'POST', { ...(username ? { username } : {}), challengeHash: createHash('sha256').update(challenge).digest('hex') }), null, 2));
  } else if (command === 'start') {
    const result = await request('start', 'POST');
    mkdirSync('.local', { recursive: true });
    writeFileSync(`.local/sender-challenge-${slot}.json`, JSON.stringify({ message: result.message, expiresAt: result.expiresAt }));
    console.log(JSON.stringify({ sendFrom: slot === 'owner' ? '@rebarfw' : 'Michel karkoush, from his own Instagram account', sendTo: '@' + result.username, message: result.message, expiresAt: new Date(result.expiresAt).toISOString() }, null, 2));
  } else if (command === 'diagnose') {
    console.log(JSON.stringify(await request('diagnose', 'GET'), null, 2));
  } else if (command === 'status') {
    const result = await request('status', 'GET');
    // The actual sender ID is returned only to the authenticated installer.
    console.log(JSON.stringify({ matched: result.matched, expired: result.expired, matchedAt: result.matchedAt, expiresAt: result.expiresAt }, null, 2));
  } else if (command === 'finish') {
    const result = await request('status', 'GET');
    if (!result.matched || result.expired || !/^\d{1,40}$/.test(result.senderId)) throw new Error('owner_dm_not_verified');
    wrangler(['secret', 'put', secretName], { input: result.senderId, capture: true });
    // A secret update creates a new deployment; allow its environment to propagate.
    for (let attempt = 0; ; attempt++) {
      try { await request('finish', 'POST'); break; }
      catch (error) { if (attempt >= 3) throw error; await delay(1500); }
    }
    console.log('Verified sender installed as ' + secretName + '; temporary proof removed.');
  } else throw new Error('Use npm run owner:start, owner:status, owner:diagnose, owner:import or owner:finish.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
