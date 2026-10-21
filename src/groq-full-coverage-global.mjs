import {assertGrounding} from './groq-summary.mjs';
import {evidenceNotes,synthesisTreeProgress,synthesisQuoteEstimate,completedSynthesisReport,persistedSynthesisNode,COMPLETE_SYNTHESIS_CONTRACT} from './groq-complete-synthesis.mjs';
import {assertFullSource,nextFullCoverageStage,validateLeafResponse} from './groq-full-coverage.mjs';

const fail=code=>{throw Error(code);};
const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value))))).map(x=>x.toString(16).padStart(2,'0')).join('');

// Builds a separate, immutable synthesis scope from every validated section.
// The appendix remains available, while the root is a new model response.
export async function fullCoverageGlobalContext({plan,records,segments,raw,boundarySegmentIds=[]}){
 assertFullSource(segments,raw);
 if(nextFullCoverageStage(plan,records).state!=='READY_TO_FINALIZE')fail('GLOBAL_SECTIONS_INCOMPLETE');
 if(!Array.isArray(boundarySegmentIds)||boundarySegmentIds.some(id=>!Number.isSafeInteger(id)||id<1||id>segments.length)||new Set(boundarySegmentIds).size!==boundarySegmentIds.length)fail('GLOBAL_BOUNDARY_INVALID');
 const stages=[],checkpoints=[];let nextId=1;
 for(const [index,stage] of plan.stages.entries()){
  if(stage.firstId!==nextId||stage.lastId<nextId)fail('GLOBAL_COVERAGE_INVALID');
  const group=segments.slice(stage.firstId-1,stage.lastId),report=stage.kind==='REUSED_LEGACY_CHECKPOINT'?stage.report:validateLeafResponse(stage,records.get(stage.key)?.response);
  if(!report)fail('GLOBAL_SECTION_MISSING');
  const ids=group.map(item=>item.id),reportSha256=await sha(report);
  stages.push({index,ids,boundarySegmentIds:ids.filter(id=>boundarySegmentIds.includes(id)),range:{firstId:stage.firstId,lastId:stage.lastId,startMs:group[0].startMs,endMs:group.at(-1).endMs},provenance:'AI_VALIDATED_RAW_CHECKPOINT',reportSha256});
  checkpoints.push({key:'raw:'+index,sourceHash:plan.sourceHash,provenance:'AI_VALIDATED_RAW_CHECKPOINT',report,reportSha256});
  nextId=stage.lastId+1;
 }
 if(nextId!==segments.length+1)fail('GLOBAL_COVERAGE_INVALID');
 const core={contract:COMPLETE_SYNTHESIS_CONTRACT,sourceHash:plan.sourceHash,auditSha256:plan.sourceAuditSha256,segmentCount:segments.length,rawStageCount:stages.length,missingSegmentIds:[],boundarySegmentIds:[...boundarySegmentIds].sort((a,b)=>a-b),synthesisFanout:4,maxNotesPerStage:2,stages};
 const manifest={...core,manifestSha256:await sha(core)},excerpts=Array(stages.length).fill(null);
 const notes=await evidenceNotes({manifest,checkpoints,excerpts});
 return {manifest,notes,checkpoints,excerpts,quote:synthesisQuoteEstimate(notes.length,4),sourceHash:plan.sourceHash};
}

export async function fullCoverageGlobalProgress({context,savedNodes,segments}){
 return synthesisTreeProgress({notes:context.notes,sourceSegments:segments,verifyGrounding:assertGrounding,savedNodes,fanout:4});
}

export async function readFullCoverageGlobalNodes(env,id,context,segments){
 const prefix=id+':groq-summary-complete:'+context.sourceHash+':note:';
 const rows=(await env.DB.prepare("SELECT id,state,result_json,units,error_code FROM yta_operations WHERE job_id=? AND provider='groq-summary-synthesis' AND substr(id,1,length(?))=?").bind(id,prefix,prefix).all()).results||[];
 const recoveryPrefix=id+':groq-summary-synthesis-recovery:'+context.sourceHash+':note:',recoveryRows=(await env.DB.prepare("SELECT id,state,result_json FROM yta_operations WHERE job_id=? AND provider='groq-summary-synthesis-recovery' AND substr(id,1,length(?))=?").bind(id,recoveryPrefix,recoveryPrefix).all()).results||[];
 const usageRows=(await env.DB.prepare("SELECT id,used_units,unit,provenance FROM usage_events WHERE job_id=? AND owner_id='owner' AND provider='groq' AND capability='LIVE_FREE_SYNTHESIS'").bind(id).all()).results||[],usageById=new Map(usageRows.map(row=>[row.id,row]));
 const savedNodes=new Map();let unsettled=null;
 const rowByKey=new Map();
 for(const row of rows){
  let saved;try{saved=JSON.parse(row.result_json);}catch{fail('GLOBAL_NODE_RECORD_INVALID');}
  if(row.id!==prefix+saved?.key||!Number.isSafeInteger(row.units)||row.units!==6600||rowByKey.has(saved.key))fail('GLOBAL_NODE_RECORD_INVALID');
  rowByKey.set(saved.key,{row,saved});
 }
 if(usageRows.some(row=>!rows.some(operation=>{let record;try{record=JSON.parse(operation.result_json);}catch{}return record?.usageEventId===row.id;})))fail('GLOBAL_ORPHAN_USAGE');
 const recoveredFailureIds=[],recoveryProofs=[],recoveryByKey=new Map();
 for(const recoveryRow of recoveryRows){
  let recovery;try{recovery=JSON.parse(recoveryRow.result_json);}catch{fail('GLOBAL_RECOVERY_INVALID');}
  if(recoveryRow.id!==recoveryPrefix+recovery?.key||recoveryByKey.has(recovery.key))fail('GLOBAL_RECOVERY_INVALID');
  recoveryByKey.set(recovery.key,{recoveryRow,recovery});
 }
 while(true){
  const next=await fullCoverageGlobalProgress({context,savedNodes,segments});
  if(next.complete)break;
  const key=next.next.key,direct=rowByKey.get(key),recovered=recoveryByKey.get(key);
  if(!direct)break;
  const {row:failed,saved:failedRecord}=direct;
  if(failed.state==='DONE'){
   if(recovered)fail('GLOBAL_RECOVERY_INVALID');
   const usage=usageById.get(failedRecord.usageEventId);
   if(!failedRecord.response||!failedRecord.responseSha256||!failedRecord.nodeSha256||failedRecord.usage?.totalTokens!==usage?.used_units||usage?.unit!=='actual_total_tokens'||usage?.provenance!=='PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN'||failedRecord.usage.totalTokens>failed.units)fail('GLOBAL_NODE_USAGE_INVALID');
   savedNodes.set(key,failedRecord);continue;
  }
  const failedId=failed.id;
  if(!recovered){unsettled={id:failedId,state:failed.state,errorCode:failed.error_code??null,resultJson:failed.result_json,record:failedRecord};break;}
  const {recoveryRow,recovery}=recovered;
  const usage=usageById.get(recovery?.usageEventId),approval=await env.DB.prepare("SELECT state,result_json FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-summary-synthesis-approval'").bind(recovery?.approvalId,id).first();
  if(recoveryRow.state!=='DONE'||recovery.contract!=='full-coverage-global-response-recovery-v1'||failed.state!=='FAILED_UNCERTAIN'||recovery.failedOperationId!==failedId||recovery.failedResultSha256!==await sha(failed.result_json)||recovery.sourceHash!==context.sourceHash||recovery.manifestSha256!==context.manifest.manifestSha256||recovery.originalFailurePreserved!==true||recovery.providerCalls!==0||approval?.state!=='STOPPED'||recovery.approvalResultSha256!==await sha(approval.result_json)||usage?.used_units!==recovery.usage?.totalTokens||usage?.unit!=='actual_total_tokens'||!['PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN','PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN'].includes(usage?.provenance))fail('GLOBAL_RECOVERY_INVALID');
  const expected=await persistedSynthesisNode({next:next.next,response:recovery.response,sourceSegments:segments,verifyGrounding:assertGrounding});
  if(recovery.requestSha256!==expected.requestSha256||recovery.responseSha256!==expected.responseSha256||recovery.nodeSha256!==expected.nodeSha256)fail('GLOBAL_RECOVERY_INVALID');
  savedNodes.set(key,recovery);recoveredFailureIds.push(failedId);
  recoveryProofs.push({id:recoveryRow.id,jobId:id,resultJson:recoveryRow.result_json,failedId,failedJson:failed.result_json,usageId:recovery.usageEventId,usageProvenance:usage.provenance,usageTokens:usage.used_units,approvalId:recovery.approvalId,approvalJson:approval.result_json});
 }
 const progress=await fullCoverageGlobalProgress({context,savedNodes,segments});
 if(rows.length!==savedNodes.size+(unsettled?1:0)||recoveryRows.length!==recoveryProofs.length)fail('GLOBAL_NODE_ORDER_INVALID');
 return {progress,unsettled,savedNodes,rows,recoveredFailureIds,recoveryProofs};
}

export async function fullCoverageGlobalReport({context,progress,segments,sections,semanticReview}){
 if(!progress.complete)fail('GLOBAL_TREE_INCOMPLETE');
 const report=await completedSynthesisReport({manifest:context.manifest,notes:context.notes,root:progress.root,checkpoints:context.checkpoints,excerpts:context.excerpts,segments,verifyGrounding:assertGrounding,semanticReview});
 const {reportSha256:baseReportSha256,...base}=report;
 const final={...base,baseReportSha256,compositionMode:'groq-full-coverage-global-v1',globalSynthesisStatus:'MODEL_ROOT_VALIDATED_HUMAN_UNREVIEWED',sectionReports:sections,sourceCoverage:{segmentCount:segments.length,firstId:1,lastId:segments.length,missingSegmentIds:[]}};
 return {...final,reportSha256:await sha(final)};
}
