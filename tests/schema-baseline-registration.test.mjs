import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {createExpectedSchema,trustedBuffers,sha,target,assessAdoptionReview} from '../scripts/schema-baseline-review.mjs';
import {registerManagedSchemaBaseline,readRegistrationSnapshot,inspectRegisteredBaseline,readBaselineForMigration} from '../scripts/schema-baseline-registration.mjs';
import {assessFullCoverageMigration,verifyFullCoverageMigration} from '../scripts/full-coverage-migration-preflight.mjs';
import {migrationBefore} from './fixtures/migration-review-snapshot.mjs';
const repo=resolve(import.meta.dirname,'..'),expected=createExpectedSchema(repo),source=trustedBuffers(repo);
const rows=(db,q)=>db.prepare(q).all();
function binding(db,hooks={}){
 const adapter={batchCalls:0,prepare(q){const make=args=>({q,args,bind(...values){return make(values);},async first(){return db.prepare(q).get(...args)||null;},async all(){return {results:db.prepare(q).all(...args)};},async run(){return {success:true,meta:{changes:Number(db.prepare(q).run(...args).changes)}};}});return make([]);},async batch(statements){
  adapter.batchCalls++;await hooks.before?.();db.exec('BEGIN IMMEDIATE');
  try{const results=statements.map(s=>({success:true,results:db.prepare(s.q).all(...s.args)}));if(hooks.failBeforeCommit)throw Error('BEFORE_COMMIT');db.exec('COMMIT');if(hooks.ackLoss)throw Error('ACK_LOST');return results;}
  catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
 }};return adapter;
}
function base(){
 const db=new DatabaseSync(':memory:');db.exec(source.base.toString());for(const f of source.files.filter(f=>f.name<'0016'))db.exec(f.bytes.toString());
 db.exec("INSERT INTO jobs(id,owner_id,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES('j','owner','text','TRANSCRIPT_UNVERIFIED',98,'t','t','REPORT_FIXTURE','AUDIT_FIXTURE'); INSERT INTO yta_sources VALUES('j','SOURCE_FIXTURE','[]','FIXTURE','t'); INSERT INTO usage_events(id,owner_id,provider,capability,unit,used_units,provenance,captured_at) VALUES('u','owner','groq','summary','tokens',2169,'FIXTURE','t')");
 for(let i=0;i<7;i++)db.prepare("INSERT INTO yta_operations VALUES(?,'j','groq-summary',6600,'FAILED_UNCERTAIN','t','UNKNOWN','RECEIPT_FIXTURE')").run('old-'+i);
 return db;
}
const retained=db=>sha(JSON.stringify(['jobs','yta_sources','yta_operations','usage_events'].map(t=>rows(db,`SELECT * FROM ${t} ORDER BY 1`))));
async function input(DB){
 const dbSnapshot=await readRegistrationSnapshot(DB);
 // SQLite's native Windows clock can lead the JS clock by a millisecond.
 // Wait for actual time to catch up; never fabricate later review timestamps.
 const captured=Date.parse(dbSnapshot.capturedAt);if(captured-Date.now()>1000)throw Error('LOCAL_FIXTURE_CLOCK_SKEW');
 while(Date.now()<captured)await new Promise(r=>setTimeout(r,1));
 const at=new Date().toISOString();
 const observation={...target,rows:JSON.parse(dbSnapshot.schemaJson),digest:sha(JSON.stringify(dbSnapshot)),startedAt:dbSnapshot.capturedAt,completedAt:dbSnapshot.capturedAt};
 const review={...target,kind:'EXISTING_MANAGED_SCHEMA_ADOPTION_REVIEW_V1',historyClaim:'UNKNOWN_NO_HISTORICAL_APPLIED_ROWS',schemaFingerprint:expected.fingerprint,observationDigest:observation.digest,catalogDigest:expected.catalogDigest,reviewedAt:at};
 const controls={...target,schemaFingerprint:expected.fingerprint,writersQuiesced:true,relevantDispatchPaused:true,productionBuildsDisabled:true,previewBuildsDisabled:true,runningOrQueuedBuildCount:0,unsettledRelevantOperationCount:0,capturedAt:at,timeTravel:{databaseId:target.databaseId,bookmark:'SYNTHETIC_LOCAL_ONLY',capturedAt:at},commandsAndProtectedEvidenceReviewed:true,scope:'BASELINE_RECORD_ONLY_NO_MIGRATION_EXECUTION'};
 const approval={kind:'SCHEMA_BASELINE_REGISTRATION_APPROVAL_V1',requestId:'11111111-1111-4111-8111-111111111111',...target,action:'REGISTER_BASELINE_ONLY',approvedAt:at,expiresAt:new Date(Date.parse(at)+240000).toISOString(),windowId:'22222222-2222-4222-8222-222222222222',windowStartsAt:at,windowEndsAt:new Date(Date.parse(at)+240000).toISOString(),observationDigest:observation.digest,snapshotDigest:dbSnapshot.digest,schemaFingerprint:expected.fingerprint,catalogDigest:expected.catalogDigest,controlsDigest:sha(JSON.stringify(controls)),restoreBookmarkDigest:sha(controls.timeTravel.bookmark)};
 return {observation,review,controls,dbSnapshot,approval};
}
const auth=async()=>true;

for(const spelling of ['d1_migrations','D1_MIGRATIONS','D1_Migrations'])for(const late of [false,true]){
 test(`history identifier ${spelling} ${late?'created before atomic batch':'present at snapshot'} blocks baseline registration`,async()=>{
  const db=base();try{
   const create=()=>db.exec(`CREATE TABLE ${spelling}(name TEXT PRIMARY KEY); INSERT INTO ${spelling} VALUES('ACTUAL_EXISTING_HISTORY')`);
   if(!late)create();
   const DB=binding(db,late?{before:create}:{}),f=await input(DB),before=retained(db);
   assert.equal(f.dbSnapshot.historyTableCount,late?0:1);
   await assert.rejects(registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth}),late?/BASELINE_REGISTRATION_UNCONFIRMED/:/BASELINE_HISTORY_REVIEW_REQUIRED/);
   assert.equal(DB.batchCalls,late?1:0);
   assert.equal(rows(db,"SELECT name FROM sqlite_master WHERE tbl_name='codex_schema_baselines' COLLATE NOCASE").length,0);
   assert.deepEqual(rows(db,'SELECT name FROM d1_migrations').map(r=>r.name),['ACTUAL_EXISTING_HISTORY']);
   assert.equal(retained(db),before);
  }finally{db.close();}
 });
}

test('baseline storage lookup discovers alternate identifier case and rejects it before writing or atomically after a race',async()=>{
 for(const spelling of ['CODEX_SCHEMA_BASELINES','Codex_Schema_Baselines'])for(const late of [false,true]){
  const db=base();try{
   const create=()=>db.exec(`CREATE TABLE ${spelling} (id TEXT PRIMARY KEY, database_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, record_sha256 TEXT NOT NULL, registered_at_ms INTEGER NOT NULL)`);
   if(!late)create();
   const DB=binding(db,late?{before:create}:{}),f=await input(DB),before=retained(db);
   if(!late)await assert.rejects(inspectRegisteredBaseline(DB),/BASELINE_STORAGE_SCHEMA_MISMATCH/);
   await assert.rejects(registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth}),late?/BASELINE_REGISTRATION_UNCONFIRMED/:/BASELINE_STORAGE_SCHEMA_MISMATCH/);
   assert.equal(DB.batchCalls,late?1:0);assert.equal(rows(db,'SELECT * FROM codex_schema_baselines').length,0);
   assert.equal(rows(db,"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='codex_schema_baselines' COLLATE NOCASE").length,0);
   assert.equal(retained(db),before);
  }finally{db.close();}
 }
});

test('managed schema lookup includes case variants and upper-case yta prefix without normalizing their definitions',async()=>{
 for(const name of ['jobs','usage_events','yta_sources','YTA_EXTRA','Yta_Extra']){
  const db=base();try{
   if(name.startsWith('Y'))db.exec(`CREATE TABLE ${name}(unexpected TEXT)`);
   else db.exec(`ALTER TABLE ${name} RENAME TO case_rename_fixture; ALTER TABLE case_rename_fixture RENAME TO ${name.toUpperCase()}`);
   const DB=binding(db),f=await input(DB);
   assert.ok(JSON.parse(f.dbSnapshot.schemaJson).some(r=>r.type==='table'&&r.name===(name.startsWith('Y')?name:name.toUpperCase())));
   await assert.rejects(registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth}),/BASELINE_SCHEMA_MISMATCH/);
   assert.equal(DB.batchCalls,0);assert.equal((await inspectRegisteredBaseline(DB)).state,'ABSENT');
  }finally{db.close();}
 }
});
test('register one baseline, preserve seven uncertain rows and source/report/usage, read back without historical inserts',async()=>{
 const db=base();try{
  const DB=binding(db),f=await input(DB),before=retained(db),result=await registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth});
  assert.equal(result.state,'RECORDED');assert.equal(DB.batchCalls,1);assert.equal(retained(db),before);
  assert.equal(rows(db,"SELECT name FROM sqlite_master WHERE name='d1_migrations'").length,0);
  assert.equal(rows(db,'SELECT * FROM codex_schema_baselines').length,1);
  const record=JSON.parse(result.row.record_json);assert.equal(record.historyClaim,'UNKNOWN_NO_HISTORICAL_APPLIED_ROWS');assert.equal('appliedMigrations' in record,false);
  assert.equal((await registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth})).state,'ALREADY_RECORDED');assert.equal(DB.batchCalls,1);
  await assert.rejects(DB.prepare("UPDATE codex_schema_baselines SET record_json='{}'").run(),/SCHEMA_BASELINE_IMMUTABLE/);
  await assert.rejects(DB.prepare('DELETE FROM codex_schema_baselines').run(),/SCHEMA_BASELINE_IMMUTABLE/);
  const conflict=structuredClone(f);conflict.approval.requestId='33333333-3333-4333-8333-333333333333';
  await assert.rejects(registerManagedSchemaBaseline(DB,conflict,{assertAuthorized:auth}),/BASELINE_CONFLICT/);assert.equal(DB.batchCalls,1);
 }finally{db.close();}
});
test('missing/wrong/stale evidence and missing target authorization cause zero write batches',async()=>{
 for(const mutate of [f=>{f.observation.digest=null;},f=>{f.controls.timeTravel.bookmark='';},f=>{f.controls.writersQuiesced=false;},f=>{f.controls.relevantDispatchPaused=false;},f=>{f.approval.databaseId='wrong';},f=>{f.approval.action='MIGRATE';},f=>{f.approval.expiresAt='2020-01-01T00:00:00.000Z';},f=>{f.dbSnapshot.capturedAt='2020-01-01T00:00:00.000Z';},f=>{f.approval.secret='MUST_NOT_STORE';},f=>{delete f.controls;},f=>{f.approval.snapshotDigest='0'.repeat(64);}]){
  const db=base();try{const DB=binding(db),f=await input(DB);mutate(f);await assert.rejects(registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth}));assert.equal(DB.batchCalls,0);assert.equal(rows(db,"SELECT name FROM sqlite_master WHERE name='codex_schema_baselines'").length,0);}finally{db.close();}
 }
 const db=base();try{const DB=binding(db),f=await input(DB);await assert.rejects(registerManagedSchemaBaseline(DB,f),/BASELINE_AUTHORIZATION_REQUIRED/);assert.equal(DB.batchCalls,0);}finally{db.close();}
});
test('final authorization await cannot extend expiry or allow changed pause evidence',async()=>{
 const db=base();try{const DB=binding(db),f=await input(DB);let calls=0;
  await assert.rejects(registerManagedSchemaBaseline(DB,f,{assertAuthorized:async()=>{if(++calls===2)f.controls.writersQuiesced=false;return true;}}),/BASELINE_REVIEW_BLOCKED/);assert.equal(DB.batchCalls,0);
 }finally{db.close();}
 const expired=base();try{const DB=binding(expired),f=await input(DB);let calls=0,clockOverride;
  await assert.rejects(registerManagedSchemaBaseline(DB,f,{now:()=>clockOverride??Date.now(),assertAuthorized:async()=>{if(++calls===2)clockOverride=Date.parse(f.approval.expiresAt);return true;}}),/BASELINE_APPROVAL_SCOPE_EXPIRED/);assert.equal(DB.batchCalls,0);
 }finally{expired.close();}
});
test('reviewed P2 digest negatives remain blocked after importing the reviewed proposal',async()=>{
 const db=base();try{const DB=binding(db),valid=await input(DB);
  for(const value of [undefined,null,'','not-a-sha256',42]){
   const f=structuredClone(valid);if(value===undefined){delete f.observation.digest;delete f.review.observationDigest;}else{f.observation.digest=value;f.review.observationDigest=value;}
   const result=assessAdoptionReview({...f,expected});assert.equal(result.readyForIndependentOperatorReview,false);assert.equal(result.productionExecutionSupported,false);assert.equal(result.createsHistoricalAppliedRows,false);
  }
 }finally{db.close();}
});
test('schema and operation changes immediately before atomic batch roll back baseline DDL',async()=>{
 for(const mutate of [db=>db.exec('ALTER TABLE jobs ADD COLUMN unreviewed TEXT'),db=>db.exec("INSERT INTO yta_operations VALUES('live','j','groq-full-coverage',1,'CLAIMED','t',NULL,NULL)")]){
  const db=base();try{const DB=binding(db,{before:()=>mutate(db)}),f=await input(DB);await assert.rejects(registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth}),/BASELINE_REGISTRATION_UNCONFIRMED/);assert.equal(DB.batchCalls,1);assert.equal(rows(db,"SELECT name FROM sqlite_master WHERE tbl_name='codex_schema_baselines'").length,0);}finally{db.close();}
 }
});
test('server-clock expiry during batch handoff rejects without a baseline row',async()=>{
 const db=base();try{const DB=binding(db,{before:()=>new Promise(r=>setTimeout(r,220))}),f=await input(DB);f.approval.expiresAt=new Date(Date.now()+100).toISOString();
  await assert.rejects(registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth}),/BASELINE_REGISTRATION_UNCONFIRMED/);assert.equal(rows(db,"SELECT name FROM sqlite_master WHERE tbl_name='codex_schema_baselines'").length,0);
 }finally{db.close();}
});
test('restore evidence also expires inside the server-side transaction, and injected storage triggers cannot write application rows',async()=>{
 const db=base();try{const DB=binding(db,{before:()=>new Promise(r=>setTimeout(r,450))}),f=await input(DB);
  f.controls.timeTravel.capturedAt=new Date(Date.now()-299700).toISOString();f.approval.controlsDigest=sha(JSON.stringify(f.controls));
  await assert.rejects(registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth}),/BASELINE_REGISTRATION_UNCONFIRMED/);assert.equal((await inspectRegisteredBaseline(DB)).state,'ABSENT');
 }finally{db.close();}
 const injected=base();try{const before=retained(injected),DB=binding(injected,{before:()=>injected.exec("CREATE TABLE codex_schema_baselines (id TEXT PRIMARY KEY, database_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, record_sha256 TEXT NOT NULL, registered_at_ms INTEGER NOT NULL); CREATE TRIGGER malicious AFTER INSERT ON codex_schema_baselines BEGIN UPDATE usage_events SET used_units=0; END")}),f=await input(DB);
  await assert.rejects(registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth}),/BASELINE_REGISTRATION_UNCONFIRMED/);assert.equal(retained(injected),before);assert.equal(rows(injected,'SELECT * FROM codex_schema_baselines').length,0);
 }finally{injected.close();}
});
test('persistent read failure after commit is unresolved without retrying the write batch',async()=>{
 const db=base();try{const baseDB=binding(db),f=await input(baseDB);let committed=false,writes=0;
  const DB={prepare(q){if(committed)throw Error('DB_UNAVAILABLE');return baseDB.prepare(q);},async batch(statements){writes++;await baseDB.batch(statements);committed=true;throw Error('ACK_LOST');}};
  await assert.rejects(registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth}),/BASELINE_REGISTRATION_UNCONFIRMED/);assert.equal(writes,1);assert.equal(rows(db,'SELECT * FROM codex_schema_baselines').length,1);assert.equal((await inspectRegisteredBaseline(baseDB)).state,'RECORDED');
 }finally{db.close();}
});
test('before-commit failure and commit ACK loss reconcile without a second write',async()=>{
 for(const committed of [false,true]){const db=base();try{const DB=binding(db,committed?{ackLoss:true}:{failBeforeCommit:true}),f=await input(DB),before=retained(db);
  if(committed){assert.equal((await registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth})).state,'RECOVERED_AFTER_ACK_LOSS');assert.equal((await inspectRegisteredBaseline(DB)).state,'RECORDED');}
  else{await assert.rejects(registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth}),/BASELINE_REGISTRATION_UNCONFIRMED/);assert.equal((await inspectRegisteredBaseline(DB)).state,'ABSENT');}
  assert.equal(DB.batchCalls,1);assert.equal(retained(db),before);
 }finally{db.close();}}
});
test('concurrent identical registration creates one record and never mutates application evidence',async()=>{
 const db=base();try{const DB=binding(db),f=await input(DB),before=retained(db),results=await Promise.all([registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth}),registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth})]);
  assert.equal(results.length,2);assert.equal(rows(db,'SELECT * FROM codex_schema_baselines').length,1);assert.equal(retained(db),before);
 }finally{db.close();}
});
test('adopted migration guard keeps all prior filenames pending and permits only actual isolated 0016',async()=>{
 const db=base();try{const DB=binding(db),f=await input(DB);await registerManagedSchemaBaseline(DB,f,{assertAuthorized:auth});
  const before=migrationBefore();before.appliedMigrations=[];before.pendingMigrations=source.catalog.files.map(f=>f.name);before.migrationHistoryTable='ABSENT';before.schemaBaseline=await readBaselineForMigration(DB);
  assert.equal(assessFullCoverageMigration(before).readyForOperatorReview,true);
  const fakeHistory=structuredClone(before);fakeHistory.appliedMigrations=source.catalog.files.filter(f=>f.name<'0016').map(f=>f.name);assert.ok(assessFullCoverageMigration(fakeHistory).blocks.includes('MIGRATION_HISTORY_UNVERIFIED'));
  const omitted=structuredClone(before);omitted.pendingMigrations=omitted.pendingMigrations.filter(n=>n>='0016');assert.ok(assessFullCoverageMigration(omitted).blocks.includes('PENDING_MIGRATIONS_UNEXPECTED'));
  const noSnapshot=structuredClone(before);delete noSnapshot.schemaBaseline;assert.equal(assessFullCoverageMigration(noSnapshot).readyForOperatorReview,false);
  const wide=structuredClone(before);wide.executionScope.files.push(source.catalog.files.at(-1));assert.ok(assessFullCoverageMigration(wide).blocks.includes('SINGLE_MIGRATION_SCOPE_UNVERIFIED'));
  const bytes=source.files.find(f=>f.name.startsWith('0016')).bytes;db.exec(bytes.toString());
  db.exec("CREATE TABLE d1_migrations(name TEXT PRIMARY KEY); INSERT INTO d1_migrations VALUES('0016_full_coverage_write_lock.sql')");
  const after={databaseId:target.databaseId,capturedAt:new Date().toISOString(),repositorySource:source.catalog,pendingMigrations:source.catalog.files.filter(f=>!f.name.startsWith('0016')).map(f=>f.name),appliedMigrations:['0016_full_coverage_write_lock.sql'],migrationHistoryTable:'PRESENT',schemaBaseline:await readBaselineForMigration(DB),executionScope:{...before.executionScope,pendingMigrations:[]},triggers:rows(db,"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'full_coverage_%'")};
  assert.equal(verifyFullCoverageMigration(after,{before}).verified,true);
  const tampered=structuredClone(after);tampered.schemaBaseline.row.record_json+=' ';assert.equal(verifyFullCoverageMigration(tampered,{before}).verified,false);
  db.exec('ALTER TABLE jobs ADD COLUMN unrelated TEXT');after.schemaBaseline=await readBaselineForMigration(DB);assert.equal(verifyFullCoverageMigration(after,{before}).verified,false);
 }finally{db.close();}
});
