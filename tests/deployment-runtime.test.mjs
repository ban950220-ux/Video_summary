import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {deploymentEnvironment,runWranglerSafely,assertDeployedVersion} from '../scripts/deployment-runtime.mjs';

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
 assert.equal(deploymentEnvironment({...base,WRANGLER_CI_MATCH_TAG:'REVIEWED_TAG'},'REVIEWED_TAG').WRANGLER_CI_MATCH_TAG,'REVIEWED_TAG');
 assert.throws(()=>deploymentEnvironment({...base,WRANGLER_CI_MATCH_TAG:'OTHER'},'REVIEWED_TAG'),/WORKER_TAG_MISMATCH/);
});
test('raw Wrangler stdout, stderr and errors cannot reach caller output',()=>{
 const secret='SECRET_RUNTIME_ACCESS_VALUE';
 let options;
 assert.throws(()=>runWranglerSafely('node','fake','/tmp',deploymentEnvironment(base),'a'.repeat(40),(_,args,input)=>{options=input;return {status:1,stdout:secret,stderr:secret};}),error=>!String(error).includes(secret));
 assert.deepEqual(options.stdio,['ignore','pipe','pipe']);
 assert.equal(options.env.WRANGLER_WRITE_LOGS,'false');
});
test('structured Wrangler version and commit annotation must match the live deployment',()=>{
 const commit='a'.repeat(40),versionId='11111111-1111-4111-8111-111111111111',otherId='22222222-2222-4222-8222-222222222222';
 const result=runWranglerSafely('node','fake','/tmp',deploymentEnvironment(base),commit,(_,args,options)=>{
  assert.deepEqual(args.slice(-2),['--message',`source-commit:${commit}`]);
  writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH,JSON.stringify({type:'deploy',version:1,worker_name:'holy-rice-b914',version_id:versionId})+'\n');
  return {status:0,stdout:'PRIVATE_ACCESS_VALUE',stderr:'PRIVATE_ACCESS_VALUE'};
 });
 assert.deepEqual(result,{versionId,sourceCommit:commit});
 assert.equal(assertDeployedVersion({activeVersions:[{id:versionId,percentage:100}],deploymentMessage:`source-commit:${commit}`},result),true);
 assert.throws(()=>assertDeployedVersion({activeVersions:[{id:otherId,percentage:100}],deploymentMessage:`source-commit:${commit}`},result),/POST_DEPLOY_VERSION_UNVERIFIED/);
 assert.throws(()=>assertDeployedVersion({activeVersions:[{id:versionId,percentage:100}],deploymentMessage:'source-commit:'+('b'.repeat(40))},result),/POST_DEPLOY_VERSION_UNVERIFIED/);
 assert.throws(()=>runWranglerSafely('node','fake','/tmp',deploymentEnvironment(base),commit,()=>({status:0,stdout:'success',stderr:''})),/DEPLOY_RESULT_UNVERIFIED/);
});
