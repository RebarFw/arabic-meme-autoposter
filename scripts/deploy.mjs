import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { wrangler } from './wrangler.mjs';
import { cloudflareApi } from './cloudflare-api.mjs';
import { verifyDeployment } from './verify-deployment.mjs';

try {
  const auth = JSON.parse(wrangler(['whoami', '--json'], { capture: true }));
  if (!auth.loggedIn || auth.accounts?.length !== 1) throw new Error('one_authenticated_cloudflare_account_required');
  const accountId = auth.accounts[0].id;
  const config = JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  if (config.account_id && config.account_id !== accountId) throw new Error('cloudflare_account_changed');
  config.account_id = accountId;
  config.vars.CLOUDFLARE_ACCOUNT_ID = accountId;
  writeFileSync('wrangler.jsonc', JSON.stringify(config,null,2) + '\n');
  // Creation uses the existing enabled R2 product and Standard storage only.
  // No account subscription/upgrade or public-domain enablement is performed.
  const bucketName = 'arabic-meme-autoposter-media';
  const buckets = await cloudflareApi(accountId, '/r2/buckets');
  if (!buckets.buckets.some(b => b.name === bucketName)) wrangler(['r2','bucket','create',bucketName]);
  const publicAccess = await cloudflareApi(accountId, `/r2/buckets/${bucketName}/domains/managed`);
  if (publicAccess.enabled) throw new Error('arabic_r2_bucket_must_be_private');
  const customDomains = await cloudflareApi(accountId, `/r2/buckets/${bucketName}/domains/custom`);
  if (customDomains.domains?.some(d => d.enabled)) throw new Error('arabic_r2_bucket_has_public_domain');
  const lifecycle = wrangler(['r2','bucket','lifecycle','list',bucketName], { capture: true });
  if (!lifecycle.includes('arabic-meme-autoposter-expiry-2d')) wrangler(['r2','bucket','lifecycle','add',bucketName,'arabic-meme-autoposter-expiry-2d','arabic-meme-autoposter/','--expire-days','2','--force']);
  const databases = JSON.parse(wrangler(['d1','list','--json'], { capture: true }));
  let db = databases.find(d => d.name === 'arabic-meme-autoposter-jobs');
  if (!db) {
    wrangler(['d1','create','arabic-meme-autoposter-jobs']);
    db = JSON.parse(wrangler(['d1','list','--json'], { capture: true })).find(d => d.name === 'arabic-meme-autoposter-jobs');
  }
  if (!db?.uuid) throw new Error('arabic_database_not_found');
  if (config.d1_databases[0].database_id !== '00000000-0000-0000-0000-000000000000' && config.d1_databases[0].database_id !== db.uuid) throw new Error('arabic_database_identity_changed');
  config.d1_databases[0].database_id = db.uuid;
  config.vars.CLOUDFLARE_DATABASE_ID = db.uuid;
  const info = await cloudflareApi(accountId, `/d1/database/${db.uuid}`);
  if (info.name !== 'arabic-meme-autoposter-jobs') throw new Error('arabic_database_identity_mismatch');
  const subdomain = (await cloudflareApi(accountId, '/workers/subdomain')).subdomain;
  if (!/^[a-z0-9-]+$/.test(subdomain)) throw new Error('workers_subdomain_unverified');
  config.vars.PUBLIC_BASE_URL = `https://arabic-meme-autoposter.${subdomain}.workers.dev`;
  writeFileSync('wrangler.jsonc', JSON.stringify(config,null,2) + '\n');
  wrangler(['d1','migrations','apply','arabic-meme-autoposter-jobs','--remote']);
  wrangler(['deploy']);
  // Installation reports names only and skips missing/empty input files.
  await import('./install-secrets.mjs');
  if (process.exitCode) throw new Error('secure_secret_installation_failed');
  mkdirSync('.local',{recursive:true});
  const url=config.vars.PUBLIC_BASE_URL;
  writeFileSync('.local/deployment.json',JSON.stringify({url,webhook:`${url}/webhooks/instagram`,privateR2Verified:true,noSubscriptionChanges:true},null,2));
  await verifyDeployment(url);
  console.log(`Verified private Arabic R2, health, Meta GET verification and admin protection.\nMeta callback: ${url}/webhooks/instagram`);
} catch (error) { console.error(error.message); process.exitCode=1; }
