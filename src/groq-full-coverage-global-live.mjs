import {ProviderError} from './adapters.mjs';
import {completeSource,assertGrounding} from './groq-summary.mjs';
import {planPersistedFullCoverage,nextFullCoverageStage,assembleFullCoverageReport,completeFreshTranscriptSource} from './groq-full-coverage.mjs';
import {fullCoverageD1Store,fullCoverageKeyBinding} from './groq-full-coverage-d1.mjs';
import {fullCoverageGlobalContext,readFullCoverageGlobalNodes,fullCoverageGlobalReport} from './groq-full-coverage-global.mjs';
import {synthesisAction,synthesisApprovalStatus} from './groq-synthesis-execution.mjs';
import {persistedSynthesisNode} from './groq-complete-synthesis.mjs';

const fail=code=>{throw new ProviderError(code,code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const respond=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');

export async function handleFullCoverageGlobalAction(request,env,{id,job,sourceOf,ownedJob}){
 if(!['GET','POST'].includes(request.method))return respond({error:{code:'METHOD_NOT_ALLOWED'}},405);
 if(job.report)return respond({saved:true,compositionMode:job.report.compositionMode??null,providerCalls:0});
 const build=async(fresh=job)=>{
  const verified=await planPersistedFullCoverage(env,fresh,sourceOf);
  const {plan,source}=verified,store=fullCoverageD1Store({env,id,job:fresh,source,plan,approval:{sequence:0,legacyTranscriptHash:verified.transcriptHash,keyIdentity:'',bindingRecordSha256:''},heldFailureEvidence:verified.heldFailureEvidence,historicalOperationIds:verified.historicalOperationIds,historicalOperationProofs:verified.historicalOperationProofs,historicalUsageProofs:verified.historicalUsageProofs,transcriptHash:verified.transcriptHash});
  const sections=await store.loadAll();
  if(nextFullCoverageStage(plan,sections).state!=='READY_TO_FINALIZE')fail('GLOBAL_SECTIONS_INCOMPLETE');
  const boundarySegmentIds=(fresh.audit?.audioBoundaryAmbiguities||[]).map(item=>item.segmentId);
  const context=await fullCoverageGlobalContext({plan,records:sections,segments:source.segments,raw:source.raw,boundarySegmentIds});
  return {...verified,sections,context,store};
 };
 const current=await build();
 const {context,source,heldFailureEvidence}=current;
 const durable=await readFullCoverageGlobalNodes(env,id,context,source.segments),{progress,unsettled}=durable;
 const binding=await fullCoverageKeyBinding(env);
 let recoveryCandidate=null;
 if(unsettled?.state==='FAILED_UNCERTAIN'&&progress.next){
  const failed=unsettled.record,usage=await env.DB.prepare("SELECT used_units,unit,provenance FROM usage_events WHERE id=? AND job_id=? AND owner_id='owner' AND provider='groq' AND capability='LIVE_FREE_SYNTHESIS'").bind(failed.usageEventId,id).first();
  const approval=await env.DB.prepare("SELECT state,result_json FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-summary-synthesis-approval'").bind(failed.approvalId,id).first();
  if(failed.dispatched===true&&failed.responseComplete===true&&typeof failed.partialText==='string'&&failed.partialText.length&&failed.requestSha256===progress.next.requestSha256&&Number.isSafeInteger(failed.usage?.totalTokens)&&failed.usage.totalTokens>0&&failed.usage.totalTokens===usage?.used_units&&usage?.unit==='actual_total_tokens'&&approval?.state==='STOPPED'&&failed.approvalResultSha256===await sha(approval.result_json)){
   try{await persistedSynthesisNode({next:progress.next,response:failed.partialText,sourceSegments:source.segments,verifyGrounding:assertGrounding});recoveryCandidate={failedOperationId:unsettled.id,responseSha256:await sha(failed.partialText),usageTotalTokens:failed.usage.totalTokens,providerCalls:0};}catch{}
  }
 }
 const activeApproval=progress.complete?null:await synthesisApprovalStatus(env,id,context.sourceHash,progress.completed);
 const status={contract:'groq-full-coverage-global-v1',jobId:id,sourceHash:context.sourceHash,manifestSha256:context.manifest.manifestSha256,sourceSegments:context.manifest.segmentCount,sourceCoverageComplete:true,sectionReportsPreserved:true,globalSynthesisComplete:progress.complete,completedGlobalNodes:progress.completed,requiredGlobalNodes:context.quote.calls,quoteEstimate:context.quote,featureEnabled:env.ENABLE_FULL_COVERAGE==='true',freeKeyBindingVerified:Boolean(binding),activeApproval, nextNode:progress.next?.key??null,nextRequestSha256:progress.next?.requestSha256??null,unsettledState:unsettled?.state??null,recoveryCandidate,blockedCandidate:unsettled?.state==='BLOCKED'?{failedOperationId:unsettled.id,failedResultSha256:await sha(unsettled.resultJson),providerCalls:0}:null,automaticRetries:0,providerCalls:0};
 if(request.method==='GET')return respond(status);
 let body;try{body=await request.json();}catch{fail('GLOBAL_BAD_JSON');}
 if(!body||typeof body!=='object'||Array.isArray(body)||env.ENABLE_FULL_COVERAGE!=='true'||env.ALLOW_PAID_API==='true'||!binding)fail('GLOBAL_FREE_GUARD_REQUIRED');
 if(body.manifestSha256!==context.manifest.manifestSha256||body.sourceHash!==context.sourceHash)fail('GLOBAL_SCOPE_CHANGED');
 if(body.step==='recover-node'){
  if(!recoveryCandidate||body.failedOperationId!==recoveryCandidate.failedOperationId||body.responseSha256!==recoveryCandidate.responseSha256||body.usageTotalTokens!==recoveryCandidate.usageTotalTokens||body.confirmNoProviderCall!==true||body.confirmOriginalFailurePreserved!==true)fail('GLOBAL_RECOVERY_EVIDENCE_INVALID');
  const failed=unsettled.record,validated=await persistedSynthesisNode({next:progress.next,response:failed.partialText,sourceSegments:source.segments,verifyGrounding:assertGrounding});
  const approval=await env.DB.prepare("SELECT state,result_json FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-summary-synthesis-approval'").bind(failed.approvalId,id).first();
  const record={...validated,usage:failed.usage,usageEventId:failed.usageEventId,approvalId:failed.approvalId,approvalResultSha256:await sha(approval.result_json),contract:'full-coverage-global-response-recovery-v1',failedOperationId:unsettled.id,failedResultSha256:await sha(unsettled.resultJson),sourceHash:context.sourceHash,manifestSha256:context.manifest.manifestSha256,originalFailurePreserved:true,providerCalls:0};
  const recoveryId=id+':groq-summary-synthesis-recovery:'+context.sourceHash+':note:'+progress.next.key;
  const inserted=await env.DB.prepare("INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,j.id,'groq-summary-synthesis-recovery',0,'DONE',?,? FROM jobs j JOIN yta_sources s ON s.job_id=j.id JOIN yta_operations f ON f.job_id=j.id JOIN yta_operations a ON a.job_id=j.id JOIN usage_events u ON u.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND f.id=? AND f.provider='groq-summary-synthesis' AND f.state='FAILED_UNCERTAIN' AND f.result_json=? AND a.id=? AND a.provider='groq-summary-synthesis-approval' AND a.state='STOPPED' AND a.result_json=? AND u.id=? AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_SYNTHESIS' AND u.unit='actual_total_tokens' AND u.used_units=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.provider='deletion' AND d.state='DELETING')").bind(recoveryId,new Date().toISOString(),JSON.stringify(record),id,JSON.stringify(job.audit),source.raw,source.segments_json,unsettled.id,unsettled.resultJson,failed.approvalId,approval.result_json,failed.usageEventId,failed.usage.totalTokens,id+':deleting').run();
  if(inserted.meta?.changes!==1)fail('GLOBAL_RECOVERY_WRITE_UNCERTAIN');
  const readBack=await env.DB.prepare("SELECT state,result_json FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-summary-synthesis-recovery'").bind(recoveryId,id).first();
  if(readBack?.state!=='DONE'||readBack.result_json!==JSON.stringify(record))fail('GLOBAL_RECOVERY_WRITE_UNCERTAIN');
  return respond({recovered:true,node:progress.next.key,providerCalls:0,originalFailurePreserved:true});
 }
 if(body.step==='reopen-blocked'){
  const failed=unsettled?.record,active=await synthesisApprovalStatus(env,id,context.sourceHash,progress.completed);
  if(unsettled?.state!=='BLOCKED'||failed?.dispatched!==false||failed?.responseComplete!==false||failed?.usageEventId!==null||failed?.requestSha256!==progress.next?.requestSha256||!active||active.approvalId===failed.approvalId||body.approvalId!==active.approvalId||body.failedOperationId!==unsettled.id||body.failedResultSha256!==await sha(unsettled.resultJson)||body.confirmNoProviderCall!==true)fail('GLOBAL_BLOCKED_REOPEN_INVALID');
  const priorApproval=await env.DB.prepare("SELECT state,result_json FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-summary-synthesis-approval'").bind(failed.approvalId,id).first();
  if(priorApproval?.state!=='STOPPED'||failed.approvalResultSha256!==await sha(priorApproval.result_json))fail('GLOBAL_BLOCKED_REOPEN_INVALID');
  const newApproval=await env.DB.prepare("SELECT state,result_json FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-summary-synthesis-approval'").bind(active.approvalId,id).first();
  const usageIds=durable.rows.map(row=>JSON.parse(row.result_json).usageEventId).filter(value=>typeof value==='string');
  if(new Set(usageIds).size!==usageIds.length)fail('GLOBAL_BLOCKED_USAGE_SET_INVALID');
  const usageIdsJson=JSON.stringify(usageIds);
  const reviewId=unsettled.id+':blocked-review:'+active.approvalId,reviewJson=JSON.stringify({failedOperationId:unsettled.id,failedResultSha256:await sha(unsettled.resultJson),newApprovalId:active.approvalId,newApprovalSha256:await sha(newApproval.result_json),providerCalls:0});
  const inserted=await env.DB.prepare("INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,f.job_id,'groq-summary-synthesis-blocked-review',0,'REVIEWED',?,? FROM yta_operations f JOIN yta_operations a ON a.job_id=f.job_id JOIN yta_operations old ON old.job_id=f.job_id WHERE f.id=? AND f.job_id=? AND f.provider='groq-summary-synthesis' AND f.state='BLOCKED' AND f.result_json=? AND a.id=? AND a.provider='groq-summary-synthesis-approval' AND a.state='APPROVED' AND a.result_json=? AND old.id=? AND old.provider='groq-summary-synthesis-approval' AND old.state='STOPPED' AND old.result_json=? AND (SELECT COUNT(*) FROM usage_events u WHERE u.job_id=f.job_id AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_SYNTHESIS')=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM usage_events u WHERE u.job_id=f.job_id AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_SYNTHESIS' AND u.id NOT IN (SELECT value FROM json_each(?)))").bind(reviewId,new Date().toISOString(),reviewJson,unsettled.id,id,unsettled.resultJson,active.approvalId,newApproval.result_json,failed.approvalId,priorApproval.result_json,usageIdsJson,usageIdsJson).run();
  if(inserted.meta?.changes!==1)fail('GLOBAL_BLOCKED_REOPEN_UNCERTAIN');
  const reviewed=await env.DB.prepare("SELECT state,result_json FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-summary-synthesis-blocked-review'").bind(reviewId,id).first();
  if(reviewed?.state!=='REVIEWED'||reviewed.result_json!==reviewJson||active.expiresAt<=Date.now())fail('GLOBAL_BLOCKED_REOPEN_UNCERTAIN');
  const removed=await env.DB.prepare("DELETE FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-summary-synthesis' AND state='BLOCKED' AND result_json=? AND (SELECT COUNT(*) FROM usage_events u WHERE u.job_id=yta_operations.job_id AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_SYNTHESIS')=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM usage_events u WHERE u.job_id=yta_operations.job_id AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_SYNTHESIS' AND u.id NOT IN (SELECT value FROM json_each(?))) AND EXISTS(SELECT 1 FROM yta_operations a WHERE a.id=? AND a.job_id=? AND a.provider='groq-summary-synthesis-approval' AND a.state='APPROVED' AND a.result_json=?) AND EXISTS(SELECT 1 FROM yta_operations old WHERE old.id=? AND old.job_id=? AND old.provider='groq-summary-synthesis-approval' AND old.state='STOPPED' AND old.result_json=?)").bind(unsettled.id,id,unsettled.resultJson,usageIdsJson,usageIdsJson,active.approvalId,id,newApproval.result_json,failed.approvalId,id,priorApproval.result_json).run();
  if(removed.meta?.changes!==1)fail('GLOBAL_BLOCKED_REOPEN_UNCERTAIN');
  return respond({reopened:true,reviewId,providerCalls:0});
 }
 if(unsettled&&!['quote','approve'].includes(body.step))fail('GLOBAL_NODE_OUTCOME_REVIEW_REQUIRED');
 if(body.step==='finalize'){
  if(!progress.complete||unsettled||body.confirmNoProviderCall!==true)fail('GLOBAL_FINAL_NOT_READY');
  const sections=assembleFullCoverageReport({plan:current.plan,records:current.sections,segments:source.segments,raw:source.raw,legacyFailureEvidence:heldFailureEvidence});
  const report=await fullCoverageGlobalReport({context,progress,segments:source.segments,sections,semanticReview:body.semanticReview,sourceScope:job.audit?.fullCoverageFresh?.sourceScope??null});
  const synthesisProofs=durable.rows.map(row=>{
   const record=JSON.parse(row.result_json),saved=durable.savedNodes.get(record.key),recovery=durable.recoveryProofs.find(item=>item.failedId===row.id);
   if(!saved||!['DONE','FAILED_UNCERTAIN'].includes(row.state)||Boolean(recovery)!==(row.state==='FAILED_UNCERTAIN'))fail('GLOBAL_FINAL_NODE_CHANGED');
   return {id:row.id,resultJson:row.result_json,recovered:Boolean(recovery),receiptId:recovery?.id??row.id,receiptJson:recovery?.resultJson??row.result_json,usageEventId:saved.usageEventId,actualTotalTokens:saved.usage.totalTokens,usageProvenance:recovery?.usageProvenance??'PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN',approvalId:recovery?.approvalId??null,approvalJson:recovery?.approvalJson??null};
  });
  if(!await current.store.saveFinalReport({planSha256:current.plan.planSha256,sourceHash:current.plan.sourceHash,report,records:current.sections,synthesisProofs}))fail('GLOBAL_FINAL_CAS_FAILED');
  const readBack=await current.store.readFinalReport();if(!same(readBack,report))fail('GLOBAL_FINAL_READBACK_FAILED');
  return respond({saved:true,persisted:true,readBackVerified:true,compositionMode:report.compositionMode,sourceCoverage:report.sourceCoverage,providerCalls:0});
 }
 if(!['quote','approve','execute','cancel'].includes(body.step)||progress.complete)fail('GLOBAL_ACTION_NOT_READY');
 const assertSectionScope=async()=>{
  const freshBinding=await fullCoverageKeyBinding(env);
  if(!freshBinding||freshBinding.identity!==binding.identity||freshBinding.recordSha256!==binding.recordSha256)fail('GLOBAL_FREE_BINDING_EXPIRED_OR_CHANGED');
  if(!await current.store.verifySectionsSnapshot(current.sections))fail('GLOBAL_SECTION_SCOPE_CHANGED');
  if(freshBinding.expiresAt<=Date.now()||env.ALLOW_PAID_API==='true'||env.ENABLE_FULL_COVERAGE!=='true')fail('GLOBAL_FREE_BINDING_EXPIRED_OR_CHANGED');
 };
 const sourceContext=async(e,fresh,of)=>({...await (current.plan.mode==='FRESH_IMPORTED_TRANSCRIPT'?completeFreshTranscriptSource(e,fresh,of):completeSource(e,fresh,of)),transcriptHash:context.sourceHash});
 const mappedEnv={...env,ENABLE_COMPLETE_SYNTHESIS:env.ENABLE_FULL_COVERAGE};
 const recoveryProofs=durable.recoveryProofs.map(item=>({...item,auditJson:JSON.stringify(job.audit),sourceRaw:source.raw,segmentsJson:source.segments_json}));
 const result=await synthesisAction({body,env:mappedEnv,id,job,source,sourceHash:context.sourceHash,manifest:context.manifest,notes:context.notes,progress,failures:[{dispositionReviewed:true,evidence:heldFailureEvidence}],recoveredFailureIds:durable.recoveredFailureIds,recoveryProofs,ownedJob,sourceOf,completeSource:sourceContext,verifyGrounding:assertGrounding,assertSectionScope});
 return respond({...result,automaticContinuation:false});
}
