import {test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedRemoteBaseline,approvedPreDeployLineage,assertRemoteState,assertProtectedDeployTarget,protectedRemoteBaseline} from '../scripts/remote-state-policy.mjs';

const observability=approvedRemoteBaseline.observability;
const optionalScriptFields=approvedRemoteBaseline.optionalScriptFields;
const baseline=approvedRemoteBaseline;
test('protected deployment identity must match Wrangler config and child account before upload',()=>{
 const config=`name = "${baseline.workerName}"\n[[d1_databases]]\ndatabase_id = "${baseline.databaseId}"\n`;
 assert.equal(assertProtectedDeployTarget(config,baseline,{CLOUDFLARE_ACCOUNT_ID:baseline.accountId,WRANGLER_CI_OVERRIDE_NAME:baseline.workerName}),true);
 for(const changed of [
  config.replace(baseline.workerName,'other-worker'),
  config.replace(baseline.databaseId,'55555555-5555-4555-8555-555555555555'),
  config+`database_id = "${baseline.databaseId}"\n`,
 ])assert.throws(()=>assertProtectedDeployTarget(changed,baseline),/PROTECTED_DEPLOY_TARGET_MISMATCH/);
 assert.throws(()=>assertProtectedDeployTarget(config,baseline,{CLOUDFLARE_ACCOUNT_ID:'b'.repeat(32)}),/PROTECTED_DEPLOY_TARGET_MISMATCH/);
 assert.throws(()=>assertProtectedDeployTarget(config,baseline,{WRANGLER_CI_OVERRIDE_NAME:'other-worker'}),/PROTECTED_DEPLOY_TARGET_MISMATCH/);
});
const remote=()=>({workerName:baseline.workerName,environment:'production',activeVersions:[{id:baseline.activeVersionId,percentage:100}],deploymentMessage:`source-commit:${baseline.sourceCommit}`,workersDev:true,previewUrls:false,routes:[],domains:[],compatibilityDate:'2026-10-10',compatibilityFlagsPresent:false,observability:structuredClone(observability),optionalScriptFields:structuredClone(optionalScriptFields),scriptSettings:{logpush:false,tail_consumers:null,observability:structuredClone(observability)},bindings:[
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
  {name:'ENABLE_GEMINI_TWO_PASS',type:'secret_text'},
  {name:'GEMINI_TWO_PASS_ALLOWED_JOB_ID',type:'secret_text'},
  {name:'GEMINI_LEGACY_QUOTE_RECOVERY_JSON',type:'plain_text',text:'PRIVATE_PRESERVED_SETTING'},
]});

test('guard baseline pins the verified active Worker version and source commit',()=>{
  assert.match(approvedRemoteBaseline.activeVersionId,/^[0-9a-f-]{36}$/);
  assert.match(approvedRemoteBaseline.sourceCommit,/^[0-9a-f]{40}$/);
  assert.equal(approvedRemoteBaseline.remoteSettingsReviewed,true);
  const observed=remote();observed.bindings.push({name:'ASSETS',type:'assets'});
  assert.equal(assertRemoteState(observed,approvedRemoteBaseline),true);
  const previous=structuredClone(observed);
  previous.activeVersions[0].id=baseline.priorVersionId;
  previous.deploymentMessage='source-commit:'+'b'.repeat(40);
  assert.throws(()=>assertRemoteState(previous,approvedRemoteBaseline),/ACTIVE_VERSION_MISMATCH/);
  previous.activeVersions[0].id=approvedRemoteBaseline.activeVersionId;
  previous.deploymentMessage='source-commit:'+'b'.repeat(40);
  assert.throws(()=>assertRemoteState(previous,approvedRemoteBaseline),/SOURCE_COMMIT_MISMATCH/);
});

test('protected deployment identity is required, recent, exact, and still checked against remote state',()=>{
 const reviewedAt=new Date(Date.now()-1000).toISOString(),expiresAt=new Date(Date.now()+3600000).toISOString();
 const approval={kind:'REMOTE_DEPLOYMENT_REVIEW_V1',accountId:baseline.accountId,workerName:baseline.workerName,databaseId:baseline.databaseId,activeVersionId:'44444444-4444-4444-8444-444444444444',priorVersionId:baseline.priorVersionId,scriptEtag:baseline.scriptEtag,sourceCommit:'b'.repeat(40),reviewedAt,expiresAt};
 const env={GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify(approval)};
 assert.throws(()=>protectedRemoteBaseline({}),/DEPLOYMENT_EVIDENCE_UNAVAILABLE/);
 assert.throws(()=>protectedRemoteBaseline({GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify({...approval,expiresAt:new Date(Date.now()-1000).toISOString()})}),/DEPLOYMENT_EVIDENCE_EXPIRED/);
 assert.throws(()=>protectedRemoteBaseline({GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify({...approval,extra:'x'})}),/DEPLOYMENT_EVIDENCE_INVALID/);
 const protectedBaseline=protectedRemoteBaseline(env),state=remote();state.bindings.push({name:'ASSETS',type:'assets'});
 assert.throws(()=>assertRemoteState(state,protectedBaseline),/ACTIVE_VERSION_MISMATCH/);
 state.activeVersions[0].id=approval.activeVersionId;
 assert.throws(()=>assertRemoteState(state,protectedBaseline),/SOURCE_COMMIT_MISMATCH/);
 state.deploymentMessage=`source-commit:${approval.sourceCommit}`;
 assert.equal(assertRemoteState(state,protectedBaseline),true);
});

test('the PR9 settings version requires the pinned predecessor and unchanged script and settings',()=>{
 const state=remote();state.bindings.push({name:'ASSETS',type:'assets'});state.activeVersions[0].id=approvedPreDeployLineage.activeVersionId;state.deploymentMessage='Dashboard settings update';
 const historicalBaseline={...baseline,activeVersionId:approvedPreDeployLineage.activeVersionId,sourceCommit:approvedPreDeployLineage.sourceCommit};
 const proof={activeVersionId:approvedPreDeployLineage.activeVersionId,priorVersionId:approvedPreDeployLineage.priorVersionId,activeDeploymentSourceAnnotation:'OTHER',priorDeploymentSourceAnnotation:'EXPECTED',activeDeploymentSource:'DASHBOARD',priorDeploymentSource:'WRANGLER',scriptEtagMatchesPinned:true,scriptContentEqual:true,runtimeMetadataComplete:true,runtimeMetadataEqual:true,knownBindingAddition:true,activeAssetsBindingCount:1,priorAssetsBindingCount:1,codeLineageEvidence:'SAME_SCRIPT_AND_SETTINGS_AS_ANNOTATED_PRIOR',sourceAnnotationGuardMatch:false,assetSetIdentifier:'NOT_EXPOSED_BY_VERSION_GET'};
 assert.throws(()=>assertRemoteState(state,historicalBaseline),/SOURCE_COMMIT_MISMATCH/);
 assert.equal(assertRemoteState(state,historicalBaseline,{preDeployLineage:proof}),true);
 const wrongBaseline={...historicalBaseline,priorVersionId:'55555555-5555-4555-8555-555555555555'};
 assert.throws(()=>assertRemoteState(state,wrongBaseline,{preDeployLineage:proof}),/SOURCE_COMMIT_MISMATCH/);
 for(const [key,value] of [['activeVersionId','other'],['priorVersionId','other'],['activeDeploymentSourceAnnotation','MISSING'],['priorDeploymentSourceAnnotation','OTHER'],['activeDeploymentSource','OTHER'],['priorDeploymentSource','OTHER'],['scriptEtagMatchesPinned',false],['scriptContentEqual',false],['runtimeMetadataComplete',false],['runtimeMetadataComplete',undefined],['runtimeMetadataEqual',false],['knownBindingAddition',false],['activeAssetsBindingCount',0],['priorAssetsBindingCount',0],['codeLineageEvidence','UNVERIFIED'],['sourceAnnotationGuardMatch',true]]){
  assert.throws(()=>assertRemoteState(state,historicalBaseline,{preDeployLineage:{...proof,[key]:value}}),/SOURCE_COMMIT_MISMATCH/,key);
 }
 const changed=structuredClone(state);changed.activeVersions[0].id='other';assert.throws(()=>assertRemoteState(changed,historicalBaseline,{preDeployLineage:proof}),/ACTIVE_VERSION_MISMATCH/);
 changed.activeVersions[0].id=historicalBaseline.activeVersionId;changed.bindings.find(item=>item.name==='DB').id='other';assert.throws(()=>assertRemoteState(changed,historicalBaseline,{preDeployLineage:proof}),/D1_MISMATCH/);
 changed.bindings.find(item=>item.name==='DB').id=baseline.databaseId;changed.bindings.find(item=>item.name==='ACCESS_AUD').text='';assert.throws(()=>assertRemoteState(changed,historicalBaseline,{preDeployLineage:proof}),/ACCESS_VARS_MISSING/);
 changed.bindings.find(item=>item.name==='ACCESS_AUD').text='test-audience-value';changed.bindings.pop();assert.throws(()=>assertRemoteState(changed,historicalBaseline,{preDeployLineage:proof}),/BINDINGS_UNEXPECTED/);
 const missingSetting=structuredClone(state);missingSetting.bindings.find(item=>item.name==='GEMINI_LEGACY_QUOTE_RECOVERY_JSON').text='';assert.throws(()=>assertRemoteState(missingSetting,historicalBaseline,{preDeployLineage:proof}),/RECOVERY_SETTING_UNAVAILABLE/);
});

test('offline remote policy requires exactly one ASSETS before and after later deploys',()=>{
  const after=remote();after.bindings.push({name:'ASSETS',type:'assets'});
  assert.equal(assertRemoteState(after,baseline),true);
  const protectedScope=structuredClone(after);protectedScope.bindings.push({name:'GROQ_LEGACY_RECOVERY_SCOPE_JSON',type:'secret_text'});
  assert.equal(assertRemoteState(protectedScope,baseline),true);
  protectedScope.bindings.at(-1).type='plain_text';
  assert.throws(()=>assertRemoteState(protectedScope,baseline),/BINDINGS_UNEXPECTED/);
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
    state=>{state.deploymentMessage='source-commit:'+('b'.repeat(40));},
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
  ]){const state=remote();state.bindings.push({name:'ASSETS',type:'assets'});mutate(state);assert.throws(()=>assertRemoteState(state,baseline),/Remote deployment guard/,mutate.toString());}
  const incomplete=remote();incomplete.bindings.push({name:'ASSETS',type:'assets'});delete incomplete.observability.logs.invocation_logs;
  assert.throws(()=>assertRemoteState(incomplete,baseline),/OBSERVABILITY_INCOMPLETE/);
});
