import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {approvedRemoteBaseline,approvedPreDeployLineage,assertRemoteState,assertProtectedDeployTarget,protectedRemoteBaseline} from '../scripts/remote-state-policy.mjs';
import {assertProductionTarget} from '../scripts/guard-production-target.mjs';
import {inspectFullCoverageConfig} from '../scripts/full-coverage-config.mjs';
import {geminiPaidFlagNames} from '../scripts/gemini-paid-activation.mjs';
import {safeRemoteBaselineReport} from '../scripts/remote-baseline-preflight.mjs';

const observability=approvedRemoteBaseline.observability;
const optionalScriptFields=approvedRemoteBaseline.optionalScriptFields;
const baseline=approvedRemoteBaseline;
const paidReview=(extra={})=>({kind:'REMOTE_DEPLOYMENT_REVIEW_V1',accountId:baseline.accountId,workerName:baseline.workerName,databaseId:baseline.databaseId,activeVersionId:baseline.activeVersionId,priorVersionId:baseline.priorVersionId,scriptEtag:baseline.scriptEtag,sourceCommit:baseline.sourceCommit,reviewedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),...extra});
const reviewEnv=review=>({GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify(review)});
test('production config permits only the exact optional flag and never embeds Free proof',()=>{
 const config=readFileSync(resolve(import.meta.dirname,'../wrangler.toml'),'utf8');
 assert.equal(assertProductionTarget(config),true);
 for(const line of ['ENABLE_FULL_COVERAGE = "true"','  ENABLE_FULL_COVERAGE\t=\t"true"  # reviewed']){
  const enabled=config.replace('ENABLE_LIVE_FREE = "true"',`ENABLE_LIVE_FREE = "true"\n${line}`);
  assert.equal(inspectFullCoverageConfig(enabled).enabled,true);
  assert.equal(assertProductionTarget(enabled),true);
 }
 assert.equal(inspectFullCoverageConfig(config+'\n# ENABLE_FULL_COVERAGE = "true"\n# GROQ_FREE_ORG_BINDING_JSON = "x"\n').enabled,false);
 for(const altered of [
  config.replace('ENABLE_LIVE_FREE = "true"','ENABLE_LIVE_FREE = "true"\nENABLE_FULL_COVERAGE = "false"'),
  config.replace('ENABLE_LIVE_FREE = "true"','ENABLE_LIVE_FREE = "true"\nENABLE_FULL_COVERAGE = "true"\nENABLE_FULL_COVERAGE = "true"'),
  config.replace('ENABLE_LIVE_FREE = "true"','ENABLE_LIVE_FREE = "true"\n"ENABLE_FULL_COVERAGE" = "true"'),
  config.replace('ENABLE_LIVE_FREE = "true"','ENABLE_LIVE_FREE = "true"\nvars.ENABLE_FULL_COVERAGE = "true"'),
  config.replace('ENABLE_LIVE_FREE = "true"','ENABLE_LIVE_FREE = "true"\n  ENABLE_FULL_COVERAGE = true'),
  config.replace('ENABLE_LIVE_FREE = "true"','ENABLE_LIVE_FREE = "true"\n"ENABLE_FULL_COVERAG\\u0045" = "true"'),
  config.replace('ENABLE_LIVE_FREE = "true"','ENABLE_LIVE_FREE = "true"\n"GROQ_FREE_ORG_BINDING_\\u004aSON" = "fake"'),
  config+'\n[previews.vars]\nENABLE_FULL_COVERAGE = "true"\n',
  config+'\n[vars]\nENABLE_FULL_COVERAGE = "true"\n',
  config+'\nGROQ_FREE_ORG_BINDING_JSON = "fake"\n',
  config+'\n"GROQ_FREE_ORG_BINDING_JSON" = "fake"\n',
 ])assert.throws(()=>assertProductionTarget(altered),/FULL_COVERAGE_CONFIG_INVALID|FREE_ORG_BINDING_MUST_BE_SECRET/);
});
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

test('full coverage runtime bindings require an exact fresh opt-in and stay exact before and after deployment',()=>{
 const reviewedAt=new Date(Date.now()-1000).toISOString(),expiresAt=new Date(Date.now()+3600000).toISOString();
 const approval={kind:'REMOTE_DEPLOYMENT_REVIEW_V1',accountId:baseline.accountId,workerName:baseline.workerName,databaseId:baseline.databaseId,activeVersionId:baseline.activeVersionId,priorVersionId:baseline.priorVersionId,scriptEtag:baseline.scriptEtag,sourceCommit:baseline.sourceCommit,reviewedAt,expiresAt};
 const old=protectedRemoteBaseline({GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify(approval)});
 const approved=protectedRemoteBaseline({GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify({...approval,fullCoverageEnabled:true})});
 assert.equal(approved.fullCoverageEnabled,true);
 for(const value of [false,'true',null])assert.throws(()=>protectedRemoteBaseline({GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify({...approval,fullCoverageEnabled:value})}),/DEPLOYMENT_EVIDENCE_INVALID/);
 const active=remote();active.bindings.push({name:'ASSETS',type:'assets'},{name:'ENABLE_FULL_COVERAGE',type:'plain_text',text:'true'},{name:'GROQ_FREE_ORG_BINDING_JSON',type:'secret_text'});
 for(const postDeploy of [false,true]){
  assert.equal(assertRemoteState(active,approved,{postDeploy}),true);
  assert.throws(()=>assertRemoteState(active,old,{postDeploy}),/BINDINGS_UNEXPECTED/);
  for(const change of [
   state=>{state.bindings.find(x=>x.name==='ENABLE_FULL_COVERAGE').text='false';},
   state=>{state.bindings.find(x=>x.name==='GROQ_FREE_ORG_BINDING_JSON').type='plain_text';},
   state=>{state.bindings.splice(state.bindings.findIndex(x=>x.name==='GROQ_FREE_ORG_BINDING_JSON'),1);},
   state=>{state.bindings.push({name:'UNREVIEWED',type:'secret_text'});},
  ]){const changed=structuredClone(active);change(changed);assert.throws(()=>assertRemoteState(changed,approved,{postDeploy}),/BINDINGS_UNEXPECTED|RUNTIME_FLAGS_MISMATCH/);}
 }
 const config=`name = "${baseline.workerName}"\n[vars]\nENABLE_FULL_COVERAGE = "true"\n[[d1_databases]]\ndatabase_id = "${baseline.databaseId}"\n`;
 assert.equal(assertProtectedDeployTarget(config,approved),true);
 assert.equal(assertProtectedDeployTarget(config.replace('ENABLE_FULL_COVERAGE = "true"',' \tENABLE_FULL_COVERAGE = "true" # approved'),approved),true);
 assert.throws(()=>assertProtectedDeployTarget(config,old),/FULL_COVERAGE_ACTIVATION_UNAPPROVED/);
 assert.throws(()=>assertProtectedDeployTarget(config.replace('"true"','"false"'),approved),/FULL_COVERAGE_CONFIG_INVALID/);
 assert.throws(()=>assertProtectedDeployTarget(config.replace('ENABLE_FULL_COVERAGE','"ENABLE_FULL_COVERAGE"'),old),/FULL_COVERAGE_CONFIG_INVALID/);
 assert.throws(()=>assertProtectedDeployTarget(config+'GROQ_FREE_ORG_BINDING_JSON = "secret"\n',approved),/FREE_ORG_BINDING_MUST_BE_SECRET/);
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

test('Gemini paid deployment opt-in is exact and never grants unknown binding names',()=>{
 const approval=paidReview({geminiTwoPassPaidEnabled:true}),approved=protectedRemoteBaseline(reviewEnv(approval));
 assert.equal(approved.geminiTwoPassPaidEnabled,true);
 assert.equal(approved.deploymentEvidenceExpiresAt,approval.expiresAt);
 for(const value of [false,'true',null,0,1,[],{}])assert.throws(()=>protectedRemoteBaseline(reviewEnv({...approval,geminiTwoPassPaidEnabled:value})),/DEPLOYMENT_EVIDENCE_INVALID/);
 assert.throws(()=>protectedRemoteBaseline(reviewEnv({...approval,allowAnyPaidBinding:true})),/DEPLOYMENT_EVIDENCE_INVALID/);
 const old=protectedRemoteBaseline(reviewEnv(paidReview())),state=remote();state.bindings.push({name:'ASSETS',type:'assets'});
 assert.equal(assertRemoteState(state,old),true);
 state.bindings.push(...geminiPaidFlagNames.map(name=>({name,type:'plain_text',text:'true'})));
 for(const postDeploy of [false,true]){
  assert.equal(assertRemoteState(state,approved,{postDeploy}),true);
  assert.throws(()=>assertRemoteState(state,old,{postDeploy}),/BINDINGS_UNEXPECTED/);
  for(let mask=0;mask<7;mask++){
   const missing=structuredClone(state);
   missing.bindings=missing.bindings.filter(x=>!geminiPaidFlagNames.includes(x.name)||(mask&(1<<geminiPaidFlagNames.indexOf(x.name))));
   assert.throws(()=>assertRemoteState(missing,approved,{postDeploy}),/BINDINGS_UNEXPECTED/,`subset ${mask}`);
  }
  for(const name of geminiPaidFlagNames){
   for(const mutate of [
    x=>{x.bindings.find(b=>b.name===name).type='secret_text';},
    x=>{x.bindings.find(b=>b.name===name).text='false';},
    x=>{x.bindings.find(b=>b.name===name).text=true;},
    x=>{x.bindings.push({...x.bindings.find(b=>b.name===name)});},
   ]){const altered=structuredClone(state);mutate(altered);assert.throws(()=>assertRemoteState(altered,approved,{postDeploy}),/BINDINGS_UNEXPECTED|RUNTIME_FLAGS_MISMATCH/);}
  }
  const unknown=structuredClone(state);unknown.bindings.push({name:'PAID_OTHER',type:'plain_text',text:'true'});
  assert.throws(()=>assertRemoteState(unknown,approved,{postDeploy}),/BINDINGS_UNEXPECTED/);
  const broad=structuredClone(state);broad.bindings.find(x=>x.name==='ALLOW_PAID_API').text='true';
  assert.throws(()=>assertRemoteState(broad,approved,{postDeploy}),/RUNTIME_FLAGS_MISMATCH/);
 }
});

test('all Gemini paid flags stay out of TOML in every supported key spelling and environment',()=>{
 const config=readFileSync(resolve(import.meta.dirname,'../wrangler.toml'),'utf8');
 const targetConfig=`name = "${baseline.workerName}"\n[[d1_databases]]\ndatabase_id = "${baseline.databaseId}"\n`;
 const approved=protectedRemoteBaseline(reviewEnv(paidReview({geminiTwoPassPaidEnabled:true})));
 for(const name of geminiPaidFlagNames){
  for(const statement of [
   `[vars]\n${name} = "true"`, `[vars]\n \t${name}\t=\t"true" # active`,
   `[vars]\n"${name}" = "true"`, `[vars]\n'${name}' = 'true'`,
   `vars.${name} = "true"`, `vars = { ${name} = "true" }`,
   `[previews.vars]\n${name} = "true"`, `[env.preview.vars]\n${name} = "true"`,
   `[vars]\n${name} = true`, `[vars]\n${name} = "false"`,
   `[vars]\n"${name.slice(0,-1)}\\u0044" = "true"`,
  ]){
   assert.throws(()=>assertProductionTarget(config+'\n'+statement+'\n'),/GEMINI_PAID|FULL_COVERAGE_CONFIG_INVALID/);
   assert.throws(()=>assertProtectedDeployTarget(targetConfig+statement+'\n',approved),/GEMINI_PAID|FULL_COVERAGE_CONFIG_INVALID/);
  }
  const comment=`\n # ${name} = "true"\n`;
  assert.equal(assertProductionTarget(config+comment),true);
  assert.equal(assertProtectedDeployTarget(targetConfig+comment,approved),true);
 }
});

test('paid opt-in expires during a remote await and cannot pass preflight or postcheck',async t=>{
 const now=Date.UTC(2026,9,23,12);
 t.mock.timers.enable({apis:['Date'],now});
 const approval=paidReview({geminiTwoPassPaidEnabled:true,reviewedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+1000).toISOString()});
 const approved=protectedRemoteBaseline(reviewEnv(approval)),state=remote();
 state.bindings.push({name:'ASSETS',type:'assets'},...geminiPaidFlagNames.map(name=>({name,type:'plain_text',text:'true'})));
 assert.equal(assertRemoteState(state,approved),true);
 await Promise.resolve();t.mock.timers.setTime(now+1000);
 for(const postDeploy of [false,true])assert.throws(()=>assertRemoteState(state,approved,{postDeploy}),/DEPLOYMENT_EVIDENCE_EXPIRED/);
 const targetConfig=`name = "${baseline.workerName}"\n[[d1_databases]]\ndatabase_id = "${baseline.databaseId}"\n`;
 assert.throws(()=>assertProtectedDeployTarget(targetConfig,approved),/DEPLOYMENT_EVIDENCE_EXPIRED/);
 assert.throws(()=>assertRemoteState(state,{...approved,deploymentEvidenceExpiresAt:null}),/DEPLOYMENT_EVIDENCE_EXPIRED/);
});

test('sanitized diagnostics check all three paid values and compose with the existing Free opt-in',()=>{
 for(const fullCoverageEnabled of [false,true]){
  const env=reviewEnv(paidReview({geminiTwoPassPaidEnabled:true,...(fullCoverageEnabled?{fullCoverageEnabled:true}:{})}));
  const state=remote();state.bindings.push({name:'ASSETS',type:'assets'},...geminiPaidFlagNames.map(name=>({name,type:'plain_text',text:'true'})));
  if(fullCoverageEnabled)state.bindings.push({name:'ENABLE_FULL_COVERAGE',type:'plain_text',text:'true'},{name:'GROQ_FREE_ORG_BINDING_JSON',type:'secret_text'});
  const report=safeRemoteBaselineReport(state,env);
  assert.equal(report.bindings.complete,true);assert.equal(report.target.runtimeFlagsMatch,true);assert.equal(report.matchesProposedBaseline,true);
  for(const name of geminiPaidFlagNames){
   const changed=structuredClone(state);changed.bindings.find(x=>x.name===name).text='PRIVATE_VALUE_NEVER_LOG';
   const invalid=safeRemoteBaselineReport(changed,env);
   assert.equal(invalid.target.runtimeFlagsMatch,false);assert.equal(invalid.matchesProposedBaseline,false);assert.equal(invalid.mismatchCode,'RUNTIME_FLAGS_MISMATCH');
   assert.equal(JSON.stringify(invalid).includes('PRIVATE_VALUE_NEVER_LOG'),false);
  }
 }
});
