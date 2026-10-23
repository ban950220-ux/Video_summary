import {ProviderError} from './adapters.mjs';
import {sha} from './gemini-two-pass-contract.mjs';

const provider='gemini-two-pass-quote-renewal';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash=/^[a-f0-9]{64}$/;
const fail=code=>{throw new ProviderError(code,'Unused quote renewal stopped; inspect stored evidence. No automatic retry.');};
const encode=value=>JSON.stringify(value);
const digest=value=>sha(encode(value));
const stamp=()=>new Date().toISOString();
const attemptId=id=>id+':gemini-two-pass-quote';
const optionalTables=['yta_paid_summary_approvals','yta_paid_summary_reservations','yta_paid_summary_receipts','yta_paid_first_trial'];
const allowedBody=(body,keys)=>body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).every(key=>keys.includes(key));
// The canonical row is excluded from the other-operation snapshot because it evolves.
// Bind every column here, including nulls, at each expected evolution. Never clear a
// concurrently recorded error or adopt a changed job/provider/units/timestamp.
const operationColumns=['id','job_id','provider','units','state','created_at','error_code','result_json'];
const operationMatch=operationColumns.map(column=>`${column} IS ?`).join(' AND ');
const operationValues=row=>operationColumns.map(column=>row[column]??null);
async function assertRenewalContext(env,context){
 const valid=await env.DB.prepare(`SELECT 1 AS ok WHERE ${context.guard} AND ${context.rowGuard} AND EXISTS(SELECT 1 FROM yta_operations WHERE ${operationMatch})`).bind(...context.bindings,...context.rowBindings,...operationValues(context.attempt)).first();
 if(!valid)fail('TWO_PASS_RENEWAL_SCOPE_CHANGED');
}

// Compare ordered complete row sets in SQL. New rows, removals and changed values all fail.
// No secret or source text is copied to the renewal record. SQL bindings stay in memory.
async function snapshot(DB,table,where,args,order,guards,bindings){
 const rows=(await DB.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order}`).bind(...args).all()).results??[];
 if(rows.length){
  const columns=Object.keys(rows[0]);if(columns.some(key=>!/^\w+$/.test(key)))fail('TWO_PASS_RENEWAL_SCHEMA_CHANGED');
  const object=columns.map(key=>`'${key}',x.${key}`).join(',');
  const query=`SELECT json_group_array(json_object(${object})) AS snapshot FROM (SELECT * FROM ${table} WHERE ${where} ORDER BY ${order}) x`;
  const encoded=(await DB.prepare(query).bind(...args).first()).snapshot;
  if(encode(JSON.parse(encoded))!==encode(rows))fail('TWO_PASS_RENEWAL_SCOPE_CHANGED');
  guards.push(`(${query})=?`);bindings.push(...args,encoded);
 }else{guards.push(`NOT EXISTS(SELECT 1 FROM ${table} WHERE ${where})`);bindings.push(...args);}
 return rows;
}

export async function inspectUnusedQuote(env,{id,row,scope,credential,requestSha256,quote,legacyUncertain}){
 if(legacyUncertain)fail('TWO_PASS_RENEWAL_LEGACY_UNCERTAIN');
 if(!row||!['QUOTED','APPROVED','CANCELLED'].includes(row.state)||row.state!=='CANCELLED'&&row.expires_at>Date.now()||row.first_report_json||row.review_json||row.error_code)fail('TWO_PASS_RENEWAL_NOT_UNUSED');
 if(row.source_sha256!==scope.sourceHash||row.audit_sha256!==scope.auditHash||row.first_request_sha256!==requestSha256||row.credential_generation!==credential.generation)fail('TWO_PASS_RENEWAL_SCOPE_CHANGED');
 const DB=env.DB,guards=[],bindings=[];
 const job=(await snapshot(DB,'jobs',"id=? AND owner_id='owner'",[id],'id',guards,bindings))[0];
 const source=(await snapshot(DB,'yta_sources','job_id=?',[id],'job_id',guards,bindings))[0];
 if(!job||job.report_json&&job.report_json!=='null'||job.audit_json!==scope.auditJson||job.duration_seconds!==scope.durationSeconds||!source||source.raw!==scope.sourceRaw||source.segments_json!==scope.segmentsJson||source.provenance!==scope.source.provenance)fail('TWO_PASS_RENEWAL_SCOPE_CHANGED');
 const key=(await snapshot(DB,'provider_credentials',"owner_id='owner' AND provider='gemini'",[],'provider',guards,bindings))[0];
 if(!key||key.cipher_version!==credential.cipherVersion||key.iv_b64!==credential.ivB64||key.ciphertext_b64!==credential.ciphertextB64||key.updated_at!==credential.updatedAt)fail('TWO_PASS_RENEWAL_SCOPE_CHANGED');
 const existing=(await DB.prepare("SELECT * FROM yta_gemini_two_pass_jobs WHERE job_id=? AND owner_id='owner'").bind(id).first());
 if(encode(existing)!==encode(row))fail('TWO_PASS_RENEWAL_SCOPE_CHANGED');
 // Keep the old quote exact until replacement, including old approval and expiration.
 const rowGuard=[],rowBindings=[];
 const captured=(await snapshot(DB,'yta_gemini_two_pass_jobs','job_id=?',[id],'job_id',rowGuard,rowBindings))[0];
 if(encode(captured)!==encode(row))fail('TWO_PASS_RENEWAL_SCOPE_CHANGED');
 if((await snapshot(DB,'yta_gemini_two_pass_calls','job_id=?',[id],'phase',guards,bindings)).length)fail('TWO_PASS_RENEWAL_GENERATION_HISTORY');
 const attempt=await DB.prepare("SELECT * FROM yta_operations WHERE id=? AND job_id=? AND provider='gemini-two-pass-quote'").bind(attemptId(id),id).first();
 let proof;try{proof=JSON.parse(attempt?.result_json);}catch{fail('TWO_PASS_RENEWAL_QUOTE_UNCERTAIN');}
 if(attempt?.state!=='QUOTE_SAVED'||attempt.error_code||attempt.units!==0||!uuid.test(proof.attemptId)||proof.ownerId!=='owner'||proof.jobId!==id||proof.sourceSha256!==scope.sourceHash||proof.auditSha256!==scope.auditHash||proof.requestSha256!==requestSha256||proof.credentialGeneration!==credential.generation||proof.projectMode!==row.project_mode||proof.model!==quote.model||proof.countedTokens!==quote.inputTokensCounted||proof.recoveryApproval)fail('TWO_PASS_RENEWAL_QUOTE_UNCERTAIN');
 const ops=await snapshot(DB,'yta_operations','job_id=? AND id<>? AND provider<>?',[id,attemptId(id),provider],'id',guards,bindings);
 // Only completed audio acquisition is unrelated to summary generation. Unknown ledgers fail closed.
 if(ops.some(op=>op.state!=='DONE'||op.error_code||!['groq','gemini'].includes(op.provider)||!op.id.startsWith(id+':audio:')))fail('TWO_PASS_RENEWAL_PRIOR_ACTIVITY');
 const usage=await snapshot(DB,'usage_events','job_id=?',[id],'id',guards,bindings);
 const completedAudioUsage=item=>item.owner_id==='owner'&&ops.some(op=>op.provider===item.provider)&&(
  item.provider==='groq'&&item.unit==='audio_seconds'&&['LIVE_FREE','LIVE_FREE_PROBE','LIVE_FREE_BATCH'].includes(item.capability)&&['APP_RESERVED_UPPER_BOUND','APP_RESERVED_ACCOUNT_CAPACITY_UNKNOWN'].includes(item.provenance)||
  item.provider==='gemini'&&item.unit==='conservative_token_units'&&item.capability==='LIVE_FREE'&&item.provenance==='APP_RESERVED_UPPER_BOUND');
 if(usage.some(item=>!completedAudioUsage(item)))fail('TWO_PASS_RENEWAL_USAGE_HISTORY');
 const names=(await DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('yta_paid_summary_approvals','yta_paid_summary_reservations','yta_paid_summary_receipts','yta_paid_first_trial') ORDER BY name").all()).results??[];
 guards.push("(SELECT json_group_array(name) FROM (SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('yta_paid_summary_approvals','yta_paid_summary_reservations','yta_paid_summary_receipts','yta_paid_first_trial') ORDER BY name))=?");bindings.push(encode(names.map(item=>item.name)));
 for(const table of optionalTables){
  if(!names.some(item=>item.name.toLowerCase()===table))continue;
  if(table==='yta_paid_summary_reservations'){
   if(!names.some(item=>item.name.toLowerCase()==='yta_paid_summary_approvals'))fail('TWO_PASS_RENEWAL_SCHEMA_CHANGED');
   if((await snapshot(DB,table,'approval_id IN (SELECT id FROM yta_paid_summary_approvals WHERE job_id=?)',[id],'id',guards,bindings)).length)fail('TWO_PASS_RENEWAL_USAGE_HISTORY');
  }else if((await snapshot(DB,table,'job_id=?',[id],table==='yta_paid_summary_receipts'?'reservation_id':table==='yta_paid_first_trial'?'job_id':'id',guards,bindings)).length)fail('TWO_PASS_RENEWAL_PRIOR_ACTIVITY');
 }
 const evidence={kind:'UNUSED_QUOTE_EVIDENCE_V1',jobId:id,sourceSha256:scope.sourceHash,auditSha256:scope.auditHash,requestSha256,credentialGeneration:credential.generation,oldQuote:row,oldAttempt:attempt,contextSha256:await digest([job,source,key,ops,usage,names]),generationCalls:0};
 return {id,row,attempt,evidence,evidenceSha256:await digest(evidence),guard:guards.join(' AND '),bindings,rowGuard:rowGuard.join(' AND '),rowBindings};
}

export function unusedQuoteReview(context){return {eligible:true,evidenceSha256:context.evidenceSha256,quoteSha256:context.row.quote_sha256,priorState:context.row.state,priorExpiresAt:context.row.expires_at,generationCalls:0,approvalGrantsGeneration:false,countTokensRequested:false};}
const approvalId=(id,requestId)=>id+':gemini-two-pass-renewal:'+requestId;
async function approvalRow(env,id){return env.DB.prepare('SELECT * FROM yta_operations WHERE id=? AND provider=?').bind(id,provider).first();}
export async function approveUnusedQuote(env,context,body){
 if(!allowedBody(body,['requestId','evidenceSha256','confirmArchiveUnusedQuote','confirmNoProviderCall'])||!uuid.test(body.requestId)||!hash.test(body.evidenceSha256)||body.evidenceSha256!==context.evidenceSha256||body.confirmArchiveUnusedQuote!==true||body.confirmNoProviderCall!==true)fail('TWO_PASS_RENEWAL_APPROVAL_REQUIRED');
 const id=approvalId(context.id,body.requestId),prior=await approvalRow(env,id);
 const publicResult=record=>({renewalApprovalId:id,requestId:body.requestId,evidenceSha256:record.evidenceSha256,expiresAt:record.expiresAt,generationAllowed:false,countTokensRequested:false});
 if(prior){const record=JSON.parse(prior.result_json);if(prior.job_id!==context.id||prior.units!==0||prior.error_code!==null||prior.state!=='APPROVED'||record.evidenceSha256!==context.evidenceSha256||record.expiresAt<=Date.now())fail('TWO_PASS_RENEWAL_APPROVAL_USED');await assertRenewalContext(env,context);return publicResult(record);}
 const approvedAt=Date.now(),record={kind:'UNUSED_QUOTE_RENEWAL_APPROVAL_V1',requestId:body.requestId,evidenceSha256:context.evidenceSha256,approvedAt,expiresAt:approvedAt+300000,maxMetadataCalls:1,maxCountCalls:1,maxGenerationCalls:0,maxRetries:0,archive:context.evidence};
 const encoded=encode(record);
 try{const result=await env.DB.prepare(`INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,?,?,0,'APPROVED',?,? WHERE ${context.guard} AND ${context.rowGuard} AND EXISTS(SELECT 1 FROM yta_operations WHERE ${operationMatch})`).bind(id,context.id,provider,stamp(),encoded,...context.bindings,...context.rowBindings,...operationValues(context.attempt)).run();if(result.meta?.changes===1)return publicResult(record);}catch{}
 const stored=await approvalRow(env,id);
 if(stored?.state==='APPROVED'&&stored.job_id===context.id&&stored.units===0&&stored.error_code===null){
  const saved=JSON.parse(stored.result_json);
  if(saved.requestId===body.requestId&&saved.evidenceSha256===context.evidenceSha256&&encode(saved.archive)===encode(context.evidence)&&saved.expiresAt>Date.now()){await assertRenewalContext(env,context);return publicResult(saved);}
 }
 fail('TWO_PASS_RENEWAL_SCOPE_CHANGED');
}

export async function renewUnusedQuote(env,context,body,{gate,metadata,count,buildQuote}){
 if(!allowedBody(body,['projectMode','confirmFullTranscriptSentToGoogleForTokenCount','confirmBillingDisabled','renewalApprovalId','quoteRequestId'])||!uuid.test(body.quoteRequestId)||typeof body.renewalApprovalId!=='string'||body.projectMode!==context.row.project_mode||body.confirmFullTranscriptSentToGoogleForTokenCount!==true)fail('TWO_PASS_RENEWAL_REQUEST_REQUIRED');
 const approval=await approvalRow(env,body.renewalApprovalId);let record;try{record=JSON.parse(approval?.result_json);}catch{fail('TWO_PASS_RENEWAL_APPROVAL_REQUIRED');}
 if(approval?.job_id!==context.id||approval.units!==0||approval.error_code!==null||approval.state!=='APPROVED'||record.evidenceSha256!==context.evidenceSha256||encode(record.archive)!==encode(context.evidence)||record.maxGenerationCalls!==0||record.maxRetries!==0||record.maxCountCalls!==1||record.maxMetadataCalls!==1||!Number.isSafeInteger(record.approvedAt)||!Number.isSafeInteger(record.expiresAt)||record.approvedAt>Date.now()||record.expiresAt-record.approvedAt!==300000||record.expiresAt<=Date.now())fail('TWO_PASS_RENEWAL_APPROVAL_USED');
 const clock=()=>{gate();if(Date.now()>=record.expiresAt)fail('TWO_PASS_RENEWAL_APPROVAL_EXPIRED');};clock();
 const consumed=encode({...record,quoteRequestId:body.quoteRequestId,consumedAt:Date.now()});
 const attempt={attemptId:body.quoteRequestId,ownerId:'owner',jobId:context.id,sourceSha256:context.row.source_sha256,auditSha256:context.row.audit_sha256,requestSha256:context.row.first_request_sha256,credentialGeneration:context.row.credential_generation,model:JSON.parse(context.row.quote_json).model,projectMode:body.projectMode,renewalApprovalId:approval.id};
 let encodedAttempt=encode(attempt);
 const reservedAt=stamp(),consumedApproval={...approval,state:'CONSUMED',result_json:consumed};
 let expectedAttempt={...context.attempt,state:'RESERVED',result_json:encodedAttempt,created_at:reservedAt};
 // Atomic archive consumption + reservation. A lost ACK stops, and cannot dispatch again.
 await env.DB.batch([
  env.DB.prepare(`UPDATE yta_operations SET state='CONSUMED',result_json=? WHERE ${operationMatch} AND ${context.guard} AND ${context.rowGuard} AND EXISTS(SELECT 1 FROM yta_operations WHERE ${operationMatch}) AND CAST(strftime('%s','now') AS INTEGER)*1000<?`).bind(consumed,...operationValues(approval),...context.bindings,...context.rowBindings,...operationValues(context.attempt),record.expiresAt),
  env.DB.prepare(`UPDATE yta_operations SET state='RESERVED',result_json=?,created_at=? WHERE ${operationMatch} AND changes()=1`).bind(encodedAttempt,reservedAt,...operationValues(context.attempt)),
  env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('RENEWAL_CONFLICT') END AS ok")
 ]);
 async function transition(from,to,extra={}){
  clock();const next=encode({...JSON.parse(encodedAttempt),...extra});
  if(expectedAttempt.state!==from)fail('TWO_PASS_RENEWAL_SCOPE_CHANGED');
  const result=await env.DB.prepare(`UPDATE yta_operations SET state=?,result_json=? WHERE ${operationMatch} AND ${context.guard} AND ${context.rowGuard} AND EXISTS(SELECT 1 FROM yta_operations WHERE ${operationMatch}) AND CAST(strftime('%s','now') AS INTEGER)*1000<?`).bind(to,next,...operationValues(expectedAttempt),...context.bindings,...context.rowBindings,...operationValues(consumedApproval),record.expiresAt).run();
  if(result.meta?.changes!==1)fail('TWO_PASS_RENEWAL_SCOPE_CHANGED');encodedAttempt=next;expectedAttempt={...expectedAttempt,state:to,result_json:next};clock();
 }
 await transition('RESERVED','MODEL_LOOKUP');const model=await metadata();
 await transition('MODEL_LOOKUP','COUNT_SENT');const tokens=await count();
 await transition('COUNT_SENT','COUNT_RECEIVED',{countedTokens:tokens});
 const quote=buildQuote(tokens,model),quoteJson=encode(quote),quoteSha256=await sha(quoteJson);
 clock();
 await env.DB.batch([
  env.DB.prepare(`UPDATE yta_gemini_two_pass_jobs SET quote_json=?,quote_sha256=?,expires_at=?,state='QUOTED',updated_at=? WHERE job_id=? AND ${context.guard} AND ${context.rowGuard} AND EXISTS(SELECT 1 FROM yta_operations WHERE ${operationMatch}) AND EXISTS(SELECT 1 FROM yta_operations WHERE ${operationMatch}) AND CAST(strftime('%s','now') AS INTEGER)*1000<?`).bind(quoteJson,quoteSha256,quote.expiresAt,stamp(),context.id,...context.bindings,...context.rowBindings,...operationValues(expectedAttempt),...operationValues(consumedApproval),record.expiresAt),
  env.DB.prepare(`UPDATE yta_operations SET state='QUOTE_SAVED' WHERE ${operationMatch} AND changes()=1`).bind(...operationValues(expectedAttempt)),
  env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('RENEWAL_SAVE_CONFLICT') END AS ok")
 ]);
 // No generation approval is carried forward. Existing generation/usage rows were never changed.
 return quoteSha256;
}
