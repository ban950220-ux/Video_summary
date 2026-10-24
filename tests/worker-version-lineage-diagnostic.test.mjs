import {test} from 'node:test';
import assert from 'node:assert/strict';
import {expectedPriorVersionId,runWorkerVersionLineageDiagnostic,safeWorkerLineageReport} from '../scripts/worker-version-lineage-diagnostic.mjs';
import {approvedRemoteBaseline,approvedPreDeployLineage,protectedRemoteBaseline} from '../scripts/remote-state-policy.mjs';
import {geminiPaidFlagNames} from '../scripts/gemini-paid-activation.mjs';
import {assertRemoteDeploymentBaseline} from '../scripts/read-remote-state.mjs';

const priorVersionId=approvedPreDeployLineage.priorVersionId;
const reviewEnv={GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify({kind:'REMOTE_DEPLOYMENT_REVIEW_V1',accountId:approvedRemoteBaseline.accountId,workerName:approvedRemoteBaseline.workerName,databaseId:approvedRemoteBaseline.databaseId,activeVersionId:approvedRemoteBaseline.activeVersionId,priorVersionId,scriptEtag:approvedRemoteBaseline.scriptEtag,sourceCommit:approvedRemoteBaseline.sourceCommit,reviewedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()})};
const secret='PRIVATE_SENTINEL_DO_NOT_PRINT';
const sourceMessage=`source-commit:${approvedRemoteBaseline.sourceCommit}`;
const deployments=()=>[
 {source:'dash',versions:[{version_id:approvedRemoteBaseline.activeVersionId,percentage:100}],annotations:{'workers/message':secret,'workers/triggered_by':secret}},
 {source:'wrangler',versions:[{version_id:priorVersionId,percentage:100}],annotations:{'workers/message':sourceMessage}},
];
const version=(id,hash=approvedPreDeployLineage.scriptEtag)=>({id,resources:{script:{etag:hash},script_runtime:{assets:{binding:'ASSETS'},compatibility_date:'2026-10-10',usage_model:'standard'},bindings:[{name:'ASSETS',type:'assets',secret},{name:'KEY_ENCRYPTION_KEY_B64',type:'secret_text',text:secret},...(id===approvedRemoteBaseline.activeVersionId?[{name:'GEMINI_LEGACY_QUOTE_RECOVERY_JSON',type:'plain_text',text:secret}]:[])]},metadata:{author_email:secret}});

test('fixed account and versions use only three authenticated GETs and print safe lineage fields',async()=>{
 assert.equal(expectedPriorVersionId,priorVersionId);
 const calls=[],writes=[];
 const fetcher=async(url,options)=>{
  calls.push({url,method:options.method,authorized:options.headers.Authorization==='Bearer '+secret});
  const result=url.endsWith('/deployments?per_page=100')?{deployments:deployments()}:url.endsWith('/versions/'+approvedRemoteBaseline.activeVersionId)?version(approvedRemoteBaseline.activeVersionId):url.endsWith('/versions/'+priorVersionId)?version(priorVersionId):null;
  assert.ok(result);return {ok:true,json:async()=>({success:true,result})};
 };
 assert.equal(await runWorkerVersionLineageDiagnostic({env:{...reviewEnv,WORKERS_CI:'true',CLOUDFLARE_API_TOKEN:secret},fetcher,write:value=>writes.push(value)}),true);
 assert.equal(calls.length,3);assert.ok(calls.every(call=>call.method==='GET'&&call.authorized&&call.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${approvedRemoteBaseline.accountId}/workers/scripts/${approvedRemoteBaseline.workerName}/`)));
 const output=writes.join('\n'),report=JSON.parse(output);assert.ok(!output.includes(secret));assert.ok(!output.includes(approvedPreDeployLineage.scriptEtag));assert.ok(!output.includes(approvedRemoteBaseline.activeVersionId));assert.ok(!output.includes(priorVersionId));assert.equal(report.activeDeploymentSourceAnnotation,'OTHER');assert.equal(report.priorDeploymentSourceAnnotation,'EXPECTED');assert.equal(report.activeDeploymentSource,'DASHBOARD');assert.equal(report.priorDeploymentSource,'WRANGLER');assert.equal(report.scriptEtagMatchesPinned,true);assert.equal(report.scriptContentEqual,true);assert.equal(report.runtimeMetadataEqual,true);assert.equal(report.knownBindingAddition,true);assert.equal(report.codeLineageEvidence,'SAME_SCRIPT_AND_SETTINGS_AS_ANNOTATED_PRIOR');assert.equal(report.sourceAnnotationGuardMatch,false);assert.equal(report.activeAssetsBindingCount,1);assert.equal(report.assetSetIdentifier,'NOT_EXPOSED_BY_VERSION_GET');
});

test('real pre-deploy guard consumes the encrypted-scope lineage evidence on both reads',async()=>{
 const b=approvedRemoteBaseline,calls=[],bindings=[...Object.entries(b.runtimeFlags).map(([name,text])=>({name,text,type:'plain_text'})),
  {name:'DB',type:'d1',id:b.databaseId},{name:'ASSETS',type:'assets'},
  {name:'ACCESS_AUD',type:'plain_text',text:'test-audience-value'},{name:'ACCESS_TEAM_DOMAIN',type:'plain_text',text:'https://test.cloudflareaccess.com'},
  ...['ACCESS_OWNER_EMAIL','KEY_ENCRYPTION_KEY_B64','ENABLE_GEMINI_TWO_PASS','GEMINI_TWO_PASS_ALLOWED_JOB_ID','GROQ_LEGACY_RECOVERY_SCOPE_JSON'].map(name=>({name,type:'secret_text'})),
  {name:'GEMINI_LEGACY_QUOTE_RECOVERY_JSON',type:'plain_text',text:secret}];
 const current=version(b.activeVersionId);current.resources.bindings=current.resources.bindings.filter(x=>x.name!=='GEMINI_LEGACY_QUOTE_RECOVERY_JSON');current.resources.bindings.push({name:'GROQ_LEGACY_RECOVERY_SCOPE_JSON',type:'secret_text'});
 const fetcher=async(url,options)=>{
  calls.push(options.method);let result;
  if(url.endsWith('/workers/services/'+b.workerName))result={default_environment:{environment:'production',script:{tag:'expected-tag'}}};
  else if(url.endsWith('/environments/production'))result={script:{compatibility_date:b.compatibilityDate,observability:b.observability}};
  else if(url.endsWith('/bindings'))result=bindings;
  else if(url.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
  else if(url.includes('/routes?')||url.includes('/workers/domains/records?'))result=[];
  else if(url.endsWith('/script-settings'))result=b.scriptSettings;
  else if(url.includes('/deployments'))result={deployments:deployments()};
  else if(url.endsWith('/versions/'+b.activeVersionId))result=current;
  else if(url.endsWith('/versions/'+priorVersionId))result=version(priorVersionId);
  else throw Error('unexpected mock request');
  return {ok:true,json:async()=>({success:true,result})};
 };
 const result=await assertRemoteDeploymentBaseline({token:secret,baseline:b,ciMatchTag:'expected-tag',fetcher});
 assert.equal(result.activeVersions[0].id,b.activeVersionId);assert.equal(calls.length,22);assert.ok(calls.every(method=>method==='GET'));
 current.resources.script_runtime={};
 await assert.rejects(assertRemoteDeploymentBaseline({token:secret,baseline:b,ciMatchTag:'expected-tag',fetcher}),/SOURCE_COMMIT_MISMATCH/);
});

test('one encrypted Groq scope addition preserves exact code and all prior bindings',()=>{
 const current=version(approvedRemoteBaseline.activeVersionId),prior=version(priorVersionId);
 current.resources.bindings=current.resources.bindings.filter(item=>item.name!=='GEMINI_LEGACY_QUOTE_RECOVERY_JSON');
 current.resources.bindings.push({name:'GROQ_LEGACY_RECOVERY_SCOPE_JSON',type:'secret_text'});
 assert.equal(safeWorkerLineageReport(deployments(),current,prior).codeLineageEvidence,'SAME_SCRIPT_AND_SETTINGS_AS_ANNOTATED_PRIOR');
 const wrongType=structuredClone(current);wrongType.resources.bindings.at(-1).type='plain_text';assert.equal(safeWorkerLineageReport(deployments(),wrongType,prior).knownBindingAddition,false);
 const exposed=structuredClone(current);exposed.resources.bindings.at(-1).text=secret;assert.equal(safeWorkerLineageReport(deployments(),exposed,prior).knownBindingAddition,false);
 const altered=structuredClone(current);altered.resources.bindings[0].secret='changed';assert.equal(safeWorkerLineageReport(deployments(),altered,prior).knownBindingAddition,false);
 const extra=structuredClone(current);extra.resources.bindings.push({name:'OTHER',type:'secret_text'});assert.equal(safeWorkerLineageReport(deployments(),extra,prior).knownBindingAddition,false);
});

test('missing or differing script hashes and annotations never establish lineage',()=>{
 const current=version(approvedRemoteBaseline.activeVersionId),prior=version(priorVersionId);
 let report=safeWorkerLineageReport(deployments(),current,{...prior,resources:{...prior.resources,script:{etag:'b'.repeat(64)}}});assert.equal(report.scriptContentEqual,false);assert.equal(report.codeLineageEvidence,'UNVERIFIED');
 report=safeWorkerLineageReport(deployments(),{...current,resources:{...current.resources,script:{etag:secret}}},prior);assert.equal(report.scriptEtagMatchesPinned,false);assert.equal(report.scriptContentEqual,null);assert.ok(!JSON.stringify(report).includes(secret));
 const missing=deployments();missing.splice(1,1);report=safeWorkerLineageReport(missing,current,prior);assert.equal(report.priorDeploymentSourceAnnotation,'DEPLOYMENT_NOT_IN_PAGE');assert.equal(report.codeLineageEvidence,'UNVERIFIED');
 const annotated=deployments();annotated[0].annotations['workers/message']=sourceMessage;report=safeWorkerLineageReport(annotated,current,prior);assert.equal(report.sourceAnnotationGuardMatch,true);
 const added=structuredClone(current);added.resources.bindings.push({name:'UNEXPECTED',type:'plain_text',text:secret});assert.equal(safeWorkerLineageReport(deployments(),added,prior).knownBindingAddition,false);
 const altered=structuredClone(current);altered.resources.bindings[0].secret='changed';assert.equal(safeWorkerLineageReport(deployments(),altered,prior).knownBindingAddition,false);
 const runtime=structuredClone(current);runtime.resources.script_runtime.compatibility_date='2026-10-11';assert.equal(safeWorkerLineageReport(deployments(),runtime,prior).runtimeMetadataEqual,false);
 const wrongSource=deployments();wrongSource[0].source='wrangler';assert.equal(safeWorkerLineageReport(wrongSource,current,prior).codeLineageEvidence,'UNVERIFIED');
 assert.throws(()=>safeWorkerLineageReport(deployments(),current,{...prior,id:'55555555-5555-4555-8555-555555555555'}),/DIAGNOSTIC_SCOPE_INVALID/);
});

test('lineage compares annotations to the protected source commit',()=>{
 const baseline={...approvedRemoteBaseline,sourceCommit:'b'.repeat(40)};
 const history=deployments();history[1].annotations['workers/message']=`source-commit:${baseline.sourceCommit}`;
 const report=safeWorkerLineageReport(history,version(baseline.activeVersionId),version(baseline.priorVersionId),baseline);
 assert.equal(report.priorDeploymentSourceAnnotation,'EXPECTED');
 assert.equal(report.codeLineageEvidence,'SAME_SCRIPT_AND_SETTINGS_AS_ANNOTATED_PRIOR');
 assert.equal(report.sourceAnnotationGuardMatch,false);
});

test('missing credentials, denied API and changed active deployment fail closed without leaking values',async()=>{
 const writes=[],write=value=>writes.push(value),fetcher=async()=>{throw Error(secret);};
 assert.equal(await runWorkerVersionLineageDiagnostic({env:{},fetcher,write}),false);
 assert.equal(await runWorkerVersionLineageDiagnostic({env:{...reviewEnv,WORKERS_CI:'true',CLOUDFLARE_API_TOKEN:secret},fetcher,write}),false);
 const denied=async()=>({ok:false,status:403});assert.equal(await runWorkerVersionLineageDiagnostic({env:{...reviewEnv,WORKERS_CI:'true',CLOUDFLARE_API_TOKEN:secret},fetcher:denied,write}),false);
 const wrong=async()=>({ok:true,json:async()=>({success:true,result:{deployments:[{versions:[{version_id:priorVersionId,percentage:100}]}]}})});assert.equal(await runWorkerVersionLineageDiagnostic({env:{...reviewEnv,WORKERS_CI:'true',CLOUDFLARE_API_TOKEN:secret},fetcher:wrong,write}),false);
 assert.ok(writes.every(value=>!value.includes(secret)));
});

 test('absent, empty and malformed runtime metadata never establishes lineage',()=>{
 const invalid=[undefined,null,{},[],true,'runtime',{compatibility_date:'2026-10-10'},{usage_model:'standard'},
 {compatibility_date:'',usage_model:'standard'},{compatibility_date:'2026-02-30',usage_model:'standard'},
 {compatibility_date:'2026-10-10',usage_model:' '},{compatibility_date:'2026-10-10',usage_model:[]},
 {compatibility_date:'2026-10-10',usage_model:'standard',compatibility_flags:null},
 {compatibility_date:'2026-10-10',usage_model:'standard',compatibility_flags:[1]}];
 for(const value of invalid){
  for(const side of ['current','prior','both']){
   const current=version(approvedRemoteBaseline.activeVersionId),prior=version(priorVersionId);
   if(side!=='prior')current.resources.script_runtime=value;
   if(side!=='current')prior.resources.script_runtime=value;
   const report=safeWorkerLineageReport(deployments(),current,prior);
   assert.equal(report.runtimeMetadataComplete,false);
   assert.equal(report.runtimeMetadataEqual,false);
   assert.equal(report.codeLineageEvidence,'UNVERIFIED');
  }
 }
 });
 test('complete runtime comparison preserves optional field presence and all settings',()=>{
 const current=version(approvedRemoteBaseline.activeVersionId),prior=version(priorVersionId);
 assert.equal(safeWorkerLineageReport(deployments(),current,prior).runtimeMetadataComplete,true);
 current.resources.script_runtime.compatibility_flags=[];
 assert.equal(safeWorkerLineageReport(deployments(),current,prior).runtimeMetadataEqual,false);
 prior.resources.script_runtime.compatibility_flags=[];
 assert.equal(safeWorkerLineageReport(deployments(),current,prior).runtimeMetadataEqual,true);
 current.resources.script_runtime.extra_setting=false;
 assert.equal(safeWorkerLineageReport(deployments(),current,prior).runtimeMetadataEqual,false);
 });

test('Dashboard lineage accepts only the reviewed exact paid three-binding addition',()=>{
 const b=protectedRemoteBaseline({GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify({...JSON.parse(reviewEnv.GROQ_DEPLOYMENT_EVIDENCE_JSON),geminiTwoPassPaidEnabled:true})});
 const prior=version(priorVersionId),current=version(b.activeVersionId);
 current.resources.bindings=[...structuredClone(prior.resources.bindings),...geminiPaidFlagNames.map(name=>({name,type:'plain_text',text:'true'}))];
 assert.equal(safeWorkerLineageReport(deployments(),current,prior,b).codeLineageEvidence,'SAME_SCRIPT_AND_SETTINGS_AS_ANNOTATED_PRIOR');
 assert.equal(safeWorkerLineageReport(deployments(),current,prior).knownBindingAddition,false);
 for(const mutate of [
  x=>x.resources.bindings.pop(),
  x=>x.resources.bindings.splice(-2),
  x=>x.resources.bindings.push({name:'EXTRA',type:'plain_text',text:'true'}),
  x=>{x.resources.bindings.at(-1).text='false';},
  x=>{x.resources.bindings.at(-1).text=true;},
  x=>{x.resources.bindings.at(-1).type='secret_text';},
  x=>x.resources.bindings.push({...x.resources.bindings.at(-1)}),
  x=>{x.resources.bindings[0].secret='CHANGED';},
  x=>x.resources.bindings.shift(),
 ]){const changed=structuredClone(current);mutate(changed);assert.equal(safeWorkerLineageReport(deployments(),changed,prior,b).knownBindingAddition,false);}
 for(const mutate of [
  x=>{x.resources.script.etag='b'.repeat(64);},
  x=>{x.resources.script_runtime.usage_model='changed';},
 ]){const changed=structuredClone(current);mutate(changed);assert.equal(safeWorkerLineageReport(deployments(),changed,prior,b).codeLineageEvidence,'UNVERIFIED');}
 const wrong=deployments();wrong[1].source='dash';assert.equal(safeWorkerLineageReport(wrong,current,prior,b).codeLineageEvidence,'UNVERIFIED');
 const missing=deployments().slice(0,1);assert.equal(safeWorkerLineageReport(missing,current,prior,b).codeLineageEvidence,'UNVERIFIED');
 assert.throws(()=>safeWorkerLineageReport(deployments(),current,prior,{...b,deploymentEvidenceExpiresAt:new Date(Date.now()-1000).toISOString()}),/DEPLOYMENT_EVIDENCE_EXPIRED/);
});

test('real pre-deploy reads accept the reviewed paid Dashboard delta and reject a changed existing binding',async()=>{
 const b=protectedRemoteBaseline({GROQ_DEPLOYMENT_EVIDENCE_JSON:JSON.stringify({...JSON.parse(reviewEnv.GROQ_DEPLOYMENT_EVIDENCE_JSON),geminiTwoPassPaidEnabled:true})});
 const bindings=[...Object.entries(b.runtimeFlags).map(([name,text])=>({name,text,type:'plain_text'})),
  {name:'DB',type:'d1',id:b.databaseId},{name:'ASSETS',type:'assets'},
  {name:'ACCESS_AUD',type:'plain_text',text:'test-audience-value'},{name:'ACCESS_TEAM_DOMAIN',type:'plain_text',text:'https://test.cloudflareaccess.com'},
  ...['ACCESS_OWNER_EMAIL','KEY_ENCRYPTION_KEY_B64','ENABLE_GEMINI_TWO_PASS','GEMINI_TWO_PASS_ALLOWED_JOB_ID'].map(name=>({name,type:'secret_text'})),
  {name:'GEMINI_LEGACY_QUOTE_RECOVERY_JSON',type:'plain_text',text:secret}];
 const prior=version(priorVersionId);prior.resources.bindings=structuredClone(bindings);
 bindings.push(...geminiPaidFlagNames.map(name=>({name,type:'plain_text',text:'true'})));
 const current=version(b.activeVersionId);current.resources.bindings=structuredClone(bindings);
 const calls=[],fetcher=async(url,options)=>{
  calls.push(options.method);let result;
  if(url.endsWith('/workers/services/'+b.workerName))result={default_environment:{environment:'production',script:{tag:'expected-tag'}}};
  else if(url.endsWith('/environments/production'))result={script:{compatibility_date:b.compatibilityDate,observability:b.observability}};
  else if(url.endsWith('/bindings'))result=bindings;
  else if(url.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
  else if(url.includes('/routes?')||url.includes('/workers/domains/records?'))result=[];
  else if(url.endsWith('/script-settings'))result=b.scriptSettings;
  else if(url.includes('/deployments'))result={deployments:deployments()};
  else if(url.endsWith('/versions/'+b.activeVersionId))result=current;
  else if(url.endsWith('/versions/'+priorVersionId))result=prior;
  else throw Error('unexpected fixture endpoint');
  return {ok:true,json:async()=>({success:true,result})};
 };
 const result=await assertRemoteDeploymentBaseline({token:secret,baseline:b,ciMatchTag:'expected-tag',fetcher});
 assert.equal(result.activeVersions[0].id,b.activeVersionId);assert.equal(calls.length,22);assert.ok(calls.every(method=>method==='GET'));
 current.resources.bindings.find(x=>x.name==='ACCESS_AUD').text='changed-audience';
 await assert.rejects(assertRemoteDeploymentBaseline({token:secret,baseline:b,ciMatchTag:'expected-tag',fetcher}),/SOURCE_COMMIT_MISMATCH/);
});
