import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const configPath=resolve(import.meta.dirname,'../wrangler.toml');

export function assertProductionTarget(config,env={}){
  const required=[
    ['Worker name',/^name\s*=\s*"holy-rice-b914"\s*$/m],
    ['Worker entry',/^main\s*=\s*"src\/site-worker\.mjs"\s*$/m],
    ['production workers.dev route',/^workers_dev\s*=\s*true\s*$/m],
    ['disabled version URLs',/^preview_urls\s*=\s*false\s*$/m],
    ['dashboard variables preserved',/^keep_vars\s*=\s*true\s*$/m],
    ['assets binding',/^binding\s*=\s*"ASSETS"\s*$/m],
    ['auth before assets',/^run_worker_first\s*=\s*true\s*$/m],
    ['production D1 binding',/^binding\s*=\s*"DB"\s*$/m],
    ['production D1 name',/^database_name\s*=\s*"youtube-ai-analyzer-private-db"\s*$/m],
    ['production D1 ID',/^database_id\s*=\s*"d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34"\s*$/m],
  ];
  for(const [label,pattern] of required){
    if(!pattern.test(config))throw Error(`Deployment target guard: invalid ${label}`);
  }
  for(const [section,fields] of Object.entries({
    observability:{enabled:'true',head_sampling_rate:'1',redact_query_string:'false'},
    'observability.logs':{enabled:'true',head_sampling_rate:'1',invocation_logs:'true',persist:'true',destinations:'[]'},
    'observability.traces':{enabled:'false',head_sampling_rate:'1',persist:'true',destinations:'[]'},
    'observability.issues':{enabled:'false'},
  })){
    const marker=`[${section}]`,parts=config.split(marker);
    if(parts.length!==2)throw Error(`Deployment target guard: invalid ${section}`);
    const body=parts[1].split(/^\[/m)[0];
    for(const [key,value] of Object.entries(fields)){
      const entries=[...body.matchAll(new RegExp(`^${key}\\s*=\\s*(.*)$`,'gm'))];
      if(entries.length!==1||entries[0][1].trim()!==value)throw Error(`Deployment target guard: invalid ${section}.${key}`);
    }
  }
  const productionVars=config.split(/^\[vars\]\s*$/m)[1]?.split(/^\[/m)[0]??'';
  for(const [key,value] of Object.entries({ENABLE_LIVE_FREE:'false',ALLOW_PAID_API:'false',SITE_DEPLOYED:'true'})){
    if(!new RegExp(`^${key}\\s*=\\s*"${value}"\\s*$`,'m').test(productionVars))throw Error(`Deployment target guard: invalid ${key}`);
  }
  if(/^\s*(ACCESS_AUD|ACCESS_TEAM_DOMAIN|ACCESS_OWNER_EMAIL|KEY_ENCRYPTION_KEY_B64)\s*=/m.test(config)){
    throw Error('Deployment target guard: private Access or encryption values must stay out of config');
  }
  const previewConfig=config.split(/^\[previews(?:\.|\])|^previews\s*=/m)[1]??'';
  if(/database_id\s*=|\[\[previews\.d1_databases\]\]/m.test(previewConfig)){
    throw Error('Deployment target guard: preview must not bind production D1');
  }
  if(env.WRANGLER_CI_OVERRIDE_NAME&&env.WRANGLER_CI_OVERRIDE_NAME!=='holy-rice-b914'){
    throw Error('Deployment target guard: WRANGLER_CI_OVERRIDE_NAME targets a different Worker');
  }
  return true;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  assertProductionTarget(readFileSync(configPath,'utf8'),process.env);
  console.log('Production target guard passed (offline only).');
}
