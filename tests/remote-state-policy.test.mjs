import {test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedRemoteBaseline,approvedPreDeployLineage,assertRemoteState} from '../scripts/remote-state-policy.mjs';

const observability=approvedRemoteBaseline.observability;
const optionalScriptFields=approvedRemoteBaseline.optionalScriptFields;
const baseline=approvedRemoteBaseline;
const remote=()=>({workerName:'holy-rice-b914',environment:'production',activeVersions:[{id:baseline.activeVersionId,percentage:100}],deploymentMessage:`source-commit:${baseline.sourceCommit}`,workersDev:true,previewUrls:false,routes:[],domains:[],compatibilityDate:'2026-10-10',compatibilityFlagsPresent:false,observability:structuredClone(observability),optionalScriptFields:structuredClone(optionalScriptFields),scriptSettings:{logpush:false,tail_consumers:null,observability:structuredClone(observability)},bindings:[
  {name:'DB',type:'d1',id:baseline.databaseId},
  {name:'ACCESS_AUD',type:'plain_text',text:'test-audience-value'},
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
]});

test('guard baseline pins the verified active Worker version and source commit',()=>{
  assert.equal(approvedRemoteBaseline.activeVersionId,'3ab1c143-be05-46d5-8004-7d09508c916e');
  assert.equal(approvedRemoteBaseline.sourceCommit,'040c4289a700b3867e285d8d8eb93c710a3b4c89');
  assert.equal(approvedRemoteBaseline.remoteSettingsReviewed,true);
  const observed=remote();observed.bindings.push({name:'ASSETS',type:'assets'});
  assert.equal(assertRemoteState(observed,approvedRemoteBaseline),true);
  const previous=structuredClone(observed);
  previous.activeVersions[0].id='589e91f6-67a8-4d14-a895-84135330ed4b';
  previous.deploymentMessage='source-commit:7a2407bdc0fcf73245399f75917e8dc6b949a272';
  assert.throws(()=>assertRemoteState(previous,approvedRemoteBaseline),/ACTIVE_VERSION_MISMATCH/);
  previous.activeVersions[0].id=approvedRemoteBaseline.activeVersionId;
  previous.deploymentMessage='source-commit:e1d75ed25f2c5a04adff6c615a17ffecd2a77d3c';
  assert.throws(()=>assertRemoteState(previous,approvedRemoteBaseline),/SOURCE_COMMIT_MISMATCH/);
});

test('the one settings version accepts only the pinned annotated predecessor and exact script hash',()=>{
 const oldBaseline={...baseline,activeVersionId:approvedPreDeployLineage.activeVersionId,sourceCommit:approvedPreDeployLineage.sourceCommit};
 const state=remote();state.activeVersions[0].id=oldBaseline.activeVersionId;state.bindings.push({name:'ASSETS',type:'assets'});state.deploymentMessage='Dashboard settings update';
 const proof={activeVersionId:approvedPreDeployLineage.activeVersionId,priorVersionId:approvedPreDeployLineage.priorVersionId,activeDeploymentSourceAnnotation:'OTHER',priorDeploymentSourceAnnotation:'EXPECTED',activeScriptEtag:approvedPreDeployLineage.scriptEtag,priorScriptEtag:approvedPreDeployLineage.scriptEtag,scriptContentEqual:true,codeLineageEvidence:'SAME_SCRIPT_AS_ANNOTATED_PRIOR',sourceAnnotationGuardMatch:false,assetSetIdentifier:'NOT_EXPOSED_BY_VERSION_GET'};
 assert.throws(()=>assertRemoteState(state,oldBaseline),/SOURCE_COMMIT_MISMATCH/);
 assert.equal(assertRemoteState(state,oldBaseline,{preDeployLineage:proof}),true);
 const current=remote();current.bindings.push({name:'ASSETS',type:'assets'});current.deploymentMessage='Dashboard settings update';
 assert.throws(()=>assertRemoteState(current,baseline,{preDeployLineage:proof}),/SOURCE_COMMIT_MISMATCH/);
 for(const [key,value] of [['activeVersionId','other'],['priorVersionId','other'],['activeDeploymentSourceAnnotation','MISSING'],['priorDeploymentSourceAnnotation','OTHER'],['activeScriptEtag','a'.repeat(64)],['priorScriptEtag','a'.repeat(64)],['scriptContentEqual',false],['codeLineageEvidence','UNVERIFIED'],['sourceAnnotationGuardMatch',true]]){
  assert.throws(()=>assertRemoteState(state,oldBaseline,{preDeployLineage:{...proof,[key]:value}}),/SOURCE_COMMIT_MISMATCH/,key);
 }
 const changed=structuredClone(state);changed.activeVersions[0].id='other';assert.throws(()=>assertRemoteState(changed,oldBaseline,{preDeployLineage:proof}),/ACTIVE_VERSION_MISMATCH/);
 changed.activeVersions[0].id=oldBaseline.activeVersionId;changed.bindings.find(item=>item.name==='DB').id='other';assert.throws(()=>assertRemoteState(changed,oldBaseline,{preDeployLineage:proof}),/D1_MISMATCH/);
 changed.bindings.find(item=>item.name==='DB').id=baseline.databaseId;changed.bindings.find(item=>item.name==='ACCESS_AUD').text='';assert.throws(()=>assertRemoteState(changed,oldBaseline,{preDeployLineage:proof}),/ACCESS_VARS_MISSING/);
 changed.bindings.find(item=>item.name==='ACCESS_AUD').text='test-audience-value';changed.bindings.pop();assert.throws(()=>assertRemoteState(changed,oldBaseline,{preDeployLineage:proof}),/BINDINGS_UNEXPECTED/);
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
  after.bindings.find(item=>item.name==='ALLOW_PAID_API').text='false';
  for(const name of ['ENABLE_PAID_SUMMARY','PAID_SUMMARY_EXECUTION_APPROVED','PAID_FIRST_GENERATION_TRIAL_ENABLED','PAID_FIRST_TRIAL_USD_COST_REVIEWED']){
    const state=structuredClone(after);state.bindings.find(item=>item.name===name).text='false';
    assert.throws(()=>assertRemoteState(state,baseline),/RUNTIME_FLAGS_MISMATCH/);
    assert.throws(()=>assertRemoteState(state,baseline,{postDeploy:true}),/RUNTIME_FLAGS_MISMATCH/);
  }
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
    state=>{state.compatibilityFlags=null;},
    state=>{state.observability.logs.destinations=[];},
    state=>{state.observability.logs.destinations=null;},
    state=>{state.observability.issues={enabled:false};},
    state=>{state.observability.issues=null;},
    state=>{delete state.scriptSettings.tail_consumers;},
    state=>{state.scriptSettings.observability.logs.persist=false;},
  ]){const state=remote();state.bindings.push({name:'ASSETS',type:'assets'});mutate(state);assert.throws(()=>assertRemoteState(state,baseline),/Remote deployment guard/);}
  const incomplete=remote();incomplete.bindings.push({name:'ASSETS',type:'assets'});delete incomplete.observability.logs.invocation_logs;
  assert.throws(()=>assertRemoteState(incomplete,baseline),/OBSERVABILITY_INCOMPLETE/);
});
