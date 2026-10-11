import {test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedRemoteBaseline,assertRemoteState} from '../scripts/remote-state-policy.mjs';

const observability=approvedRemoteBaseline.observability;
const version='a'.repeat(8)+'-1111-4111-8111-'+'b'.repeat(12);
const optionalScriptFields=approvedRemoteBaseline.optionalScriptFields;
const baseline={...approvedRemoteBaseline,activeVersionId:version,remoteSettingsReviewed:true};
const remote=()=>({workerName:'holy-rice-b914',environment:'production',activeVersions:[{id:version,percentage:100}],deploymentMessage:`source-commit:${baseline.sourceCommit}`,workersDev:true,previewUrls:false,routes:[],domains:[],compatibilityDate:'2026-10-10',compatibilityFlagsPresent:false,observability:structuredClone(observability),optionalScriptFields:structuredClone(optionalScriptFields),scriptSettings:{logpush:false,tail_consumers:null,observability:structuredClone(observability)},bindings:[
  {name:'DB',type:'d1',id:baseline.databaseId},
  {name:'ACCESS_AUD',type:'plain_text',text:'test-audience-value'},
  {name:'ACCESS_TEAM_DOMAIN',type:'plain_text',text:'https://test.cloudflareaccess.com'},
  {name:'ACCESS_OWNER_EMAIL',type:'secret_text'},
  {name:'KEY_ENCRYPTION_KEY_B64',type:'secret_text'},
  {name:'ENABLE_LIVE_FREE',type:'plain_text',text:'true'},
  {name:'ALLOW_PAID_API',type:'plain_text',text:'false'},
  {name:'SITE_DEPLOYED',type:'plain_text',text:'true'},
]});

test('guard baseline pins the verified active Worker version and source commit',()=>{
  assert.equal(approvedRemoteBaseline.activeVersionId,'e730511d-c688-4eda-bdc4-8d733eeadb55');
  assert.equal(approvedRemoteBaseline.sourceCommit,'3b7c704eab39651c308041dceae97c9f08541cab');
});

test('offline remote policy requires exactly one ASSETS before and after later deploys',()=>{
  const after=remote();after.bindings.push({name:'ASSETS',type:'assets'});
  assert.equal(assertRemoteState(after,baseline),true);
  assert.throws(()=>assertRemoteState(remote(),baseline),/BINDINGS_UNEXPECTED/);
  assert.equal(assertRemoteState(after,baseline,{postDeploy:true}),true);
  after.bindings.find(item=>item.name==='ENABLE_LIVE_FREE').text='false';
  assert.throws(()=>assertRemoteState(after,baseline),/RUNTIME_FLAGS_MISMATCH/);
  assert.throws(()=>assertRemoteState(after,baseline,{postDeploy:true}),/RUNTIME_FLAGS_MISMATCH/);
  after.bindings.find(item=>item.name==='ENABLE_LIVE_FREE').text='true';
  after.bindings.find(item=>item.name==='ALLOW_PAID_API').text='true';
  assert.throws(()=>assertRemoteState(after,baseline,{postDeploy:true}),/RUNTIME_FLAGS_MISMATCH/);
  assert.equal(assertRemoteState(remote(),{...baseline,assetsPresent:false}),true);
  for(const mutate of [
    state=>{state.bindings.push({...state.bindings.at(-1)});},
    state=>{state.bindings.at(-1).type='plain_text';},
  ]){
    const invalid=structuredClone(after);mutate(invalid);
    assert.throws(()=>assertRemoteState(invalid,baseline,{postDeploy:true}),/BINDINGS_UNEXPECTED/);
  }
});
test('offline remote policy fails closed on active version, DB, Access, preview and observability drift',()=>{
  for(const mutate of [
    state=>{state.activeVersions[0].id='different';},
    state=>{state.deploymentMessage='source-commit:'+('a'.repeat(40));},
    state=>{state.bindings[0].id='different';},
    state=>{state.bindings.splice(1,1);},
    state=>{state.bindings[1].text='';},
    state=>{state.previewUrls=true;},
    state=>{state.observability.logs.persist=false;},
    state=>{state.observability.traces.head_sampling_rate=0.5;},
    state=>{state.bindings.push({name:'OTHER',type:'plain_text',text:'x'});},
    state=>{state.scriptSettings.logpush=true;},
    state=>{state.scriptSettings.tail_consumers=[];},
    state=>{state.optionalScriptFields.streaming_tail_consumers={present:true,value:[]};},
    state=>{state.optionalScriptFields.limits={present:true,value:null};},
    state=>{state.optionalScriptFields.placement_mode={present:true,value:'smart'};},
    state=>{state.compatibilityFlagsPresent=true;state.compatibilityFlags=[];},
    state=>{state.observability.logs.destinations=[];},
    state=>{state.observability.issues={enabled:false};},
    state=>{state.scriptSettings.observability.logs.persist=false;},
  ]){const state=remote();state.bindings.push({name:'ASSETS',type:'assets'});mutate(state);assert.throws(()=>assertRemoteState(state,baseline),/Remote deployment guard/);}
  const incomplete=remote();incomplete.bindings.push({name:'ASSETS',type:'assets'});delete incomplete.observability.logs.invocation_logs;
  assert.throws(()=>assertRemoteState(incomplete,baseline),/OBSERVABILITY_INCOMPLETE/);
});
