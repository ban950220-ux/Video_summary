import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {assertProductionTarget} from './guard-production-target.mjs';
import {assertProductionBranch} from './production-branch.mjs';
import {assertRemoteDeploymentBaseline} from './read-remote-state.mjs';

const root=resolve(import.meta.dirname,'..');
assertProductionTarget(readFileSync(resolve(root,'wrangler.toml'),'utf8'),process.env);
const branch=execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim();
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
assertProductionBranch(process.env,branch,head);
if(!process.env.WORKERS_CI)throw Error('Production deploy requires guarded Workers Builds runtime.');
if(process.env.CLOUDFLARE_ACCOUNT_ID&&process.env.CLOUDFLARE_ACCOUNT_ID!=='fe9d7e2a164274b1ff6cef150a75cb0b')throw Error('Production deploy account mismatch.');
await assertRemoteDeploymentBaseline({token:process.env.CLOUDFLARE_API_TOKEN});
const wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
const result=spawnSync(process.execPath,[wrangler,'deploy','--config','wrangler.toml','--name','holy-rice-b914','--keep-vars'],{cwd:root,stdio:'inherit',env:process.env});
if(result.error)throw result.error;
process.exitCode=result.status??1;
