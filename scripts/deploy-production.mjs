import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {assertProductionTarget} from './guard-production-target.mjs';

const root=resolve(import.meta.dirname,'..');
assertProductionTarget(readFileSync(resolve(root,'wrangler.toml'),'utf8'),process.env);
const branch=execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim();
if(branch!=='main'||(process.env.WORKERS_CI&&process.env.WORKERS_CI_BRANCH!=='main')){
  throw Error('Production deploy requires the main branch; review branches cannot deploy.');
}
const wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
const result=spawnSync(process.execPath,[wrangler,'deploy','--config','wrangler.toml','--name','holy-rice-b914','--keep-vars','--strict'],{cwd:root,stdio:'inherit',env:process.env});
if(result.error)throw result.error;
process.exitCode=result.status??1;
