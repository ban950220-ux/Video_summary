import test from 'node:test';
import assert from 'node:assert/strict';
import {restStatement} from '../scripts/baseline-cloudflare-transport.mjs';
import {fixture,ready,reviewedInput,terminal,retained,fixtureCredential,fixtureBookmark} from './fixtures/baseline-operator-fixture.mjs';

test('authenticated fixed target plus explicit terminal confirmation registers one baseline without touching retained data',async()=>{
 const f=fixture();try{
  const before=retained(f.db),r=await ready(f),result=await f.session.register(r.grant);
  assert.equal(result.state,'RECORDED');assert.equal(result.authorization,'INJECTED_TERMINAL_NOT_PRODUCTION_PROOF');assert.equal(result.authentication,'INJECTED_TRANSPORT_NOT_PRODUCTION_PROOF');assert.equal(result.manualPauseEvidence,'OPERATOR_ATTESTED_NOT_API_PROVEN');assert.equal(f.writes.length,1);assert.equal(retained(f.db),before);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='d1_migrations'").get().n,0);
  assert.equal((await f.session.inspect()).state,'RECORDED');
  assert.equal(f.calls.filter(c=>c.path.endsWith('/time_travel/bookmark')).length,4);
  assert.match(r.tty.text(),/do not prove those manual facts/);assert.ok(!r.tty.text().includes(fixtureCredential));
  await assert.rejects(f.session.register(r.grant),/BASELINE_SESSION_GRANT_INVALID/);assert.equal(f.writes.length,1);
 }finally{f.close();}
});

test('REST integer parameters preserve SQL types, quoted question marks stay literal and values are not interpolated',()=>{
 assert.deepEqual(restStatement("SELECT '?' AS a, ? AS b, ? AS c",[123,"x'; DROP TABLE jobs; --"]),{sql:"SELECT '?' AS a, CAST(? AS INTEGER) AS b, ? AS c",params:['123',"x'; DROP TABLE jobs; --"]});
 for(const [sql,args] of [['SELECT ?',[]],['SELECT 1',['x']],['SELECT ?1',['x']],['SELECT ?',[null]],['SELECT ?',[Infinity]]])assert.throws(()=>restStatement(sql,args),/BASELINE_SQL_BINDING_INVALID/);
});

for(const kind of ['boolean-callback','non-tty','wrong-answer','forged-capability'])test(`${kind} cannot authorize writes`,async()=>{
 const f=fixture();try{
  const capture=await f.session.captureEvidence(),bundle=await reviewedInput(f,capture);
  if(kind==='forged-capability')await assert.rejects(f.session.register({kind:'BASELINE_OPERATOR_CAPABILITY_V1'}));
  else await assert.rejects(f.session.confirm(bundle.input,bundle.window,kind==='boolean-callback'?{input:true,output:true}:terminal({tty:kind!=='non-tty',wrong:kind==='wrong-answer'})));
  assert.equal(f.writes.length,0);
 }finally{f.close();}
});

for(const kind of ['target','bookmark','unauthenticated','redirect','secret-error'])test(`remote ${kind} failure never yields an approved session or leaks remote error text`,async()=>{
 const f=fixture({fetch:({u,response})=>{
  if(kind==='target'&&!u.pathname.endsWith('bookmark'))return response({uuid:'wrong',name:'youtube-ai-analyzer-private-db'});
  if(kind==='bookmark'&&u.pathname.endsWith('bookmark'))return response({bookmark:'secret/private/url'});
  if(kind==='unauthenticated')return response({message:fixtureCredential},403);
  if(kind==='redirect')return new Response('',{status:302,headers:{Location:'https://evil.invalid'}});
  if(kind==='secret-error')throw Error(fixtureCredential);
 }});try{await assert.rejects(f.session.captureEvidence(),e=>!e.message.includes(fixtureCredential));assert.equal(f.writes.length,0);}finally{f.close();}
});

for(const field of ['snapshot','restore','review','window','inventory','extra','scope','expiry'])test(`changed ${field} evidence blocks before confirmation/write`,async()=>{
 const f=fixture();try{
  const capture=await f.session.captureEvidence(),{input,window}=await reviewedInput(f,capture);
  if(field==='snapshot')input.dbSnapshot.digest='a'.repeat(64);
  if(field==='restore')input.controls.timeTravel.bookmark='00000000-00000000';
  if(field==='review')input.review.observationDigest='b'.repeat(64);
  if(field==='window')window.controlsDigest='c'.repeat(64);
  if(field==='inventory')window.writerInventoryDigest='d'.repeat(64);
  if(field==='extra')window.authorization=fixtureCredential;
  if(field==='scope')input.approval.action='MIGRATE';
  if(field==='expiry')f.advance(120001);
  const tty=terminal();await assert.rejects(f.session.confirm(input,window,tty));assert.equal(tty.text(),'');assert.equal(f.writes.length,0);
 }finally{f.close();}
});

test('final authenticated read cannot extend approval past expiry',async()=>{
 let reads=0;const f=fixture({fetch:({u,advance})=>{if(u.pathname.endsWith('bookmark')&&++reads===4)advance(120001);}});
 try{const r=await ready(f);await assert.rejects(f.session.register(r.grant),e=>e.code==='BASELINE_STOPPED_BEFORE_DISPATCH'&&e.reason==='BASELINE_CONFIRMATION_EXPIRED'&&e.writeSent===false);assert.equal(f.writes.length,0);assert.equal(f.session.status().writeSent,false);}finally{f.close();}
});

test('revoked authentication and a changed restore bookmark after confirmation stop before dispatch',async()=>{
 for(const kind of ['revoked','bookmark']){
  let confirmed=false;const f=fixture({fetch:({u,response})=>{if(confirmed)return kind==='revoked'?response({},401):u.pathname.endsWith('bookmark')?response({bookmark:fixtureBookmark.replace('00000001','00000002')}):undefined;}});
  try{const r=await ready(f);confirmed=true;await assert.rejects(f.session.register(r.grant));assert.equal(f.writes.length,0);}finally{f.close();}
 }
});

test('late in-flight operation rolls the entire baseline batch back while keeping old uncertainty',async()=>{
 const f=fixture({beforeWrite:({db})=>db.exec("INSERT INTO yta_operations VALUES('late','j','groq-summary',6600,'CLAIMED','t',NULL,NULL)")});
 try{const r=await ready(f);await assert.rejects(f.session.register(r.grant),/BASELINE_REGISTRATION_UNCONFIRMED/);assert.equal(f.writes.length,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='codex_schema_baselines'").get().n,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE state='FAILED_UNCERTAIN'").get().n,7);}finally{f.close();}
});

test('ACK loss reconciles by reads and never sends a second registration batch',async()=>{
 const f=fixture({ackLoss:true});try{const r=await ready(f),result=await f.session.register(r.grant);assert.equal(result.state,'RECOVERED_AFTER_ACK_LOSS');assert.equal(f.writes.length,1);await assert.rejects(f.session.register(r.grant));assert.equal(f.writes.length,1);}finally{f.close();}
});

test('unconfirmed commit with persistent read failure stays uncertain without replay',async()=>{
 const f=fixture({ackLoss:true,rejectReadsAfterWrite:true});try{const r=await ready(f);await assert.rejects(f.session.register(r.grant),e=>e.code==='BASELINE_REGISTRATION_UNCONFIRMED'&&!e.message.includes(fixtureCredential));assert.equal(f.session.status().phase,'WRITE_UNCONFIRMED');await assert.rejects(f.session.register(r.grant));assert.equal(f.writes.length,1);}finally{f.close();}
});

test('competing register calls and later caller mutation keep one immutable reviewed request',async()=>{
 const f=fixture();try{const r=await ready(f);r.input.controls.writersQuiesced=false;r.input.approval.action='MIGRATE';const values=await Promise.allSettled([f.session.register(r.grant),f.session.register(r.grant)]);assert.equal(values.filter(v=>v.status==='fulfilled').length,1);assert.equal(f.writes.length,1);assert.equal(JSON.parse(f.db.prepare('SELECT record_json FROM codex_schema_baselines').get().record_json).approvalDigest,JSON.parse(values.find(v=>v.status==='fulfilled').value.row.record_json).approvalDigest);}finally{f.close();}
});

test('abort/close revoke a confirmed session without network writes',async()=>{
 for(const kind of ['abort','close']){const controller=new AbortController(),f=fixture({signal:controller.signal});try{const r=await ready(f);if(kind==='abort')controller.abort();else f.session.close();await assert.rejects(f.session.register(r.grant));assert.equal(f.writes.length,0);}finally{f.close();}}
});

test('confirmation cannot outlive the reviewed expiry while waiting for a terminal reply',async()=>{
 const f=fixture();try{const capture=await f.session.captureEvidence(),bundle=await reviewedInput(f,capture);await assert.rejects(f.session.confirm(bundle.input,bundle.window,terminal({beforeReply:()=>f.advance(120001)})),/BASELINE_CONFIRMATION_EXPIRED/);assert.equal(f.writes.length,0);}finally{f.close();}
});

test('a genuine grant from another session cannot register this session',async()=>{
 const a=fixture(),b=fixture();try{const first=await ready(a),second=await ready(b);await assert.rejects(b.session.register(first.grant),/BASELINE_SESSION_GRANT_INVALID/);assert.equal(b.writes.length,0);await b.session.register(second.grant);assert.equal(b.writes.length,1);assert.equal(a.writes.length,0);}finally{a.close();b.close();}
});

test('window evidence is bound through the persisted controls digest and operator receipt',async()=>{
 const f=fixture();try{const r=await ready(f),result=await f.session.register(r.grant),record=JSON.parse(result.row.record_json);assert.equal(record.controlsDigest,r.input.approval.controlsDigest);assert.equal(result.operatorReceipt.operatorEvidenceDigest,r.input.controls.operatorEvidenceDigest);assert.equal(result.operatorReceipt.recordSha256,result.row.record_sha256);assert.equal('writerInventoryDigest' in record,false);}finally{f.close();}
});
