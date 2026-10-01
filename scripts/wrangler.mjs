import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function wrangler(args, options = {}) {
  const config = JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  if (config.name !== 'arabic-meme-autoposter' || config.r2_buckets?.[0]?.bucket_name !== 'arabic-meme-autoposter-media' || config.d1_databases?.[0]?.database_name !== 'arabic-meme-autoposter-jobs') throw new Error('Arabic project isolation check failed');
  if (args.some(arg => /^meme-autoposter(?:-|$)/.test(arg))) throw new Error('English resource mutation blocked');
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: options.capture || options.input ? ['pipe','pipe','pipe'] : 'inherit',
    ...(options.input ? { input: options.input } : {}),
  });
  if (result.status !== 0) {
    // Never print secret-bearing stdin. Wrangler output is suppressed for secret puts.
    if (options.capture && !options.input) console.error(result.stderr || result.stdout);
    throw new Error(`Wrangler ${args.slice(0,2).join(' ')} failed`);
  }
  return result.stdout ?? '';
}
