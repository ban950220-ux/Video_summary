// Contract primitives only. There is deliberately no paid provider dispatch here.
import {ProviderError} from './adapters.mjs';
import {capacityIdentity} from './observed-capacity.mjs';

const fail=code=>{throw new ProviderError(code,'유료 요약 계약과 예산을 다시 검토하세요.');};
const positive=n=>Number.isSafeInteger(n)&&n>0;
const hex64=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(b=>b.toString(16).padStart(2,'0')).join('');
const validSnapshot=s=>s&&typeof s.raw==='string'&&typeof s.segmentsJson==='string'&&typeof s.auditJson==='string';
const safeNumber=value=>{if(value>BigInt(Number.MAX_SAFE_INTEGER))fail('PAID_QUOTE_INVALID');return Number(value);};
const cost=(tokens,perMillion)=>safeNumber((BigInt(tokens)*BigInt(perMillion)+999_999n)/1_000_000n);

export async function priceSummaryQuote({jobId,sourceSha256,requestSha256=null,model,priceVersion,priceSource,inputTokensUpper,outputTokensUpper,plannedCalls,maxRetries,maxTaxBps,priceInputMicroUsdPerMillion,priceOutputMicroUsdPerMillion,credentialGeneration,expiresAt}){
 if(!jobId||!hex64(sourceSha256)||(requestSha256!==null&&!hex64(requestSha256))||!model||!priceVersion||!priceSource||!credentialGeneration||![inputTokensUpper,outputTokensUpper,plannedCalls,priceInputMicroUsdPerMillion,priceOutputMicroUsdPerMillion].every(positive)||!Number.isSafeInteger(maxRetries)||maxRetries<0||maxRetries>plannedCalls||!Number.isSafeInteger(maxTaxBps)||maxTaxBps<0||maxTaxBps>10000||!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now())fail('PAID_QUOTE_INVALID');
 const maxCalls=plannedCalls+maxRetries,inputCostMicroUsd=cost(inputTokensUpper,priceInputMicroUsdPerMillion),outputCostMicroUsd=cost(outputTokensUpper,priceOutputMicroUsdPerMillion),perCallMicroUsd=safeNumber(BigInt(inputCostMicroUsd)+BigInt(outputCostMicroUsd)),maxCallMicroUsd=safeNumber((BigInt(perCallMicroUsd)*BigInt(10000+maxTaxBps)+9999n)/10000n),maxMicroUsd=safeNumber(BigInt(maxCallMicroUsd)*BigInt(maxCalls));
 if(maxMicroUsd<=0)fail('PAID_QUOTE_INVALID');
 const quote={kind:'PAID_FULL_VIDEO_SYNTHESIS',ownerId:'owner',jobId,sourceSha256,requestSha256,model,priceVersion,priceSource,inputTokensUpper,outputTokensUpper,plannedCalls,maxRetries,maxCalls,maxTaxBps,priceInputMicroUsdPerMillion,priceOutputMicroUsdPerMillion,inputCostMicroUsd,outputCostMicroUsd,perCallMicroUsd,maxCallMicroUsd,maxMicroUsd,credentialGeneration,expiresAt,eta:{status:'UNKNOWN',reason:'실제 제공자 대기열과 단계별 출력 길이에 대한 검증된 관측치가 없습니다.'},transcriptionCostMicroUsd:0,transcriptionAlreadyComplete:true};
 return {...quote,quoteSha256:await digest(quote)};
}

async function keySnapshot(env,generation){
 const credential=await env.DB.prepare('SELECT cipher_version,iv_b64,ciphertext_b64,updated_at FROM provider_credentials WHERE owner_id=? AND provider=?').bind('owner','gemini').first();
 if(!credential||await capacityIdentity(env,'gemini')!==generation)fail('PAID_CREDENTIAL_CHANGED');
 return credential;
}

export async function approvePaidSummaryBudget(env,quote,{id,maxMicroUsd,maxCalls,expiresAt,confirmExactQuote,sourceSnapshot}){
 if(confirmExactQuote!==true||!id||!validSnapshot(sourceSnapshot)||await digest(sourceSnapshot)!==quote?.sourceSha256||!hex64(quote?.quoteSha256)||!positive(maxMicroUsd)||maxMicroUsd>quote.maxMicroUsd||!positive(maxCalls)||maxCalls>quote.maxCalls||!Number.isSafeInteger(expiresAt)||expiresAt>quote.expiresAt||Date.now()>=expiresAt||await digest(Object.fromEntries(Object.entries(quote).filter(([key])=>key!=='quoteSha256')))!==quote.quoteSha256)fail('PAID_APPROVAL_SCOPE_CHANGED');
 const DB=env.DB,key=await keySnapshot(env,quote.credentialGeneration);
 const result=await DB.prepare("INSERT OR IGNORE INTO yta_paid_summary_approvals(id,job_id,owner_id,source_sha256,quote_sha256,quote_json,model,price_version,credential_generation,max_micro_usd,max_call_micro_usd,max_calls,expires_at,state,created_at) SELECT ?,j.id,'owner',?,?,?,?,?,?,?,?,?,?,'APPROVED',? FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND json_extract(j.audit_json,'$.audioProcessingCoverage')=1 AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING') AND s.raw=? AND s.segments_json=? AND json_remove(j.audit_json,'$.summaryProvider','$.externalFactCheck')=? AND EXISTS(SELECT 1 FROM provider_credentials c WHERE c.owner_id='owner' AND c.provider='gemini' AND c.cipher_version=? AND c.iv_b64=? AND c.ciphertext_b64=? AND c.updated_at=?)").bind(id,quote.sourceSha256,quote.quoteSha256,JSON.stringify(quote),quote.model,quote.priceVersion,quote.credentialGeneration,maxMicroUsd,quote.maxCallMicroUsd,maxCalls,expiresAt,new Date().toISOString(),quote.jobId,sourceSnapshot.raw,sourceSnapshot.segmentsJson,sourceSnapshot.auditJson,key.cipher_version,key.iv_b64,key.ciphertext_b64,key.updated_at).run();
 if(result.meta?.changes!==1)fail('PAID_APPROVAL_SCOPE_CHANGED');
 return {id,state:'APPROVED',maxMicroUsd,maxCalls,expiresAt,quoteSha256:quote.quoteSha256};
}

// A single SQLite statement checks contract, call uniqueness and aggregate spend atomically.
export async function reservePaidSummaryCall(env,{id,approvalId,callIndex,jobId,sourceSha256,sourceSnapshot,quoteSha256,model,priceVersion,credentialGeneration,now=Date.now()}){
 if(!id||!approvalId||!Number.isSafeInteger(callIndex)||callIndex<0||!hex64(sourceSha256)||!hex64(quoteSha256)||!validSnapshot(sourceSnapshot)||await digest(sourceSnapshot)!==sourceSha256)fail('PAID_RESERVATION_INVALID');
 const DB=env.DB,key=await keySnapshot(env,credentialGeneration);
 const approved=await DB.prepare('SELECT quote_json FROM yta_paid_summary_approvals WHERE id=? AND job_id=? AND owner_id=?').bind(approvalId,jobId,'owner').first();
 let approvedQuote;try{approvedQuote=JSON.parse(approved?.quote_json);}catch{fail('PAID_APPROVAL_SCOPE_CHANGED');}
 if(approvedQuote.quoteSha256!==quoteSha256||await digest(Object.fromEntries(Object.entries(approvedQuote).filter(([name])=>name!=='quoteSha256')))!==quoteSha256)fail('PAID_APPROVAL_SCOPE_CHANGED');
 const result=await DB.prepare("INSERT OR IGNORE INTO yta_paid_summary_reservations(id,approval_id,call_index,reserved_micro_usd,state,created_at) SELECT ?,a.id,?,a.max_call_micro_usd,'RESERVED',? FROM yta_paid_summary_approvals a JOIN jobs j ON j.id=a.job_id JOIN yta_sources s ON s.job_id=j.id WHERE a.id=? AND a.job_id=? AND a.owner_id='owner' AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND json_extract(j.audit_json,'$.audioProcessingCoverage')=1 AND a.state='APPROVED' AND a.expires_at>? AND a.source_sha256=? AND a.quote_sha256=? AND a.quote_json=? AND a.max_call_micro_usd=? AND a.max_micro_usd<=? AND a.max_calls<=? AND a.expires_at<=? AND a.model=? AND a.price_version=? AND a.credential_generation=? AND s.raw=? AND s.segments_json=? AND json_remove(j.audit_json,'$.summaryProvider','$.externalFactCheck')=? AND EXISTS(SELECT 1 FROM provider_credentials c WHERE c.owner_id='owner' AND c.provider='gemini' AND c.cipher_version=? AND c.iv_b64=? AND c.ciphertext_b64=? AND c.updated_at=?) AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING') AND ?<a.max_calls AND (SELECT COUNT(*) FROM yta_paid_summary_reservations r WHERE r.approval_id=a.id AND r.state<>'RELEASED')<a.max_calls AND COALESCE((SELECT SUM(r.reserved_micro_usd) FROM yta_paid_summary_reservations r WHERE r.approval_id=a.id AND r.state<>'RELEASED'),0)+a.max_call_micro_usd<=a.max_micro_usd").bind(id,callIndex,new Date(now).toISOString(),approvalId,jobId,now,sourceSha256,quoteSha256,approved.quote_json,approvedQuote.maxCallMicroUsd,approvedQuote.maxMicroUsd,approvedQuote.maxCalls,approvedQuote.expiresAt,model,priceVersion,credentialGeneration,sourceSnapshot.raw,sourceSnapshot.segmentsJson,sourceSnapshot.auditJson,key.cipher_version,key.iv_b64,key.ciphertext_b64,key.updated_at,callIndex).run();
 if(result.meta?.changes!==1)fail('PAID_BUDGET_OR_SCOPE_BLOCKED');
 const row=await DB.prepare('SELECT reserved_micro_usd FROM yta_paid_summary_reservations WHERE id=?').bind(id).first();
 return {id,state:'RESERVED',amountMicroUsd:row.reserved_micro_usd};
}

export async function markPaidSummaryUncertain(DB,id){const result=await DB.prepare("UPDATE yta_paid_summary_reservations SET state='UNCERTAIN' WHERE id=? AND state='RESERVED'").bind(id).run();if(result.meta?.changes!==1)fail('PAID_RESERVATION_STATE_CHANGED');}
export async function cancelPaidSummaryBudget(DB,id){const result=await DB.prepare("UPDATE yta_paid_summary_approvals SET state='CANCELLED' WHERE id=? AND state='APPROVED'").bind(id).run();if(result.meta?.changes!==1)fail('PAID_APPROVAL_STATE_CHANGED');}
export async function releaseUndispatchedPaidSummary(DB,id){const result=await DB.prepare("UPDATE yta_paid_summary_reservations SET state='RELEASED',outcome='PROVEN_NOT_SENT' WHERE id=? AND state='RESERVED'").bind(id).run();if(result.meta?.changes!==1)fail('PAID_RESERVATION_STATE_CHANGED');}
export async function settlePaidSummary(DB,id,quote,usage,outcome){
 const input=usage?.promptTokenCount,output=usage?.candidatesTokenCount,thinking=usage?.thoughtsTokenCount??0;
 if(![input,output,thinking].every(n=>Number.isSafeInteger(n)&&n>=0)||input>quote.inputTokensUpper||output+thinking>quote.outputTokensUpper){await markPaidSummaryUncertain(DB,id);return {state:'UNCERTAIN',tokenEstimateMicroUsd:null};}
 const tokenEstimateMicroUsd=cost(input,quote.priceInputMicroUsdPerMillion)+cost(output+thinking,quote.priceOutputMicroUsdPerMillion);
 const result=await DB.prepare("UPDATE yta_paid_summary_reservations SET state='SETTLED',token_estimate_micro_usd=?,usage_json=?,outcome=? WHERE id=? AND state='RESERVED'").bind(tokenEstimateMicroUsd,JSON.stringify({promptTokenCount:input,candidatesTokenCount:output,thoughtsTokenCount:thinking}),outcome,id).run();
 if(result.meta?.changes!==1)fail('PAID_RESERVATION_STATE_CHANGED');
 return {state:'SETTLED',tokenEstimateMicroUsd,invoiceAmount:'UNKNOWN'};
}
