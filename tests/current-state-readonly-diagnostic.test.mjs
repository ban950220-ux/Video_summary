import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {runCurrentStateReadonlyDiagnostic} from '../scripts/current-state-readonly-diagnostic.mjs';
import {approvedRemoteBaseline} from '../scripts/remote-state-policy.mjs';

const root=resolve(import.meta.dirname,'..'),token='TOKEN_DO_NOT_PRINT',secret='PRIVATE_VALUE_DO_NOT_PRINT';
const target={accountId:'fe9d7e2a164274b1ff6cef150a75cb0b',workerName:'holy-rice-b914',databaseId:'d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34',active:'a1aa62cf-1ecb-4f51-9cd9-c8823f4e2167',prior:'283c647e-8618-4c9d-9c66-450deebee143',source:'60272937664175cb2c124999cd780f8a5237d9ab',etag:'281ae5cbbe50917708f3c6a81616c89e23f5c416651a88495c7b013438857b6f'};
const bindings=()=>[
 ...Object.entries(approvedRemoteBaseline.runtimeFlags).map(([name,text])=>({name,type:'plain_text',text})),
 {name:'DB',type:'d1',id:target.databaseId},{name:'ASSETS',type:'assets'},
 {name:'ACCESS_AUD',type:'plain_text',text:'test-audience-value'},
 {name:'ACCESS_TEAM_DOMAIN',type:'plain_text',text:'https://test.cloudflareaccess.com'},
 ...['ACCESS_OWNER_EMAIL','KEY_ENCRYPTION_KEY_B64','ENABLE_GEMINI_TWO_PASS','GEMINI_TWO_PASS_ALLOWED_JOB_ID','GROQ_LEGACY_RECOVERY_SCOPE_JSON'].map(name=>({name,type:'secret_text'})),
 {name:'GEMINI_LEGACY_QUOTE_RECOVERY_JSON',type:'plain_text',text:secret},
];
function mock({placement='omitted',failPath=null}={}){
 const calls=[],metadata={script:{compatibility_date:approvedRemoteBaseline.compatibilityDate,observability:approvedRemoteBaseline.observability}};
 if(placement!=='omitted')metadata.script.placement_mode=placement;
 const deployments={deployments:[
  {source:'dash',versions:[{version_id:target.active,percentage:100}],annotations:{'workers/message':secret}},
  {source:'wrangler',versions:[{version_id:target.prior,percentage:100}],annotations:{'workers/message':'source-commit:'+target.source}},
 ]};
 const version=id=>({id,resources:{script:{etag:target.etag},script_runtime:{compatibility_date:'2026-10-10',usage_model:'standard'},bindings:[{name:'ASSETS',type:'assets'}]}});
 const fetcher=async(url,options)=>{
  calls.push({url,method:options.method,auth:options.headers.Authorization});
  assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer '+token);
  if(failPath&&url.includes(failPath))return {ok:false,status:403};
  let result;
  if(url.endsWith('/workers/services/'+target.workerName))result={default_environment:{environment:'production',script:{tag:secret}}};
  else if(url.endsWith('/environments/production'))result=metadata;
  else if(url.endsWith('/bindings'))result=bindings();
  else if(url.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
  else if(url.includes('/routes?')||url.includes('/workers/domains/records?'))result=[];
  else if(url.endsWith('/script-settings'))result=approvedRemoteBaseline.scriptSettings;
  else if(url.endsWith('/deployments')||url.includes('/deployments?'))result=deployments;
  else if(url.endsWith('/versions/'+target.active))result=version(target.active);
  else if(url.endsWith('/versions/'+target.prior))result=version(target.prior);
  else throw Error('unexpected endpoint');
  return {ok:true,json:async()=>({success:true,result})};
 };
 return {calls,fetcher};
}

test('diagnostic performs only eleven fixed GETs and emits a sanitized fingerprint and local asset digest',async()=>{
 const {calls,fetcher}=mock(),output=[];
 assert.equal(await runCurrentStateReadonlyDiagnostic({env:{CLOUDFLARE_API_TOKEN:token,WORKERS_CI:'true',WORKERS_CI_BRANCH:'main',WORKERS_CI_COMMIT_SHA:'f'.repeat(40),GROQ_CURRENT_STATE_REPLACEMENT_JSON:'unapproved'},fetcher,write:x=>output.push(x),root}),true);
 const base=`https://api.cloudflare.com/client/v4/accounts/${target.accountId}`;
 assert.deepEqual(calls.map(item=>item.url).sort(),[
  `/workers/services/${target.workerName}`,`/workers/services/${target.workerName}/environments/production`,
  `/workers/services/${target.workerName}/environments/production/bindings`,
  `/workers/services/${target.workerName}/environments/production/subdomain`,
  `/workers/services/${target.workerName}/environments/production/routes?show_zonename=true`,
  `/workers/domains/records?page=0&per_page=100&service=${target.workerName}&environment=production`,
  `/workers/scripts/${target.workerName}/deployments`,
  `/workers/scripts/${target.workerName}/script-settings`,
  `/workers/scripts/${target.workerName}/deployments?per_page=100`,
  `/workers/scripts/${target.workerName}/versions/${target.active}`,
  `/workers/scripts/${target.workerName}/versions/${target.prior}`,
 ].map(path=>base+path).sort());
 assert.ok(calls.every(item=>item.method==='GET'));
 const rendered=output.join('\n'),report=JSON.parse(rendered);
 for(const value of [token,secret,target.accountId,target.databaseId,target.active,target.prior,target.etag,target.source])assert.ok(!rendered.includes(value));
 assert.match(report.remoteFingerprint,/^[0-9a-f]{64}$/);assert.match(report.assetManifestDigest,/^[0-9a-f]{64}$/);
 assert.equal(report.policyMismatch,null);assert.equal(report.target.activeVersionMatched,true);assert.equal(report.target.databaseMatched,true);assert.equal(report.target.recoveryScopeBindingPresent,true);
 assert.equal(report.scopeValueEquality,'UNVERIFIED');assert.equal(report.lineage.assetSetIdentifier,'NOT_EXPOSED_BY_VERSION_GET');
});

test('fingerprint and safe metadata distinguish omitted and null fields',async()=>{
 const results=[];
 for(const placement of ['omitted',null]){
  const {fetcher}=mock({placement}),output=[];
  assert.equal(await runCurrentStateReadonlyDiagnostic({env:{CLOUDFLARE_API_TOKEN:token},fetcher,write:x=>output.push(x),root}),true);
  results.push(JSON.parse(output[0]));
 }
 assert.equal(results[0].metadata.placementMode.kind,'OMITTED');
 assert.equal(results[1].metadata.placementMode.kind,'NULL');
 assert.notEqual(results[0].remoteFingerprint,results[1].remoteFingerprint);
 assert.equal(results[1].policyMismatch,'SCRIPT_SETTINGS_MISMATCH');
});

test('missing token and failed GET stop with fixed text and no raw response',async()=>{
 const noToken=[],bad=mock({failPath:'/bindings'}),failed=[];
 assert.equal(await runCurrentStateReadonlyDiagnostic({env:{},fetcher:()=>{throw Error('must not run');},write:x=>noToken.push(x),root}),false);
 assert.deepEqual(noToken,['CURRENT_STATE_READONLY_DIAGNOSTIC_FAILED: TOKEN_UNAVAILABLE']);
 assert.equal(await runCurrentStateReadonlyDiagnostic({env:{CLOUDFLARE_API_TOKEN:token},fetcher:bad.fetcher,write:x=>failed.push(x),root}),false);
 assert.deepEqual(failed,['CURRENT_STATE_READONLY_DIAGNOSTIC_FAILED: READ_OR_RESPONSE_INVALID']);
 assert.ok(!failed.join('').includes(token));assert.ok(!failed.join('').includes(secret));
});
