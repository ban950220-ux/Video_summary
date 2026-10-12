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
export const sameCanonical=(left,right)=>canonical(left)===canonical(right);
const fail=code=>{throw Error(`Remote deployment guard: ${code}`);};
const requiredBindingTypes=new Map([
  ['DB','d1'],['ACCESS_AUD','plain_text'],['ACCESS_TEAM_DOMAIN','plain_text'],
  ['ACCESS_OWNER_EMAIL','secret_text'],['KEY_ENCRYPTION_KEY_B64','secret_text'],
  ['ENABLE_LIVE_FREE','plain_text'],['ALLOW_PAID_API','plain_text'],['SITE_DEPLOYED','plain_text'],
]);

export function inspectBindingSet(bindings,{expectAssets=false}={}){
  if(!Array.isArray(bindings))return {available:false,unique:false,complete:false};
  const names=bindings.map(binding=>binding?.name);
  const unique=names.every(name=>typeof name==='string')&&new Set(names).size===names.length;
  const actual=new Map(bindings.map(binding=>[binding?.name,binding?.type]));
  const expected=new Map(requiredBindingTypes);
  if(expectAssets)expected.set('ASSETS','assets');
  return {available:true,unique,complete:unique&&actual.size===expected.size&&[...expected].every(([name,type])=>actual.get(name)===type)};
}
const baselineObservability={
  enabled:true,head_sampling_rate:1,redact_query_string:false,
  logs:{enabled:true,head_sampling_rate:1,invocation_logs:true,persist:true},
  traces:{enabled:false,head_sampling_rate:1,persist:true},
};

export const approvedRemoteBaseline={
  activeVersionId:'76b50169-5db5-4930-a5ef-df35923fc3d6',
  sourceCommit:'627163ffd25941881684151e15d903d4a636ecea',
  databaseId:'d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34',
  routes:[],domains:[],compatibilityDate:'2026-10-10',compatibilityFlagsPresent:false,
  assetsPresent:true,
  // The previous guarded deploy installed ASSETS; recheck all remote state before the next upload.
  remoteSettingsReviewed:true,
  runtimeFlags:{ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',SITE_DEPLOYED:'true'},
  optionalScriptFields:{limits:{present:false},placement_mode:{present:false},streaming_tail_consumers:{present:false}},
  scriptSettings:{logpush:false,tail_consumers:null,observability:baselineObservability},
  observability:baselineObservability,
};

export function assertRemoteState(remote,baseline,{postDeploy=false}={}){
  if(baseline?.remoteSettingsReviewed!==true)fail('REMOTE_SETTINGS_BASELINE_UNVERIFIED');
  if(typeof baseline.assetsPresent!=='boolean')fail('BINDINGS_BASELINE_INVALID');
  if(!remote||!baseline||!Array.isArray(remote.routes)||!Array.isArray(remote.domains)||!Array.isArray(baseline.routes)||!Array.isArray(baseline.domains)||typeof remote.compatibilityFlagsPresent!=='boolean'||typeof baseline.compatibilityFlagsPresent!=='boolean'||(remote.compatibilityFlagsPresent&&!Array.isArray(remote.compatibilityFlags))||(baseline.compatibilityFlagsPresent&&!Array.isArray(baseline.compatibilityFlags)))fail('METADATA_INCOMPLETE');
  if(remote?.workerName!=='holy-rice-b914'||remote.environment!=='production')fail('WORKER_TARGET_MISMATCH');
  if(!Array.isArray(remote.activeVersions)||remote.activeVersions.length!==1||remote.activeVersions[0]?.percentage!==100||remote.activeVersions[0]?.id!==baseline?.activeVersionId)fail('ACTIVE_VERSION_MISMATCH');
  if(remote.workersDev!==true||remote.previewUrls!==false)fail('PUBLIC_URL_SETTINGS_MISMATCH');
  if(canonical(remote.routes)!==canonical(baseline.routes)||canonical(remote.domains)!==canonical(baseline.domains))fail('ROUTES_MISMATCH');
  if(remote.compatibilityDate!==baseline.compatibilityDate||remote.compatibilityFlagsPresent!==baseline.compatibilityFlagsPresent||canonical(remote.compatibilityFlags)!==canonical(baseline.compatibilityFlags))fail('COMPATIBILITY_MISMATCH');
  if(!remote.scriptSettings||typeof remote.scriptSettings.logpush!=='boolean'||!Object.hasOwn(remote.scriptSettings,'tail_consumers')||!(remote.scriptSettings.tail_consumers===null||Array.isArray(remote.scriptSettings.tail_consumers))||!remote.scriptSettings.observability||!remote.optionalScriptFields||Object.keys(baseline.optionalScriptFields||{}).some(key=>typeof remote.optionalScriptFields[key]?.present!=='boolean'))fail('SCRIPT_SETTINGS_INCOMPLETE');
  if(canonical(remote.scriptSettings.logpush)!==canonical(baseline.scriptSettings?.logpush)||canonical(remote.scriptSettings.tail_consumers)!==canonical(baseline.scriptSettings?.tail_consumers)||canonical(remote.optionalScriptFields)!==canonical(baseline.optionalScriptFields))fail('SCRIPT_SETTINGS_MISMATCH');
  for(const path of Object.keys(requiredObservability)){
    if(valueAt(remote.observability,path)===undefined||valueAt(baseline.observability,path)===undefined)fail('OBSERVABILITY_INCOMPLETE');
  }
  if(canonical(remote.observability)!==canonical(baseline.observability))fail('OBSERVABILITY_MISMATCH');
  for(const path of Object.keys(requiredObservability))if(valueAt(remote.scriptSettings.observability,path)===undefined||valueAt(baseline.scriptSettings.observability,path)===undefined)fail('SCRIPT_SETTINGS_OBSERVABILITY_INCOMPLETE');
  if(canonical(remote.scriptSettings.observability)!==canonical(baseline.scriptSettings.observability))fail('SCRIPT_SETTINGS_OBSERVABILITY_MISMATCH');
  const shape=inspectBindingSet(remote.bindings,{expectAssets:postDeploy||baseline.assetsPresent});
  if(!shape.available)fail('BINDINGS_UNAVAILABLE');
  if(!shape.unique||!shape.complete)fail('BINDINGS_UNEXPECTED');
  const bindings=new Map(remote.bindings.map(binding=>[binding.name,binding]));
  if(bindings.get('DB')?.id!==baseline.databaseId)fail('D1_MISMATCH');
  const expectedFlags={...baseline.runtimeFlags,...(postDeploy?{ENABLE_LIVE_FREE:'true'}:{})};
  if(!baseline.runtimeFlags||baseline.runtimeFlags.ALLOW_PAID_API!=='false'||baseline.runtimeFlags.SITE_DEPLOYED!=='true'||!['false','true'].includes(baseline.runtimeFlags.ENABLE_LIVE_FREE))fail('RUNTIME_FLAGS_BASELINE_INVALID');
  for(const [name,value] of Object.entries(expectedFlags)){
    if(bindings.get(name)?.text!==value)fail('RUNTIME_FLAGS_MISMATCH');
  }
  if(typeof bindings.get('ACCESS_AUD')?.text!=='string'||bindings.get('ACCESS_AUD').text.length<12||!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(bindings.get('ACCESS_TEAM_DOMAIN')?.text??''))fail('ACCESS_VARS_MISSING');
  if(!postDeploy&&(typeof baseline.sourceCommit!=='string'||!/^[0-9a-f]{40}$/.test(baseline.sourceCommit)||remote.deploymentMessage!==`source-commit:${baseline.sourceCommit}`))fail('SOURCE_COMMIT_MISMATCH');
  return true;
}
