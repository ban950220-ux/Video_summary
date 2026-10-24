// Offline policy prototype. Do not invoke deployment from this module.
import {inspectFullCoverageConfig} from './full-coverage-config.mjs';
import {geminiPaidFlagNames,assertGeminiPaidConfig,expectedRuntimeFlags,assertGeminiPaidReviewFresh} from './gemini-paid-activation.mjs';
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
export const legacyQuoteRecoveryBinding='GEMINI_LEGACY_QUOTE_RECOVERY_JSON';
export const legacyGroqRecoveryScopeBinding='GROQ_LEGACY_RECOVERY_SCOPE_JSON';
const requiredBindingTypes=new Map([
  ['DB','d1'],['ACCESS_AUD','plain_text'],['ACCESS_TEAM_DOMAIN','plain_text'],
  ['ACCESS_OWNER_EMAIL','secret_text'],['KEY_ENCRYPTION_KEY_B64','secret_text'],
  ['ENABLE_LIVE_FREE','plain_text'],['ALLOW_PAID_API','plain_text'],['SITE_DEPLOYED','plain_text'],
  ['ENABLE_PAID_SUMMARY','plain_text'],['PAID_SUMMARY_EXECUTION_APPROVED','plain_text'],
  ['PAID_FIRST_GENERATION_TRIAL_ENABLED','plain_text'],['PAID_FIRST_TRIAL_USD_COST_REVIEWED','plain_text'],
  ['ENABLE_GEMINI_TWO_PASS','secret_text'],['GEMINI_TWO_PASS_ALLOWED_JOB_ID','secret_text'],
  [legacyQuoteRecoveryBinding,'plain_text'],
]);

export function inspectBindingSet(bindings,{expectAssets=false,fullCoverageEnabled=false,geminiTwoPassPaidEnabled=false}={}){
  if(!Array.isArray(bindings))return {available:false,unique:false,complete:false};
  const names=bindings.map(binding=>binding?.name);
  const unique=names.every(name=>typeof name==='string')&&new Set(names).size===names.length;
  const actual=new Map(bindings.map(binding=>[binding?.name,binding?.type]));
  const expected=new Map(requiredBindingTypes);
  if(expectAssets)expected.set('ASSETS','assets');
  if(fullCoverageEnabled){
    expected.set('ENABLE_FULL_COVERAGE','plain_text');
    expected.set('GROQ_FREE_ORG_BINDING_JSON','secret_text');
  }
  if(geminiTwoPassPaidEnabled===true)for(const name of geminiPaidFlagNames)expected.set(name,'plain_text');
  if(actual.has(legacyGroqRecoveryScopeBinding))expected.set(legacyGroqRecoveryScopeBinding,'secret_text');
  return {available:true,unique,complete:unique&&actual.size===expected.size&&[...expected].every(([name,type])=>actual.get(name)===type)};
}
const baselineObservability={
  enabled:true,head_sampling_rate:1,redact_query_string:false,
  logs:{enabled:true,head_sampling_rate:1,invocation_logs:true,persist:true},
  traces:{enabled:false,head_sampling_rate:1,persist:true},
};

// Offline shape fixture; deployment identity must come from protected evidence.
export const approvedRemoteBaseline={
  accountId:'a'.repeat(32),workerName:'example-worker',
  activeVersionId:'11111111-1111-4111-8111-111111111111',
  sourceCommit:'a'.repeat(40),
  databaseId:'22222222-2222-4222-8222-222222222222',
  priorVersionId:'33333333-3333-4333-8333-333333333333',
  scriptEtag:'a'.repeat(64),
  routes:[],domains:[],compatibilityDate:'2026-10-10',compatibilityFlagsPresent:false,
  assetsPresent:true,
  // The dashboard settings version has no source annotation. The fixed
  // predecessor and identical script ETag are verified before upload.
  // A fresh remote preflight still checks all settings before another upload;
  // omitted optional fields, null and [] remain distinct.
  remoteSettingsReviewed:true,
  runtimeFlags:{ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',SITE_DEPLOYED:'true',ENABLE_PAID_SUMMARY:'true',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_FIRST_GENERATION_TRIAL_ENABLED:'true',PAID_FIRST_TRIAL_USD_COST_REVIEWED:'true'},
  optionalScriptFields:{limits:{present:false},placement_mode:{present:false},streaming_tail_consumers:{present:false}},
  scriptSettings:{logpush:false,tail_consumers:null,observability:baselineObservability},
  observability:baselineObservability,
};
export const approvedPreDeployLineage={
 activeVersionId:'11111111-1111-4111-8111-111111111111',
 priorVersionId:'33333333-3333-4333-8333-333333333333',
 sourceCommit:'a'.repeat(40),
 scriptEtag:'a'.repeat(64),
};

// The current deployment identity is supplied by a protected CI variable.
// Without a recent, exact approval the production preflight never starts.
export function protectedRemoteBaseline(env=process.env){
 let approval;try{approval=JSON.parse(env.GROQ_DEPLOYMENT_EVIDENCE_JSON);}catch{fail('DEPLOYMENT_EVIDENCE_UNAVAILABLE');}
 const keys=['kind','accountId','workerName','databaseId','activeVersionId','priorVersionId','scriptEtag','sourceCommit','reviewedAt','expiresAt'];
 const fullCoverageEnabled=Object.hasOwn(approval??{},'fullCoverageEnabled');
 if(fullCoverageEnabled)keys.push('fullCoverageEnabled');
 const geminiTwoPassPaidEnabled=Object.hasOwn(approval??{},'geminiTwoPassPaidEnabled');
 if(geminiTwoPassPaidEnabled)keys.push('geminiTwoPassPaidEnabled');
 if(!approval||typeof approval!=='object'||Array.isArray(approval)||Object.keys(approval).sort().join(',')!==keys.sort().join(',')||(fullCoverageEnabled&&approval.fullCoverageEnabled!==true)||(geminiTwoPassPaidEnabled&&approval.geminiTwoPassPaidEnabled!==true))fail('DEPLOYMENT_EVIDENCE_INVALID');
 const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,hex32=/^[0-9a-f]{32}$/i,worker=/^[a-z0-9][a-z0-9-]{0,62}$/i,sha=/^[0-9a-f]{40}$/i,iso=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
 if(approval.kind!=='REMOTE_DEPLOYMENT_REVIEW_V1'||!hex32.test(approval.accountId)||!worker.test(approval.workerName)||!uuid.test(approval.databaseId)||!uuid.test(approval.activeVersionId)||!uuid.test(approval.priorVersionId)||!(/^[0-9a-f]{64}$/i).test(approval.scriptEtag)||approval.priorVersionId===approval.activeVersionId||!sha.test(approval.sourceCommit)||!iso.test(approval.reviewedAt)||!iso.test(approval.expiresAt))fail('DEPLOYMENT_EVIDENCE_INVALID');
 const start=Date.parse(approval.reviewedAt),end=Date.parse(approval.expiresAt),now=Date.now();
 if(!Number.isFinite(start)||!Number.isFinite(end)||start>now||end<=now||end-start>24*60*60*1000)fail('DEPLOYMENT_EVIDENCE_EXPIRED');
 return {...approvedRemoteBaseline,accountId:approval.accountId,workerName:approval.workerName,databaseId:approval.databaseId,activeVersionId:approval.activeVersionId,priorVersionId:approval.priorVersionId,scriptEtag:approval.scriptEtag,sourceCommit:approval.sourceCommit,fullCoverageEnabled,geminiTwoPassPaidEnabled,...(geminiTwoPassPaidEnabled?{deploymentEvidenceReviewedAt:approval.reviewedAt,deploymentEvidenceExpiresAt:approval.expiresAt}:{})};
}

export function assertProtectedDeployTarget(config,baseline,env={}){
 if(typeof config!=='string'||!baseline||typeof baseline.accountId!=='string')fail('PROTECTED_DEPLOY_TARGET_MISMATCH');
 const worker=[...config.matchAll(/^name\s*=\s*"([^"]+)"\s*$/gm)];
 const database=[...config.matchAll(/^database_id\s*=\s*"([^"]+)"\s*$/gm)];
 if(worker.length!==1||database.length!==1||worker[0][1]!==baseline?.workerName||database[0][1]!==baseline?.databaseId)fail('PROTECTED_DEPLOY_TARGET_MISMATCH');
 if(env.CLOUDFLARE_ACCOUNT_ID&&env.CLOUDFLARE_ACCOUNT_ID!==baseline.accountId)fail('PROTECTED_DEPLOY_TARGET_MISMATCH');
 if(env.WRANGLER_CI_OVERRIDE_NAME&&env.WRANGLER_CI_OVERRIDE_NAME!==baseline.workerName)fail('PROTECTED_DEPLOY_TARGET_MISMATCH');
 let activation;try{activation=inspectFullCoverageConfig(config);assertGeminiPaidConfig(config);}catch(error){fail(error.message);}
 if(activation.enabled&&baseline.fullCoverageEnabled!==true)fail('FULL_COVERAGE_ACTIVATION_UNAPPROVED');
 assertGeminiPaidReviewFresh(baseline);
 return true;
}

export function assertRemoteState(remote,baseline,{postDeploy=false,preDeployLineage=null}={}){
  if(baseline?.remoteSettingsReviewed!==true)fail('REMOTE_SETTINGS_BASELINE_UNVERIFIED');
  assertGeminiPaidReviewFresh(baseline);
  if(typeof baseline.assetsPresent!=='boolean')fail('BINDINGS_BASELINE_INVALID');
  if(!remote||!baseline||!Array.isArray(remote.routes)||!Array.isArray(remote.domains)||!Array.isArray(baseline.routes)||!Array.isArray(baseline.domains)||typeof remote.compatibilityFlagsPresent!=='boolean'||typeof baseline.compatibilityFlagsPresent!=='boolean'||(remote.compatibilityFlagsPresent&&!Array.isArray(remote.compatibilityFlags))||(baseline.compatibilityFlagsPresent&&!Array.isArray(baseline.compatibilityFlags)))fail('METADATA_INCOMPLETE');
  if(typeof baseline.workerName!=='string'||remote?.workerName!==baseline.workerName||remote.environment!=='production')fail('WORKER_TARGET_MISMATCH');
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
  const shape=inspectBindingSet(remote.bindings,{expectAssets:postDeploy||baseline.assetsPresent,fullCoverageEnabled:baseline.fullCoverageEnabled===true,geminiTwoPassPaidEnabled:baseline.geminiTwoPassPaidEnabled===true});
  if(!shape.available)fail('BINDINGS_UNAVAILABLE');
  if(!shape.unique||!shape.complete)fail('BINDINGS_UNEXPECTED');
  const bindings=new Map(remote.bindings.map(binding=>[binding.name,binding]));
  if(typeof bindings.get(legacyQuoteRecoveryBinding)?.text!=='string'||!bindings.get(legacyQuoteRecoveryBinding).text)fail('RECOVERY_SETTING_UNAVAILABLE');
  if(bindings.get('DB')?.id!==baseline.databaseId)fail('D1_MISMATCH');
  const expectedFlags=expectedRuntimeFlags(baseline,{postDeploy});
  if(!baseline.runtimeFlags||baseline.runtimeFlags.ALLOW_PAID_API!=='false'||baseline.runtimeFlags.SITE_DEPLOYED!=='true'||!['false','true'].includes(baseline.runtimeFlags.ENABLE_LIVE_FREE)||['ENABLE_PAID_SUMMARY','PAID_SUMMARY_EXECUTION_APPROVED','PAID_FIRST_GENERATION_TRIAL_ENABLED','PAID_FIRST_TRIAL_USD_COST_REVIEWED'].some(name=>baseline.runtimeFlags[name]!=='true'))fail('RUNTIME_FLAGS_BASELINE_INVALID');
  for(const [name,value] of Object.entries(expectedFlags)){
    if(bindings.get(name)?.text!==value)fail('RUNTIME_FLAGS_MISMATCH');
  }
  if(typeof bindings.get('ACCESS_AUD')?.text!=='string'||bindings.get('ACCESS_AUD').text.length<12||!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(bindings.get('ACCESS_TEAM_DOMAIN')?.text??''))fail('ACCESS_VARS_MISSING');
  if(!postDeploy&&(typeof baseline.sourceCommit!=='string'||!/^[0-9a-f]{40}$/.test(baseline.sourceCommit)||remote.deploymentMessage!==`source-commit:${baseline.sourceCommit}`)){
   const expected=baseline,evidence=preDeployLineage;
   // Script ETag proves only script content. Current assets and settings are
   // checked separately above; this exception never applies after upload.
   if(baseline.activeVersionId!==expected.activeVersionId||baseline.sourceCommit!==expected.sourceCommit||remote.activeVersions[0].id!==expected.activeVersionId||typeof remote.deploymentMessage!=='string'||!evidence||evidence.activeVersionId!==expected.activeVersionId||evidence.priorVersionId!==expected.priorVersionId||evidence.activeDeploymentSourceAnnotation!=='OTHER'||evidence.priorDeploymentSourceAnnotation!=='EXPECTED'||evidence.activeDeploymentSource!=='DASHBOARD'||evidence.priorDeploymentSource!=='WRANGLER'||evidence.scriptEtagMatchesPinned!==true||evidence.scriptContentEqual!==true||evidence.runtimeMetadataComplete!==true||evidence.runtimeMetadataEqual!==true||evidence.knownBindingAddition!==true||evidence.activeAssetsBindingCount!==1||evidence.priorAssetsBindingCount!==1||evidence.codeLineageEvidence!=='SAME_SCRIPT_AND_SETTINGS_AS_ANNOTATED_PRIOR'||evidence.sourceAnnotationGuardMatch!==false)fail('SOURCE_COMMIT_MISMATCH');
  }
  return true;
}
