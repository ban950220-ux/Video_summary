import test from 'node:test';
import assert from 'node:assert/strict';
import {runAudioChunks} from '../web/site/audio-runner.mjs';

const chunks=[0,1,2].map(index=>({index,start:index*300,end:(index+1)*300}));
function fixture(){let clock=1000000,done=0,last=0;const sent=[],waits=[];const snapshot={provider:'gemini',model:'gemini-2.5-flash',valid_until:clock+60000,remaining:{requestsMinute:5,tokensMinute:100000,requestsDay:5},reserved:{requestsMinute:0,tokensMinute:0,requestsDay:0}};const grant={provider:'gemini',expires_at:clock+3600000,billing_disabled:1,request_count:0,request_limit:5,consumed:0,allowance:250000};return {
  sent,waits,snapshot,grant,now:()=>clock,
  getProgress:async()=>({chunks:chunks.map(c=>({index:c.index,state:c.index<done?'DONE':'PLANNED'})),complete:done===3,nextEligibleAt:{gemini:last?last+13000:null},operationInFlight:{gemini:false}}),
  getCapacity:async()=>({snapshots:[snapshot]}),getQuota:async()=>({grants:[grant]}),chooseProvider:()=> 'gemini',review429:async()=>null,
  wait:async ms=>{waits.push(ms);clock+=ms;},sendChunk:async c=>{sent.push({index:c.index,at:clock});done++;last=clock;grant.request_count++;grant.consumed+=18304;snapshot.reserved.requestsMinute++;snapshot.reserved.requestsDay++;snapshot.reserved.tokensMinute+=22880;return {state:'DONE'};}
 };}
test('foreground runner completes three chunks with server pacing and fresh shared capacity',async()=>{
 const f=fixture(),result=await runAudioChunks({chunks,...f});assert.equal(result.complete,true);assert.deepEqual(f.sent.map(row=>row.index),[0,1,2]);assert.deepEqual(f.sent.map(row=>row.at),[1000000,1013000,1026000]);assert.deepEqual(f.waits,[13000,13000]);
});
test('runner pauses before dispatch when summary has reserved shared Gemini tokens',async()=>{
 const f=fixture();f.snapshot.reserved.tokensMinute=90000;const result=await runAudioChunks({chunks,...f});assert.equal(result.complete,false);assert.equal(result.reason,'CAPACITY_OR_GRANT_REOBSERVATION_REQUIRED');assert.equal(f.sent.length,0);
});
test('runner pauses if observation expires before the next eligible request',async()=>{
 const f=fixture();f.snapshot.valid_until=1010000;const result=await runAudioChunks({chunks,...f});assert.equal(result.complete,false);assert.equal(result.index,1);assert.deepEqual(f.sent.map(row=>row.index),[0]);assert.equal(f.waits.length,0);
});
