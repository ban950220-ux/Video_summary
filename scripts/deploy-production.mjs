import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {assertProductionTarget} from './guard-production-target.mjs';
import {assertProductionBranch} from './production-branch.mjs';
import {assertRemoteDeploymentBaseline} from './read-remote-state.mjs';
import {deploymentEnvironment,runWranglerSafely} from './deployment-runtime.mjs';
import {verifyPostDeploy} from './post-deploy-verification.mjs';

const root=resolve(import.meta.dirname,'..');
assertProductionTarget(readFileSync(resolve(root,'wrangler.toml'),'utf8'),process.env);
const branch=execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim();
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
assertProductionBranch(process.env,branch,head);
if(!process.env.WORKERS_CI)throw Error('Production deploy requires guarded Workers Builds runtime.');
let before;
try{before=await assertRemoteDeploymentBaseline({token:process.env.CLOUDFLARE_API_TOKEN,ciMatchTag:process.env.WRANGLER_CI_MATCH_TAG});}
catch{throw Error('Production deploy: PRE_DEPLOY_BLOCKED: REMOTE_READ_OR_GUARD_FAILED; no upload attempted.');}
const childEnvironment=deploymentEnvironment(process.env,before.workerTag);
const wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
const deployed=runWranglerSafely(process.execPath,wrangler,root,childEnvironment,head);
console.log(await verifyPostDeploy({token:process.env.CLOUDFLARE_API_TOKEN,ciMatchTag:process.env.WRANGLER_CI_MATCH_TAG,deployed,before}));
