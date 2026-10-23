import {canonicalYouTubeUrl, validateAcquisitionManifest, assertBoundedAudioApproval, serializeBoundedAudioApproval, sha256} from './local-runner-contract.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stamp=()=>new Date().toISOString();
const eligible=(o='yta_local_runner_outbox')=>`EXISTS(SELECT 1 FROM jobs j WHERE j.id=${o}.job_id AND j.owner_id='owner' AND (j.source_type='url' OR (j.source_type='audio' AND ${o}.audio_link_manifest_sha256=${o}.manifest_sha256 AND json_extract(j.audit_json,'$.ownedAudioSha256')=json_extract(${o}.manifest_json,'$.fileSha256'))) AND j.source_url=${o}.source_url_snapshot AND j.duration_seconds=${o}.duration_seconds AND (j.report_json IS NULL OR j.report_json='null')) AND NOT EXISTS(SELECT 1 FROM yta_sources s WHERE s.job_id=${o}.job_id) AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=${o}.job_id||':deleting' AND d.provider='deletion')`;
const sqlNow="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const active=(o='o')=>`${o}.state='ACQUIRED' AND ${o}.lease_owner=? AND ${o}.lease_nonce=? AND ${o}.lease_expires_at>MAX(?,${sqlNow}) AND ${eligible(o)}`;

// Isolated proposal: no HTTP route, credentials, network or provider adapter.
export async function enqueueAcquisition(db,{jobId,requestId,url}){
 if(!uuid.test(jobId||'')||!uuid.test(requestId||''))fail('RUNNER_REQUEST_INVALID');
 const canonical=canonicalYouTubeUrl(url),created=stamp();
 const inserted=await db.prepare(`INSERT OR IGNORE INTO yta_local_runner_outbox(job_id,request_id,video_id,canonical_url,source_url_snapshot,duration_seconds,state,created_at,updated_at) SELECT id,?,?,?,source_url,duration_seconds,'QUEUED',?,? FROM jobs WHERE id=? AND owner_id='owner' AND source_type='url' AND source_url=? AND duration_seconds>0 AND duration_seconds<=7200 AND (report_json IS NULL OR report_json='null') AND NOT EXISTS(SELECT 1 FROM yta_sources WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE id=jobs.id||':deleting' AND provider='deletion')`).bind(requestId,canonical.videoId,canonical.url,created,created,jobId,url).run();
 const row=await db.prepare('SELECT * FROM yta_local_runner_outbox WHERE request_id=?').bind(requestId).first();
 if(!row||row.job_id!==jobId||row.video_id!==canonical.videoId||row.canonical_url!==canonical.url||row.source_url_snapshot!==url)fail('RUNNER_REQUEST_CONFLICT');
 return {created:inserted.meta?.changes===1,jobId:row.job_id,requestId:row.request_id,state:row.state,videoId:row.video_id};
}
export async function claimAcquisition(db,{runnerId,now=Date.now(),leaseMs=60000}){
 if(!uuid.test(runnerId||'')||!Number.isSafeInteger(now)||!Number.isSafeInteger(leaseMs)||leaseMs<10000||leaseMs>120000)fail('RUNNER_LEASE_INVALID');
 const candidate=await db.prepare(`SELECT job_id,revision FROM yta_local_runner_outbox WHERE state IN ('QUEUED','LEASED','ACQUIRED') AND (lease_expires_at IS NULL OR lease_expires_at<=?) AND ${eligible()} ORDER BY created_at,job_id LIMIT 1`).bind(now).first();
 if(!candidate)return null;
 const nonce=crypto.randomUUID(),updated=await db.prepare(`UPDATE yta_local_runner_outbox SET state=CASE WHEN state='QUEUED' THEN 'LEASED' ELSE state END,lease_owner=?,lease_nonce=?,lease_expires_at=?,revision=revision+1,updated_at=? WHERE job_id=? AND revision=? AND state IN ('QUEUED','LEASED','ACQUIRED') AND (lease_expires_at IS NULL OR lease_expires_at<=?) AND ${eligible()}`).bind(runnerId,nonce,now+leaseMs,stamp(),candidate.job_id,candidate.revision,now).run();
 if(updated.meta?.changes!==1)return null;
 const row=await db.prepare('SELECT * FROM yta_local_runner_outbox WHERE job_id=? AND lease_nonce=?').bind(candidate.job_id,nonce).first();
 if(!row)return null;
 return {jobId:row.job_id,requestId:row.request_id,videoId:row.video_id,url:row.canonical_url,durationSeconds:row.duration_seconds,state:row.state,manifest:row.manifest_json?JSON.parse(row.manifest_json):null,manifestSha256:row.manifest_sha256,leaseNonce:nonce,leaseExpiresAt:row.lease_expires_at};
}
export async function heartbeatAcquisition(db,{jobId,runnerId,leaseNonce,now=Date.now(),leaseMs=60000}){
 if(!uuid.test(runnerId||'')||!uuid.test(leaseNonce||'')||!Number.isSafeInteger(now)||!Number.isSafeInteger(leaseMs)||leaseMs<10000||leaseMs>120000)fail('RUNNER_LEASE_INVALID');
 const changed=await db.prepare(`UPDATE yta_local_runner_outbox SET lease_expires_at=?,updated_at=? WHERE job_id=? AND lease_owner=? AND lease_nonce=? AND lease_expires_at>? AND state IN ('LEASED','ACQUIRED') AND ${eligible()}`).bind(now+leaseMs,stamp(),jobId,runnerId,leaseNonce,now).run();
 if(changed.meta?.changes!==1)fail('RUNNER_LEASE_LOST');return now+leaseMs;
}
export async function sealAcquisition(db,{jobId,runnerId,leaseNonce,manifest,now=Date.now()}){
 const row=await db.prepare('SELECT * FROM yta_local_runner_outbox WHERE job_id=?').bind(jobId).first();if(!row)fail('RUNNER_NOT_FOUND');
 validateAcquisitionManifest(manifest,{videoId:row.video_id,jobId});
 if(manifest.requestId!==row.request_id||Math.abs(manifest.durationSeconds-row.duration_seconds)>2)fail('RUNNER_MANIFEST_INVALID');
 const manifestJson=JSON.stringify(manifest),manifestHash=await sha256(manifestJson);
 const changed=await db.prepare(`UPDATE yta_local_runner_outbox SET state='ACQUIRED',manifest_json=?,manifest_sha256=?,revision=revision+1,updated_at=? WHERE job_id=? AND state IN ('LEASED','ACQUIRED') AND lease_owner=? AND lease_nonce=? AND lease_expires_at>? AND (manifest_sha256 IS NULL OR manifest_sha256=?) AND ${eligible()}`).bind(manifestJson,manifestHash,stamp(),jobId,runnerId,leaseNonce,now,manifestHash).run();
 if(changed.meta?.changes!==1)fail('RUNNER_MANIFEST_OR_LEASE_CHANGED');return {jobId,manifestSha256:manifestHash,state:'ACQUIRED'};
}
export async function cancelAcquisition(db,{jobId}){
 await db.batch([
  db.prepare("UPDATE yta_local_runner_outbox SET state='CANCELLED',revision=revision+1,updated_at=? WHERE job_id=? AND state NOT IN ('COMPLETE','DISPATCH_UNCERTAIN')").bind(stamp(),jobId),
  db.prepare("UPDATE yta_local_runner_batches SET state='CANCELLED' WHERE job_id=?").bind(jobId)
 ]);
}
export async function markExternalDispatchUncertain(db,{jobId,runnerId,leaseNonce,manifestSha256,now=Date.now()}){
 const changed=await db.prepare(`UPDATE yta_local_runner_outbox SET state='DISPATCH_UNCERTAIN',revision=revision+1,updated_at=? WHERE job_id=? AND state='ACQUIRED' AND manifest_sha256=? AND lease_owner=? AND lease_nonce=? AND lease_expires_at>? AND ${eligible()}`).bind(stamp(),jobId,manifestSha256,runnerId,leaseNonce,now).run();
 if(changed.meta?.changes!==1)fail('RUNNER_DISPATCH_BLOCKED');return {jobId,state:'DISPATCH_UNCERTAIN',automaticRetry:false};
}
export async function completeFromStoredReport(){
 // Arbitrary report JSON plus an audio hash cannot prove a settled, source-bound
 // summary. Fail closed until the actual summary ledger adapter is integrated.
 fail('RUNNER_REPORT_VERIFIER_NOT_CONNECTED');
}

export async function approveAcquisitionUpload(db,{jobId,approval,now=Date.now()}){
 const row=await db.prepare(`SELECT * FROM yta_local_runner_outbox WHERE job_id=? AND state='ACQUIRED' AND ${eligible()}`).bind(jobId).first();
 if(!row)fail('RUNNER_UPLOAD_BLOCKED');
 const manifest=JSON.parse(row.manifest_json);
 assertBoundedAudioApproval(approval,{jobId,requestId:row.request_id,manifestSha256:row.manifest_sha256,sourceSha256:manifest.fileSha256,chunkHashes:manifest.chunks.map(c=>c.sha256),provider:approval?.provider,model:approval?.model,now});
 const raw=serializeBoundedAudioApproval(approval),hash=await sha256(raw);
 await db.prepare(`INSERT OR IGNORE INTO yta_local_runner_batches(request_id,job_id,approval_json,approval_sha256,expires_at,max_calls,max_micro_usd,per_call_micro_usd,state) SELECT request_id,job_id,?,?,?,?,?,?,'APPROVED' FROM yta_local_runner_outbox WHERE job_id=? AND manifest_sha256=? AND state='ACQUIRED' AND ${eligible()}`).bind(raw,hash,approval.expiresAt,approval.maxCalls,approval.maxMicroUsd,approval.perCallMaxMicroUsd,jobId,row.manifest_sha256).run();
 const saved=await db.prepare("SELECT approval_sha256,state FROM yta_local_runner_batches WHERE job_id=?").bind(jobId).first();
 if(saved?.approval_sha256!==hash||saved.state!=='APPROVED')fail('RUNNER_APPROVAL_CONFLICT');
 return {approvalSha256:hash,providerEnabled:false};
}

// Local/in-process transport for offline fixtures. A real HTTPS route must get
// its own authenticated owner context; never accept this auth object from a
// request body. There is deliberately no provider callback or body persistence.
export function createLocalUploadTransport(db,{getAuth,clock=Date.now}){
 const auth=()=>{const a=getAuth();if(a?.ownerId!=='owner'||!Number.isSafeInteger(a.expiresAt)||a.expiresAt<=clock())fail('RUNNER_AUTH_REQUIRED');return a;};
 const scope=async args=>{
  auth();
  const row=await db.prepare(`SELECT o.* FROM yta_local_runner_outbox o WHERE o.job_id=? AND o.request_id=? AND o.manifest_sha256=? AND ${active()}`).bind(args.jobId,args.requestId,args.manifestSha256,args.runnerId,args.leaseNonce,clock()).first();
  auth();if(!row)fail('RUNNER_UPLOAD_BLOCKED');return row;
 };
 const readReceipt=async args=>{
  await scope(args);
  const row=await db.prepare(`SELECT t.receipt_json FROM yta_local_runner_transfers t JOIN yta_local_runner_outbox o ON o.job_id=t.job_id WHERE t.job_id=? AND t.chunk_index=? AND t.request_id=? AND ${active()}`).bind(args.jobId,args.index,args.requestId,args.runnerId,args.leaseNonce,clock()).first();
  auth();return row?JSON.parse(row.receipt_json):null;
 };
 return {
  assertActive:scope,
  readReceipt,
  async uploadChunk(args){
   const row=await scope(args),manifest=JSON.parse(row.manifest_json),chunk=manifest.chunks[args.index];
   if(!chunk||!Number.isSafeInteger(args.index)||!(args.bytes instanceof Uint8Array)||args.bytes.byteLength!==chunk.bytes)fail('RUNNER_CHUNK_CHANGED');
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',args.bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
   if(digest!==chunk.sha256)fail('RUNNER_CHUNK_CHANGED');
   const a=auth(),now=clock();
   const receipt={kind:'LOCAL_UPLOAD_RECEIPT_V1',jobId:args.jobId,requestId:args.requestId,manifestSha256:args.manifestSha256,index:args.index,sha256:digest,bytes:chunk.bytes,providerCalls:0,status:'UPLOAD_RECEIVED_PROVIDER_NOT_DISPATCHED'};
   await db.prepare(`INSERT OR IGNORE INTO yta_local_runner_transfers(job_id,chunk_index,request_id,chunk_sha256,reserved_micro_usd,state,receipt_json,created_at) SELECT o.job_id,?,o.request_id,?,b.per_call_micro_usd,'RECEIVED',?,? FROM yta_local_runner_outbox o JOIN yta_local_runner_batches b ON b.job_id=o.job_id AND b.request_id=o.request_id WHERE o.job_id=? AND o.request_id=? AND o.manifest_sha256=? AND ${active()} AND b.state='APPROVED' AND b.expires_at>MAX(?,${sqlNow}) AND ?>MAX(?,${sqlNow}) AND (SELECT COUNT(*) FROM yta_local_runner_transfers t WHERE t.job_id=o.job_id)<b.max_calls AND COALESCE((SELECT SUM(reserved_micro_usd) FROM yta_local_runner_transfers t WHERE t.job_id=o.job_id),0)+b.per_call_micro_usd<=b.max_micro_usd`).bind(args.index,digest,JSON.stringify(receipt),stamp(),args.jobId,args.requestId,args.manifestSha256,args.runnerId,args.leaseNonce,now,now,a.expiresAt,now).run();
   const saved=await readReceipt(args);
   if(!saved)fail('RUNNER_APPROVAL_OR_LIMIT_BLOCKED');
   if(saved.sha256!==digest||saved.manifestSha256!==args.manifestSha256)fail('RUNNER_RECEIPT_CONFLICT');
   return saved;
  },
  dispatchProvider(){fail('RUNNER_PROVIDER_NOT_CONNECTED');}
 };
}
