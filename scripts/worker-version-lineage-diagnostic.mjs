// Workers Builds diagnostic only. All requests are fixed Cloudflare GETs.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {approvedRemoteBaseline,approvedPreDeployLineage,protectedRemoteBaseline,legacyQuoteRecoveryBinding,legacyGroqRecoveryScopeBinding,sameCanonical} from './remote-state-policy.mjs';

export const expectedPriorVersionId=approvedPreDeployLineage.priorVersionId;
const etag=/^[0-9a-f]{64}$/i;
const annotationKind=(value,message)=>value===message?'EXPECTED':value===undefined||value===null?'MISSING':'OTHER';
const safeEtag=value=>typeof value==='string'&&etag.test(value)?value.toLowerCase():null;
const assetBindingCount=value=>Array.isArray(value)?value.filter(item=>item?.name==='ASSETS'&&item?.type==='assets').length:null;
const sourceKind=value=>value==='dash'?'DASHBOARD':value==='wrangler'?'WRANGLER':'OTHER';
function knownBindingAddition(current,prior){
 const present=current.resources?.bindings,original=prior.resources?.bindings;
 if(!Array.isArray(present)||!Array.isArray(original)||present.length!==original.length+1)return false;
 const names=present.map(item=>item?.name),oldNames=original.map(item=>item?.name);
 if(new Set(names).size!==names.length||new Set(oldNames).size!==oldNames.length)return false;
 const added=present.filter(item=>!oldNames.includes(item.name));
 if(added.length!==1)return false;
 const binding=added[0],known=binding.name===legacyQuoteRecoveryBinding&&binding.type==='plain_text'&&typeof binding.text==='string'&&binding.text.length>0||binding.name===legacyGroqRecoveryScopeBinding&&binding.type==='secret_text'&&!Object.hasOwn(binding,'text');
 return known&&sameCanonical(present.filter(item=>item.name!==binding.name).sort((a,b)=>a.name.localeCompare(b.name)),[...original].sort((a,b)=>a.name.localeCompare(b.name)));
}

export function safeWorkerLineageReport(deployments,current,prior,baseline=approvedRemoteBaseline){
 const message=`source-commit:${baseline.sourceCommit}`;
 const expectedPriorVersionId=baseline.priorVersionId;
 const latest=deployments?.[0];
 if(!Array.isArray(deployments)||!latest||latest.versions?.length!==1||latest.versions[0]?.version_id!==baseline.activeVersionId||latest.versions[0]?.percentage!==100||current?.id!==baseline.activeVersionId||prior?.id!==expectedPriorVersionId)throw Error('DIAGNOSTIC_SCOPE_INVALID');
 const oldDeployment=deployments.find(item=>item?.versions?.some(version=>version?.version_id===expectedPriorVersionId&&version?.percentage===100));
 const currentEtag=safeEtag(current.resources?.script?.etag),priorEtag=safeEtag(prior.resources?.script?.etag);
 const currentAssets=assetBindingCount(current.resources?.bindings),priorAssets=assetBindingCount(prior.resources?.bindings);
 const priorAnnotation=oldDeployment?annotationKind(oldDeployment.annotations?.['workers/message'],message):'DEPLOYMENT_NOT_IN_PAGE';
 const runtimeMetadataEqual=Boolean(current.resources?.script_runtime&&prior.resources?.script_runtime&&sameCanonical(current.resources.script_runtime,prior.resources.script_runtime));
 const bindingAddition=knownBindingAddition(current,prior),pinnedEtag=Boolean(currentEtag&&priorEtag&&currentEtag===baseline.scriptEtag&&priorEtag===baseline.scriptEtag);
 const provenance=sourceKind(latest.source)==='DASHBOARD'&&sourceKind(oldDeployment?.source)==='WRANGLER';
 const sameKnownLineage=Boolean(pinnedEtag&&priorAnnotation==='EXPECTED'&&annotationKind(latest.annotations?.['workers/message'],message)==='OTHER'&&provenance&&runtimeMetadataEqual&&bindingAddition&&currentAssets===1&&priorAssets===1);
 return {
  kind:'WORKER_VERSION_LINEAGE_DIAGNOSTIC',readOnly:true,
  activeVersionMatched:true,priorVersionMatched:true,
  activeDeploymentSourceAnnotation:annotationKind(latest.annotations?.['workers/message'],message),
  priorDeploymentSourceAnnotation:priorAnnotation,activeDeploymentSource:sourceKind(latest.source),priorDeploymentSource:sourceKind(oldDeployment?.source),
  scriptEtagMatchesPinned:pinnedEtag,
  scriptContentEqual:currentEtag&&priorEtag?currentEtag===priorEtag:null,
  runtimeMetadataEqual,knownBindingAddition:bindingAddition,
  activeAssetsBindingCount:currentAssets,priorAssetsBindingCount:priorAssets,
  assetSetIdentifier:'NOT_EXPOSED_BY_VERSION_GET',
  codeLineageEvidence:sameKnownLineage?'SAME_SCRIPT_AND_SETTINGS_AS_ANNOTATED_PRIOR':'UNVERIFIED',
  sourceAnnotationGuardMatch:annotationKind(latest.annotations?.['workers/message'],message)==='EXPECTED',
 };
}

export async function readWorkerVersionLineage({token,fetcher=fetch,baseline=protectedRemoteBaseline()}={}){
 if(!/^[0-9a-f]{32}$/i.test(baseline?.accountId??'')||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(baseline?.workerName??'')||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(baseline?.priorVersionId??''))throw Error('WORKER_VERSION_DIAGNOSTIC_FAILED: TARGET_INVALID');
 const apiRoot=`https://api.cloudflare.com/client/v4/accounts/${baseline.accountId}/workers/scripts/${baseline.workerName}`;
 if(typeof token!=='string'||!token)throw Error('WORKER_VERSION_DIAGNOSTIC_FAILED: TOKEN_UNAVAILABLE');
 async function read(path){
  const response=await fetcher(apiRoot+path,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('READ_FAILED');
  const body=await response.json();
  if(body?.success!==true||!body.result||typeof body.result!=='object')throw Error('RESPONSE_INVALID');
  return body.result;
 }
 const deployments=(await read('/deployments?per_page=100')).deployments;
 if(!Array.isArray(deployments)||deployments[0]?.versions?.length!==1||deployments[0]?.versions[0]?.version_id!==baseline.activeVersionId||deployments[0]?.versions[0]?.percentage!==100)throw Error('ACTIVE_VERSION_MISMATCH');
 const [current,prior]=await Promise.all([read(`/versions/${baseline.activeVersionId}`),read(`/versions/${baseline.priorVersionId}`)]);
 return safeWorkerLineageReport(deployments,current,prior,baseline);
}

export async function runWorkerVersionLineageDiagnostic({env=process.env,fetcher=fetch,write=console.log}={}){
 if(!env.WORKERS_CI||!env.CLOUDFLARE_API_TOKEN){write('WORKER_VERSION_DIAGNOSTIC_FAILED: BUILD_CONTEXT_OR_TOKEN_UNAVAILABLE');return false;}
 try{
  write(JSON.stringify(await readWorkerVersionLineage({token:env.CLOUDFLARE_API_TOKEN,fetcher,baseline:protectedRemoteBaseline(env)})));
  return true;
 }catch{write('WORKER_VERSION_DIAGNOSTIC_FAILED: READ_OR_SCOPE_INVALID');return false;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==2){console.log('WORKER_VERSION_DIAGNOSTIC_FAILED: ARGUMENTS_NOT_ALLOWED');process.exitCode=1;}
 else if(!await runWorkerVersionLineageDiagnostic())process.exitCode=1;
}
