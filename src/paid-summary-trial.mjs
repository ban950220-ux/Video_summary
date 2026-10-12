import {ProviderError} from './adapters.mjs';
import {PAID_SUMMARY_CATALOG} from './paid-summary-contract.mjs';

export const FIRST_TRIAL_KIND='FIRST_GENERATION_UNTESTED';
export const FIRST_TRIAL_MAX_MICRO_USD=720896;
export const FIRST_TRIAL_MODEL_PRETAX_MICRO_USD=360448;
export const FIRST_TRIAL_VAT_BPS=1000;
export const FIRST_TRIAL_MODEL_PLUS_VAT_CEILING_MICRO_USD=396493;
export const FIRST_TRIAL_EVIDENCE=Object.freeze({
 keyProject:'OWNER_CONFIRMED_FOR_QUOTED_KEY_GENERATION',
 paidBalance:'OWNER_REPORTED_KRW_8000_AUTO_RELOAD_OFF_AT_REVIEW',
 observedPrepayTopup:'OWNER_UI_2026_10_11_KRW_8000_EQUALS_CREDIT_7273_PLUS_VAT_727',
 modelListing:'OWNER_REPORTED_IN_PROJECT_UI',
 metadataGet:'NOT_REQUESTED',
 generation:'UNTESTED',
 usdCostReview:{scope:'ONE_STANDARD_TEXT_GENERATECONTENT_NO_TOOLS_NO_CACHE',modelPretaxMicroUsd:FIRST_TRIAL_MODEL_PRETAX_MICRO_USD,koreanVatBps:FIRST_TRIAL_VAT_BPS,modelPlusVatCeilingMicroUsd:FIRST_TRIAL_MODEL_PLUS_VAT_CEILING_MICRO_USD,approvedMicroUsd:FIRST_TRIAL_MAX_MICRO_USD,basis:'OFFICIAL_MODEL_PRICE_LIMITS_AND_OBSERVED_PREPAY_TOPUP_VAT'},
 koreanVat:'GENERAL_POLICY_10_PERCENT_AND_TOPUP_VAT_OBSERVED_USAGE_APPLICATION_UNVERIFIED',
 billingCurrencyAndRate:'ACCOUNT_UNVERIFIED',
 additionalFees:'UNVERIFIED',
 funding:'EXISTING_PREPAY_ONLY_NO_NEW_PURCHASE'
});
const fail=()=>{throw new ProviderError('PAID_FIRST_TRIAL_SCOPE_CHANGED','최초 생성 시험 범위를 다시 검토하세요.');};

export async function firstTrialSchemaReady(DB){
 return !!(await DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='yta_paid_first_trial'").first());
}

export async function firstTrialForApproval(DB,approvalId){
 if(!await firstTrialSchemaReady(DB))return null;
 return DB.prepare('SELECT * FROM yta_paid_first_trial WHERE approval_id=?').bind(approvalId).first();
}

export function firstTrialRequestValid({quote,maxMicroUsd,maxCalls,expiresAt,confirmUnknownGeneration,confirmExistingPrepayOnly,confirmCurrentKeyProject}){
 return confirmUnknownGeneration===true&&confirmExistingPrepayOnly===true&&confirmCurrentKeyProject===true&&quote?.model===PAID_SUMMARY_CATALOG.model&&quote.priceVersion===PAID_SUMMARY_CATALOG.priceVersion&&quote.inputTokensUpper===PAID_SUMMARY_CATALOG.inputLimit&&quote.outputTokensUpper===PAID_SUMMARY_CATALOG.outputLimit&&quote.priceInputMicroUsdPerMillion===PAID_SUMMARY_CATALOG.inputPriceMicroUsdPerMillion&&quote.priceOutputMicroUsdPerMillion===PAID_SUMMARY_CATALOG.outputPriceMicroUsdPerMillion&&quote.perCallMicroUsd===FIRST_TRIAL_MODEL_PRETAX_MICRO_USD&&Math.ceil(quote.perCallMicroUsd*(1+FIRST_TRIAL_VAT_BPS/10000))===FIRST_TRIAL_MODEL_PLUS_VAT_CEILING_MICRO_USD&&quote.maxRetries===0&&quote.plannedCalls===1&&quote.maxCalls===1&&quote.maxCallMicroUsd===FIRST_TRIAL_MAX_MICRO_USD&&quote.maxMicroUsd===FIRST_TRIAL_MAX_MICRO_USD&&maxMicroUsd===FIRST_TRIAL_MAX_MICRO_USD&&maxCalls===1&&Number.isSafeInteger(expiresAt)&&expiresAt<=quote.expiresAt;
}

export async function reserveFirstTrialIntent(DB,{approvalId,quote,quoteId,maxMicroUsd,maxCalls,expiresAt,confirmUnknownGeneration,confirmExistingPrepayOnly,confirmCurrentKeyProject}){
 if(!await firstTrialSchemaReady(DB)||!firstTrialRequestValid({quote,maxMicroUsd,maxCalls,expiresAt,confirmUnknownGeneration,confirmExistingPrepayOnly,confirmCurrentKeyProject}))fail();
 const result=await DB.prepare("INSERT OR IGNORE INTO yta_paid_first_trial(id,approval_id,job_id,source_sha256,request_sha256,quote_sha256,model,credential_generation,expires_at,max_calls,max_micro_usd,evidence_json,state,created_at) SELECT 'FIRST_GENERATION',q.id,q.job_id,q.source_sha256,q.request_sha256,q.quote_sha256,?,?,?,1,?,?, 'PENDING_APPROVAL',? FROM yta_paid_summary_quotes q WHERE q.id=? AND q.job_id=? AND q.state='ISSUED' AND q.expires_at>? AND q.source_sha256=? AND q.request_sha256=? AND q.quote_sha256=?").bind(quote.model,quote.credentialGeneration,expiresAt,FIRST_TRIAL_MAX_MICRO_USD,JSON.stringify(FIRST_TRIAL_EVIDENCE),new Date().toISOString(),quoteId,quote.jobId,Date.now(),quote.sourceSha256,quote.requestSha256,quote.quoteSha256).run();
 if(result.meta?.changes!==1)fail();
}

export async function approveFirstTrial(DB,{approvalId,quote,maxMicroUsd,expiresAt}){
 const result=await DB.prepare("UPDATE yta_paid_first_trial SET state='APPROVED' WHERE id='FIRST_GENERATION' AND state='PENDING_APPROVAL' AND approval_id=? AND job_id=? AND source_sha256=? AND request_sha256=? AND quote_sha256=? AND model=? AND credential_generation=? AND expires_at=? AND max_calls=1 AND max_micro_usd=? AND EXISTS(SELECT 1 FROM yta_paid_summary_approvals a WHERE a.id=? AND a.job_id=? AND a.state='APPROVED' AND a.source_sha256=? AND a.quote_sha256=? AND a.model=? AND a.credential_generation=? AND a.expires_at=? AND a.max_calls=1 AND a.max_call_micro_usd=? AND a.max_micro_usd=?)").bind(approvalId,quote.jobId,quote.sourceSha256,quote.requestSha256,quote.quoteSha256,quote.model,quote.credentialGeneration,expiresAt,FIRST_TRIAL_MAX_MICRO_USD,approvalId,quote.jobId,quote.sourceSha256,quote.quoteSha256,quote.model,quote.credentialGeneration,expiresAt,FIRST_TRIAL_MAX_MICRO_USD,maxMicroUsd).run();
 if(result.meta?.changes!==1)fail();
 return {kind:FIRST_TRIAL_KIND,state:'APPROVED',generation:'UNTESTED',metadataGet:'NOT_REQUESTED'};
}

export function firstTrialMatches(row,{approvalId,quote,current}){
 return !!row&&row.state==='APPROVED'&&row.approval_id===approvalId&&row.job_id===quote.jobId&&row.source_sha256===current.sourceSha256&&row.request_sha256===current.requestSha256&&row.quote_sha256===quote.quoteSha256&&row.model===quote.model&&row.credential_generation===quote.credentialGeneration&&row.expires_at>=Date.now()&&row.expires_at<=quote.expiresAt&&row.max_calls===1&&row.max_micro_usd===FIRST_TRIAL_MAX_MICRO_USD&&quote.maxCallMicroUsd===FIRST_TRIAL_MAX_MICRO_USD;
}

export async function consumeFirstTrial(DB,{approvalId,reservationId,quote,current,credential}){
 if(!credential||!current?.sourceSnapshot)fail();
 const now=Date.now();
 const result=await DB.prepare(`UPDATE yta_paid_first_trial SET state='CONSUMED',consumed_at=?
 WHERE id='FIRST_GENERATION' AND state='APPROVED' AND approval_id=? AND job_id=?
 AND source_sha256=? AND request_sha256=? AND quote_sha256=? AND model=?
 AND credential_generation=? AND expires_at>? AND expires_at<=?
 AND max_calls=1 AND max_micro_usd=?
 AND EXISTS(
  SELECT 1 FROM yta_paid_summary_approvals a
  JOIN yta_paid_summary_reservations r ON r.approval_id=a.id
  JOIN jobs j ON j.id=a.job_id
  JOIN yta_sources s ON s.job_id=j.id
  JOIN provider_credentials c ON c.owner_id='owner' AND c.provider='gemini'
  WHERE a.id=? AND a.job_id=? AND a.owner_id='owner' AND a.state='APPROVED'
  AND a.expires_at>? AND a.expires_at<=? AND a.source_sha256=?
  AND a.quote_sha256=? AND a.quote_json=? AND a.model=? AND a.price_version=?
  AND a.credential_generation=? AND a.max_micro_usd=? AND a.max_call_micro_usd=?
  AND a.max_calls=1 AND r.id=? AND r.state='RESERVED' AND r.reserved_micro_usd=?
  AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null')
  AND json_remove(j.audit_json,'$.summaryProvider','$.externalFactCheck')=?
  AND s.raw=? AND s.segments_json=?
  AND c.cipher_version=? AND c.iv_b64=? AND c.ciphertext_b64=? AND c.updated_at=?
  AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')
 )`).bind(new Date(now).toISOString(),approvalId,quote.jobId,current.sourceSha256,current.requestSha256,quote.quoteSha256,quote.model,quote.credentialGeneration,now,quote.expiresAt,FIRST_TRIAL_MAX_MICRO_USD,approvalId,quote.jobId,now,quote.expiresAt,current.sourceSha256,quote.quoteSha256,JSON.stringify(quote),quote.model,quote.priceVersion,quote.credentialGeneration,FIRST_TRIAL_MAX_MICRO_USD,FIRST_TRIAL_MAX_MICRO_USD,reservationId,FIRST_TRIAL_MAX_MICRO_USD,current.sourceSnapshot.auditJson,current.sourceSnapshot.raw,current.sourceSnapshot.segmentsJson,credential.cipher_version,credential.iv_b64,credential.ciphertext_b64,credential.updated_at).run();
 if(result.meta?.changes!==1)fail();
}
