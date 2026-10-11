import test from 'node:test';
import assert from 'node:assert/strict';
import {audioProgressPlan,cleanedAudioComplete} from '../web/site/audio-progress-plan.mjs';

test('completed source-time intervals count overlap once and preserve remaining chunks',()=>{
 const progress={complete:false,chunks:[
  {index:0,start:0,end:300,state:'DONE'},
  {index:1,start:297,end:600,state:'DONE'},
  {index:2,start:597,end:900,state:'UNCERTAIN',uncertainFailure:true},
  {index:3,start:897,end:1200,state:'PLANNED'},
 ]};
 const plan=audioProgressPlan(progress,1200,1000);
 assert.equal(plan.coveredSeconds,600);
 assert.equal(plan.remainingSeconds,600);
 assert.equal(plan.remainingRequestSeconds,606);
 assert.equal(plan.referenceGroqUsd,606/3600*0.04);
 assert.equal(plan.completedChunks,2);
 assert.equal(plan.remainingChunks,2);
 assert.equal(plan.nextKind,'REVIEW_REQUIRED');
 assert.equal(plan.nextIndex,2);
 assert.equal(progress.chunks[2].state,'UNCERTAIN');
});

test('next step distinguishes provider retry, app earliest time and unknown capacity',()=>{
 const base={complete:false,chunks:[{index:0,start:0,end:300,state:'PAUSED',groqAllowed:true}],nextEligibleAt:{groq:5000,gemini:null}};
 assert.deepEqual([audioProgressPlan({...base,chunks:[{...base.chunks[0],reviewed429Required:true,resetAt:7000}]},300,1000).nextKind,audioProgressPlan(base,300,1000).nextKind,audioProgressPlan({...base,nextEligibleAt:{groq:null,gemini:null}},300,1000).nextKind],['PROVIDER_RETRY','LOCAL_EARLIEST','CAPACITY_UNKNOWN']);
 assert.equal(audioProgressPlan(base,300,1000).nextAt,5000);
 assert.equal(audioProgressPlan({...base,chunks:[{...base.chunks[0],unknownCapacityProbeApproved:true}]},300,1000).nextKind,'UNKNOWN_PROBE_WAIT');
});

test('empty cleaned state and completed state never invent new work or time',()=>{
 const cleaned=audioProgressPlan({chunks:[],complete:false,temporaryResultsCleaned:true},600);
 assert.equal(cleaned.valid,false);
 assert.equal(cleaned.temporaryResultsCleaned,true);
 const job={audit:{audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)}};
 assert.equal(cleanedAudioComplete({temporaryResultsCleaned:true},job),true);
 assert.equal(cleanedAudioComplete({temporaryResultsCleaned:true},{audit:{...job.audit,audioFileSha256:null}}),false);
 const complete=audioProgressPlan({chunks:[{index:0,start:0,end:600,state:'DONE'}],complete:true},600);
 assert.equal(complete.complete,true);
 assert.equal(complete.remainingSeconds,0);
});

test('reviewed uncertain recovery uses Groq cooldown, never earlier Gemini time',()=>{
 const base={chunks:[{index:5,start:1500,end:1800,state:'UNCERTAIN',reviewedFreeRetryApproved:true,groqAllowed:true}],nextEligibleAt:{groq:3600000,gemini:13000}};
 const plan=audioProgressPlan(base,1800,1000);
 assert.equal(plan.nextKind,'LOCAL_EARLIEST');
 assert.equal(plan.nextAt,3600000);
 const probe=audioProgressPlan({...base,chunks:[{...base.chunks[0],unknownCapacityProbeApproved:true}]},1800,1000);
 assert.equal(probe.nextKind,'UNKNOWN_PROBE_WAIT');
 assert.equal(probe.nextAt,3600000);
 assert.equal(audioProgressPlan({...base,nextEligibleAt:{groq:null,gemini:13000},chunks:[{...base.chunks[0],unknownCapacityProbeApproved:true}]},1800,1000).nextKind,'UNKNOWN_CAPACITY_PROBE');
});

test('in-flight recovery remains blocked and 429 retry uses later verified time',()=>{
 const chunk={index:0,start:0,end:300,state:'UNCERTAIN',reviewedFreeRetryApproved:true};
 const busy=audioProgressPlan({chunks:[chunk],operationInFlight:{groq:true,gemini:false},nextEligibleAt:{groq:5000,gemini:2000}},300,1000);
 assert.equal(busy.nextKind,'OPERATION_IN_FLIGHT');
 assert.equal(busy.nextAt,5000);
 const retry=audioProgressPlan({chunks:[{...chunk,reviewed429Required:true,reviewProvider:'groq',resetAt:4000}],nextEligibleAt:{groq:5000,gemini:2000}},300,1000);
 assert.equal(retry.nextKind,'PROVIDER_RETRY');
 assert.equal(retry.nextAt,5000);
});

test('invalid or missing boundaries never become zero-dollar quotes',()=>{
 for(const bad of [null,{index:0,state:'PLANNED'},...[[NaN,10],[0,Infinity],[20,10],[-1,10],[0,301]].map(([start,end])=>({index:0,start,end,state:'PLANNED'}))]){
  const plan=audioProgressPlan({chunks:[bad]},300);
  assert.equal(plan.valid,false);
  assert.equal(plan.quoteAvailable,false);
  assert.equal(plan.referenceGroqUsd,undefined);
 }
 assert.equal(audioProgressPlan({chunks:[]},300).valid,false);
 assert.equal(audioProgressPlan({chunks:[{index:0,start:0,end:10,state:'PLANNED'}]},null).valid,false);
});

test('quote includes per-request ten second minimum for a short tail',()=>{
 const plan=audioProgressPlan({chunks:[{index:0,start:0,end:8,state:'PLANNED'},{index:1,start:8,end:20,state:'PLANNED'}]},20);
 assert.equal(plan.remainingRequestSeconds,20);
 assert.equal(plan.billableGroqSeconds,22);
 assert.equal(plan.referenceGroqUsd,22/3600*0.04);
});
