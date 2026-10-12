import {ProviderError} from './adapters.mjs';

// Below D1's row and bound-value limits, including the other receipt columns.
export const PAID_RECEIPT_MAX_BYTES=256_000;
export const PAID_VALIDATION_VERSION='paid-full-v1';
const encoder=new TextEncoder();
const fail=code=>{throw new ProviderError(code,'보존된 유료 응답과 원본 범위를 검토하세요.');};
const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');

export async function requirePaidReceiptSchema(DB){
 const row=await DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='yta_paid_summary_receipts'").first();
 if(!row)fail('PAID_RECEIPT_SCHEMA_REQUIRED');
}

export async function preservePaidReceipt(DB,{id,reservationId,current,quote,responseText=null,responseBytes,httpStatus=null,complete=false,errorCode=null}){
 const full=complete&&typeof responseText==='string'&&encoder.encode(responseText).length===responseBytes&&responseBytes<=PAID_RECEIPT_MAX_BYTES;
 const hash=full?await sha(responseText):null,now=new Date().toISOString();
 const inserted=await DB.prepare("INSERT OR IGNORE INTO yta_paid_summary_receipts(reservation_id,job_id,owner_id,source_sha256,request_sha256,quote_sha256,response_sha256,response_bytes,response_json,response_complete,http_status,state,error_code,created_at,updated_at) SELECT ?,j.id,'owner',?,?,?,?,?,?,?,?,?,?,?,? FROM jobs j JOIN yta_paid_summary_approvals a ON a.job_id=j.id AND a.owner_id='owner' JOIN yta_paid_summary_reservations r ON r.approval_id=a.id WHERE j.id=? AND j.owner_id='owner' AND r.id=? AND r.state='RESERVED' AND a.source_sha256=? AND a.quote_sha256=? AND (j.report_json IS NULL OR j.report_json='null') AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(reservationId,current.sourceSha256,current.requestSha256,quote.quoteSha256,hash,responseBytes,full?responseText:null,full?1:0,httpStatus,full?'RECEIVED':'INCOMPLETE',full?null:errorCode??'PAID_RESPONSE_INCOMPLETE',now,now,id,reservationId,current.sourceSha256,quote.quoteSha256).run();
 if(inserted.meta?.changes!==1)fail('PAID_RECEIPT_SCOPE_CHANGED');
 if(!full)fail(errorCode??'PAID_RESPONSE_INCOMPLETE');
 const stored=await DB.prepare("SELECT response_sha256,response_bytes,response_json,response_complete FROM yta_paid_summary_receipts WHERE reservation_id=? AND job_id=? AND owner_id='owner'").bind(reservationId,id).first();
 if(stored?.response_complete!==1||stored.response_bytes!==responseBytes||stored.response_json!==responseText||stored.response_sha256!==hash||await sha(stored.response_json)!==hash)fail('PAID_RECEIPT_READBACK_FAILED');
 return {responseSha256:hash,responseBytes};
}

export async function markPaidReceipt(DB,reservationId,state,errorCode=null,{modelVersion=null,finishReason=null,usage=null}={}){
 const changed=await DB.prepare("UPDATE yta_paid_summary_receipts SET state=?,error_code=?,model_version=COALESCE(?,model_version),finish_reason=COALESCE(?,finish_reason),usage_json=COALESCE(?,usage_json),validation_version=?,updated_at=? WHERE reservation_id=? AND owner_id='owner' AND state<>'SAVED'").bind(state,errorCode,modelVersion,finishReason,usage?JSON.stringify(usage):null,PAID_VALIDATION_VERSION,new Date().toISOString(),reservationId).run();
 if(changed.meta?.changes!==1)fail('PAID_RECEIPT_STATE_CHANGED');
 const row=await DB.prepare("SELECT state,error_code,model_version,finish_reason,usage_json FROM yta_paid_summary_receipts WHERE reservation_id=? AND owner_id='owner'").bind(reservationId).first();
 if(row?.state!==state||row.error_code!==errorCode||modelVersion!==null&&row.model_version!==modelVersion||finishReason!==null&&row.finish_reason!==finishReason||usage&&row.usage_json!==JSON.stringify(usage))fail('PAID_RECEIPT_READBACK_FAILED');
}

export async function markPaidRevalidation(DB,reservationId,code){
 const now=new Date().toISOString(),changed=await DB.prepare("UPDATE yta_paid_summary_receipts SET revalidation_version=?,revalidation_code=?,revalidated_at=?,updated_at=? WHERE reservation_id=? AND owner_id='owner' AND (?='REPORT_SAVED' OR (state<>'SAVED' AND COALESCE(revalidation_code,'')<>'REPORT_SAVED'))").bind(PAID_VALIDATION_VERSION,code,now,now,reservationId,code).run();
 if(changed.meta?.changes!==1&&code==='REPORT_SAVED')fail('PAID_RECEIPT_STATE_CHANGED');
}

export async function paidReceiptForRecovery(DB,{id,reservationId,current,quote}){
 const row=await DB.prepare("SELECT p.response_json,p.response_sha256,p.response_bytes,p.response_complete,p.http_status,p.state,p.error_code,p.model_version,p.finish_reason,p.usage_json AS receipt_usage_json,r.usage_json AS settled_usage_json FROM yta_paid_summary_receipts p JOIN yta_paid_summary_reservations r ON r.id=p.reservation_id JOIN yta_paid_summary_approvals a ON a.id=r.approval_id JOIN jobs j ON j.id=p.job_id WHERE p.reservation_id=? AND p.job_id=? AND p.owner_id='owner' AND j.id=? AND j.owner_id='owner' AND a.job_id=? AND a.owner_id='owner' AND r.state='SETTLED' AND r.outcome='REPORT_NOT_SAVED' AND p.source_sha256=? AND p.request_sha256=? AND p.quote_sha256=? AND a.source_sha256=? AND a.quote_sha256=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(reservationId,id,id,id,current.sourceSha256,current.requestSha256,quote.quoteSha256,current.sourceSha256,quote.quoteSha256).first();
 if(!row||row.response_complete!==1||typeof row.response_json!=='string'||!['RECEIVED','ENVELOPE_INVALID','VALIDATION_FAILED','SAVE_FAILED'].includes(row.state)||row.response_bytes>PAID_RECEIPT_MAX_BYTES||encoder.encode(row.response_json).length!==row.response_bytes||await sha(row.response_json)!==row.response_sha256)fail('PAID_RECEIPT_SCOPE_CHANGED');
 try{const response=JSON.parse(row.response_json),usage=response.usageMetadata,settled=JSON.parse(row.settled_usage_json);if(row.model_version!==(response.modelVersion??null)||row.finish_reason!==(response.candidates?.[0]?.finishReason??null)||JSON.stringify(usage??null)!==(row.receipt_usage_json??'null')||settled.promptTokenCount!==usage?.promptTokenCount||settled.candidatesTokenCount!==usage?.candidatesTokenCount||settled.thoughtsTokenCount!==(usage?.thoughtsTokenCount??0))fail('PAID_RECEIPT_SCOPE_CHANGED');}catch{fail('PAID_RECEIPT_SCOPE_CHANGED');}
 return row;
}
