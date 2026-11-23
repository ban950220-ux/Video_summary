// Offline specification checker. This file is not imported by a Worker, route,
// provider, database adapter or deployment script. Supplied evidence is untrusted.
import {createHash} from 'node:crypto';
import {videoIdOf} from '../src/core.mjs';

// All fixture identity, counts, durations and text sizes are invented test data.
export const EXAMPLE_ACCEPTANCE_REFERENCE = Object.freeze({
  videoId:'synthetic01', segmentCount:120, chapterCount:12, chunkCount:12,
  audioDurationMs:600000, lastStoredSegmentEndMs:599500,
  referenceId:'SYNTHETIC_FULL_TRANSCRIPT_SUMMARY_V1',
  summaryUtf8Bytes:4096,
  provenance:'SYNTHETIC_ASSISTANT_SUMMARY_REFERENCE',
  independentlyVerifiedAudio:false,
});

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const stringsEqual=(left,right)=>text(left)&&left===right;
const hashEqual=(left,right)=>hex(left)&&left===right;
const orderedIds=(values,count)=>Array.isArray(values)&&values.length===count&&values.every((id,index)=>id===index+1);
const allIndices=(values,count)=>Array.isArray(values)&&values.length===count&&values.every((id,index)=>id===index);
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(Date.parse(value)).toISOString()===value;

function parseEvidenceJson(json){
  // Never introspect or stringify a caller's object. That could run accessors,
  // Proxy traps or toJSON. Only primitive JSON text crosses this API boundary.
  if(typeof json!=='string'||json.length>8_000_000)return {ok:false};
  try{
    const value=JSON.parse(json),pending=[value];
    while(pending.length){
      const item=pending.pop();
      if(typeof item==='number'&&!Number.isFinite(item))return {ok:false};
      if(item!==null&&typeof item==='object')for(const child of Object.values(item))pending.push(child);
    }
    return {ok:true,value};
  }catch{return {ok:false};}
}
function jsonDigest(value){
  return createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');
}
export function evidenceDigest(json){
  const parsed=parseEvidenceJson(json);if(!parsed.ok)return null;
  try{return jsonDigest(parsed.value);}catch{return null;}
}

export const QUALITY_RUBRIC = Object.freeze([
  'allChaptersAndDistinctClaims','causalityAndNegation','numbersUnitsAndTimeHorizons',
  'speakerAndForecastAttribution','uncertaintyAndTranscriptLimits',
  'noUnsupportedFacts','coherentWholeVideoConclusion',
]);

function stage(name,checks){
  const blockedBy=checks.filter(([,ok])=>!ok).map(([code])=>code);
  return {name,structureSatisfied:blockedBy.length===0,blockedBy};
}

/**
 * Examine one caller-supplied capture against the example acceptance contract.
 * A structurally complete capture is NOT authenticated operational evidence.
 * Neither true flags nor copied provider receipts can turn automaticCompletion on.
 */
export function assessExamplePipelineEvidence(json){
  const parsed=parseEvidenceJson(json);
  if(parsed.ok&&record(parsed.value))try{return assessEvidenceData(parsed.value);}catch{/* Fixed diagnostics only. */}
  const result=assessEvidenceData({});
  result.stages[0].blockedBy.unshift('EVIDENCE_JSON_INVALID');
  return result;
}
function assessEvidenceData(input){
  const c=record(input)?input:{};
  const l=record(c.link)?c.link:{},s=record(c.source)?c.source:{};
  const t=record(c.transcript)?c.transcript:{},m=record(c.merged)?c.merged:{};
  const r=record(c.summary)?c.summary:{},p=record(c.saved)?c.saved:{};
  const segments=Array.isArray(t.segments)?t.segments:[];
  const chunks=Array.isArray(t.chunks)?t.chunks:[];
  const chapters=Array.isArray(r.chapters)?r.chapters:[];
  const ref=EXAMPLE_ACCEPTANCE_REFERENCE;
  let videoId=null;
  try{videoId=videoIdOf(l.url);}catch{/* Fixed diagnostic only; no input echo. */}
  const segmentIds=segments.map(segment=>segment?.id);
  const validSegments=segments.length===ref.segmentCount&&orderedIds(segmentIds,ref.segmentCount)&&segments.every((segment,index)=>
    record(segment)&&text(segment.text)&&Number.isSafeInteger(segment.startMs)&&Number.isSafeInteger(segment.endMs)&&
    segment.startMs>=0&&segment.endMs>segment.startMs&&segment.endMs<=s.durationMs&&
    (!index||segment.startMs>=segments[index-1].startMs));
  const transcriptSha256=validSegments?jsonDigest(segments):null;
  const validChunks=t.expectedChunkCount===ref.chunkCount&&allIndices(chunks.map(chunk=>chunk?.index),t.expectedChunkCount)&&chunks.every(chunk=>
    chunk.state==='SAVED'&&chunk.responseComplete===true&&hashEqual(chunk.sourceSha256,s.sha256)&&hex(chunk.outputSha256));
  const q=record(r.qualityReview)?r.qualityReview:{};
  const reportPayload={language:r.language,overview:r.overview,chapters:r.chapters,conclusion:r.conclusion};
  const reportSha256=jsonDigest(reportPayload);
  let nextId=1;
  const validChapters=chapters.length===ref.chapterCount&&chapters.every(chapter=>{
    if(!record(chapter)||chapter.firstSegmentId!==nextId||!positive(chapter.lastSegmentId)||chapter.lastSegmentId<nextId||chapter.lastSegmentId>ref.segmentCount||!text(chapter.text)||!Array.isArray(chapter.evidenceIds)||!chapter.evidenceIds.length||new Set(chapter.evidenceIds).size!==chapter.evidenceIds.length||chapter.evidenceIds.some(id=>!Number.isInteger(id)||id<chapter.firstSegmentId||id>chapter.lastSegmentId))return false;
    nextId=chapter.lastSegmentId+1;return true;
  })&&nextId===ref.segmentCount+1;
  const qualityMatches=q.kind==='FULL_TRANSCRIPT_SEMANTIC_REVIEW'&&q.verdict==='PASS'&&text(q.reviewerId)&&iso(q.reviewedAt)&&
    hex(q.reviewRecordSha256)&&hashEqual(q.reportSha256,r.sha256)&&hashEqual(q.transcriptSha256,t.sha256)&&
    q.referenceId===ref.referenceId&&orderedIds(q.reviewedSegmentIds,ref.segmentCount)&&
    QUALITY_RUBRIC.every(key=>q.rubric?.[key]?.verdict==='PASS'&&text(q.rubric[key].note));
  const audioQa=record(t.audioReview)?t.audioReview:{};
  const audioReviewMatches=audioQa.kind==='SOURCE_AUDIO_REVIEW'&&audioQa.verdict==='PASS'&&text(audioQa.reviewerId)&&
    hex(audioQa.reviewRecordSha256)&&hashEqual(audioQa.sourceSha256,s.sha256)&&hashEqual(audioQa.transcriptSha256,t.sha256)&&
    audioQa.fullRangeReviewed===true&&audioQa.unresolvedOmissions===0&&audioQa.unresolvedBoundaryAmbiguities===0;
  const stages=[
    stage('link',[
      ['CAPTURE_KIND_INVALID',c.kind==='OFFLINE_PIPELINE_EVIDENCE_V1'],
      ['VIDEO_ID_MISMATCH',videoId===ref.videoId&&l.videoId===videoId],
      ['JOB_BINDING_MISSING',text(l.jobId)],
    ]),
    stage('source',[
      ['SOURCE_IDENTITY_MISMATCH',s.videoId===videoId&&stringsEqual(s.jobId,l.jobId)&&hex(s.sha256)],
      ['LINK_SOURCE_ACQUISITION_UNPROVEN',s.acquisition==='AUTOMATIC_FROM_LINK'&&s.authorizedSource===true],
      ['COMPLETE_AUDIO_UNPROVEN',s.mediaKind==='AUDIO'&&s.completeAudio===true&&s.durationMs===ref.audioDurationMs],
    ]),
    stage('transcript',[
      ['TRANSCRIPT_SOURCE_CHANGED',hashEqual(t.sourceSha256,s.sha256)],
      ['TRANSCRIPT_SEGMENTS_INCOMPLETE',validSegments],
      ['TRANSCRIPT_HASH_MISMATCH',hashEqual(t.sha256,transcriptSha256)],
      ['TRANSCRIPT_TAIL_MISMATCH',segments.at(-1)?.endMs===ref.lastStoredSegmentEndMs],
      ['CHUNKS_MISSING_DUPLICATE_OR_UNSAVED',validChunks],
      ['AUDIO_ACCURACY_UNVERIFIED',audioReviewMatches],
    ]),
    stage('merged',[
      ['MERGE_SOURCE_CHANGED',hashEqual(m.sourceSha256,s.sha256)&&hashEqual(m.transcriptSha256,t.sha256)],
      ['MERGE_CHUNKS_INCOMPLETE',positive(t.expectedChunkCount)&&allIndices(m.inputChunkIndices,t.expectedChunkCount)&&Array.isArray(m.missingChunks)&&m.missingChunks.length===0],
      ['MERGE_TEXT_CHANGED',validSegments&&m.raw===segments.map(segment=>segment.text).join('\n')],
      ['MERGE_HASH_MISMATCH',hashEqual(m.sha256,jsonDigest({raw:m.raw,transcriptSha256:m.transcriptSha256,inputChunkIndices:m.inputChunkIndices}))],
      ['MERGE_BOUNDARY_REVIEW_MISSING',m.boundaryReview==='REVIEWED_NO_UNRESOLVED_AMBIGUITY'],
    ]),
    stage('summary',[
      ['SUMMARY_NOT_AUTOMATIC',r.provenance==='PIPELINE_PROVIDER_GENERATED'&&r.generationPath==='AUTOMATIC_PIPELINE'],
      ['SUMMARY_SOURCE_CHANGED',hashEqual(r.sourceSha256,s.sha256)&&hashEqual(r.transcriptSha256,t.sha256)&&hashEqual(r.mergedSha256,m.sha256)],
      ['SUMMARY_SCHEMA_INVALID',r.language==='ko'&&text(r.overview)&&text(r.conclusion)&&validChapters],
      ['SUMMARY_HASH_MISMATCH',hashEqual(r.sha256,reportSha256)],
      ['SUMMARY_OPERATION_UNPROVEN',text(r.operationId)&&r.responseComplete===true&&hex(r.providerResponseSha256)&&r.operationState==='SAVED'],
      ['SEMANTIC_QUALITY_REVIEW_MISSING',qualityMatches],
      ['SUMMARY_SCOPE_OR_LIMITS_MISREPRESENTED',r.externalFactCheck==='NOT_PERFORMED'&&r.scope==='FULL_STORED_TRANSCRIPT'],
    ]),
    stage('saved',[
      ['SAVED_JOB_OR_REPORT_MISMATCH',stringsEqual(p.jobId,l.jobId)&&hashEqual(p.summarySha256,r.sha256)&&hashEqual(p.transcriptSha256,t.sha256)],
      ['SAVE_READBACK_MISSING',p.durableReadbackConfirmed===true&&(p.writeAcknowledged===true||p.writeOutcome==='CONFIRMED_BY_READBACK')],
      ['FRESH_LOGIN_LIST_REOPEN_MISSING',p.ownerLoginFresh===true&&p.listContainsJob===true&&p.reopenedAfterReload===true&&hashEqual(p.reopenedSummarySha256,r.sha256)],
      ['TXT_EXPORT_MISMATCH',p.exportContainsCompleteSummary===true&&p.exportContainsCompleteTranscript===true&&hashEqual(p.exportSummarySha256,r.sha256)&&hashEqual(p.exportTranscriptSha256,t.sha256)],
      ['ORIGINAL_EVIDENCE_NOT_PRESERVED',p.originalTranscriptUnchanged===true&&p.originalOperationsUnchanged===true&&p.originalUsageAndReceiptsUnchanged===true],
      ['COST_OR_OPERATION_RECONCILIATION_MISSING',p.unresolvedOperationCount===0&&p.duplicateDispatchCount===0&&p.receiptClassificationPreserved===true],
    ]),
  ];
  const structuralCriteriaSatisfied=stages.every(item=>item.structureSatisfied);
  return {
    kind:'OFFLINE_PIPELINE_ACCEPTANCE_RESULT_V1',mode:'OFFLINE_SPECIFICATION_ONLY',
    structuralCriteriaSatisfied,
    verdict:structuralCriteriaSatisfied?'STRUCTURE_ONLY_REQUIRES_OPERATIONAL_VERIFICATION':'BLOCKED',
    stages,provenanceAuthenticated:false,automaticCompletion:false,
    productionExecutionSupported:false,providerCalls:0,databaseWrites:0,
    runtimeVerificationRequired:['AUTHENTICATED_SOURCE_AND_OPERATION_CAPTURE','INDEPENDENT_AUDIO_AND_SEMANTIC_REVIEW','REAL_OWNER_LIST_REOPEN_AND_EXPORT','COST_AND_UNCERTAINTY_RECONCILIATION'],
  };
}

const RESUME_STAGES=new Set(['source','transcript','merged','summary','saved']);
const UNCERTAIN=new Set(['CLAIMED','RESERVED','DISPATCHING','PENDING','RUNNING','FAILED_UNCERTAIN','UNCERTAIN']);
const SCOPE_KEYS=['jobId','stage','unitKey','sourceIdentitySha256','sourceSha256','transcriptSha256','requestSha256','model','contractVersion'];
function scopeDigestData(scope){
  if(!record(scope)||!RESUME_STAGES.has(scope.stage)||!['jobId','unitKey','model','contractVersion'].every(key=>text(scope[key]))||!['sourceIdentitySha256','requestSha256'].every(key=>hex(scope[key])))return null;
  if(scope.stage==='source'?scope.sourceSha256!==null:!hex(scope.sourceSha256))return null;
  if(['source','transcript'].includes(scope.stage)?scope.transcriptSha256!==null:!hex(scope.transcriptSha256))return null;
  return jsonDigest(Object.fromEntries(SCOPE_KEYS.map(key=>[key,scope[key]])));
}
export function operationScopeDigest(json){
  const parsed=parseEvidenceJson(json);if(!parsed.ok)return null;
  try{return scopeDigestData(parsed.value);}catch{return null;}
}

/** Decide what may be reviewed next. It never dispatches, releases a budget,
 * changes a failed row, writes a receipt, or authorizes production execution. */
export function reviewOfflineResumePolicy(json){
  const parsed=parseEvidenceJson(json);
  if(parsed.ok&&record(parsed.value))try{return reviewResumeData(parsed.value);}catch{/* Fixed diagnostics only. */}
  return {...reviewResumeData({}),reason:'EVIDENCE_JSON_INVALID'};
}
function reviewResumeData({scope,checkpoint=null,operation=null,approval=null,now,expectedMicroUsd=0}){
  const base={mode:'OFFLINE_SPECIFICATION_ONLY',provenanceAuthenticated:false,productionExecutionSupported:false,automaticCompletion:false,dispatchAllowed:false,providerCalls:0,databaseWrites:0,automaticRetries:0,originalHistoryPreserved:true};
  const out=(nextStep,reason)=>({...base,nextStep,reason});
  const scopeSha256=scopeDigestData(scope);
  if(!scopeSha256||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(expectedMicroUsd)||expectedMicroUsd<0)return out('BLOCKED','INVALID_SCOPE');
  if(operation!==null&&operation!==undefined&&!record(operation))return out('BLOCKED','INVALID_OPERATION_RECORD');
  if(checkpoint!==null&&checkpoint!==undefined&&!record(checkpoint))return out('BLOCKED','INVALID_CHECKPOINT_RECORD');
  if(operation&&(!record(operation)||!hashEqual(operation.scopeSha256,scopeSha256)))return out('BLOCKED','OPERATION_SCOPE_CHANGED');
  if(checkpoint&&(!record(checkpoint)||!hashEqual(checkpoint.scopeSha256,scopeSha256)||!hex(checkpoint.payloadSha256)))return out('BLOCKED','CHECKPOINT_SCOPE_CHANGED');
  if(operation&&UNCERTAIN.has(operation.state)){
    if(operation.responseComplete===true&&operation.responseValidated===true&&hex(operation.responseSha256))return out('REVIEW_COMPLETE_STORED_RESPONSE','PRESERVE_FAILURE_AND_COST_NO_NEW_CALL');
    return out('READ_ONLY_RECONCILIATION_REQUIRED','DISPATCH_OUTCOME_UNCERTAIN');
  }
  if(checkpoint?.state==='SAVED'&&checkpoint.contentReadbackMatches===true&&operation?.state==='DONE'){
    if(operation.responseComplete!==true||operation.responseValidated!==true||!hashEqual(operation.responseSha256,checkpoint.sourceResponseSha256))return out('BLOCKED','CHECKPOINT_RESPONSE_BINDING_REQUIRED');
    return out('REUSE_VERIFIED_CHECKPOINT','EXACT_SCOPE_RESPONSE_AND_SAVED_CONTENT_MATCH');
  }
  if(checkpoint)return out('BLOCKED','CHECKPOINT_READBACK_REQUIRED');
  if(operation?.state==='DONE')return out('READ_ONLY_RECONCILIATION_REQUIRED','COMPLETED_OPERATION_MISSING_CHECKPOINT');
  if(operation?.state==='PROVEN_NOT_SENT'&&(
    Object.hasOwn(operation,'responseSha256')||
    ['responseComplete','responseValidated'].some(key=>Object.hasOwn(operation,key)&&operation[key]!==false)
  ))return out('BLOCKED','CONTRADICTORY_NOT_SENT_EVIDENCE');
  if(operation&&!(operation.state==='PROVEN_NOT_SENT'&&operation.dispatchCount===0&&operation.notSentEvidenceVerified===true))return out('BLOCKED','PRIOR_OPERATION_REQUIRES_REVIEW');
  if(scope.stage==='merged'||scope.stage==='saved')return out('REVIEW_LOCAL_STEP_ONLY','REUSE_INPUT_NO_PROVIDER_REQUEST');
  if(!record(approval)||!hashEqual(approval.scopeSha256,scopeSha256)||approval.state!=='APPROVED'||!Number.isSafeInteger(approval.expiresAt)||approval.expiresAt<=now)return out('BLOCKED','APPROVAL_MISSING_EXPIRED_CONSUMED_OR_CHANGED');
  if(!positive(approval.remainingCalls)||approval.automaticRetries!==0)return out('BLOCKED','CALL_LIMIT_OR_AUTOMATIC_RETRY_BLOCKED');
  if(expectedMicroUsd>0){
    if(approval.kind!=='PAID_EXACT_SCOPE'||approval.explicitOwnerApproval!==true||!Number.isSafeInteger(approval.remainingMicroUsd)||approval.remainingMicroUsd<expectedMicroUsd)return out('BLOCKED','PAID_CAP_OR_APPROVAL_REQUIRED');
  }else if(approval.kind!=='FREE_EXACT_SCOPE'||approval.billingDisabledConfirmed!==true||approval.freeQuotaObservedSufficient!==true)return out('BLOCKED','FREE_CAPACITY_UNVERIFIED');
  return out('REVIEW_SINGLE_DISPATCH_PLAN','FRESH_EXACT_SCOPE_REQUIRED_AT_ATOMIC_CLAIM');
}
