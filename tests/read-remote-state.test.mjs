import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readRemoteState,assertRemoteDeploymentBaseline} from '../scripts/read-remote-state.mjs';
import {approvedRemoteBaseline} from '../scripts/remote-state-policy.mjs';

function fakeApi({status=200,observability=approvedRemoteBaseline.observability,scriptSettings=approvedRemoteBaseline.scriptSettings,includeOptional=false}={}){
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
      {name:'ENABLE_LIVE_FREE',type:'plain_text',text:'false'},
      {name:'ALLOW_PAID_API',type:'plain_text',text:'false'},
      {name:'SITE_DEPLOYED',type:'plain_text',text:'true'},
    ];
    else if(path.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
    else if(path.endsWith('/routes'))result=[];
    else if(path.endsWith('/domains/records'))result=[];
    else if(path.endsWith('/deployments'))result={deployments:[{versions:[{version_id:approvedRemoteBaseline.activeVersionId,percentage:100}],annotations:{'workers/message':'old-deployment'}}]};
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
