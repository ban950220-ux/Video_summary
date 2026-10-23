import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {routeApi} from '../src/worker.mjs';
import {enqueueAcquisition,claimAcquisition} from '../src/local-runner-outbox.mjs';
import {runnerResumeEvidence} from '../src/local-runner-blocked-resume.mjs';
import {verifyFullCoverageTriggerDefinitions} from '../scripts/full-coverage-migration-preflight.mjs';

const dir=new URL('../migrations/',import.meta.url);
const all=readdirSync(dir).filter(x=>x.endsWith('.sql')).sort();
const stages=all.filter(x=>x>='0016'),prior=all.filter(x=>x<'0016');
const sql=name=>readFileSync(new URL(name,dir),'utf8');
const schema=db=>JSON.stringify(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all());
const history=db=>db.prepare('SELECT name FROM d1_migrations ORDER BY name').all().map(x=>x.name);
function apply(db,name,{fail=false,ackLost=false}={}){
 // Local transaction fixture mirrors Wrangler's SQL + migration-history unit.
 // It is not an operational D1 executor or a claim about network ACK delivery.
 db.exec('BEGIN');
 try{db.exec(sql(name));if(fail)db.exec('SELECT * FROM injected_missing_table');db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);db.exec('COMMIT');}
 catch(e){db.exec('ROLLBACK');throw e;}
 if(ackLost)throw Error('FIXTURE_COMMIT_ACK_LOST');
}
function base(path=':memory:'){
 const db=new DatabaseSync(path);db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
 for(const name of prior)apply(db,name);
 db.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES('11111111-1111-4111-8111-111111111111','owner','fixture','text','TRANSCRIPT_UNVERIFIED',60,'fixture','fixture',?,?)").run('{"summary":["KEEP REPORT"]}','{"status":"TRANSCRIPT_UNVERIFIED"}');
 db.exec("INSERT INTO yta_sources VALUES('11111111-1111-4111-8111-111111111111','KEEP SOURCE','[]','FIXTURE','fixture'); INSERT INTO yta_operations VALUES('uncertain','11111111-1111-4111-8111-111111111111','groq-summary',6600,'FAILED_UNCERTAIN','fixture','UNKNOWN','{\"receipt\":\"KEEP\"}'); INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,provenance,captured_at) VALUES('used','11111111-1111-4111-8111-111111111111','owner','groq','LIVE_FREE_SUMMARY','tokens',2169,'FIXTURE','fixture')");
 return db;
}
const retained=db=>JSON.stringify({job:db.prepare('SELECT id,owner_id,source_type,status,report_json,audit_json FROM jobs WHERE id=\'11111111-1111-4111-8111-111111111111\'').get(),source:db.prepare('SELECT * FROM yta_sources').all(),ops:db.prepare('SELECT * FROM yta_operations').all(),usage:db.prepare('SELECT * FROM usage_events').all()});
function binding(db){return {prepare(q){const make=args=>({q,args,bind(...values){return make(values);},async run(){return {success:true,meta:{changes:Number(db.prepare(q).run(...args).changes)}};},async first(){return db.prepare(q).get(...args)||null;},async all(){return {results:db.prepare(q).all(...args)};}});return make([]);},async batch(statements){db.exec('BEGIN');try{const result=statements.map(s=>({success:true,meta:{changes:Number(db.prepare(s.q).run(...s.args).changes)}}));db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};}
const req=(path,method='GET',body)=>new Request('https://fixture.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});

test('each 0016-0020 transaction can stop before commit, resume, and reconcile a lost commit ACK without replay',()=>{
 const folder=mkdtempSync(join(tmpdir(),'migration-sequence-')),path=join(folder,'local.sqlite');let db=base(path);
 try{
  const preserved=retained(db);
  for(const name of stages){
   const beforeSchema=schema(db),beforeHistory=history(db);
   assert.throws(()=>apply(db,name,{fail:true}),/injected_missing_table/);
   assert.equal(schema(db),beforeSchema);assert.deepEqual(history(db),beforeHistory);assert.equal(retained(db),preserved);
   assert.throws(()=>apply(db,name,{ackLost:true}),/FIXTURE_COMMIT_ACK_LOST/);
   const committedSchema=schema(db);db.close();db=new DatabaseSync(path);
   assert.equal(schema(db),committedSchema);assert.deepEqual(history(db),[...beforeHistory,name]);
   assert.equal(retained(db),preserved);
   // A verified history row plus matching full schema means skip, not replay.
   assert.ok(history(db).includes(name));
  }
  assert.throws(()=>db.exec(sql(stages[1])),/duplicate column name: submission_hash/);
  assert.throws(()=>db.exec(sql(stages[4])),/duplicate column name: attempt_id/);
 }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});

test('nontransactional partial DDL and old 0018 shape are not repaired by IF NOT EXISTS or fabricated history',()=>{
 const db=base();
 try{
  const first=sql(stages[0]).match(/CREATE TRIGGER[\s\S]*?END;/)[0];db.exec(first);
  const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'full_coverage_%'").all();
  assert.equal(verifyFullCoverageTriggerDefinitions(triggers).verified,false);
  assert.equal(history(db).includes(stages[0]),false);
  db.exec(sql(stages[2]).replace(' audio_link_manifest_sha256 TEXT,',''));
  db.exec(sql(stages[2]));
  assert.equal(db.prepare("SELECT name FROM pragma_table_info('yta_local_runner_outbox') WHERE name='audio_link_manifest_sha256'").get(),undefined);
  assert.equal(history(db).includes(stages[2]),false,'partial/schema-only state requires manual reconciliation');
  assert.throws(()=>db.exec(sql(stages[4])),/no such table: yta_local_runner_audio_dispatches/);
 }finally{db.close();}
});

test('0016 preserves old writers when idle and blocks source/proof edits during both relevant in-flight states',()=>{
 const db=base();
 try{
  apply(db,stages[0]);
  const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'full_coverage_%'").all();
  assert.equal(verifyFullCoverageTriggerDefinitions(triggers).verified,true);
  for(const provider of ['groq-full-coverage','groq-summary-synthesis'])for(const state of ['CLAIMED','RECEIPT_STORED']){
   db.prepare("INSERT INTO yta_operations VALUES('active','11111111-1111-4111-8111-111111111111',?,6600,?,'fixture',NULL,NULL)").run(provider,state);
   for(const q of ["UPDATE yta_sources SET raw='wrong' WHERE job_id='11111111-1111-4111-8111-111111111111'","DELETE FROM yta_sources WHERE job_id='11111111-1111-4111-8111-111111111111'","UPDATE jobs SET audit_json='{}' WHERE id='11111111-1111-4111-8111-111111111111'","DELETE FROM jobs WHERE id='11111111-1111-4111-8111-111111111111'","UPDATE yta_operations SET units=0 WHERE id='uncertain'","DELETE FROM usage_events WHERE id='used'"])assert.throws(()=>db.exec(q),/FULL_COVERAGE_.*_LOCKED/);
   db.exec("UPDATE yta_operations SET state='DONE' WHERE id='active'; DELETE FROM yta_operations WHERE id='active'");
  }
  db.exec("UPDATE jobs SET audit_json=audit_json WHERE id='11111111-1111-4111-8111-111111111111'; UPDATE yta_sources SET raw=raw WHERE job_id='11111111-1111-4111-8111-111111111111'");
  assert.equal(db.prepare("SELECT state FROM yta_operations WHERE id='uncertain'").get().state,'FAILED_UNCERTAIN');
 }finally{db.close();}
});

test('PR29 API read/export and legacy MP3 writes work at each prefix; bound audio remains blocked until 0017',async()=>{
 const db=base(),env={DB:binding(db),ENABLE_LIVE_FREE:'false',ALLOW_PAID_API:'false'};
 const payload={sourceType:'audio',url:'https://youtu.be/2hUkTmwYm3A',durationSeconds:60,title:'BOUND',submissionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownedAudioSha256:'a'.repeat(64)};
 const original=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('NO_NETWORK_ALLOWED');};
 try{
  for(let prefix=0;prefix<=stages.length;prefix++){
   if(prefix)apply(db,stages[prefix-1]);
   assert.equal((await routeApi(req('/api/jobs/11111111-1111-4111-8111-111111111111'),env)).status,200);
   assert.match(await(await routeApi(req('/api/jobs/11111111-1111-4111-8111-111111111111/export?format=txt'),env)).text(),/KEEP REPORT/);
   const legacy=await routeApi(req('/api/jobs','POST',{sourceType:'audio',durationSeconds:60}),env);assert.equal(legacy.status,202);
   assert.equal((await routeApi(req('/api/jobs/'+(await legacy.json()).job.id,'DELETE'),env)).status,200);
   const bound=await routeApi(req('/api/jobs','POST',payload),env);
   if(prefix<2){assert.equal(bound.status,409);assert.equal((await bound.json()).error.code,'LIVE_SCHEMA_REQUIRED');}
   else{assert.equal(bound.status,202);const row=await bound.json();assert.equal(row.job.id,payload.submissionId);assert.equal(row.reused,prefix>2);}
   assert.equal(db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='groq'").get().n,0);
  }
  assert.equal(calls,0);
  assert.equal(db.prepare("SELECT submission_hash FROM jobs WHERE id='11111111-1111-4111-8111-111111111111'").get().submission_hash,null);
 }finally{globalThis.fetch=original;db.close();}
});

test('0018 outbox claim and 0019-to-0020 historical uncertainty retain data without inventing zero-dispatch proof',async()=>{
 const db=base(),DB=binding(db);const jobId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',url='https://www.youtube.com/watch?v=2hUkTmwYm3A';
 try{
  for(const name of stages.slice(0,3))apply(db,name);
  db.prepare("INSERT INTO jobs(id,owner_id,source_type,source_url,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','url',?,'NEED_UPLOAD',60,'fixture','fixture','null','{}')").run(jobId,url);
  assert.equal((await enqueueAcquisition(DB,{jobId,requestId,url})).created,true);
  assert.equal((await enqueueAcquisition(DB,{jobId,requestId,url})).created,false);
  const lease=await claimAcquisition(DB,{runnerId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'});assert.equal(lease.jobId,jobId);
  assert.equal(await claimAcquisition(DB,{runnerId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}),null);
  apply(db,stages[3]);
  const insert=db.prepare("INSERT INTO yta_local_runner_audio_dispatches VALUES(?,?,?,?,?,?,?,'fixture','fixture')");
  insert.run(jobId,0,requestId,'a'.repeat(64),'b'.repeat(64),'prior-blocked','BLOCKED');
  insert.run(jobId,1,requestId,'a'.repeat(64),'c'.repeat(64),'prior-uncertain','DISPATCH_UNCERTAIN');
  const old=db.prepare('SELECT * FROM yta_local_runner_audio_dispatches ORDER BY chunk_index').all();
  apply(db,stages[4]);
  const rows=db.prepare('SELECT * FROM yta_local_runner_audio_dispatches ORDER BY chunk_index').all();
  assert.deepEqual(rows.map(({attempt_id,...row})=>({...row})),old.map(row=>({...row})));
  assert.deepEqual(rows.map(row=>row.attempt_id),[null,null]);
  for(const table of ['yta_local_runner_audio_attempts','yta_local_runner_audio_resumes'])assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
  const sc={row:{job_id:jobId}};
  await assert.rejects(runnerResumeEvidence(DB,sc,0));
  assert.equal(db.prepare("SELECT state FROM yta_operations WHERE id='uncertain'").get().state,'FAILED_UNCERTAIN');
 }finally{db.close();}
});
