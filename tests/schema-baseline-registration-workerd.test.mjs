import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {target,sha,createExpectedSchema,trustedBuffers} from '../scripts/schema-baseline-review.mjs';
import {readRegistrationSnapshot,registerManagedSchemaBaseline,inspectRegisteredBaseline} from '../scripts/schema-baseline-registration.mjs';
const repo=resolve(import.meta.dirname,'..'),source=trustedBuffers(repo),expected=createExpectedSchema(repo);
const rows=async(DB,q)=>(await DB.prepare(q).all()).results;
async function setup(DB){
 for(const bytes of [source.base,...source.files.filter(f=>f.name<'0016').map(f=>f.bytes)]){
  const sql=bytes.toString().split('\n').filter(l=>!l.trim().startsWith('--')).join('\n');
  await DB.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(q=>DB.prepare(q)));
 }
 await DB.batch([
  DB.prepare("INSERT INTO jobs(id,owner_id,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES('j','owner','text','TRANSCRIPT_UNVERIFIED',98,'t','t','REPORT_FIXTURE','AUDIT_FIXTURE')"),
  DB.prepare("INSERT INTO yta_sources VALUES('j','SOURCE_FIXTURE','[]','FIXTURE','t')"),
  DB.prepare("INSERT INTO usage_events(id,owner_id,provider,capability,unit,used_units,provenance,captured_at) VALUES('u','owner','groq','summary','tokens',2169,'FIXTURE','t')"),
  ...Array.from({length:7},(_,i)=>DB.prepare("INSERT INTO yta_operations VALUES(?,'j','groq-summary',6600,'FAILED_UNCERTAIN','t','UNKNOWN','RECEIPT_FIXTURE')").bind('old-'+i))
 ]);
}
async function input(DB){
 const dbSnapshot=await readRegistrationSnapshot(DB);
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

test('Workerd identifier-case regressions reject existing and racing history, storage aliases and upper-case managed extras',async t=>{
 const cases=[
  {name:'LOWER',history:'d1_migrations'},
  {name:'UPPER',history:'D1_MIGRATIONS'},
  {name:'MIXED',history:'D1_Migrations'},
  {name:'LATE_UPPER',history:'D1_MIGRATIONS',late:true},
  {name:'LATE_MIXED',history:'D1_Migrations',late:true},
  {name:'STORAGE_UPPER',storage:'CODEX_SCHEMA_BASELINES'},
  {name:'LATE_STORAGE',storage:'Codex_Schema_Baselines',late:true},
  {name:'MANAGED_EXTRA',extra:'YTA_UNREVIEWED'},
  {name:'LATE_EXTRA',extra:'Yta_Unreviewed',late:true}
 ];
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'baseline-case-local',modules:true,script:'export default {fetch(){return new Response("local fixture only")}}',d1Databases:Object.fromEntries(cases.map(c=>[c.name,'baseline-case-'+c.name.toLowerCase()]))}]}));
 try{
  for(const c of cases)await t.test(c.name,async()=>{
   const DB=await mf.getD1Database(c.name);await setup(DB);
   const create=async()=>{
    if(c.history)await DB.batch([DB.prepare(`CREATE TABLE ${c.history}(name TEXT PRIMARY KEY)`),DB.prepare(`INSERT INTO ${c.history} VALUES('ACTUAL_EXISTING_HISTORY')`)]);
    else if(c.storage)await DB.prepare(`CREATE TABLE ${c.storage} (id TEXT PRIMARY KEY, database_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, record_sha256 TEXT NOT NULL, registered_at_ms INTEGER NOT NULL)`).run();
    else await DB.prepare(`CREATE TABLE ${c.extra}(unexpected TEXT)`).run();
   };
   if(!c.late)await create();
   const f=await input(DB),preserved=sha(JSON.stringify(await Promise.all(['jobs','yta_sources','yta_operations','usage_events'].map(table=>rows(DB,`SELECT * FROM ${table} ORDER BY 1`)))));
   let writes=0;
   const adapter={prepare:q=>DB.prepare(q),batch:async statements=>{writes++;if(c.late)await create();return DB.batch(statements);}};
   assert.equal(f.dbSnapshot.historyTableCount,c.history&&!c.late?1:0);
   if(c.storage&&!c.late)await assert.rejects(inspectRegisteredBaseline(DB),/BASELINE_STORAGE_SCHEMA_MISMATCH/);
   await assert.rejects(registerManagedSchemaBaseline(adapter,f,{assertAuthorized:auth}),c.late?/BASELINE_REGISTRATION_UNCONFIRMED/:c.history?/BASELINE_HISTORY_REVIEW_REQUIRED/:c.storage?/BASELINE_STORAGE_SCHEMA_MISMATCH/:/BASELINE_SCHEMA_MISMATCH/);
   assert.equal(writes,c.late?1:0);
   const metadata=await rows(DB,"SELECT type,name FROM sqlite_master WHERE tbl_name='codex_schema_baselines' COLLATE NOCASE");
   if(c.storage){assert.equal(metadata.filter(r=>r.type==='trigger').length,0);assert.equal((await rows(DB,'SELECT * FROM codex_schema_baselines')).length,0);}
   else assert.equal(metadata.length,0);
   if(c.history)assert.deepEqual((await rows(DB,'SELECT name FROM d1_migrations')).map(r=>r.name),['ACTUAL_EXISTING_HISTORY']);
   assert.equal(sha(JSON.stringify(await Promise.all(['jobs','yta_sources','yta_operations','usage_events'].map(table=>rows(DB,`SELECT * FROM ${table} ORDER BY 1`))))),preserved);
  });
 }finally{await mf.dispose();}
});
test('actual local Workerd D1 records once, rolls back late runtime failure, blocks late claim and reconciles ACK loss',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'baseline-local',modules:true,script:'export default {fetch(){return new Response("local fixture only")}}',d1Databases:{GOOD:'baseline-good',FAIL:'baseline-fail',RACE:'baseline-race',ACK:'baseline-ack'}}]}));
 try{
  for(const name of ['GOOD','FAIL','RACE','ACK']){
   const DB=await mf.getD1Database(name);await setup(DB);const f=await input(DB);
   const preserved=sha(JSON.stringify(await Promise.all(['jobs','yta_sources','yta_operations','usage_events'].map(t=>rows(DB,`SELECT * FROM ${t} ORDER BY 1`)))));
   let writes=0;const adapter={prepare:q=>DB.prepare(q),batch:async statements=>{
    writes++;
    if(name==='RACE')await DB.prepare("INSERT INTO yta_operations VALUES('racing','j','groq-full-coverage',1,'CLAIMED','t',NULL,NULL)").run();
    const result=await DB.batch(name==='FAIL'?[...statements,DB.prepare("SELECT json('INJECTED_RUNTIME_FAILURE')")]:statements);
    if(name==='ACK')throw Error('ACK_LOST_AFTER_COMMIT');return result;
   }};
   if(name==='FAIL'||name==='RACE'){
    await assert.rejects(registerManagedSchemaBaseline(adapter,f,{assertAuthorized:auth}),/BASELINE_REGISTRATION_UNCONFIRMED/);
    assert.equal((await rows(DB,"SELECT name FROM sqlite_master WHERE tbl_name='codex_schema_baselines'")).length,0);
   }else{
    assert.equal((await registerManagedSchemaBaseline(adapter,f,{assertAuthorized:auth})).state,name==='ACK'?'RECOVERED_AFTER_ACK_LOSS':'RECORDED');
    assert.equal((await inspectRegisteredBaseline(DB)).state,'RECORDED');
    assert.equal((await registerManagedSchemaBaseline(adapter,f,{assertAuthorized:auth})).state,'ALREADY_RECORDED');
    assert.equal((await rows(DB,'SELECT * FROM codex_schema_baselines')).length,1);
   }
   assert.equal(writes,1);assert.equal((await rows(DB,"SELECT name FROM sqlite_master WHERE name='d1_migrations'")).length,0);
   if(name==='RACE')await DB.prepare("DELETE FROM yta_operations WHERE id='racing'").run();
   assert.equal(sha(JSON.stringify(await Promise.all(['jobs','yta_sources','yta_operations','usage_events'].map(t=>rows(DB,`SELECT * FROM ${t} ORDER BY 1`))))),preserved);
  }
 }finally{await mf.dispose();}
});
