import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const accountId='fe9d7e2a164274b1ff6cef150a75cb0b';
const workerName='holy-rice-b914';
const allowedOverrides=new Set(['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','WRANGLER_CI_OVERRIDE_NAME']);

export function deploymentEnvironment(input){
  for(const key of Object.keys(input)){
    if(/^(?:CLOUDFLARE_|CF_|WRANGLER_)/.test(key)&&!allowedOverrides.has(key))throw Error(`Production deploy: ENV_OVERRIDE_BLOCKED: ${key}`);
  }
  if(!input.CLOUDFLARE_API_TOKEN)throw Error('Production deploy: BUILD_TOKEN_UNAVAILABLE');
  if(input.CLOUDFLARE_ACCOUNT_ID&&input.CLOUDFLARE_ACCOUNT_ID!==accountId)throw Error('Production deploy: ACCOUNT_MISMATCH');
  if(input.WRANGLER_CI_OVERRIDE_NAME&&input.WRANGLER_CI_OVERRIDE_NAME!==workerName)throw Error('Production deploy: WORKER_NAME_MISMATCH');
  return {
    PATH:input.PATH||'/usr/bin:/bin',
    HOME:input.HOME||'/tmp',
    TMPDIR:input.TMPDIR||'/tmp',
    CI:'true',WORKERS_CI:input.WORKERS_CI,
    WORKERS_CI_BRANCH:input.WORKERS_CI_BRANCH,
    WORKERS_CI_COMMIT_SHA:input.WORKERS_CI_COMMIT_SHA,
    CLOUDFLARE_API_TOKEN:input.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID:accountId,
    WRANGLER_CI_OVERRIDE_NAME:input.WRANGLER_CI_OVERRIDE_NAME,
    WRANGLER_LOG:'error',WRANGLER_LOG_SANITIZE:'true',
    WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false',
  };
}

// Wrangler's raw remote diff can contain dashboard-only Access values. Never relay
// its stdout/stderr or write its debug stream to the Build console or disk.
export function runWranglerSafely(node,wrangler,cwd,environment,sourceCommit,spawn=spawnSync){
  if(!/^[0-9a-f]{40}$/.test(sourceCommit))throw Error('Production deploy: SOURCE_COMMIT_INVALID');
  const directory=mkdtempSync(join(tmpdir(),'yta-wrangler-output-'));
  const outputPath=join(directory,'result.jsonl');
  try{
    const result=spawn(node,[wrangler,'deploy','--config','wrangler.toml','--name',workerName,'--keep-vars','--message',`source-commit:${sourceCommit}`],{
      cwd,env:{...environment,WRANGLER_OUTPUT_FILE_PATH:outputPath},
      stdio:['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:8*1024*1024,
    });
    if(result.error||result.status!==0)throw Error('Production deploy: WRANGLER_FAILED; output withheld to protect runtime variables.');
    let entries;
    try{entries=readFileSync(outputPath,'utf8').trim().split('\n').map(line=>JSON.parse(line));}
    catch{throw Error('Production deploy: DEPLOY_RESULT_UNVERIFIED; upload may have completed.');}
    const deploys=entries.filter(entry=>entry?.type==='deploy');
    if(deploys.length!==1||deploys[0].version!==1||deploys[0].worker_name!==workerName||deploys[0].wrangler_environment||!isVersionId(deploys[0].version_id))throw Error('Production deploy: DEPLOY_RESULT_UNVERIFIED; upload may have completed.');
    return {versionId:deploys[0].version_id,sourceCommit};
  }finally{rmSync(directory,{recursive:true,force:true});}
}

const isVersionId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function assertDeployedVersion(remote,result){
  if(!isVersionId(result?.versionId)||remote?.activeVersions?.length!==1||remote.activeVersions[0]?.id!==result.versionId||remote.activeVersions[0]?.percentage!==100||remote.deploymentMessage!==`source-commit:${result.sourceCommit}`)throw Error('Production deploy: POST_DEPLOY_VERSION_UNVERIFIED');
  return true;
}
