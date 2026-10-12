import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runRemoteBaselinePreflight,safeRemoteBaselineReport} from '../scripts/remote-baseline-preflight.mjs';
import {approvedRemoteBaseline} from '../scripts/remote-state-policy.mjs';

const secret='PRIVATE_SENTINEL_DO_NOT_PRINT';
const remote=()=>({
 workerName:'holy-rice-b914',environment:'production',workerTag:secret,
 activeVersions:[{id:approvedRemoteBaseline.activeVersionId,percentage:100}],
 workersDev:true,previewUrls:false,routes:[{pattern:secret}],domains:[{hostname:secret}],deploymentMessage:secret,
 compatibilityDate:'2026-10-10',compatibilityFlagsPresent:true,compatibilityFlags:[],
 observability:{...structuredClone(approvedRemoteBaseline.observability),logs:{...approvedRemoteBaseline.observability.logs,destinations:[secret]}},
 optionalScriptFields:{limits:{present:false},placement_mode:{present:true,value:null},streaming_tail_consumers:{present:true,value:[{service:secret}]}},
 scriptSettings:{logpush:false,tail_consumers:[{service:secret}],observability:{...structuredClone(approvedRemoteBaseline.observability),traces:{...approvedRemoteBaseline.observability.traces,destinations:[secret]}},tags:[secret]},
 bindings:[{name:'DB',type:'d1',id:approvedRemoteBaseline.databaseId},{name:'ACCESS_AUD',type:'plain_text',text:secret},{name:'ACCESS_TEAM_DOMAIN',type:'plain_text',text:secret},{name:'ACCESS_OWNER_EMAIL',type:'secret_text',text:secret},{name:'KEY_ENCRYPTION_KEY_B64',type:'secret_text',text:secret},{name:'ENABLE_LIVE_FREE',type:'plain_text',text:'true'},{name:'ALLOW_PAID_API',type:'plain_text',text:'false'},{name:'SITE_DEPLOYED',type:'plain_text',text:'true'}],
});

test('preflight emits only approved booleans, rates, presence and counts',()=>{
 const output=JSON.stringify(safeRemoteBaselineReport(remote(),{WRANGLER_CI_MATCH_TAG:secret}));
 assert.ok(!output.includes(secret));
 assert.ok(!output.includes(approvedRemoteBaseline.databaseId));
 assert.ok(!output.includes(approvedRemoteBaseline.activeVersionId));
 const report=JSON.parse(output);
 assert.equal(report.metadata.limits.kind,'OMITTED');
 assert.equal(report.metadata.streamingTailConsumers.count,1);
 assert.equal(report.scriptSettings.tailConsumerCount,1);
 assert.equal(report.scriptSettings.observability.logs.persist,true);
 assert.equal(report.scriptSettings.observability.traces.destinationCount,1);
 assert.equal(report.exposure.routeCount,1);
 assert.equal(report.target.buildTagMatched,true);
 assert.equal(report.target.accessVarsValid,false);
 assert.equal(report.scriptSettings.logpushMatchesProposed,true);
 assert.equal(report.scriptSettings.tailConsumersMatchProposed,false);
 assert.equal(report.reviewGateEnabled,true);
 assert.equal(report.diagnosticReadSucceeded,true);
 assert.equal(report.matchesProposedBaseline,false);
 assert.equal(report.mismatchCode,'ROUTES_MISMATCH');
});
test('version diagnostic emits only validated active UUID and source SHA',()=>{
 const state=remote(),sha='a'.repeat(40);state.deploymentMessage='source-commit:'+sha;
 const report=safeRemoteBaselineReport(state,{REMOTE_PREFLIGHT_VERSION_DIAGNOSTIC:'true'});
 assert.deepEqual(report.versionDiagnostic,{activeVersionId:approvedRemoteBaseline.activeVersionId,sourceCommit:sha});
 assert.ok(!JSON.stringify(report).includes(secret));
 state.deploymentMessage=secret;state.activeVersions[0].id=secret;
 assert.deepEqual(safeRemoteBaselineReport(state,{REMOTE_PREFLIGHT_VERSION_DIAGNOSTIC:'true'}).versionDiagnostic,{activeVersionId:'UNAVAILABLE',sourceCommit:'UNAVAILABLE'});
 assert.equal(Object.hasOwn(safeRemoteBaselineReport(state,{}),'versionDiagnostic'),false);
});

test('diagnostic ignores object key order and reports complete, unique bindings separately from review approval',()=>{
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,entry])=>[key,reorder(entry)])):value;
 const state=remote();
 state.routes=[];state.domains=[];
 state.compatibilityFlagsPresent=false;delete state.compatibilityFlags;
 state.observability=reorder(approvedRemoteBaseline.observability);
 state.optionalScriptFields=reorder(approvedRemoteBaseline.optionalScriptFields);
 state.scriptSettings={logpush:false,tail_consumers:null,observability:reorder(approvedRemoteBaseline.scriptSettings.observability)};
 state.bindings.find(item=>item.name==='ACCESS_AUD').text='TEST_AUDIENCE_LONG_ENOUGH';
 state.bindings.find(item=>item.name==='ACCESS_TEAM_DOMAIN').text='https://test.cloudflareaccess.com';
 state.deploymentMessage='source-commit:'+approvedRemoteBaseline.sourceCommit;
 state.bindings.push({name:'ASSETS',type:'assets'});
 const report=safeRemoteBaselineReport(state,{WRANGLER_CI_MATCH_TAG:secret,REMOTE_PREFLIGHT_VERSION_DIAGNOSTIC:'true'});
 assert.deepEqual(report.bindings,{available:true,unique:true,complete:true});
 assert.deepEqual(report.versionDiagnostic,{activeVersionId:approvedRemoteBaseline.activeVersionId,sourceCommit:approvedRemoteBaseline.sourceCommit});
 assert.deepEqual(report.target,{workerMatched:true,productionEnvironment:true,buildTagMatched:true,activeVersionMatchesExpected:true,d1MatchesExpected:true,accessBindingsPresent:true,accessVarsValid:true,runtimeFlagsMatch:true});
 assert.deepEqual(report.exposure,{workersDev:true,previewUrls:false,routeCount:0,domainCount:0});
 assert.equal(report.metadata.compatibilityDateMatchesExpected,true);
 assert.deepEqual(report.metadata.compatibilityFlags,{kind:'OMITTED',count:'OMITTED'});
 assert.equal(report.metadata.compatibilityFlagsMatchExpected,true);
 assert.equal(report.metadata.observability.kind,'OBJECT');
 assert.equal(report.metadata.observability.enabled,true);
 assert.equal(report.metadata.observability.headSamplingRate,1);
 assert.equal(report.metadata.observability.redactQueryString,false);
 assert.equal(report.metadata.observability.logs.kind,'OBJECT');
 assert.equal(report.metadata.observability.logs.enabled,true);
 assert.equal(report.metadata.observability.logs.headSamplingRate,1);
 assert.equal(report.metadata.observability.logs.invocationLogs,true);
 assert.equal(report.metadata.observability.logs.persist,true);
 assert.equal(report.metadata.observability.logs.destinationCount,'OMITTED');
 assert.equal(report.metadata.observability.traces.kind,'OBJECT');
 assert.equal(report.metadata.observability.traces.enabled,false);
 assert.equal(report.metadata.observability.traces.headSamplingRate,1);
 assert.equal(report.metadata.observability.traces.persist,true);
 assert.equal(report.metadata.observability.traces.destinationCount,'OMITTED');
 assert.equal(report.metadata.observability.issues.kind,'OMITTED');
 for(const key of ['limits','placementMode','streamingTailConsumers'])assert.deepEqual(report.metadata[key],{present:false,kind:'OMITTED'});
 assert.equal(report.metadata.observabilityMatchesProposed,true);
 assert.equal(report.metadata.optionalFieldsMatchProposed,true);
 assert.equal(report.scriptSettings.logpush,false);
 assert.equal(report.scriptSettings.logpushMatchesProposed,true);
 assert.equal(report.scriptSettings.tailConsumerCount,'NULL');
 assert.equal(report.scriptSettings.tailConsumersMatchProposed,true);
 assert.deepEqual(report.scriptSettings.observability,report.metadata.observability);
 assert.equal(report.scriptSettings.observabilityMatchesProposed,true);
 assert.equal(report.matchesProposedBaseline,true);
 assert.equal(report.reviewGateEnabled,true);
 for(const mutate of [
  x=>x.bindings.push({...x.bindings[1]}),
  x=>x.bindings.splice(1,1),
  x=>x.bindings.push({name:'PRIVATE_EXTRA',type:'plain_text',text:secret}),
  x=>{x.bindings[1].type='secret_text';},
 ]){
  const changed=structuredClone(state);mutate(changed);
  const result=safeRemoteBaselineReport(changed,{WRANGLER_CI_MATCH_TAG:secret});
  assert.equal(result.bindings.complete,false);
  assert.equal(result.matchesProposedBaseline,false);
  assert.equal(result.mismatchCode,'BINDINGS_UNEXPECTED');
  assert.ok(!JSON.stringify(result).includes(secret));
 }
 const duplicate=structuredClone(state);duplicate.bindings.push({...duplicate.bindings[1]});
 assert.equal(safeRemoteBaselineReport(duplicate).bindings.unique,false);
});

test('diagnostic separates omitted, null and invalid remote fields without exposing values',()=>{
 const omitted=remote();
 omitted.compatibilityFlagsPresent=false;
 delete omitted.compatibilityFlags;
 delete omitted.observability.logs.destinations;
 delete omitted.observability.issues;
 delete omitted.scriptSettings.tail_consumers;
 const missing=safeRemoteBaselineReport(omitted);
 assert.deepEqual(missing.metadata.compatibilityFlags,{kind:'OMITTED',count:'OMITTED'});
 assert.equal(missing.metadata.observability.logs.destinationCount,'OMITTED');
 assert.equal(missing.metadata.observability.issues.kind,'OMITTED');
 assert.equal(missing.scriptSettings.tailConsumerCount,'OMITTED');
 assert.equal(missing.matchesProposedBaseline,false);

 const nulled=remote();
 nulled.compatibilityFlags=null;
 nulled.observability.logs.destinations=null;
 nulled.observability.issues=null;
 nulled.scriptSettings.tail_consumers=null;
 const nullReport=safeRemoteBaselineReport(nulled);
 assert.deepEqual(nullReport.metadata.compatibilityFlags,{kind:'NULL',count:'NULL'});
 assert.equal(nullReport.metadata.observability.logs.destinationCount,'NULL');
 assert.equal(nullReport.metadata.observability.issues.kind,'NULL');
 assert.equal(nullReport.scriptSettings.tailConsumerCount,'NULL');

 const invalid=remote();
 invalid.compatibilityFlags=secret;
 invalid.observability.logs.destinations=secret;
 invalid.observability.issues=secret;
 invalid.scriptSettings.tail_consumers=secret;
 const invalidReport=safeRemoteBaselineReport(invalid);
 assert.deepEqual(invalidReport.metadata.compatibilityFlags,{kind:'INVALID_TYPE',count:'INVALID_TYPE'});
 assert.equal(invalidReport.metadata.observability.logs.destinationCount,'INVALID_TYPE');
 assert.equal(invalidReport.metadata.observability.issues.kind,'INVALID_TYPE');
 assert.equal(invalidReport.scriptSettings.tailConsumerCount,'INVALID_TYPE');
 assert.ok(!JSON.stringify(invalidReport).includes(secret));
});

test('preflight uses only fixed Cloudflare GET endpoints and never logs API data on failure',async()=>{
 const calls=[],output=[];
 const fetcher=async(url,options)=>{
  calls.push({url,method:options.method});
  const path=new URL(url).pathname;
  let result;
  if(path.endsWith('/workers/services/holy-rice-b914'))result={default_environment:{environment:'production',script:{tag:secret}}};
  else if(path.endsWith('/environments/production'))result={script:{compatibility_date:'2026-10-10',observability:remote().observability}};
  else if(path.endsWith('/bindings'))result=remote().bindings;
  else if(path.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
  else if(path.endsWith('/routes'))result=[];
  else if(path.endsWith('/domains/records'))result=[];
  else if(path.endsWith('/deployments'))result={deployments:[{versions:[{version_id:approvedRemoteBaseline.activeVersionId,percentage:100}]}]};
  else if(path.endsWith('/script-settings'))result=remote().scriptSettings;
  else throw Error('unexpected endpoint');
  return {ok:true,json:async()=>({success:true,result})};
 };
 assert.equal(await runRemoteBaselinePreflight({env:{WORKERS_CI:'1',CLOUDFLARE_API_TOKEN:secret,WRANGLER_CI_MATCH_TAG:secret},fetcher,write:value=>output.push(value)}),true);
 assert.equal(calls.length,8);
 assert.ok(calls.every(call=>call.method==='GET'&&call.url.startsWith('https://api.cloudflare.com/client/v4/accounts/')));
 assert.ok(!output.join('').includes(secret));
 assert.deepEqual(JSON.parse(output[0]).metadata.compatibilityFlags,{kind:'OMITTED',count:'OMITTED'});
 const denied=[];
 assert.equal(await runRemoteBaselinePreflight({env:{WORKERS_CI:'1',CLOUDFLARE_API_TOKEN:secret},fetcher:()=>{throw Error(secret);},write:value=>denied.push(value)}),false);
 assert.deepEqual(denied,['REMOTE_BASELINE_PREFLIGHT_FAILED: READ_OR_RESPONSE_INVALID']);
});
