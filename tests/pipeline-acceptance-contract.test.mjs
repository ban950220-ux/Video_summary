import test from 'node:test';
import assert from 'node:assert/strict';
import {transcriptAudit} from '../src/core.mjs';
import {EXAMPLE_ACCEPTANCE_REFERENCE as REF,QUALITY_RUBRIC,evidenceDigest as digestJson,assessExamplePipelineEvidence as assessJson,operationScopeDigest as scopeDigestJson,reviewOfflineResumePolicy as resumeJson} from '../scripts/pipeline-acceptance-contract.mjs';

// Synthetic metadata/text only. No user transcript, reference-summary body,
// real provider receipt, production database or paid/network call is used.
const hash=letter=>letter.repeat(64),stamp='2030-01-01T00:00:00.000Z';
const evidenceDigest=value=>digestJson(JSON.stringify(value));
const assessExamplePipelineEvidence=value=>assessJson(JSON.stringify(value));
const operationScopeDigest=value=>scopeDigestJson(JSON.stringify(value));
const reviewOfflineResumePolicy=value=>resumeJson(JSON.stringify(value));
function capture(){
  const sourceSha256=hash('a');
  const segments=Array.from({length:REF.segmentCount},(_,index)=>({id:index+1,startMs:Math.floor(index*REF.lastStoredSegmentEndMs/REF.segmentCount),endMs:Math.floor((index+1)*REF.lastStoredSegmentEndMs/REF.segmentCount),text:`Synthetic statement ${index+1}.`}));
  const transcriptSha256=evidenceDigest(segments);
  const chunks=Array.from({length:REF.chunkCount},(_,index)=>({index,state:'SAVED',responseComplete:true,sourceSha256,outputSha256:evidenceDigest({syntheticChunk:index})}));
  const merged={sourceSha256,transcriptSha256,raw:segments.map(segment=>segment.text).join('\n'),inputChunkIndices:chunks.map(chunk=>chunk.index),missingChunks:[],boundaryReview:'REVIEWED_NO_UNRESOLVED_AMBIGUITY'};
  merged.sha256=evidenceDigest({raw:merged.raw,transcriptSha256,inputChunkIndices:merged.inputChunkIndices});
  const chapters=Array.from({length:REF.chapterCount},(_,index)=>{
    const firstSegmentId=Math.floor(index*REF.segmentCount/REF.chapterCount)+1,lastSegmentId=Math.floor((index+1)*REF.segmentCount/REF.chapterCount);
    return {firstSegmentId,lastSegmentId,evidenceIds:[firstSegmentId,lastSegmentId],text:`Synthetic chapter ${index+1}; this describes no real video.`};
  });
  const summary={provenance:'PIPELINE_PROVIDER_GENERATED',generationPath:'AUTOMATIC_PIPELINE',language:'ko',overview:'Synthetic overview.',conclusion:'Synthetic conclusion with limitations.',chapters,sourceSha256,transcriptSha256,mergedSha256:merged.sha256,operationId:'synthetic-operation',operationState:'SAVED',responseComplete:true,providerResponseSha256:hash('b'),externalFactCheck:'NOT_PERFORMED',scope:'FULL_STORED_TRANSCRIPT'};
  summary.sha256=evidenceDigest({language:summary.language,overview:summary.overview,chapters:summary.chapters,conclusion:summary.conclusion});
  summary.qualityReview={kind:'FULL_TRANSCRIPT_SEMANTIC_REVIEW',verdict:'PASS',reviewerId:'synthetic-reviewer',reviewedAt:stamp,reviewRecordSha256:hash('c'),reportSha256:summary.sha256,transcriptSha256,referenceId:REF.referenceId,reviewedSegmentIds:segments.map(segment=>segment.id),rubric:Object.fromEntries(QUALITY_RUBRIC.map(key=>[key,{verdict:'PASS',note:'Synthetic review note; not production verification.'}]))};
  return {
    kind:'OFFLINE_PIPELINE_EVIDENCE_V1',link:{url:'https://youtu.be/synthetic01',videoId:REF.videoId,jobId:'synthetic-job'},
    source:{videoId:REF.videoId,jobId:'synthetic-job',sha256:sourceSha256,acquisition:'AUTOMATIC_FROM_LINK',authorizedSource:true,mediaKind:'AUDIO',completeAudio:true,durationMs:REF.audioDurationMs},
    transcript:{sourceSha256,sha256:transcriptSha256,expectedChunkCount:REF.chunkCount,chunks,segments,audioReview:{kind:'SOURCE_AUDIO_REVIEW',verdict:'PASS',reviewerId:'synthetic-audio-reviewer',reviewRecordSha256:hash('d'),sourceSha256,transcriptSha256,fullRangeReviewed:true,unresolvedOmissions:0,unresolvedBoundaryAmbiguities:0}},
    merged,summary,
    saved:{jobId:'synthetic-job',summarySha256:summary.sha256,transcriptSha256,writeAcknowledged:true,durableReadbackConfirmed:true,ownerLoginFresh:true,listContainsJob:true,reopenedAfterReload:true,reopenedSummarySha256:summary.sha256,exportContainsCompleteSummary:true,exportContainsCompleteTranscript:true,exportSummarySha256:summary.sha256,exportTranscriptSha256:transcriptSha256,originalTranscriptUnchanged:true,originalOperationsUnchanged:true,originalUsageAndReceiptsUnchanged:true,unresolvedOperationCount:0,duplicateDispatchCount:0,receiptClassificationPreserved:true},
  };
}
const reasons=result=>result.stages.flatMap(stage=>stage.blockedBy);
function blockedBy(change,code){const c=capture();change(c);const result=assessExamplePipelineEvidence(c);assert.equal(result.structuralCriteriaSatisfied,false);assert.ok(reasons(result).includes(code),JSON.stringify(reasons(result)));assert.equal(result.automaticCompletion,false);}

test('all six fixture stages can satisfy the specification without claiming real completion',()=>{
  const result=assessExamplePipelineEvidence(capture());
  assert.equal(result.structuralCriteriaSatisfied,true);
  assert.equal(result.verdict,'STRUCTURE_ONLY_REQUIRES_OPERATIONAL_VERIFICATION');
  assert.deepEqual(result.stages.map(stage=>stage.name),['link','source','transcript','merged','summary','saved']);
  assert.equal(result.provenanceAuthenticated,false);assert.equal(result.productionExecutionSupported,false);assert.equal(result.automaticCompletion,false);
  assert.equal(result.providerCalls,0);assert.equal(result.databaseWrites,0);
});
test('caller completion/authentication flags cannot manufacture operational evidence',()=>{
  const c=capture();Object.assign(c,{automaticCompletion:true,provenanceAuthenticated:true,productionExecutionSupported:true});
  const result=assessExamplePipelineEvidence(c);
  assert.equal(result.automaticCompletion,false);assert.equal(result.provenanceAuthenticated,false);assert.equal(result.productionExecutionSupported,false);
});
test('a lost save acknowledgement may be reconciled by exact durable readback without another generation',()=>{
  const c=capture();c.saved.writeAcknowledged=false;c.saved.writeOutcome='CONFIRMED_BY_READBACK';
  const result=assessExamplePipelineEvidence(c);
  assert.equal(result.stages.find(stage=>stage.name==='saved').structureSatisfied,true);
  assert.equal(result.providerCalls,0);assert.equal(result.automaticCompletion,false);
});
test('empty and missing captures fail closed without returning supplied content',()=>{
  for(const value of [undefined,null,{},[],{summary:{secret:'must-not-be-echoed'}}]){
    const result=assessExamplePipelineEvidence(value);assert.equal(result.structuralCriteriaSatisfied,false);assert.equal(JSON.stringify(result).includes('must-not-be-echoed'),false);
  }
});
test('public APIs accept JSON text only and do not execute object getters, toJSON, cycles or Proxy traps',()=>{
  let executed=0;
  const accessor={};Object.defineProperty(accessor,'summary',{enumerable:true,get(){executed++;throw Error('private-getter-output');}});
  const withToJSON={toJSON(){executed++;throw Error('private-toJSON-output');}};
  const cycle={};cycle.self=cycle;
  const proxy=new Proxy({},{get(){executed++;throw Error('private-proxy-output');},ownKeys(){executed++;throw Error('private-proxy-output');}});
  const revoked=Proxy.revocable({},{});revoked.revoke();
  for(const value of [accessor,withToJSON,cycle,proxy,revoked.proxy,1n]){
    const result=assessJson(value);
    assert.equal(result.verdict,'BLOCKED');assert.ok(reasons(result).includes('EVIDENCE_JSON_INVALID'));
    assert.equal(resumeJson(value).reason,'EVIDENCE_JSON_INVALID');
    assert.equal(digestJson(value),null);assert.equal(scopeDigestJson(value),null);
    assert.equal(JSON.stringify(result).includes('private-'),false);
  }
  assert.equal(executed,0);
});
test('malformed JSON, excessive-size text and non-finite JSON numbers fail with fixed diagnostics',()=>{
  for(const value of ['{"private":"raw-secret"','{"amount":1e400}',' '.repeat(8_000_001)]){
    assert.ok(reasons(assessJson(value)).includes('EVIDENCE_JSON_INVALID'));
    assert.equal(resumeJson(value).reason,'EVIDENCE_JSON_INVALID');assert.equal(digestJson(value),null);
    assert.equal(JSON.stringify(assessJson(value)).includes('raw-secret'),false);
  }
});
for(const provenance of ['MANUAL_IMPORTED','ASSISTANT_AUTHORED_IMPORTED_SUMMARY','EXTRACTIVE_ONLY_NOT_AI'])test(`${provenance} cannot satisfy automatic summary completion`,()=>blockedBy(c=>{c.summary.provenance=provenance;},'SUMMARY_NOT_AUTOMATIC'));
for(const [name,change,code] of [
  ['another video',c=>{c.link.url='https://youtu.be/AAAAAAAAAAA';},'VIDEO_ID_MISMATCH'],
  ['untrusted host',c=>{c.link.url='https://youtube.com.evil.test/watch?v=synthetic01';},'VIDEO_ID_MISMATCH'],
  ['manual source acquisition',c=>{c.source.acquisition='USER_MP3_UPLOAD';},'LINK_SOURCE_ACQUISITION_UNPROVEN'],
  ['native captions only',c=>{c.source.mediaKind='CAPTIONS';},'COMPLETE_AUDIO_UNPROVEN'],
  ['changed source',c=>{c.source.sha256=hash('f');},'TRANSCRIPT_SOURCE_CHANGED'],
  ['missing transcript cue',c=>{c.transcript.segments.splice(Math.floor(REF.segmentCount/2),1);},'TRANSCRIPT_SEGMENTS_INCOMPLETE'],
  ['duplicate transcript cue',c=>{c.transcript.segments[Math.floor(REF.segmentCount/2)].id=Math.floor(REF.segmentCount/2);},'TRANSCRIPT_SEGMENTS_INCOMPLETE'],
  ['changed transcript text',c=>{c.transcript.segments[Math.floor(REF.segmentCount/2)].text='Changed after review.';},'TRANSCRIPT_HASH_MISMATCH'],
  ['missing chunk',c=>{c.transcript.chunks.splice(9,1);},'CHUNKS_MISSING_DUPLICATE_OR_UNSAVED'],
  ['shrunk expected chunk manifest',c=>{c.transcript.chunks=c.transcript.chunks.slice(0,1);c.transcript.expectedChunkCount=1;},'CHUNKS_MISSING_DUPLICATE_OR_UNSAVED'],
  ['duplicate chunk',c=>{c.transcript.chunks[9].index=8;},'CHUNKS_MISSING_DUPLICATE_OR_UNSAVED'],
  ['uncertain chunk',c=>{c.transcript.chunks[9].state='FAILED_UNCERTAIN';},'CHUNKS_MISSING_DUPLICATE_OR_UNSAVED'],
  ['truncated chunk response',c=>{c.transcript.chunks[9].responseComplete=false;},'CHUNKS_MISSING_DUPLICATE_OR_UNSAVED'],
  ['missing merge input',c=>{c.merged.inputChunkIndices.pop();},'MERGE_CHUNKS_INCOMPLETE'],
  ['merge text loss',c=>{c.merged.raw=c.merged.raw.slice(200);},'MERGE_TEXT_CHANGED'],
  ['merge source changed',c=>{c.merged.sourceSha256=hash('f');},'MERGE_SOURCE_CHANGED'],
  ['unreviewed overlapping transcription',c=>{c.merged.boundaryReview='AMBIGUOUS';},'MERGE_BOUNDARY_REVIEW_MISSING'],
  ['missing chapter',c=>{c.summary.chapters.splice(10,1);},'SUMMARY_SCHEMA_INVALID'],
  ['chapter coverage hole',c=>{c.summary.chapters[10].firstSegmentId++;},'SUMMARY_SCHEMA_INVALID'],
  ['chapter outside evidence',c=>{c.summary.chapters[0].evidenceIds=[REF.segmentCount];},'SUMMARY_SCHEMA_INVALID'],
  ['summary edited after QA',c=>{c.summary.conclusion='Changed conclusion.';},'SUMMARY_HASH_MISMATCH'],
  ['partial summary response',c=>{c.summary.responseComplete=false;},'SUMMARY_OPERATION_UNPROVEN'],
  ['summary from old transcript',c=>{c.summary.transcriptSha256=hash('f');},'SUMMARY_SOURCE_CHANGED'],
  ['export loses summary',c=>{c.saved.exportContainsCompleteSummary=false;},'TXT_EXPORT_MISMATCH'],
  ['export loses transcript',c=>{c.saved.exportTranscriptSha256=hash('f');},'TXT_EXPORT_MISMATCH'],
  ['POST success without GET readback',c=>{c.saved.durableReadbackConfirmed=false;},'SAVE_READBACK_MISSING'],
  ['cached page without fresh owner login',c=>{c.saved.ownerLoginFresh=false;},'FRESH_LOGIN_LIST_REOPEN_MISSING'],
  ['report belongs to another job',c=>{c.saved.jobId='other-job';},'SAVED_JOB_OR_REPORT_MISMATCH'],
  ['rewritten historical provider failure',c=>{c.saved.originalOperationsUnchanged=false;},'ORIGINAL_EVIDENCE_NOT_PRESERVED'],
  ['invented or modified payment receipt',c=>{c.saved.originalUsageAndReceiptsUnchanged=false;},'ORIGINAL_EVIDENCE_NOT_PRESERVED'],
  ['uncertain dispatch remains',c=>{c.saved.unresolvedOperationCount=1;},'COST_OR_OPERATION_RECONCILIATION_MISSING'],
  ['double dispatch',c=>{c.saved.duplicateDispatchCount=1;},'COST_OR_OPERATION_RECONCILIATION_MISSING'],
])test(`${name} blocks the corresponding stage`,()=>blockedBy(change,code));

test('120 synthetic segments, 12 synthetic chapters and end-to-end timeline coverage do not prove audio accuracy',()=>{
  const c=capture(),timeline=transcriptAudit(c.transcript.segments,REF.audioDurationMs/1000);
  assert.ok(timeline.timelineRatio>.99);assert.equal(timeline.status,'TRANSCRIPT_UNVERIFIED');
  delete c.transcript.audioReview;
  assert.ok(reasons(assessExamplePipelineEvidence(c)).includes('AUDIO_ACCURACY_UNVERIFIED'));
});
test('chapter count and reference file byte count cannot replace semantic review',()=>blockedBy(c=>{
  c.summary.qualityReview={verdict:'PASS',referenceUtf8Bytes:4096,chapterCount:12};
},'SEMANTIC_QUALITY_REVIEW_MISSING'));
for(const criterion of QUALITY_RUBRIC)test(`semantic review requires explicit ${criterion} findings`,()=>blockedBy(c=>{
  c.summary.qualityReview.rubric[criterion]={verdict:'PASS',note:''};
},'SEMANTIC_QUALITY_REVIEW_MISSING'));
test('review of one cue cannot claim full 120-cue semantic coverage',()=>blockedBy(c=>{c.summary.qualityReview.reviewedSegmentIds=[1];},'SEMANTIC_QUALITY_REVIEW_MISSING'));
test('audio review bound to another transcript cannot upgrade unverified text',()=>blockedBy(c=>{c.transcript.audioReview.transcriptSha256=hash('f');},'AUDIO_ACCURACY_UNVERIFIED'));
test('unresolved forecast attribution or tentative-to-certain wording blocks semantic acceptance',()=>blockedBy(c=>{
  c.summary.qualityReview.rubric.speakerAndForecastAttribution={verdict:'ISSUES',note:'Synthetic finding: a tentative possibility became a confirmed outcome, or distinct speakers/time horizons were conflated.'};
},'SEMANTIC_QUALITY_REVIEW_MISSING'));

function resume(){
  const scope={jobId:'synthetic-job',stage:'summary',unitKey:'summary:final',sourceIdentitySha256:hash('e'),sourceSha256:hash('a'),transcriptSha256:hash('b'),requestSha256:hash('c'),model:'synthetic-model',contractVersion:'synthetic-v1'};
  return {scope,now:10000,expectedMicroUsd:0,approval:{scopeSha256:operationScopeDigest(scope),state:'APPROVED',expiresAt:20000,remainingCalls:1,automaticRetries:0,kind:'FREE_EXACT_SCOPE',billingDisabledConfirmed:true,freeQuotaObservedSufficient:true}};
}
test('reviewing a fresh free dispatch plan never dispatches or grants runtime authority',()=>{
  const result=reviewOfflineResumePolicy(resume());assert.equal(result.nextStep,'REVIEW_SINGLE_DISPATCH_PLAN');assert.equal(result.dispatchAllowed,false);assert.equal(result.providerCalls,0);assert.equal(result.databaseWrites,0);
  assert.equal(result.productionExecutionSupported,false);assert.equal(result.automaticCompletion,false);
});
for(const field of ['operation','checkpoint'])test(`${field} only accepts an object or explicit absent/null state`,()=>{
  for(const value of [false,0,'',true,1,[],['synthetic']]){
    const c=resume();c[field]=value;const result=reviewOfflineResumePolicy(c);
    assert.equal(result.nextStep,'BLOCKED');assert.equal(result.reason,field==='operation'?'INVALID_OPERATION_RECORD':'INVALID_CHECKPOINT_RECORD');
    assert.equal(result.productionExecutionSupported,false);assert.equal(result.automaticCompletion,false);
  }
  const c=resume();c[field]=null;assert.equal(reviewOfflineResumePolicy(c).nextStep,'REVIEW_SINGLE_DISPATCH_PLAN');
});
for(const state of ['CLAIMED','RESERVED','DISPATCHING','PENDING','RUNNING','FAILED_UNCERTAIN','UNCERTAIN'])test(`${state} requires read-only reconciliation with zero automatic retries`,()=>{
  const c=resume();c.operation={scopeSha256:operationScopeDigest(c.scope),state};
  const result=reviewOfflineResumePolicy(c);assert.equal(result.nextStep,'READ_ONLY_RECONCILIATION_REQUIRED');assert.equal(result.automaticRetries,0);assert.equal(result.providerCalls,0);
});
test('a preserved complete response permits a no-call recovery review without rewriting failure or usage',()=>{
  const c=resume();c.operation={scopeSha256:operationScopeDigest(c.scope),state:'FAILED_UNCERTAIN',responseComplete:true,responseValidated:true,responseSha256:hash('d')};
  const before=JSON.stringify(c),result=reviewOfflineResumePolicy(c);
  assert.equal(result.nextStep,'REVIEW_COMPLETE_STORED_RESPONSE');assert.equal(result.originalHistoryPreserved,true);assert.equal(result.databaseWrites,0);assert.equal(JSON.stringify(c),before);
});
test('same completed checkpoint is reused even after its old approval expires',()=>{
  const c=resume(),scopeSha256=operationScopeDigest(c.scope);c.approval.expiresAt=1;
  c.operation={scopeSha256,state:'DONE',responseComplete:true,responseValidated:true,responseSha256:hash('e')};c.checkpoint={scopeSha256,state:'SAVED',payloadSha256:hash('d'),sourceResponseSha256:hash('e'),contentReadbackMatches:true};
  assert.equal(reviewOfflineResumePolicy(c).nextStep,'REUSE_VERIFIED_CHECKPOINT');
});
for(const [label,change] of [
  ['incomplete response',c=>{c.operation.responseComplete=false;}],
  ['unvalidated response',c=>{c.operation.responseValidated=false;}],
  ['different response hash',c=>{c.checkpoint.sourceResponseSha256=hash('f');}],
  ['missing response hash',c=>{delete c.operation.responseSha256;}],
])test(`DONE checkpoint with ${label} cannot be reused`,()=>{
  const c=resume(),scopeSha256=operationScopeDigest(c.scope);
  c.operation={scopeSha256,state:'DONE',responseComplete:true,responseValidated:true,responseSha256:hash('e')};
  c.checkpoint={scopeSha256,state:'SAVED',payloadSha256:hash('d'),sourceResponseSha256:hash('e'),contentReadbackMatches:true};
  change(c);assert.equal(reviewOfflineResumePolicy(c).reason,'CHECKPOINT_RESPONSE_BINDING_REQUIRED');
});
for(const key of ['sourceIdentitySha256','sourceSha256','transcriptSha256','requestSha256','model','contractVersion','unitKey'])test(`changing ${key} prevents reuse or old approval consumption`,()=>{
  const c=resume(),scopeSha256=operationScopeDigest(c.scope);c.operation={scopeSha256,state:'DONE',responseComplete:true,responseValidated:true,responseSha256:hash('e')};c.checkpoint={scopeSha256,state:'SAVED',payloadSha256:hash('d'),sourceResponseSha256:hash('e'),contentReadbackMatches:true};
  c.scope[key]=key.endsWith('Sha256')?hash('f'):'changed-value';assert.equal(reviewOfflineResumePolicy(c).reason,'OPERATION_SCOPE_CHANGED');
});
test('failed saved-content readback cannot cause provider redispatch',()=>{
  const c=resume(),scopeSha256=operationScopeDigest(c.scope);c.operation={scopeSha256,state:'DONE'};c.checkpoint={scopeSha256,state:'SAVED',payloadSha256:hash('d'),contentReadbackMatches:false};
  assert.equal(reviewOfflineResumePolicy(c).reason,'CHECKPOINT_READBACK_REQUIRED');
});
test('successful provider operation with lost save response must reconcile rather than resend',()=>{
  const c=resume();c.operation={scopeSha256:operationScopeDigest(c.scope),state:'DONE'};
  assert.equal(reviewOfflineResumePolicy(c).reason,'COMPLETED_OPERATION_MISSING_CHECKPOINT');
});
for(const change of [a=>{a.expiresAt=10000;},a=>{a.state='CONSUMED';},a=>{a.state='CANCELLED';},a=>{a.scopeSha256=hash('f');}])test('expired consumed cancelled or changed approval cannot open a new attempt',()=>{
  const c=resume();change(c.approval);assert.equal(reviewOfflineResumePolicy(c).reason,'APPROVAL_MISSING_EXPIRED_CONSUMED_OR_CHANGED');
});
test('known insufficient or unknown free capacity does not fall back to paid',()=>{
  const c=resume();c.approval.freeQuotaObservedSufficient=false;const result=reviewOfflineResumePolicy(c);
  assert.equal(result.reason,'FREE_CAPACITY_UNVERIFIED');assert.equal(result.dispatchAllowed,false);
});
test('new paid step requires an exact fresh explicit owner cap',()=>{
  const c=resume();c.expectedMicroUsd=1000;assert.equal(reviewOfflineResumePolicy(c).reason,'PAID_CAP_OR_APPROVAL_REQUIRED');
  Object.assign(c.approval,{kind:'PAID_EXACT_SCOPE',explicitOwnerApproval:true,remainingMicroUsd:999});assert.equal(reviewOfflineResumePolicy(c).reason,'PAID_CAP_OR_APPROVAL_REQUIRED');
  c.approval.remainingMicroUsd=1000;const result=reviewOfflineResumePolicy(c);assert.equal(result.nextStep,'REVIEW_SINGLE_DISPATCH_PLAN');assert.equal(result.dispatchAllowed,false);
});
test('a proven-not-sent attempt needs affirmative zero-dispatch proof before a new plan review',()=>{
  const c=resume();c.operation={scopeSha256:operationScopeDigest(c.scope),state:'PROVEN_NOT_SENT',dispatchCount:0};
  assert.equal(reviewOfflineResumePolicy(c).reason,'PRIOR_OPERATION_REQUIRES_REVIEW');
  c.operation.notSentEvidenceVerified=true;assert.equal(reviewOfflineResumePolicy(c).nextStep,'REVIEW_SINGLE_DISPATCH_PLAN');
});
test('proven-not-sent cannot coexist with response evidence or malformed response flags',()=>{
  for(const patch of [{responseComplete:true},{responseValidated:true},{responseSha256:hash('d')},{responseSha256:null},{responseComplete:'true'},{responseValidated:1}]){
    const c=resume();c.operation={scopeSha256:operationScopeDigest(c.scope),state:'PROVEN_NOT_SENT',dispatchCount:0,notSentEvidenceVerified:true,...patch};
    const result=reviewOfflineResumePolicy(c);assert.equal(result.nextStep,'BLOCKED');assert.equal(result.reason,'CONTRADICTORY_NOT_SENT_EVIDENCE');
  }
});
for(const stage of ['merged','saved'])test(`${stage} review uses stored inputs without a provider request`,()=>{
  const c=resume();c.scope.stage=stage;delete c.approval;
  const result=reviewOfflineResumePolicy(c);assert.equal(result.nextStep,'REVIEW_LOCAL_STEP_ONLY');assert.equal(result.providerCalls,0);assert.equal(result.databaseWrites,0);
});
for(const stage of ['source','transcript'])test(`${stage} scope binds known identity without inventing a future transcript hash`,()=>{
  const c=resume();c.scope.stage=stage;c.scope.transcriptSha256=null;
  if(stage==='source')c.scope.sourceSha256=null;
  c.approval.scopeSha256=operationScopeDigest(c.scope);
  assert.match(c.approval.scopeSha256,/^[a-f0-9]{64}$/);
  assert.equal(reviewOfflineResumePolicy(c).nextStep,'REVIEW_SINGLE_DISPATCH_PLAN');
  c.scope.transcriptSha256=hash('f');assert.equal(operationScopeDigest(c.scope),null);
});
test('downstream scope requires actual source/transcript hashes, not identity hash substitutes',()=>{
  for(const stage of ['merged','summary','saved']){
    const c=resume();c.scope.stage=stage;c.scope.transcriptSha256=null;
    assert.equal(operationScopeDigest(c.scope),null);assert.equal(reviewOfflineResumePolicy(c).reason,'INVALID_SCOPE');
  }
});
test('automatic retry allowance and exhausted call count are both blocked',()=>{
  for(const patch of [{remainingCalls:0},{automaticRetries:1}]){
    const c=resume();Object.assign(c.approval,patch);assert.equal(reviewOfflineResumePolicy(c).reason,'CALL_LIMIT_OR_AUTOMATIC_RETRY_BLOCKED');
  }
});
