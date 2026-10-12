// Workers Builds diagnostic only. All requests are fixed Cloudflare GETs.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {approvedRemoteBaseline} from './remote-state-policy.mjs';

const accountId='fe9d7e2a164274b1ff6cef150a75cb0b';
const workerName='holy-rice-b914';
const apiRoot=`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`;
export const expectedPriorVersionId='bf955e63-0b85-4535-ad39-2858742f89e4';
const etag=/^[0-9a-f]{64}$/i;
const message=`source-commit:${approvedRemoteBaseline.sourceCommit}`;

const annotationKind=value=>value===message?'EXPECTED':value===undefined||value===null?'MISSING':'OTHER';
const safeEtag=value=>typeof value==='string'&&etag.test(value)?value.toLowerCase():null;
const assetBindingCount=value=>Array.isArray(value)?value.filter(item=>item?.name==='ASSETS'&&item?.type==='assets').length:null;

export function safeWorkerLineageReport(deployments,current,prior){
 const latest=deployments?.[0];
 if(!Array.isArray(deployments)||!latest||latest.versions?.length!==1||latest.versions[0]?.version_id!==approvedRemoteBaseline.activeVersionId||latest.versions[0]?.percentage!==100||current?.id!==approvedRemoteBaseline.activeVersionId||prior?.id!==expectedPriorVersionId)throw Error('DIAGNOSTIC_SCOPE_INVALID');
 const oldDeployment=deployments.find(item=>item?.versions?.some(version=>version?.version_id===expectedPriorVersionId&&version?.percentage===100));
 const currentEtag=safeEtag(current.resources?.script?.etag),priorEtag=safeEtag(prior.resources?.script?.etag);
 const currentAssets=assetBindingCount(current.resources?.bindings),priorAssets=assetBindingCount(prior.resources?.bindings);
 const priorAnnotation=oldDeployment?annotationKind(oldDeployment.annotations?.['workers/message']):'DEPLOYMENT_NOT_IN_PAGE';
 return {
  kind:'WORKER_VERSION_LINEAGE_DIAGNOSTIC',readOnly:true,
  activeVersionId:approvedRemoteBaseline.activeVersionId,priorVersionId:expectedPriorVersionId,
  activeDeploymentSourceAnnotation:annotationKind(latest.annotations?.['workers/message']),
  priorDeploymentSourceAnnotation:priorAnnotation,
  activeScriptEtag:currentEtag??'UNAVAILABLE',priorScriptEtag:priorEtag??'UNAVAILABLE',
  scriptContentEqual:currentEtag&&priorEtag?currentEtag===priorEtag:null,
  activeAssetsBindingCount:currentAssets,priorAssetsBindingCount:priorAssets,
  assetSetIdentifier:'NOT_EXPOSED_BY_VERSION_GET',
  codeLineageEvidence:currentEtag&&priorEtag&&currentEtag===priorEtag&&priorAnnotation==='EXPECTED'?'SAME_SCRIPT_AS_ANNOTATED_PRIOR':'UNVERIFIED',
  sourceAnnotationGuardMatch:annotationKind(latest.annotations?.['workers/message'])==='EXPECTED',
 };
}

export async function runWorkerVersionLineageDiagnostic({env=process.env,fetcher=fetch,write=console.log}={}){
 if(!env.WORKERS_CI||!env.CLOUDFLARE_API_TOKEN){write('WORKER_VERSION_DIAGNOSTIC_FAILED: BUILD_CONTEXT_OR_TOKEN_UNAVAILABLE');return false;}
 async function read(path){
  const response=await fetcher(apiRoot+path,{method:'GET',headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,Accept:'application/json'},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('READ_FAILED');
  const body=await response.json();
  if(body?.success!==true||!body.result||typeof body.result!=='object')throw Error('RESPONSE_INVALID');
  return body.result;
 }
 try{
  const deployments=(await read('/deployments?per_page=100')).deployments;
  if(!Array.isArray(deployments)||deployments[0]?.versions?.length!==1||deployments[0]?.versions[0]?.version_id!==approvedRemoteBaseline.activeVersionId||deployments[0]?.versions[0]?.percentage!==100)throw Error('ACTIVE_VERSION_MISMATCH');
  const [current,prior]=await Promise.all([read(`/versions/${approvedRemoteBaseline.activeVersionId}`),read(`/versions/${expectedPriorVersionId}`)]);
  write(JSON.stringify(safeWorkerLineageReport(deployments,current,prior)));
  return true;
 }catch{write('WORKER_VERSION_DIAGNOSTIC_FAILED: READ_OR_SCOPE_INVALID');return false;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==2){console.log('WORKER_VERSION_DIAGNOSTIC_FAILED: ARGUMENTS_NOT_ALLOWED');process.exitCode=1;}
 else if(!await runWorkerVersionLineageDiagnostic())process.exitCode=1;
}
