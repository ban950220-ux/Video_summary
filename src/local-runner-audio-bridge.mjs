import {routeApi} from './worker.mjs';
import {sha256,validateAcquisitionManifest,assertBoundedAudioApproval} from './local-runner-contract.mjs';
import {ProviderError} from './adapters.mjs';
import {proveRunnerZero,runnerResumeEvidence,approveRunnerResume,claimRunnerResume} from './local-runner-blocked-resume.mjs';

const fail=code=>{const e=new ProviderError(code,code);e.preDispatchBlocked=true;throw e;};
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const sqlTime="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const jobScope="EXISTS(SELECT 1 FROM jobs j WHERE j.id=o.job_id AND j.owner_id='owner' AND (j.source_type='url' OR (j.source_type='audio' AND o.audio_link_manifest_sha256=o.manifest_sha256 AND json_extract(j.audit_json,'$.ownedAudioSha256')=json_extract(o.manifest_json,'$.fileSha256'))) AND j.source_url=o.source_url_snapshot AND j.duration_seconds=o.duration_seconds AND (j.report_json IS NULL OR j.report_json='null')) AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=o.job_id||':deleting' AND d.provider='deletion')";

async function bytesOf(request,max){
 if(Number(request.headers.get('content-length'))>max)fail('RUNNER_CHUNK_CHANGED');
 const reader=request.body?.getReader();if(!reader)fail('RUNNER_CHUNK_CHANGED');
 const parts=[];let n=0;for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>max){await reader.cancel();fail('RUNNER_CHUNK_CHANGED');}parts.push(value);}
 const bytes=new Uint8Array(n);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
async function binaryHash(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');}

// Deliberately not routed by site-worker or included in the production bundle.
// authenticate must be a trusted server adapter. No default authentication,
// token persistence or provider-account evidence is synthesized here.
export function createRunnerAudioHandler({env,authenticate,enableDispatch=false}){
 const auth=async request=>{
  if(typeof authenticate!=='function')fail('RUNNER_AUTH_REQUIRED');
  const context=await authenticate(request);
  if(context?.ownerId!=='owner'||!Number.isSafeInteger(context.expiresAt)||context.expiresAt<=Date.now())fail('RUNNER_AUTH_REQUIRED');
  return context;
 };
 const scope=async(request,jobId,{allowSource=false}={})=>{
  const context=await auth(request);
  const requestId=request.headers.get('x-runner-request-id'),manifestHash=request.headers.get('x-runner-manifest-sha256'),runnerId=request.headers.get('x-runner-id'),nonce=request.headers.get('x-runner-lease-nonce');
  const row=await env.DB.prepare(`SELECT o.*,b.approval_json,b.approval_sha256,b.state AS approval_state,b.expires_at AS approval_expires_at FROM yta_local_runner_outbox o LEFT JOIN yta_local_runner_batches b ON b.job_id=o.job_id AND b.request_id=o.request_id WHERE o.job_id=? AND o.request_id=? AND o.manifest_sha256=? AND o.lease_owner=? AND o.lease_nonce=? AND o.state='ACQUIRED' AND o.lease_expires_at>${sqlTime} AND ${jobScope} ${allowSource?'':"AND NOT EXISTS(SELECT 1 FROM yta_sources s WHERE s.job_id=o.job_id)"}`).bind(jobId,requestId,manifestHash,runnerId,nonce).first();
  if(!row||context.expiresAt<=Date.now())fail('RUNNER_SCOPE_CHANGED');
  let manifest;try{manifest=JSON.parse(row.manifest_json);validateAcquisitionManifest(manifest,{jobId,videoId:row.video_id});}catch{fail('RUNNER_MANIFEST_INVALID');}
  if(manifest.requestId!==row.request_id||await sha256(row.manifest_json)!==row.manifest_sha256)fail('RUNNER_MANIFEST_INVALID');
  return {row,manifest,context,runnerId,nonce};
 };
 const approval=async scope=>{
  const {row,manifest}=scope;let a;try{a=JSON.parse(row.approval_json);assertBoundedAudioApproval(a,{jobId:row.job_id,requestId:row.request_id,manifestSha256:row.manifest_sha256,sourceSha256:manifest.fileSha256,chunkHashes:manifest.chunks.map(c=>c.sha256),provider:a.provider,model:a.model});}catch{fail('RUNNER_APPROVAL_REQUIRED');}
  if(row.approval_state!=='APPROVED'||row.approval_expires_at!==a.expiresAt||row.approval_expires_at<=Date.now()||await sha256(row.approval_json)!==row.approval_sha256)fail('RUNNER_APPROVAL_REQUIRED');
  // Existing audio-chunk has a fixed Groq model. No paid or provider fallback.
  if(a.provider!=='groq'||a.model!=='whisper-large-v3-turbo'||a.maxMicroUsd!==0||a.perCallMaxMicroUsd!==0)fail('RUNNER_FREE_AUDIO_SCOPE_REQUIRED');
  return a;
 };
 const reconcile=async(jobId,index,sc,{persist=true}={})=>{
  const dispatch=await env.DB.prepare("SELECT d.*,t.gate,t.resume_approval_id,t.approval_sha256 AS attempt_approval FROM yta_local_runner_audio_dispatches d JOIN yta_local_runner_audio_attempts t ON t.id=d.attempt_id WHERE d.job_id=? AND d.chunk_index=? AND d.request_id=? AND d.manifest_sha256=? AND d.chunk_sha256=? AND d.operation_id=? AND d.state IN ('DISPATCH_UNCERTAIN','TRANSCRIBED') AND t.gate='FENCED' AND t.job_id=d.job_id AND t.chunk_index=d.chunk_index AND t.manifest_sha256=d.manifest_sha256").bind(jobId,index,sc.row.request_id,sc.row.manifest_sha256,sc.manifest.chunks[index].sha256,jobId+':audio:'+index).first();
  if(!dispatch||dispatch.attempt_approval!==sc.row.approval_sha256||await sha256(sc.row.approval_json||'')!==dispatch.attempt_approval)return null;
  if(dispatch.resume_approval_id){const r=await env.DB.prepare("SELECT approval_json,approval_sha256 FROM yta_local_runner_audio_resumes WHERE id=? AND job_id=? AND chunk_index=? AND state='USED'").bind(dispatch.resume_approval_id,jobId,index).first();if(!r||await sha256(r.approval_json)!==r.approval_sha256)return null;const a=JSON.parse(r.approval_json);if(a.previousApprovalSha256!==dispatch.attempt_approval||a.manifestSha256!==dispatch.manifest_sha256||a.chunkHashes?.[index]!==dispatch.chunk_sha256)return null;}
  try{const a=JSON.parse(sc.row.approval_json);assertBoundedAudioApproval(a,{jobId,requestId:sc.row.request_id,manifestSha256:sc.row.manifest_sha256,sourceSha256:sc.manifest.fileSha256,chunkHashes:sc.manifest.chunks.map(c=>c.sha256),provider:'groq',model:'whisper-large-v3-turbo',now:a.expiresAt-1});}catch{return null;}
  const row=await env.DB.prepare("SELECT a.state,a.result_json,o.state AS operation_state,o.result_json AS operation_result,o.units,(SELECT COUNT(*) FROM usage_events u WHERE u.job_id=a.job_id AND u.provider='groq' AND u.capability='LIVE_FREE' AND u.unit='audio_seconds' AND u.used_units=o.units) AS usage_count FROM yta_audio a JOIN yta_operations o ON o.id=? AND o.job_id=a.job_id AND o.provider='groq' WHERE a.job_id=? AND a.chunk_index=?").bind(jobId+':audio:'+index,jobId,index).first();
  let result,op;try{result=JSON.parse(row?.result_json);op=JSON.parse(row?.operation_result);}catch{return null;}
  if(row?.state!=='DONE'||result.requestAudioSha256!==dispatch.chunk_sha256||op?.requestAudioSha256!==dispatch.chunk_sha256||row.operation_state!=='DONE'||row.usage_count<1||result?.operationId!==jobId+':audio:'+index||result.fileSha256!==sc.manifest.fileSha256||!Array.isArray(result.segments)||!result.segments.length||JSON.stringify(result.segments)!==JSON.stringify(op?.segments))return null;
  const usage=await env.DB.prepare("SELECT (SELECT COUNT(*) FROM usage_events WHERE job_id=? AND provider='groq' AND capability='LIVE_FREE') AS usage_count,(SELECT COALESCE(SUM(used_units),0) FROM usage_events WHERE job_id=? AND provider='groq' AND capability='LIVE_FREE' AND unit='audio_seconds') AS usage_units,(SELECT COUNT(*) FROM yta_operations WHERE job_id=? AND provider='groq' AND state='DONE') AS done_count,(SELECT COALESCE(SUM(units),0) FROM yta_operations WHERE job_id=? AND provider='groq' AND state='DONE') AS done_units").bind(jobId,jobId,jobId,jobId).first();
  if(usage.usage_count!==usage.done_count||usage.usage_units!==usage.done_units)return null;
  if(persist)await env.DB.prepare(`UPDATE yta_local_runner_audio_dispatches SET state='TRANSCRIBED',error_code=NULL WHERE job_id=? AND chunk_index=? AND request_id=? AND manifest_sha256=? AND EXISTS(SELECT 1 FROM yta_local_runner_outbox o WHERE o.job_id=? AND ${jobScope})`).bind(jobId,index,sc.row.request_id,sc.row.manifest_sha256,jobId).run();
  return {index,state:'TRANSCRIBED',manifestSha256:sc.row.manifest_sha256,chunkSha256:sc.manifest.chunks[index].sha256,provider:'groq',operationId:result.operationId,segmentCount:result.segments.length,providerUsage:{unit:'audio_seconds',reservedUpperBound:row.units,actualUsd:null,provenance:'APP_RESERVED_UPPER_BOUND'},summaryComplete:false};
 };
 return async request=>{
  try{
   const url=new URL(request.url),match=url.pathname.match(/^\/runner\/jobs\/([0-9a-f-]{36})\/(plan|chunk|progress|finish|resume-blocked)$/i);if(!match)return json({error:{code:'NOT_FOUND'}},404);
   const [,jobId,action]=match;
   if(!['GET','POST'].includes(request.method)||(action==='progress')!==(request.method==='GET'))return json({error:{code:'METHOD_NOT_ALLOWED'}},405);
   const sc=await scope(request,jobId,{allowSource:action==='progress'||action==='finish'});
   const internal=(suffix,method='GET',body,headers={})=>routeApi(new Request('https://runner-internal.invalid/api/jobs/'+jobId+'/'+suffix,{method,headers:{...(body instanceof Uint8Array?{'content-type':'application/octet-stream'}:body?{'content-type':'application/json'}:{}),...headers},body:body instanceof Uint8Array?body:body?JSON.stringify(body):undefined}),env);
   if(action==='plan'){
    const body=JSON.parse(new TextDecoder().decode(await bytesOf(request,1024)));
    if(body.rightsConfirmed!==true||body.linkUrlToAudio!==true)fail('RUNNER_RIGHTS_CONFIRMATION_REQUIRED');
    // Explicit, same-job URL -> owned audio transition. Preserve URL and pin the
    // acquisition manifest; do not silently widen URL eligibility for free batch.
    await env.DB.batch([
     env.DB.prepare(`UPDATE jobs SET source_type='audio',audit_json=json_set(COALESCE(audit_json,'{}'),'$.urlAudioAssociation','LOCAL_RUNNER_MANIFEST_UNVERIFIED','$.ownedAudioSha256',?),updated_at=? WHERE id=? AND owner_id='owner' AND source_type='url' AND source_url=? AND duration_seconds=? AND (report_json IS NULL OR report_json='null') AND NOT EXISTS(SELECT 1 FROM yta_sources WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM yta_audio WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.job_id=jobs.id AND (d.provider='deletion' OR d.id LIKE jobs.id||':audio:%')) AND EXISTS(SELECT 1 FROM yta_local_runner_outbox o WHERE o.job_id=jobs.id AND o.state='ACQUIRED' AND o.manifest_json=? AND o.lease_owner=? AND o.lease_nonce=? AND o.lease_expires_at>${sqlTime})`).bind(sc.manifest.fileSha256,new Date().toISOString(),jobId,sc.row.source_url_snapshot,sc.row.duration_seconds,sc.row.manifest_json,sc.runnerId,sc.nonce),
     env.DB.prepare('UPDATE yta_local_runner_outbox SET audio_link_manifest_sha256=manifest_sha256 WHERE job_id=? AND changes()=1').bind(jobId)
    ]);
    const linked=await env.DB.prepare("SELECT 1 AS ok FROM jobs j JOIN yta_local_runner_outbox o ON o.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND j.source_type='audio' AND o.audio_link_manifest_sha256=? AND json_extract(j.audit_json,'$.ownedAudioSha256')=?").bind(jobId,sc.row.manifest_sha256,sc.manifest.fileSha256).first();
    if(!linked)fail('RUNNER_AUDIO_LINK_CHANGED');await scope(request,jobId);
    return internal('audio-plan','POST',{rightsConfirmed:true,fileSha256:sc.manifest.fileSha256,chunks:sc.manifest.chunks.map(({index,start,end})=>({index,start,end}))});
   }
   if(action==='progress'){
    const response=await internal('audio-progress');if(!response.ok)return response;const progress=await response.json();
    const dispatches=(await env.DB.prepare('SELECT chunk_index,state,error_code FROM yta_local_runner_audio_dispatches WHERE job_id=?').bind(jobId).all()).results;
    for(const d of dispatches)if(d.state==='BLOCKED'){try{const a=await approval(sc),proof=await runnerResumeEvidence(env.DB,sc,d.chunk_index);d.resume={state:'EXPLICIT_NEW_APPROVAL_REQUIRED',blockedAttemptId:proof.id,evidenceSha256:proof.evidence_sha256,previousApprovalSha256:sc.row.approval_sha256,originalApproval:a};}catch{d.resume={state:'NOT_PROVEN_OR_NEW_CONSENT_REQUIRED'};}}
    const receipts=[];for(const chunk of sc.manifest.chunks){const receipt=await reconcile(jobId,chunk.index,sc,{persist:false});if(receipt)receipts.push(receipt);}
    return json({jobId,manifestSha256:sc.row.manifest_sha256,audio:progress,dispatches,receipts,summaryComplete:false,sourceAccuracy:'UNVERIFIED'});
   }
   if(action==='finish'){
    for(const chunk of sc.manifest.chunks)if(!await reconcile(jobId,chunk.index,sc))fail('RUNNER_TRANSCRIPTION_INCOMPLETE');
    const response=await internal('audio-finish','POST',{});if(!response.ok)return response;
    const saved=await response.json();if(saved.persisted!==true||saved.job.audit?.audioFileSha256!==sc.manifest.fileSha256||saved.job.audit?.audioProcessingCoverage!==1||!saved.source?.segments?.length)fail('RUNNER_TRANSCRIPT_NOT_STORED');
    return json({state:'TRANSCRIPT_STORED_SOURCE_UNVERIFIED',persisted:true,jobId,segmentCount:saved.source.segments.length,sourceAccuracy:'UNVERIFIED',summaryComplete:false,report:saved.job.report??null});
   }
   const index=Number(url.searchParams.get('index')),chunk=sc.manifest.chunks[index];
   if(!Number.isSafeInteger(index)||!chunk)fail('RUNNER_CHUNK_CHANGED');
   if(action==='resume-blocked'){
    const body=JSON.parse(new TextDecoder().decode(await bytesOf(request,20000)));
    if(Object.keys(body).join(',')!=='approval')fail('RUNNER_RESUME_APPROVAL_INVALID');
    let a;try{a=await approval(sc);}catch{fail('RUNNER_NEW_CONSENT_REQUIRED');}
    if(!enableDispatch||env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API!=='false')fail('RUNNER_DISPATCH_DISABLED');
    return json(await approveRunnerResume(env.DB,sc,a,index,body.approval));
   }
   const bytes=await bytesOf(request,chunk.bytes);if(bytes.length!==chunk.bytes||await binaryHash(bytes)!==chunk.sha256)fail('RUNNER_CHUNK_CHANGED');
   const prior=await env.DB.prepare('SELECT state FROM yta_local_runner_audio_dispatches WHERE job_id=? AND chunk_index=?').bind(jobId,index).first();
   const resumeId=request.headers.get('x-runner-resume-approval-id');
   if(prior){const saved=await reconcile(jobId,index,sc);if(saved)return json({...saved,cached:true});if(prior.state!=='BLOCKED'||!resumeId)fail('RUNNER_DISPATCH_RECONCILIATION_REQUIRED');}
   const a=await approval(sc);
   if(!enableDispatch||env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API!=='false')fail('RUNNER_DISPATCH_DISABLED');
   const attemptId=crypto.randomUUID();let resume=null;
   if(prior)resume=await claimRunnerResume(env.DB,sc,index,resumeId,attemptId);
   else{
    if(resumeId)fail('RUNNER_RESUME_APPROVAL_INVALID');
    const claimed=await env.DB.batch([
     env.DB.prepare(`INSERT OR IGNORE INTO yta_local_runner_audio_dispatches(job_id,chunk_index,request_id,manifest_sha256,chunk_sha256,operation_id,state,created_at,attempt_id) SELECT o.job_id,?,o.request_id,o.manifest_sha256,?,?,'DISPATCH_UNCERTAIN',?,? FROM yta_local_runner_outbox o JOIN yta_local_runner_batches b ON b.job_id=o.job_id WHERE o.job_id=? AND o.state='ACQUIRED' AND o.manifest_json=? AND o.lease_owner=? AND o.lease_nonce=? AND o.lease_expires_at>${sqlTime} AND b.approval_json=? AND b.state='APPROVED' AND b.expires_at>${sqlTime} AND ${jobScope} AND NOT EXISTS(SELECT 1 FROM yta_sources WHERE job_id=o.job_id) AND (SELECT COUNT(*) FROM yta_local_runner_audio_dispatches d WHERE d.job_id=o.job_id)<? AND NOT EXISTS(SELECT 1 FROM yta_operations x WHERE x.job_id=o.job_id AND x.id=?)`).bind(index,chunk.sha256,jobId+':audio:'+index,new Date().toISOString(),attemptId,jobId,sc.row.manifest_json,sc.runnerId,sc.nonce,sc.row.approval_json,a.maxCalls,jobId+':audio:'+index),
     env.DB.prepare("INSERT INTO yta_local_runner_audio_attempts(id,job_id,chunk_index,gate,approval_sha256,manifest_sha256,created_at) SELECT ?,?,?,'PREPARED',?,?,? WHERE changes()=1").bind(attemptId,jobId,index,sc.row.approval_sha256,sc.row.manifest_sha256,new Date().toISOString())
    ]);
    if(claimed[0].meta?.changes!==1)fail('RUNNER_DISPATCH_RECONCILIATION_REQUIRED');
   }
   let quotaZero=true,capacityKnown=true;
   const accounting=event=>{if(event==='QUOTA_PENDING')quotaZero=false;if(event==='QUOTA_ZERO')quotaZero=true;if(event==='CAPACITY_PENDING')capacityKnown=false;if(event==='CAPACITY_KNOWN')capacityKnown=true;};
   const guard=async()=>{
    const context=await auth(request);
    const valid=await env.DB.prepare(`SELECT 1 AS ok FROM yta_local_runner_outbox o JOIN yta_local_runner_batches b ON b.job_id=o.job_id JOIN yta_local_runner_audio_dispatches d ON d.job_id=o.job_id WHERE o.job_id=? AND o.state='ACQUIRED' AND o.manifest_json=? AND o.lease_owner=? AND o.lease_nonce=? AND o.lease_expires_at>${sqlTime} AND b.approval_json=? AND b.state='APPROVED' AND b.expires_at>${sqlTime} AND d.chunk_index=? AND d.attempt_id=? AND d.state='DISPATCH_UNCERTAIN' AND (? IS NULL OR EXISTS(SELECT 1 FROM yta_local_runner_audio_resumes r WHERE r.id=? AND r.state='USED' AND r.approval_sha256=? AND r.approval_json=? AND r.expires_at>${sqlTime})) AND ${jobScope} AND NOT EXISTS(SELECT 1 FROM yta_sources WHERE job_id=o.job_id)`).bind(jobId,sc.row.manifest_json,sc.runnerId,sc.nonce,sc.row.approval_json,index,attemptId,resume?.id??null,resume?.id??null,resume?.approval_sha256??null,resume?.approval_json??null).first();
    if(!valid||sc.row.lease_expires_at<=Date.now()||context.expiresAt<=Date.now()||a.expiresAt<=Date.now()||(resume&&resume.expires_at<=Date.now())||env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API!=='false')fail('RUNNER_SCOPE_CHANGED');
   };
   const fence=async()=>{const result=await env.DB.prepare("UPDATE yta_local_runner_audio_attempts SET gate='FENCED' WHERE id=? AND gate='PREPARED' AND EXISTS(SELECT 1 FROM yta_local_runner_audio_dispatches WHERE job_id=? AND chunk_index=? AND attempt_id=? AND state='DISPATCH_UNCERTAIN')").bind(attemptId,jobId,index,attemptId).run();if(result.meta?.changes!==1)fail('RUNNER_SEND_FENCE_UNCONFIRMED');await guard();};
   const response=await routeApi(new Request('https://runner-internal.invalid/api/jobs/'+jobId+'/audio-chunk?index='+index+'&provider=groq&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),{...env,LOCAL_RUNNER_AUDIO_GUARD:guard,LOCAL_RUNNER_AUDIO_SEND_FENCE:fence,LOCAL_RUNNER_AUDIO_ACCOUNTING:accounting});
   const saved=await reconcile(jobId,index,sc);if(saved)return json(saved);
   const operation=await env.DB.prepare('SELECT state,error_code FROM yta_operations WHERE id=?').bind(jobId+':audio:'+index).first();
   if(!operation||operation.state==='BLOCKED')await env.DB.prepare("UPDATE yta_local_runner_audio_dispatches SET state='BLOCKED',error_code=? WHERE job_id=? AND chunk_index=? AND state='DISPATCH_UNCERTAIN'").bind(operation?.error_code??'AUDIO_ROUTE_REJECTED',jobId,index).run();
   await proveRunnerZero(env.DB,{attemptId,quotaZero,capacityKnown});
   return response.ok?json({error:{code:'RUNNER_TRANSCRIPT_NOT_STORED'}},409):response;
  }catch(error){return json({error:{code:error.code||'RUNNER_BRIDGE_ERROR'}},error.code==='RUNNER_AUTH_REQUIRED'?401:409);}
 };
}
