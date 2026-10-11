import {approvedRemoteBaseline,assertRemoteState} from './remote-state-policy.mjs';

const accountId='fe9d7e2a164274b1ff6cef150a75cb0b';
const workerName='holy-rice-b914';
const root=`https://api.cloudflare.com/client/v4/accounts/${accountId}`;

export async function readRemoteState({token,fetcher=fetch}={}){
  if(typeof token!=='string'||!token)throw Error('Remote deployment guard: BUILD_TOKEN_UNAVAILABLE');
  async function read(path){
    let response;
    try{response=await fetcher(root+path,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},signal:AbortSignal.timeout(10000)});}
    catch{throw Error('Remote deployment guard: REMOTE_READ_FAILED');}
    if(!response.ok)throw Error('Remote deployment guard: REMOTE_READ_FAILED');
    let body;
    try{body=await response.json();}catch{throw Error('Remote deployment guard: REMOTE_RESPONSE_INVALID');}
    if(body?.success!==true||body.result===undefined)throw Error('Remote deployment guard: REMOTE_RESPONSE_INVALID');
    return body.result;
  }
  const service=await read(`/workers/services/${workerName}`);
  const environment=service?.default_environment?.environment;
  if(environment!=='production')throw Error('Remote deployment guard: WORKER_TARGET_MISMATCH');
  const base=`/workers/services/${workerName}/environments/${environment}`;
  const [metadata,bindings,subdomain,routes,domains,history,scriptSettings]=await Promise.all([
    read(base),read(base+'/bindings'),read(base+'/subdomain'),
    read(base+'/routes?show_zonename=true'),
    read(`/workers/domains/records?page=0&per_page=100&service=${workerName}&environment=${environment}`),
    read(`/workers/scripts/${workerName}/deployments`),
    read(`/workers/scripts/${workerName}/script-settings`),
  ]);
  if(!Array.isArray(bindings)||!Array.isArray(routes)||!Array.isArray(domains)||!Array.isArray(history?.deployments))throw Error('Remote deployment guard: REMOTE_RESPONSE_INVALID');
  const latest=history.deployments[0];
  if(!latest||!Array.isArray(latest.versions))throw Error('Remote deployment guard: REMOTE_RESPONSE_INVALID');
  return {
    workerName,environment,
    activeVersions:latest.versions.map(version=>({id:version.version_id,percentage:version.percentage})),
    workersDev:subdomain?.enabled,previewUrls:subdomain?.previews_enabled,
    routes,domains,
    compatibilityDate:metadata?.script?.compatibility_date,
    compatibilityFlags:metadata?.script?.compatibility_flags,
    observability:metadata?.script?.observability,
    limits:metadata?.script?.limits??null,
    placement:metadata?.script?.placement_mode??null,
    streamingTailConsumers:metadata?.script?.streaming_tail_consumers??[],
    scriptSettings,
    bindings,
  };
}

export async function assertRemoteDeploymentBaseline(options){
  for(let i=0;i<2;i++)assertRemoteState(await readRemoteState(options),approvedRemoteBaseline);
  return true;
}
