import {ProviderError} from './adapters.mjs';
import {capacityIdentity} from './observed-capacity.mjs';
import {completeSource,promptAudit,summaryInputAudit} from './groq-summary.mjs';
import {PAID_SUMMARY_CATALOG,paidExecutionAllowed,firstTrialExecutionEnabled,fullSummaryRequest,paidRequestCostPreview,validatePaidFullReport} from './paid-summary-contract.mjs';
import {priceSummaryQuote,approvePaidSummaryBudget,reservePaidSummaryCall,markPaidSummaryUncertain,releaseUndispatchedPaidSummary,settlePaidSummary,cancelPaidSummaryBudget} from './paid-summary-budget.mjs';
import {runPaidGeminiFullSummary} from './paid-summary-adapter.mjs';
import {FIRST_TRIAL_KIND,FIRST_TRIAL_EVIDENCE,firstTrialSchemaReady,firstTrialRequestValid,reserveFirstTrialIntent,approveFirstTrial,firstTrialForApproval,firstTrialMatches,consumeFirstTrial} from './paid-summary-trial.mjs';

const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(b=>b.toString(16).padStart(2,'0')).join('');
const fail=(code,message='유료 요약 견적·승인 상태를 다시 확인하세요.')=>{throw new ProviderError(code,message);};
const snapshot=(job,source)=>({raw:source.raw,segmentsJson:source.segments_json,auditJson:JSON.stringify(summaryInputAudit(job.audit))});

async function scope(env,job,sourceOf){const complete=await completeSource(env,job,sourceOf),source=complete.source,sourceSnapshot=snapshot(job,source),request=fullSummaryRequest(source,promptAudit(job));return {source,sourceSnapshot,request,sourceSha256:await digest(sourceSnapshot),requestSha256:await digest(request.body)};}
async function schema(env){const rows=(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('yta_paid_summary_quotes','yta_paid_summary_approvals','yta_paid_summary_reservations')").all()).results||[];if(rows.length!==3)fail('PAID_SCHEMA_REQUIRED','유료 계약 migration이 아직 준비되지 않았습니다.');}
async function quoteRow(env,id,quoteId){return env.DB.prepare("SELECT id,quote_json,quote_sha256,request_sha256,source_sha256,expires_at,state FROM yta_paid_summary_quotes WHERE id=? AND job_id=? AND owner_id='owner'").bind(quoteId,id).first();}
async function catalogQuote(id,current,credentialGeneration,expiresAt){const c=PAID_SUMMARY_CATALOG;return priceSummaryQuote({jobId:id,sourceSha256:current.sourceSha256,requestSha256:current.requestSha256,model:c.model,priceVersion:c.priceVersion,priceSource:c.priceSource,inputTokensUpper:current.request.inputChargeCeiling,outputTokensUpper:current.request.outputChargeCeiling,plannedCalls:1,maxRetries:0,maxTaxBps:10000,priceInputMicroUsdPerMillion:c.inputPriceMicroUsdPerMillion,priceOutputMicroUsdPerMillion:c.outputPriceMicroUsdPerMillion,credentialGeneration,expiresAt,costEstimate:paidRequestCostPreview(current.request)});}
async function issuedQuote(env,id,job,current){
 const storedKey=await env.DB.prepare("SELECT 1 AS ok FROM provider_credentials WHERE owner_id='owner' AND provider='gemini'").first();if(!storedKey)fail('PAID_CREDENTIAL_UNAVAILABLE');
 const key=await capacityIdentity(env,'gemini');
 const approved=await env.DB.prepare("SELECT 1 AS ok FROM yta_paid_summary_approvals WHERE job_id=? AND owner_id='owner'").bind(id).first();if(approved)fail('PAID_APPROVAL_EXISTS');
 const old=await env.DB.prepare("SELECT id,quote_json,quote_sha256,request_sha256,source_sha256,expires_at FROM yta_paid_summary_quotes WHERE job_id=? AND owner_id='owner' AND state='ISSUED' AND expires_at>? ORDER BY created_at DESC LIMIT 1").bind(id,Date.now()).first();
 const firstTrialAvailable=await firstTrialSchemaReady(env.DB)&&!(await env.DB.prepare("SELECT id FROM yta_paid_first_trial WHERE id='FIRST_GENERATION'").first());
 if(old){const parsed=JSON.parse(old.quote_json),trusted=await catalogQuote(id,current,key,old.expires_at);if(old.source_sha256===current.sourceSha256&&old.request_sha256===current.requestSha256&&old.quote_sha256===trusted.quoteSha256&&parsed.quoteSha256===trusted.quoteSha256)return {quoteId:old.id,quote:parsed,firstTrialAvailable,firstTrialEvidence:FIRST_TRIAL_EVIDENCE,accountModelAvailability:'UNVERIFIED',providerBalance:'UNKNOWN'};}
 await env.DB.prepare("UPDATE yta_paid_summary_quotes SET state='EXPIRED' WHERE job_id=? AND owner_id='owner' AND state='ISSUED'").bind(id).run();
 const quote=await catalogQuote(id,current,key,Date.now()+600000);
 const quoteId=crypto.randomUUID(),inserted=await env.DB.prepare("INSERT OR IGNORE INTO yta_paid_summary_quotes(id,job_id,owner_id,source_sha256,quote_sha256,quote_json,request_sha256,state,expires_at,created_at) SELECT ?,j.id,'owner',?,?,?,?,'ISSUED',?,? FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND json_remove(j.audit_json,'$.summaryProvider','$.externalFactCheck')=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(quoteId,current.sourceSha256,quote.quoteSha256,JSON.stringify(quote),current.requestSha256,quote.expiresAt,new Date().toISOString(),id,current.sourceSnapshot.auditJson,current.sourceSnapshot.raw,current.sourceSnapshot.segmentsJson).run();
 if(inserted.meta?.changes!==1){const winner=await env.DB.prepare("SELECT id,quote_json,quote_sha256,expires_at FROM yta_paid_summary_quotes WHERE job_id=? AND owner_id='owner' AND state='ISSUED' AND expires_at>?").bind(id,Date.now()).first();if(winner){const trusted=await catalogQuote(id,current,key,winner.expires_at),parsed=JSON.parse(winner.quote_json);if(winner.quote_sha256===trusted.quoteSha256&&parsed.quoteSha256===trusted.quoteSha256)return {quoteId:winner.id,quote:parsed,firstTrialAvailable,firstTrialEvidence:FIRST_TRIAL_EVIDENCE,accountModelAvailability:'UNVERIFIED',providerBalance:'UNKNOWN'};}fail('PAID_QUOTE_SCOPE_CHANGED');}
 return {quoteId,quote,firstTrialAvailable,firstTrialEvidence:FIRST_TRIAL_EVIDENCE,accountModelAvailability:'UNVERIFIED',providerBalance:'UNKNOWN',inputRequestBytes:current.request.requestBytes,estimatedInputUpper:current.request.estimatedInputUpper,taxNote:'승인 상한은 100% 세금 여유를 포함합니다. 실제 세금과 제공자 청구액은 확인 전입니다.'};
}

async function dispatchGuard(env,{id,approvalId,reservationId,current,quote,firstTrial}){
 if(!paidExecutionAllowed(env,firstTrial))fail('PAID_EXECUTION_DISABLED');
 const credential=await env.DB.prepare('SELECT cipher_version,iv_b64,ciphertext_b64,updated_at FROM provider_credentials WHERE owner_id=? AND provider=?').bind('owner','gemini').first();
 if(!credential||await capacityIdentity(env,'gemini')!==quote.credentialGeneration)fail('PAID_CREDENTIAL_CHANGED');
 const row=await env.DB.prepare("SELECT a.expires_at AS approval_expires_at FROM yta_paid_summary_reservations r JOIN yta_paid_summary_approvals a ON a.id=r.approval_id JOIN jobs j ON j.id=a.job_id JOIN yta_sources s ON s.job_id=j.id JOIN provider_credentials c ON c.owner_id='owner' AND c.provider='gemini' WHERE r.id=? AND r.state='RESERVED' AND r.reserved_micro_usd=? AND a.id=? AND a.state='APPROVED' AND a.expires_at>? AND a.job_id=? AND a.owner_id='owner' AND a.quote_sha256=? AND a.quote_json=? AND a.source_sha256=? AND a.max_call_micro_usd=? AND a.max_micro_usd<=? AND a.max_calls<=? AND a.credential_generation=? AND a.model=? AND a.price_version=? AND j.owner_id='owner' AND (j.report_json IS NULL OR j.report_json='null') AND json_remove(j.audit_json,'$.summaryProvider','$.externalFactCheck')=? AND s.raw=? AND s.segments_json=? AND c.cipher_version=? AND c.iv_b64=? AND c.ciphertext_b64=? AND c.updated_at=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=j.id||':deleting' AND d.state='DELETING')").bind(reservationId,quote.maxCallMicroUsd,approvalId,Date.now(),id,quote.quoteSha256,JSON.stringify(quote),current.sourceSha256,quote.maxCallMicroUsd,quote.maxMicroUsd,quote.maxCalls,quote.credentialGeneration,quote.model,quote.priceVersion,current.sourceSnapshot.auditJson,current.sourceSnapshot.raw,current.sourceSnapshot.segmentsJson,credential.cipher_version,credential.iv_b64,credential.ciphertext_b64,credential.updated_at).first();
 if(!row||Date.now()>=row.approval_expires_at||Date.now()>=quote.expiresAt||!paidExecutionAllowed(env,firstTrial))fail('PAID_DISPATCH_SCOPE_CHANGED');
}

export async function handlePaidSummaryAction(request,env,{id,action,job,sourceOf,ownedJob}){
 await schema(env);
 if(action==='paid-summary-status'&&request.method==='GET'){
  const approval=await env.DB.prepare("SELECT id,state,max_micro_usd,max_calls,expires_at,quote_sha256 FROM yta_paid_summary_approvals WHERE job_id=? AND owner_id='owner'").bind(id).first();
  const trial=approval?await firstTrialForApproval(env.DB,approval.id):null;
  const latestQuote=await env.DB.prepare("SELECT id,quote_json FROM yta_paid_summary_quotes WHERE job_id=? AND owner_id='owner' AND state='ISSUED' AND expires_at>? ORDER BY created_at DESC LIMIT 1").bind(id,Date.now()).first();
  const firstTrialAvailable=await firstTrialSchemaReady(env.DB)&&!(await env.DB.prepare("SELECT id FROM yta_paid_first_trial WHERE id='FIRST_GENERATION'").first());
  const reservations=approval?(await env.DB.prepare('SELECT id,call_index,reserved_micro_usd,token_estimate_micro_usd,usage_json,outcome,state FROM yta_paid_summary_reservations WHERE approval_id=?').bind(approval.id).all()).results||[]:[];
  let executionReady=false;
  if(approval?.state==='APPROVED'&&approval.expires_at>Date.now()&&reservations.length===0&&!job.report&&paidExecutionAllowed(env,!!trial)){
   try{const current=await scope(env,job,sourceOf),saved=await env.DB.prepare("SELECT quote_json FROM yta_paid_summary_approvals WHERE id=? AND job_id=? AND owner_id='owner' AND state='APPROVED'").bind(approval.id,id).first(),quote=JSON.parse(saved.quote_json),key=await capacityIdentity(env,'gemini'),trusted=await catalogQuote(id,current,key,quote.expiresAt),credential=await env.DB.prepare("SELECT 1 AS ok FROM provider_credentials WHERE owner_id='owner' AND provider='gemini'").first();
    executionReady=!!credential&&quote.quoteSha256===trusted.quoteSha256&&approval.quote_sha256===trusted.quoteSha256&&approval.expires_at>Date.now()&&approval.expires_at<=quote.expiresAt&&approval.max_micro_usd>=quote.maxCallMicroUsd&&approval.max_calls>=1&&(!trial||firstTrialMatches(trial,{approvalId:approval.id,quote,current}));
   }catch{executionReady=false;}
  }
  const finalReportSaved=job.report?.kind==='GEMINI_PAID_FULL_EVIDENCE_LINKED';
  let recordedTrialEvidence=null;if(trial)try{recordedTrialEvidence=JSON.parse(trial.evidence_json);}catch{}
  return json({issuedQuote:latestQuote?{quoteId:latestQuote.id,quote:JSON.parse(latestQuote.quote_json),firstTrialAvailable,firstTrialEvidence:FIRST_TRIAL_EVIDENCE}:null,approval,firstTrial:trial?{kind:FIRST_TRIAL_KIND,state:trial.state,generation:trial.state==='CONSUMED'?(finalReportSaved&&reservations.some(item=>item.state==='SETTLED')?'SUCCEEDED':'UNCONFIRMED'):'UNTESTED',metadataGet:'NOT_REQUESTED',evidence:recordedTrialEvidence}:null,reservations:reservations.map(({usage_json,...row})=>({...row,usage:usage_json?JSON.parse(usage_json):null})),executionReady,finalReportSaved,providerInvoiceAmount:'UNKNOWN'});
 }
 if(action==='paid-summary-quote'&&request.method==='POST'){
  if(job.report)fail('SUMMARY_ALREADY_EXISTS');const current=await scope(env,job,sourceOf);return json(await issuedQuote(env,id,job,current));
 }
 if(action==='paid-summary-approve'&&request.method==='POST'){
  if(job.report)fail('SUMMARY_ALREADY_EXISTS');const body=await request.json();if(!body?.quoteId||body.confirmExactQuote!==true||body.confirmNoAutomaticFallback!==true)fail('PAID_APPROVAL_REQUIRED');
  const current=await scope(env,job,sourceOf),row=await quoteRow(env,id,body.quoteId);if(!row||row.state!=='ISSUED'||row.expires_at<=Date.now()||row.source_sha256!==current.sourceSha256||row.request_sha256!==current.requestSha256)fail('PAID_QUOTE_SCOPE_CHANGED');
  const quote=JSON.parse(row.quote_json),trusted=await catalogQuote(id,current,await capacityIdentity(env,'gemini'),row.expires_at);if(quote.quoteSha256!==row.quote_sha256||quote.quoteSha256!==trusted.quoteSha256||quote.requestSha256!==current.requestSha256)fail('PAID_QUOTE_SCOPE_CHANGED');
  if(body.trialKind!==undefined&&body.trialKind!==FIRST_TRIAL_KIND)fail('PAID_FIRST_TRIAL_SCOPE_CHANGED');
  if(body.trialKind===FIRST_TRIAL_KIND&&(!firstTrialExecutionEnabled(env)||!firstTrialRequestValid({quote,maxMicroUsd:body.maxMicroUsd,maxCalls:body.maxCalls,expiresAt:body.expiresAt,confirmUnknownGeneration:body.confirmUnknownGeneration,confirmExistingPrepayOnly:body.confirmExistingPrepayOnly,confirmCurrentKeyProject:body.confirmCurrentKeyProject})||!await firstTrialSchemaReady(env.DB)||await env.DB.prepare("SELECT id FROM yta_paid_first_trial WHERE id='FIRST_GENERATION'").first()))fail('PAID_FIRST_TRIAL_SCOPE_CHANGED');
  if(body.trialKind===FIRST_TRIAL_KIND)await reserveFirstTrialIntent(env.DB,{approvalId:row.id,quote,quoteId:row.id,maxMicroUsd:body.maxMicroUsd,maxCalls:body.maxCalls,expiresAt:body.expiresAt,confirmUnknownGeneration:body.confirmUnknownGeneration,confirmExistingPrepayOnly:body.confirmExistingPrepayOnly,confirmCurrentKeyProject:body.confirmCurrentKeyProject});
  const approval=await approvePaidSummaryBudget(env,quote,{id:row.id,maxMicroUsd:body.maxMicroUsd,maxCalls:body.maxCalls,expiresAt:body.expiresAt,confirmExactQuote:true,sourceSnapshot:current.sourceSnapshot});
  const trial=body.trialKind===FIRST_TRIAL_KIND?await approveFirstTrial(env.DB,{approvalId:approval.id,quote,maxMicroUsd:body.maxMicroUsd,expiresAt:body.expiresAt}):null;
  return json({...approval,trial,automaticExecution:false});
 }
 if(action==='paid-summary-cancel'&&request.method==='POST'){
  const approval=await env.DB.prepare("SELECT id FROM yta_paid_summary_approvals WHERE job_id=? AND owner_id='owner'").bind(id).first();if(!approval)fail('PAID_APPROVAL_NOT_FOUND');await cancelPaidSummaryBudget(env.DB,approval.id);return json({cancelled:true,automaticRefund:false});
 }
 if(action==='paid-summary-execute'&&request.method==='POST'){
  if(job.report?.kind==='GEMINI_PAID_FULL_EVIDENCE_LINKED')return json({job,cached:true,persisted:true});if(job.report)fail('SUMMARY_ALREADY_EXISTS');
  const body=await request.json(),approvalId=body?.approvalId;if(typeof approvalId!=='string')fail('PAID_APPROVAL_REQUIRED');
  const trial=await firstTrialForApproval(env.DB,approvalId),firstTrial=!!trial;
  if(!paidExecutionAllowed(env,firstTrial))fail('PAID_EXECUTION_DISABLED');
  const approval=await env.DB.prepare("SELECT quote_json FROM yta_paid_summary_approvals WHERE id=? AND job_id=? AND owner_id='owner' AND state='APPROVED'").bind(approvalId,id).first();if(!approval)fail('PAID_APPROVAL_REQUIRED');
  const quote=JSON.parse(approval.quote_json),current=await scope(env,job,sourceOf);
  const trusted=await catalogQuote(id,current,await capacityIdentity(env,'gemini'),quote.expiresAt);
  if(quote.quoteSha256!==trusted.quoteSha256||quote.sourceSha256!==current.sourceSha256||quote.requestSha256!==current.requestSha256||firstTrial&&!firstTrialMatches(trial,{approvalId,quote,current}))fail('PAID_QUOTE_SCOPE_CHANGED');
  const reservationId=approvalId+':call:0';await reservePaidSummaryCall(env,{id:reservationId,approvalId,callIndex:0,jobId:id,sourceSha256:current.sourceSha256,sourceSnapshot:current.sourceSnapshot,quoteSha256:quote.quoteSha256,model:quote.model,priceVersion:quote.priceVersion,credentialGeneration:quote.credentialGeneration});
  let dispatchAdmitted=false,result;
  try{
   const beforeFetch=async()=>{await dispatchGuard(env,{id,approvalId,reservationId,current,quote,firstTrial});if(firstTrial){await consumeFirstTrial(env.DB,{approvalId,reservationId,quote,current});if(Date.now()>=trial.expires_at||!paidExecutionAllowed(env,true))fail('PAID_DISPATCH_SCOPE_CHANGED');}dispatchAdmitted=true;};
   const runner=env.PAID_SUMMARY_TEST_RUNNER??runPaidGeminiFullSummary;
   result=await runner({env,body:current.request.body,quote,firstTrial,beforeFetch});
   if(!dispatchAdmitted)fail('PAID_ADAPTER_GUARD_MISSING');
   const report=validatePaidFullReport(result.text,current.source);
   const saved=await env.DB.prepare("UPDATE jobs SET report_json=?,audit_json=json_set(audit_json,'$.summaryProvider','gemini-paid','$.externalFactCheck','NOT_PERFORMED'),status='COMPLETE',updated_at=? WHERE id=? AND owner_id='owner' AND (report_json IS NULL OR report_json='null') AND json_remove(audit_json,'$.summaryProvider','$.externalFactCheck')=? AND EXISTS(SELECT 1 FROM yta_sources WHERE job_id=? AND raw=? AND segments_json=?) AND EXISTS(SELECT 1 FROM yta_paid_summary_reservations WHERE id=? AND state='RESERVED') AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE id=? AND state='DELETING')").bind(JSON.stringify(report),new Date().toISOString(),id,current.sourceSnapshot.auditJson,id,current.sourceSnapshot.raw,current.sourceSnapshot.segmentsJson,reservationId,id+':deleting').run();
   if(saved.meta?.changes!==1)fail('PAID_SAVE_SCOPE_CHANGED');
   const settlement=await settlePaidSummary(env.DB,reservationId,quote,result.usage,'REPORT_SAVED');
   return json({job:await ownedJob(env,id),persisted:true,settlement});
  }catch(error){
   if(!dispatchAdmitted)await releaseUndispatchedPaidSummary(env.DB,reservationId);
   else if(result?.usage)await settlePaidSummary(env.DB,reservationId,quote,result.usage,'REPORT_NOT_SAVED');
   else await markPaidSummaryUncertain(env.DB,reservationId);
   throw error;
  }
 }
 return json({error:{code:'METHOD_NOT_ALLOWED'}},405);
}
