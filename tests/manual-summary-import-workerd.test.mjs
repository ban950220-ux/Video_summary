import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';

// Entirely synthetic temporary D1 data. No remote service, API key, real
// analysis identifier or user-authored transcript/summary is used here.
const origin='https://example.invalid';
const stamp='2025-01-01T00:00:00.000Z';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const request=(path,method='GET',body)=>new Request(origin+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
const sqls=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);
const base=jobId=>`/api/jobs/${jobId}/imported-summaries`;
const requests=jobId=>`/api/jobs/${jobId}/imported-summary-requests`;
const segments=[{id:1,startMs:0,endMs:1000,text:'Synthetic opening.'},{id:2,startMs:1000,endMs:2000,text:'Synthetic middle.'},{id:3,startMs:2000,endMs:3000,text:'Synthetic ending.'}];

test('temporary Workerd D1 imported-summary storage and race boundaries',async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'synthetic-manual-import',modules:true,script:'export default {fetch(){return new Response("synthetic local fixture")}}',d1Databases:{DB:'synthetic-manual-import'}}]}));
 const originalFetch=globalThis.fetch;let providerCalls=0;
 globalThis.fetch=async()=>{providerCalls++;throw Error('Provider/network requests forbidden in this fixture');};
 try{
  const DB=await mf.getD1Database('DB');
  for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of sqls(file))await DB.prepare(sql).run();
  const env={DB,ALLOW_PAID_API:'false'};
  const call=(path,method='GET',body,db=DB)=>routeApi(request(path,method,body),{...env,DB:db});
  const get=async path=>{const response=await call(path);assert.equal(response.status,200);return response.json();};
  const seed=async({owner='owner',source=true,report=null}={})=>{
   const id=crypto.randomUUID();
   await DB.prepare('INSERT INTO jobs(id,owner_id,video_id,title,source_url,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,owner,'synthVideo1','Synthetic attachment analysis','https://example.invalid/video/synthetic','audio','TRANSCRIPT_UNVERIFIED',3,stamp,stamp,JSON.stringify(report),'{"verification":"NOT_VERIFIED","synthetic":true}').run();
   if(source)await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(id,'Synthetic transcript only.',JSON.stringify(segments),'SYNTHETIC_TRANSCRIPT_FIXTURE',stamp).run();
   await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'synthetic-provider',1,'FAILED_UNCERTAIN',?,'SYNTHETIC_ERROR','{\"synthetic\":true}')").bind(id+':synthetic-op',id,stamp).run();
   await DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,'synthetic-provider','SYNTHETIC_ONLY','synthetic-unit',1,0,0,'SYNTHETIC_ONLY',?)").bind(crypto.randomUUID(),id,owner,stamp).run();
   return id;
  };
  const source=async id=>get(base(id)+'/source');
  const payload=async(id,bytes=Buffer.from('Synthetic imported summary.\r\n'),requestId=crypto.randomUUID())=>{
   const {sourceSha256}=await source(id),artifactSha256=hash(bytes);
   return {requestId,sourceSha256,artifactSha256,artifactBase64:bytes.toString('base64'),provenance:'EXISTING_TRANSCRIPT_IMPORTED',basis:{method:'OWNER_SOURCE_RECONCILIATION',sourceSha256,artifactSha256,ownerConfirmed:true}};
  };
  const preserve=async id=>({job:await DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first(),source:await DB.prepare('SELECT * FROM yta_sources WHERE job_id=?').bind(id).first(),operations:(await DB.prepare('SELECT * FROM yta_operations WHERE job_id=? ORDER BY id').bind(id).all()).results,usage:(await DB.prepare('SELECT * FROM usage_events WHERE job_id=? ORDER BY id').bind(id).all()).results});
  const counts=async id=>({imports:(await DB.prepare('SELECT COUNT(*) n FROM yta_summary_imports WHERE job_id=?').bind(id).first()).n,requests:(await DB.prepare('SELECT COUNT(*) n FROM yta_summary_import_requests WHERE job_id=?').bind(id).first()).n});
  const error=async(response,status,code)=>{assert.equal(response.status,status);assert.equal((await response.json()).error.code,code);};

  await t.test('pending local migration is atomic, additive and idempotent with existing records preserved',async()=>{
   const id=await seed(),before=await preserve(id),pending=sqls('../migrations/pending/0021_manual_summary_imports.sql');
   const names=async()=>(await DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).results.map(row=>row.name),original=await names();
   await assert.rejects(DB.batch([...pending.map(sql=>DB.prepare(sql)),DB.prepare('INSERT INTO nonexistent_synthetic_table VALUES(1)')]));
   assert.deepEqual(await names(),original);assert.deepEqual(await preserve(id),before);
   await DB.batch(pending.map(sql=>DB.prepare(sql)));
   assert.deepEqual((await names()).filter(name=>!original.includes(name)).sort(),['yta_summary_import_requests','yta_summary_imports']);assert.deepEqual(await preserve(id),before);
   await DB.batch(pending.map(sql=>DB.prepare(sql)));assert.deepEqual(await preserve(id),before);assert.deepEqual(await counts(id),{imports:0,requests:0});
  });

  await t.test('exact UTF-8 BOM and CRLF round trip, safe provenance and preserved original rows',async()=>{
   const id=await seed({report:{kind:'SYNTHETIC_ORIGINAL_REPORT',summary:['Synthetic existing report.']}}),before=await preserve(id),bytes=Buffer.from('\ufeff합성 요약.\r\n<script>synthetic text only</script>\n'),body=await payload(id,bytes);
   const response=await call(base(id),'POST',body);assert.equal(response.status,201);
   const saved=await response.json();assert.equal(saved.state,'COMMITTED');assert.equal(saved.reused,false);assert.equal(saved.summary.provenance,'EXISTING_TRANSCRIPT_IMPORTED');assert.equal(saved.summary.providerExecution,'NOT_RUN_BY_APP');assert.equal(saved.summary.automaticSummaryCompleted,false);assert.equal(saved.summary.independentlyVerified,false);
   const detail=await get(base(id)+'/'+saved.summary.id);assert.equal(detail.summary.text,bytes.toString('utf8'));assert.equal(detail.summary.artifactBytes,bytes.byteLength);
   const exported=await call(base(id)+'/'+saved.summary.id+'/export');assert.equal(exported.status,200);assert.match(exported.headers.get('content-type'),/^text\/plain/);assert.deepEqual(Buffer.from(await exported.arrayBuffer()),bytes);
   const list=await get(base(id));assert.equal(list.summaries.length,1);assert.equal(Object.hasOwn(list.summaries[0],'text'),false);
   const jobs=await get('/api/jobs');assert.equal(jobs.jobs.find(job=>job.id===id).importedSummaryCount,1);
   assert.deepEqual(await preserve(id),before);
  });

  await t.test('same request replay and new request duplicate resolve the same immutable attachment',async()=>{
   const id=await seed(),body=await payload(id),first=await(await call(base(id),'POST',body)).json();
   const replay=await call(base(id),'POST',body);assert.equal(replay.status,200);assert.equal((await replay.json()).summary.id,first.summary.id);
   const duplicate=await call(base(id),'POST',{...body,requestId:crypto.randomUUID()});assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).summary.id,first.summary.id);
   assert.deepEqual(await counts(id),{imports:1,requests:2});
  });
  await t.test('same request changed content conflicts, new content appends a revision without overwrite',async()=>{
   const id=await seed(),first=await payload(id),saved=await(await call(base(id),'POST',first)).json();
   const changed=await payload(id,Buffer.from('Synthetic second revision.'),first.requestId);
   await error(await call(base(id),'POST',changed),409,'MANUAL_IMPORT_REQUEST_CONFLICT');
   const second=await(await call(base(id),'POST',{...changed,requestId:crypto.randomUUID()})).json();assert.equal(second.summary.revision,2);
   assert.equal((await get(base(id)+'/'+saved.summary.id)).summary.text,Buffer.from(first.artifactBase64,'base64').toString('utf8'));
   assert.deepEqual(await counts(id),{imports:2,requests:2});
  });
  await t.test('concurrent identical clicks and distinct request duplicates create one content row',async()=>{
   const id=await seed(),body=await payload(id);
   const responses=await Promise.all([call(base(id),'POST',body),call(base(id),'POST',body),call(base(id),'POST',{...body,requestId:crypto.randomUUID()})]);
   assert.deepEqual(responses.map(response=>response.status).sort(),[200,200,201]);assert.deepEqual(await counts(id),{imports:1,requests:2});
  });
  await t.test('concurrent conflicting content on one request cannot leave an orphan attachment',async()=>{
   const id=await seed(),first=await payload(id),second=await payload(id,Buffer.from('Different synthetic body.'),first.requestId);
   const responses=await Promise.all([call(base(id),'POST',first),call(base(id),'POST',second)]);assert.deepEqual(responses.map(response=>response.status).sort(),[201,409]);assert.deepEqual(await counts(id),{imports:1,requests:1});
  });
  await t.test('source mismatch, basis mismatch and provenance claims fail before any write',async()=>{
   const id=await seed(),body=await payload(id),before=await preserve(id);
   const checks=[
    [{...body,sourceSha256:'a'.repeat(64),basis:{...body.basis,sourceSha256:'a'.repeat(64)}},'SOURCE_HASH_MISMATCH'],
    [{...body,basis:{...body.basis,sourceSha256:'a'.repeat(64)}},'BASIS_HASH_MISMATCH'],
    [{...body,basis:{...body.basis,artifactSha256:'b'.repeat(64)}},'BASIS_HASH_MISMATCH'],
    [{...body,provenance:'PROVIDER_SUCCEEDED'},'PROVENANCE_MISMATCH'],
    [{...body,basis:{...body.basis,ownerConfirmed:false}},'BASIS_REQUIRED'],
   ];
   for(const [input,code] of checks)await error(await call(base(id),'POST',input),409,'MANUAL_IMPORT_'+code);
   assert.deepEqual(await counts(id),{imports:0,requests:0});assert.deepEqual(await preserve(id),before);
  });
  await t.test('hash mismatch, coercion, forged fields, malformed and duplicate-key JSON are rejected',async()=>{
   const id=await seed(),body=await payload(id);
   const mismatched={...body,artifactSha256:'c'.repeat(64),basis:{...body.basis,artifactSha256:'c'.repeat(64)}};
   await error(await call(base(id),'POST',mismatched),409,'MANUAL_IMPORT_ARTIFACT_HASH_MISMATCH');
   for(const input of [{...body,requestId:[body.requestId]},{...body,sourceSha256:[body.sourceSha256]},{...body,artifactSha256:[body.artifactSha256]},{...body,ownerId:'other'},{...body,providerReceipt:{success:true}},{...body,automaticSummaryCompleted:true}])await error(await call(base(id),'POST',input),400,'MANUAL_IMPORT_INVALID_REQUEST');
   const duplicate=JSON.stringify(body).replace('"requestId":','"requestId":"11111111-1111-4111-8111-111111111111","requestId":');
   await error(await call(base(id),'POST',duplicate),400,'MANUAL_IMPORT_NONCANONICAL_JSON');
   await error(await call(base(id),'POST','{broken}'),400,'MANUAL_IMPORT_INVALID_JSON');
   assert.deepEqual(await counts(id),{imports:0,requests:0});
  });
  await t.test('UTF-8 byte limit counts Korean bytes and rejects invalid UTF-8, controls and blank files',async()=>{
   const id=await seed(),exact=Buffer.from('가'.repeat(333333)+'a');assert.equal(exact.byteLength,1000000);
   assert.equal((await call(base(id),'POST',await payload(id,exact))).status,201);
   await error(await call(base(id),'POST',await payload(id,Buffer.concat([exact,Buffer.from('b')]))),413,'MANUAL_IMPORT_ARTIFACT_TOO_LARGE');
   await error(await call(base(id),'POST',await payload(id,Buffer.from([0xc3,0x28]))),400,'MANUAL_IMPORT_ARTIFACT_UTF8');
   await error(await call(base(id),'POST',await payload(id,Buffer.from('Synthetic\u0000text'))),400,'MANUAL_IMPORT_ARTIFACT_TEXT');
   await error(await call(base(id),'POST',await payload(id,Buffer.from(' \r\n\t'))),400,'MANUAL_IMPORT_ARTIFACT_TEXT');
   assert.equal((await counts(id)).imports,1);
  });
  await t.test('canonical base64 and streamed request byte limits cannot be bypassed',async()=>{
   const id=await seed(),body=await payload(id,Buffer.from('f'));
   for(const artifactBase64 of ['Zh==','Zg=','Zg==\n',[],null])await error(await call(base(id),'POST',{...body,artifactBase64}),400,'MANUAL_IMPORT_ARTIFACT_ENCODING');
   const oversized=new Request(origin+base(id),{method:'POST',headers:{'content-type':'application/json','content-length':'1400001'},body:'{}'});
   await error(await routeApi(oversized,env),413,'MANUAL_IMPORT_BODY_TOO_LARGE');
   const streamed=new Request(origin+base(id),{method:'POST',headers:{'content-type':'application/json','content-length':'2'},body:' '.repeat(1400001)});
   await error(await routeApi(streamed,env),413,'MANUAL_IMPORT_BODY_TOO_LARGE');assert.deepEqual(await counts(id),{imports:0,requests:0});
  });
  await t.test('source structure is validated without treating overlaps as audio verification',async()=>{
   const id=await seed();
   for(const value of [[{id:2,startMs:0,endMs:1000,text:'Synthetic invalid ID.'}],[{id:1,startMs:0,endMs:4000,text:'Synthetic outside duration.'}],[{id:1,startMs:0,endMs:1000,text:' '}],[{id:1,startMs:500,endMs:1000,text:'First.'},{id:2,startMs:0,endMs:2000,text:'Out of order.'}]]){
    await DB.prepare('UPDATE yta_sources SET segments_json=? WHERE job_id=?').bind(JSON.stringify(value),id).run();await error(await call(base(id)+'/source'),409,'MANUAL_IMPORT_SOURCE_INVALID');
   }
   await DB.prepare('UPDATE yta_sources SET segments_json=? WHERE job_id=?').bind(JSON.stringify([{id:1,startMs:0,endMs:2000,text:'Synthetic overlap A.'},{id:2,startMs:1000,endMs:3000,text:'Synthetic overlap B.'}]),id).run();
   const view=await source(id);assert.equal(view.segmentCount,2);assert.equal(view.independentlyVerified,false);assert.equal(view.automaticSummaryCompleted,false);
  });
  await t.test('foreign owner, foreign analysis and missing source cannot be accessed or mutated',async()=>{
   const own=await seed(),body=await payload(own),saved=await(await call(base(own),'POST',body)).json(),foreign=await seed({owner:'someone-else'}),withoutSource=await seed({source:false});
   for(const path of [base(foreign),base(foreign)+'/source',base(foreign)+'/'+saved.summary.id,base(foreign)+'/'+saved.summary.id+'/export',requests(foreign)+'/'+body.requestId])await error(await call(path),404,'MANUAL_IMPORT_NOT_FOUND');
   await error(await call(base(foreign),'POST',body),404,'MANUAL_IMPORT_NOT_FOUND');
   await error(await call(requests(foreign)+'/'+body.requestId+'/cancel','POST',{}),404,'MANUAL_IMPORT_NOT_FOUND');
   await error(await call(base(withoutSource)+'/source'),409,'MANUAL_IMPORT_SOURCE_REQUIRED');
   await error(await call(base(withoutSource),'POST',body),409,'MANUAL_IMPORT_SOURCE_REQUIRED');
   const another=await seed();await error(await call(base(another)+'/'+saved.summary.id),404,'MANUAL_IMPORT_NOT_FOUND');
  });
  await t.test('interruption before commit leaves no writes; lost commit ACK is recovered by GET only',async()=>{
   const id=await seed(),body=await payload(id),before=await preserve(id);
   const beforeCommit={prepare:sql=>DB.prepare(sql),batch:async()=>{throw Error('Synthetic interrupted before commit');}};
   await error(await call(base(id),'POST',body,beforeCommit),503,'MANUAL_IMPORT_WRITE_UNCERTAIN');assert.deepEqual(await counts(id),{imports:0,requests:0});assert.equal((await get(requests(id)+'/'+body.requestId)).state,'NOT_FOUND');
   const afterCommit={prepare:sql=>DB.prepare(sql),async batch(items){await DB.batch(items);throw Error('Synthetic lost commit ACK');}};
   await error(await call(base(id),'POST',body,afterCommit),503,'MANUAL_IMPORT_WRITE_UNCERTAIN');
   const restored=await get(requests(id)+'/'+body.requestId);assert.equal(restored.state,'COMMITTED');assert.equal((await get(base(id)+'/'+restored.summary.id)).summary.text,Buffer.from(body.artifactBase64,'base64').toString('utf8'));
   assert.deepEqual(await counts(id),{imports:1,requests:1});assert.deepEqual(await preserve(id),before);
  });
  await t.test('second statement failure rolls back both attachment and request',async()=>{
   const id=await seed(),body=await payload(id);
   const broken={prepare:sql=>DB.prepare(sql),batch:items=>DB.batch([items[0],DB.prepare('INSERT INTO nonexistent_synthetic_table VALUES(1)')])};
   await error(await call(base(id),'POST',body,broken),503,'MANUAL_IMPORT_WRITE_UNCERTAIN');assert.deepEqual(await counts(id),{imports:0,requests:0});
  });
  await t.test('cancel before submit, repeated cancel and save-then-cancel report actual durable state',async()=>{
   const id=await seed(),body=await payload(id),cancel=()=>call(requests(id)+'/'+body.requestId+'/cancel','POST',{});
   assert.equal((await(await cancel()).json()).state,'CANCELLED');assert.equal((await(await cancel()).json()).state,'CANCELLED');
   const cancelled=await call(base(id),'POST',body);assert.equal(cancelled.status,200);assert.equal((await cancelled.json()).state,'CANCELLED');assert.deepEqual(await counts(id),{imports:0,requests:1});
   const second=await payload(id);assert.equal((await call(base(id),'POST',second)).status,201);
   const savedCancel=await(await call(requests(id)+'/'+second.requestId+'/cancel','POST',{})).json();assert.equal(savedCancel.state,'COMMITTED');assert.ok(savedCancel.summary.id);assert.deepEqual(await counts(id),{imports:1,requests:2});
  });
  await t.test('cancellation winning immediately before the atomic batch prevents content storage',async()=>{
   const id=await seed(),body=await payload(id);let fired=false;
   const cancelFirst={prepare:sql=>DB.prepare(sql),async batch(items){if(!fired){fired=true;assert.equal((await(await call(requests(id)+'/'+body.requestId+'/cancel','POST',{})).json()).state,'CANCELLED');}return DB.batch(items);}};
   const response=await call(base(id),'POST',body,cancelFirst);assert.equal(response.status,200);assert.equal((await response.json()).state,'CANCELLED');assert.equal(fired,true);assert.deepEqual(await counts(id),{imports:0,requests:1});
  });
  const races={
   raw:id=>DB.prepare("UPDATE yta_sources SET raw='Concurrent synthetic source.' WHERE job_id=?").bind(id).run(),
   segments:id=>DB.prepare('UPDATE yta_sources SET segments_json=? WHERE job_id=?').bind(JSON.stringify([{id:1,startMs:0,endMs:3000,text:'Changed synthetic segment.'}]),id).run(),
   provenance:id=>DB.prepare("UPDATE yta_sources SET provenance='SYNTHETIC_REVISED_ORIGIN' WHERE job_id=?").bind(id).run(),
   sourceVersion:id=>DB.prepare("UPDATE yta_sources SET updated_at='2025-01-02T00:00:00.000Z' WHERE job_id=?").bind(id).run(),
   owner:id=>DB.prepare("UPDATE jobs SET owner_id='someone-else' WHERE id=?").bind(id).run(),
   video:id=>DB.prepare("UPDATE jobs SET video_id='synthVideo2' WHERE id=?").bind(id).run(),
   duration:id=>DB.prepare('UPDATE jobs SET duration_seconds=4 WHERE id=?').bind(id).run(),
   deletion:id=>DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'deletion',0,'DELETING',?)").bind(id+':deleting',id,stamp).run(),
   missingJob:id=>DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run(),
  };
  for(const [name,mutate] of Object.entries(races))await t.test(`atomic owner/source/deletion guard rejects ${name} race without content or parent changes`,async()=>{
   const id=await seed(),body=await payload(id);let after,fired=false;
   const racing={prepare:sql=>DB.prepare(sql),async batch(items){if(!fired){fired=true;await mutate(id);after=await preserve(id);}return DB.batch(items);}};
   await error(await call(base(id),'POST',body,racing),409,'MANUAL_IMPORT_STATE_CHANGED');assert.equal(fired,true);assert.deepEqual(await counts(id),{imports:0,requests:0});assert.deepEqual(await preserve(id),after);
  });
  await t.test('changed stored content fails integrity readback, export and reconciliation',async()=>{
   const id=await seed(),body=await payload(id),saved=await(await call(base(id),'POST',body)).json();
   await DB.prepare("UPDATE yta_summary_imports SET content_text='Synthetic corrupt content.' WHERE id=?").bind(saved.summary.id).run();
   for(const path of [base(id)+'/'+saved.summary.id,base(id)+'/'+saved.summary.id+'/export',requests(id)+'/'+body.requestId])await error(await call(path),409,'MANUAL_IMPORT_STORAGE_INTEGRITY');
  });
  await t.test('request binding corruption fails reconciliation and list pagination exposes only metadata',async()=>{
   const id=await seed(),first=await payload(id),second=await payload(id,Buffer.from('Synthetic second page.'));
   await call(base(id),'POST',first);await call(base(id),'POST',second);
   const page=await get(base(id)+'?limit=1');assert.equal(page.summaries.length,1);assert.equal(page.hasMore,true);assert.equal(page.summaries[0].revision,2);assert.equal(Object.hasOwn(page.summaries[0],'content_text'),false);
   const older=await get(base(id)+'?limit=1&offset=1');assert.equal(older.hasMore,false);assert.equal(older.summaries[0].revision,1);
   await DB.prepare('UPDATE yta_summary_import_requests SET request_sha256=? WHERE job_id=? AND request_id=?').bind('f'.repeat(64),id,first.requestId).run();await error(await call(requests(id)+'/'+first.requestId),409,'MANUAL_IMPORT_STORAGE_INTEGRITY');
  });
  await t.test('keyset pagination remains stable across appends and never clamps invalid offsets',async()=>{
   const id=await seed();
   for(let i=1;i<=3;i++)assert.equal((await call(base(id),'POST',await payload(id,Buffer.from('Synthetic revision '+i)))).status,201);
   const first=await get(base(id)+'?limit=2');assert.deepEqual(first.summaries.map(row=>row.revision),[3,2]);assert.equal(first.nextBeforeRevision,2);
   assert.equal((await call(base(id),'POST',await payload(id,Buffer.from('Synthetic revision 4')))).status,201);
   const older=await get(base(id)+'?limit=2&beforeRevision='+first.nextBeforeRevision);assert.deepEqual(older.summaries.map(row=>row.revision),[1]);assert.equal(older.hasMore,false);assert.equal(older.nextBeforeRevision,null);
   assert.equal((await get(base(id)+'?offset=10001')).summaries.length,0);
   for(const query of ['offset=-1','offset=1.5','offset=9007199254740992','beforeRevision=0','beforeRevision=2&offset=1','limit=0','limit=51'])await error(await call(base(id)+'?'+query),400,'MANUAL_IMPORT_INVALID_PAGINATION');
  });
  await t.test('existing explicit analysis deletion scrubs imported content and blocks late writes',async()=>{
   const id=await seed(),body=await payload(id);assert.equal((await call(base(id),'POST',body)).status,201);
   assert.equal((await call('/api/jobs/'+id,'DELETE')).status,200);assert.deepEqual(await counts(id),{imports:0,requests:0});await error(await call(base(id),'POST',body),404,'MANUAL_IMPORT_NOT_FOUND');
  });
  await t.test('missing prepared migration fails closed without automatically creating tables',async()=>{
   await DB.prepare('ALTER TABLE yta_summary_imports RENAME TO synthetic_held_imports').run();
   const id=await seed();await error(await call(base(id)),503,'MANUAL_IMPORT_SCHEMA_REQUIRED');assert.equal(await DB.prepare("SELECT name FROM sqlite_master WHERE name='yta_summary_imports'").first(),null);
   await DB.prepare('ALTER TABLE synthetic_held_imports RENAME TO yta_summary_imports').run();
  });
  assert.equal(providerCalls,0);
 }finally{globalThis.fetch=originalFetch;await mf.dispose();}
});
