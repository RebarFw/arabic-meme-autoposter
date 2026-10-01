import { wrangler } from './wrangler.mjs';

const expected = ['ADMIN_TOKEN', 'BUFFER_API_KEY', 'META_VERIFY_TOKEN', 'META_APP_SECRET', 'META_ACCESS_TOKEN', 'OWNER_IG_SENDER_ID', 'FRIEND_IG_SENDER_ID', 'DOWNLOADER_API_KEY', 'CLOUDFLARE_USAGE_TOKEN'];
try {
  // Never display unrecognized names: an accidental paste can put a credential
  // into the name itself. Suppress raw Wrangler output even when listing fails.
  const entries = JSON.parse(wrangler(['secret', 'list'], { capture: true, input: '\n' }));
  const names = entries.map(entry => entry.name);
  console.log(JSON.stringify({
    configured: Object.fromEntries(expected.map(name => [name, names.includes(name)])),
    unexpectedCount: names.filter(name => !expected.includes(name)).length,
    possiblyMisnamed: expected.filter(name => names.some(candidate => candidate !== name && candidate.startsWith(name))),
  }, null, 2));
} catch { console.error('Secret configuration check failed. No raw names or credentials were displayed.'); process.exitCode = 1; }
