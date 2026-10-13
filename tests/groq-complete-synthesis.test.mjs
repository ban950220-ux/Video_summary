import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertGrounding} from '../src/groq-summary.mjs';
import {markdownReport} from '../src/report.mjs';
import {abbreviatedYearRecoveryCandidate} from '../src/groq-year-recovery.mjs';
import {COMPLETE_SYNTHESIS_INPUT_LIMIT,COMPLETE_SYNTHESIS_OUTPUT_LIMIT,reviewedSourceExcerpt,verifyReviewedSourceExcerpt,completeCoverageManifest,evidenceNotes,synthesisMergeRequest,leafNodes,synthesisQuoteEstimate,synthesisTreeOffline,synthesisTreeProgress,persistedSynthesisNode,completedSynthesisReport} from '../src/groq-complete-synthesis.mjs';

const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
const evidence=id=>({text:'원문 발언을 정리함',evidenceIds:[id]});
const report=id=>({summary:[evidence(id)],chapters:[evidence(id)],claims:[],numbers:[],critical:[],conclusion:'원문 범위의 결론'});
const reviewedStages=manifest=>manifest.stages.map(stage=>({index:stage.index,evidenceSha256:stage.recordSha256??stage.reportSha256}));
async function fixture(count=79){
 const groups=Array.from({length:count},(_,index)=>Array.from({length:3},(_,part)=>{const id=index*3+part+1;return {id,startMs:(id-1)*24000,endMs:id*24000,text:'원문 발언을 정리함'};}));
 const segments=groups.flat(),sourceHash='a'.repeat(64),auditSha256='c'.repeat(64),excerpts=Array(count).fill(null),failures=[8,9].filter(index=>index<count);
 for(const index of failures)excerpts[index]=await reviewedSourceExcerpt(sourceHash,groups[index],groups[index].map(item=>item.id),{stageIndex:index,auditSha256,failureEvidence:[{operationId:'raw:'+index,resultSha256:'b'.repeat(64),usageTotalTokens:2078,unit:'actual_total_tokens'}]});
 const checkpoints=await Promise.all(groups.map(async(group,index)=>failures.includes(index)?null:{key:'raw:'+index,sourceHash,provenance:'AI_VALIDATED_RAW_CHECKPOINT',report:report(group[0].id),reportSha256:await digest(report(group[0].id))}));
 return {groups,segments,sourceHash,auditSha256,excerpts,checkpoints};
}

test('reviewed excerpt binds every held segment, exact time, text and source hash',async()=>{
 const f=await fixture();
 const excerpt=f.excerpts[8],evidence=excerpt.failureEvidence;
 assert.equal((await verifyReviewedSourceExcerpt(excerpt,f.sourceHash,f.groups[8],evidence,f.auditSha256)).provenance,'HUMAN_REVIEWED_SOURCE_EXCERPT');
 await assert.rejects(reviewedSourceExcerpt(f.sourceHash,f.groups[8],[f.groups[8][0].id],{stageIndex:8,failureEvidence:evidence,auditSha256:f.auditSha256}),/EXCERPT_COVERAGE_REQUIRED/);
 await assert.rejects(verifyReviewedSourceExcerpt(excerpt,'b'.repeat(64),f.groups[8],evidence,f.auditSha256),/EXCERPT_SOURCE_CHANGED/);
 await assert.rejects(verifyReviewedSourceExcerpt(excerpt,f.sourceHash,[{...f.groups[8][0],text:'바뀐 원문'},...f.groups[8].slice(1)],evidence,f.auditSha256),/EXCERPT_SOURCE_CHANGED/);
 await assert.rejects(verifyReviewedSourceExcerpt(excerpt,f.sourceHash,f.groups[8],[{...evidence[0],usageTotalTokens:1}],f.auditSha256),/EXCERPT_SOURCE_CHANGED/);
 await assert.rejects(verifyReviewedSourceExcerpt(excerpt,f.sourceHash,f.groups[8],evidence,'d'.repeat(64)),/EXCERPT_SOURCE_CHANGED/);
});

test('79 raw stages complete offline through bounded tree, full coverage, saved report and identical TXT readback',async()=>{
 const f=await fixture(),manifest=await completeCoverageManifest({...f,verifyGrounding:assertGrounding});
 assert.equal(manifest.rawStageCount,79);assert.equal(manifest.missingSegmentIds.length,0);
 assert.equal(manifest.stages[8].provenance,'HUMAN_REVIEWED_SOURCE_EXCERPT');
 assert.equal(manifest.stages[9].provenance,'HUMAN_REVIEWED_SOURCE_EXCERPT');
 const notes=await evidenceNotes({manifest,checkpoints:f.checkpoints,excerpts:f.excerpts});
 assert.equal(notes.length,79);
 assert.equal(notes.length-1,78);
 const quote=synthesisQuoteEstimate(notes.length);
 assert.equal(quote.calls,78);assert.equal(quote.totalReservationUpper,514_800);assert.equal(quote.maxCallsPerWindow,29);assert.equal(quote.minimumApprovalWindows,3);
 let calls=0;
 const merged=await synthesisTreeOffline({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,merge:({request,left,right})=>{
  calls++;assert.ok(request.inputUpper<=COMPLETE_SYNTHESIS_INPUT_LIMIT);assert.equal(request.outputUpper,COMPLETE_SYNTHESIS_OUTPUT_LIMIT);
  return {summary:[evidence(left.evidenceIds[0])],chapters:[evidence(left.evidenceIds[0]),evidence(right.evidenceIds[0])],claims:[],numbers:[],critical:[],conclusion:'원문 범위의 결론'};
 }});
 assert.equal(calls,notes.length-1);assert.equal(merged.operations.length,calls);
 await assert.rejects(completedSynthesisReport({manifest,notes,root:merged.root,checkpoints:f.checkpoints,excerpts:f.excerpts,segments:f.segments,verifyGrounding:assertGrounding}),/SYNTHESIS_MEANING_REVIEW_REQUIRED/);
 const semanticReview={confirmMeaningAgainstSource:true,confirmRootIncludesAllMeaningfulPoints:true,reviewedStages:reviewedStages(manifest),manifestSha256:manifest.manifestSha256,rootSha256:await digest(merged.root),reviewedAt:new Date().toISOString()};
 const final=await completedSynthesisReport({manifest,notes,root:merged.root,checkpoints:f.checkpoints,excerpts:f.excerpts,segments:f.segments,verifyGrounding:assertGrounding,semanticReview});
 assert.equal(final.synthesisComplete,true);assert.equal(final.kind,'GROQ_EVIDENCE_LINKED');assert.equal(final.appendix.length,79);
 assert.equal(final.appendix[8].provenance,'HUMAN_REVIEWED_SOURCE_EXCERPT');
 assert.equal(final.appendix[9].provenance,'HUMAN_REVIEWED_SOURCE_EXCERPT');
 const source={raw:f.segments.map(item=>item.text).join('\n'),segments:f.segments};
 const persisted=JSON.parse(JSON.stringify({title:'전체 영상',status:'completed',duration_seconds:5688,source_type:'audio',report:final,audit:{audioProcessingCoverage:1}}));
 const txt=markdownReport(persisted,source),reload=markdownReport(JSON.parse(JSON.stringify(persisted)),JSON.parse(JSON.stringify(source)));
 assert.equal(reload,txt);assert.match(txt,/누락 원문 ID: 없음/);assert.match(txt,/raw:8 · 검토된 원문 발췌 \(AI 요약 아님\)/);
 assert.match(txt,/raw:78 · 검증된 AI 구간 보고서/);
});

test('98:12.864 structure covers 1,226 source segments across 79 raw stages through final offline TXT',async()=>{
 const total=1226,durationMs=5_892_864,sourceHash='d'.repeat(64),auditSha256='e'.repeat(64),segments=Array.from({length:total},(_,index)=>({id:index+1,startMs:Math.floor(index*durationMs/total),endMs:Math.floor((index+1)*durationMs/total),text:'원문 발언을 정리함'}));
 const groups=[];let offset=0;for(let index=0;index<79;index++){const size=15+(index<41?1:0);groups.push(segments.slice(offset,offset+size));offset+=size;}assert.equal(offset,total);
 const excerpts=Array(79).fill(null),checkpoints=Array(79).fill(null);
 for(let index=0;index<79;index++)if(index===8||index===9)excerpts[index]=await reviewedSourceExcerpt(sourceHash,groups[index],groups[index].map(item=>item.id),{stageIndex:index,auditSha256,failureEvidence:[{operationId:'raw:'+index,resultSha256:'f'.repeat(64),usageTotalTokens:2078,unit:'actual_total_tokens'}]});else checkpoints[index]={key:'raw:'+index,sourceHash,provenance:'AI_VALIDATED_RAW_CHECKPOINT',report:report(groups[index][0].id),reportSha256:await digest(report(groups[index][0].id))};
 const manifest=await completeCoverageManifest({sourceHash,auditSha256,segments,groups,checkpoints,excerpts,verifyGrounding:assertGrounding}),notes=await evidenceNotes({manifest,checkpoints,excerpts});
 const merged=await synthesisTreeOffline({notes,sourceSegments:segments,verifyGrounding:assertGrounding,merge:({request,left,right})=>{assert.ok(request.inputUpper<=4800);return {summary:[evidence(left.evidenceIds[0])],chapters:[evidence(left.evidenceIds[0]),evidence(right.evidenceIds[0])],claims:[],numbers:[],critical:[],conclusion:'원문 범위의 결론'};}});
 const semanticReview={confirmMeaningAgainstSource:true,confirmRootIncludesAllMeaningfulPoints:true,reviewedStages:reviewedStages(manifest),manifestSha256:manifest.manifestSha256,rootSha256:await digest(merged.root),reviewedAt:new Date().toISOString()},final=await completedSynthesisReport({manifest,notes,root:merged.root,checkpoints,excerpts,segments,verifyGrounding:assertGrounding,semanticReview}),source={raw:segments.map(item=>item.text).join('\n'),segments},job={title:'98분 영상',status:'completed',duration_seconds:5892.864,source_type:'audio',report:final,audit:{audioProcessingCoverage:1}},txt=markdownReport(job,source);
 assert.equal(manifest.segmentCount,1226);assert.equal(manifest.rawStageCount,79);assert.equal(manifest.missingSegmentIds.length,0);assert.equal(segments.at(-1).endMs,durationMs);assert.equal(final.appendix.length,79);assert.match(txt,/#1226/);assert.equal(markdownReport(JSON.parse(JSON.stringify(job)),JSON.parse(JSON.stringify(source))),txt);
});

test('missing or changed raw evidence cannot be finalized as complete',async()=>{
 const f=await fixture();
 const missing=[...f.checkpoints];missing[78]=null;
 await assert.rejects(completeCoverageManifest({...f,checkpoints:missing,verifyGrounding:assertGrounding}),/COVERAGE_MISSING_STAGE/);
 const changed=[...f.checkpoints];changed[0]={...changed[0],report:report(2)};
 await assert.rejects(completeCoverageManifest({...f,checkpoints:changed,verifyGrounding:assertGrounding}),/COVERAGE_CHECKPOINT_HASH_CHANGED/);
 const gaps=[...f.groups];gaps[9]=[...gaps[9].slice(1)];
 await assert.rejects(completeCoverageManifest({...f,groups:gaps,verifyGrounding:assertGrounding}),/COVERAGE_SOURCE_MISMATCH/);
});

test('a single short raw note cannot appear complete without a quote or merge',async()=>{
 const f=await fixture(1),manifest=await completeCoverageManifest({...f,verifyGrounding:assertGrounding});
 await assert.rejects(evidenceNotes({manifest,checkpoints:f.checkpoints,excerpts:f.excerpts}),/SYNTHESIS_NOTE_COUNT_INVALID/);
 await assert.rejects(synthesisTreeProgress({notes:[{index:0,stage:0,evidenceIds:[1],boundarySegmentIds:[],provenance:'AI_VALIDATED_RAW_CHECKPOINT',text:'one'}],sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:new Map()}),/SYNTHESIS_PROGRESS_INVALID/);
});

test('unsupported synthesized number and oversized response stop before completion',async()=>{
 const f=await fixture(10),manifest=await completeCoverageManifest({...f,verifyGrounding:assertGrounding}),notes=await evidenceNotes({manifest,checkpoints:f.checkpoints,excerpts:f.excerpts});
 await assert.rejects(synthesisTreeOffline({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,merge:({left,right})=>({summary:[{text:'근거 없는 2024년',evidenceIds:[left.evidenceIds[0]]}],chapters:[evidence(left.evidenceIds[0]),evidence(right.evidenceIds[0])],claims:[],numbers:[],critical:[],conclusion:'원문 범위의 결론'})}),/UNSUPPORTED_NUMBER/);
 await assert.rejects(synthesisTreeOffline({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,merge:({left,right})=>({summary:[{text:'원문 발언을 정리함 '.repeat(200),evidenceIds:[left.evidenceIds[0]]}],chapters:[evidence(left.evidenceIds[0]),evidence(right.evidenceIds[0])],claims:[],numbers:[],critical:[],conclusion:'원문 범위의 결론'})}),/SYNTHESIS_OUTPUT_TOO_LARGE/);
});

test('resume validates saved request and response hashes before revealing one next step',async()=>{
 const f=await fixture(10),manifest=await completeCoverageManifest({...f,verifyGrounding:assertGrounding}),notes=await evidenceNotes({manifest,checkpoints:f.checkpoints,excerpts:f.excerpts}),saved=new Map();
 let current=await synthesisTreeProgress({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:saved});
 assert.equal(current.complete,false);assert.equal(current.completed,0);
 const {next}=current,response={summary:[evidence(next.left.evidenceIds[0])],chapters:[evidence(next.left.evidenceIds[0]),evidence(next.right.evidenceIds[0])],claims:[],numbers:[],critical:[],conclusion:'원문 범위의 결론'};
 const row=await persistedSynthesisNode({next,response,sourceSegments:f.segments,verifyGrounding:assertGrounding});saved.set(next.key,row);
 current=await synthesisTreeProgress({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:saved});
 assert.equal(current.completed,1);assert.notEqual(current.next.key,next.key);
 saved.set(next.key,{...row,requestSha256:'b'.repeat(64)});
 await assert.rejects(synthesisTreeProgress({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:saved}),/SYNTHESIS_SAVED_NODE_CHANGED/);
 saved.set(next.key,row);saved.set('note:9:9',row);
 await assert.rejects(synthesisTreeProgress({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:saved}),/SYNTHESIS_OPERATION_ORDER_INVALID/);
});

test('coverage distinguishes a source-preserving derived raw:9 checkpoint from a reviewed raw:8 excerpt',async()=>{
 const f=await fixture(10),ids=f.groups[9].map(item=>item.id);
 f.groups[9]=f.groups[9].map((item,index)=>({...item,text:index===0?'22년 금리 1.5%':index===1?'23년 물가 2%대':'원문 발언을 정리함'}));f.segments=f.groups.flat();
 const original={summary:[{text:'2022년 금리 1.5%',evidenceIds:[ids[0]]},{text:'2023년 물가 2%대',evidenceIds:[ids[1]]}],chapters:[{text:'금리와 물가 언급',evidenceIds:[ids[0],ids[1]]}],claims:[],numbers:[],critical:[],conclusion:'원문 범위의 결론'},failedResultJson=JSON.stringify({reviewResult:{partialText:JSON.stringify(original),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:60,totalTokens:2078}}});
 const approvalEvidence={id:'job:groq-summary:approval:1',state:'STOPPED',resultJson:JSON.stringify({jobId:'job',transcriptHash:f.sourceHash,sequence:1,model:'openai/gpt-oss-120b',outputKind:'RAW_CHECKPOINTS_WITH_REVIEW_GAP',windowStart:9,maxRequests:1,maxInputTokensPerRequest:4800,maxCompletionTokensPerRequest:1800,freeTierConfirmed:true,billingDisabled:true})},failedOperationId='job:groq-summary:'+f.sourceHash+':raw:9';
 const recovery=await abbreviatedYearRecoveryCandidate({stage:'raw:9',sourceHash:f.sourceHash,auditSha256:f.auditSha256,failedOperationId,failedResultJson,usageEvidence:{unit:'actual_total_tokens',totalTokens:2078},approvalEvidence,segments:f.groups[9],verifyGrounding:assertGrounding});
 f.excerpts[9]=null;f.checkpoints[9]={key:'raw:9',sourceHash:f.sourceHash,provenance:'AUDITED_DERIVED_CHECKPOINT',report:recovery.derivedReport,reportSha256:await digest(recovery.derivedReport),recoveryRecord:recovery,approvalEvidence,failedResultJson,usageEvidence:{id:'usage-raw-9',capability:'LIVE_FREE_SUMMARY',unit:'actual_total_tokens',provenance:'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',totalTokens:2078},failureEvidence:[{usageEventId:'usage-raw-9',operationId:failedOperationId,resultSha256:recovery.failedResultSha256,responseSha256:recovery.originalResponseSha256,usageTotalTokens:2078,unit:'actual_total_tokens'}]};
 const manifest=await completeCoverageManifest({...f,verifyGrounding:assertGrounding});
 assert.equal(manifest.stages[8].provenance,'HUMAN_REVIEWED_SOURCE_EXCERPT');assert.equal(manifest.stages[9].provenance,'AUDITED_DERIVED_CHECKPOINT');
 const changed=structuredClone(f);changed.checkpoints[9].recoveryRecord.failedResultSha256='f'.repeat(64);
 await assert.rejects(completeCoverageManifest({...changed,verifyGrounding:assertGrounding}),/COVERAGE_RECOVERY_INVALID/);
 for(const field of ['failedOperationId','originalResponseSha256','confirmedUsage','transformations']){
  const missing=structuredClone(f);delete missing.checkpoints[9].recoveryRecord[field];missing.checkpoints[9].recoveryRecord.recordSha256=await digest(Object.fromEntries(Object.entries(missing.checkpoints[9].recoveryRecord).filter(([key])=>key!=='recordSha256')));
  await assert.rejects(completeCoverageManifest({...missing,verifyGrounding:assertGrounding}),/COVERAGE_RECOVERY_INVALID/);
 }
});

test('quote-heavy excerpts fit the final serialized merge request without dropping text',async()=>{
 const text='"No." "Yes." '.repeat(60)+'마지막',groups=[0,1].map(index=>[{id:index+1,startMs:index*1000,endMs:(index+1)*1000,text}]),segments=groups.flat(),sourceHash='a'.repeat(64),auditSha256='c'.repeat(64);
 const excerpts=await Promise.all(groups.map((group,index)=>reviewedSourceExcerpt(sourceHash,group,[index+1],{stageIndex:index,auditSha256,failureEvidence:[{operationId:'raw:'+index,resultSha256:'b'.repeat(64),usageTotalTokens:2078,unit:'actual_total_tokens'}]})));
 const manifest=await completeCoverageManifest({sourceHash,auditSha256,segments,groups,checkpoints:[null,null],excerpts,verifyGrounding:assertGrounding}),notes=await evidenceNotes({manifest,checkpoints:[null,null],excerpts});
 assert.ok(notes.length>=2);
 const reconstructed=[0,1].map(index=>notes.filter(note=>note.stage===index).flatMap(note=>JSON.parse(note.text)).map(item=>item.text).join(''));
 assert.deepEqual(reconstructed,[text,text]);
 const leaves=leafNodes(notes);for(let index=0;index+1<leaves.length;index+=2)assert.ok(synthesisMergeRequest(leaves[index],leaves[index+1]).inputUpper<=COMPLETE_SYNTHESIS_INPUT_LIMIT);
});

test('47 uncertain boundary IDs stay in notes, merge prompts, root and final manifest',async()=>{
 const f=await fixture(),boundarySegmentIds=f.groups.slice(0,47).map(group=>group[0].id),manifest=await completeCoverageManifest({...f,boundarySegmentIds,verifyGrounding:assertGrounding}),notes=await evidenceNotes({manifest,checkpoints:f.checkpoints,excerpts:f.excerpts});
 assert.deepEqual(manifest.boundarySegmentIds,boundarySegmentIds);
 assert.ok(notes.every(note=>note.boundarySegmentIds.every(id=>boundarySegmentIds.includes(id))));
 assert.deepEqual([...new Set(notes.flatMap(note=>note.boundarySegmentIds))].sort((a,b)=>a-b),boundarySegmentIds);
 let sawGuidance=false;
 const merged=await synthesisTreeOffline({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,merge:({request,left,right})=>{
  const content=request.messages[1].content;
  if(left.boundarySegmentIds.length||right.boundarySegmentIds.length){assert.match(content,/경계 불확실성/);sawGuidance=true;}
  return {summary:[evidence(left.evidenceIds[0])],chapters:[evidence(left.evidenceIds[0]),evidence(right.evidenceIds[0])],claims:[],numbers:[],critical:[],conclusion:'원문 범위의 결론'};
 }});
 assert.equal(sawGuidance,true);assert.deepEqual(merged.root.boundarySegmentIds,boundarySegmentIds);
 const semanticReview={confirmMeaningAgainstSource:true,confirmRootIncludesAllMeaningfulPoints:true,reviewedStages:reviewedStages(manifest),manifestSha256:manifest.manifestSha256,rootSha256:await digest(merged.root),reviewedAt:new Date().toISOString()};
 const final=await completedSynthesisReport({manifest,notes,root:merged.root,checkpoints:f.checkpoints,excerpts:f.excerpts,segments:f.segments,verifyGrounding:assertGrounding,semanticReview});
 assert.deepEqual(final.coverageManifest.boundarySegmentIds,boundarySegmentIds);
});

test('heterogeneous topics require a review record for every stage before finalization',async()=>{
 const topics=['출시 계획','매출 7%','품질 반론','납기 불확실','지난 분기','고객 이탈','환율 3%','안전 조건'];
 const f=await fixture(8);
 for(let index=0;index<8;index++){
  f.groups[index]=f.groups[index].map(item=>({...item,text:topics[index]}));
  const revised={summary:[{text:topics[index],evidenceIds:[f.groups[index][0].id]}],chapters:[{text:topics[index],evidenceIds:[f.groups[index][0].id]}],claims:[],numbers:[],critical:[],conclusion:'추가 확인 필요'};
  f.checkpoints[index]={...f.checkpoints[index],report:revised,reportSha256:await digest(revised)};
 }
 f.segments=f.groups.flat();
 const manifest=await completeCoverageManifest({...f,verifyGrounding:assertGrounding}),notes=await evidenceNotes({manifest,checkpoints:f.checkpoints,excerpts:f.excerpts});
 const merged=await synthesisTreeOffline({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,merge:({left,right})=>({summary:[{text:'논의가 있었다',evidenceIds:[left.evidenceIds[0]]}],chapters:[{text:'논의가 있었다',evidenceIds:[left.evidenceIds[0]]},{text:'논의가 있었다',evidenceIds:[right.evidenceIds[0]]}],claims:[],numbers:[],critical:[],conclusion:'추가 확인 필요'})});
 const semanticReview={confirmMeaningAgainstSource:true,confirmRootIncludesAllMeaningfulPoints:true,reviewedStages:reviewedStages(manifest).filter(item=>[0,4].includes(item.index)),manifestSha256:manifest.manifestSha256,rootSha256:await digest(merged.root),reviewedAt:new Date().toISOString()};
 await assert.rejects(completedSynthesisReport({manifest,notes,root:merged.root,checkpoints:f.checkpoints,excerpts:f.excerpts,segments:f.segments,verifyGrounding:assertGrounding,semanticReview}),/SYNTHESIS_MEANING_REVIEW_REQUIRED/);
});
