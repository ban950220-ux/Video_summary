import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readRemoteState} from '../scripts/read-remote-state.mjs';
import {verifyPostDeploy} from '../scripts/post-deploy-verification.mjs';
import {approvedRemoteBaseline as baseline} from '../scripts/remote-state-policy.mjs';

const deployed={versionId:'11111111-1111-4111-8111-111111111111',sourceCommit:'a'.repeat(40)};
const remote=()=>({
 workerName:'holy-rice-b914',environment:'production',workerTag:'EXPECTED_TAG',
 activeVersions:[{id:deployed.versionId,percentage:100}],deploymentMessage:`source-commit:${deployed.sourceCommit}`,
 workersDev:true,previewUrls:false,routes:[],domains:[],compatibilityDate:baseline.compatibilityDate,compatibilityFlagsPresent:false,
 observability:structuredClone(baseline.observability),optionalScriptFields:structuredClone(baseline.optionalScriptFields),scriptSettings:structuredClone(baseline.scriptSettings),
 bindings:[
  {name:'DB',type:'d1',id:baseline.databaseId},{name:'ACCESS_AUD',type:'plain_text',text:'TEST_AUDIENCE_1234'},
  {name:'ACCESS_TEAM_DOMAIN',type:'plain_text',text:'https://test.cloudflareaccess.com'},
  {name:'ACCESS_OWNER_EMAIL',type:'secret_text'},{name:'KEY_ENCRYPTION_KEY_B64',type:'secret_text'},
  {name:'ENABLE_LIVE_FREE',type:'plain_text',text:'true'},{name:'ALLOW_PAID_API',type:'plain_text',text:'false'},
  {name:'SITE_DEPLOYED',type:'plain_text',text:'true'},
  {name:'ENABLE_PAID_SUMMARY',type:'plain_text',text:'true'},{name:'PAID_SUMMARY_EXECUTION_APPROVED',type:'plain_text',text:'true'},
  {name:'PAID_FIRST_GENERATION_TRIAL_ENABLED',type:'plain_text',text:'true'},{name:'PAID_FIRST_TRIAL_USD_COST_REVIEWED',type:'plain_text',text:'true'},
  {name:'ASSETS',type:'assets'},
 ],
});
const transport=()=>Object.assign(Error('PRIVATE_TRANSPORT_DETAIL'),{retryableReadTransport:true});
const verify=(read,wait=async()=>{})=>verifyPostDeploy({token:'TEST_ONLY_TOKEN',ciMatchTag:'EXPECTED_TAG',deployed,read,wait});

test('post-deploy transport errors retry bounded GET reads without another upload',async()=>{
 let reads=0;const delays=[];
 const receipt=await verify(async()=>{reads++;if(reads===1||reads===3)throw transport();return remote();},async ms=>delays.push(ms));
 assert.equal(reads,4);assert.deepEqual(delays,[500,500]);
 assert.deepEqual(JSON.parse(receipt),{activeVersionId:deployed.versionId,sourceCommit:deployed.sourceCommit});
 assert.ok(!receipt.includes('TEST_ONLY_TOKEN'));
});

test('exhausted post-deploy transport remains deployed but unverified with no secret leak',async()=>{
 let reads=0;const delays=[];
 await assert.rejects(verify(async()=>{reads++;throw transport();},async ms=>delays.push(ms)),error=>{
  assert.match(error.message,/DEPLOYED_UNVERIFIED: POST_DEPLOY_TRANSPORT_EXHAUSTED/);
  assert.ok(!error.message.includes('PRIVATE_TRANSPORT_DETAIL'));return true;
 });
 assert.equal(reads,3);assert.deepEqual(delays,[500,1000]);
});

test('second required postcheck also exhausts safely after one successful read',async()=>{
 let reads=0;
 await assert.rejects(verify(async()=>{reads++;if(reads===1)return remote();throw transport();}),/DEPLOYED_UNVERIFIED: POST_DEPLOY_TRANSPORT_EXHAUSTED/);
 assert.equal(reads,4);
});

test('HTTP, invalid response, version drift and guard drift never retry',async()=>{
 for(const [name,read,code] of [
  ['http',async()=>{throw Error('PRIVATE_HTTP_STATUS_403');},'POST_DEPLOY_READ_FAILED'],
  ['version',async()=>({...remote(),activeVersions:[{id:'other',percentage:100}]}),'POST_DEPLOY_VERSION_MISMATCH'],
  ['guard',async()=>({...remote(),observability:{...baseline.observability,enabled:false}}),'POST_DEPLOY_BASELINE_MISMATCH'],
  ['tag',async()=>({...remote(),workerTag:'other'}),'POST_DEPLOY_WORKER_TAG_MISMATCH'],
 ]){
  let reads=0,waits=0;
  await assert.rejects(verify(async()=>{reads++;return read();},async()=>{waits++;}),error=>error.message.includes(code)&&!error.message.includes('PRIVATE_'),name);
  assert.equal(reads,1,name);assert.equal(waits,0,name);
 }
});

test('only fetch transport exceptions receive the retry marker',async()=>{
 await assert.rejects(readRemoteState({token:'TEST_ONLY_TOKEN',fetcher:async()=>{throw Error('PRIVATE_NETWORK_DETAIL');}}),error=>error.retryableReadTransport===true&&error.message==='Remote deployment guard: REMOTE_READ_FAILED'&&!error.message.includes('PRIVATE_'));
 await assert.rejects(readRemoteState({token:'TEST_ONLY_TOKEN',fetcher:async()=>({ok:false,status:403})}),error=>error.retryableReadTransport!==true&&error.message==='Remote deployment guard: REMOTE_READ_FAILED');
 await assert.rejects(readRemoteState({token:'TEST_ONLY_TOKEN',fetcher:async()=>({ok:true,json:async()=>{throw Error('PRIVATE_BODY_DETAIL');}})}),error=>error.retryableReadTransport!==true&&error.message==='Remote deployment guard: REMOTE_RESPONSE_INVALID');
});
