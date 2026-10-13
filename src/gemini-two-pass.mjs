import {ProviderError} from './adapters.mjs';
import {configuredMasterKey,decryptProviderKey} from './vault.mjs';
import {capacityIdentity} from './observed-capacity.mjs';
import {completeSource,promptAudit} from './groq-summary.mjs';
import {PAID_SUMMARY_CATALOG,validatePaidFullReport} from './paid-summary-contract.mjs';
import {TWO_PASS_MODEL,TWO_PASS_INPUT_CAP,TWO_PASS_OUTPUT_CAP,TWO_PASS_VALIDATION_VERSION,sourceSnapshot,summaryRequest,reviewRequest,validateReview,costCeiling,assertCountedRequest,sha} from './gemini-two-pass-contract.mjs';

const json=value=>Response.json(value,{headers:{'cache-control':'no-store'}});
const fail=(code,message='Gemini 전체 전사 대조 상태를 확인하세요.')=>{throw new ProviderError(code,message);};
const digest=async value=>sha(JSON.stringify(value));
const now=()=>new Date().toISOString();
const modelUrl=action=>`https://generativelanguage.googleapis.com/v1beta/models/${TWO_PASS_MODEL}:${action}`;

async function keyOf(env){
 const row=await env.DB.prepare("SELECT cipher_version,iv_b64,ciphertext_b64 FROM provider_credentials WHERE owner_id='owner' AND provider='gemini'").first();
 const root=configuredMasterKey(env);if(!row||!root)fail('TWO_PASS_KEY_UNAVAILABLE');
 try{return await decryptProviderKey(root,'gemini',{version:row.cipher_version,ivB64:row.iv_b64,ciphertextB64:row.ciphertext_b64});}catch{fail('TWO_PASS_KEY_UNAVAILABLE');}
}
async function counted(env,body){
 if(env.GEMINI_TWO_PASS_TEST_PROVIDER)return env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens(body);
 const key=await keyOf(env);
 const response=await fetch(modelUrl('countTokens'),{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:JSON.stringify({generateContentRequest:{model:`models/${TWO_PASS_MODEL}`,...body}})});
 if(!response.ok)fail('TWO_PASS_COUNT_UNAVAILABLE','공식 입력 토큰 수를 확인하지 못했습니다. 생성 호출은 하지 않습니다.');
 const result=await response.json();if(!Number.isSafeInteger(result.totalTokens)||result.totalTokens<1)fail('TWO_PASS_COUNT_UNAVAILABLE');
 return result.totalTokens;
}
async function generated(env,body,onResponse){
 if(env.GEMINI_TWO_PASS_TEST_PROVIDER){const result=await env.GEMINI_TWO_PASS_TEST_PROVIDER.generate(body);await onResponse(result);return result;}
 const key=await keyOf(env);let response;
 try{response=await fetch(modelUrl('generateContent'),{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:JSON.stringify(body)});}catch{fail('TWO_PASS_PROVIDER_UNCERTAIN');}
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
 if(await digest(quote)!==row.quote_sha256||quote.model!==TWO_PASS_MODEL||quote.priceVersion!==PAID_SUMMARY_CATALOG.priceVersion||quote.sourceSha256!==row.source_sha256||quote.auditSha256!==row.audit_sha256||quote.firstRequestSha256!==row.first_request_sha256||quote.projectMode!==row.project_mode||quote.credentialGeneration!==row.credential_generation||quote.expiresAt!==row.expires_at||quote.maxCalls!==2||quote.maxRetries!==0||quote.outputTokensPerCallCap!==TWO_PASS_OUTPUT_CAP||quote.maxMicroUsd!==costs.totalApprovalMicroUsd||quote.preTaxMicroUsd!==costs.totalPreTaxMicroUsd)fail('TWO_PASS_QUOTE_SCOPE_CHANGED');
 return quote;
}
function view(row,calls){
 const quote=row?JSON.parse(row.quote_json):null;
 return {state:row?.state??'NOT_STARTED',projectMode:row?.project_mode??null,quote:quote?{model:quote.model,sourceSha256:quote.sourceSha256,firstRequestSha256:quote.firstRequestSha256,inputTokensCounted:quote.inputTokensCounted,inputTokensPerCallCap:quote.inputTokensPerCallCap,outputTokensPerCallCap:quote.outputTokensPerCallCap,maxCalls:2,maxRetries:0,maxMicroUsd:quote.maxMicroUsd,preTaxMicroUsd:quote.preTaxMicroUsd,expiresAt:quote.expiresAt,quoteSha256:row.quote_sha256,priceVersion:quote.priceVersion}:null,firstReport:row?.first_report_json?JSON.parse(row.first_report_json):null,review:row?.review_json?JSON.parse(row.review_json):null,errorCode:row?.error_code??null,calls:calls.map(item=>({phase:item.phase,state:item.state,inputTokensCounted:item.input_tokens_counted,usage:item.usage_json?JSON.parse(item.usage_json):null,responseStored:item.response_complete===1,responseSha256:item.response_sha256,responseBytes:item.response_bytes,errorCode:item.error_code,tokenEstimateMicroUsd:item.token_estimate_micro_usd})),meaningReview:row?.state==='COMPLETE'?'AUTO_CHECK_PASSED_HUMAN_UNREVIEWED':'NOT_PASSED',externalFactCheck:'NOT_PERFORMED',audioAccuracy:'NOT_VERIFIED',providerInvoiceAmount:'UNKNOWN',next:row?.state==='FIRST_READY'?(calls.some(item=>item.phase===0&&item.state==='SETTLED')?'RUN_REVIEW':'RECOVER_FIRST_RECEIPT'):row?.state==='ISSUES'?'REVIEW_ISSUES_OR_USE_GROQ':row?.state==='BLOCKED'?'INSPECT_STORED_RECEIPT_NO_AUTO_RETRY':null};
}
async function allCalls(env,id){return (await env.DB.prepare('SELECT * FROM yta_gemini_two_pass_calls WHERE job_id=? ORDER BY phase').bind(id).all()).results||[];}
function executionGate(env,mode){
 if(env.ENABLE_GEMINI_TWO_PASS!=='true')fail('TWO_PASS_DISABLED');
 if(mode==='FREE_ATTESTED'){
  if(env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API!=='false'||env.GEMINI_TWO_PASS_FREE_PROJECT_ATTESTED!=='true'||env.GEMINI_PROJECT_BILLING_MODE!=='FREE')fail('TWO_PASS_FREE_PROJECT_UNVERIFIED','이 키의 프로젝트에서 과금이 꺼져 있음을 별도로 확인해야 합니다. 현재 확인된 유료 프로젝트를 무료로 분류할 수 없습니다.');
 }else if(mode==='PAID_APPROVED'){
  if(env.ENABLE_GEMINI_TWO_PASS_PAID!=='true'||env.GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED!=='true'||env.PAID_MODEL_ACCESS_VERIFIED!=='true'||env.PAID_TAX_MAX_BPS_VERIFIED!=='true'||env.ALLOW_PAID_API!=='false')fail('TWO_PASS_PAID_DISABLED');
 }else fail('TWO_PASS_PROJECT_MODE_REQUIRED');
}
async function reconcile(env,id,phase,scope,row,receipt){
 if(receipt.response_complete!==1||!receipt.response_json||await sha(receipt.response_json)!==receipt.response_sha256)fail('TWO_PASS_RECEIPT_INCOMPLETE');
 let envelope;try{envelope=JSON.parse(receipt.response_json);}catch{fail('TWO_PASS_RECEIPT_INVALID');}
 const candidate=envelope.candidates?.[0],output=candidate?.content?.parts?.map(part=>part.text||'').join('')||'',usage=envelope.usageMetadata;
 if(usage)await env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET usage_json=?,finish_reason=?,updated_at=? WHERE job_id=? AND phase=? AND state IN ('RECEIVED','VALIDATION_FAILED') AND response_sha256=?").bind(JSON.stringify(usage),candidate?.finishReason??null,now(),id,phase,receipt.response_sha256).run();
 if(receipt.http_status!==200||candidate?.finishReason!=='STOP'||!output)fail('TWO_PASS_OUTPUT_INCOMPLETE');
 const input=usage?.promptTokenCount,generatedTokens=(usage?.candidatesTokenCount??NaN)+(usage?.thoughtsTokenCount??0);
 if(!Number.isSafeInteger(input)||input<1||input>JSON.parse(row.quote_json).inputTokensPerCallCap||!Number.isSafeInteger(generatedTokens)||generatedTokens<0||generatedTokens>TWO_PASS_OUTPUT_CAP)fail('TWO_PASS_USAGE_UNCERTAIN');
 const micro=Math.ceil(input*PAID_SUMMARY_CATALOG.inputPriceMicroUsdPerMillion/1_000_000)+Math.ceil(generatedTokens*PAID_SUMMARY_CATALOG.outputPriceMicroUsdPerMillion/1_000_000);
 await env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET usage_json=?,finish_reason='STOP',token_estimate_micro_usd=?,updated_at=? WHERE job_id=? AND phase=? AND state IN ('RECEIVED','VALIDATION_FAILED') AND response_sha256=?").bind(JSON.stringify(usage),micro,now(),id,phase,receipt.response_sha256).run();
 let result;
 if(phase===0){result=validatePaidFullReport(output,scope.source);}
 else{if(!row.first_report_json)fail('TWO_PASS_FIRST_MISSING');result=validateReview(output,scope.source,JSON.parse(row.first_report_json));}
 if(phase===0){if(row.state!=='FIRST_READY'||row.first_report_json!==JSON.stringify(result)){const update=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET first_report_json=?,state='FIRST_READY',error_code=NULL,updated_at=? WHERE job_id=? AND owner_id='owner' AND state='FIRST_PENDING' AND source_sha256=?").bind(JSON.stringify(result),now(),id,scope.sourceHash).run();if(update.meta?.changes!==1)fail('TWO_PASS_STATE_CHANGED');}}
 else{
  const pass=result.verdict==='PASS';
  if(pass){const report={...JSON.parse(row.first_report_json),kind:'GEMINI_TWO_PASS_REVIEWED',compositionMode:'gemini-two-pass-v1',sourceCoverage:{inputScope:'ALL_STORED_SEGMENTS',segmentCount:scope.source.segments.length,firstSegmentId:scope.source.segments[0].id,lastSegmentId:scope.source.segments.at(-1).id,sourceSha256:scope.sourceHash,semanticCompleteness:'NOT_PROVEN'},meaningReview:{status:'AUTO_CHECK_PASSED_HUMAN_UNREVIEWED',validationVersion:TWO_PASS_VALIDATION_VERSION,independentFactCheck:false},reviewIssues:[],warning:'전체 원문 대조 모델의 자동 검사를 통과했습니다. 사람의 전체 의미 검토, 원음 정확성 및 외부 사실 확인은 수행하지 않았습니다.'};
   const updated=await env.DB.prepare("UPDATE jobs SET report_json=?,audit_json=json_set(audit_json,'$.summaryProvider','gemini-two-pass','$.externalFactCheck','NOT_PERFORMED'),status='COMPLETE',updated_at=? WHERE id=? AND owner_id='owner' AND audit_json=? AND (report_json IS NULL OR report_json='null') AND EXISTS(SELECT 1 FROM yta_sources WHERE job_id=? AND raw=? AND segments_json=? AND provenance=?) AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE id=? AND state='DELETING')").bind(JSON.stringify(report),now(),id,scope.auditJson,id,scope.sourceRaw,scope.segmentsJson,scope.source.provenance,id+':deleting').run();if(updated.meta?.changes!==1){const existing=await env.DB.prepare("SELECT report_json FROM jobs WHERE id=? AND owner_id='owner'").bind(id).first();if(existing?.report_json!==JSON.stringify(report))fail('TWO_PASS_SAVE_SCOPE_CHANGED');}}
  if(row.state!==(pass?'COMPLETE':'ISSUES')||row.review_json!==JSON.stringify(result)){const update=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET review_json=?,state=?,error_code=NULL,updated_at=? WHERE job_id=? AND owner_id='owner' AND state='REVIEW_PENDING' AND source_sha256=?").bind(JSON.stringify(result),pass?'COMPLETE':'ISSUES',now(),id,scope.sourceHash).run();if(update.meta?.changes!==1)fail('TWO_PASS_STATE_CHANGED');}
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
  if(row||job.report)fail('TWO_PASS_ALREADY_STARTED');const body=await request.json(),mode=body?.projectMode;
  executionGate(env,mode);if(mode==='FREE_ATTESTED'&&body.confirmBillingDisabled!==true)fail('TWO_PASS_FREE_PROJECT_UNVERIFIED');
  const scope=await scoped(env,job,sourceOf),first=summaryRequest(scope.source,scope.audit),count=await counted(env,first);
  if(!Number.isSafeInteger(count)||count<1||count>TWO_PASS_INPUT_CAP)fail('TWO_PASS_TOKEN_BOUND');
  // The second request contains the first report. If it exceeds this fixed cap, stop before dispatch.
  const inputCap=Math.min(TWO_PASS_INPUT_CAP,count+16384);
  const costs=costCeiling({inputTokensPerCall:inputCap}),expiresAt=Date.now()+1800000,credentialGeneration=await capacityIdentity(env,'gemini');
  const quote={kind:'GEMINI_TWO_PASS_FULL_TRANSCRIPT',model:TWO_PASS_MODEL,priceVersion:PAID_SUMMARY_CATALOG.priceVersion,sourceSha256:scope.sourceHash,auditSha256:scope.auditHash,firstRequestSha256:await digest(first),inputTokensCounted:count,inputTokensPerCallCap:inputCap,outputTokensPerCallCap:TWO_PASS_OUTPUT_CAP,maxCalls:2,maxRetries:0,preTaxMicroUsd:costs.totalPreTaxMicroUsd,maxMicroUsd:costs.totalApprovalMicroUsd,taxBufferBps:costs.taxBufferBps,credentialGeneration,expiresAt,projectMode:mode};
  const quoteSha256=await digest(quote),insert=await env.DB.prepare("INSERT OR IGNORE INTO yta_gemini_two_pass_jobs(job_id,owner_id,source_sha256,audit_sha256,first_request_sha256,quote_sha256,quote_json,project_mode,credential_generation,state,expires_at,created_at,updated_at) SELECT j.id,'owner',?,?,?,?,?,?,?,'QUOTED',?,?,? FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(scope.sourceHash,scope.auditHash,quote.firstRequestSha256,quoteSha256,JSON.stringify(quote),mode,credentialGeneration,expiresAt,now(),now(),id,scope.sourceRaw,scope.segmentsJson).run();
  if(insert.meta?.changes!==1)fail('TWO_PASS_QUOTE_CONFLICT');return json(view(await saved(env,id),[]));
 }
 if(!row)fail('TWO_PASS_QUOTE_REQUIRED');
 if(action==='gemini-two-pass-approve'&&request.method==='POST'){
  const body=await request.json(),quote=await activeQuote(row);
  if(body?.quoteSha256!==row.quote_sha256||body?.maxMicroUsd!==quote.maxMicroUsd||body?.maxCalls!==2||body?.confirmNoAutomaticRetry!==true||body?.confirmProjectMode!==row.project_mode||row.expires_at<=Date.now()||job.report)fail('TWO_PASS_APPROVAL_SCOPE_CHANGED');
  if(row.project_mode==='PAID_APPROVED'&&body?.confirmSeparatePaidApproval!==true)fail('TWO_PASS_PAID_APPROVAL_REQUIRED');
  if(row.project_mode==='FREE_ATTESTED'&&body?.confirmBillingDisabled!==true)fail('TWO_PASS_FREE_PROJECT_UNVERIFIED');
  executionGate(env,row.project_mode);const scope=await scoped(env,job,sourceOf);
  if(scope.sourceHash!==row.source_sha256||scope.auditHash!==row.audit_sha256||await capacityIdentity(env,'gemini')!==row.credential_generation)fail('TWO_PASS_APPROVAL_SCOPE_CHANGED');
  const update=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state='APPROVED',updated_at=? WHERE job_id=? AND owner_id='owner' AND state='QUOTED' AND quote_sha256=? AND expires_at>? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.state='DELETING')").bind(now(),id,row.quote_sha256,Date.now(),id+':deleting').run();if(update.meta?.changes!==1)fail('TWO_PASS_APPROVAL_CONFLICT');return json(view(await saved(env,id),[]));
 }
 if(action==='gemini-two-pass-cancel'&&request.method==='POST'){
  const update=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state='CANCELLED',updated_at=? WHERE job_id=? AND owner_id='owner' AND state IN ('QUOTED','APPROVED')").bind(now(),id).run();if(update.meta?.changes!==1)fail('TWO_PASS_CANCEL_BLOCKED');return json({cancelled:true});
 }
 if(action==='gemini-two-pass-recover'&&request.method==='POST'){
  const body=await request.json();if(body?.confirmNoProviderCall!==true||![0,1].includes(body.phase))fail('TWO_PASS_RECOVERY_SCOPE_CHANGED');
  const scope=await scoped(env,job,sourceOf),receipt=await call(env,id,body.phase);if(scope.sourceHash!==row.source_sha256||!receipt)fail('TWO_PASS_RECOVERY_SCOPE_CHANGED');
  if(receipt.state==='SETTLED')return json({status:view(row,await allCalls(env,id)),providerCalled:false});
  if(row.state==='BLOCKED'&&receipt.response_complete===1){await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state=?,updated_at=? WHERE job_id=? AND owner_id='owner' AND state='BLOCKED' AND source_sha256=?").bind(body.phase===0?'FIRST_PENDING':'REVIEW_PENDING',now(),id,scope.sourceHash).run();row=await saved(env,id);}
  try{await reconcile(env,id,body.phase,scope,row,receipt);}catch(error){await env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET state='VALIDATION_FAILED',error_code=?,updated_at=? WHERE job_id=? AND phase=? AND state='RECEIVED'").bind(error.code??'TWO_PASS_VALIDATION_FAILED',now(),id,body.phase).run();await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state='BLOCKED',error_code=?,updated_at=? WHERE job_id=? AND owner_id='owner' AND state IN ('FIRST_PENDING','REVIEW_PENDING')").bind(error.code??'TWO_PASS_VALIDATION_FAILED',now(),id).run();throw error;}
  return json({status:view(await saved(env,id),await allCalls(env,id)),providerCalled:false,job:await ownedJob(env,id)});
 }
 if(action==='gemini-two-pass-run'&&request.method==='POST'){
  const body=await request.json(),phase=body?.phase,quote=await activeQuote(row);
  if(![0,1].includes(phase)||body?.quoteSha256!==row.quote_sha256||row.expires_at<=Date.now()||job.report)fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
  executionGate(env,row.project_mode);if(row.project_mode==='PAID_APPROVED'&&body?.confirmSeparatePaidApproval!==true)fail('TWO_PASS_PAID_APPROVAL_REQUIRED');
  const scope=await scoped(env,job,sourceOf);if(scope.sourceHash!==row.source_sha256||scope.auditHash!==row.audit_sha256||await capacityIdentity(env,'gemini')!==row.credential_generation)fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
  const first=phase===0,requestBody=first?summaryRequest(scope.source,scope.audit):reviewRequest(scope.source,scope.audit,JSON.parse(row.first_report_json||'null'));
  if(row.state!==(first?'APPROVED':'FIRST_READY')||!first&&(await call(env,id,0))?.state!=='SETTLED')fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
  const requestHash=await digest(requestBody),count=await counted(env,requestBody);
  if(first&&(requestHash!==row.first_request_sha256||count!==quote.inputTokensCounted))fail('TWO_PASS_REQUEST_SCOPE_CHANGED');
  await assertCountedRequest({body:requestBody,countedTokens:count,requestHash,sourceHash:scope.sourceHash,inputCap:quote.inputTokensPerCallCap});
  // A unique phase row is the durable no-retry reservation; neither a second POST nor a lost response can send again.
  const changed=await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state=?,updated_at=? WHERE job_id=? AND owner_id='owner' AND state=? AND expires_at>? AND source_sha256=? AND quote_sha256=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.state='DELETING')").bind(first?'FIRST_PENDING':'REVIEW_PENDING',now(),id,first?'APPROVED':'FIRST_READY',Date.now(),scope.sourceHash,row.quote_sha256,id+':deleting').run();
  if(changed.meta?.changes!==1)fail('TWO_PASS_DISPATCH_CONFLICT');
  const inserted=await env.DB.prepare("INSERT OR IGNORE INTO yta_gemini_two_pass_calls(job_id,phase,request_sha256,input_tokens_counted,output_tokens_cap,state,created_at,updated_at) VALUES(?,?,?,?,?,'RESERVED',?,?)").bind(id,phase,requestHash,count,TWO_PASS_OUTPUT_CAP,now(),now()).run();
  if(inserted.meta?.changes!==1)fail('TWO_PASS_DUPLICATE_CALL');
  let receiptStored=false;
  try{
   // Recheck immediately before the chargeable call. No automatic fallback or retry.
   executionGate(env,row.project_mode);if(Date.now()>=row.expires_at||await capacityIdentity(env,'gemini')!==row.credential_generation)fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
   const finalGuard=await env.DB.prepare("SELECT 1 AS ok FROM jobs j JOIN yta_sources s ON s.job_id=j.id JOIN yta_gemini_two_pass_jobs t ON t.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND s.provenance=? AND t.owner_id='owner' AND t.state=? AND t.source_sha256=? AND t.quote_sha256=? AND t.expires_at>? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(id,scope.auditJson,scope.sourceRaw,scope.segmentsJson,scope.source.provenance,first?'FIRST_PENDING':'REVIEW_PENDING',scope.sourceHash,row.quote_sha256,Date.now()).first();
   if(!finalGuard)fail('TWO_PASS_DISPATCH_SCOPE_CHANGED');
   const result=await generated(env,requestBody,async response=>{
    const complete=response.complete===true&&typeof response.responseText==='string'&&response.responseBytes<=256000;
    const hash=complete?await sha(response.responseText):null;
    const updated=await env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET state=?,response_json=?,response_sha256=?,response_bytes=?,response_complete=?,http_status=?,updated_at=? WHERE job_id=? AND phase=? AND state='RESERVED' AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.state='DELETING')").bind(complete?'RECEIVED':'INCOMPLETE',complete?response.responseText:null,hash,response.responseBytes??0,complete?1:0,response.httpStatus??null,now(),id,phase,id+':deleting').run();
    if(updated.meta?.changes!==1)fail('TWO_PASS_RECEIPT_WRITE_FAILED');receiptStored=complete;
   });
   if(!receiptStored||!result)fail('TWO_PASS_RECEIPT_INCOMPLETE');
   const receipt=await call(env,id,phase);await reconcile(env,id,phase,scope,row,receipt);
   return json({status:view(await saved(env,id),await allCalls(env,id)),job:await ownedJob(env,id),providerCalled:true});
  }catch(error){
   await env.DB.prepare("UPDATE yta_gemini_two_pass_calls SET state=CASE WHEN state='RESERVED' THEN 'UNCERTAIN' ELSE state END,error_code=?,updated_at=? WHERE job_id=? AND phase=? AND state<>'SETTLED'").bind(error.code??'TWO_PASS_UNCERTAIN',now(),id,phase).run();
   await env.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state='BLOCKED',error_code=?,updated_at=? WHERE job_id=? AND owner_id='owner' AND state IN ('FIRST_PENDING','REVIEW_PENDING')").bind(error.code??'TWO_PASS_UNCERTAIN',now(),id).run();throw error;
  }
 }
 return json({error:{code:'METHOD_NOT_ALLOWED'}});
}
