import {sha256} from './local-runner-contract.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const runnerSqlTime="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
// No transcript, URL, credential or free-form error body is archived here.
// Exact current-chunk state and the entire job's usage/operation metadata are CAS-bound.
const snapshot=`json_object('audio',json((SELECT json_object('state',state,'start',start_sec,'end',end_sec,'result',result_json) FROM yta_audio WHERE job_id=d.job_id AND chunk_index=d.chunk_index)),
 'operations',json((SELECT json_group_array(json_object('id',id,'provider',provider,'units',units,'state',state,'error',error_code,'at',created_at,'hasResult',result_json IS NOT NULL)) FROM (SELECT * FROM yta_operations WHERE job_id=d.job_id ORDER BY id))),
 'usage',json((SELECT json_group_array(json_object('id',id,'provider',provider,'capability',capability,'unit',unit,'units',used_units,'estimated',estimated_usd,'actual',actual_usd,'at',captured_at)) FROM (SELECT * FROM usage_events WHERE job_id=d.job_id ORDER BY id))))`;
export const resumeContext=`o.state='ACQUIRED' AND o.manifest_json IS NOT NULL AND o.audio_link_manifest_sha256=o.manifest_sha256
 AND o.lease_owner=? AND o.lease_nonce=? AND o.lease_expires_at>${runnerSqlTime}
 AND b.state='APPROVED' AND b.approval_sha256=? AND b.approval_json=? AND b.expires_at>${runnerSqlTime}
 AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=o.job_id AND j.owner_id='owner' AND j.source_type='audio' AND j.source_url=o.source_url_snapshot AND j.duration_seconds=o.duration_seconds AND json_extract(j.audit_json,'$.ownedAudioSha256')=json_extract(o.manifest_json,'$.fileSha256') AND (j.report_json IS NULL OR j.report_json='null'))
 AND NOT EXISTS(SELECT 1 FROM yta_sources WHERE job_id=o.job_id)
 AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE job_id=o.job_id AND (provider='deletion' OR state IN ('CLAIMED','FAILED_UNCERTAIN'))) `;
const joins=`FROM yta_local_runner_audio_dispatches d JOIN yta_local_runner_outbox o ON o.job_id=d.job_id JOIN yta_local_runner_batches b ON b.job_id=d.job_id JOIN yta_local_runner_audio_attempts t ON t.id=d.attempt_id`;
const args=sc=>[sc.runnerId,sc.nonce,sc.row.approval_sha256,sc.row.approval_json];

export async function proveRunnerZero(db,{attemptId,quotaZero,capacityKnown}){
 if(!quotaZero||!capacityKnown)return false;
 const row=await db.prepare(`SELECT d.*,t.gate,${snapshot} AS snapshot ${joins} WHERE t.id=? AND t.gate='PREPARED' AND d.state='BLOCKED'
 AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE job_id=d.job_id AND (provider='deletion' OR state IN ('CLAIMED','FAILED_UNCERTAIN')))
 AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE id=d.operation_id AND (state<>'BLOCKED' OR error_code NOT IN ('QUOTA_EXHAUSTED','PRE_DISPATCH_BLOCKED','CAPACITY_WAIT') OR result_json IS NOT NULL))
 AND EXISTS(SELECT 1 FROM yta_audio WHERE job_id=d.job_id AND chunk_index=d.chunk_index AND state IN ('PLANNED','PAUSED'))`).bind(attemptId).first();
 if(!row)return false;
 const value=JSON.parse(row.snapshot);const result=JSON.parse(value.audio.result||'{}');
 if(Object.keys(result).some(k=>!['fileSha256','geminiConsent'].includes(k))||!value.audio||!['PLANNED','PAUSED'].includes(value.audio.state))return false;
 const done=value.operations.filter(o=>o.state==='DONE');
 if(value.operations.some(o=>o.provider!=='groq'||!Number.isFinite(o.units)||o.units<=0||!['DONE','BLOCKED'].includes(o.state)||(o.state==='BLOCKED'&&!['QUOTA_EXHAUSTED','PRE_DISPATCH_BLOCKED','CAPACITY_WAIT'].includes(o.error)))||value.usage.some(u=>u.provider!=='groq'||u.capability!=='LIVE_FREE'||u.unit!=='audio_seconds'||!Number.isFinite(u.units)||u.units<=0||u.actual!==null)||value.usage.length!==done.length||value.usage.reduce((n,u)=>n+u.units,0)!==done.reduce((n,o)=>n+o.units,0))return false;
 const digest=await sha256(row.snapshot);
 const saved=await db.prepare(`UPDATE yta_local_runner_audio_attempts SET gate='PROVEN_ZERO',evidence_json=?,evidence_sha256=? WHERE id=? AND gate='PREPARED' AND EXISTS(SELECT 1 ${joins} WHERE t.id=? AND d.state='BLOCKED' AND ${snapshot}=?)`).bind(row.snapshot,digest,attemptId,attemptId,row.snapshot).run();
 return saved.meta?.changes===1;
}
export async function runnerResumeEvidence(db,sc,index){
 const row=await db.prepare(`SELECT t.id,t.evidence_sha256,t.evidence_json,t.approval_sha256,t.manifest_sha256,${snapshot} AS current_snapshot ${joins} WHERE d.job_id=? AND d.chunk_index=? AND d.state='BLOCKED' AND t.gate='PROVEN_ZERO' AND ${resumeContext}`).bind(sc.row.job_id,index,...args(sc)).first();
 if(!row||row.manifest_sha256!==sc.row.manifest_sha256||row.approval_sha256!==sc.row.approval_sha256||row.current_snapshot!==row.evidence_json||await sha256(row.evidence_json)!==row.evidence_sha256)fail('RUNNER_ZERO_DISPATCH_NOT_PROVEN');
 return row;
}
export function validateResumeApproval(value,sc,original,index,evidence){
 const keys=['kind','approvalId','jobId','requestId','chunkIndex','blockedAttemptId','evidenceSha256','previousApprovalSha256','manifestSha256','sourceSha256','chunkHashes','provider','model','maxCalls','maxMicroUsd','perCallMaxMicroUsd','expiresAt','maxRetries','confirmNoProviderCall','confirmResumeOnce'];
 if(!value||Object.keys(value).sort().join(',')!==keys.sort().join(',')||value.kind!=='LOCAL_AUDIO_BLOCKED_RESUME_V1'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.approvalId||''))fail('RUNNER_RESUME_APPROVAL_INVALID');
 if(value.jobId!==sc.row.job_id||value.requestId!==sc.row.request_id||value.chunkIndex!==index||value.blockedAttemptId!==evidence.id||value.evidenceSha256!==evidence.evidence_sha256||value.previousApprovalSha256!==sc.row.approval_sha256||value.confirmNoProviderCall!==true||value.confirmResumeOnce!==true)fail('RUNNER_RESUME_APPROVAL_INVALID');
 for(const field of ['manifestSha256','sourceSha256','chunkHashes','provider','model','maxCalls','maxMicroUsd','perCallMaxMicroUsd','maxRetries'])if(JSON.stringify(value[field])!==JSON.stringify(original[field]))fail('RUNNER_NEW_CONSENT_REQUIRED');
 if(!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||value.expiresAt>original.expiresAt)fail('RUNNER_NEW_CONSENT_REQUIRED');
 return JSON.stringify(Object.fromEntries(keys.map(k=>[k,value[k]])));
}
export async function approveRunnerResume(db,sc,original,index,value){
 const evidence=await runnerResumeEvidence(db,sc,index),raw=validateResumeApproval(value,sc,original,index,evidence),digest=await sha256(raw);
 const result=await db.prepare(`INSERT OR IGNORE INTO yta_local_runner_audio_resumes(id,job_id,chunk_index,blocked_attempt_id,approval_json,approval_sha256,expires_at,state,created_at)
 SELECT ?,d.job_id,d.chunk_index,t.id,?,?,?,'APPROVED',? ${joins} WHERE d.job_id=? AND d.chunk_index=? AND d.state='BLOCKED' AND t.id=? AND t.gate='PROVEN_ZERO' AND t.evidence_json=? AND ${snapshot}=? AND ${resumeContext} AND ?>${runnerSqlTime}`).bind(value.approvalId,raw,digest,value.expiresAt,new Date().toISOString(),sc.row.job_id,index,evidence.id,evidence.evidence_json,evidence.evidence_json,...args(sc),Math.min(value.expiresAt,sc.context.expiresAt)).run();
 const saved=await db.prepare('SELECT * FROM yta_local_runner_audio_resumes WHERE id=?').bind(value.approvalId).first();
 if(!saved||saved.approval_json!==raw||saved.state!=='APPROVED')fail('RUNNER_RESUME_APPROVAL_CONFLICT');
 return {state:'BLOCKED_RESUME_APPROVED',approvalId:value.approvalId,chunkIndex:index,evidenceSha256:evidence.evidence_sha256,providerCalls:0,cached:result.meta?.changes!==1};
}
export async function claimRunnerResume(db,sc,index,resumeId,attemptId){
 const proof=await runnerResumeEvidence(db,sc,index);
 const r=await db.prepare("SELECT * FROM yta_local_runner_audio_resumes WHERE id=? AND job_id=? AND chunk_index=? AND blocked_attempt_id=? AND state='APPROVED'").bind(resumeId,sc.row.job_id,index,proof.id).first();
 if(!r||r.expires_at<=Date.now()||await sha256(r.approval_json)!==r.approval_sha256)fail('RUNNER_RESUME_APPROVAL_REQUIRED');
 const parsed=JSON.parse(r.approval_json);
 if(parsed.approvalId!==r.id||parsed.expiresAt!==r.expires_at||validateResumeApproval(parsed,sc,JSON.parse(sc.row.approval_json),index,proof)!==r.approval_json)fail('RUNNER_RESUME_APPROVAL_INVALID');
 const changed=await db.batch([
  db.prepare(`UPDATE yta_local_runner_audio_dispatches SET state='DISPATCH_UNCERTAIN',error_code=NULL,attempt_id=? WHERE job_id=? AND chunk_index=? AND state='BLOCKED' AND attempt_id=? AND EXISTS(SELECT 1 ${joins} WHERE d.job_id=? AND d.chunk_index=? AND t.id=? AND t.gate='PROVEN_ZERO' AND ${snapshot}=? AND ${resumeContext}) AND EXISTS(SELECT 1 FROM yta_local_runner_audio_resumes WHERE id=? AND state='APPROVED' AND approval_sha256=? AND expires_at>${runnerSqlTime}) AND ?>${runnerSqlTime}`).bind(attemptId,sc.row.job_id,index,proof.id,sc.row.job_id,index,proof.id,proof.evidence_json,...args(sc),r.id,r.approval_sha256,sc.context.expiresAt),
  db.prepare("INSERT INTO yta_local_runner_audio_attempts(id,job_id,chunk_index,gate,approval_sha256,manifest_sha256,created_at,resume_approval_id) SELECT ?,?,?,'PREPARED',?,?,?,? WHERE changes()=1").bind(attemptId,sc.row.job_id,index,sc.row.approval_sha256,sc.row.manifest_sha256,new Date().toISOString(),r.id),
  db.prepare("UPDATE yta_local_runner_audio_resumes SET state='USED' WHERE id=? AND state='APPROVED' AND changes()=1").bind(r.id)
 ]);
 if(changed[0].meta?.changes!==1||changed[2].meta?.changes!==1)fail('RUNNER_RESUME_ALREADY_CLAIMED');
 return r;
}
