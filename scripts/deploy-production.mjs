import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {assertProductionTarget} from './guard-production-target.mjs';
import {assertProductionBranch} from './production-branch.mjs';
import {assertRemoteDeploymentBaseline,readRemoteState} from './read-remote-state.mjs';
import {assertProtectedDeployTarget,assertRemoteState,protectedRemoteBaseline} from './remote-state-policy.mjs';
import {deploymentEnvironment,runWranglerSafely} from './deployment-runtime.mjs';
import {verifyPostDeploy} from './post-deploy-verification.mjs';
import {assertReplacementConfig,assetManifestDigest,currentStateReplacementApproval,remoteStateFingerprint} from './current-state-replacement.mjs';

const root=resolve(import.meta.dirname,'..');
const config=readFileSync(resolve(root,'wrangler.toml'),'utf8');
assertProductionTarget(config,process.env);
const replacing=Object.hasOwn(process.env,'GROQ_CURRENT_STATE_REPLACEMENT_JSON');
if(replacing)assertReplacementConfig(config);
const approved=replacing?currentStateReplacementApproval(process.env):protectedRemoteBaseline(process.env);
assertProtectedDeployTarget(config,approved,process.env);
const branch=execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim();
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
assertProductionBranch(process.env,branch,head);
if(!process.env.WORKERS_CI)throw Error('Production deploy requires guarded Workers Builds runtime.');
let before;
try{before=await assertRemoteDeploymentBaseline({token:process.env.CLOUDFLARE_API_TOKEN,ciMatchTag:process.env.WRANGLER_CI_MATCH_TAG,baseline:approved,env:process.env,head,buildSha:process.env.WORKERS_CI_COMMIT_SHA,manifestDigest:replacing?assetManifestDigest(root):undefined});}
catch{throw Error('Production deploy: PRE_DEPLOY_BLOCKED: REMOTE_READ_OR_GUARD_FAILED; no upload attempted.');}
if(replacing){
  // Last read before a single upload. This narrows but cannot eliminate a
  // dashboard or another build changing state during the upload itself.
  let latest;
  try{latest=await readRemoteState({token:process.env.CLOUDFLARE_API_TOKEN,target:approved,env:process.env});}
  catch{throw Error('Production deploy: PRE_DEPLOY_BLOCKED: FINAL_REMOTE_READ_FAILED; no upload attempted.');}
  const fresh=currentStateReplacementApproval(process.env);
  try{
   assertRemoteState(latest,fresh,{postDeploy:true});
   if(process.env.WRANGLER_CI_MATCH_TAG&&latest.workerTag!==process.env.WRANGLER_CI_MATCH_TAG)throw Error('WORKER_TAG_MISMATCH');
   if(remoteStateFingerprint(latest)!==fresh.replacement.remoteFingerprint||fresh.replacement.reviewedCommitSha!==head||assetManifestDigest(root)!==fresh.replacement.assetManifestDigest)throw Error('FINAL_DRIFT');
  }catch{throw Error('Production deploy: PRE_DEPLOY_BLOCKED: FINAL_STATE_CHANGED; no upload attempted.');}
}
const childEnvironment=deploymentEnvironment({...process.env,CLOUDFLARE_ACCOUNT_ID:approved.accountId,WRANGLER_CI_OVERRIDE_NAME:approved.workerName},before.workerTag);
assertProtectedDeployTarget(config,approved,childEnvironment);
const wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
const deployed=runWranglerSafely(process.execPath,wrangler,root,childEnvironment,head);
console.log(await verifyPostDeploy({token:process.env.CLOUDFLARE_API_TOKEN,ciMatchTag:process.env.WRANGLER_CI_MATCH_TAG,deployed,before,baseline:approved}));
