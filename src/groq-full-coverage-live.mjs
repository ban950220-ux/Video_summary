import {ProviderError} from './adapters.mjs';
import {runOwnedGroqSummary} from './provider-keys.mjs';
import {planPersistedFullCoverage,nextFullCoverageStage,fullCoverageAdmission,executeFullCoverageStep,finalizeFullCoverage,FULL_COVERAGE_DAY_RESERVATION} from './groq-full-coverage.mjs';
import {fullCoverageApprovalId,fullCoverageD1Store,fullCoverageKeyBinding,fullCoverageLedger} from './groq-full-coverage-d1.mjs';

const respond=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const reject=code=>{throw new ProviderError(code,code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const allowed=['NEW_HELD_LEAF','NEW_LEAF'];
const nowIso=()=>new Date().toISOString();
async function bodyOf(request){let value;try{value=await request.json();}catch{reject('FULL_BAD_JSON');}if(!value||typeof value!=='object'||Array.isArray(value))reject('FULL_BAD_JSON');return value;}
async function readApproval(env,id){
 const rows=(await env.DB.prepare("SELECT id,state,result_json FROM yta_operations WHERE job_id=? AND provider='groq-full-coverage-approval' ORDER BY CAST(json_extract(result_json,'$.sequence') AS INTEGER) DESC LIMIT 2").bind(id).all()).results||[];
 if(rows.length>1&&rows[0].id===rows[1].id)reject('FULL_APPROVAL_DUPLICATE');
 const row=rows[0];if(!row)return null;
 let value;try{value=JSON.parse(row.result_json);}catch{reject('FULL_APPROVAL_INVALID');}
 if(row.id!==fullCoverageApprovalId(id,value?.sequence)||!['APPROVED','STOPPED'].includes(row.state))reject('FULL_APPROVAL_INVALID');
 return {...value,state:row.state};
}
async function recordsOf(env,id,plan,store){
 return store.loadAll();
}
function validateApproval(approval,plan,transcriptHash,evidence,proof){
 if(!approval||approval.planSha256!==plan.planSha256||approval.sourceHash!==plan.sourceHash||approval.sourceAuditSha256!==plan.sourceAuditSha256||approval.legacyTranscriptHash!==transcriptHash||!same(approval.heldFailureEvidence,evidence)||approval.keyIdentity!==proof?.identity||approval.bindingRecordSha256!==proof?.recordSha256||approval.acknowledgeNewCallForUncertainRaw8!==(plan.mode!=='FRESH_IMPORTED_TRANSCRIPT')||approval.acknowledgeDuplicateSummaryTokens!==(plan.mode==='FRESH_IMPORTED_TRANSCRIPT')||approval.providerFreeBound!==true||approval.noPaidFallback!==true||approval.noAutoRetry!==true||!Number.isSafeInteger(approval.maxRequests)||approval.maxRequests<1||approval.maxRequests>plan.stages.filter(s=>allowed.includes(s.kind)).length||!Number.isSafeInteger(approval.issuedAt)||!Number.isSafeInteger(approval.expiresAt)||approval.expiresAt>approval.issuedAt+3_600_000||approval.expiresAt<=Date.now())reject('FULL_APPROVAL_CHANGED_OR_EXPIRED');
}
export async function handleFullCoverageAction(request,env,{id,job,sourceOf,ownedJob,dispatchOverride=null}){
 if(!['GET','POST'].includes(request.method))return respond({error:{code:'METHOD_NOT_ALLOWED'}},405);
 if(job.report)return respond({state:job.report.compositionMode==='groq-full-coverage-v1'?'SAVED':'OTHER_REPORT_SAVED',saved:true,compositionMode:job.report.compositionMode??null,providerCalls:0});
  const {plan,source,transcriptHash,heldFailureEvidence,historicalOperationIds,historicalOperationProofs,historicalUsageProofs}=await planPersistedFullCoverage(env,job,sourceOf);
 const proof=await fullCoverageKeyBinding(env),approval=await readApproval(env,id);
 const safeApproval=approval?.planSha256===plan.planSha256&&approval?.sourceHash===plan.sourceHash&&approval?.legacyTranscriptHash===transcriptHash&&same(approval?.heldFailureEvidence,heldFailureEvidence)?approval:null;
  const store=fullCoverageD1Store({env,id,job,source,plan,approval:safeApproval??{sequence:0,legacyTranscriptHash:transcriptHash,keyIdentity:'',bindingRecordSha256:''},heldFailureEvidence,historicalOperationIds,historicalOperationProofs,historicalUsageProofs,transcriptHash});
 const records=await recordsOf(env,id,plan,store),next=nextFullCoverageStage(plan,records);
 const ledger=await fullCoverageLedger(env),newStages=plan.stages.filter(item=>allowed.includes(item.kind)),completed=newStages.filter(item=>records.get(item.key)?.state==='DONE').length;
 const admission=next.state==='PENDING'?fullCoverageAdmission({now:Date.now(),ledger,request:next.stage,providerFreeBound:proof!==null,approvalExpiresAt:safeApproval?.state==='APPROVED'?safeApproval.expiresAt:0,reviewedUncertainIds:heldFailureEvidence.map(x=>x.operationId)}):null;
 const status={contract:'groq-full-coverage-v1',jobId:id,planSha256:plan.planSha256,sourceHash:plan.sourceHash,sourceAuditSha256:plan.sourceAuditSha256,sourceSegments:plan.segmentCount,reusedLegacy:plan.mode==='FRESH_IMPORTED_TRANSCRIPT'?0:8,heldLegacy:plan.mode==='FRESH_IMPORTED_TRANSCRIPT'?null:'raw:8',heldLegacyFailurePreserved:plan.mode!=='FRESH_IMPORTED_TRANSCRIPT',freshTranscriptJob:plan.mode==='FRESH_IMPORTED_TRANSCRIPT',requiredNewRequests:newStages.length,completedNewRequests:completed,remainingNewRequests:newStages.length-completed,reservationUpperBound:newStages.reduce((n,s)=>n+s.reservationTokens,0),reservationBasis:'UTF8_REQUEST_BYTES_PLUS_512_AND_OUTPUT_CAP_NOT_PROVIDER_TOKEN_COUNT',rollingDayAppCap:FULL_COVERAGE_DAY_RESERVATION,accountRemaining:'UNKNOWN',featureEnabled:env.ENABLE_FULL_COVERAGE==='true',freeKeyBindingVerified:proof!==null,approvalState:safeApproval?.state??'NONE',approvalExpiresAt:safeApproval?.expiresAt??null,stageState:next.state,nextStage:next.stage?.key??null,operationState:next.operationState??null,blockedReopenReady:next.operationState==='BLOCKED'&&safeApproval?.state==='APPROVED'&&safeApproval.expiresAt>Date.now()&&safeApproval.sequence>records.get(next.stage.key)?.approvalSequence,recoveryResponseSha256:next.operationState==='RECEIPT_STORED'?records.get(next.stage.key)?.responseSha256??null:null,admission,nextAt:admission?.nextAt??null,providerCalls:0};
 if(request.method==='GET')return respond(status);
 const body=await bodyOf(request);
 if(body.step==='approve'){
  if(env.ENABLE_FULL_COVERAGE!=='true'||env.ALLOW_PAID_API==='true'||!proof||body.planSha256!==plan.planSha256||body.confirmFreePlanAndBillingDisabled!==true||body.acknowledgeAccountRemainingUnknown!==true||(plan.mode==='FRESH_IMPORTED_TRANSCRIPT'?body.acknowledgeDuplicateSummaryTokens!==true:body.acknowledgeNewCallForUncertainRaw8!==true)||body.noPaidFallback!==true||body.noAutoRetry!==true||!Number.isSafeInteger(body.maxRequests)||body.maxRequests<1||body.maxRequests>newStages.length-completed)reject('FULL_APPROVAL_REQUIREMENTS');
  if(safeApproval?.state==='APPROVED'&&safeApproval.expiresAt>Date.now()&&next.operationState!=='BLOCKED')reject('FULL_APPROVAL_ALREADY_ACTIVE');
  if(next.state==='REVIEW_REQUIRED'&&next.operationState!=='BLOCKED')reject('FULL_PRIOR_OUTCOME_REVIEW_REQUIRED');
  const sequence=(approval?.sequence??0)+1,issuedAt=Date.now(),value={sequence,issuedAt,expiresAt:issuedAt+3_600_000,planSha256:plan.planSha256,sourceHash:plan.sourceHash,sourceAuditSha256:plan.sourceAuditSha256,legacyTranscriptHash:transcriptHash,heldFailureEvidence,keyIdentity:proof.identity,bindingRecordSha256:proof.recordSha256,acknowledgeNewCallForUncertainRaw8:plan.mode!=='FRESH_IMPORTED_TRANSCRIPT',acknowledgeDuplicateSummaryTokens:plan.mode==='FRESH_IMPORTED_TRANSCRIPT',providerFreeBound:true,noPaidFallback:true,noAutoRetry:true,maxRequests:body.maxRequests};
  const inserted=await env.DB.prepare("INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,j.id,'groq-full-coverage-approval',0,'APPROVED',?,? FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE provider IN ('groq-summary','groq-summary-synthesis','groq-full-coverage') AND state IN ('CLAIMED','RECEIPT_STORED'))").bind(fullCoverageApprovalId(id,sequence),nowIso(),JSON.stringify(value),id,JSON.stringify(job.audit),source.raw,source.segments_json).run();
  if(inserted.meta?.changes!==1)reject('FULL_APPROVAL_SCOPE_CHANGED');
  return respond({approved:true,sequence,expiresAt:value.expiresAt,maxRequests:value.maxRequests,providerCalls:0});
 }
 if(body.step==='execute'){
  if(env.ENABLE_FULL_COVERAGE!=='true'||env.ALLOW_PAID_API==='true'||body.executeOnce!==true||body.planSha256!==plan.planSha256||body.expectedStage!==next.stage?.key||next.state!=='PENDING')reject('FULL_EXECUTION_SCOPE_CHANGED');
  validateApproval(safeApproval,plan,transcriptHash,heldFailureEvidence,proof);
  if(safeApproval.state!=='APPROVED')reject('FULL_APPROVAL_STOPPED');
  const dispatch=dispatchOverride??(async(requestBody)=>runOwnedGroqSummary({env:{...env,GROQ_FREE_PLAN_CONFIRMED:'true'},messages:requestBody.messages,maxCompletionTokens:next.stage.outputTokens,beforeFetch:async()=>{const binding={planSha256:plan.planSha256,sourceHash:plan.sourceHash,requestSha256:next.stage.requestSha256,key:next.stage.key,reservationTokens:next.stage.reservationTokens,approvalSequence:safeApproval.sequence};if(!await store.verifyBeforeDispatch(binding,{deep:true})){const error=new ProviderError('FULL_PRE_FETCH_SCOPE_CHANGED','FULL_PRE_FETCH_SCOPE_CHANGED');error.preDispatchBlocked=true;throw error;}}}));
  const result=await executeFullCoverageStep({plan,records,ledger,store,dispatch,approval:safeApproval,reviewedUncertainIds:heldFailureEvidence.map(x=>x.operationId)});
  return respond({...result,providerCalls:result.state==='DONE'?1:result.state==='REVIEW_REQUIRED'&&result.reason!=='RECEIPT_PERSISTENCE_UNKNOWN'? 'UNKNOWN':0,automaticContinuation:false});
 }
 if(body.step==='recover-receipt'){
  if(body.planSha256!==plan.planSha256||body.expectedStage!==next.stage?.key||next.state!=='REVIEW_REQUIRED'||next.operationState!=='RECEIPT_STORED'||typeof body.responseSha256!=='string')reject('FULL_RECEIPT_RECOVERY_NOT_READY');
  const stage=next.stage,binding={key:stage.key,planSha256:plan.planSha256,sourceHash:plan.sourceHash,requestSha256:stage.requestSha256,reservationTokens:stage.reservationTokens,approvalSequence:records.get(stage.key)?.approvalSequence};
  return respond(await store.recoverStoredReceipt(stage,binding,body.responseSha256));
 }
 if(body.step==='reopen-blocked'){
  if(body.planSha256!==plan.planSha256||body.expectedStage!==next.stage?.key||body.confirmNoProviderCall!==true||next.state!=='REVIEW_REQUIRED'||next.operationState!=='BLOCKED'||!status.blockedReopenReady)reject('FULL_BLOCKED_REOPEN_NOT_READY');
  validateApproval(safeApproval,plan,transcriptHash,heldFailureEvidence,proof);
  return respond(await store.reopenBlocked(next.stage));
 }
 if(body.step==='finalize'){
  reject('GLOBAL_SYNTHESIS_REQUIRED');
 }
 reject('FULL_UNKNOWN_STEP');
}
