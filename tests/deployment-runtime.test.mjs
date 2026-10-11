import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {deploymentEnvironment,runWranglerSafely,assertDeployedVersion,safeBuildEnvironmentReport} from '../scripts/deployment-runtime.mjs';

const base={CLOUDFLARE_API_TOKEN:'TEST_ONLY_TOKEN',WORKERS_CI:'1',WORKERS_CI_BRANCH:'main',WORKERS_CI_COMMIT_SHA:'a'.repeat(40),WRANGLER_CI_OVERRIDE_NAME:'holy-rice-b914'};
test('Wrangler child target and log controls are fixed',()=>{
 const env=deploymentEnvironment(base);
 assert.equal(env.CLOUDFLARE_ACCOUNT_ID,'fe9d7e2a164274b1ff6cef150a75cb0b');
 assert.equal(env.WRANGLER_WRITE_LOGS,'false');
 assert.equal(env.WRANGLER_LOG,'error');
 assert.equal(env.WRANGLER_CI_OVERRIDE_NAME,'holy-rice-b914');
 assert.equal(env.WRANGLER_CI_GENERATE_PREVIEW_ALIAS,'false');
 assert.equal(env.CLOUDFLARE_API_BASE_URL,'https://api.cloudflare.com/client/v4');
 const unsupported={CF_API_BASE_URL:'PRIVATE_URL',CF_ACCOUNT_ID:'PRIVATE_ID',CLOUDFLARE_ENV:'preview',WRANGLER_LOG_PATH:'PRIVATE_PATH',WRANGLER_WRITE_LOGS:'true'};
 assert.throws(()=>deploymentEnvironment({...base,...unsupported}),error=>Object.keys(unsupported).every(name=>error.message.includes(name))&&!error.message.includes('PRIVATE_'));
 for(const [key,value] of Object.entries(unsupported))assert.throws(()=>deploymentEnvironment({...base,[key]:value}),/ENV_OVERRIDES_BLOCKED/);
 const many=Object.fromEntries(Array.from({length:15},(_,i)=>[`WRANGLER_UNKNOWN_${i}`,'PRIVATE_VALUE']));
 assert.throws(()=>deploymentEnvironment({...base,...many}),error=>error.message.includes('MORE_NAMES_OMITTED')&&!error.message.includes('PRIVATE_VALUE')&&error.message.split('WRANGLER_UNKNOWN_').length-1===12);
 assert.throws(()=>deploymentEnvironment({...base,['WRANGLER_BAD\nPRIVATE_VALUE']:'SECRET'}),error=>error.message.includes('INVALID_NAME')&&!error.message.includes('PRIVATE_VALUE')&&!error.message.includes('SECRET'));
 for(const value of ['true','false'])assert.equal(deploymentEnvironment({...base,WRANGLER_CI_GENERATE_PREVIEW_ALIAS:value}).WRANGLER_CI_GENERATE_PREVIEW_ALIAS,'false');
 for(const value of ['', 'TRUE', '1', 'unexpected', null])assert.throws(()=>deploymentEnvironment({...base,WRANGLER_CI_GENERATE_PREVIEW_ALIAS:value}),/PREVIEW_ALIAS_FLAG_INVALID/);
 const officialBuild={...base,CI:'true',WORKERS_CI_BUILD_UUID:'11111111-1111-4111-8111-111111111111',WRANGLER_CI_MATCH_TAG:'REVIEWED_TAG',WRANGLER_CI_GENERATE_PREVIEW_ALIAS:'true',WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST:'true',CLOUDFLARE_API_BASE_URL:'https://api.cloudflare.com/client/v4',WRANGLER_OUTPUT_FILE_DIRECTORY:'/build/system-output',WRANGLER_OUTPUT_FILE_PATH:'/build/untrusted.jsonl'};
 const filtered=deploymentEnvironment(officialBuild,'REVIEWED_TAG');
 assert.equal(filtered.WRANGLER_CI_GENERATE_PREVIEW_ALIAS,'false');
 assert.equal(filtered.WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST,undefined);
 assert.equal(filtered.CLOUDFLARE_API_BASE_URL,'https://api.cloudflare.com/client/v4');
 assert.equal(filtered.WRANGLER_OUTPUT_FILE_DIRECTORY,undefined);
 assert.equal(filtered.WRANGLER_OUTPUT_FILE_PATH,undefined);
 for(const key of ['WRANGLER_OUTPUT_FILE_DIRECTORY','WRANGLER_OUTPUT_FILE_PATH'])for(const value of ['',null,17])assert.throws(()=>deploymentEnvironment({...base,[key]:value}),/OUTPUT_LOCATION_INVALID/);
 for(const value of ['', 'TRUE', '1', null])assert.throws(()=>deploymentEnvironment({...base,WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST:value}),/NETWORK_HOST_FLAG_INVALID/);
 for(const value of ['http://api.cloudflare.com/client/v4','https://api.cloudflare.com/client/v4/','https://user@api.cloudflare.com/client/v4','https://api.cloudflare.com/client/v4?token=SECRET','https://example.test/client/v4',null])assert.throws(()=>deploymentEnvironment({...base,CLOUDFLARE_API_BASE_URL:value}),error=>error.message.includes('API_BASE_NOT_CANONICAL')&&!error.message.includes('SECRET')&&!error.message.includes('example.test'));
 assert.throws(()=>deploymentEnvironment({...base,WRANGLER_CI_OVERRIDE_NAME:'other'}),/WORKER_NAME_MISMATCH/);
 assert.throws(()=>deploymentEnvironment({...base,CLOUDFLARE_ACCOUNT_ID:'other'}),/ACCOUNT_MISMATCH/);
 assert.equal(deploymentEnvironment({...base,WRANGLER_CI_MATCH_TAG:'REVIEWED_TAG'},'REVIEWED_TAG').WRANGLER_CI_MATCH_TAG,'REVIEWED_TAG');
 assert.throws(()=>deploymentEnvironment({...base,WRANGLER_CI_MATCH_TAG:'OTHER'},'REVIEWED_TAG'),/WORKER_TAG_MISMATCH/);
});
test('build environment diagnostic reports only safe classifications',()=>{
 const secret='PRIVATE_SENTINEL';
 const report=safeBuildEnvironmentReport({...base,CLOUDFLARE_API_BASE_URL:`https://api.cloudflare.com/client/v4?token=${secret}`,WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST:secret,WRANGLER_CI_GENERATE_PREVIEW_ALIAS:secret,WRANGLER_OUTPUT_FILE_DIRECTORY:`/private/${secret}`,WRANGLER_UNKNOWN:secret});
 assert.equal(report.apiBaseCanonicalMatch,false);
 assert.equal(report.networkHostMode,'INVALID');
 assert.equal(report.previewAliasMode,'INVALID');
 assert.deepEqual(report.unsupportedNames,['WRANGLER_UNKNOWN']);
 assert.ok(!JSON.stringify(report).includes(secret));
 const accepted=safeBuildEnvironmentReport({...base,CLOUDFLARE_API_BASE_URL:'https://api.cloudflare.com/client/v4',WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST:'true'});
 assert.equal(accepted.apiBaseCanonicalMatch,true);
 assert.equal(accepted.networkHostMode,'TRUE');
});
test('raw Wrangler stdout, stderr and errors cannot reach caller output',()=>{
 const secret='SECRET_RUNTIME_ACCESS_VALUE';
 let options;
 assert.throws(()=>runWranglerSafely('node','fake','/tmp',deploymentEnvironment(base),'a'.repeat(40),(_,args,input)=>{options=input;return {status:1,stdout:secret,stderr:secret};}),error=>!String(error).includes(secret));
 assert.deepEqual(options.stdio,['ignore','pipe','pipe']);
 assert.equal(options.env.WRANGLER_WRITE_LOGS,'false');
 assert.equal(options.env.WRANGLER_OUTPUT_FILE_DIRECTORY,undefined);
 assert.equal(options.env.WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST,undefined);
});
test('Build output overrides never replace the private structured result file',()=>{
 const input={...base,WRANGLER_CI_GENERATE_PREVIEW_ALIAS:'true',WRANGLER_OUTPUT_FILE_DIRECTORY:'/build/system-output',WRANGLER_OUTPUT_FILE_PATH:'/build/untrusted.jsonl'};
 const environment=deploymentEnvironment(input);
 const result=runWranglerSafely('node','fake','/tmp',environment,'a'.repeat(40),(_,args,options)=>{
  assert.equal(options.env.WRANGLER_CI_GENERATE_PREVIEW_ALIAS,'false');
  assert.equal(options.env.WRANGLER_OUTPUT_FILE_DIRECTORY,undefined);
  assert.notEqual(options.env.WRANGLER_OUTPUT_FILE_PATH,input.WRANGLER_OUTPUT_FILE_PATH);
  assert.match(options.env.WRANGLER_OUTPUT_FILE_PATH,/yta-wrangler-output-.*\/result\.jsonl$/);
  writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH,JSON.stringify({type:'deploy',version:1,worker_name:'holy-rice-b914',version_id:'11111111-1111-4111-8111-111111111111'})+'\n');
  return {status:0,stdout:'PRIVATE_ACCESS_VALUE',stderr:'PRIVATE_ACCESS_VALUE'};
 });
 assert.equal(result.versionId,'11111111-1111-4111-8111-111111111111');
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
