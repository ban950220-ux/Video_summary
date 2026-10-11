import {spawnSync} from 'node:child_process';

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
export function runWranglerSafely(node,wrangler,cwd,environment,spawn=spawnSync){
  const result=spawn(node,[wrangler,'deploy','--config','wrangler.toml','--name',workerName,'--keep-vars'],{
    cwd,env:environment,stdio:['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:8*1024*1024,
  });
  if(result.error||result.status!==0)throw Error('Production deploy: WRANGLER_FAILED; output withheld to protect runtime variables.');
  return true;
}
