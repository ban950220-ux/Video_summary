// Pure OFFLINE projection of explicitly supplied, non-secret captures.
// No fetch, credential access, provenance authentication or production wiring.
import {createHash} from 'node:crypto';
import {target,validateObservation} from './exact-version-release-proposal.mjs';

export const captureFormat='CLOUDFLARE_NON_SECRET_RELEASE_CAPTURES_V1';
export const productionExecutionSupported=false;
const prefix='RELEASE_CAPTURE_';
class ProjectionError extends Error {constructor(code){super(prefix+code);}}
const fail=code=>{throw new ProjectionError(code);};
const own=(x,key)=>Object.hasOwn(x,key);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const workerId=x=>typeof x==='string'&&(/^[a-f0-9]{32}$/.test(x)||uuid(x));
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const iso=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const dateTime=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x));
const text=x=>typeof x==='string'&&x.length<=10000;
const bool=x=>typeof x==='boolean';
const rate=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1;
const strings=x=>Array.isArray(x)&&x.length<=1000&&x.every(text);
const empty=x=>Array.isArray(x)&&x.length===0;
const stable=x=>JSON.stringify(x,(_,v)=>record(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
const digest=x=>createHash('sha256').update(stable(x)).digest('hex');
const copy=x=>JSON.parse(JSON.stringify(x));
function fields(x,required,optional=[],code='SCHEMA_UNSUPPORTED'){
 if(!record(x)||required.some(key=>!own(x,key))||Object.keys(x).some(key=>![...required,...optional].includes(key)))fail(code);
}
function types(x,schema,code='SCHEMA_UNSUPPORTED'){
 for(const key of Object.keys(x))if(!schema[key]?.(x[key]))fail(code);
}
function cleanJson(x){
 let count=0;const seen=new Set();
 function visit(value,depth){
  if(++count>20000||depth>20)fail('INPUT_INVALID');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))fail('INPUT_INVALID');return;}
  if(typeof value==='string'){if(value.length>200000)fail('INPUT_INVALID');return;}
  if((!record(value)&&!Array.isArray(value))||seen.has(value))fail('INPUT_INVALID');
  seen.add(value);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(descriptors.type?.value==='secret_text'&&(own(descriptors,'text')||own(descriptors,'value')))fail('SECRET_VALUE_INPUT');
  if(own(descriptors,'jwt'))fail('SECRET_VALUE_INPUT');
  if(Array.isArray(value)&&Object.keys(value).length!==value.length)fail('INPUT_INVALID');
  for(const key of Reflect.ownKeys(value)){
   if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key))fail('INPUT_INVALID');
   const descriptor=descriptors[key];
   if(!own(descriptor,'value')||(!descriptor.enumerable&&!(key==='length'&&Array.isArray(value))))fail('INPUT_INVALID');
   if(Array.isArray(value)&&key!=='length'&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=value.length))fail('INPUT_INVALID');
   if(key!=='length'||!Array.isArray(value))visit(descriptor.value,depth+1);
  }
  seen.delete(value);
 }
 visit(x,0);
}
function observability(value){
 fields(value,['enabled','head_sampling_rate','redact_query_string','logs','traces'],['issues'],'WORKER_SETTINGS_INCOMPLETE');
 types(value,{enabled:bool,head_sampling_rate:rate,redact_query_string:bool,logs:record,traces:record,issues:record});
 fields(value.logs,['enabled','head_sampling_rate','invocation_logs','persist'],['destinations']);
 types(value.logs,{enabled:bool,head_sampling_rate:rate,invocation_logs:bool,persist:bool,destinations:strings});
 fields(value.traces,['enabled','head_sampling_rate','persist'],['destinations','propagation_policy']);
 types(value.traces,{enabled:bool,head_sampling_rate:rate,persist:bool,destinations:strings,propagation_policy:x=>x===null||['authenticated','accept'].includes(x)});
 if(own(value,'issues')){fields(value.issues,['enabled']);types(value.issues,{enabled:bool});}
}
function worker(value){
 fields(value,['id','created_on','logpush','name','observability','references','subdomain','tags','tail_consumers','updated_on'],['deployed_on'],'WORKER_SETTINGS_INCOMPLETE');
 if(!workerId(value.id)||value.name!==target.workerName||!dateTime(value.created_on)||!dateTime(value.updated_on)||!bool(value.logpush)||!strings(value.tags)||!empty(value.tail_consumers)||(own(value,'deployed_on')&&!dateTime(value.deployed_on)))fail('WORKER_SETTINGS_UNSUPPORTED');
 observability(value.observability);
 fields(value.references,['dispatch_namespace_outbounds','domains','durable_objects','queues','workers']);
 if(!Object.values(value.references).every(empty))fail('WORKER_REFERENCES_UNREVIEWED');
 fields(value.subdomain,['enabled','previews_enabled'],['preview_url_suffix','url'],'WORKER_SETTINGS_INCOMPLETE');
 types(value.subdomain,{enabled:bool,previews_enabled:bool,preview_url_suffix:text,url:text});
 // Optional field presence remains part of the digest; no false/null/[] defaults.
 return {id:value.id,name:value.name,settings:{logpush:value.logpush,observability:copy(value.observability),references:copy(value.references),subdomain:copy(value.subdomain),tags:copy(value.tags),tail_consumers:copy(value.tail_consumers)}};
}
function annotations(value,version=false){
 fields(value,[],version?['workers/message','workers/tag','workers/triggered_by']:['workers/message','workers/triggered_by']);
 if(!Object.values(value).every(text))fail('SCHEMA_UNSUPPORTED');
}
function deployment(value){
 fields(value,['id','created_on','source','strategy','versions'],['annotations','author_email']);
 if(!uuid(value.id)||!dateTime(value.created_on)||!text(value.source)||value.strategy!=='percentage'||!Array.isArray(value.versions)||value.versions.length!==1)fail('BASELINE_NOT_ACTIVE');
 const active=value.versions[0];fields(active,['version_id','percentage']);
 if(active.version_id!==target.baselineVersionId||active.percentage!==100)fail('BASELINE_NOT_ACTIVE');
 if(own(value,'annotations'))annotations(value.annotations);
 if(own(value,'author_email')&&!text(value.author_email))fail('SCHEMA_UNSUPPORTED');
 return {id:value.id,versions:[{version_id:active.version_id,percentage:active.percentage}]};
}
function version(value,omittedSecretTextBindings){
 fields(value,['id','created_on','number','urls','bindings','compatibility_date','compatibility_flags','assets'],['annotations','author_email','author_id','main_module','source','startup_time_ms'],'VERSION_SETTINGS_UNSUPPORTED');
 if(value.id!==target.baselineVersionId||!dateTime(value.created_on)||!Number.isSafeInteger(value.number)||value.number<1||!strings(value.urls)||value.compatibility_date!=='2026-10-10'||!empty(value.compatibility_flags))fail('VERSION_SETTINGS_UNSUPPORTED');
 for(const key of ['author_email','author_id','main_module','source'])if(own(value,key)&&!text(value[key]))fail('SCHEMA_UNSUPPORTED');
 if(own(value,'startup_time_ms')&&(!Number.isFinite(value.startup_time_ms)||value.startup_time_ms<0))fail('SCHEMA_UNSUPPORTED');
 if(own(value,'annotations'))annotations(value.annotations,true);
 if(record(value.assets)&&own(value.assets,'jwt'))fail('SECRET_VALUE_INPUT');
 fields(value.assets,['config'],[],'ASSET_SETTINGS_UNSUPPORTED');
 fields(value.assets.config,['run_worker_first'],[],'ASSET_SETTINGS_UNSUPPORTED');
 if(value.assets.config.run_worker_first!==true)fail('ASSET_SETTINGS_UNSUPPORTED');
 if(!Array.isArray(value.bindings)||value.bindings.length>100||!strings(omittedSecretTextBindings)||new Set(omittedSecretTextBindings).size!==omittedSecretTextBindings.length)fail('BINDINGS_INVALID');
 const omitted=[],names=new Set(),bindings=[];
 for(const b of value.bindings){
  if(!record(b)||typeof b.name!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(b.name)||names.has(b.name))fail('BINDINGS_INVALID');
  names.add(b.name);
  if(b.type==='secret_text'){
   // Even null, empty or masked text is rejected. No secret value is inspected.
   if(own(b,'text')||own(b,'value'))fail('SECRET_VALUE_INPUT');
   fields(b,['name','type'],[],'BINDING_FIELDS_UNSUPPORTED');omitted.push(b.name);
   bindings.push({name:b.name,type:b.type});
  }else if(b.type==='plain_text'){
   fields(b,['name','type','text'],[],'PLAIN_BINDING_VALUE_MISSING');
   if(!text(b.text))fail('BINDINGS_INVALID');
   // Permitted plain values are checked in memory only, never returned or logged.
   bindings.push({name:b.name,type:b.type});
  }else if(b.type==='d1'){
   fields(b,['name','type','database_id'],['id'],'D1_IDENTIFIER_INVALID');
   if(b.name!=='DB'||b.database_id!==target.databaseId||(own(b,'id')&&b.id!==b.database_id))fail('D1_IDENTIFIER_INVALID');
   bindings.push({name:b.name,type:b.type,id:b.database_id});
  }else if(b.type==='assets'){
   fields(b,['name','type'],[],'BINDING_FIELDS_UNSUPPORTED');bindings.push({name:b.name,type:b.type});
  }else fail('BINDING_TYPE_UNSUPPORTED');
 }
 if(stable(omitted.sort())!==stable([...omittedSecretTextBindings].sort()))fail('SECRET_OMISSIONS_UNACCOUNTED');
 return {id:value.id,bindings:bindings.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),compatibility_date:value.compatibility_date,compatibility_flags:copy(value.compatibility_flags),assets:{config:copy(value.assets.config)},unsupportedFields:[]};
}
function envelope(capture,path,query,now,window){
 fields(capture,['request','startedAt','completedAt','response']);
 fields(capture.request,['method','path','query']);
 if(capture.request.method!=='GET'||capture.request.path!==path||stable(capture.request.query)!==stable(query))fail('REQUEST_TARGET_MISMATCH');
 if(!iso(capture.startedAt)||!iso(capture.completedAt))fail('COLLECTION_TIME_INVALID');
 const start=Date.parse(capture.startedAt),end=Date.parse(capture.completedAt);
 if(start>end||end>now||now-start>60000)fail('COLLECTION_STALE');
 if(start<Date.parse(window.startsAt)||end>=Date.parse(window.expiresAt))fail('COLLECTION_OUTSIDE_WRITER_WINDOW');
 fields(capture.response,['success','errors','messages','result'],['result_info']);
 if(capture.response.success!==true||!empty(capture.response.errors)||!empty(capture.response.messages))fail('API_RESPONSE_UNCONFIRMED');
 if(own(capture.response,'result_info')){
  const info=capture.response.result_info;fields(info,[],['count','page','per_page','total_count','total_pages']);
  if(Object.values(info).some(x=>!Number.isSafeInteger(x)||x<0)||(own(info,'page')&&info.page!==1)||(own(info,'per_page')&&info.per_page!==1))fail('PAGINATION_UNSUPPORTED');
  const deployments=capture.response.result?.deployments;
  if(query.page!==1||query.per_page!==1||!Array.isArray(deployments))fail('PAGINATION_UNSUPPORTED');
  if((own(info,'count')&&info.count!==deployments.length)||(own(info,'total_count')&&info.total_count<Math.max(1,deployments.length))||(own(info,'total_pages')&&info.total_pages<1))fail('PAGINATION_UNSUPPORTED');
  // Fixed, unfiltered per_page=1 means one result per page. Absent fields stay absent.
  if(own(info,'total_count')&&own(info,'total_pages')&&info.total_count!==info.total_pages)fail('PAGINATION_UNSUPPORTED');
 }
 return capture.response.result;
}
function evidence(value,now){
 fields(value,['scope','apiCompatibility','compatibilityEvidenceDigest','masterFalseWriteEvidenceDigest','nonSecretCaptureReviewEvidenceDigest','singleWriter'],[],'EXTERNAL_EVIDENCE_REQUIRED');
 fields(value.scope,['accountId','workerId','workerName','baselineVersionId','activeDeploymentId'],[],'EVIDENCE_SCOPE_INVALID');
 const s=value.scope;
 if(s.accountId!==target.accountId||!workerId(s.workerId)||s.workerName!==target.workerName||s.baselineVersionId!==target.baselineVersionId||!uuid(s.activeDeploymentId))fail('EVIDENCE_SCOPE_INVALID');
 if(value.apiCompatibility!=='EXACT_VERSION_INHERIT_CONFIRMED'||!sha(value.compatibilityEvidenceDigest)||!sha(value.masterFalseWriteEvidenceDigest)||!sha(value.nonSecretCaptureReviewEvidenceDigest))fail('EXTERNAL_EVIDENCE_REQUIRED');
 const w=value.singleWriter;fields(w,['confirmed','windowId','startsAt','expiresAt','evidenceDigest'],[],'WRITER_EVIDENCE_REQUIRED');
 if(w.confirmed!==true||!uuid(w.windowId)||!iso(w.startsAt)||!iso(w.expiresAt)||!sha(w.evidenceDigest)||Date.parse(w.startsAt)>now||Date.parse(w.expiresAt)<=now)fail('WRITER_EVIDENCE_REQUIRED');
 return value;
}

/**
 * Validate supplied capture claims, not their authenticity or collection authority.
 * Secret-text omissions are an explicit local capture format, NOT an asserted
 * Cloudflare raw-response schema. A reviewed collector remains unimplemented.
 */
export function projectReleaseObservation(input){
 try{
  cleanJson(input);fields(input,['captures','externalEvidence','now']);
  const {captures:c,now}=input;
  if(!Number.isSafeInteger(now)||now<0||!Number.isFinite(new Date(now).getTime()))fail('CURRENT_TIME_INVALID');
  const e=evidence(input.externalEvidence,now);
  fields(c,['format','accountId','worker','deployments','version','omittedSecretTextBindings']);
  if(c.format!==captureFormat||c.accountId!==target.accountId)fail('CAPTURE_FORMAT_OR_ACCOUNT_INVALID');
  const root=`/accounts/${target.accountId}/workers`;
  const w=worker(envelope(c.worker,`${root}/workers/${target.workerName}`,{},now,e.singleWriter));
  if(w.id!==e.scope.workerId)fail('WORKER_IDENTITY_MISMATCH');
  const list=envelope(c.deployments,`${root}/scripts/${target.workerName}/deployments`,{page:1,per_page:1},now,e.singleWriter);
  fields(list,['deployments']);
  if(!Array.isArray(list.deployments)||list.deployments.length!==1)fail('ACTIVE_DEPLOYMENT_MISSING');
  const active=deployment(list.deployments[0]);
  if(active.id!==e.scope.activeDeploymentId)fail('DEPLOYMENT_EVIDENCE_MISMATCH');
  const v=version(envelope(c.version,`${root}/workers/${w.id}/versions/${target.baselineVersionId}`,{},now,e.singleWriter),c.omittedSecretTextBindings);
  // Earliest collection START is conservative: a late finish cannot refresh old data.
  const observedAt=[c.worker.startedAt,c.deployments.startedAt,c.version.startedAt].sort()[0];
  const workerSettingsDigest=digest(['GET_WORKER_SETTINGS_PROJECTION_V1',{accountId:c.accountId,workerId:w.id,workerName:w.name},w.settings]);
  const observation={accountId:c.accountId,worker:{id:w.id,name:w.name},apiCompatibility:e.apiCompatibility,compatibilityEvidenceDigest:e.compatibilityEvidenceDigest,observedAt,activeDeployment:active,version:v,workerSettingsDigest,masterFalseWriteEvidenceDigest:e.masterFalseWriteEvidenceDigest,singleWriter:copy(e.singleWriter)};
  // Keep the original baseline and binding policy; never substitute projection defaults.
  try{validateObservation(observation,now);}catch{fail('EXISTING_OBSERVATION_GUARD_REJECTED');}
  return {kind:'OFFLINE_SUPPLIED_CAPTURE_PROJECTION_V1',productionExecutionSupported:false,provenanceAuthenticated:false,permissionVerified:false,
   offlineObservation:observation,
   reviewReferences:{nonSecretCaptureReviewEvidenceDigest:e.nonSecretCaptureReviewEvidenceDigest},
   coverage:{workerSettings:'GET_WORKER_RESPONSE_SETTINGS_ONLY',bindingValues:'NOT_RETURNED_OR_PROVEN',secretResponseOmissions:'EXPLICIT_LOCAL_CAPTURE_CONTRACT_NOT_RAW_API_SCHEMA'},
   unresolvedGates:['CAPTURE_PROVENANCE_AND_PERMISSION_NOT_AUTHENTICATED','VALUE_FREE_VERSION_RESPONSE_BEHAVIOR_NOT_ESTABLISHED','EXTERNAL_EVIDENCE_CONTENT_NOT_VERIFIED','ROUTES_ACCESS_AND_BUILD_SETTINGS_NOT_CAPTURED','PRODUCTION_TRANSPORT_NOT_IMPLEMENTED']};
 }catch(error){
  // Never echo remote errors, annotations, keys, values, getters or arbitrary errors.
  if(error instanceof ProjectionError)throw error;
  fail('INPUT_INVALID');
 }
}
