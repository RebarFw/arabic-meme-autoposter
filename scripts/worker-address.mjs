import { cloudflareApi, CloudflareApiError } from './cloudflare-api.mjs';

export async function workerAddress(accountId) {
  let result;
  try { result = await cloudflareApi(accountId, '/workers/subdomain'); }
  catch (error) {
    if (!(error instanceof CloudflareApiError) || !error.codes.includes(10007)) throw error;
    // Register only on a new account. Never rename an existing subdomain.
    const subdomain = 'maikl-arabic-memes';
    try { await cloudflareApi(accountId, `/workers/subdomains/${subdomain}`); }
    catch (availabilityError) {
      if (!(availabilityError instanceof CloudflareApiError) || !availabilityError.codes.includes(10032)) throw availabilityError;
    }
    result = await cloudflareApi(accountId, '/workers/subdomain', { method: 'PUT', body: JSON.stringify({ subdomain }) });
  }
  if (!/^[a-z0-9-]+$/.test(result?.subdomain ?? '')) throw new Error('workers_subdomain_unverified');
  return `https://arabic-meme-autoposter.${result.subdomain}.workers.dev`;
}
