import test from 'node:test';
import assert from 'node:assert/strict';
import {audioProgressPlan} from '../web/site/audio-progress-plan.mjs';

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
 assert.equal(audioProgressPlan({...base,chunks:[{...base.chunks[0],unknownCapacityProbeApproved:true}]},300,1000).nextKind,'UNKNOWN_CAPACITY_PROBE');
});

test('empty cleaned state and completed state never invent new work or time',()=>{
 const cleaned=audioProgressPlan({chunks:[],complete:false,temporaryResultsCleaned:true},600);
 assert.equal(cleaned.remainingChunks,0);
 assert.equal(cleaned.temporaryResultsCleaned,true);
 const complete=audioProgressPlan({chunks:[{index:0,start:0,end:600,state:'DONE'}],complete:true},600);
 assert.equal(complete.complete,true);
 assert.equal(complete.remainingSeconds,0);
});
