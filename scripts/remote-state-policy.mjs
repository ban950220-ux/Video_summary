// Offline policy prototype. Do not invoke deployment from this module.
const requiredObservability={
  'enabled':true,
  'head_sampling_rate':true,
  'redact_query_string':true,
  'logs.enabled':true,
  'logs.head_sampling_rate':true,
  'logs.invocation_logs':true,
  'logs.persist':true,
  'traces.enabled':true,
  'traces.head_sampling_rate':true,
  'traces.persist':true,
};
const valueAt=(obj,path)=>path.split('.').reduce((value,key)=>value?.[key],obj);
const canonical=value=>JSON.stringify(value,(_,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b))):entry);
const fail=code=>{throw Error(`Remote deployment guard: ${code}`);};

export function assertRemoteState(remote,baseline){
  if(!remote||!baseline||!Array.isArray(remote.routes)||!Array.isArray(remote.domains)||!Array.isArray(baseline.routes)||!Array.isArray(baseline.domains)||!Array.isArray(remote.compatibilityFlags)||!Array.isArray(baseline.compatibilityFlags))fail('METADATA_INCOMPLETE');
  if(remote?.workerName!=='holy-rice-b914'||remote.environment!=='production')fail('WORKER_TARGET_MISMATCH');
  if(!Array.isArray(remote.activeVersions)||remote.activeVersions.length!==1||remote.activeVersions[0]?.percentage!==100||remote.activeVersions[0]?.id!==baseline?.activeVersionId)fail('ACTIVE_VERSION_MISMATCH');
  if(remote.workersDev!==true||remote.previewUrls!==false)fail('PUBLIC_URL_SETTINGS_MISMATCH');
  if(canonical(remote.routes)!==canonical(baseline.routes)||canonical(remote.domains)!==canonical(baseline.domains))fail('ROUTES_MISMATCH');
  if(remote.compatibilityDate!==baseline.compatibilityDate||canonical(remote.compatibilityFlags)!==canonical(baseline.compatibilityFlags))fail('COMPATIBILITY_MISMATCH');
  for(const path of Object.keys(requiredObservability)){
    if(valueAt(remote.observability,path)===undefined||valueAt(baseline.observability,path)===undefined)fail('OBSERVABILITY_INCOMPLETE');
  }
  if(canonical(remote.observability)!==canonical(baseline.observability))fail('OBSERVABILITY_MISMATCH');
  if(!Array.isArray(remote.bindings))fail('BINDINGS_UNAVAILABLE');
  const bindings=new Map();
  for(const binding of remote.bindings){
    if(typeof binding?.name!=='string'||bindings.has(binding.name))fail('BINDINGS_UNEXPECTED');
    bindings.set(binding.name,binding);
  }
  const expected=new Map([
    ['DB','d1'],['ACCESS_AUD','plain_text'],['ACCESS_TEAM_DOMAIN','plain_text'],
    ['ACCESS_OWNER_EMAIL','secret_text'],['KEY_ENCRYPTION_KEY_B64','secret_text'],
    ['ENABLE_LIVE_FREE','plain_text'],['ALLOW_PAID_API','plain_text'],['SITE_DEPLOYED','plain_text'],
  ]);
  if(bindings.has('ASSETS'))expected.set('ASSETS','assets');
  if(bindings.size!==expected.size||[...expected].some(([name,type])=>bindings.get(name)?.type!==type))fail('BINDINGS_UNEXPECTED');
  if(bindings.get('DB')?.id!==baseline.databaseId)fail('D1_MISMATCH');
  for(const [name,value] of Object.entries({ENABLE_LIVE_FREE:'false',ALLOW_PAID_API:'false',SITE_DEPLOYED:'true'})){
    if(bindings.get(name)?.text!==value)fail('RUNTIME_FLAGS_MISMATCH');
  }
  if(typeof bindings.get('ACCESS_AUD')?.text!=='string'||bindings.get('ACCESS_AUD').text.length<12||!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(bindings.get('ACCESS_TEAM_DOMAIN')?.text??''))fail('ACCESS_VARS_MISSING');
  return true;
}
