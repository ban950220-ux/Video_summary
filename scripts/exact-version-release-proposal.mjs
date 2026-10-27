// OFFLINE PROPOSAL ONLY: no fetch, credentials, CLI, production wiring or auto activation.
// Review booleans/digests below are fixture claims, not an authorization verifier.
import {createHash,randomUUID} from 'node:crypto';
import {extname} from 'node:path';
import {inspectBindingSet} from './remote-state-policy.mjs';
import {localReleaseStore} from './offline-release-store.mjs';

export const target=Object.freeze({accountId:'fe9d7e2a164274b1ff6cef150a75cb0b',workerName:'holy-rice-b914',databaseId:'d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34',baselineVersionId:'adc0e786-5fdf-4daf-bea1-02304de1e1b0',candidateCommit:'6c3f309c30f270d696fecc581cd928532c767499',candidateTree:'d5ac6ab65696e06484809794867610f6658fa97a',assetDigest:'09e9fdd7ae49f3753818f7566219db990909f9822fa27d8c2dfef90fca041467'});
const fail=code=>{throw Error(code);};
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const stable=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export const hash=x=>createHash('sha256').update(x).digest('hex');
const digest=x=>hash(stable(x));
const exact=(x,fields,code)=>{if(!x||Array.isArray(x)||typeof x!=='object'||Object.keys(x).sort().join('|')!==[...fields].sort().join('|'))fail(code);};
const iso=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x));
const frozen=x=>JSON.parse(JSON.stringify(x));
const intents='REPLACE_REVIEWED_CODE_AND_ASSETS_KEEP_BASELINE_BINDINGS';
const assertNow=now=>{if(!Number.isSafeInteger(now)||now<0||!Number.isFinite(new Date(now).getTime()))fail('CURRENT_TIME_INVALID');};

export function reviewedAssets(files){
 if(!Array.isArray(files)||!files.length)fail('ASSETS_EMPTY');
 const seen=new Set();
 const rows=files.map(f=>{
  exact(f,['path','bytes'],'ASSET_FIELDS');
  if(typeof f.path!=='string'||!/^web\/site\/[A-Za-z0-9_./-]+$/.test(f.path)||f.path.includes('..')||seen.has(f.path)||!(f.bytes instanceof Uint8Array))fail('ASSET_PATH_OR_BYTES');
  seen.add(f.path);const bytes=Buffer.from(f.bytes),extension=extname(f.path).slice(1);
  return {path:f.path,bytes,sha256:hash(bytes),apiHash:hash(bytes.toString('base64')+extension).slice(0,32)};
 }).sort((a,b)=>a.path<b.path?-1:1);
 const assetDigest=hash(JSON.stringify(['COMPLETE_ASSET_MANIFEST_V1',rows.map(r=>[r.path,r.sha256])]));
 if(assetDigest!==target.assetDigest)fail('CANDIDATE_ASSET_MANIFEST_MISMATCH');
 const apiManifest=Object.fromEntries(rows.map(r=>['/'+r.path.slice('web/site/'.length),{hash:r.apiHash,size:r.bytes.length}]));
 return {assetDigest,apiManifest,rows};
}

export function packageCandidate({files,modules,main_module}){
 const assets=reviewedAssets(files);
 if(!Array.isArray(modules)||!modules.length||modules.length>64)fail('MODULES_MISSING');
 const names=new Set();
 for(const m of modules){
  exact(m,['name','content_type','content_base64'],'MODULE_FIELDS');
  if(typeof m.name!=='string'||!m.name||m.name.includes('..')||names.has(m.name)||typeof m.content_type!=='string'||!m.content_type||typeof m.content_base64!=='string'||Buffer.from(m.content_base64,'base64').toString('base64')!==m.content_base64)fail('MODULE_INVALID');names.add(m.name);
 }
 if(!names.has(main_module))fail('MAIN_MODULE_MISSING');
 const copy=frozen(modules).sort((a,b)=>a.name<b.name?-1:1);
 return {assets,modules:copy,main_module,moduleDigest:digest({modules:copy,main_module}),productionExecutionSupported:false};
}

// These are normalized, non-secret observations; they are NOT invented API fields.
// A future approved reader must produce them. No reader is implemented here.
export function observationDigest(o){const {observedAt,...rest}=o;return digest(rest);}
export function validateObservation(o,now,{activeVersionId=target.baselineVersionId,historical=false}={}){
 assertNow(now);
 exact(o,['accountId','worker','apiCompatibility','compatibilityEvidenceDigest','observedAt','activeDeployment','version','workerSettingsDigest','masterFalseWriteEvidenceDigest','singleWriter'],'OBSERVATION_FIELDS');
 exact(o.worker,['id','name'],'WORKER_IDENTITY_UNKNOWN');
 if(o.accountId!==target.accountId||!(/^[a-f0-9]{32}$/.test(o.worker.id??'')||uuid(o.worker.id))||o.worker.name!==target.workerName)fail('WORKER_IDENTITY_UNKNOWN');
 if(o.apiCompatibility!=='EXACT_VERSION_INHERIT_CONFIRMED'||!sha(o.compatibilityEvidenceDigest))fail('API_COMPATIBILITY_UNKNOWN');
 if(!iso(o.observedAt)||Date.parse(o.observedAt)>now||(!historical&&now-Date.parse(o.observedAt)>60000))fail('OBSERVATION_STALE');
 exact(o.activeDeployment,['id','versions'],'DEPLOYMENT_METADATA');
 if(!uuid(o.activeDeployment.id)||stable(o.activeDeployment.versions)!==stable([{version_id:activeVersionId,percentage:100}]))fail('BASELINE_NOT_ACTIVE');
 exact(o.version,['id','bindings','compatibility_date','compatibility_flags','assets','unsupportedFields'],'VERSION_METADATA');
 const v=o.version;
 if(v.id!==target.baselineVersionId||v.compatibility_date!=='2026-10-10'||stable(v.compatibility_flags)!=='[]'||stable(v.unsupportedFields)!=='[]'||stable(v.assets)!==stable({config:{run_worker_first:true}}))fail('VERSION_SETTINGS_UNSUPPORTED');
 if(!inspectBindingSet(v.bindings,{expectAssets:true}).complete)fail('BINDING_SET_UNREVIEWED');
 for(const b of v.bindings){exact(b,b.name==='DB'?['name','type','id']:['name','type'],'BINDING_VALUE_OR_METADATA_UNSUPPORTED');if(b.name==='DB'&&b.id!==target.databaseId)fail('DATABASE_MISMATCH');}
 if(!sha(o.workerSettingsDigest)||!sha(o.masterFalseWriteEvidenceDigest))fail('NON_SECRET_EVIDENCE_MISSING');
 exact(o.singleWriter,['confirmed','windowId','startsAt','expiresAt','evidenceDigest'],'WRITER_WINDOW_MISSING');
 const w=o.singleWriter;
 if(w.confirmed!==true||!uuid(w.windowId)||!sha(w.evidenceDigest)||!iso(w.startsAt)||!iso(w.expiresAt)||Date.parse(w.startsAt)>now||(!historical&&Date.parse(w.expiresAt)<=now))fail('WRITER_WINDOW_MISSING');
 // A recent snapshot can still predate exclusive ownership of the write window.
 // Historical evidence remains usable for read-only reconciliation only.
 if(!historical&&Date.parse(o.observedAt)<Date.parse(w.startsAt))fail('OBSERVATION_BEFORE_WRITER_WINDOW');
 return true;
}

function validateApproval(a,o,p,now){
 assertNow(now);
 exact(a,['approvalId','reviewedAt','expiresAt','ownerEvidenceDigest','independentReviewDigest','observationDigest','moduleDigest','assetDigest','intent','maxVersionCreates','maxPromotions','automaticRetries'],'APPROVAL_MISSING');
 if(!uuid(a.approvalId)||!iso(a.reviewedAt)||!iso(a.expiresAt)||Date.parse(a.reviewedAt)>now||now>=Date.parse(a.expiresAt)||Date.parse(a.expiresAt)-Date.parse(a.reviewedAt)>900000||Date.parse(a.expiresAt)>Date.parse(o.singleWriter.expiresAt))fail('APPROVAL_EXPIRED');
 if(!sha(a.ownerEvidenceDigest)||!sha(a.independentReviewDigest)||a.observationDigest!==observationDigest(o)||a.moduleDigest!==p.moduleDigest||a.assetDigest!==target.assetDigest||a.intent!==intents||a.maxVersionCreates!==1||a.maxPromotions!==1||a.automaticRetries!==0)fail('APPROVAL_UNBOUND');
}
export function operationKey(o,p){
 // Approval ID deliberately excluded: a new approval cannot reset this operation.
 return digest({accountId:target.accountId,workerId:o.worker.id,workerName:target.workerName,baseline:target.baselineVersionId,commit:target.candidateCommit,tree:target.candidateTree,moduleDigest:p.moduleDigest,assetDigest:target.assetDigest,intent:intents});
}
function checkedPackage(p){
 const rebuilt=packageCandidate({files:p.assets.rows.map(r=>({path:r.path,bytes:r.bytes})),modules:p.modules,main_module:p.main_module});
 if(rebuilt.moduleDigest!==p.moduleDigest||stable(rebuilt.assets.apiManifest)!==stable(p.assets.apiManifest))fail('PACKAGE_CHANGED');return rebuilt;
}
function createBody(o,p,jwt,tag){return {annotations:{'workers/message':`source-commit:${target.candidateCommit}`,'workers/tag':tag},bindings:o.version.bindings.map(b=>b.type==='assets'?{name:b.name,type:'assets'}:{name:b.name,type:'inherit',version_id:target.baselineVersionId}),compatibility_date:o.version.compatibility_date,compatibility_flags:o.version.compatibility_flags,assets:{config:o.version.assets.config,jwt},main_module:p.main_module,modules:p.modules};}
const base=`/accounts/${target.accountId}/workers`;
const result=r=>{if(r?.success!==true||!r.result)fail('API_RESULT_UNCERTAIN');return r.result;};

// Normalize the documented D1 response at the API boundary. Internal reviewed
// observations retain their existing `id` field; neither alias may conceal drift.
function createdBindingMetadata(b){
 if(b?.name!=='DB')return {name:b?.name,type:b?.type};
 const canonical=Object.hasOwn(b,'database_id'),legacy=Object.hasOwn(b,'id');
 if((!canonical&&!legacy)||(canonical&&!uuid(b.database_id))||(legacy&&!uuid(b.id))||(canonical&&legacy&&b.database_id!==b.id))fail('CREATED_D1_IDENTIFIER_INVALID');
 return {name:b.name,type:b.type,id:canonical?b.database_id:b.id};
}

export const VERSION_LIST_PAGE_BUDGET=5;
async function uniqueAttemptVersion(send,workerId,tag){
 // Pagination is not a snapshot/CAS. Under the reviewed single-writer window,
 // require a complete, internally consistent bounded listing, not page-1 luck.
 const perPage=100,seen=new Set(),matches=[];let totals;
 for(let page=1;page<=VERSION_LIST_PAGE_BUDGET;page++){
  const response=await send({method:'GET',path:`${base}/workers/${workerId}/versions`,query:{page,per_page:perPage}});
  const found=result(response),info=response.result_info;
  if(!Array.isArray(found)||!info||info.page!==page||info.per_page!==perPage||!Number.isSafeInteger(info.total_count)||info.total_count<0||!Number.isSafeInteger(info.total_pages)||info.total_pages<0)return null;
  const expectedPages=Math.max(1,Math.ceil(info.total_count/perPage));
  if(info.total_pages!==expectedPages||expectedPages>VERSION_LIST_PAGE_BUDGET||found.length!==Math.min(perPage,Math.max(0,info.total_count-(page-1)*perPage))||(Object.hasOwn(info,'count')&&info.count!==found.length))return null;
  if(totals&&(totals.count!==info.total_count||totals.pages!==info.total_pages))return null;
  totals={count:info.total_count,pages:info.total_pages};
  for(const version of found){
   if(!uuid(version?.id)||seen.has(version.id))return null;seen.add(version.id);
   if(version.annotations?.['workers/tag']===tag)matches.push(version.id);
  }
  if(page===totals.pages)return seen.size===totals.count&&matches.length===1?matches[0]:null;
 }
 return null;
}

export function offlineReleaseAdapter({directory,transport,readObservation,now=Date.now}){
 if(transport?.mode!=='OFFLINE_FIXTURE_ONLY'||typeof transport.request!=='function'||typeof readObservation!=='function')fail('OFFLINE_TRANSPORT_REQUIRED');
 const store=localReleaseStore(directory);
 const send=request=>transport.request(frozen(request)); // Injected fixture only; no HTTP implementation.
 async function fresh(initial,a,p){const current=await readObservation();validateObservation(current,now());validateApproval(a,current,p,now());if(observationDigest(current)!==observationDigest(initial))fail('FINAL_OBSERVATION_DRIFT');return current;}
 return {productionExecutionSupported:false,
  async create({observation,approval,package:p}){
   const o=frozen(observation),a=frozen(approval),pkg=checkedPackage(p);validateObservation(o,now());validateApproval(a,o,pkg,now());
   const key=operationKey(o,pkg);
   return store.locked(key,async journal=>{
    if(journal.current)fail('OPERATION_EXISTS_RECONCILE_ONLY');
    const tag='release-'+randomUUID();
    let state={state:'CLAIMED',tag,approvalId:a.approvalId,observationDigest:observationDigest(o),moduleDigest:pkg.moduleDigest,assetDigest:target.assetDigest,workerId:o.worker.id,createdVersionId:null};
    journal.append(state);
    const write=async(request,phase)=>{
     const observed=await fresh(o,a,pkg);
     state={...state,state:phase,requestDigest:digest(request)};journal.append(state);
     // Re-check time after the final await AND synchronous journal persistence.
     validateObservation(observed,now());validateApproval(a,observed,pkg,now());
     return result(await send(request));
    };
    try{
     const session=await write({method:'POST',path:`${base}/scripts/${target.workerName}/assets-upload-session`,body:{manifest:pkg.assets.apiManifest}},'ASSET_SESSION_PENDING');
     if(typeof session.jwt!=='string'||!session.jwt||!Array.isArray(session.buckets))fail('ASSET_SESSION_UNCERTAIN');
     const buckets=session.buckets,seen=new Set();let completion=buckets.length?null:session.jwt;
     for(const [index,bucket] of buckets.entries()){
      if(!Array.isArray(bucket)||!bucket.length)fail('ASSET_BUCKET_INVALID');
      const body={};
      for(const h of bucket){const rows=pkg.assets.rows.filter(r=>r.apiHash===h);if(!rows.length||seen.has(h)||rows.some(r=>!r.bytes.equals(rows[0].bytes)))fail('ASSET_BUCKET_INVALID');seen.add(h);body[h]=rows[0].bytes.toString('base64');}
      // Official assets upload: base64=true multipart hash=>base64 file bodies.
      const uploaded=await write({method:'POST',path:`${base}/assets/upload`,query:{base64:true},headers:{Authorization:`Bearer ${session.jwt}`},multipart:body},'ASSET_UPLOAD_PENDING');
      if(index===buckets.length-1&&typeof uploaded.jwt==='string'&&uploaded.jwt)completion=uploaded.jwt;
     }
     if(!completion)fail('ASSET_COMPLETION_MISSING');
     const body=createBody(o,pkg,completion,tag);
     state={...state,assetCompletionDigest:hash(completion),createRequestDigest:digest(body)};
     const version=await write({method:'POST',path:`${base}/workers/${o.worker.id}/versions`,query:{deploy:false},body},'VERSION_CREATE_PENDING');
     if(!uuid(version.id)||version.id===target.baselineVersionId||version.annotations?.['workers/tag']!==tag)fail('VERSION_RESPONSE_UNCERTAIN');
     state={...state,state:'VERSION_CREATED',createdVersionId:version.id};journal.append(state);
     return {operationKey:key,state:state.state,versionId:version.id,productionExecutionSupported:false};
    }catch(error){journal.append({...state,state:'UNCERTAIN_NO_WRITE_RETRY',pendingPhase:state.state});throw Error('CREATE_STOPPED_RECONCILE_ONLY',{cause:error});}
   });
  },
  async reconcile({observation,package:p}){
   const o=frozen(observation),pkg=checkedPackage(p);validateObservation(o,now(),{historical:true});
   return store.locked(operationKey(o,pkg),async journal=>{
    const s=journal.current;if(!s||!['VERSION_CREATED','VERSION_VERIFIED','VERSION_CREATE_PENDING','UNCERTAIN_NO_WRITE_RETRY','PROMOTION_PENDING'].includes(s.state))fail('NO_RECONCILABLE_ATTEMPT');
    if(s.workerId!==o.worker.id||s.moduleDigest!==pkg.moduleDigest||s.observationDigest!==observationDigest(o))fail('RECONCILIATION_SCOPE_CHANGED');
    let id=s.createdVersionId;
    if(!id&&s.pendingPhase!=='VERSION_CREATE_PENDING'&&s.state!=='VERSION_CREATE_PENDING')return {state:'UNCERTAIN_NO_WRITE_RETRY',productionExecutionSupported:false};
    if(!sha(s.assetCompletionDigest)||!sha(s.createRequestDigest))fail('CREATE_RECEIPT_UNBOUND');
    if(!id){
     // Missing metadata, truncation, page-budget exhaustion or ambiguity never
     // authorizes another write, even with a new approval ID after a restart.
     id=await uniqueAttemptVersion(send,o.worker.id,s.tag);
     if(!id)return {state:'UNCERTAIN_NO_WRITE_RETRY',productionExecutionSupported:false};
    }
    const v=result(await send({method:'GET',path:`${base}/workers/${o.worker.id}/versions/${id}`,query:{include:'modules'}}));
    if(['cache_options','containers','exports','limits','migrations','migration_tag','placement','usage_model','package_dependencies'].some(name=>Object.hasOwn(v,name)))fail('CREATED_RUNTIME_FIELDS_UNREVIEWED');
    if(v.id!==id||v.annotations?.['workers/tag']!==s.tag||v.annotations?.['workers/message']!==`source-commit:${target.candidateCommit}`||digest({modules:[...(v.modules??[])].sort((a,b)=>a.name<b.name?-1:1),main_module:v.main_module})!==pkg.moduleDigest||v.compatibility_date!==o.version.compatibility_date||stable(v.compatibility_flags)!==stable(o.version.compatibility_flags)||stable(v.assets?.config)!==stable(o.version.assets.config))fail('CREATED_VERSION_MISMATCH');
    // GET reveals binding metadata, not hidden secret values. Exact-version
    // inheritance is a platform trust assumption, not cryptographic equality.
    const bindingMetadata=Array.isArray(v.bindings)?v.bindings.map(createdBindingMetadata).sort((a,b)=>a.name<b.name?-1:1):null;
    if(stable(bindingMetadata)!==stable([...o.version.bindings].sort((a,b)=>a.name<b.name?-1:1)))fail('CREATED_BINDING_METADATA_MISMATCH');
    if(s.state==='PROMOTION_PENDING'||s.pendingPhase==='PROMOTION_PENDING'){
     const deployments=result(await send({method:'GET',path:`${base}/scripts/${target.workerName}/deployments`}));
     const active=deployments.deployments?.[0];
     if(!uuid(active?.id)||stable(active.versions)!==stable([{version_id:id,percentage:100}])||active.annotations?.['workers/message']!==s.tag)return {state:'UNCERTAIN_NO_WRITE_RETRY',productionExecutionSupported:false};
     const current=await readObservation(),checkedAt=now();validateObservation(current,checkedAt,{activeVersionId:id,historical:true});
     if(checkedAt-Date.parse(current.observedAt)>60000||current.activeDeployment.id!==active.id||current.worker.id!==o.worker.id||current.workerSettingsDigest!==o.workerSettingsDigest||stable(current.version)!==stable(o.version)||current.masterFalseWriteEvidenceDigest!==o.masterFalseWriteEvidenceDigest)fail('POST_PROMOTION_DRIFT');
     journal.append({...s,state:'CONFIRMED',createdVersionId:id,deploymentId:active.id});return {state:'CONFIRMED',productionExecutionSupported:false};
    }
    journal.append({...s,state:'VERSION_VERIFIED',createdVersionId:id});return {state:'VERSION_VERIFIED',versionId:id,productionExecutionSupported:false};
   });
  },
  async promote({observation,approval,package:p}){
   const o=frozen(observation),a=frozen(approval),pkg=checkedPackage(p);validateObservation(o,now());validateApproval(a,o,pkg,now());
   return store.locked(operationKey(o,pkg),async journal=>{
    let s=journal.current;if(s?.state!=='VERSION_VERIFIED'||s.observationDigest!==observationDigest(o))fail('PROMOTION_NOT_READY');
    const observed=await fresh(o,a,pkg);
    const request={method:'POST',path:`${base}/scripts/${target.workerName}/deployments`,query:{force:false},body:{strategy:'percentage',versions:[{version_id:s.createdVersionId,percentage:100}],annotations:{'workers/message':s.tag}}};
    s={...s,state:'PROMOTION_PENDING',promotionApprovalId:a.approvalId,requestDigest:digest(request)};journal.append(s);
    try{
     validateObservation(observed,now());validateApproval(a,observed,pkg,now());
     const deployed=result(await send(request));
     if(!uuid(deployed.id)||stable(deployed.versions)!==stable([{version_id:s.createdVersionId,percentage:100}]))fail('PROMOTION_RESPONSE_UNCERTAIN');
     // Receipt is recorded, but confirmation needs a separate GET, not this ACK.
     journal.append({...s,deploymentId:deployed.id});return {state:'PROMOTION_PENDING',productionExecutionSupported:false};
    }catch(error){journal.append({...s,state:'UNCERTAIN_NO_WRITE_RETRY',pendingPhase:'PROMOTION_PENDING'});throw Error('PROMOTION_STOPPED_RECONCILE_ONLY',{cause:error});}
   });
  },
 };
}
