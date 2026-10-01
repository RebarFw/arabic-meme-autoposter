import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { wrangler } from './wrangler.mjs';

try {
  mkdirSync('.secrets', { recursive: true });
  const files = { BUFFER_API_KEY: 'buffer-api-key.txt', DOWNLOADER_API_KEY: 'apify-token.txt', CLOUDFLARE_USAGE_TOKEN: 'cloudflare-usage-token.txt', META_ACCESS_TOKEN: 'meta-access-token.txt', META_APP_SECRET: 'meta-app-secret.txt', ADMIN_TOKEN: 'admin-token', META_VERIFY_TOKEN: 'meta-verify-token' };
  for (const name of ['ADMIN_TOKEN', 'META_VERIFY_TOKEN']) {
    if (!existsSync('.secrets/' + files[name])) writeFileSync('.secrets/' + files[name], randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  const values = {}, missing = [];
  for (const [name, file] of Object.entries(files)) {
    const value = existsSync('.secrets/' + file) ? readFileSync('.secrets/' + file, 'utf8').trim() : '';
    if (!value) { missing.push(name); continue; }
    if ([...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) throw new Error('invalid_local_secret_format_' + name);
    values[name] = value;
  }
  // A single stdin upload prevents secret text in shell arguments and logs.
  wrangler(['secret', 'bulk'], { input: JSON.stringify(values), capture: true });
  console.log(JSON.stringify({ installed: Object.keys(values), missing }, null, 2));
} catch { console.error('Secret installation failed; credentials and provider output were suppressed.'); process.exitCode = 1; }
