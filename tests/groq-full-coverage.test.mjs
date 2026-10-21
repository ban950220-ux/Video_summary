import test from 'node:test';
import assert from 'node:assert/strict';
import {assertFullSource,partitionFullCoverage,fullCoveragePlan,validateLeafResponse,nextFullCoverageStage,fullCoverageAdmission,assembleFullCoverageReport,executeFullCoverageStep,finalizeFullCoverage,FULL_COVERAGE_MINUTE_RESERVATION} from '../src/groq-full-coverage.mjs';
import {markdownReport} from '../src/report.mjs';
import {fullCoverageGlobalContext,fullCoverageGlobalProgress} from '../src/groq-full-coverage-global.mjs';
import {synthesisQuoteEstimate,synthesisTreeProgress,persistedSynthesisNode} from '../src/groq-complete-synthesis.mjs';

const item=(text,ids)=>({text,evidenceIds:ids});
const report=group=>({summary:[item('범위 요약',[group[0].id,group.at(-1).id])],chapters:[item('시간순 주제',[group[0].id,group.at(-1).id])],claims:[],numbers:[],critical:[],conclusion:'부분 요약'});
const segments=Array.from({length:1226},(_,i)=>({id:i+1,startMs:i*4000,endMs:i*4000+3900,text:`발화 ${i+1}의 한국어 원문과 근거 내용을 기록합니다.`}));
const raw=segments.map(s=>s.text).join('\n');
const legacyGroups=Array.from({length:79},(_,i)=>segments.slice(i*16,Math.min((i+1)*16,segments.length))).filter(group=>group.length);
const savedLegacyReports=legacyGroups.slice(0,8).map(report);

async function plan(){return fullCoveragePlan({segments,raw,legacyGroups,savedLegacyReports,summarizeHeldStage:true});}

test('1226 original IDs are covered once; eight checkpoints reused; raw:8 held',async()=>{
 const result=await plan();
 assert.equal(result.segmentCount,1226);
 assert.deepEqual(result.stages.slice(0,8).map(s=>s.kind),Array(8).fill('REUSED_LEGACY_CHECKPOINT'));
 assert.equal(result.stages[8].kind,'NEW_HELD_LEAF');
 assert.equal(result.stages[8].legacyOperation,'raw:8');
 assert.equal(result.stages.at(-1).lastId,1226);
 assert.ok(result.stages.filter(s=>s.kind==='NEW_LEAF').length>0);
 for(const stage of result.stages.filter(s=>['NEW_HELD_LEAF','NEW_LEAF'].includes(s.kind))){
  assert.ok(stage.inputBytes<=6200);
  assert.ok(stage.reservationTokens<=FULL_COVERAGE_MINUTE_RESERVATION);
 }
});

test('duplicate, missing, and changed source fail before a request is planned',async()=>{
 assert.throws(()=>assertFullSource([...segments.slice(0,50),segments[49],...segments.slice(51)],raw),/FULL_SOURCE_INVALID/);
 await assert.rejects(fullCoveragePlan({segments,raw:raw+'x',legacyGroups,savedLegacyReports}),/FULL_SOURCE_RAW_MISMATCH/);
 await assert.rejects(fullCoveragePlan({segments,raw,legacyGroups:[...legacyGroups.slice(0,9),legacyGroups[9],...legacyGroups.slice(11)],savedLegacyReports}),/LEGACY_COVERAGE_CHANGED/);
});

test('saved job audit and legacy transcript contract bind the plan identity',async()=>{
 const a=await fullCoveragePlan({segments,raw,legacyGroups,savedLegacyReports,summarizeHeldStage:true,sourceAuditSha256:'a'.repeat(64),legacyTranscriptHash:'c'.repeat(64)});
 const b=await fullCoveragePlan({segments,raw,legacyGroups,savedLegacyReports,summarizeHeldStage:true,sourceAuditSha256:'b'.repeat(64),legacyTranscriptHash:'c'.repeat(64)});
 assert.notEqual(a.planSha256,b.planSha256);
});

test('leaf citations must include both temporal endpoints',async()=>{
 const stage=(await plan()).stages.find(s=>s.kind==='NEW_LEAF');
 assert.doesNotThrow(()=>validateLeafResponse(stage,report(stage.segments)));
 const wrong=report(stage.segments);wrong.chapters=[item('범위 누락',[stage.firstId])];
 assert.throws(()=>validateLeafResponse(stage,wrong),/FULL_LEAF_ENDPOINTS_UNCITED/);
});

test('uncertain call is never implicitly advanced or retried',async()=>{
 const p=await plan(),stage=p.stages.find(s=>s.kind==='NEW_HELD_LEAF');
 const rows=new Map([[stage.key,{state:'FAILED_UNCERTAIN',planSha256:p.planSha256,requestSha256:stage.requestSha256}]]);
 assert.deepEqual(nextFullCoverageStage(p,rows),{state:'REVIEW_REQUIRED',stage,operationState:'FAILED_UNCERTAIN'});
 assert.equal(fullCoverageAdmission({now:1000000,providerFreeBound:true,approvalExpiresAt:2000000,request:stage,ledger:[{id:'old-raw:8',state:'FAILED_UNCERTAIN',reservationTokens:6200,at:1}]}).reason,'PRIOR_OUTCOME_REVIEW_REQUIRED');
 assert.equal(fullCoverageAdmission({now:1000000,providerFreeBound:true,approvalExpiresAt:2000000,request:stage,reviewedUncertainIds:['old-raw:8'],ledger:[{id:'old-raw:8',state:'FAILED_UNCERTAIN',reservationTokens:6200,at:1}]}).allowed,true);
});

test('new call for held raw:8 requires an explicit separate approval',async()=>{
 const p=await plan(),stage=p.stages.find(s=>s.kind==='NEW_HELD_LEAF'),records=new Map();let calls=0;
 const result=await executeFullCoverageStep({plan:p,records,ledger:[],store:{},dispatch:async()=>{calls++;},approval:{providerFreeBound:true,expiresAt:Date.now()+3600000}});
 assert.equal(result.reason,'EXPLICIT_HELD_STAGE_APPROVAL_REQUIRED');
 assert.equal(result.stage,stage.key);
 assert.equal(calls,0);
 const partial=await fullCoveragePlan({segments,raw,legacyGroups,savedLegacyReports});
 assert.throws(()=>assembleFullCoverageReport({plan:partial,records:new Map(),segments,raw,legacyFailureEvidence:[{operationId:'old:raw:8',actualTotalTokens:100}]}),/FULL_HELD_STAGE_NOT_SUMMARIZED/);
});

test('rolling daily cap stops and resumes without resetting old usage',async()=>{
 const request={reservationTokens:6200},ledger=Array.from({length:31},(_,i)=>({id:'old:'+i,state:'DONE',reservationTokens:6200,at:1000000+i*62000}));
 const now=1000000+31*62000;
 assert.equal(fullCoverageAdmission({now,ledger,request,providerFreeBound:true,approvalExpiresAt:now+3600000}).reason,'LOCAL_DAY_LIMIT');
 assert.equal(fullCoverageAdmission({now:now+86400001,ledger,request,providerFreeBound:true,approvalExpiresAt:now+90000000}).allowed,true);
 assert.equal(fullCoverageAdmission({now,ledger:[],request,providerFreeBound:false,approvalExpiresAt:now+3600000}).reason,'FREE_KEY_BINDING_OR_APPROVAL_REQUIRED');
});

test('finalization requires every persisted leaf and preserves held source/usage in TXT',async()=>{
 const p=await plan(),rows=new Map();
 assert.throws(()=>assembleFullCoverageReport({plan:p,records:rows,segments,raw,legacyFailureEvidence:[{operationId:'raw:8',actualTotalTokens:100}]}),/FULL_FINAL_NOT_READY/);
 for(const stage of p.stages.filter(s=>['NEW_HELD_LEAF','NEW_LEAF'].includes(s.kind)))rows.set(stage.key,{state:'DONE',planSha256:p.planSha256,requestSha256:stage.requestSha256,response:report(stage.segments),actualTotalTokens:400});
 const assembled=assembleFullCoverageReport({plan:p,records:rows,segments,raw,legacyFailureEvidence:[{operationId:'old:raw:8',actualTotalTokens:2169}]});
 assert.equal(assembled.sourceCoverage.segmentCount,1226);
 assert.equal(assembled.sourceCoverage.missingSegmentIds.length,0);
 assert.equal(assembled.heldLegacyStage,'raw:8');
 assert.equal(assembled.appendix[8].segments.length,16);
 const txt=markdownReport({title:'검증',status:'DONE',duration_seconds:4904,source_type:'audio',audit:{},report:assembled},{segments,raw});
 assert.match(txt,/검증/);
 assert.match(txt,/범위 요약/);
 assert.match(txt,/The old operation remains uncertain/);
});

test('global synthesis has a separate evidence-linked hierarchy and cannot finalize from section joins',async()=>{
 const p=await plan(),rows=new Map();
 for(const stage of p.stages.filter(s=>['NEW_HELD_LEAF','NEW_LEAF'].includes(s.kind)))rows.set(stage.key,{state:'DONE',planSha256:p.planSha256,requestSha256:stage.requestSha256,response:report(stage.segments),actualTotalTokens:400});
 const context=await fullCoverageGlobalContext({plan:p,records:rows,segments,raw});
 assert.equal(context.manifest.segmentCount,1226);
 assert.equal(context.manifest.missingSegmentIds.length,0);
 assert.ok(context.notes.length>1);
 assert.ok(context.quote.calls>0);
 assert.equal(context.manifest.synthesisFanout,4);
 assert.equal(context.manifest.maxNotesPerStage,2);
 assert.ok(context.notes.length<=p.stages.length*2);
 assert.equal(context.quote.calls,synthesisQuoteEstimate(context.notes.length,4).calls);
 assert.equal(synthesisQuoteEstimate(62,4).calls,21);
 const progress=await fullCoverageGlobalProgress({context,savedNodes:new Map(),segments});
 assert.equal(progress.complete,false);
 assert.ok(progress.next.request.reservationUpper<=6600);
 assert.equal(progress.next.children.length,4);
 const prompt=progress.next.request.messages[1].content,packed=JSON.parse(prompt.split('\n').at(-1));
 assert.equal(packed.length,4);
 assert.ok(packed.every(node=>Number.isFinite(node.timeRange.startMs)&&node.timeRange.endMs>node.timeRange.startMs));
 assert.match(prompt,/Boundary IDs:/);
 assert.ok(progress.next.request.inputUpper<=4800);
 assert.deepEqual(progress.next.left.evidenceIds.every(id=>id>=1&&id<=1226),true);
});

test('oversized section evidence stops before synthesis instead of silently dropping notes',async()=>{
 const p=await plan(),rows=new Map();
 for(const stage of p.stages.filter(s=>['NEW_HELD_LEAF','NEW_LEAF'].includes(s.kind)))rows.set(stage.key,{state:'DONE',planSha256:p.planSha256,requestSha256:stage.requestSha256,response:report(stage.segments),actualTotalTokens:400});
 const stage=p.stages.find(s=>s.kind==='NEW_LEAF'),large=report(stage.segments);
 large.claims=Array.from({length:12},()=>item('evidence '.repeat(32),[stage.firstId,stage.lastId]));
 rows.get(stage.key).response=large;
 await assert.rejects(fullCoverageGlobalContext({plan:p,records:rows,segments,raw}),/SYNTHESIS_STAGE_NOTE_LIMIT/);
});

test('62 bounded evidence notes finish in the quoted 21 four-way calls with all time ranges',async()=>{
 const sourceSegments=Array.from({length:62},(_,i)=>({id:i+1,startMs:i*1000,endMs:i*1000+900,text:'fixture'}));
 const notes=sourceSegments.map((segment,index)=>({index,stage:Math.floor(index/2),text:'[]',evidenceIds:[segment.id],boundarySegmentIds:[],provenance:'AI_VALIDATED_RAW_CHECKPOINT',timeRange:{firstId:segment.id,lastId:segment.id,startMs:segment.startMs,endMs:segment.endMs}}));
 const savedNodes=new Map();let progress=await synthesisTreeProgress({notes,sourceSegments,verifyGrounding:()=>{},savedNodes,fanout:4});
 while(!progress.complete){
  const next=progress.next,refs=[...new Set(next.children.flatMap(node=>[node.evidenceIds[0],node.evidenceIds.at(-1)]))];
  const response={summary:[item('fixture',refs)],chapters:[item('fixture',refs)],claims:[],numbers:[],critical:[],conclusion:'fixture'};
  assert.ok(next.request.inputUpper<=4800);
  savedNodes.set(next.key,await persistedSynthesisNode({next,response,sourceSegments,verifyGrounding:()=>{}}));
  progress=await synthesisTreeProgress({notes,sourceSegments,verifyGrounding:()=>{},savedNodes,fanout:4});
 }
 assert.equal(savedNodes.size,21);
 assert.equal(progress.root.firstNote,0);
 assert.equal(progress.root.lastNote,61);
 assert.deepEqual(progress.root.evidenceIds,sourceSegments.map(segment=>segment.id));
 assert.deepEqual(progress.root.timeRange,{firstId:1,lastId:62,startMs:0,endMs:61900});
});

test('response commit followed by lost ACK is read back without a second dispatch',async()=>{
 const p=await plan(),records=new Map(),stage=p.stages.find(s=>s.kind==='NEW_HELD_LEAF');let calls=0;
 const store={
  async claim(binding){records.set(binding.key,{state:'CLAIMED',...binding});return true;},
  async verifyBeforeDispatch(){return true;},
  async completeWithReceipt(binding,row){records.set(binding.key,row);throw Error('ACK_LOST');},
  async load(binding){return records.get(binding.key);},
 };
 const dispatch=async()=>{calls++;return {text:JSON.stringify(report(stage.segments)),usage:{inputTokens:400,outputTokens:200,totalTokens:600}};};
 const args={plan:p,records,ledger:[],store,dispatch,approval:{providerFreeBound:true,acknowledgeNewCallForUncertainRaw8:true,expiresAt:Date.now()+3600000},reviewedUncertainIds:[]};
 const first=await executeFullCoverageStep(args);
 assert.deepEqual({state:first.state,recoveredAckLoss:first.recoveredAckLoss,actualTotalTokens:first.actualTotalTokens},{state:'DONE',recoveredAckLoss:true,actualTotalTokens:600});
 assert.equal(records.get(stage.key).state,'DONE');
 assert.equal(calls,1);
 assert.equal(nextFullCoverageStage(p,records).stage.key,'leaf:0');
});

test('unconfirmed receipt write blocks finalization and same-operation replay',async()=>{
 const p=await plan(),records=new Map(),stage=p.stages.find(s=>s.kind==='NEW_HELD_LEAF');let calls=0;
 const store={async claim(binding){records.set(binding.key,{state:'CLAIMED',...binding});return true;},async verifyBeforeDispatch(){return true;},async completeWithReceipt(){throw Error('DB_OFFLINE');},async load(){return null;}};
 const dispatch=async()=>{calls++;return {text:JSON.stringify(report(stage.segments)),usage:{inputTokens:300,outputTokens:200,totalTokens:500}};};
 const args={plan:p,records,ledger:[],store,dispatch,approval:{providerFreeBound:true,acknowledgeNewCallForUncertainRaw8:true,expiresAt:Date.now()+3600000}};
 assert.equal((await executeFullCoverageStep(args)).reason,'RECEIPT_PERSISTENCE_UNKNOWN');
 assert.equal((await executeFullCoverageStep(args)).state,'REVIEW_REQUIRED');
 assert.equal(calls,1);
 assert.throws(()=>assembleFullCoverageReport({plan:p,records,segments,raw,legacyFailureEvidence:[{operationId:'old:raw:8',actualTotalTokens:100}]}),/FULL_FINAL_NOT_READY/);
});

test('provider uncertainty and over-bound usage preserve the claim and stop continuation',async()=>{
 const p=await plan(),stage=p.stages.find(s=>s.kind==='NEW_HELD_LEAF');
 for(const outcome of ['throw','overBound']){
  const records=new Map(),store={
   async claim(binding){records.set(binding.key,{state:'CLAIMED',...binding});return true;},
   async verifyBeforeDispatch(){return true;},
   async markUncertain(binding){records.set(binding.key,{state:'FAILED_UNCERTAIN',...binding});},
   async completeWithReceipt(){throw Error('must not settle invalid receipt');},
   async load(){return null;},
  };
  const dispatch=async()=>{if(outcome==='throw')throw Error('network outcome unknown');return {text:JSON.stringify(report(stage.segments)),usage:{inputTokens:stage.reservationTokens,outputTokens:1,totalTokens:stage.reservationTokens+1}};};
  const args={plan:p,records,ledger:[],store,dispatch,approval:{providerFreeBound:true,acknowledgeNewCallForUncertainRaw8:true,expiresAt:Date.now()+3600000}};
  assert.equal((await executeFullCoverageStep(args)).state,'REVIEW_REQUIRED');
  assert.equal(records.get(stage.key).state,'FAILED_UNCERTAIN');
  assert.equal(nextFullCoverageStage(p,records).state,'REVIEW_REQUIRED');
 }
});

test('final report save and readback are required before success',async()=>{
 const p=await plan(),records=new Map();for(const stage of p.stages.filter(s=>['NEW_HELD_LEAF','NEW_LEAF'].includes(s.kind)))records.set(stage.key,{state:'DONE',planSha256:p.planSha256,requestSha256:stage.requestSha256,response:report(stage.segments),actualTotalTokens:400});
 let saved;
 const result=await finalizeFullCoverage({plan:p,records,segments,raw,legacyFailureEvidence:[{operationId:'old:raw:8',actualTotalTokens:100}],store:{async saveFinalReport({report}){saved=report;return true;},async readFinalReport(){return saved;}}});
 assert.equal(result.readBackVerified,true);
 await assert.rejects(finalizeFullCoverage({plan:p,records,segments,raw,legacyFailureEvidence:[{operationId:'old:raw:8',actualTotalTokens:100}],store:{async saveFinalReport(){return true;},async readFinalReport(){return null;}}}),/FULL_FINAL_READBACK_FAILED/);
});
