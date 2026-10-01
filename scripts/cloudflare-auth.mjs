import { existsSync, readFileSync } from 'node:fs';

// This project belongs to maiklkarkoch51@gmail.com. Never select an account
// from the operator's global Wrangler login: that login belongs to English.
export function deploymentAccount() {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const accountId = config.account_id;
  if (accountId !== '7d7578de8373f18cc730837758c40395' || config.vars.CLOUDFLARE_ACCOUNT_ID !== accountId) throw new Error('arabic_cloudflare_account_correction_required');
  return accountId;
}

export function deploymentToken() {
  // A distinct deployment token may be used when the analytics reader is
  // intentionally read-only. Both remain ignored local credential files.
  const file = existsSync('.secrets/cloudflare-deploy-token.txt') ? '.secrets/cloudflare-deploy-token.txt' : '.secrets/cloudflare-usage-token.txt';
  const token = readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error('invalid_local_cloudflare_deployment_token');
  return token;
}
