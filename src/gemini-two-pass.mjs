import {ProviderError} from './adapters.mjs';
import {configuredMasterKey,decryptProviderKey} from './vault.mjs';
import {capacityIdentity,capacityIdentityForCredentialSnapshot} from './observed-capacity.mjs';
import {completeSource,promptAudit} from './groq-summary.mjs';
import {PAID_SUMMARY_CATALOG} from './paid-summary-contract.mjs';
import {validateWindowedSummary} from './two-pass-windows.mjs';
import {TWO_PASS_MODEL,TWO_PASS_INPUT_CAP,TWO_PASS_OUTPUT_CAP,sourceSnapshot,summaryRequest,reviewRequest,validateReview,costCeiling,assertCountedRequest,countTokensRequest,sha} from './gemini-two-pass-contract.mjs';

const json=value=>Response.json(value,{headers:{'cache-control':'no-store'}});
const fail=(code,message='Gemini 전체 전사 대조 상태를 확인하세요.')=>{throw new ProviderError(code,message);};
const digest=async value=>sha(JSON.stringify(value));
const now=()=>new Date().toISOString();
const modelUrl=action=>`https://generativelanguage.googleapis.com/v1beta/models/${TWO_PASS_MODEL}:${action}`;

async function credentialSnapshot(env){
 const row=await env.DB.prepare("SELECT cipher_version,iv_b64,ciphertext_b64,updated_at FROM provider_credentials WHERE owner_id='owner' AND provider='gemini'").first();
 const root=configuredMasterKey(env);if(!row||!root)fail('TWO_PASS_KEY_UNAVAILABLE');
 try{return {key:await decryptProviderKey(root,'gemini',{version:row.cipher_version,ivB64:row.iv_b64,ciphertextB64:row.ciphertext_b64}),generation:await capacityIdentityForCredentialSnapshot(env,'gemini',row),cipherVersion:row.cipher_version,ivB64:row.iv_b64,ciphertextB64:row.ciphertext_b64,updatedAt:row.updated_at};}catch{fail('TWO_PASS_KEY_UNAVAILABLE');}
}
async function counted(env,body,credential){
 if(env.GEMINI_TWO_PASS_TEST_PROVIDER)return env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens(body,credential);
 const response=await fetch(modelUrl('countTokens'),{method:'POST',headers:{'x-goog-api-key':credential.key,'content-type':'application/json'},body:JSON.stringify(countTokensRequest(body))});
 if(!response.ok)fail('TWO_PASS_COUNT_UNAVAILABLE','공식 입력 토큰 수를 확인하지 못했습니다. 생성 호출은 하지 않습니다.');
 const result=await response.json();if(!Number.isSafeInteger(result.totalTokens)||result.totalTokens<1)fail('TWO_PASS_COUNT_UNAVAILABLE');
 return result.totalTokens;
}
async function generated(env,body,credential,onResponse){
 if(env.GEMINI_TWO_PASS_TEST_PROVIDER){const result=await env.GEMINI_TWO_PASS_TEST_PROVIDER.generate(body,credential);await onResponse(result);return result;}
 let response;
 try{response=await fetch(modelUrl('generateContent'),{method:'POST',headers:{'x-goog-api-key':credential.key,'content-type':'application/json'},body:JSON.stringify(body)});}catch{fail('TWO_PASS_PROVIDER_UNCERTAIN');}
 let chunks=[],bytes=0,complete=false;
 try{const reader=response.body?.getReader();if(!reader)throw Error('NO_BODY');while(true){const item=await reader.read();if(item.done){complete=true;break;}bytes+=item.value.byteLength;if(bytes>256000){await reader.cancel();break;}chunks.push(item.value);}}catch{complete=false;}
 if(!complete){await onResponse({responseText:null,responseBytes:bytes,httpStatus:response.status,complete:false});fail('TWO_PASS_RESPONSE_INCOMPLETE');}
 const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
 let responseText;try{responseText=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{await onResponse({responseText:null,responseBytes:bytes,httpStatus:response.status,complete:false});fail('TWO_PASS_RESPONSE_INCOMPLETE');}
 const result={responseText,responseBytes:bytes,httpStatus:response.status,complete:true};await onResponse(result);return result;
}
async function scoped(env,job,sourceOf){
 const complete=await completeSource(env,job,sourceOf),source=complete.source,audit=promptAudit(job),snapshot=sourceSnapshot(source);
 return {source,audit,sourceHash:await sha(JSON.stringify([snapshot,source.provenance,job.audit.audioFileSha256])),auditHash:await digest(audit),auditJson:JSON.stringify(job.audit),sourceRaw:source.raw,segmentsJson:source.segments_json};
}
async function saved(env,id){return env.DB.prepare("SELECT * FROM yta_gemini_two_pass_jobs WHERE job_id=? AND owner_id='owner'").bind(id).first();}
async function call(env,id,phase){return env.DB.prepare('SELECT * FROM yta_gemini_two_pass_calls WHERE job_id=? AND phase=?').bind(id,phase).first();}
async function activeQuote(row){
 let quote;try{quote=JSON.parse(row.quote_json);}catch{fail('TWO_PASS_QUOTE_SCOPE_CHANGED');}
 const costs=costCeiling({inputTokensPerCall:quote.inputTokensPerCallCap});
 if(await digest(quote)!==row.quote_sha256||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(quote.executionId)||quote.model!==TWO_PASS_MODEL||quote.priceVersion!==PAID_SUMMARY_CATALOG.priceVersion||quote.sourceSha256!==row.source_sha256||quote.auditSha256!==row.audit_sha256||quote.firstRequestSha256!==row.first_request_sha256||quote.projectMode!==row.project_mode||quote.credentialGeneration!==row.credential_generation||quote.expiresAt!==row.expires_at||quote.maxCalls!==2||quote.maxRetries!==0||quote.transcriptCountConsent!==true||quote.outputTokensPerCallCap!==TWO_PASS_OUTPUT_CAP||quote.maxMicroUsd!==costs.totalApprovalMicroUsd||quote.maxMicroUsd>170000||quote.preTaxMicroUsd!==costs.totalPreTaxMicroUsd||quote.taxBufferMicroUsd!==costs.taxBufferMicroUsd||quote.taxBufferBps!==costs.taxBufferBps)fail('TWO_PASS_QUOTE_SCOPE_CHANGED');
 return quote;
}
function view(row,calls){
 const quote=row?JSON.parse(row.quote_json):null;
 return {state:row?.state??'NOT_STARTED',projectMode:row?.project_mode??null,quote:quote?{executionId:quote.executionId,model:quote.model,sourceSha256:quote.sourceSha256,firstRequestSha256:quote.firstRequestSha256,inputTokensCounted:quote.inputTokensCounted,inputTokensPerCallCap:quote.inputTokensPerCallCap,outputTokensPerCallCap:quote.outputTokensPerCallCap,maxCalls:2,maxRetries:0,maxMicroUsd:quote.maxMicroUsd,preTaxMicroUsd:quote.preTaxMicroUsd,taxBufferMicroUsd:quote.taxBufferMicroUsd,expiresAt:quote.expiresAt,quoteSha256:row.quote_sha256,priceVersion:quote.priceVersion}:null,firstReport:row?.first_report_json?JSON.parse(row.first_report_json):null,review:row?.review_json?JSON.parse(row.review_json):null,errorCode:row?.error_code??null,calls:calls.map(item=>({phase:item.phase,state:item.state,inputTokensCounted:item.input_tokens_counted,usage:item.usage_json?JSON.parse(item.usage_json):null,responseStored:item.response_complete===1,responseSha256:item.response_sha256,responseBytes:item.response_bytes,errorCode:item.error_code,tokenEstimateMicroUsd:item.token_estimate_micro_usd})),meaningReview:row?.state==='ISSUES'?'SOURCE_REVIEW_REQUIRED':'NOT_PASSED',reviewStage:row?.state==='ISSUES'?'REVIEW_REQUIRED':null,sourceReview:row?.state==='ISSUES'?'REQUIRED':'NOT_PERFORMED',externalFactCheck:'NOT_PERFORMED',audioAccuracy:'NOT_VERIFIED',providerInvoiceAmount:'UNKNOWN',next:row?.state==='FIRST_READY'?(calls.some(item=>item.phase===0&&item.state==='SETTLED')?'RUN_REVIEW':'RECOVER_FIRST_RECEIPT'):row?.state==='ISSUES'?'REVIEW_STORED_SOURCE_OR_USE_GROQ':row?.state==='BLOCKED'?'INSPECT_STORED_RECEIPT_NO_AUTO_RETRY':null};
}
async function allCalls(env,id){return (await env.DB.prepare('SELECT * FROM yta_gemini_two_pass_calls WHERE job_id=? ORDER BY phase').bind(id).all()).results||[];}
function boundRequest(scope,row,phase){
 if(phase===0)return summaryRequest(scope.source,scope.audit);
 if(!row.first_report_json)fail('TWO_PASS_RECOVERY_SCOPE_CHANGED');
 return reviewRequest(scope.source,scope.audit,JSON.parse(row.first_report_json));
}
async function receiptBinding(scope,row,receipt,phase){
 if(scope.sourceHash!==row.source_sha256||scope.auditHash!==row.audit_sha256||receipt.request_sha256!==await digest(boundRequest(scope,row,phase))||phase===0&&receipt.request_sha256!==row.first_request_sha256)fail('TWO_PASS_RECOVERY_SCOPE_CHANGED');
}
async function persistReceipt(env,id,phase,response){
 const complete=response.complete===true&&typeof response.responseText==='string'&&response.responseBytes<=256000;
 const hash=complete?await sha(response.responseText):null;
 const stored=async()=>call(env,id,phase);
 const matches=receipt=>receipt&&receipt.state==='RECEIVED'&&receipt.response_complete===1&&receipt.response_sha256===hash&&receipt.response_json===response.responseText&&receipt.response_bytes===response.responseBytes&&receipt.http_status===(response.httpStatus??null);
 const write=()=>env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET state=?,response_json=?,response_sha256=?,response_bytes=?,response_complete=?,http_status=?,updated_at=? WHERE job_id=? AND phase=? AND state='DISPATCHING' AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.state='DELETING')").bind(complete?'RECEIVED':'INCOMPLETE',complete?response.responseText:null,hash,response.responseBytes??0,complete?1:0,response.httpStatus??null,now(),id,phase,id+':deleting').run();
 for(let attempt=0;attempt<2;attempt++){
  try{const updated=await write();if(updated.meta?.changes===1)return complete;}catch(error){if(matches(await stored()))return true;if(attempt===1)throw error;continue;}
  if(matches(await stored()))return true;
  if(attempt===1)fail('TWO_PASS_RECEIPT_WRITE_FAILED');
 }
 return false;
}
function jobGate(env,id){
 if(env.GEMINI_TWO_PASS_ALLOWED_JOB_ID!==id)fail('TWO_PASS_JOB_NOT_ALLOWED');
}
function executionGate(env,mode,id){
 jobGate(env,id);
 if(env.ENABLE_GEMINI_TWO_PASS!=='true')fail('TWO_PASS_DISABLED');
 if(mode==='FREE_ATTESTED'){
  if(env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API!=='false'||env.GEMINI_TWO_PASS_FREE_PROJECT_ATTESTED!=='true'||env.GEMINI_PROJECT_BILLING_MODE!=='FREE')fail('TWO_PASS_FREE_PROJECT_UNVERIFIED','이 키의 프로젝트에서 과금이 꺼져 있음을 별도로 확인해야 합니다. 현재 확인된 유료 프로젝트를 무료로 분류할 수 없습니다.');
 }else if(mode==='PAID_APPROVED'){
  if(env.ENABLE_GEMINI_TWO_PASS_PAID!=='true'||env.GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED!=='true'||env.PAID_MODEL_ACCESS_VERIFIED!=='true'||env.PAID_TAX_MAX_BPS_VERIFIED!=='true'||env.ALLOW_PAID_API!=='false')fail('TWO_PASS_PAID_DISABLED');
 }else fail('TWO_PASS_PROJECT_MODE_REQUIRED');
}
function quoteGate(env,mode,id){
 jobGate(env,id);
 if(env.ENABLE_GEMINI_TWO_PASS!=='true'||env.ALLOW_PAID_API!=='false')fail('TWO_PASS_DISABLED');
 if(mode==='PAID_APPROVED'){
  if(env.PAID_MODEL_ACCESS_VERIFIED!=='true')fail('TWO_PASS_PAID_MODEL_UNVERIFIED');
 }else if(mode==='FREE_ATTESTED'){
  if(env.ENABLE_LIVE_FREE!=='true'||env.GEMINI_TWO_PASS_FREE_PROJECT_ATTESTED!=='true'||env.GEMINI_PROJECT_BILLING_MODE!=='FREE')fail('TWO_PASS_FREE_PROJECT_UNVERIFIED');
 }else fail('TWO_PASS_PROJECT_MODE_REQUIRED');
}
async function reconcile(env,id,phase,scope,row,receipt){
 if(receipt.response_complete!==1||!receipt.response_json||await sha(receipt.response_json)!==receipt.response_sha256)fail('TWO_PASS_RECEIPT_INCOMPLETE');
 let envelope;try{envelope=JSON.parse(receipt.response_json);}catch{fail('TWO_PASS_RECEIPT_INVALID');}
 if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||Object.keys(envelope).length===0)fail('TWO_PASS_RECEIPT_INVALID');
 const candidate=envelope.candidates?.[0],output=candidate?.content?.parts?.map(part=>part.text||'').join('')||'',usage=envelope.usageMetadata;
 if(usage)await env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET usage_json=?,finish_reason=?,updated_at=? WHERE job_id=? AND phase=? AND state IN ('RECEIVED','VALIDATION_FAILED') AND response_sha256=?").bind(JSON.stringify(usage),candidate?.finishReason??null,now(),id,phase,receipt.response_sha256).run();
 if(receipt.http_status!==200||envelope.candidates?.length!==1||candidate?.finishReason!=='STOP'||!output)fail('TWO_PASS_OUTPUT_INCOMPLETE');
 const input=usage?.promptTokenCount,candidates=usage?.candidatesTokenCount,thoughts=usage?.thoughtsTokenCount??0,generatedTokens=candidates+thoughts;
 if(!Number.isSafeInteger(candidates)||candidates<0||!Number.isSafeInteger(thoughts)||thoughts<0||usage?.totalTokenCount!=null&&(!Number.isSafeInteger(usage.totalTokenCount)||usage.totalTokenCount!==input+generatedTokens))fail('TWO_PASS_USAGE_UNCERTAIN');
 if(!Number.isSafeInteger(input)||input<1||input>JSON.parse(row.quote_json).inputTokensPerCallCap||!Number.isSafeInteger(generatedTokens)||generatedTokens<0||generatedTokens>TWO_PASS_OUTPUT_CAP)fail('TWO_PASS_USAGE_UNCERTAIN');
 const micro=Math.ceil(input*PAID_SUMMARY_CATALOG.inputPriceMicroUsdPerMillion/1_000_000)+Math.ceil(generatedTokens*PAID_SUMMARY_CATALOG.outputPriceMicroUsdPerMillion/1_000_000);
 await env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET usage_json=?,finish_reason='STOP',token_estimate_micro_usd=?,updated_at=? WHERE job_id=? AND phase=? AND state IN ('RECEIVED','VALIDATION_FAILED') AND response_sha256=?").bind(JSON.stringify(usage),micro,now(),id,phase,receipt.response_sha256).run();
 let result;
 if(phase===0){result=validateWindowedSummary(output,scope.source);}
 else{if(!row.first_report_json)fail('TWO_PASS_FIRST_MISSING');result=validateReview(output,scope.source,JSON.parse(row.first_report_json));}
 if(phase===0){if(row.state!=='FIRST_READY'||row.first_report_json!==JSON.stringify(result)){const update=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET first_report_json=?,state='FIRST_READY',error_code=NULL,updated_at=? WHERE job_id=? AND owner_id='owner' AND state='FIRST_PENDING' AND source_sha256=?").bind(JSON.stringify(result),now(),id,scope.sourceHash).run();if(update.meta?.changes!==1)fail('TWO_PASS_STATE_CHANGED');}}
 else{
  // The second model's PASS is a review signal, not source-verified completion.
  // Keep the review and receipts in the two-pass ledger; the public job stays unchanged.
  if(row.state!=='ISSUES'||row.review_json!==JSON.stringify(result)){
   const update=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET review_json=?,state='ISSUES',error_code=NULL,updated_at=? WHERE job_id=? AND owner_id='owner' AND state='REVIEW_PENDING' AND source_sha256=? AND audit_sha256=? AND quote_sha256=?").bind(JSON.stringify(result),now(),id,scope.sourceHash,scope.auditHash,row.quote_sha256).run();
   if(update.meta?.changes!==1)fail('TWO_PASS_STATE_CHANGED');
  }
 }
 const settled=await env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET state='SETTLED',usage_json=?,finish_reason='STOP',token_estimate_micro_usd=?,updated_at=? WHERE job_id=? AND phase=? AND state IN ('RECEIVED','VALIDATION_FAILED') AND response_sha256=?").bind(JSON.stringify(usage),micro,now(),id,phase,receipt.response_sha256).run();
 if(settled.meta?.changes!==1)fail('TWO_PASS_RECEIPT_STATE_CHANGED');
 return result;
}

export async function handleGeminiTwoPassAction(request,env,{id,action,job,sourceOf,ownedJob}){
 const exists=await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='yta_gemini_two_pass_jobs'").first();if(!exists)fail('TWO_PASS_SCHEMA_REQUIRED');
 let row=await saved(env,id);
 if(action==='gemini-two-pass-status'&&request.method==='GET')return json(view(row,row?await allCalls(env,id):[]));
 if(action==='gemini-two-pass-quote'&&request.method==='POST'){
  if(job.report||row&&!(row.state==='CANCELLED'||row.expires_at<=Date.now()))fail('TWO_PASS_ALREADY_STARTED');
  if(row&&(await allCalls(env,id)).length)fail('TWO_PASS_ALREADY_STARTED');
  const body=await request.json(),mode=body?.projectMode;
  if(body?.confirmFullTranscriptSentToGoogleForTokenCount!==true)fail('TWO_PASS_COUNT_CONSENT_REQUIRED','견적용 공식 토큰 계수에도 전체 전사와 구간 ID가 Google로 전송됩니다. 별도로 동의해야 합니다.');
  quoteGate(env,mode,id);if(mode==='FREE_ATTESTED'&&body.confirmBillingDisabled!==true)fail('TWO_PASS_FREE_PROJECT_UNVERIFIED');
  const scope=await scoped(env,job,sourceOf),first=summaryRequest(scope.source,scope.audit),credential=await credentialSnapshot(env),count=await counted(env,first,credential);
  if(!Number.isSafeInteger(count)||count<1||count>TWO_PASS_INPUT_CAP)fail('TWO_PASS_TOKEN_BOUND');
  // The second request contains the first report. If it exceeds this fixed cap, stop before dispatch.
  const inputCap=Math.min(TWO_PASS_INPUT_CAP,count+16384);
  const costs=costCeiling({inputTokensPerCall:inputCap}),expiresAt=Date.now()+1800000,credentialGeneration=credential.generation;
  if(costs.totalApprovalMicroUsd>170000)fail('TWO_PASS_COST_BOUND');
  const quote={kind:'GEMINI_TWO_PASS_FULL_TRANSCRIPT',executionId:crypto.randomUUID(),revision:row?(JSON.parse(row.quote_json).revision??1)+1:1,model:TWO_PASS_MODEL,priceVersion:PAID_SUMMARY_CATALOG.priceVersion,sourceSha256:scope.sourceHash,auditSha256:scope.auditHash,firstRequestSha256:await digest(first),transcriptCountConsent:true,inputTokensCounted:count,inputTokensPerCallCap:inputCap,outputTokensPerCallCap:TWO_PASS_OUTPUT_CAP,maxCalls:2,maxRetries:0,preTaxMicroUsd:costs.totalPreTaxMicroUsd,taxBufferMicroUsd:costs.taxBufferMicroUsd,maxMicroUsd:costs.totalApprovalMicroUsd,taxBufferBps:costs.taxBufferBps,credentialGeneration,expiresAt,projectMode:mode};
  const quoteSha256=await digest(quote),insert=await env.DB.prepare("INSERT OR IGNORE INTO yta_gemini_two_pass_jobs(job_id,owner_id,source_sha256,audit_sha256,first_request_sha256,quote_sha256,quote_json,project_mode,credential_generation,state,expires_at,created_at,updated_at) SELECT j.id,'owner',?,?,?,?,?,?,?,'QUOTED',?,?,? FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND s.provenance=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(scope.sourceHash,scope.auditHash,quote.firstRequestSha256,quoteSha256,JSON.stringify(quote),mode,credentialGeneration,expiresAt,now(),now(),id,scope.auditJson,scope.sourceRaw,scope.segmentsJson,scope.source.provenance).run();
  if(insert.meta?.changes!==1){
   const revised=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET source_sha256=?,audit_sha256=?,first_request_sha256=?,quote_sha256=?,quote_json=?,project_mode=?,credential_generation=?,state='QUOTED',first_report_json=NULL,review_json=NULL,error_code=NULL,expires_at=?,created_at=?,updated_at=? WHERE job_id=? AND owner_id='owner' AND (state='CANCELLED' OR expires_at<=?) AND NOT EXISTS(SELECT 1 FROM yta_gemini_two_pass_calls c WHERE c.job_id=?) AND EXISTS(SELECT 1 FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=yta_gemini_two_pass_jobs.job_id AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND s.provenance=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING'))").bind(scope.sourceHash,scope.auditHash,quote.firstRequestSha256,quoteSha256,JSON.stringify(quote),mode,credentialGeneration,expiresAt,now(),now(),id,Date.now(),id,scope.auditJson,scope.sourceRaw,scope.segmentsJson,scope.source.provenance).run();
   if(revised.meta?.changes!==1)fail('TWO_PASS_QUOTE_CONFLICT');
  }
  return json(view(await saved(env,id),[]));
 }
 if(!row)fail('TWO_PASS_QUOTE_REQUIRED');
 if(action==='gemini-two-pass-approve'&&request.method==='POST'){
  const body=await request.json(),quote=await activeQuote(row);
  if(body?.quoteSha256!==row.quote_sha256||body?.maxMicroUsd!==quote.maxMicroUsd||body?.maxCalls!==2||body?.confirmNoAutomaticRetry!==true||body?.confirmProjectMode!==row.project_mode||row.expires_at<=Date.now()||job.report)fail('TWO_PASS_APPROVAL_SCOPE_CHANGED');
  if(row.project_mode==='PAID_APPROVED'&&body?.confirmSeparatePaidApproval!==true)fail('TWO_PASS_PAID_APPROVAL_REQUIRED');
  if(row.project_mode==='FREE_ATTESTED'&&body?.confirmBillingDisabled!==true)fail('TWO_PASS_FREE_PROJECT_UNVERIFIED');
  executionGate(env,row.project_mode,id);const scope=await scoped(env,job,sourceOf);
  if(scope.sourceHash!==row.source_sha256||scope.auditHash!==row.audit_sha256||await capacityIdentity(env,'gemini')!==row.credential_generation)fail('TWO_PASS_APPROVAL_SCOPE_CHANGED');
  const update=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state='APPROVED',updated_at=? WHERE job_id=? AND owner_id='owner' AND state='QUOTED' AND quote_sha256=? AND expires_at>? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.state='DELETING')").bind(now(),id,row.quote_sha256,Date.now(),id+':deleting').run();if(update.meta?.changes!==1)fail('TWO_PASS_APPROVAL_CONFLICT');return json(view(await saved(env,id),[]));
 }
 if(action==='gemini-two-pass-cancel'&&request.method==='POST'){
  const update=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state='CANCELLED',updated_at=? WHERE job_id=? AND owner_id='owner' AND state IN ('QUOTED','APPROVED','FIRST_READY') AND (state<>'FIRST_READY' OR EXISTS(SELECT 1 FROM yta_gemini_two_pass_calls c WHERE c.job_id=? AND c.phase=0 AND c.state='SETTLED'))").bind(now(),id,id).run();if(update.meta?.changes!==1)fail('TWO_PASS_CANCEL_BLOCKED');return json({cancelled:true});
 }
 if(action==='gemini-two-pass-recover'&&request.method==='POST'){
  const body=await request.json();if(body?.confirmNoProviderCall!==true||![0,1].includes(body.phase))fail('TWO_PASS_RECOVERY_SCOPE_CHANGED');
  const scope=await scoped(env,job,sourceOf),receipt=await call(env,id,body.phase);if(!receipt)fail('TWO_PASS_RECOVERY_SCOPE_CHANGED');
  await receiptBinding(scope,row,receipt,body.phase);
  // A phase row with the job still in its pre-dispatch state was never sent.
  if(receipt.state==='RESERVED'&&[body.phase===0?'APPROVED':'FIRST_READY',body.phase===0?'FIRST_PENDING':'REVIEW_PENDING'].includes(row.state)){
   const removed=await env.DB.prepare("DELETE FROM yta_gemini_two_pass_calls WHERE job_id=? AND phase=? AND state='RESERVED' AND response_json IS NULL AND response_complete=0 AND EXISTS(SELECT 1 FROM yta_gemini_two_pass_jobs t WHERE t.job_id=? AND t.state=? AND t.quote_sha256=? AND t.source_sha256=? AND t.audit_sha256=?)").bind(id,body.phase,id,row.state,row.quote_sha256,scope.sourceHash,scope.auditHash).run();
   if(removed.meta?.changes!==1)fail('TWO_PASS_RECOVERY_SCOPE_CHANGED');
   if(row.state.endsWith('_PENDING')){
    const reset=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state=?,error_code=NULL,updated_at=? WHERE job_id=? AND owner_id='owner' AND state=? AND quote_sha256=? AND NOT EXISTS(SELECT 1 FROM yta_gemini_two_pass_calls c WHERE c.job_id=? AND c.phase=?)").bind(body.phase===0?'APPROVED':'FIRST_READY',now(),id,row.state,row.quote_sha256,id,body.phase).run();
    if(reset.meta?.changes!==1)fail('TWO_PASS_RECOVERY_SCOPE_CHANGED');
   }
   return json({status:view(await saved(env,id),await allCalls(env,id)),providerCalled:false,reservationReleased:true});
  }
  if(receipt.state==='SETTLED')return json({status:view(row,await allCalls(env,id)),providerCalled:false});
  if(row.state==='BLOCKED'&&receipt.response_complete===1){await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state=?,updated_at=? WHERE job_id=? AND owner_id='owner' AND state='BLOCKED' AND source_sha256=? AND audit_sha256=? AND quote_sha256=?").bind(body.phase===0?'FIRST_PENDING':'REVIEW_PENDING',now(),id,scope.sourceHash,scope.auditHash,row.quote_sha256).run();row=await saved(env,id);}
  try{await reconcile(env,id,body.phase,scope,row,receipt);}catch(error){await env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET state='VALIDATION_FAILED',error_code=?,updated_at=? WHERE job_id=? AND phase=? AND state='RECEIVED'").bind(error.code??'TWO_PASS_VALIDATION_FAILED',now(),id,body.phase).run();await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state='BLOCKED',error_code=?,updated_at=? WHERE job_id=? AND owner_id='owner' AND state IN ('FIRST_PENDING','REVIEW_PENDING')").bind(error.code??'TWO_PASS_VALIDATION_FAILED',now(),id).run();throw error;}
  return json({status:view(await saved(env,id),await allCalls(env,id)),providerCalled:false,job:await ownedJob(env,id)});
 }
 if(action==='gemini-two-pass-run'&&request.method==='POST'){
  const body=await request.json(),phase=body?.phase,quote=await activeQuote(row);
  if(![0,1].includes(phase)||body?.quoteSha256!==row.quote_sha256||row.expires_at<=Date.now()||job.report)fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
  executionGate(env,row.project_mode,id);if(row.project_mode==='PAID_APPROVED'&&body?.confirmSeparatePaidApproval!==true)fail('TWO_PASS_PAID_APPROVAL_REQUIRED');
  const scope=await scoped(env,job,sourceOf);if(scope.sourceHash!==row.source_sha256||scope.auditHash!==row.audit_sha256||await capacityIdentity(env,'gemini')!==row.credential_generation)fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
  const first=phase===0,requestBody=first?summaryRequest(scope.source,scope.audit):reviewRequest(scope.source,scope.audit,JSON.parse(row.first_report_json||'null'));
  if(row.state!==(first?'APPROVED':'FIRST_READY')||!first&&(await call(env,id,0))?.state!=='SETTLED')fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
  const requestHash=await digest(requestBody),countCredential=await credentialSnapshot(env);if(countCredential.generation!==row.credential_generation)fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
  const count=await counted(env,requestBody,countCredential);
  if(first&&(requestHash!==row.first_request_sha256||count!==quote.inputTokensCounted))fail('TWO_PASS_REQUEST_SCOPE_CHANGED');
  await assertCountedRequest({body:requestBody,countedTokens:count,requestHash,sourceHash:scope.sourceHash,inputCap:quote.inputTokensPerCallCap});
  // Reserve first. A failed/unknown state transition cannot strand PENDING without a phase row.
  const inserted=await env.DB.prepare("INSERT OR IGNORE INTO yta_gemini_two_pass_calls(job_id,phase,request_sha256,input_tokens_counted,output_tokens_cap,state,created_at,updated_at) SELECT t.job_id,?,?,?,?, 'RESERVED',?,? FROM yta_gemini_two_pass_jobs t JOIN jobs j ON j.id=t.job_id JOIN yta_sources s ON s.job_id=t.job_id WHERE t.job_id=? AND t.owner_id='owner' AND t.state=? AND t.expires_at>? AND t.source_sha256=? AND t.audit_sha256=? AND t.quote_sha256=? AND t.credential_generation=? AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND s.provenance=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(phase,requestHash,count,TWO_PASS_OUTPUT_CAP,now(),now(),id,first?'APPROVED':'FIRST_READY',Date.now(),scope.sourceHash,scope.auditHash,row.quote_sha256,row.credential_generation,scope.auditJson,scope.sourceRaw,scope.segmentsJson,scope.source.provenance).run();
  if(inserted.meta?.changes!==1){if(await call(env,id,phase))fail('TWO_PASS_DUPLICATE_CALL');const current=await saved(env,id);fail(current?.state===(first?'APPROVED':'FIRST_READY')?'TWO_PASS_DISPATCH_SCOPE_CHANGED':'TWO_PASS_DISPATCH_CONFLICT');}
  const changed=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state=?,updated_at=? WHERE job_id=? AND owner_id='owner' AND state=? AND expires_at>? AND source_sha256=? AND audit_sha256=? AND quote_sha256=? AND credential_generation=? AND EXISTS(SELECT 1 FROM yta_gemini_two_pass_calls c WHERE c.job_id=? AND c.phase=? AND c.state='RESERVED' AND c.request_sha256=?) AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.state='DELETING')").bind(first?'FIRST_PENDING':'REVIEW_PENDING',now(),id,first?'APPROVED':'FIRST_READY',Date.now(),scope.sourceHash,scope.auditHash,row.quote_sha256,row.credential_generation,id,phase,requestHash,id+':deleting').run();
  if(changed.meta?.changes!==1)fail('TWO_PASS_DISPATCH_CONFLICT');
  let receiptStored=false;
  try{
   // Recheck immediately before the chargeable call. No automatic fallback or retry.
   const dispatchCredential=await credentialSnapshot(env);if(dispatchCredential.generation!==row.credential_generation)fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
   const claimed=await env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET state='DISPATCHING',updated_at=? WHERE job_id=? AND phase=? AND state='RESERVED' AND request_sha256=? AND input_tokens_counted=? AND output_tokens_cap=? AND EXISTS(SELECT 1 FROM jobs j JOIN yta_sources s ON s.job_id=j.id JOIN yta_gemini_two_pass_jobs t ON t.job_id=j.id JOIN provider_credentials k ON k.owner_id='owner' AND k.provider='gemini' WHERE j.id=? AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND s.provenance=? AND t.owner_id='owner' AND t.state=? AND t.source_sha256=? AND t.audit_sha256=? AND t.quote_sha256=? AND t.credential_generation=? AND t.expires_at>? AND k.cipher_version=? AND k.iv_b64=? AND k.ciphertext_b64=? AND k.updated_at=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING'))").bind(now(),id,phase,requestHash,count,TWO_PASS_OUTPUT_CAP,id,scope.auditJson,scope.sourceRaw,scope.segmentsJson,scope.source.provenance,first?'FIRST_PENDING':'REVIEW_PENDING',scope.sourceHash,scope.auditHash,row.quote_sha256,dispatchCredential.generation,Date.now(),dispatchCredential.cipherVersion,dispatchCredential.ivB64,dispatchCredential.ciphertextB64,dispatchCredential.updatedAt).run();
   if(claimed.meta?.changes!==1)fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
   // No await between the last clock/flag check and the provider call.
   executionGate(env,row.project_mode,id);if(Date.now()>=row.expires_at)fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
   const result=await generated(env,requestBody,dispatchCredential,async response=>{
    receiptStored=await persistReceipt(env,id,phase,response);
   });
   if(!receiptStored||!result)fail('TWO_PASS_RECEIPT_INCOMPLETE');
   const receipt=await call(env,id,phase);await reconcile(env,id,phase,scope,row,receipt);
   return json({status:view(await saved(env,id),await allCalls(env,id)),job:await ownedJob(env,id),providerCalled:true});
  }catch(error){
   let current;try{current=await call(env,id,phase);}catch{}
   if(current?.state==='RESERVED')throw error;
   const invalidResponse=['TWO_PASS_WINDOW_INVALID','TWO_PASS_REVIEW_INVALID','TWO_PASS_OUTPUT_INCOMPLETE','TWO_PASS_USAGE_UNCERTAIN','TWO_PASS_RECEIPT_INVALID','TWO_PASS_RECEIPT_INCOMPLETE'].includes(error.code);
   try{await env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET state=CASE WHEN state='DISPATCHING' THEN 'UNCERTAIN' WHEN state='RECEIVED' AND ?=1 THEN 'VALIDATION_FAILED' ELSE state END,error_code=?,updated_at=? WHERE job_id=? AND phase=? AND state<>'SETTLED'").bind(invalidResponse?1:0,error.code??'TWO_PASS_UNCERTAIN',now(),id,phase).run();}catch{}
   try{await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state='BLOCKED',error_code=?,updated_at=? WHERE job_id=? AND owner_id='owner' AND state IN ('FIRST_PENDING','REVIEW_PENDING')").bind(error.code??'TWO_PASS_UNCERTAIN',now(),id).run();}catch{}throw error;
  }
 }
 return json({error:{code:'METHOD_NOT_ALLOWED'}});
}
