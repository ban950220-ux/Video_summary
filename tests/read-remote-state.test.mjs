import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readRemoteState,assertRemoteDeploymentBaseline} from '../scripts/read-remote-state.mjs';
import {approvedRemoteBaseline,approvedPreDeployLineage} from '../scripts/remote-state-policy.mjs';
const reviewEnv={GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify({kind:'REMOTE_DEPLOYMENT_REVIEW_V1',accountId:approvedRemoteBaseline.accountId,workerName:approvedRemoteBaseline.workerName,databaseId:approvedRemoteBaseline.databaseId,activeVersionId:approvedRemoteBaseline.activeVersionId,priorVersionId:approvedRemoteBaseline.priorVersionId,scriptEtag:approvedRemoteBaseline.scriptEtag,sourceCommit:approvedRemoteBaseline.sourceCommit,reviewedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()})};

function fakeApi({status=200,observability=approvedRemoteBaseline.observability,scriptSettings=approvedRemoteBaseline.scriptSettings,includeOptional=false,currentMessage=`source-commit:${approvedRemoteBaseline.sourceCommit}`,priorMessage=`source-commit:${approvedRemoteBaseline.sourceCommit}`,currentEtag=approvedPreDeployLineage.scriptEtag,priorEtag=approvedPreDeployLineage.scriptEtag,recoverySetting='PRIVATE_PRESERVED_SETTING'}={}){
  const seen=[];
  const fetcher=async(url,options)=>{
    seen.push({url,method:options.method,tokenPresent:options.headers.Authorization==='Bearer TEST_ONLY_TOKEN'});
    if(status!==200)return {ok:false,status};
    const path=new URL(url).pathname;
    let result;
    if(path.endsWith('/workers/services/'+approvedRemoteBaseline.workerName))result={default_environment:{environment:'production',script:{tag:'TEST_WORKER_TAG'}}};
    else if(path.endsWith('/environments/production'))result={script:{compatibility_date:'2026-10-10',observability,...(includeOptional?{streaming_tail_consumers:[],limits:null,placement_mode:null}:{})}};
    else if(path.endsWith('/bindings'))result=[
      {name:'DB',type:'d1',id:approvedRemoteBaseline.databaseId},
      {name:'ACCESS_AUD',type:'plain_text',text:'TEST_ONLY_AUDIENCE'},
      {name:'ACCESS_TEAM_DOMAIN',type:'plain_text',text:'https://test.cloudflareaccess.com'},
      {name:'ACCESS_OWNER_EMAIL',type:'secret_text'},
      {name:'KEY_ENCRYPTION_KEY_B64',type:'secret_text'},
      {name:'ENABLE_LIVE_FREE',type:'plain_text',text:'true'},
      {name:'ALLOW_PAID_API',type:'plain_text',text:'false'},
      {name:'SITE_DEPLOYED',type:'plain_text',text:'true'},
      {name:'ENABLE_PAID_SUMMARY',type:'plain_text',text:'true'},
      {name:'PAID_SUMMARY_EXECUTION_APPROVED',type:'plain_text',text:'true'},
      {name:'PAID_FIRST_GENERATION_TRIAL_ENABLED',type:'plain_text',text:'true'},
      {name:'PAID_FIRST_TRIAL_USD_COST_REVIEWED',type:'plain_text',text:'true'},
      {name:'ENABLE_GEMINI_TWO_PASS',type:'secret_text'},
      {name:'GEMINI_TWO_PASS_ALLOWED_JOB_ID',type:'secret_text'},
      {name:'GEMINI_LEGACY_QUOTE_RECOVERY_JSON',type:'plain_text',text:recoverySetting},
      {name:'ASSETS',type:'assets'},
    ];
    else if(path.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
    else if(path.endsWith('/routes'))result=[];
    else if(path.endsWith('/domains/records'))result=[];
    else if(path.endsWith('/deployments'))result={deployments:[{source:'dash',versions:[{version_id:approvedRemoteBaseline.activeVersionId,percentage:100}],annotations:{'workers/message':currentMessage}},{source:'wrangler',versions:[{version_id:approvedPreDeployLineage.priorVersionId,percentage:100}],annotations:{'workers/message':priorMessage}}]};
    else if(path.endsWith('/versions/'+approvedRemoteBaseline.activeVersionId))result={id:approvedRemoteBaseline.activeVersionId,resources:{script:{etag:currentEtag},script_runtime:{assets:{binding:'ASSETS'},compatibility_date:'2026-10-10'},bindings:[{name:'ASSETS',type:'assets'},{name:'KEY_ENCRYPTION_KEY_B64',type:'secret_text'},{name:'GEMINI_LEGACY_QUOTE_RECOVERY_JSON',type:'plain_text',text:recoverySetting}]}};
    else if(path.endsWith('/versions/'+approvedPreDeployLineage.priorVersionId))result={id:approvedPreDeployLineage.priorVersionId,resources:{script:{etag:priorEtag},script_runtime:{assets:{binding:'ASSETS'},compatibility_date:'2026-10-10'},bindings:[{name:'ASSETS',type:'assets'},{name:'KEY_ENCRYPTION_KEY_B64',type:'secret_text'}]}};
    else if(path.endsWith('/script-settings'))result=scriptSettings;
    else throw Error('Unexpected test API path');
    return {ok:true,async json(){return {success:true,result};}};
  };
  return {fetcher,seen};
}

test('read-only guard checks the active baseline twice before deploy',async()=>{
  const {fetcher,seen}=fakeApi();
  assert.equal((await assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher,ciMatchTag:'TEST_WORKER_TAG',baseline:{...approvedRemoteBaseline,remoteSettingsReviewed:true}})).workerTag,'TEST_WORKER_TAG');
  assert.equal(seen.length,16);
  assert.ok(seen.every(call=>call.method==='GET'&&call.tokenPresent));
});
test('guard fails closed when token, API read or observability fields are unavailable',async()=>{
  await assert.rejects(readRemoteState({fetcher:()=>{throw Error('should not fetch');}}),/BUILD_TOKEN_UNAVAILABLE/);
  await assert.rejects(readRemoteState({token:'TEST_ONLY_TOKEN',fetcher:fakeApi({status:403}).fetcher,target:approvedRemoteBaseline}),/REMOTE_READ_FAILED/);
  const incomplete=structuredClone(approvedRemoteBaseline.observability);
  delete incomplete.logs.invocation_logs;
  const baseline={...approvedRemoteBaseline,remoteSettingsReviewed:true};
  await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher:fakeApi().fetcher,baseline:{...approvedRemoteBaseline,remoteSettingsReviewed:false}}),/REMOTE_SETTINGS_BASELINE_UNVERIFIED/);
  await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher:fakeApi({observability:incomplete}).fetcher,baseline}),/OBSERVABILITY_INCOMPLETE/);
  await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher:fakeApi({scriptSettings:{tail_consumers:[]}}).fetcher,baseline}),/SCRIPT_SETTINGS_INCOMPLETE/);
  await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher:fakeApi({scriptSettings:{...approvedRemoteBaseline.scriptSettings,observability:{enabled:false}}}).fetcher,baseline}),/SCRIPT_SETTINGS_OBSERVABILITY_INCOMPLETE/);
  await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher:fakeApi().fetcher,ciMatchTag:'OTHER',baseline}),/WORKER_TAG_MISMATCH/);
  await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher:fakeApi({includeOptional:true}).fetcher,baseline}),/SCRIPT_SETTINGS_MISMATCH/);
  assert.equal((await assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher:fakeApi().fetcher,baseline})).environment,'production');
});

test('protected version evidence requires its exact source annotation on both pre-deploy reads',async()=>{
 const {fetcher,seen}=fakeApi();
 await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher,env:{}}),/DEPLOYMENT_EVIDENCE_UNAVAILABLE/);
 const state=await assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher,ciMatchTag:'TEST_WORKER_TAG',env:reviewEnv});
 assert.equal(state.activeVersions[0].id,approvedRemoteBaseline.activeVersionId);
 assert.equal(state.deploymentMessage,`source-commit:${approvedRemoteBaseline.sourceCommit}`);
 assert.equal(seen.length,16);assert.ok(seen.every(call=>call.method==='GET'&&call.tokenPresent));
});

test('missing private target fields block before any external read',async()=>{
 let calls=0;
 const fetcher=async()=>{calls++;throw Error('unexpected read');};
 const approval=JSON.parse(reviewEnv.GROQ_DEPLOYMENT_EVIDENCE_JSON);
 for(const name of ['accountId','workerName','databaseId','priorVersionId','scriptEtag']){
  const invalid={...approval};delete invalid[name];
  await assert.rejects(readRemoteState({token:'TEST_ONLY_TOKEN',fetcher,env:{GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify(invalid)}}),/DEPLOYMENT_EVIDENCE_INVALID/);
 }
 assert.equal(calls,0);
});

test('changed source annotation, recovery setting, or observability fails closed',async()=>{
 for(const changed of [
  {currentMessage:'other'},
  {recoverySetting:''},
  {observability:{...approvedRemoteBaseline.observability,enabled:false}},
 ]){
  const {fetcher}=fakeApi(changed);
  await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher,env:reviewEnv}),/Remote deployment guard: (SOURCE_COMMIT_MISMATCH|OBSERVABILITY_MISMATCH|RECOVERY_SETTING_UNAVAILABLE)/);
 }
 const {fetcher}=fakeApi();
 await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher:async(url,options)=>url.endsWith('/bindings')?{ok:false,status:403}:fetcher(url,options),env:reviewEnv}),/READ_FAILED/);
});
test('a recovery setting change between pre-deploy reads blocks without revealing its value',async()=>{
 const {fetcher}=fakeApi();let bindingReads=0;
 const changed=async(url,options)=>{
  const response=await fetcher(url,options);
  if(url.endsWith('/bindings')&&++bindingReads===2){const body=await response.json();body.result.find(item=>item.name==='GEMINI_LEGACY_QUOTE_RECOVERY_JSON').text='PRIVATE_CHANGED_SETTING';return {ok:true,json:async()=>body};}
  return response;
 };
 await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher:changed,env:reviewEnv}),error=>error.message.includes('RECOVERY_SETTING_CHANGED')&&!error.message.includes('PRIVATE_'));
});
test('a protected Groq scope binding added between guard reads blocks deploy',async()=>{
 const {fetcher}=fakeApi();let bindingReads=0;
 const changed=async(url,options)=>{
  const response=await fetcher(url,options);
  if(url.endsWith('/bindings')&&++bindingReads===2){const body=await response.json();body.result.push({name:'GROQ_LEGACY_RECOVERY_SCOPE_JSON',type:'secret_text'});return {ok:true,json:async()=>body};}
  return response;
 };
 await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher:changed,env:reviewEnv}),/GROQ_SCOPE_BINDING_CHANGED/);
});
