import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
const env={ADMIN_TOKEN:'test-secret-with-at-least-24-chars',ENABLE_LIVE_FREE:'false'};
const req=(path,body=null,secret=env.ADMIN_TOKEN)=>new Request('https://private.example'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+secret,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
test('private endpoints reject unauthenticated requests',async()=>{
  const r=await worker.fetch(req('/api/usage',null,'wrong'),env);
  assert.equal(r.status,401);
});
test('health does not imply deployed production',async()=>{
  const j=await (await worker.fetch(req('/api/health'),env)).json();
  assert.equal(j.mode,'MOCK_ONLY');
  assert.equal(j.deployed,false);
});
test('preflight URL 120 minutes shows uncertain caption cost',async()=>{
  const res=await worker.fetch(req('/api/preflight',{sourceType:'url',durationSeconds:7200,url:'https://youtu.be/2hUkTmwYm3A'}),env);
  assert.equal(res.status,200);
  const j=await res.json();
  assert.equal(j.routes[0].creditsMax,1);
  assert.equal(j.routes[1].creditsMax,240);
});
test('URL-only job explicitly needs upload and cannot invent video content',async()=>{
  const r=await worker.fetch(req('/api/jobs',{sourceType:'url',durationSeconds:3600,url:'https://youtu.be/2hUkTmwYm3A'}),env);
  assert.equal(r.status,202);
  const j=await r.json();
  assert.equal(j.job.status,'NEED_UPLOAD');
  assert.equal(j.job.report,null);
  assert.equal(j.persisted,false);
});
test('SRT local import generates extractive report without false full verification',async()=>{
  const r=await worker.fetch(req('/api/jobs',{sourceType:'text',durationSeconds:120,filename:'demo.srt',transcript:'1\n00:00:00,000 --> 00:02:00,000\n시장 분석입니다.'}),env);
  assert.equal(r.status,201);
  const j=await r.json();
  assert.equal(j.job.status,'TRANSCRIPT_UNVERIFIED');
  assert.deepEqual(j.job.report.summary,['시장 분석입니다.']);
});
test('120-min duration hard gate',async()=>{
  const r=await worker.fetch(req('/api/preflight',{sourceType:'text',durationSeconds:8000}),env);
  assert.equal(r.status,400);
});
test('no fake persistence without D1',async()=>{
  const r=await worker.fetch(req('/api/jobs/11111111-1111-1111-1111-111111111111'),env);
  assert.equal(r.status,503);
});
test('usage never invents provider account exact remaining',async()=>{
  const j=await (await worker.fetch(req('/api/usage'),env)).json();
  assert.ok(j.providers.every(p=>p.accountQuota.provenance==='UNKNOWN'));
});
