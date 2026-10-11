import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deploymentEnvironment,runWranglerSafely} from '../scripts/deployment-runtime.mjs';

const base={CLOUDFLARE_API_TOKEN:'TEST_ONLY_TOKEN',WORKERS_CI:'1',WORKERS_CI_BRANCH:'main',WORKERS_CI_COMMIT_SHA:'a'.repeat(40),WRANGLER_CI_OVERRIDE_NAME:'holy-rice-b914'};
test('Wrangler child target and log controls are fixed',()=>{
 const env=deploymentEnvironment(base);
 assert.equal(env.CLOUDFLARE_ACCOUNT_ID,'fe9d7e2a164274b1ff6cef150a75cb0b');
 assert.equal(env.WRANGLER_WRITE_LOGS,'false');
 assert.equal(env.WRANGLER_LOG,'error');
 assert.equal(env.WRANGLER_CI_OVERRIDE_NAME,'holy-rice-b914');
 assert.equal(env.CLOUDFLARE_API_BASE_URL,undefined);
 for(const [key,value] of Object.entries({CLOUDFLARE_API_BASE_URL:'https://example.test',CF_API_BASE_URL:'https://example.test',CF_ACCOUNT_ID:'other',CLOUDFLARE_ENV:'preview',WRANGLER_LOG_PATH:'/tmp/leak',WRANGLER_WRITE_LOGS:'true',WRANGLER_CI_GENERATE_PREVIEW_ALIAS:'true'})){
  assert.throws(()=>deploymentEnvironment({...base,[key]:value}),/ENV_OVERRIDE_BLOCKED/);
 }
 assert.throws(()=>deploymentEnvironment({...base,WRANGLER_CI_OVERRIDE_NAME:'other'}),/WORKER_NAME_MISMATCH/);
});
test('raw Wrangler stdout, stderr and errors cannot reach caller output',()=>{
 const secret='SECRET_RUNTIME_ACCESS_VALUE';
 let options;
 assert.throws(()=>runWranglerSafely('node','fake','/tmp',deploymentEnvironment(base),(_,args,input)=>{options=input;return {status:1,stdout:secret,stderr:secret};}),error=>!String(error).includes(secret));
 assert.deepEqual(options.stdio,['ignore','pipe','pipe']);
 assert.equal(options.env.WRANGLER_WRITE_LOGS,'false');
});
