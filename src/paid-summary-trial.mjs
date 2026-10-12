import {ProviderError} from './adapters.mjs';
import {PAID_SUMMARY_CATALOG} from './paid-summary-contract.mjs';

export const FIRST_TRIAL_KIND='FIRST_GENERATION_UNTESTED';
export const FIRST_TRIAL_MAX_MICRO_USD=720896;
export const FIRST_TRIAL_EVIDENCE=Object.freeze({
 keyProject:'OWNER_CONFIRMED_FOR_QUOTED_KEY_GENERATION',
 paidBalance:'OWNER_REPORTED_KRW_8000_AUTO_RELOAD_OFF_AT_REVIEW',
 observedPrepayTopup:'OWNER_UI_2026_10_11_KRW_8000_EQUALS_CREDIT_7273_PLUS_VAT_727',
 modelListing:'OWNER_REPORTED_IN_PROJECT_UI',
 metadataGet:'NOT_REQUESTED',
 generation:'UNTESTED',
 modelPrice:'OFFICIAL_STANDARD_TEXT_CATALOG',
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
 return confirmUnknownGeneration===true&&confirmExistingPrepayOnly===true&&confirmCurrentKeyProject===true&&quote?.model===PAID_SUMMARY_CATALOG.model&&quote.maxRetries===0&&quote.plannedCalls===1&&quote.maxCalls===1&&quote.maxCallMicroUsd===FIRST_TRIAL_MAX_MICRO_USD&&quote.maxMicroUsd===FIRST_TRIAL_MAX_MICRO_USD&&maxMicroUsd===FIRST_TRIAL_MAX_MICRO_USD&&maxCalls===1&&Number.isSafeInteger(expiresAt)&&expiresAt<=quote.expiresAt;
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

export async function consumeFirstTrial(DB,{approvalId,reservationId,quote,current}){
 const result=await DB.prepare("UPDATE yta_paid_first_trial SET state='CONSUMED',consumed_at=? WHERE id='FIRST_GENERATION' AND state='APPROVED' AND approval_id=? AND job_id=? AND source_sha256=? AND request_sha256=? AND quote_sha256=? AND model=? AND credential_generation=? AND expires_at>? AND expires_at<=? AND max_calls=1 AND max_micro_usd=? AND EXISTS(SELECT 1 FROM yta_paid_summary_approvals a JOIN yta_paid_summary_reservations r ON r.approval_id=a.id WHERE a.id=? AND a.state='APPROVED' AND a.expires_at>? AND a.quote_sha256=? AND a.max_micro_usd=? AND a.max_call_micro_usd=? AND r.id=? AND r.state='RESERVED' AND r.reserved_micro_usd=?)").bind(new Date().toISOString(),approvalId,quote.jobId,current.sourceSha256,current.requestSha256,quote.quoteSha256,quote.model,quote.credentialGeneration,Date.now(),quote.expiresAt,FIRST_TRIAL_MAX_MICRO_USD,approvalId,Date.now(),quote.quoteSha256,FIRST_TRIAL_MAX_MICRO_USD,FIRST_TRIAL_MAX_MICRO_USD,reservationId,FIRST_TRIAL_MAX_MICRO_USD).run();
 if(result.meta?.changes!==1)fail();
}
