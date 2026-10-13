import {ProviderError} from './adapters.mjs';
import {capacityIdentity} from './observed-capacity.mjs';
import {completeSource,promptAudit,summaryInputAudit} from './groq-summary.mjs';
import {PAID_SUMMARY_CATALOG,paidExecutionEnabled,fullSummaryRequest,paidRequestCostPreview,validatePaidFullReport} from './paid-summary-contract.mjs';
import {priceSummaryQuote} from './paid-summary-budget.mjs';
import {runPaidGeminiFullSummary} from './paid-summary-adapter.mjs';
import {PAID_RECEIPT_MAX_BYTES} from './paid-summary-receipt.mjs';

const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
const fail=(code,message='새 유료 시도의 원본·승인·비용 기록을 검토하세요.')=>{throw new ProviderError(code,message);};
const now=()=>new Date().toISOString();
const bytes=new TextEncoder();
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.encode(value)))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
const digest=value=>hash(JSON.stringify(value));
const checkedJson=text=>{try{return JSON.parse(text);}catch{fail('PAID_RETRY_SCOPE_CHANGED');}};
const exactQuote=(saved,trusted)=>JSON.stringify(saved)===JSON.stringify(trusted);

async function credentialSnapshot(env,generation){
 const row=await env.DB.prepare("SELECT cipher_version,iv_b64,ciphertext_b64,updated_at FROM provider_credentials WHERE owner_id='owner' AND provider='gemini'").first();
 if(!row||await capacityIdentity(env,'gemini')!==generation)fail('PAID_CREDENTIAL_CHANGED');
 return row;
}
async function schema(DB){
 const rows=(await DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('yta_paid_retry_quotes','yta_paid_retry_attempts','yta_paid_retry_receipts')").all()).results??[];
 if(rows.length!==3)fail('PAID_RETRY_SCHEMA_REQUIRED','별도 승인된 재실행 원장 migration이 필요합니다.');
}
async function currentScope(env,job,sourceOf){
 const source=(await completeSource(env,job,sourceOf)).source;
 const sourceSnapshot={raw:source.raw,segmentsJson:source.segments_json,auditJson:JSON.stringify(summaryInputAudit(job.audit))};
 const request=fullSummaryRequest(source,promptAudit(job));
 return {source,sourceSnapshot,request,sourceSha256:await digest(sourceSnapshot),requestSha256:await digest(request.body)};
}
async function quoteFor(id,current,generation,expiresAt){
 const catalog=PAID_SUMMARY_CATALOG;
 return priceSummaryQuote({jobId:id,sourceSha256:current.sourceSha256,requestSha256:current.requestSha256,model:catalog.model,priceVersion:catalog.priceVersion,priceSource:catalog.priceSource,inputTokensUpper:current.request.inputChargeCeiling,outputTokensUpper:current.request.outputChargeCeiling,plannedCalls:1,maxRetries:0,maxTaxBps:10000,priceInputMicroUsdPerMillion:catalog.inputPriceMicroUsdPerMillion,priceOutputMicroUsdPerMillion:catalog.outputPriceMicroUsdPerMillion,credentialGeneration:generation,expiresAt,costEstimate:paidRequestCostPreview(current.request)});
}
async function prior(DB,id){
 const rows=(await DB.prepare("SELECT a.id AS approval_id,r.id AS reservation_id,r.state,r.outcome,r.reserved_micro_usd,r.token_estimate_micro_usd,r.usage_json,t.state AS trial_state,t.source_sha256 AS trial_source_sha256,t.request_sha256 AS trial_request_sha256,p.response_complete,p.response_json,p.state AS receipt_state FROM yta_paid_summary_approvals a JOIN yta_paid_summary_reservations r ON r.approval_id=a.id JOIN yta_paid_first_trial t ON t.approval_id=a.id LEFT JOIN yta_paid_summary_receipts p ON p.reservation_id=r.id AND p.job_id=a.job_id AND p.owner_id='owner' WHERE a.job_id=? AND a.owner_id='owner'").bind(id).all()).results??[];
 if(rows.length!==1||rows[0].trial_state!=='CONSUMED'||!['SETTLED','RELEASED'].includes(rows[0].state)||rows[0].outcome==='REPORT_SAVED')fail('PAID_RETRY_PRIOR_NOT_TERMINAL');
 return rows[0];
}
const retainedResponse=row=>row.response_complete===1&&typeof row.response_json==='string';
async function eligible(env,id,job){
 if(job.report)fail('SUMMARY_ALREADY_EXISTS');
 const previous=await prior(env.DB,id);
 if(retainedResponse(previous))fail('PAID_REVALIDATION_FIRST','보존된 첫 응답을 제공자 호출 없이 재검증하세요.');
 return previous;
}
async function attemptFor(DB,id){return DB.prepare("SELECT * FROM yta_paid_retry_attempts WHERE job_id=? AND owner_id='owner'").bind(id).first();}
async function receiptFor(DB,id,attemptId){return DB.prepare("SELECT state,error_code,source_sha256,request_sha256,quote_sha256,response_bytes,response_complete,response_sha256,http_status,finish_reason,model_version,response_json,usage_json FROM yta_paid_retry_receipts WHERE attempt_id=? AND job_id=? AND owner_id='owner'").bind(attemptId,id).first();}
function publicAttempt(row){if(!row)return null;return {id:row.id,quoteId:row.quote_id,state:row.state,outcome:row.outcome,expiresAt:row.expires_at,maxMicroUsd:row.max_micro_usd,maxCalls:row.max_calls,tokenEstimateMicroUsd:row.token_estimate_micro_usd,usage:row.usage_json?checkedJson(row.usage_json):null,priorReservationId:row.prior_reservation_id};}
function publicReceipt(row){if(!row)return null;const {response_json,usage_json,...safe}=row;return {...safe,revalidationAvailable:row.response_complete===1&&row.http_status===200&&(row.finish_reason===null||row.finish_reason==='STOP')&&['RECEIVED','VALIDATION_FAILED','SAVE_FAILED'].includes(row.state)};}
async function status(env,id,job,sourceOf){
 const previous=await prior(env.DB,id).catch(error=>{if(error.code==='PAID_RETRY_PRIOR_NOT_TERMINAL')return null;throw error;});
 const attempt=await attemptFor(env.DB,id),receipt=attempt?await receiptFor(env.DB,id,attempt.id):null;
 const quote=await env.DB.prepare("SELECT id,quote_json,quote_sha256,source_sha256,request_sha256,expires_at,prior_reservation_id FROM yta_paid_retry_quotes WHERE job_id=? AND owner_id='owner' AND state='ISSUED' AND expires_at>? ORDER BY created_at DESC LIMIT 1").bind(id,Date.now()).first();
 let validIssuedQuote=null;
 if(quote&&!job.report&&!attempt)try{const current=await currentScope(env,job,sourceOf),trusted=await quoteFor(id,current,await capacityIdentity(env,'gemini'),quote.expires_at);if(quote.source_sha256===current.sourceSha256&&quote.request_sha256===current.requestSha256&&quote.quote_sha256===trusted.quoteSha256&&exactQuote(checkedJson(quote.quote_json),trusted))validIssuedQuote=trusted;}catch{}
 const blockedReason=job.report?'SUMMARY_ALREADY_EXISTS':!previous?'PAID_RETRY_PRIOR_NOT_TERMINAL':retainedResponse(previous)?'PAID_REVALIDATION_FIRST':attempt?'PAID_RETRY_ALREADY_APPROVED':null;
 const firstTrial=previous?{approvalId:previous.approval_id,reservationId:previous.reservation_id,trialState:previous.trial_state,reservationState:previous.state,outcome:previous.outcome,reservedMicroUsd:previous.reserved_micro_usd,tokenEstimateMicroUsd:previous.token_estimate_micro_usd,usage:previous.usage_json?checkedJson(previous.usage_json):null,receiptRetained:retainedResponse(previous)}:null;
 return json({jobId:id,firstTrial,attempt:publicAttempt(attempt),receipt:publicReceipt(receipt),cancelReady:attempt?.state==='APPROVED'&&!receipt,issuedQuote:validIssuedQuote&&!blockedReason?{quoteId:quote.id,quote:validIssuedQuote,priorReservationId:quote.prior_reservation_id,ordinaryPaidGateReady:paidExecutionEnabled(env)}:null,quoteIssueReady:!blockedReason,blockedReason,ordinaryPaidGateReady:paidExecutionEnabled(env),gateEvidenceRequired:['CURRENT_MODEL_ACCESS_FOR_KEY_AND_PROJECT','APPLICABLE_TAX_UPPER_BOUND','CURRENT_CATALOG_PRICE_AND_PREPAID_BALANCE'],finalReportSaved:job.report?.kind==='GEMINI_PAID_FULL_EVIDENCE_LINKED',priorCostPreserved:true,providerInvoiceAmount:'UNKNOWN'});
}
async function issueQuote(env,id,job,sourceOf){
 const previous=await eligible(env,id,job),DB=env.DB;
 if(await attemptFor(DB,id))fail('PAID_RETRY_ALREADY_APPROVED');
 const key=await DB.prepare("SELECT 1 AS ok FROM provider_credentials WHERE owner_id='owner' AND provider='gemini'").first();if(!key)fail('PAID_CREDENTIAL_UNAVAILABLE');
 const current=await currentScope(env,job,sourceOf),generation=await capacityIdentity(env,'gemini');
 if(previous.trial_source_sha256!==current.sourceSha256||previous.trial_request_sha256!==current.requestSha256)fail('PAID_RETRY_PRIOR_CHANGED');
 const old=await DB.prepare("SELECT id,quote_json,source_sha256,request_sha256,quote_sha256,prior_reservation_id,expires_at FROM yta_paid_retry_quotes WHERE job_id=? AND owner_id='owner' AND state='ISSUED' AND expires_at>?").bind(id,Date.now()).first();
 if(old){const trusted=await quoteFor(id,current,generation,old.expires_at);if(old.source_sha256===current.sourceSha256&&old.request_sha256===current.requestSha256&&old.quote_sha256===trusted.quoteSha256&&exactQuote(checkedJson(old.quote_json),trusted)&&old.prior_reservation_id===previous.reservation_id)return {quoteId:old.id,quote:trusted,priorReservationId:previous.reservation_id,ordinaryPaidGateReady:paidExecutionEnabled(env)};fail('PAID_RETRY_QUOTE_CHANGED');}
 await DB.prepare("UPDATE yta_paid_retry_quotes SET state='EXPIRED' WHERE job_id=? AND owner_id='owner' AND state='ISSUED' AND expires_at<=?").bind(id,Date.now()).run();
 const quote=await quoteFor(id,current,generation,Date.now()+600_000),quoteId=crypto.randomUUID();
 const inserted=await DB.prepare("INSERT OR IGNORE INTO yta_paid_retry_quotes(id,job_id,owner_id,prior_approval_id,prior_reservation_id,source_sha256,request_sha256,quote_sha256,quote_json,state,expires_at,created_at) SELECT ?,j.id,'owner',a.id,r.id,?,?,?,?,'ISSUED',?,? FROM jobs j JOIN yta_sources s ON s.job_id=j.id JOIN yta_paid_summary_approvals a ON a.job_id=j.id AND a.owner_id='owner' JOIN yta_paid_summary_reservations r ON r.approval_id=a.id JOIN yta_paid_first_trial t ON t.approval_id=a.id WHERE j.id=? AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND json_remove(j.audit_json,'$.summaryProvider','$.externalFactCheck')=? AND s.raw=? AND s.segments_json=? AND r.id=? AND r.state IN ('SETTLED','RELEASED') AND r.outcome IS NOT 'REPORT_SAVED' AND t.state='CONSUMED' AND t.source_sha256=a.source_sha256 AND NOT EXISTS(SELECT 1 FROM yta_paid_summary_receipts p WHERE p.reservation_id=r.id AND p.response_complete=1 AND p.response_json IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM yta_paid_retry_attempts x WHERE x.job_id=j.id) AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(quoteId,current.sourceSha256,current.requestSha256,quote.quoteSha256,JSON.stringify(quote),quote.expiresAt,now(),id,current.sourceSnapshot.auditJson,current.sourceSnapshot.raw,current.sourceSnapshot.segmentsJson,previous.reservation_id).run();
 if(inserted.meta?.changes!==1)fail('PAID_RETRY_QUOTE_RACE');
 return {quoteId,quote,priorReservationId:previous.reservation_id,ordinaryPaidGateReady:paidExecutionEnabled(env),automaticExecution:false};
}
async function approve(env,id,job,sourceOf,body){
 if(!paidExecutionEnabled(env))fail('PAID_EXECUTION_DISABLED');
 if(body?.confirmExactQuote!==true||body.confirmPriorCostPreserved!==true||body.confirmNoAutomaticRetry!==true||body.confirmNoAutomaticFallback!==true||typeof body.quoteId!=='string'||typeof body.priorReservationId!=='string')fail('PAID_RETRY_APPROVAL_REQUIRED');
 const previous=await eligible(env,id,job),DB=env.DB;if(previous.reservation_id!==body.priorReservationId)fail('PAID_RETRY_PRIOR_CHANGED');
 const row=await DB.prepare("SELECT * FROM yta_paid_retry_quotes WHERE id=? AND job_id=? AND owner_id='owner' AND state='ISSUED' AND expires_at>?").bind(body.quoteId,id,Date.now()).first();if(!row||row.prior_reservation_id!==previous.reservation_id||row.prior_approval_id!==previous.approval_id)fail('PAID_RETRY_QUOTE_CHANGED');
 const current=await currentScope(env,job,sourceOf),quote=checkedJson(row.quote_json),trusted=await quoteFor(id,current,await capacityIdentity(env,'gemini'),row.expires_at);
 if(previous.trial_source_sha256!==current.sourceSha256||previous.trial_request_sha256!==current.requestSha256||!exactQuote(quote,trusted)||row.quote_sha256!==trusted.quoteSha256||row.source_sha256!==current.sourceSha256||row.request_sha256!==current.requestSha256||body.maxMicroUsd!==quote.maxMicroUsd||body.maxCalls!==1||body.expiresAt!==quote.expiresAt||quote.maxRetries!==0)fail('PAID_RETRY_QUOTE_CHANGED');
 const key=await credentialSnapshot(env,quote.credentialGeneration),attemptId=crypto.randomUUID(),stamp=now();
 const inserted=await DB.prepare("INSERT OR IGNORE INTO yta_paid_retry_attempts(id,job_id,owner_id,quote_id,prior_approval_id,prior_reservation_id,source_sha256,request_sha256,quote_sha256,quote_json,model,credential_generation,max_micro_usd,max_calls,expires_at,state,created_at,updated_at) SELECT ?,j.id,'owner',q.id,q.prior_approval_id,q.prior_reservation_id,q.source_sha256,q.request_sha256,q.quote_sha256,q.quote_json,?,?,?,1,?,'APPROVED',?,? FROM yta_paid_retry_quotes q JOIN jobs j ON j.id=q.job_id JOIN yta_sources s ON s.job_id=j.id JOIN yta_paid_summary_reservations r ON r.id=q.prior_reservation_id JOIN yta_paid_first_trial t ON t.approval_id=q.prior_approval_id AND t.approval_id=r.approval_id JOIN provider_credentials c ON c.owner_id='owner' AND c.provider='gemini' WHERE q.id=? AND q.state='ISSUED' AND q.expires_at>? AND j.id=? AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND json_remove(j.audit_json,'$.summaryProvider','$.externalFactCheck')=? AND s.raw=? AND s.segments_json=? AND r.state IN ('SETTLED','RELEASED') AND r.outcome IS NOT 'REPORT_SAVED' AND t.state='CONSUMED' AND q.source_sha256=? AND q.request_sha256=? AND q.quote_sha256=? AND q.quote_json=? AND c.cipher_version=? AND c.iv_b64=? AND c.ciphertext_b64=? AND c.updated_at=? AND NOT EXISTS(SELECT 1 FROM yta_paid_summary_receipts p WHERE p.reservation_id=r.id AND p.response_complete=1 AND p.response_json IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM yta_paid_retry_attempts x WHERE x.job_id=j.id) AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(attemptId,quote.model,quote.credentialGeneration,quote.maxMicroUsd,body.expiresAt,stamp,stamp,row.id,Date.now(),id,current.sourceSnapshot.auditJson,current.sourceSnapshot.raw,current.sourceSnapshot.segmentsJson,current.sourceSha256,current.requestSha256,quote.quoteSha256,JSON.stringify(quote),key.cipher_version,key.iv_b64,key.ciphertext_b64,key.updated_at).run();
 if(inserted.meta?.changes!==1)fail('PAID_RETRY_APPROVAL_RACE');
 return {attemptId,quoteId:row.id,state:'APPROVED',maxMicroUsd:quote.maxMicroUsd,expiresAt:body.expiresAt,automaticExecution:false,priorCostPreserved:true};
}

async function saveReport(env,id,current,report,attemptId){
 const saved=await env.DB.prepare("UPDATE jobs SET report_json=?,audit_json=json_set(audit_json,'$.summaryProvider','gemini-paid','$.externalFactCheck','NOT_PERFORMED'),status='COMPLETE',updated_at=? WHERE id=? AND owner_id='owner' AND (report_json IS NULL OR report_json='null') AND json_remove(audit_json,'$.summaryProvider','$.externalFactCheck')=? AND EXISTS(SELECT 1 FROM yta_sources WHERE job_id=? AND raw=? AND segments_json=?) AND EXISTS(SELECT 1 FROM yta_paid_retry_attempts WHERE id=? AND job_id=? AND state IN ('RESERVED','UNCERTAIN','SETTLED')) AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE id=? AND state='DELETING')").bind(JSON.stringify(report),now(),id,current.sourceSnapshot.auditJson,id,current.sourceSnapshot.raw,current.sourceSnapshot.segmentsJson,attemptId,id,id+':deleting').run();
 if(saved.meta?.changes!==1)fail('PAID_SAVE_SCOPE_CHANGED');
}
async function reserve(env,id,current,attempt,quote){
 const changed=await env.DB.prepare("UPDATE yta_paid_retry_attempts SET state='RESERVED',updated_at=? WHERE id=? AND job_id=? AND owner_id='owner' AND state='APPROVED' AND expires_at>? AND source_sha256=? AND request_sha256=? AND quote_sha256=? AND quote_json=? AND max_micro_usd=? AND max_calls=1 AND EXISTS(SELECT 1 FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND json_remove(j.audit_json,'$.summaryProvider','$.externalFactCheck')=? AND s.raw=? AND s.segments_json=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')) AND EXISTS(SELECT 1 FROM yta_paid_summary_reservations r JOIN yta_paid_first_trial t ON t.approval_id=r.approval_id AND t.approval_id=? WHERE r.id=? AND r.state IN ('SETTLED','RELEASED') AND r.outcome IS NOT 'REPORT_SAVED' AND t.state='CONSUMED') AND NOT EXISTS(SELECT 1 FROM yta_paid_summary_receipts p WHERE p.reservation_id=? AND p.response_complete=1 AND p.response_json IS NOT NULL)").bind(now(),attempt.id,id,Date.now(),current.sourceSha256,current.requestSha256,quote.quoteSha256,JSON.stringify(quote),quote.maxMicroUsd,id,current.sourceSnapshot.auditJson,current.sourceSnapshot.raw,current.sourceSnapshot.segmentsJson,attempt.prior_approval_id,attempt.prior_reservation_id,attempt.prior_reservation_id).run();
 if(changed.meta?.changes!==1)fail('PAID_RETRY_ALREADY_CLAIMED');
}
async function dispatchGuard(env,id,current,attempt,quote,sourceOf){
 if(!paidExecutionEnabled(env))fail('PAID_EXECUTION_DISABLED');
 const key=await credentialSnapshot(env,attempt.credential_generation);
 const row=await env.DB.prepare("SELECT a.expires_at FROM yta_paid_retry_attempts a JOIN jobs j ON j.id=a.job_id JOIN yta_sources s ON s.job_id=j.id JOIN provider_credentials c ON c.owner_id='owner' AND c.provider='gemini' JOIN yta_paid_summary_reservations r ON r.id=a.prior_reservation_id JOIN yta_paid_first_trial t ON t.approval_id=a.prior_approval_id AND t.approval_id=r.approval_id WHERE a.id=? AND a.job_id=? AND a.state='RESERVED' AND a.expires_at>? AND a.source_sha256=? AND a.request_sha256=? AND a.quote_sha256=? AND a.quote_json=? AND a.max_micro_usd=? AND a.max_calls=1 AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND json_remove(j.audit_json,'$.summaryProvider','$.externalFactCheck')=? AND s.raw=? AND s.segments_json=? AND c.cipher_version=? AND c.iv_b64=? AND c.ciphertext_b64=? AND c.updated_at=? AND r.state IN ('SETTLED','RELEASED') AND r.outcome IS NOT 'REPORT_SAVED' AND t.state='CONSUMED' AND t.source_sha256=a.source_sha256 AND NOT EXISTS(SELECT 1 FROM yta_paid_summary_receipts p WHERE p.reservation_id=r.id AND p.response_complete=1 AND p.response_json IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(attempt.id,id,Date.now(),current.sourceSha256,current.requestSha256,quote.quoteSha256,JSON.stringify(quote),quote.maxMicroUsd,current.sourceSnapshot.auditJson,current.sourceSnapshot.raw,current.sourceSnapshot.segmentsJson,key.cipher_version,key.iv_b64,key.ciphertext_b64,key.updated_at).first();
 if(!row)fail('PAID_RETRY_DISPATCH_SCOPE_CHANGED');
 const latestJob=await env.DB.prepare("SELECT id,duration_seconds,audit_json,source_type FROM jobs WHERE id=? AND owner_id='owner'").bind(id).first();
 const refreshed=latestJob?await currentScope(env,{...latestJob,audit:checkedJson(latestJob.audit_json)},sourceOf).catch(()=>null):null;
 if(!refreshed||refreshed.sourceSha256!==current.sourceSha256||refreshed.requestSha256!==current.requestSha256||await capacityIdentity(env,'gemini')!==attempt.credential_generation||Date.now()>=row.expires_at||Date.now()>=quote.expiresAt||!paidExecutionEnabled(env))fail('PAID_RETRY_DISPATCH_SCOPE_CHANGED');
}
async function preserveReceipt(DB,id,attemptId,current,quote,response){
 const complete=response.complete&&typeof response.responseText==='string'&&bytes.encode(response.responseText).length===response.responseBytes&&response.responseBytes<=PAID_RECEIPT_MAX_BYTES;
 const responseHash=complete?await hash(response.responseText):null,stamp=now();
 const inserted=await DB.prepare("INSERT OR IGNORE INTO yta_paid_retry_receipts(attempt_id,job_id,owner_id,source_sha256,request_sha256,quote_sha256,response_sha256,response_bytes,response_json,response_complete,http_status,state,error_code,created_at,updated_at) SELECT a.id,a.job_id,'owner',a.source_sha256,a.request_sha256,a.quote_sha256,?,?,?,?,?,?,?,?,? FROM yta_paid_retry_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=? AND a.job_id=? AND a.state='RESERVED' AND a.source_sha256=? AND a.request_sha256=? AND a.quote_sha256=? AND (j.report_json IS NULL OR j.report_json='null') AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(responseHash,response.responseBytes,complete?response.responseText:null,complete?1:0,response.httpStatus,complete?'RECEIVED':'INCOMPLETE',complete?null:response.errorCode??'PAID_RESPONSE_INCOMPLETE',stamp,stamp,attemptId,id,current.sourceSha256,current.requestSha256,quote.quoteSha256).run();
 if(inserted.meta?.changes!==1)fail('PAID_RETRY_RECEIPT_SCOPE_CHANGED');
 if(!complete)fail(response.errorCode??'PAID_RESPONSE_INCOMPLETE');
 const stored=await receiptFor(DB,id,attemptId);
 if(stored?.response_complete!==1||stored.response_bytes!==response.responseBytes||stored.response_sha256!==responseHash||stored.response_json!==response.responseText||await hash(stored.response_json)!==responseHash)fail('PAID_RETRY_RECEIPT_READBACK_FAILED');
}
async function markReceipt(DB,id,attemptId,state,errorCode=null,details={}){
 const changed=await DB.prepare("UPDATE yta_paid_retry_receipts SET state=?,error_code=?,model_version=COALESCE(?,model_version),finish_reason=COALESCE(?,finish_reason),usage_json=COALESCE(?,usage_json),updated_at=? WHERE attempt_id=? AND job_id=? AND owner_id='owner' AND state NOT IN ('SAVED','SOURCE_DELETED')").bind(state,errorCode,details.modelVersion??null,details.finishReason??null,details.usage?JSON.stringify(details.usage):null,now(),attemptId,id).run();
 if(changed.meta?.changes!==1)fail('PAID_RETRY_RECEIPT_STATE_CHANGED');
}
async function settle(DB,id,attemptId,quote,usage,outcome){
 const input=usage?.promptTokenCount,output=usage?.candidatesTokenCount,thinking=usage?.thoughtsTokenCount??0;
 if(![input,output,thinking].every(n=>Number.isSafeInteger(n)&&n>=0)||input>quote.inputTokensUpper||output+thinking>quote.outputTokensUpper){await DB.prepare("UPDATE yta_paid_retry_attempts SET state='UNCERTAIN',outcome='USAGE_OUT_OF_SCOPE',updated_at=? WHERE id=? AND job_id=? AND state='RESERVED'").bind(now(),attemptId,id).run();return;}
 const estimate=Math.ceil(input*quote.priceInputMicroUsdPerMillion/1_000_000)+Math.ceil((output+thinking)*quote.priceOutputMicroUsdPerMillion/1_000_000);
 const changed=await DB.prepare("UPDATE yta_paid_retry_attempts SET state='SETTLED',outcome=?,usage_json=?,token_estimate_micro_usd=?,updated_at=? WHERE id=? AND job_id=? AND state='RESERVED'").bind(outcome,JSON.stringify({promptTokenCount:input,candidatesTokenCount:output,thoughtsTokenCount:thinking}),estimate,now(),attemptId,id).run();
 if(changed.meta?.changes!==1)fail('PAID_RETRY_LEDGER_CHANGED');
}
async function cancel(env,id,body){
 if(typeof body?.attemptId!=='string'||body.confirmCancelSecondAttempt!==true)fail('PAID_RETRY_CANCEL_REQUIRED');
 const changed=await env.DB.prepare("UPDATE yta_paid_retry_attempts SET state='CANCELLED',outcome='CANCELLED_BEFORE_SEND',updated_at=? WHERE id=? AND job_id=? AND owner_id='owner' AND state='APPROVED' AND NOT EXISTS(SELECT 1 FROM yta_paid_retry_receipts p WHERE p.attempt_id=yta_paid_retry_attempts.id)").bind(now(),body.attemptId,id).run();
 if(changed.meta?.changes!==1)fail('PAID_RETRY_CANCEL_BLOCKED','두 번째 시도가 전송됐거나 승인 상태가 아닙니다. 상태를 확인하세요.');
 return {cancelled:true,attemptId:body.attemptId,firstTrialPreserved:true,automaticRefund:false};
}
async function execute(env,id,job,sourceOf,ownedJob,body){
 if(!paidExecutionEnabled(env))fail('PAID_EXECUTION_DISABLED');
 if(typeof body?.attemptId!=='string')fail('PAID_RETRY_APPROVAL_REQUIRED');
 const attempt=await env.DB.prepare("SELECT * FROM yta_paid_retry_attempts WHERE id=? AND job_id=? AND owner_id='owner'").bind(body.attemptId,id).first();
 if(!attempt||attempt.state!=='APPROVED'||attempt.expires_at<=Date.now()||job.report)fail('PAID_RETRY_ALREADY_CLAIMED');
 const previous=await eligible(env,id,job);if(previous.reservation_id!==attempt.prior_reservation_id||previous.approval_id!==attempt.prior_approval_id)fail('PAID_RETRY_PRIOR_CHANGED');
 const current=await currentScope(env,job,sourceOf),quote=checkedJson(attempt.quote_json),trusted=await quoteFor(id,current,await capacityIdentity(env,'gemini'),attempt.expires_at);
 if(previous.trial_source_sha256!==current.sourceSha256||previous.trial_request_sha256!==current.requestSha256||!exactQuote(quote,trusted)||attempt.quote_sha256!==trusted.quoteSha256||attempt.source_sha256!==current.sourceSha256||attempt.request_sha256!==current.requestSha256||attempt.max_micro_usd!==quote.maxMicroUsd||attempt.max_calls!==1||quote.maxRetries!==0)fail('PAID_RETRY_SCOPE_CHANGED');
 await reserve(env,id,current,attempt,quote);
 let dispatched=false,receiptRecorded=false,recordedUsage=null,result;
 try{
  const runner=env.PAID_SUMMARY_TEST_RUNNER??runPaidGeminiFullSummary;
  const beforeFetch=async()=>{await dispatchGuard(env,id,current,attempt,quote,sourceOf);dispatched=true;};
  const recordResponse=async response=>{await preserveReceipt(env.DB,id,attempt.id,current,quote,response);receiptRecorded=true;};
  const recordEnvelope=async details=>{recordedUsage=details.usage??null;await markReceipt(env.DB,id,attempt.id,details.state,details.errorCode,details);};
  result=await runner({env,body:current.request.body,quote,firstTrial:false,beforeFetch,recordResponse,recordEnvelope});
  if(!dispatched)fail('PAID_ADAPTER_GUARD_MISSING');
  if(env.PAID_SUMMARY_TEST_RUNNER&&!receiptRecorded){const responseText=JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:result.text}]}}],usageMetadata:result.usage,modelVersion:'offline-test'});await recordResponse({responseText,responseBytes:bytes.encode(responseText).length,httpStatus:200,complete:true});await recordEnvelope({state:'RECEIVED',usage:result.usage,modelVersion:'offline-test',finishReason:'STOP'});}
  if(!receiptRecorded)fail('PAID_RECEIPT_GUARD_MISSING');
  let report;try{report=validatePaidFullReport(result.text,current.source);}catch(error){await markReceipt(env.DB,id,attempt.id,'VALIDATION_FAILED',error.safeValidationCode??error.code??'PAID_RESPONSE_UNGROUNDED');throw error;}
  try{await saveReport(env,id,current,report,attempt.id);}catch(error){await markReceipt(env.DB,id,attempt.id,'SAVE_FAILED',error.code??'LIVE_INTERNAL_ERROR');throw error;}
  await settle(env.DB,id,attempt.id,quote,result.usage,'REPORT_SAVED');
  await markReceipt(env.DB,id,attempt.id,'SAVED').catch(()=>{});
  return json({job:await ownedJob(env,id),persisted:true,attemptId:attempt.id,priorCostPreserved:true,providerInvoiceAmount:'UNKNOWN'});
 }catch(error){
  if(!dispatched)await env.DB.prepare("UPDATE yta_paid_retry_attempts SET state='RELEASED',outcome='PROVEN_NOT_SENT',updated_at=? WHERE id=? AND state='RESERVED'").bind(now(),attempt.id).run();
  else if(result?.usage||recordedUsage){const saved=await env.DB.prepare("SELECT json_extract(report_json,'$.kind') AS kind FROM jobs WHERE id=? AND owner_id='owner'").bind(id).first();await settle(env.DB,id,attempt.id,quote,result?.usage??recordedUsage,saved?.kind==='GEMINI_PAID_FULL_EVIDENCE_LINKED'?'REPORT_SAVED':'REPORT_NOT_SAVED');}
  else await env.DB.prepare("UPDATE yta_paid_retry_attempts SET state='UNCERTAIN',updated_at=? WHERE id=? AND state='RESERVED'").bind(now(),attempt.id).run();
  throw error;
 }
}
async function revalidate(env,id,job,sourceOf,ownedJob,body){
 if(body?.confirmNoProviderCall!==true||typeof body.attemptId!=='string')fail('PAID_RETRY_REVALIDATION_REQUIRED');
 if(job.report?.kind==='GEMINI_PAID_FULL_EVIDENCE_LINKED')return json({job,cached:true,providerCalled:false});
 if(job.report)fail('SUMMARY_ALREADY_EXISTS');
 const attempt=await env.DB.prepare("SELECT * FROM yta_paid_retry_attempts WHERE id=? AND job_id=? AND owner_id='owner'").bind(body.attemptId,id).first();
 const current=await currentScope(env,job,sourceOf),receipt=attempt?await receiptFor(env.DB,id,attempt.id):null;
 if(!attempt||!['SETTLED','UNCERTAIN','RESERVED'].includes(attempt.state)||!receipt||receipt.response_complete!==1||receipt.http_status!==200||typeof receipt.response_json!=='string'||bytes.encode(receipt.response_json).length!==receipt.response_bytes||receipt.response_bytes>PAID_RECEIPT_MAX_BYTES||await hash(receipt.response_json)!==receipt.response_sha256||receipt.source_sha256!==current.sourceSha256||receipt.request_sha256!==current.requestSha256||receipt.quote_sha256!==attempt.quote_sha256||attempt.source_sha256!==current.sourceSha256||attempt.request_sha256!==current.requestSha256||attempt.quote_sha256!==checkedJson(attempt.quote_json).quoteSha256||await digest(Object.fromEntries(Object.entries(checkedJson(attempt.quote_json)).filter(([key])=>key!=='quoteSha256')))!==attempt.quote_sha256)fail('PAID_RETRY_RECEIPT_SCOPE_CHANGED');
 const envelope=checkedJson(receipt.response_json),candidate=envelope.candidates?.[0],output=candidate?.content?.parts?.map(part=>part.text||'').join('')||'';
 if(candidate?.finishReason!=='STOP'||!output)fail('PAID_RETRY_RECEIPT_NOT_COMPLETE');
 let report;try{report=validatePaidFullReport(output,current.source);}catch(error){await markReceipt(env.DB,id,attempt.id,'VALIDATION_FAILED',error.safeValidationCode??error.code??'PAID_RESPONSE_UNGROUNDED');throw error;}
 await saveReport(env,id,current,report,attempt.id);
 await markReceipt(env.DB,id,attempt.id,'SAVED').catch(()=>{});
 return json({job:await ownedJob(env,id),persisted:true,providerCalled:false,priorCostPreserved:true,settlementUnchanged:true});
}

export async function handlePaidRetryAction(request,env,{id,action,job,sourceOf,ownedJob}){
 await schema(env.DB);
 if(action==='paid-retry-status'&&request.method==='GET')return status(env,id,job,sourceOf);
 if(action==='paid-retry-quote'&&request.method==='POST')return json(await issueQuote(env,id,job,sourceOf));
 if(action==='paid-retry-approve'&&request.method==='POST')return json(await approve(env,id,job,sourceOf,await request.json()));
 if(action==='paid-retry-cancel'&&request.method==='POST')return json(await cancel(env,id,await request.json()));
 if(action==='paid-retry-execute'&&request.method==='POST')return execute(env,id,job,sourceOf,ownedJob,await request.json());
 if(action==='paid-retry-revalidate'&&request.method==='POST')return revalidate(env,id,job,sourceOf,ownedJob,await request.json());
 return json({error:{code:'METHOD_NOT_ALLOWED'}},405);
}
