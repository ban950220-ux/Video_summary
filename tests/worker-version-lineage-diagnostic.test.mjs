import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runWorkerVersionLineageDiagnostic,safeWorkerLineageReport} from '../scripts/worker-version-lineage-diagnostic.mjs';
import {approvedRemoteBaseline} from '../scripts/remote-state-policy.mjs';

const priorVersionId='bf955e63-1111-4111-8111-111111111111';
const secret='PRIVATE_SENTINEL_DO_NOT_PRINT';
const sourceMessage=`source-commit:${approvedRemoteBaseline.sourceCommit}`;
const deployments=()=>[
 {versions:[{version_id:approvedRemoteBaseline.activeVersionId,percentage:100}],annotations:{'workers/message':secret,'workers/triggered_by':secret}},
 {versions:[{version_id:priorVersionId,percentage:100}],annotations:{'workers/message':sourceMessage}},
];
const version=(id,hash='a'.repeat(64))=>({id,resources:{script:{etag:hash},bindings:[{name:'ASSETS',type:'assets',secret},{name:'KEY_ENCRYPTION_KEY_B64',type:'secret_text',text:secret}]},metadata:{author_email:secret}});

test('fixed account and versions use only three authenticated GETs and print safe lineage fields',async()=>{
 const calls=[],writes=[];
 const fetcher=async(url,options)=>{
  calls.push({url,method:options.method,authorized:options.headers.Authorization==='Bearer '+secret});
  const result=url.endsWith('/deployments?per_page=100')?{deployments:deployments()}:url.endsWith('/versions/'+approvedRemoteBaseline.activeVersionId)?version(approvedRemoteBaseline.activeVersionId):url.endsWith('/versions/'+priorVersionId)?version(priorVersionId):null;
  assert.ok(result);return {ok:true,json:async()=>({success:true,result})};
 };
 assert.equal(await runWorkerVersionLineageDiagnostic({env:{WORKERS_CI:'true',CLOUDFLARE_API_TOKEN:secret},priorVersionId,fetcher,write:value=>writes.push(value)}),true);
 assert.equal(calls.length,3);assert.ok(calls.every(call=>call.method==='GET'&&call.authorized&&call.url.startsWith('https://api.cloudflare.com/client/v4/accounts/fe9d7e2a164274b1ff6cef150a75cb0b/workers/scripts/holy-rice-b914/')));
 const output=writes.join('\n'),report=JSON.parse(output);assert.ok(!output.includes(secret));assert.equal(report.activeDeploymentSourceAnnotation,'OTHER');assert.equal(report.priorDeploymentSourceAnnotation,'EXPECTED');assert.equal(report.scriptContentEqual,true);assert.equal(report.codeLineageEvidence,'SAME_SCRIPT_AS_ANNOTATED_PRIOR');assert.equal(report.sourceAnnotationGuardMatch,false);assert.equal(report.activeAssetsBindingCount,1);assert.equal(report.assetSetIdentifier,'NOT_EXPOSED_BY_VERSION_GET');
});

test('missing or differing script hashes and annotations never establish lineage',()=>{
 const current=version(approvedRemoteBaseline.activeVersionId),prior=version(priorVersionId);
 let report=safeWorkerLineageReport(deployments(),current,{...prior,resources:{...prior.resources,script:{etag:'b'.repeat(64)}}},priorVersionId);assert.equal(report.scriptContentEqual,false);assert.equal(report.codeLineageEvidence,'UNVERIFIED');
 report=safeWorkerLineageReport(deployments(),{...current,resources:{...current.resources,script:{etag:secret}}},prior,priorVersionId);assert.equal(report.activeScriptEtag,'UNAVAILABLE');assert.equal(report.scriptContentEqual,null);assert.ok(!JSON.stringify(report).includes(secret));
 const missing=deployments();missing.splice(1,1);report=safeWorkerLineageReport(missing,current,prior,priorVersionId);assert.equal(report.priorDeploymentSourceAnnotation,'DEPLOYMENT_NOT_IN_PAGE');assert.equal(report.codeLineageEvidence,'UNVERIFIED');
 const annotated=deployments();annotated[0].annotations['workers/message']=sourceMessage;report=safeWorkerLineageReport(annotated,current,prior,priorVersionId);assert.equal(report.sourceAnnotationGuardMatch,true);
});

test('missing credentials, wrong version, denied API and changed active deployment fail closed without leaking values',async()=>{
 const writes=[],write=value=>writes.push(value),fetcher=async()=>{throw Error(secret);};
 assert.equal(await runWorkerVersionLineageDiagnostic({env:{},priorVersionId,fetcher,write}),false);
 assert.equal(await runWorkerVersionLineageDiagnostic({env:{WORKERS_CI:'true',CLOUDFLARE_API_TOKEN:secret},priorVersionId:'bf955e63',fetcher,write}),false);
 assert.equal(await runWorkerVersionLineageDiagnostic({env:{WORKERS_CI:'true',CLOUDFLARE_API_TOKEN:secret},priorVersionId,fetcher,write}),false);
 const denied=async()=>({ok:false,status:403});assert.equal(await runWorkerVersionLineageDiagnostic({env:{WORKERS_CI:'true',CLOUDFLARE_API_TOKEN:secret},priorVersionId,fetcher:denied,write}),false);
 const wrong=async()=>({ok:true,json:async()=>({success:true,result:{deployments:[{versions:[{version_id:priorVersionId,percentage:100}]}]}})});assert.equal(await runWorkerVersionLineageDiagnostic({env:{WORKERS_CI:'true',CLOUDFLARE_API_TOKEN:secret},priorVersionId,fetcher:wrong,write}),false);
 assert.ok(writes.every(value=>!value.includes(secret)));
});
