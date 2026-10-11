import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {assertProductionTarget} from './guard-production-target.mjs';
import {assertProductionBranch} from './production-branch.mjs';
import {assertRemoteDeploymentBaseline} from './read-remote-state.mjs';
import {readRemoteState} from './read-remote-state.mjs';
import {approvedRemoteBaseline,assertRemoteState} from './remote-state-policy.mjs';
import {deploymentEnvironment,runWranglerSafely} from './deployment-runtime.mjs';

const root=resolve(import.meta.dirname,'..');
assertProductionTarget(readFileSync(resolve(root,'wrangler.toml'),'utf8'),process.env);
const branch=execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim();
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
assertProductionBranch(process.env,branch,head);
if(!process.env.WORKERS_CI)throw Error('Production deploy requires guarded Workers Builds runtime.');
const childEnvironment=deploymentEnvironment(process.env);
await assertRemoteDeploymentBaseline({token:process.env.CLOUDFLARE_API_TOKEN});
const wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
runWranglerSafely(process.execPath,wrangler,root,childEnvironment);
let deployedVersionId;
for(let i=0;i<2;i++){
  const after=await readRemoteState({token:process.env.CLOUDFLARE_API_TOKEN});
  if(after.activeVersions?.[0]?.id===approvedRemoteBaseline.activeVersionId)throw Error('Production deploy: POST_DEPLOY_VERSION_UNCHANGED');
  deployedVersionId??=after.activeVersions?.[0]?.id;
  assertRemoteState(after,{...approvedRemoteBaseline,activeVersionId:deployedVersionId});
}
console.log('Production deploy completed and remote metadata rechecked. Verify owner-only Access separately.');
