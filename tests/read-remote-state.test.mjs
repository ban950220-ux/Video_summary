import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readRemoteState,assertRemoteDeploymentBaseline} from '../scripts/read-remote-state.mjs';
import {approvedRemoteBaseline,approvedPreDeployLineage} from '../scripts/remote-state-policy.mjs';

function fakeApi({status=200,observability=approvedRemoteBaseline.observability,scriptSettings=approvedRemoteBaseline.scriptSettings,includeOptional=false,currentMessage=`source-commit:${approvedRemoteBaseline.sourceCommit}`,priorMessage=`source-commit:${approvedRemoteBaseline.sourceCommit}`,currentEtag=approvedPreDeployLineage.scriptEtag,priorEtag=approvedPreDeployLineage.scriptEtag}={}){
  const seen=[];
  const fetcher=async(url,options)=>{
    seen.push({url,method:options.method,tokenPresent:options.headers.Authorization==='Bearer TEST_ONLY_TOKEN'});
    if(status!==200)return {ok:false,status};
    const path=new URL(url).pathname;
    let result;
    if(path.endsWith('/workers/services/holy-rice-b914'))result={default_environment:{environment:'production',script:{tag:'TEST_WORKER_TAG'}}};
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
      {name:'ASSETS',type:'assets'},
    ];
    else if(path.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
    else if(path.endsWith('/routes'))result=[];
    else if(path.endsWith('/domains/records'))result=[];
    else if(path.endsWith('/deployments'))result={deployments:[{versions:[{version_id:approvedRemoteBaseline.activeVersionId,percentage:100}],annotations:{'workers/message':currentMessage}},{versions:[{version_id:approvedPreDeployLineage.priorVersionId,percentage:100}],annotations:{'workers/message':priorMessage}}]};
    else if(path.endsWith('/versions/'+approvedRemoteBaseline.activeVersionId))result={id:approvedRemoteBaseline.activeVersionId,resources:{script:{etag:currentEtag},bindings:[{name:'ASSETS',type:'assets'}]}};
    else if(path.endsWith('/versions/'+approvedPreDeployLineage.priorVersionId))result={id:approvedPreDeployLineage.priorVersionId,resources:{script:{etag:priorEtag},bindings:[{name:'ASSETS',type:'assets'}]}};
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
  await assert.rejects(readRemoteState({token:'TEST_ONLY_TOKEN',fetcher:fakeApi({status:403}).fetcher}),/REMOTE_READ_FAILED/);
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

test('current annotated release rejects a settings version using old lineage evidence',async()=>{
 const {fetcher}=fakeApi({currentMessage:'Dashboard settings update'});
 await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher,ciMatchTag:'TEST_WORKER_TAG'}),/SOURCE_COMMIT_MISMATCH/);
});

test('missing current annotation fails closed even with old lineage evidence',async()=>{
 for(const changed of [
  {currentEtag:'a'.repeat(64)},
  {priorEtag:'b'.repeat(64)},
  {currentEtag:null},
  {priorMessage:'other'},
  {observability:{...approvedRemoteBaseline.observability,enabled:false}},
 ]){
  const {fetcher}=fakeApi({currentMessage:'Dashboard settings update',...changed});
  await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher}),/Remote deployment guard: (SOURCE_COMMIT_MISMATCH|OBSERVABILITY_MISMATCH)/);
 }
 const {fetcher}=fakeApi({currentMessage:'Dashboard settings update'});
 await assert.rejects(assertRemoteDeploymentBaseline({token:'TEST_ONLY_TOKEN',fetcher:async(url,options)=>url.includes('/versions/')?{ok:false,status:403}:fetcher(url,options)}),/READ_FAILED/);
});
