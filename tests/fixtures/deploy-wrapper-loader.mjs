// Child-process-only ESM loader. It replaces network and Wrangler dependencies
// while running the real deploy-production.mjs entrypoint unchanged.
const mocked=new Set(['read-remote-state.mjs','remote-state-policy.mjs','deployment-runtime.mjs','post-deploy-verification.mjs','current-state-replacement.mjs']);
export function resolve(specifier,context,next){
 const name=specifier.split('/').at(-1);
 if(context.parentURL?.endsWith('/scripts/deploy-production.mjs')&&mocked.has(name))return {url:`mock:///${name}`,shortCircuit:true};
 return next(specifier,context);
}
export function load(url,context,next){
 if(!url.startsWith('mock:///'))return next(url,context);
 const name=url.slice('mock:///'.length);
 const common=`import {appendFileSync} from 'node:fs'; const log=value=>appendFileSync(process.env.DEPLOY_MOCK_LOG_FILE,value+'\\n');`;
 const bodies={
  'read-remote-state.mjs':`${common}
   export async function assertRemoteDeploymentBaseline(){log('PREFLIGHT');if(process.env.DEPLOY_MOCK_MODE==='preflight-fail')throw Error('BLOCKED');return {workerTag:'tag',marker:'stable'};}
   export async function readRemoteState(){log('FINAL_READ');if(process.env.DEPLOY_MOCK_MODE==='final-read-error')throw Error('READ_FAILED');return {workerTag:'tag',marker:process.env.DEPLOY_MOCK_MODE==='final-remote-drift'?'changed':'stable'};}`,
  'remote-state-policy.mjs':`export const protectedRemoteBaseline=()=>({});export const assertProtectedDeployTarget=()=>true;export const assertRemoteState=()=>true;`,
  'deployment-runtime.mjs':`${common}
   export const deploymentEnvironment=()=>({});
   export function runWranglerSafely(node,wrangler,cwd,environment,head){log('WRANGLER');if(process.env.DEPLOY_MOCK_MODE==='wrangler-error')throw Error('WRANGLER_FAILED');return {versionId:'44444444-4444-4444-8444-444444444444',sourceCommit:head};}`,
  'post-deploy-verification.mjs':`${common}
   export async function verifyPostDeploy(){log('POSTCHECK');if(process.env.DEPLOY_MOCK_MODE==='post-error')throw Error('DEPLOYED_UNVERIFIED');return '{"ok":true}';}`,
  'current-state-replacement.mjs':`${common}
   let approvals=0,manifests=0;
   export const assertReplacementConfig=()=>true;
   export function currentStateReplacementApproval(){approvals++;log('APPROVAL');if(process.env.DEPLOY_MOCK_MODE==='approval-expired-final'&&approvals===2)throw Error('APPROVAL_EXPIRED');return {accountId:'fe9d7e2a164274b1ff6cef150a75cb0b',workerName:'holy-rice-b914',databaseId:'d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34',replacement:{reviewedCommitSha:process.env.WORKERS_CI_COMMIT_SHA,assetManifestDigest:'digest',remoteFingerprint:'stable'}};}
   export function assetManifestDigest(){manifests++;log('MANIFEST');if(process.env.DEPLOY_MOCK_MODE==='asset-read-error'&&manifests===2)throw Error('MANIFEST_READ_FAILED');return process.env.DEPLOY_MOCK_MODE==='asset-drift'&&manifests===2?'changed':'digest';}
   export const remoteStateFingerprint=state=>state.marker;`,
 };
 return {format:'module',source:bodies[name],shortCircuit:true};
}
