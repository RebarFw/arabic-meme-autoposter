import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const accountId = '7d7578de8373f18cc730837758c40395';
const deploymentToken = 'fake_deployment_token_for_tests_only';
const analyticsToken = 'fake_analytics_token_for_tests_only';
function fixture(t, configAccount = accountId, separateToken = true) {
  const prefix = join(tmpdir(), 'arabic-deploy-auth-');
  const directory = mkdtempSync(prefix);
  t.after(() => {
    assert.ok(directory.startsWith(prefix));
    rmSync(directory, { recursive: true, force: true });
  });
  for (const path of ['scripts', '.secrets', 'node_modules/wrangler/bin']) mkdirSync(join(directory, path), { recursive: true });
  for (const name of ['wrangler.mjs', 'cloudflare-auth.mjs']) copyFileSync(new URL('../scripts/' + name, import.meta.url), join(directory, 'scripts', name));
  writeFileSync(join(directory, '.secrets/cloudflare-usage-token.txt'), analyticsToken);
  if (separateToken) writeFileSync(join(directory, '.secrets/cloudflare-deploy-token.txt'), deploymentToken);
  writeFileSync(join(directory, 'wrangler.jsonc'), JSON.stringify({ name: 'arabic-meme-autoposter', account_id: configAccount, vars: { CLOUDFLARE_ACCOUNT_ID: configAccount }, r2_buckets: [{ bucket_name: 'arabic-meme-autoposter-media' }], d1_databases: [{ database_name: 'arabic-meme-autoposter-jobs' }] }));
  writeFileSync(join(directory, 'node_modules/wrangler/bin/wrangler.js'), `const fs = require('node:fs'); fs.writeFileSync('invoked', 'yes'); console.log(JSON.stringify({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, tokenMatches: process.env.CLOUDFLARE_API_TOKEN === '${separateToken ? deploymentToken : analyticsToken}' }));`);
  return directory;
}
function run(directory, args = ['deploy']) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import { wrangler } from './scripts/wrangler.mjs'; try { console.log(wrangler(${JSON.stringify(args)}, { capture: true })); } catch (error) { console.error(error.message); process.exitCode = 1; }`], { cwd: directory, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: 'wrong_global_login_token', CLOUDFLARE_ACCOUNT_ID: 'wrong_global_account' } });
}

test('deployment sends the explicit Arabic account and local deployment token to Wrangler instead of global credentials', t => {
  const result = run(fixture(t));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { accountId, tokenMatches: true });
  assert.ok(!result.stdout.includes(deploymentToken));
  assert.ok(!result.stdout.includes(analyticsToken));
});

test('a project token remains required when no separate deployment token is present', t => {
  const directory = fixture(t, accountId, false);
  const result = run(directory);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { accountId, tokenMatches: true });
  rmSync(join(directory, '.secrets/cloudflare-usage-token.txt'));
  assert.notEqual(run(directory).status, 0);
});

test('rejects a different account and English resource commands before starting Wrangler', t => {
  const wrongAccount = fixture(t, '97d19512e831722d5d48aa2d05086716');
  assert.notEqual(run(wrongAccount).status, 0);
  assert.equal(existsSync(join(wrongAccount, 'invoked')), false);
  const correctAccount = fixture(t);
  assert.notEqual(run(correctAccount, ['d1', 'delete', 'meme-autoposter-jobs']).status, 0);
  assert.equal(existsSync(join(correctAccount, 'invoked')), false);
});
