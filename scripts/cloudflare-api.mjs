import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Use the operator's existing Wrangler login; never persist or display its token.
export async function cloudflareApi(accountId, suffix, init = {}) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error('invalid_cloudflare_account');
  const source = readFileSync(join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml'), 'utf8');
  const token = source.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  if (!token) throw new Error('cloudflare_browser_login_required');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${suffix}`, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`cloudflare_api_http_${response.status}`);
  return result.result;
}
