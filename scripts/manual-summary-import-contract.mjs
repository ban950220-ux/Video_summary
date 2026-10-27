// OFFLINE design validator only. No endpoint, database, credentials or provider.
// Inputs must be explicitly supplied minified JSON. They are NOT authenticated.
import {createHash} from 'node:crypto';

export const MANUAL_IMPORT_CONTRACT='OFFLINE_MANUAL_SUMMARY_IMPORT_V1';
export const MAX_IMPORTED_SUMMARY_BYTES=1_000_000;
export const productionExecutionSupported=false;
const maxJsonBytes=16_000_000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
const digest=value=>hash(stable(value));
const own=(value,key)=>Object.hasOwn(value,key);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const int=value=>Number.isSafeInteger(value)&&value>=0;
const provenance=value=>['ASSISTANT_AUTHORED_IMPORTED_SUMMARY','MANUAL_IMPORTED'].includes(value);
class ImportContractError extends Error{constructor(code){super('MANUAL_IMPORT_'+code);this.code='MANUAL_IMPORT_'+code;}}
const fail=code=>{throw new ImportContractError(code);};
function fields(value,required,optional=[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||required.some(key=>!own(value,key))||Object.keys(value).some(key=>![...required,...optional].includes(key)))fail('SCHEMA_INVALID');
}
function parseInput(json){
 // A JSON string boundary avoids invoking getters, toJSON, custom prototypes,
 // iterators or code on caller-supplied JavaScript objects. No eval is used.
 if(typeof json!=='string'||Buffer.byteLength(json,'utf8')>maxJsonBytes)fail('JSON_INPUT_REQUIRED');
 let value;try{value=JSON.parse(json);}catch{fail('JSON_INVALID');}
 // Reject duplicate keys and alternate numeric/string spellings. This is an
 // explicit minified JSON transport contract, not a general JSON parser.
 if(JSON.stringify(value)!==json)fail('JSON_NON_CANONICAL');
 let nodes=0;
 function visit(item,depth){
  if(++nodes>200_000||depth>20)fail('JSON_LIMIT');
  if(typeof item==='number'&&!Number.isFinite(item))fail('JSON_INVALID');
  if(typeof item==='string'&&Buffer.from(item,'utf8').toString('utf8')!==item)fail('UNICODE_INVALID');
  if(item&&typeof item==='object')for(const [key,next] of Object.entries(item)){
   if(['__proto__','constructor','prototype'].includes(key))fail('JSON_INVALID');
   visit(next,depth+1);
  }
 }
 visit(value,0);return value;
}
function source(snapshot){
 fields(snapshot,['ownerId','jobId','videoId','durationMs','sourceProvenance','raw','segments']);
 if(!identity(snapshot.ownerId)||!uuid(snapshot.jobId)||typeof snapshot.videoId!=='string'||!/^[A-Za-z0-9_-]{11}$/.test(snapshot.videoId)||!int(snapshot.durationMs)||snapshot.durationMs<1||snapshot.durationMs>7_200_000||typeof snapshot.sourceProvenance!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/.test(snapshot.sourceProvenance)||typeof snapshot.raw!=='string'||!snapshot.raw.trim()||Buffer.byteLength(snapshot.raw,'utf8')>2_000_000||!Array.isArray(snapshot.segments)||snapshot.segments.length<1||snapshot.segments.length>50_000)fail('SOURCE_INVALID');
 let lastStart=-1,totalBytes=0;
 snapshot.segments.forEach((segment,index)=>{
  fields(segment,['id','startMs','endMs','text']);
  if(segment.id!==index+1||!int(segment.startMs)||!int(segment.endMs)||segment.startMs<lastStart||segment.endMs<=segment.startMs||segment.endMs>snapshot.durationMs||typeof segment.text!=='string'||!segment.text.trim())fail('SOURCE_SEGMENTS_INVALID');
  lastStart=segment.startMs;totalBytes+=Buffer.byteLength(segment.text,'utf8');
 });
 if(totalBytes>2_000_000)fail('SOURCE_INVALID');
 return {ownerId:snapshot.ownerId,jobId:snapshot.jobId,videoId:snapshot.videoId,durationMs:snapshot.durationMs,segmentCount:snapshot.segments.length,canonicalSourceSha256:digest(['MANUAL_SUMMARY_SOURCE_SNAPSHOT_V1',snapshot])};
}
/** A proposed canonical format; it is not an existing provider contract hash. */
export function manualSummarySourceSha256(sourceJson){
 try{return source(parseInput(sourceJson)).canonicalSourceSha256;}catch(error){if(error instanceof ImportContractError)throw error;fail('INPUT_INVALID');}
}
function artifact(value){
 fields(value,['mimeType','sizeBytes','sha256','utf8Base64'],['libraryFileId']);
 if(value.mimeType!=='text/plain'||!int(value.sizeBytes)||value.sizeBytes<1||value.sizeBytes>MAX_IMPORTED_SUMMARY_BYTES||!sha(value.sha256)||typeof value.utf8Base64!=='string'||value.utf8Base64.length>4*Math.ceil(MAX_IMPORTED_SUMMARY_BYTES/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.utf8Base64))fail('ARTIFACT_INVALID');
 if(own(value,'libraryFileId')&&(typeof value.libraryFileId!=='string'||!/^libfile_[A-Za-z0-9_-]{1,128}$/.test(value.libraryFileId)))fail('ARTIFACT_INVALID');
 const bytes=Buffer.from(value.utf8Base64,'base64');
 if(bytes.toString('base64')!==value.utf8Base64||bytes.length!==value.sizeBytes||hash(bytes)!==value.sha256)fail('ARTIFACT_BYTES_MISMATCH');
 let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('ARTIFACT_UTF8_INVALID');}
 // Preserve BOM, newline convention and all trailing bytes in the content/hash.
 // NUL/control bytes are not a supported plain-text summary format.
 if(!text.replace(/^\uFEFF/,'').trim()||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text))fail('ARTIFACT_TEXT_INVALID');
 return {mimeType:'text/plain;charset=utf-8',sizeBytes:bytes.length,sha256:value.sha256,hasUtf8Bom:bytes.subarray(0,3).equals(Buffer.from([239,187,191])),text,renderMode:'TEXT_CONTENT_ONLY',...(own(value,'libraryFileId')?{libraryFileId:value.libraryFileId}:{})};
}
function currentCapture(value,now){
 fields(value,['observedAtMs','deleted','readOnly','source']);
 if(typeof value.deleted!=='boolean'||typeof value.readOnly!=='boolean')fail('SCHEMA_INVALID');
 if(value.deleted)fail('JOB_DELETED');
 if(value.readOnly)fail('READ_ONLY');
 fresh(value.observedAtMs,now,'SOURCE_CAPTURE_STALE');
 return source(value.source);
}
function fresh(observed,now,code){if(!int(observed)||observed>now||now-observed>60_000)fail(code);}
function sourceBinding(target,current){
 fields(target,['ownerId','jobId','videoId','durationMs','segmentCount','canonicalSourceSha256']);
 if(!sha(target.canonicalSourceSha256))fail('SOURCE_HASH_REQUIRED');
 for(const key of Object.keys(current))if(target[key]!==current[key])fail('SOURCE_SCOPE_CHANGED');
}
function basis(value,current,content){
 if(!value)fail('BASIS_REVIEW_REQUIRED');
 fields(value,['method','canonicalSourceSha256','artifactSha256','basisEvidenceSha256']);
 if(!['AUTHOR_SOURCE_MANIFEST','OWNER_SOURCE_RECONCILIATION'].includes(value.method)||!sha(value.canonicalSourceSha256)||!sha(value.artifactSha256)||!sha(value.basisEvidenceSha256))fail('BASIS_REVIEW_REQUIRED');
 if(value.canonicalSourceSha256!==current.canonicalSourceSha256||value.artifactSha256!==content.sha256)fail('SOURCE_BASIS_MISMATCH');
 return {...value,evidenceAuthentication:'NOT_VERIFIED'};
}
function inventory(value,current,now){
 fields(value,['ownerId','jobId','observedAtMs','complete','attachments','requests']);
 if(value.ownerId!==current.ownerId||value.jobId!==current.jobId||value.complete!==true||!Array.isArray(value.attachments)||!Array.isArray(value.requests)||value.attachments.length>1000||value.requests.length>5000)fail('INVENTORY_INVALID');
 fresh(value.observedAtMs,now,'INVENTORY_STALE');
 const ids=new Set(),revisions=new Set(),requestIds=new Set();
 for(const item of value.attachments){
  fields(item,['attachmentId','revision','canonicalSourceSha256','artifactSha256','provenance']);
  if(!uuid(item.attachmentId)||ids.has(item.attachmentId)||!int(item.revision)||item.revision<1||revisions.has(item.revision)||!sha(item.canonicalSourceSha256)||!sha(item.artifactSha256)||!provenance(item.provenance))fail('INVENTORY_INVALID');
  ids.add(item.attachmentId);revisions.add(item.revision);
 }
 for(const item of value.requests){
  fields(item,['requestId','requestFingerprintSha256','state','attachmentId']);
  if(!uuid(item.requestId)||requestIds.has(item.requestId)||!sha(item.requestFingerprintSha256)||!['COMMITTED','UNCERTAIN','REJECTED'].includes(item.state)||(item.state==='COMMITTED'?!ids.has(item.attachmentId):item.attachmentId!==null))fail('INVENTORY_INVALID');
  requestIds.add(item.requestId);
 }
 return digest(['MANUAL_SUMMARY_IMPORT_INVENTORY_V1',{ownerId:value.ownerId,jobId:value.jobId,attachments:value.attachments,requests:value.requests}]);
}
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const guarantees=()=>({kind:MANUAL_IMPORT_CONTRACT,productionExecutionSupported:false,provenanceAuthenticated:false,permissionVerified:false,importReady:false,automaticPipelineCompleted:false,writesPerformed:0,providerCalls:0,countTokensCalls:0,protectedExistingFields:['jobs.report_json','jobs.status','jobs.audit_json','jobs.updated_at','yta_sources.*','audio chunks','provider operations','approvals','billing receipts','usage events']});

/**
 * Validates supplied claims and returns an append-only proposal, never a write.
 * Canonical source equality does not authenticate the summary's authored basis.
 * A real owner-authenticated read/preview/transaction/readback path is absent.
 */
export function previewManualSummaryImport(inputJson){
 try{
  const input=parseInput(inputJson);fields(input,['contract','nowMs','access','current','request','inventory']);
  if(input.contract!==MANUAL_IMPORT_CONTRACT||!int(input.nowMs)||!Number.isFinite(new Date(input.nowMs).getTime()))fail('SCHEMA_INVALID');
  fields(input.access,['ownerId','permission']);
  if(input.access.permission!=='OWNER_WRITE')fail('OWNER_WRITE_REQUIRED');
  const scope=currentCapture(input.current,input.nowMs);
  if(input.access.ownerId!==scope.ownerId)fail('OWNER_MISMATCH');
  const request=input.request;
  fields(request,['requestId','target','provenance','artifact','authoredBasis','acknowledgements']);
  if(!uuid(request.requestId)||!provenance(request.provenance))fail('REQUEST_INVALID');
  sourceBinding(request.target,scope);
  fields(request.acknowledgements,['preserveExistingRecords','importIsNotAutomaticCompletion','sourceAccuracyNotVerified']);
  if(Object.values(request.acknowledgements).some(value=>value!==true))fail('ACKNOWLEDGEMENT_REQUIRED');
  const content=artifact(request.artifact),authoredBasis=basis(request.authoredBasis,scope,content);
  const inventorySha256=inventory(input.inventory,scope,input.nowMs);
  const requestFingerprintSha256=digest(['MANUAL_SUMMARY_IMPORT_REQUEST_V1',request]);
  const common={...guarantees(),sourceBinding:{...scope,status:'MATCHES_SUPPLIED_HASH_CLAIMS_ONLY'},requestId:request.requestId,requestFingerprintSha256,inventorySha256};
  const duplicates=input.inventory.attachments.filter(item=>item.canonicalSourceSha256===scope.canonicalSourceSha256&&item.artifactSha256===content.sha256);
  // A committed replay does not make duplicate attachment history consistent.
  if(duplicates.length>1)fail('DUPLICATE_ATTACHMENTS_REQUIRE_REVIEW');
  const prior=input.inventory.requests.find(item=>item.requestId===request.requestId);
  if(prior&&prior.requestFingerprintSha256!==requestFingerprintSha256)fail('REQUEST_ID_CONFLICT');
  if(prior?.state==='COMMITTED'){
   const attachment=input.inventory.attachments.find(item=>item.attachmentId===prior.attachmentId);
   if(attachment.canonicalSourceSha256!==scope.canonicalSourceSha256||attachment.artifactSha256!==content.sha256||attachment.provenance!==request.provenance)fail('REPLAY_CONFLICT');
   return freeze({...common,outcome:'ALREADY_IMPORTED',structuralPreviewReady:false,existingAttachmentId:attachment.attachmentId,nextAction:'READ_EXISTING_ATTACHMENT_ONLY'});
  }
  if(prior?.state==='REJECTED')fail('PREVIOUS_REQUEST_REJECTED');
  const uncertain=input.inventory.requests.filter(item=>item.state==='UNCERTAIN');
  if(uncertain.length)return freeze({...common,outcome:'RECONCILE_READ_ONLY',structuralPreviewReady:false,uncertainRequestIds:uncertain.map(item=>item.requestId),nextAction:'READ_IMPORT_OPERATION_AND_ATTACHMENT_ONLY',automaticRetryAllowed:false});
  if(duplicates.length){
   if(duplicates[0].provenance!==request.provenance)fail('PROVENANCE_CONFLICT');
   return freeze({...common,outcome:'ALREADY_IMPORTED',structuralPreviewReady:false,existingAttachmentId:duplicates[0].attachmentId,nextAction:'READ_EXISTING_ATTACHMENT_ONLY'});
  }
  const latestRevision=Math.max(0,...input.inventory.attachments.map(item=>item.revision));
  if(latestRevision===Number.MAX_SAFE_INTEGER)fail('REVISION_EXHAUSTED');
  return freeze({...common,outcome:'APPEND_CANDIDATE',structuralPreviewReady:true,
   candidate:{collection:'SEPARATE_IMPORTED_SUMMARY_ATTACHMENTS',proposedRevision:latestRevision+1,provenance:request.provenance,providerExecution:'NOT_RUN_BY_APP',audioAccuracy:'NOT_VERIFIED',externalFactCheck:'NOT_PERFORMED',meaningReview:'NOT_ESTABLISHED_BY_THIS_VALIDATOR',automaticPipelineCompleted:false,authoredBasis,artifact:content},
   nextAction:'IMPLEMENT_AND_REVIEW_OWNER_AUTHENTICATED_IMPORT_BEFORE_ANY_WRITE',
   requiredBeforeWrite:['AUTHENTICATE_OWNER_AND_SAME_ORIGIN','VERIFY_AUTHORED_BASIS_EVIDENCE','RECHECK_SOURCE_AND_DELETION_IN_ATOMIC_APPEND','RESERVE_REQUEST_ID_AND_CONTENT_SOURCE_DEDUP_ATOMICALLY','PRESERVE_EVERY_EXISTING_JOB_SOURCE_AND_PROVIDER_FIELD','READ_BACK_LIST_DETAIL_AND_EXACT_UTF8_EXPORT'],
   automaticRetryAllowed:false});
 }catch(error){if(error instanceof ImportContractError)throw error;fail('INPUT_INVALID');}
}
