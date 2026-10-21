import {capacityIdentity} from './observed-capacity.mjs';
import {reviewedFullCoverageLegacy} from './groq-summary.mjs';
import {FULL_COVERAGE_DAY_RESERVATION,FULL_COVERAGE_MINUTE_RESERVATION,FULL_COVERAGE_SPACING_MS,validateLeafResponse} from './groq-full-coverage.mjs';

const provider='groq-full-coverage';
const date=()=>new Date().toISOString();
const fail=code=>{throw Error(code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const safe=value=>Number.isSafeInteger(value)&&value>=0;
const ops="'groq-summary','groq-summary-synthesis','groq-full-coverage'";
const writeLockSql="(SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('full_coverage_source_insert_lock','full_coverage_source_update_lock','full_coverage_source_delete_lock','full_coverage_job_update_lock','full_coverage_job_delete_lock','full_coverage_proof_insert_lock','full_coverage_proof_update_lock','full_coverage_proof_delete_lock','full_coverage_usage_insert_lock','full_coverage_usage_update_lock','full_coverage_usage_delete_lock'))=11";
export const fullCoverageOperationId=(id,planHash,key)=>`${id}:groq-full-coverage:${planHash}:${key}`;
export const fullCoverageApprovalId=(id,sequence)=>`${id}:groq-full-coverage:approval:${sequence}`;
const receiptUsageId=opId=>opId+':usage';
const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');

export async function fullCoverageKeyBinding(env){
 let proof;try{proof=JSON.parse(env.GROQ_FREE_ORG_BINDING_JSON??'null');}catch{return null;}
 let identity;try{identity=await capacityIdentity(env,'groq');}catch{return null;}
 if(proof?.identity!==identity||proof.organizationPlan!=='Free'||proof.billingDisabled!==true||!safe(proof.confirmedAt)||!safe(proof.expiresAt)||proof.confirmedAt>Date.now()||proof.expiresAt<=Date.now()||proof.expiresAt>proof.confirmedAt+86_400_000)return null;
 const {recordSha256,...signed}=proof;
 return /^[a-f0-9]{64}$/.test(recordSha256??'')&&recordSha256===await sha(JSON.stringify(signed))?proof:null;
}

export async function fullCoverageLedger(env){
 const rows=(await env.DB.prepare(`SELECT id,units,state,created_at FROM yta_operations WHERE provider IN (${ops}) AND state IN ('CLAIMED','RECEIPT_STORED','DONE','FAILED_UNCERTAIN','BLOCKED')`).all()).results||[];
 return rows.map(row=>({id:row.id,reservationTokens:row.units,state:row.state,at:Date.parse(row.created_at)}));
}

export function fullCoverageD1Store({env,id,job,source,plan,approval,heldFailureEvidence,historicalOperationIds=[],historicalOperationProofs=[],historicalUsageProofs=[],transcriptHash}){
 const {state:approvalState,...approvalRecord}=approval;
 const auditJson=JSON.stringify(job.audit),approvalId=fullCoverageApprovalId(id,approval.sequence),approvalJson=JSON.stringify(approvalRecord),heldIds=heldFailureEvidence.map(item=>item.operationId),heldJson=JSON.stringify(heldIds),heldProofSql=heldFailureEvidence.map(()=>" AND EXISTS(SELECT 1 FROM yta_operations f JOIN usage_events u ON u.id=? AND u.job_id=f.job_id AND u.owner_id='owner' AND u.provider='groq' AND u.unit='actual_total_tokens' AND u.used_units=? WHERE f.id=? AND f.job_id=j.id AND f.provider='groq-summary' AND f.state='FAILED_UNCERTAIN' AND f.result_json=?)").join(''),heldProofArgs=heldFailureEvidence.flatMap(item=>[item.usageEventId,item.actualTotalTokens,item.operationId,item.resultJson]);
 const legacyProofSql=historicalOperationProofs.map(()=>" AND EXISTS(SELECT 1 FROM yta_operations h WHERE h.id=? AND h.job_id=o.job_id AND h.state=? AND h.result_json=? AND h.units IS ? AND h.error_code IS ?)").join(''),legacyProofArgs=historicalOperationProofs.flatMap(item=>[item.id,item.state,item.resultJson,item.units,item.errorCode]);
 const operationIdsJson=JSON.stringify(historicalOperationIds),operationSetSql=alias=>` AND (SELECT COUNT(*) FROM yta_operations h WHERE h.job_id=${alias}.id AND h.provider IN ('groq-summary','groq-summary-recovery'))=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM yta_operations h WHERE h.job_id=${alias}.id AND h.provider IN ('groq-summary','groq-summary-recovery') AND h.id NOT IN (SELECT value FROM json_each(?)))`,operationSetArgs=[operationIdsJson,operationIdsJson];
 const usageProofJson=JSON.stringify(historicalUsageProofs),usageProofSql=" AND (SELECT COUNT(*) FROM usage_events u WHERE u.job_id=o.job_id AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_SUMMARY')=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM json_each(?) p LEFT JOIN usage_events u ON u.id=json_extract(p.value,'$.id') AND u.job_id=o.job_id AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_SUMMARY' WHERE u.id IS NULL OR u.unit<>json_extract(p.value,'$.unit') OR u.provenance<>json_extract(p.value,'$.provenance') OR u.used_units<>json_extract(p.value,'$.usedUnits'))";
 const scope=async()=>{
  const row=await env.DB.prepare(`SELECT 1 AS ok FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND j.audit_json=? AND s.raw=? AND s.segments_json=? AND NOT EXISTS (SELECT 1 FROM yta_operations d WHERE d.id=? AND d.provider='deletion' AND d.state='DELETING') AND EXISTS (SELECT 1 FROM yta_operations a WHERE a.id=? AND a.job_id=j.id AND a.provider='groq-full-coverage-approval' AND a.state='APPROVED' AND a.result_json=?) ${heldProofSql} ${operationSetSql('j')}`).bind(id,auditJson,source.raw,source.segments_json,id+':deleting',approvalId,approvalJson,...heldProofArgs,...operationSetArgs).first();
  return row?.ok===1;
 };
 const historical=async()=>{
  if(plan.mode==='FRESH_IMPORTED_TRANSCRIPT'){
   const old=await env.DB.prepare("SELECT id FROM yta_operations WHERE job_id=? AND provider IN ('groq-summary','groq-summary-recovery') LIMIT 1").bind(id).first();
   const usage=await env.DB.prepare("SELECT id FROM usage_events WHERE job_id=? AND provider='groq' AND capability='LIVE_FREE_SUMMARY' LIMIT 1").bind(id).first();
   return !old&&!usage&&job.source_type==='text'&&job.audit?.fullCoverageFresh?.contract==='FRESH_IMPORTED_TRANSCRIPT_V1';
  }
  const checked=await reviewedFullCoverageLegacy(env,{id,job,source,transcriptHash,legacyTranscriptHash:approval.legacyTranscriptHash});
  return same(checked.heldFailureEvidence,heldFailureEvidence)&&same(checked.historicalOperationProofs,historicalOperationProofs)&&same(checked.historicalUsageProofs,historicalUsageProofs);
 };
 const identity=async()=>{
  const proof=await fullCoverageKeyBinding(env);
  return proof?.identity===approval.keyIdentity&&approval.bindingRecordSha256===proof.recordSha256;
 };
 const load=async binding=>{
  const opId=fullCoverageOperationId(id,plan.planSha256,binding.key),row=await env.DB.prepare('SELECT id,state,result_json,units,error_code FROM yta_operations WHERE id=? AND job_id=? AND provider=?').bind(opId,id,provider).first();
  if(!row)return null;
  let saved=null;try{saved=JSON.parse(row.result_json??'null');}catch{}
  if(row.state==='DONE'){
   const usage=await env.DB.prepare("SELECT used_units,unit,provenance FROM usage_events WHERE id=? AND job_id=? AND owner_id='owner' AND provider='groq' AND capability='LIVE_FREE_FULL_COVERAGE'").bind(receiptUsageId(opId),id).first();
   if(!saved||saved.planSha256!==plan.planSha256||saved.requestSha256!==binding.requestSha256||saved.reservationTokens!==row.units||usage?.used_units!==saved.actualTotalTokens||usage.unit!=='actual_total_tokens'||usage.provenance!=='PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN')fail('FULL_RECEIPT_OR_USAGE_CHANGED');
  }
  return {...saved,id:opId,state:row.state,errorCode:row.error_code??null};
 };
 const loadAll=async()=>{
  const prefix=id+':groq-full-coverage:'+plan.planSha256+':',rows=(await env.DB.prepare("SELECT id,state,result_json,units,error_code FROM yta_operations WHERE job_id=? AND provider='groq-full-coverage' AND substr(id,1,length(?))=?").bind(id,prefix,prefix).all()).results||[];
  const usage=(await env.DB.prepare("SELECT id,used_units,unit,provenance FROM usage_events WHERE job_id=? AND owner_id='owner' AND provider='groq' AND capability='LIVE_FREE_FULL_COVERAGE'").bind(id).all()).results||[],byUsage=new Map(usage.map(item=>[item.id,item])),records=new Map();
  for(const row of rows){
   const stage=plan.stages.find(item=>fullCoverageOperationId(id,plan.planSha256,item.key)===row.id);
   if(!stage||records.has(stage.key)||!['CLAIMED','BLOCKED','FAILED_UNCERTAIN','RECEIPT_STORED','DONE'].includes(row.state))fail('FULL_OPERATION_LEDGER_INVALID');
   let saved;try{saved=JSON.parse(row.result_json);}catch{fail('FULL_OPERATION_LEDGER_INVALID');}
   if(saved?.planSha256!==plan.planSha256||saved.requestSha256!==stage.requestSha256||saved.key!==stage.key||saved.reservationTokens!==row.units)fail('FULL_OPERATION_BINDING_CHANGED');
   if(row.state==='DONE'){
    const event=byUsage.get(receiptUsageId(row.id));
    if(event?.used_units!==saved.actualTotalTokens||event.unit!=='actual_total_tokens'||event.provenance!=='PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN'||saved.responseSha256!==await sha(saved.receiptText)||!same(saved.response,validateLeafResponse(stage,saved.receiptText)))fail('FULL_RECEIPT_OR_USAGE_CHANGED');
   }
    records.set(stage.key,{...saved,id:row.id,state:row.state,errorCode:row.error_code??null,durableResultJson:row.result_json});
  }
  if(usage.some(event=>!rows.some(row=>receiptUsageId(row.id)===event.id)))fail('FULL_ORPHAN_USAGE_EVENT');
  return records;
 };
 const claim=async(binding)=>{
  if(env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true'||approval.expiresAt<=Date.now()||!await scope()||!await identity()||approval.expiresAt<=Date.now())return false;
  const now=Date.now(),minute=new Date(now-60_000).toISOString(),day=new Date(now-86_400_000).toISOString(),spacing=new Date(now-FULL_COVERAGE_SPACING_MS).toISOString(),opId=fullCoverageOperationId(id,plan.planSha256,binding.key);
  const inserted=await env.DB.prepare(`INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,j.id,'groq-full-coverage',?,'CLAIMED',?,? FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND j.audit_json=? AND s.raw=? AND s.segments_json=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.provider='deletion' AND d.state='DELETING') AND EXISTS(SELECT 1 FROM yta_operations a WHERE a.id=? AND a.job_id=j.id AND a.state='APPROVED' AND a.result_json=?) ${heldProofSql} AND (SELECT COUNT(*) FROM yta_operations x WHERE x.job_id=j.id AND x.provider='groq-full-coverage' AND x.created_at>=?)<? AND NOT EXISTS(SELECT 1 FROM yta_operations x WHERE x.provider IN (${ops}) AND x.state IN ('CLAIMED','RECEIPT_STORED')) AND NOT EXISTS(SELECT 1 FROM yta_operations x WHERE x.provider IN (${ops}) AND x.state='FAILED_UNCERTAIN' AND x.id NOT IN (SELECT value FROM json_each(?))) AND NOT EXISTS(SELECT 1 FROM yta_operations x WHERE x.provider IN (${ops}) AND x.state='DONE' AND x.created_at>?) AND COALESCE((SELECT SUM(x.units) FROM yta_operations x WHERE x.provider IN (${ops}) AND x.state IN ('CLAIMED','RECEIPT_STORED','DONE','FAILED_UNCERTAIN') AND x.created_at>?),0)+?<=? AND COALESCE((SELECT SUM(x.units) FROM yta_operations x WHERE x.provider IN (${ops}) AND x.state IN ('CLAIMED','RECEIPT_STORED','DONE','FAILED_UNCERTAIN') AND x.created_at>?),0)+?<=?`).bind(opId,binding.reservationTokens,date(),JSON.stringify(binding),id,auditJson,source.raw,source.segments_json,id+':deleting',approvalId,approvalJson,...heldProofArgs,new Date(approval.issuedAt).toISOString(),approval.maxRequests,heldJson,spacing,minute,binding.reservationTokens,FULL_COVERAGE_MINUTE_RESERVATION,day,binding.reservationTokens,FULL_COVERAGE_DAY_RESERVATION).run();
  return inserted.meta?.changes===1;
 };
 const verifyBeforeDispatch=async(binding,{deep=false}={})=>{
  if(env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true'||approval.expiresAt<=Date.now()||!await identity()||deep&&!await historical()||!await scope())return false;
   const finalScopeSql=` AND EXISTS(SELECT 1 FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=o.job_id AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND j.audit_json=? AND s.raw=? AND s.segments_json=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.provider='deletion' AND d.state='DELETING') AND EXISTS(SELECT 1 FROM yta_operations a WHERE a.id=? AND a.job_id=j.id AND a.provider='groq-full-coverage-approval' AND a.state='APPROVED' AND a.result_json=?) ${heldProofSql})`;
   const opId=fullCoverageOperationId(id,plan.planSha256,binding.key),row=await env.DB.prepare(`SELECT 1 AS ok FROM yta_operations o WHERE o.id=? AND o.job_id=? AND o.provider=? AND o.state=? AND o.units=? AND o.result_json=? AND ${writeLockSql} AND NOT EXISTS(SELECT 1 FROM yta_operations x WHERE x.provider IN (${ops}) AND x.state IN ('CLAIMED','RECEIPT_STORED') AND x.id<>o.id) ${finalScopeSql} ${legacyProofSql} ${usageProofSql}`).bind(opId,id,provider,'CLAIMED',binding.reservationTokens,JSON.stringify(binding),auditJson,source.raw,source.segments_json,id+':deleting',approvalId,approvalJson,...heldProofArgs,...legacyProofArgs,usageProofJson,usageProofJson).first();
  return row?.ok===1&&approval.expiresAt>Date.now()&&env.ENABLE_LIVE_FREE==='true'&&env.ALLOW_PAID_API!=='true';
 };
 const mark=async(binding,state,code,receipt=null)=>env.DB.prepare("UPDATE yta_operations SET state=?,error_code=?,result_json=CASE WHEN ? IS NULL THEN result_json ELSE ? END,created_at=? WHERE id=? AND job_id=? AND provider='groq-full-coverage' AND state='CLAIMED'").bind(state,code,receipt?JSON.stringify({...binding,...receipt}):null,receipt?JSON.stringify({...binding,...receipt}):null,date(),fullCoverageOperationId(id,plan.planSha256,binding.key),id).run();
 const completeWithReceipt=async(binding,row,receipt)=>{
  const opId=fullCoverageOperationId(id,plan.planSha256,binding.key),record={...row,receiptText:receipt.text,usage:receipt.usage},json=JSON.stringify(record);
  const stored=await env.DB.prepare("UPDATE yta_operations SET state='RECEIPT_STORED',result_json=?,created_at=? WHERE id=? AND job_id=? AND provider='groq-full-coverage' AND state='CLAIMED' AND units=? AND result_json=?").bind(json,date(),opId,id,binding.reservationTokens,JSON.stringify(binding)).run();
  if(stored.meta?.changes!==1)fail('FULL_RECEIPT_STORE_RACE');
  const eventId=receiptUsageId(opId);
  await env.DB.prepare("INSERT OR IGNORE INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_FULL_COVERAGE','actual_total_tokens',?,0,NULL,'PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN',?)").bind(eventId,id,receipt.usage.totalTokens,date()).run();
  const usage=await env.DB.prepare('SELECT used_units FROM usage_events WHERE id=? AND job_id=?').bind(eventId,id).first();
  if(usage?.used_units!==receipt.usage.totalTokens)fail('FULL_USAGE_EVENT_CHANGED');
  const done=await env.DB.prepare("UPDATE yta_operations SET state='DONE',created_at=? WHERE id=? AND job_id=? AND provider='groq-full-coverage' AND state='RECEIPT_STORED' AND result_json=?").bind(date(),opId,id,json).run();
  if(done.meta?.changes!==1)fail('FULL_RECEIPT_SETTLEMENT_RACE');
 };
 const recoverStoredReceipt=async(stage,binding,expectedResponseSha256)=>{
  if(!await scope()||!await historical())fail('FULL_RECOVERY_SCOPE_CHANGED');
  const opId=fullCoverageOperationId(id,plan.planSha256,binding.key),row=await env.DB.prepare("SELECT state,result_json,units FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-full-coverage'").bind(opId,id).first();
  if(row?.state!=='RECEIPT_STORED'||row.units!==binding.reservationTokens)fail('FULL_RECOVERY_NOT_ELIGIBLE');
  let saved;try{saved=JSON.parse(row.result_json);}catch{fail('FULL_RECEIPT_INVALID');}
  if(saved?.planSha256!==plan.planSha256||saved.requestSha256!==stage.requestSha256||saved.key!==stage.key||saved.sourceHash!==plan.sourceHash||saved.responseSha256!==expectedResponseSha256||saved.responseSha256!==await sha(saved.receiptText)||!same(saved.response,validateLeafResponse(stage,saved.receiptText))||!safe(saved.actualTotalTokens)||saved.actualTotalTokens!==saved.usage?.totalTokens||saved.actualTotalTokens>stage.reservationTokens)fail('FULL_RECEIPT_INVALID');
  const eventId=receiptUsageId(opId);
  await env.DB.prepare("INSERT OR IGNORE INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_FULL_COVERAGE','actual_total_tokens',?,0,NULL,'PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN',?)").bind(eventId,id,saved.actualTotalTokens,date()).run();
  const event=await env.DB.prepare("SELECT used_units,unit,provenance FROM usage_events WHERE id=? AND job_id=? AND owner_id='owner' AND provider='groq' AND capability='LIVE_FREE_FULL_COVERAGE'").bind(eventId,id).first();
  if(event?.used_units!==saved.actualTotalTokens||event.unit!=='actual_total_tokens'||event.provenance!=='PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN')fail('FULL_USAGE_EVENT_CHANGED');
  const done=await env.DB.prepare("UPDATE yta_operations SET state='DONE' WHERE id=? AND job_id=? AND provider='groq-full-coverage' AND state='RECEIPT_STORED' AND result_json=?").bind(opId,id,row.result_json).run();
  if(done.meta?.changes!==1)fail('FULL_RECOVERY_RACE');
  return {recovered:true,providerCalls:0,stage:stage.key,actualTotalTokens:saved.actualTotalTokens};
 };
  const reopenBlocked=async(stage)=>{
   if(approval.expiresAt<=Date.now()||!await identity()||!await historical()||!await scope())fail('FULL_BLOCKED_REOPEN_SCOPE_CHANGED');
   const opId=fullCoverageOperationId(id,plan.planSha256,stage.key),row=await env.DB.prepare("SELECT state,result_json,units,error_code,created_at FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-full-coverage'").bind(opId,id).first();
   let prior;try{prior=JSON.parse(row?.result_json??'null');}catch{fail('FULL_BLOCKED_REOPEN_INVALID');}
   if(row?.state!=='BLOCKED'||row.error_code!=='PRE_DISPATCH_GUARD_FAILED'||row.units!==stage.reservationTokens||prior?.planSha256!==plan.planSha256||prior.sourceHash!==plan.sourceHash||prior.requestSha256!==stage.requestSha256||prior.key!==stage.key||prior.reservationTokens!==stage.reservationTokens||!Number.isSafeInteger(prior.approvalSequence)||prior.approvalSequence>=approval.sequence||Object.keys(prior).length!==6)fail('FULL_BLOCKED_REOPEN_INVALID');
   const oldUsage=await env.DB.prepare('SELECT 1 AS ok FROM usage_events WHERE id=? AND job_id=?').bind(receiptUsageId(opId),id).first();
   if(oldUsage)fail('FULL_BLOCKED_USAGE_PRESENT');
   const record={kind:'FULL_PRE_DISPATCH_BLOCK_REVIEW',operationId:opId,priorResultSha256:await sha(row.result_json),priorApprovalSequence:prior.approvalSequence,newApprovalSequence:approval.sequence,blockedAt:row.created_at,providerCalls:0},auditJson=JSON.stringify(record),auditId=opId+':blocked-review:'+approval.sequence;
   await env.DB.prepare("INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,o.job_id,'groq-full-coverage-blocked-review',0,'REVIEWED',?,? FROM yta_operations o WHERE o.id=? AND o.job_id=? AND o.provider='groq-full-coverage' AND o.state='BLOCKED' AND o.error_code='PRE_DISPATCH_GUARD_FAILED' AND o.result_json=? AND NOT EXISTS(SELECT 1 FROM usage_events u WHERE u.id=? AND u.job_id=o.job_id) AND EXISTS(SELECT 1 FROM yta_operations a WHERE a.id=? AND a.job_id=o.job_id AND a.provider='groq-full-coverage-approval' AND a.state='APPROVED' AND a.result_json=?)").bind(auditId,date(),auditJson,opId,id,row.result_json,receiptUsageId(opId),approvalId,approvalJson).run();
   const saved=await env.DB.prepare("SELECT state,result_json FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-full-coverage-blocked-review'").bind(auditId,id).first();
   if(saved?.state!=='REVIEWED'||saved.result_json!==auditJson||approval.expiresAt<=Date.now())fail('FULL_BLOCKED_REVIEW_NOT_STORED');
   const removed=await env.DB.prepare("DELETE FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-full-coverage' AND state='BLOCKED' AND error_code='PRE_DISPATCH_GUARD_FAILED' AND result_json=? AND NOT EXISTS(SELECT 1 FROM usage_events u WHERE u.id=? AND u.job_id=?) AND EXISTS(SELECT 1 FROM yta_operations a WHERE a.id=? AND a.job_id=? AND a.provider='groq-full-coverage-blocked-review' AND a.state='REVIEWED' AND a.result_json=?)").bind(opId,id,row.result_json,receiptUsageId(opId),id,auditId,id,auditJson).run();
   if(removed.meta?.changes!==1)fail('FULL_BLOCKED_REOPEN_RACE');
   return {reopened:true,providerCalls:0,stage:stage.key,reviewId:auditId};
  };
  const saveFinalReport=async({planSha256,sourceHash,report,records,synthesisProofs=[]})=>{
  if(planSha256!==plan.planSha256||sourceHash!==plan.sourceHash)return false;
   const stages=plan.stages.filter(item=>['NEW_HELD_LEAF','NEW_LEAF'].includes(item.kind)),proofs=stages.map(stage=>{const row=records?.get(stage.key);if(row?.state!=='DONE'||typeof row.durableResultJson!=='string'||!safe(row.actualTotalTokens)||row.actualTotalTokens>stage.reservationTokens)fail('FULL_FINAL_RECEIPT_PROOF_MISSING');return {id:fullCoverageOperationId(id,plan.planSha256,stage.key),resultJson:row.durableResultJson,units:stage.reservationTokens,actualTotalTokens:row.actualTotalTokens};}),proofJson=JSON.stringify(proofs);
   if(report?.compositionMode==='groq-full-coverage-global-v1'&&!synthesisProofs.length)fail('GLOBAL_FINAL_NODES_MISSING');
   const synthesisJson=JSON.stringify(synthesisProofs),synthesisPrefix=id+':groq-summary-complete:'+plan.sourceHash+':note:',recoveryPrefix=id+':groq-summary-synthesis-recovery:'+plan.sourceHash+':note:';
   const synthesisSql=report?.compositionMode==='groq-full-coverage-global-v1'?` AND
    (SELECT COUNT(*) FROM yta_operations x WHERE x.job_id=jobs.id AND x.provider='groq-summary-synthesis' AND substr(x.id,1,length(?))=?)=json_array_length(?)
    AND (SELECT COUNT(*) FROM yta_operations x WHERE x.job_id=jobs.id AND x.provider='groq-summary-synthesis-recovery' AND substr(x.id,1,length(?))=?)=(SELECT COUNT(*) FROM json_each(?) k WHERE json_extract(k.value,'$.recovered')=1)
    AND (SELECT COUNT(*) FROM usage_events u WHERE u.job_id=jobs.id AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_SYNTHESIS')=json_array_length(?)
    AND NOT EXISTS(SELECT 1 FROM json_each(?) k WHERE NOT EXISTS(
     SELECT 1 FROM yta_operations x JOIN yta_operations r ON r.id=json_extract(k.value,'$.receiptId') AND r.job_id=x.job_id
     JOIN usage_events u ON u.id=json_extract(k.value,'$.usageEventId') AND u.job_id=x.job_id AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_SYNTHESIS'
     LEFT JOIN yta_operations a ON a.id=json_extract(k.value,'$.approvalId') AND a.job_id=x.job_id AND a.provider='groq-summary-synthesis-approval'
     WHERE x.id=json_extract(k.value,'$.id') AND x.job_id=jobs.id AND x.provider='groq-summary-synthesis' AND x.units=6600
      AND x.state=CASE WHEN json_extract(k.value,'$.recovered')=1 THEN 'FAILED_UNCERTAIN' ELSE 'DONE' END
      AND x.result_json=json_extract(k.value,'$.resultJson')
      AND r.provider=CASE WHEN json_extract(k.value,'$.recovered')=1 THEN 'groq-summary-synthesis-recovery' ELSE 'groq-summary-synthesis' END
      AND r.state='DONE' AND r.result_json=json_extract(k.value,'$.receiptJson')
      AND (json_extract(k.value,'$.recovered')=0 OR (a.state='STOPPED' AND a.result_json=json_extract(k.value,'$.approvalJson')))
      AND u.used_units=json_extract(k.value,'$.actualTotalTokens') AND u.unit='actual_total_tokens' AND u.provenance=json_extract(k.value,'$.usageProvenance')
    ))`:'';
   const legacyFinalSql=legacyProofSql.replaceAll('o.job_id','jobs.id'),usageFinalSql=usageProofSql.replaceAll('o.job_id','jobs.id');
  const updated=await env.DB.prepare(`UPDATE jobs SET report_json=?,audit_json=json_set(audit_json,'$.summaryProvider','groq','$.externalFactCheck','NOT_PERFORMED'),updated_at=? WHERE id=? AND owner_id='owner' AND (report_json IS NULL OR report_json='null') AND audit_json=? AND EXISTS(SELECT 1 FROM yta_sources WHERE job_id=? AND raw=? AND segments_json=?) AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE id=? AND provider='deletion' AND state='DELETING') AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=jobs.id ${heldProofSql}) ${legacyFinalSql} ${usageFinalSql} ${operationSetSql('jobs')} AND (SELECT COUNT(*) FROM yta_operations o JOIN json_each(?) k ON o.id=json_extract(k.value,'$.id') JOIN usage_events u ON u.id=o.id||':usage' AND u.job_id=o.job_id AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_FULL_COVERAGE' WHERE o.job_id=jobs.id AND o.provider='groq-full-coverage' AND o.state='DONE' AND o.result_json=json_extract(k.value,'$.resultJson') AND o.units=json_extract(k.value,'$.units') AND u.used_units=json_extract(k.value,'$.actualTotalTokens') AND u.unit='actual_total_tokens' AND u.provenance='PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN')=json_array_length(?) ${synthesisSql}`).bind(JSON.stringify(report),date(),id,auditJson,id,source.raw,source.segments_json,id+':deleting',...heldProofArgs,...legacyProofArgs,usageProofJson,usageProofJson,...operationSetArgs,proofJson,proofJson,...(synthesisSql?[synthesisPrefix,synthesisPrefix,synthesisJson,recoveryPrefix,recoveryPrefix,synthesisJson,synthesisJson,synthesisJson]:[])).run();
  return updated.meta?.changes===1;
 };
 const verifySectionsSnapshot=async(records)=>{
  const stages=plan.stages.filter(item=>['NEW_HELD_LEAF','NEW_LEAF'].includes(item.kind));
  const proofs=stages.map(stage=>{const row=records?.get(stage.key);if(row?.state!=='DONE'||typeof row.durableResultJson!=='string'||!safe(row.actualTotalTokens)||row.actualTotalTokens>stage.reservationTokens)fail('GLOBAL_SECTION_RECEIPT_INVALID');return {id:fullCoverageOperationId(id,plan.planSha256,stage.key),resultJson:row.durableResultJson,units:stage.reservationTokens,actualTotalTokens:row.actualTotalTokens};});
  const proofJson=JSON.stringify(proofs),legacyFinalSql=legacyProofSql.replaceAll('o.job_id','j.id'),usageFinalSql=usageProofSql.replaceAll('o.job_id','j.id');
  const row=await env.DB.prepare(`SELECT 1 AS ok FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND j.audit_json=? AND s.raw=? AND s.segments_json=? AND ${writeLockSql} AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.provider='deletion' AND d.state='DELETING') ${heldProofSql} ${legacyFinalSql} ${usageFinalSql} ${operationSetSql('j')} AND (SELECT COUNT(*) FROM yta_operations o JOIN json_each(?) k ON o.id=json_extract(k.value,'$.id') JOIN usage_events u ON u.id=o.id||':usage' AND u.job_id=o.job_id AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_FULL_COVERAGE' WHERE o.job_id=j.id AND o.provider='groq-full-coverage' AND o.state='DONE' AND o.result_json=json_extract(k.value,'$.resultJson') AND o.units=json_extract(k.value,'$.units') AND u.used_units=json_extract(k.value,'$.actualTotalTokens') AND u.unit='actual_total_tokens' AND u.provenance='PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN')=json_array_length(?)`).bind(id,auditJson,source.raw,source.segments_json,id+':deleting',...heldProofArgs,...legacyProofArgs,usageProofJson,usageProofJson,...operationSetArgs,proofJson,proofJson).first();
  return row?.ok===1;
 };
 const readFinalReport=async()=>{const saved=await env.DB.prepare("SELECT report_json FROM jobs WHERE id=? AND owner_id='owner'").bind(id).first();try{return JSON.parse(saved?.report_json??'null');}catch{return null;}};
  return {claim,verifyBeforeDispatch,verifySectionsSnapshot,markBlocked:binding=>mark(binding,'BLOCKED','PRE_DISPATCH_GUARD_FAILED'),markUncertain:(binding,result)=>mark(binding,'FAILED_UNCERTAIN',result.code,result),completeWithReceipt,recoverStoredReceipt,reopenBlocked,load,loadAll,saveFinalReport,readFinalReport};
}
