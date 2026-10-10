import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchSupadataCaption,ProviderError} from '../src/adapters.mjs';
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
});
test('Supadata 206 no captions is NOT zero-cost',async()=>{
  const result=await fetchSupadataCaption(url,env,async()=>new Response('none',{status:206,headers:{'x-billable-requests':'1'}}));
  assert.equal(result.status,'NO_CAPTIONS');
  assert.equal(result.billedCredits,1);
});
test('provider calls blocked without free-tier attestation',async()=>{
  await assert.rejects(()=>fetchSupadataCaption(url,{...env,SUPADATA_FREE_PLAN_CONFIRMED:'false'},async()=>{throw new Error('should not call')}),e=>e.code==='PLAN_UNVERIFIED');
});
