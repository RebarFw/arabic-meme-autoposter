import { deploymentAccount, deploymentToken } from './cloudflare-auth.mjs';

// Use only this project's local token and explicitly confirmed account.
export async function cloudflareApi(accountId, suffix, init = {}) {
  if (accountId !== deploymentAccount()) throw new Error('cloudflare_account_mismatch');
  const token = deploymentToken();
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${suffix}`, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`cloudflare_api_http_${response.status}`);
  return result.result;
}
