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
  for (const name of ['wrangler.mjs', 'cloudflare-auth.mjs', 'cloudflare-api.mjs', 'worker-address.mjs', 'bootstrap-cloudflare-usage.mjs']) copyFileSync(new URL('../scripts/' + name, import.meta.url), join(directory, 'scripts', name));
  writeFileSync(join(directory, '.secrets/cloudflare-usage-token.txt'), analyticsToken);
  if (separateToken) writeFileSync(join(directory, '.secrets/cloudflare-deploy-token.txt'), deploymentToken);
  writeFileSync(join(directory, 'wrangler.jsonc'), JSON.stringify({ name: 'arabic-meme-autoposter', account_id: configAccount, vars: { CLOUDFLARE_ACCOUNT_ID: configAccount, CLOUDFLARE_DATABASE_ID: '2e47dbbf-e082-4579-9d34-c101c98ebb5b', CLOUDFLARE_USAGE_GUARD: 'true' }, r2_buckets: [{ bucket_name: 'arabic-meme-autoposter-media' }], d1_databases: [{ database_name: 'arabic-meme-autoposter-jobs' }] }));
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

function address(directory, responses) {
  const code = `import { workerAddress } from './scripts/worker-address.mjs';
    const responses = ${JSON.stringify(responses)}, calls = [];
    globalThis.fetch = async (input, init) => {
      if (init.headers.Authorization !== 'Bearer ${deploymentToken}') throw new Error('wrong_project_credential');
      calls.push({ path: new URL(input).pathname, method: init.method ?? 'GET', body: init.body });
      const response = responses.shift();
      if (!response) throw new Error('unexpected_network_request');
      return Response.json(response.body, { status: response.status });
    };
    try { console.log(JSON.stringify({ url: await workerAddress('${accountId}'), calls })); }
    catch (error) { console.log(JSON.stringify({ error: error.message, calls })); process.exitCode = 1; }`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: directory, encoding: 'utf8' });
}
test('preserves an existing workers.dev subdomain without a mutation', t => {
  const result = address(fixture(t), [{ status: 200, body: { success: true, result: { subdomain: 'existing-subdomain' } } }]);
  assert.equal(result.status, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.url, 'https://arabic-meme-autoposter.existing-subdomain.workers.dev');
  assert.deepEqual(body.calls, [{ path: `/client/v4/accounts/${accountId}/workers/subdomain`, method: 'GET' }]);
});
test('registers a new subdomain only after explicit missing and available responses', t => {
  const result = address(fixture(t), [
    { status: 404, body: { success: false, errors: [{ code: 10007 }] } },
    { status: 404, body: { success: false, errors: [{ code: 10032 }] } },
    { status: 200, body: { success: true, result: { subdomain: 'maikl-arabic-memes' } } },
  ]);
  assert.equal(result.status, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.url, 'https://arabic-meme-autoposter.maikl-arabic-memes.workers.dev');
  assert.equal(body.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(body.calls[2].body, JSON.stringify({ subdomain: 'maikl-arabic-memes' }));
});
test('does not register on an authorization error or expose a provider error containing credentials', t => {
  const result = address(fixture(t), [{ status: 403, body: { success: false, errors: [{ code: 10000, message: deploymentToken }] } }]);
  assert.notEqual(result.status, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.error, 'cloudflare_api_http_403');
  assert.equal(body.calls.length, 1);
  assert.ok(!result.stdout.includes(deploymentToken));
});

function bootstrap(directory, options = {}) {
  const code = `import { bootstrapCloudflareUsage } from './scripts/bootstrap-cloudflare-usage.mjs';
    const options=${JSON.stringify(options)}; let writes=0;
    const databaseId='2e47dbbf-e082-4579-9d34-c101c98ebb5b';
    globalThis.fetch=async(input,init)=>{
      const url=new URL(input), body=init.body?JSON.parse(init.body):{};
      if(url.pathname==='/client/v4/graphql'){
        if(init.headers.Authorization!=='Bearer ${analyticsToken}')throw new Error('wrong_reader');
        const meters={workersInvocationsAdaptive:options.unsafe?[{sum:{requests:90000}}]:[],d1AnalyticsAdaptiveGroups:[],d1StorageAdaptiveGroups:[],r2OperationsAdaptiveGroups:[],r2StorageAdaptiveGroups:[]};
        if(options.emptyClass||options.paidStorage)meters.r2StorageAdaptiveGroups=[{dimensions:{bucketName:'arabic-meme-autoposter-media',storageClass:'InfrequentAccess'},max:{payloadSize:options.paidStorage?1:0,metadataSize:0}}];
        if(options.partial)delete meters.r2OperationsAdaptiveGroups;
        return Response.json({data:{viewer:{accounts:[meters]}},errors:options.denied?[{message:'${analyticsToken}'}]:null});
      }
      if(init.headers.Authorization!=='Bearer ${deploymentToken}')throw new Error('wrong_deployment_credential');
      let result;
      if(url.pathname.endsWith('/workers/scripts'))result=options.otherResource?[{id:'arabic-meme-autoposter'},{id:'other-project'}]:[{id:'arabic-meme-autoposter'}];
      else if(url.pathname.endsWith('/d1/database'))result=[{uuid:databaseId}];
      else if(url.pathname.endsWith('/r2/buckets'))result={buckets:[{name:'arabic-meme-autoposter-media'}]};
      else if(url.pathname.endsWith('/objects'))result=options.media?[{key:'existing-media'}]:[];
      else if(url.pathname.endsWith('/query')){
        if(body.sql.startsWith('SELECT'))result=[{results:[{jobs:options.jobs?1:0,deliveries:0,reservations:0}]}];
        else{
          if(body.sql.includes('blocked=')||body.sql.includes('stop_code=')||body.sql.includes('lease_until=0'))throw new Error('latched_stop_changed');
          writes++; result=[{meta:{changes:1}}];
        }
      }else result={uuid:databaseId,name:'arabic-meme-autoposter-jobs',file_size:118784};
      return Response.json({success:true,result});
    };
    try{console.log(JSON.stringify({result:await bootstrapCloudflareUsage(),writes}));}
    catch{console.log(JSON.stringify({failed:true,writes}));process.exitCode=1;}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: directory, encoding: 'utf8' });
}
test('a verified empty-account startup measurement keeps the guard on and expires within its normal cache window', t => {
  const started=Date.now(), result=bootstrap(fixture(t),{emptyClass:true});
  assert.equal(result.status,0);
  const body=JSON.parse(result.stdout);
  assert.equal(body.writes,1);
  assert.equal(body.result.guardDisabled,false);
  assert.equal(body.result.storageBasis,'operator_verified_empty_account');
  assert.ok(Date.parse(body.result.expiresAt)<=started+61000);
  assert.ok(!result.stdout.includes(deploymentToken));
  assert.ok(!result.stdout.includes(analyticsToken));
});
test('startup measurement rejects other resources, existing jobs and nonempty media before writing a snapshot', t => {
  for(const options of [{otherResource:true},{jobs:true},{media:true}]){
    const result=bootstrap(fixture(t),options);
    assert.notEqual(result.status,0);
    assert.equal(JSON.parse(result.stdout).writes,0);
  }
});
test('startup measurement rejects analytics denial, partial datasets and unsafe usage without exposing credentials', t => {
  for(const options of [{denied:true},{partial:true},{unsafe:true},{paidStorage:true}]){
    const result=bootstrap(fixture(t),options);
    assert.notEqual(result.status,0);
    assert.equal(JSON.parse(result.stdout).writes,0);
    assert.ok(!result.stdout.includes(analyticsToken));
  }
});
