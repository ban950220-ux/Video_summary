import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchSupadataCaption,pollSupadataCaption,ProviderError} from '../src/adapters.mjs';
const env={ENABLE_LIVE_FREE:'true',SUPADATA_FREE_PLAN_CONFIRMED:'true',ALLOW_PAID_API:'false',SUPADATA_API_KEY:'test_only'};
const url='https://www.youtube.com/watch?v=2hUkTmwYm3A';
test('Supadata native-only request never enables ASR',async()=>{
  let called='';
  const mock=async (u)=>{called=u;return new Response(JSON.stringify({content:[{text:'hello',offset:0,duration:1000}],lang:'en'}),{status:200,headers:{'x-billable-requests':'1'}})};
  const result=await fetchSupadataCaption(url,env,mock);
  assert.equal(new URL(called).searchParams.get('mode'),'native');
  assert.equal(new URL(called).searchParams.get('text'),'false');
  assert.equal(result.billedCredits,1);
  assert.equal(result.segments[0].endMs,1000);
  assert.equal(result.provenance,'SUPADATA_NATIVE');
  assert.equal(result.audioVerified,false);
});
test('native response must preserve every timed segment or fail closed',async()=>{
  const reply=content=>async()=>new Response(JSON.stringify({content}),{status:200});
  for(const bad of [
    [{text:'ok',offset:0,duration:1000},{text:'lost',offset:null,duration:1000}],
    [{text:'ok',offset:1000,duration:1000},{text:'earlier',offset:0,duration:1000}],
    [],
    'untimed text'
  ]) await assert.rejects(()=>fetchSupadataCaption(url,env,reply(bad)),e=>e instanceof ProviderError&&e.code.startsWith('TRANSCRIPT_'));
});
test('pending native job polls without issuing another transcript creation request',async()=>{
  let calls=0;
  const start=await fetchSupadataCaption(url,env,async u=>{calls++;assert.equal(new URL(u).pathname,'/v1/transcript');return new Response(JSON.stringify({jobId:'job-123'}),{status:202});});
  assert.equal(start.status,'PENDING');
  const finished=await pollSupadataCaption(start.jobId,env,async u=>{calls++;assert.equal(new URL(u).pathname,'/v1/transcript/job-123');return new Response(JSON.stringify({status:'completed',result:{content:[{text:'hello',offset:0,duration:1000}]}}),{status:200});});
  assert.equal(finished.segments.length,1);
  assert.equal(calls,2);
});
test('Supadata 206 no captions is NOT zero-cost',async()=>{
  const result=await fetchSupadataCaption(url,env,async()=>new Response('none',{status:206,headers:{'x-billable-requests':'1'}}));
  assert.equal(result.status,'NO_CAPTIONS');
  assert.equal(result.billedCredits,1);
});
test('provider calls blocked without free-tier attestation',async()=>{
  await assert.rejects(()=>fetchSupadataCaption(url,{...env,SUPADATA_FREE_PLAN_CONFIRMED:'false'},async()=>{throw new Error('should not call')}),e=>e.code==='PLAN_UNVERIFIED');
});
