import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,constants} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,copyFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {
 createLocalManualSummaryMigrationSession,createManualSummaryMigrationScope,
 inspectManualSummaryImportSchema,manualSummaryMigrationIdentity,
 manualSummaryMigrationPath,manualSummaryMigrationSha256,productionExecutionSupported,
} from '../scripts/manual-summary-migration.mjs';

// Every row below is invented. No production transport, user content, credential,
// provider execution, migration history claim, or operational approval is used.
const root=resolve(import.meta.dirname,'..');
const read=path=>readFileSync(resolve(root,path));
const sql=read(manualSummaryMigrationPath).toString();
const at='2025-01-01T00:00:00.000Z';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const modulesToCopy=['scripts/manual-summary-migration.mjs','scripts/migration-source-catalog.mjs'];

function seed(database=new DatabaseSync(':memory:')){
 for(const file of ['schema.sql','migrations/0002_live.sql','migrations/0008_paid_summary_budget.sql','migrations/0009_paid_first_trial.sql','migrations/0010_paid_summary_receipts.sql'])database.exec(read(file).toString());
 database.prepare('INSERT INTO jobs(id,owner_id,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,?,?,?,?,?,?,?,?)').run('synthetic-job','owner','text','TRANSCRIPT_UNVERIFIED',12,at,at,'{"kind":"SYNTHETIC_REPORT_ONLY"}','{"synthetic":true}');
 database.prepare('INSERT INTO yta_sources VALUES(?,?,?,?,?)').run('synthetic-job','Synthetic transcript fixture.','[]','SYNTHETIC_ONLY',at);
 database.prepare('INSERT INTO yta_operations VALUES(?,?,?,?,?,?,?,?)').run('synthetic-operation','synthetic-job','synthetic-provider',3,'FAILED_UNCERTAIN',at,'SYNTHETIC_ERROR','{"synthetic":true}');
 database.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-usage','synthetic-job','owner','synthetic-provider','SYNTHETIC_ONLY','synthetic-unit',3,0,0,'SYNTHETIC_ONLY',at);
 database.prepare('INSERT INTO yta_paid_summary_quotes VALUES(?,?,?,?,?,?,?,?,?,?)').run('synthetic-quote','synthetic-job','owner','a'.repeat(64),'b'.repeat(64),'{}','c'.repeat(64),'EXPIRED',1,at);
 database.prepare('INSERT INTO yta_paid_summary_approvals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-approval','synthetic-job','owner','a'.repeat(64),'b'.repeat(64),'{}','synthetic-model','synthetic-price','synthetic-generation',11,7,2,1,'CANCELLED',at);
 database.prepare('INSERT INTO yta_paid_summary_reservations VALUES(?,?,?,?,?,?,?,?,?)').run('synthetic-reservation','synthetic-approval',0,7,null,'{"synthetic":true}','SYNTHETIC_UNCERTAIN','UNCERTAIN',at);
 database.prepare('INSERT INTO yta_paid_summary_receipts(reservation_id,job_id,owner_id,source_sha256,request_sha256,quote_sha256,response_bytes,response_json,response_complete,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-reservation','synthetic-job','owner','a'.repeat(64),'c'.repeat(64),'b'.repeat(64),0,'{"synthetic":true}',0,'INCOMPLETE',at,at);
 database.exec("CREATE TABLE byte_probe(id INTEGER PRIMARY KEY,payload TEXT,binary_payload BLOB,large_integer INTEGER,precise_real REAL); INSERT INTO byte_probe VALUES(1,CAST(X'FF00FE' AS TEXT),X'00FF80',9007199254740993,0.12345678912345678)");
 return database;
}

const importRows=db=>db.prepare("SELECT name FROM sqlite_master WHERE lower(name) LIKE '%summary_import%' ORDER BY name").all();
function apply(db,options={}){
 const session=createLocalManualSummaryMigrationSession({database:db});
 return session.apply({before:session.captureBefore(),scope:createManualSummaryMigrationScope(),...options});
}
function importFixture(db){
 db.prepare('INSERT INTO yta_summary_imports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-import','owner','synthetic-job',1,'a'.repeat(64),'SYNTHETIC_ONLY','d'.repeat(64),27,'Synthetic imported fixture.','EXISTING_TRANSCRIPT_IMPORTED','OWNER_SOURCE_RECONCILIATION',at);
 db.prepare('INSERT INTO yta_summary_import_requests VALUES(?,?,?,?,?,?,?)').run('owner','synthetic-job','synthetic-request','COMMITTED','e'.repeat(64),'synthetic-import',at);
}
async function isolatedModule(run){
 const directory=mkdtempSync(join(tmpdir(),'synthetic-0021-module-'));
 try{
  for(const file of modulesToCopy){const to=join(directory,file);mkdirSync(resolve(to,'..'),{recursive:true});copyFileSync(resolve(root,file),to);}
  mkdirSync(join(directory,'migrations/pending'),{recursive:true});
  for(const file of readdirSync(join(root,'migrations')).filter(name=>name.endsWith('.sql')))copyFileSync(join(root,'migrations',file),join(directory,'migrations',file));
  copyFileSync(join(root,'migrations/pending/0021_manual_summary_imports.sql'),join(directory,'migrations/pending/0021_manual_summary_imports.sql'));
  const module=await import(pathToFileURL(join(directory,'scripts/manual-summary-migration.mjs')).href);
  await run(module,directory);
 }finally{rmSync(directory,{recursive:true,force:true});}
}

test('0021 local execution has a fixed source and no production transport',()=>{
 assert.equal(productionExecutionSupported,false);
 const identity=manualSummaryMigrationIdentity();
 assert.equal(identity.path,'migrations/0021_manual_summary_imports.sql');
 assert.equal(identity.sha256,manualSummaryMigrationSha256);
 assert.equal(sha(read(manualSummaryMigrationPath)),manualSummaryMigrationSha256);
 const db=seed();
 try{
  assert.throws(()=>createLocalManualSummaryMigrationSession({database:db,environment:'PRODUCTION'}),/PRODUCTION_EXECUTION_UNSUPPORTED/);
  assert.throws(()=>createLocalManualSummaryMigrationSession({database:{prepare(){throw Error('must not call remote adapter');}}}),/LOCAL_SQLITE_REQUIRED/);
  assert.deepEqual(importRows(db),[]);
 }finally{db.close();}
});

test('one actual SQLite transaction adds exact0021 only and preserves all original records including approval/reservation/receipt',()=>{
 const db=seed();
 try{
  const session=createLocalManualSummaryMigrationSession({database:db}),before=session.captureBefore();
  const expectedTables=['jobs','yta_sources','yta_operations','usage_events','yta_paid_summary_approvals','yta_paid_summary_reservations','yta_paid_summary_receipts'];
  for(const table of expectedTables)assert.equal(before.tables.find(row=>row.name===table).rowCount,1);
  assert.equal(before.schema.state,'ABSENT');
  const result=session.apply({before,scope:createManualSummaryMigrationScope()});
  assert.equal(result.state,'APPLIED');assert.equal(result.originalDataPreserved,true);
  assert.equal(result.beforeOriginalSha256,result.afterOriginalSha256);
  assert.equal(result.productionExecutionSupported,false);assert.equal(result.migrationHistoryWritten,false);
  assert.equal(inspectManualSummaryImportSchema(db).state,'EXACT');
  assert.equal(result.after.tables.length,before.tables.length+2);
  for(const row of before.tables)assert.deepEqual(result.after.tables.find(after=>after.name===row.name),row);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='d1_migrations'").get().n,0);
  assert.equal(JSON.stringify(result).includes('Synthetic transcript fixture.'),false);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_REPORT_ONLY'),false);
  assert.equal(JSON.stringify(result).includes('synthetic-approval'),false);
  assert.throws(()=>session.apply({before,scope:createManualSummaryMigrationScope()}),/BEFORE_SNAPSHOT_UNISSUED/);
 }finally{db.close();}
});

test('exact schema replay preserves saved import text and request rows without reapplying SQL',()=>{
 const db=seed();
 try{
  apply(db);importFixture(db);
  const session=createLocalManualSummaryMigrationSession({database:db}),before=session.captureBefore();
  const exec=db.exec.bind(db);let ddlCalls=0;
  db.exec=statement=>{if(statement.includes('CREATE TABLE'))ddlCalls++;return exec(statement);};
  const result=session.apply({before,scope:createManualSummaryMigrationScope()});
  assert.equal(result.state,'ALREADY_EXACT');assert.equal(ddlCalls,0);assert.equal(result.importRowsPreserved,true);
  assert.deepEqual(result.after.tables,before.tables);
  assert.equal(db.prepare('SELECT content_text FROM yta_summary_imports').get().content_text,'Synthetic imported fixture.');
 }finally{db.close();}
});

const mismatches=[
 ['only one table',s=>s.split(';')[0]+';'],
 ['wrong column type',s=>s.replace('artifact_bytes INTEGER','artifact_bytes TEXT')],
 ['wrong nullability',s=>s.replace('content_text TEXT NOT NULL','content_text TEXT')],
 ['extra default',s=>s.replace('content_text TEXT NOT NULL','content_text TEXT NOT NULL DEFAULT \'synthetic\'')],
 ['wrong check bound',s=>s.replace('artifact_bytes <= 1000000','artifact_bytes <= 999999')],
 ['wrong check literal case',s=>s.replace("provenance = 'EXISTING_TRANSCRIPT_IMPORTED'","provenance = 'existing_transcript_imported'")],
 ['missing uniqueness',s=>s.replace(' UNIQUE(owner_id, job_id, source_sha256, artifact_sha256),','')],
 ['different primary key',s=>s.replace('PRIMARY KEY(owner_id, job_id, request_id)','PRIMARY KEY(owner_id, request_id)')],
 ['different index direction',s=>s.replace('revision DESC','revision ASC')],
 ['foreign key introduced',s=>s.replace('job_id TEXT NOT NULL,','job_id TEXT NOT NULL REFERENCES jobs(id),')],
 ['case variant table',s=>s.replaceAll('yta_summary_imports','YTA_SUMMARY_IMPORTS')],
 ['extra column',s=>s.replace('content_text TEXT NOT NULL,','content_text TEXT NOT NULL, extra_text TEXT,')],
 ['different table options',s=>s.replace(' PRIMARY KEY(owner_id, job_id, request_id)\n);',' PRIMARY KEY(owner_id, job_id, request_id)\n) WITHOUT ROWID;')],
 ['extra index',s=>s+'CREATE INDEX synthetic_extra_import_index ON yta_summary_imports(content_text);'],
 ['extra trigger',s=>s+"CREATE TRIGGER synthetic_import_trigger AFTER INSERT ON yta_summary_imports BEGIN SELECT 1; END;"],
 ['external trigger referring to imports',s=>s+'CREATE TRIGGER synthetic_jobs_import_trigger AFTER DELETE ON jobs BEGIN DELETE FROM yta_summary_imports; END;'],
 ['view referring to imports',s=>s+'CREATE VIEW synthetic_import_view AS SELECT content_text FROM yta_summary_imports;'],
 ['colliding index name as table',()=> 'CREATE TABLE idx_summary_imports_job(unexpected TEXT);'],
];
for(const [name,change] of mismatches)test(`fullDDL preflight rejects ${name} before any migration write`,()=>{
 const db=seed();
 try{
  db.exec(change(sql));
  assert.equal(inspectManualSummaryImportSchema(db).state,'MISMATCH');
  const session=createLocalManualSummaryMigrationSession({database:db}),before=session.captureBefore();
  assert.throws(()=>session.apply({before,scope:createManualSummaryMigrationScope()}),/PRE_SCHEMA_MISMATCH/);
  const after=session.captureBefore();
  assert.equal(after.originalSha256,before.originalSha256);
  assert.deepEqual(after.schema,before.schema);
  assert.deepEqual(after.tables,before.tables);
  assert.equal(after.schemaVersion,before.schemaVersion);
 }finally{db.close();}
});

test('temporary shadow tables and attached databases cannot conceal the inspected main schema',()=>{
 for(const sql of ['CREATE TEMP TABLE yta_summary_imports(id TEXT)',"ATTACH DATABASE ':memory:' AS synthetic_attached"]){
  const db=seed();try{db.exec(sql);assert.throws(()=>createLocalManualSummaryMigrationSession({database:db}),/TEMP_SCHEMA_FORBIDDEN|ATTACHED_DATABASE_FORBIDDEN/);assert.deepEqual(importRows(db),[]);}finally{db.close();}
 }
});

test('all three implicit rowid aliases shadowed blocks exact-preservation review',()=>{
 const db=seed();try{
  db.exec("CREATE TABLE synthetic_rowid_shadow(rowid TEXT,_rowid_ TEXT,oid TEXT); INSERT INTO synthetic_rowid_shadow VALUES('synthetic-a','synthetic-b','synthetic-c')");
  const session=createLocalManualSummaryMigrationSession({database:db});
  assert.throws(()=>session.captureBefore(),/ROWID_INACCESSIBLE/);
  assert.equal(db.isTransaction,false);assert.deepEqual(importRows(db),[]);
 }finally{db.close();}
});

test('explicit WITHOUT ROWID primary-key identity is preserved even with rowid-named columns',()=>{
 const db=seed();try{
  db.exec("CREATE TABLE synthetic_without_rowid(id TEXT PRIMARY KEY,rowid TEXT,_rowid_ TEXT,oid TEXT) WITHOUT ROWID; INSERT INTO synthetic_without_rowid VALUES('synthetic-id','synthetic-a','synthetic-b','synthetic-c')");
  const session=createLocalManualSummaryMigrationSession({database:db}),before=session.captureBefore();
  const result=session.apply({before,scope:createManualSummaryMigrationScope()});
  assert.equal(result.state,'APPLIED');assert.equal(result.beforeOriginalSha256,result.afterOriginalSha256);
  assert.deepEqual(result.after.tables.find(row=>row.name==='synthetic_without_rowid'),before.tables.find(row=>row.name==='synthetic_without_rowid'));
 }finally{db.close();}
});

test('missing, cloned, cross-session, stale and future snapshots cannot authorize a local apply',()=>{
 const db=seed();let clock=1_000_000;
 try{
  const session=createLocalManualSummaryMigrationSession({database:db,now:()=>clock}),before=session.captureBefore(),scope=createManualSummaryMigrationScope();
  assert.throws(()=>session.apply({scope}),/BEFORE_SNAPSHOT_UNISSUED/);
  assert.throws(()=>session.apply({before:structuredClone(before),scope}),/BEFORE_SNAPSHOT_UNISSUED/);
  assert.throws(()=>createLocalManualSummaryMigrationSession({database:db}).apply({before,scope}),/BEFORE_SNAPSHOT_UNISSUED/);
  clock+=300_001;assert.throws(()=>session.apply({before,scope}),/SNAPSHOT_STALE/);
  clock=999_999;assert.throws(()=>session.apply({before,scope}),/SNAPSHOT_STALE/);
  assert.deepEqual(importRows(db),[]);
 }finally{db.close();}
});

test('whole-directory,0016,reordered,extra-file and forged scopes are rejected',()=>{
 const db=seed();
 try{
  const session=createLocalManualSummaryMigrationSession({database:db}),before=session.captureBefore();
  const scope=createManualSummaryMigrationScope();
  for(const invalid of [undefined,{...scope,environment:'PRODUCTION'},{...scope,kind:'SINGLE_MIGRATION_DIRECTORY_V1'},{...scope,files:[...scope.files,{path:'migrations/0016_full_coverage_write_lock.sql',sha256:'a'.repeat(64)}]},{...scope,files:[{...scope.files[0],path:'migrations/pending/0021_manual_summary_imports.sql'}]},{...scope,files:[{...scope.files[0],sha256:'f'.repeat(64)}]},{...scope,catalogSha256:'0'.repeat(64)}])assert.throws(()=>session.apply({before,scope:invalid}),/SINGLE_FILE_SCOPE_UNVERIFIED/);
  assert.deepEqual(importRows(db),[]);
 }finally{db.close();}
});

test('changed SQL bytes, nonbytes and unhashed extra statements fail before write',()=>{
 const db=seed();try{
  const session=createLocalManualSummaryMigrationSession({database:db}),before=session.captureBefore(),scope=createManualSummaryMigrationScope();
  for(const bytes of [Buffer.from(sql+'\n'),Buffer.from(sql.replace('1000000','999999')),Buffer.from(sql+'DROP TABLE jobs;')])assert.throws(()=>session.apply({before,scope,sourceBytes:bytes}),/SOURCE_HASH_MISMATCH/);
  assert.throws(()=>session.apply({before,scope,sourceBytes:sql}),/SOURCE_BYTES_REQUIRED/);
  assert.deepEqual(importRows(db),[]);
 }finally{db.close();}
});

for(const [name,change] of [
 ['approval row',db=>db.exec("UPDATE yta_paid_summary_approvals SET model='synthetic-concurrent-change'")],
 ['reservation row',db=>db.exec("UPDATE yta_paid_summary_reservations SET reserved_micro_usd=8")],
 ['receipt row',db=>db.exec("UPDATE yta_paid_summary_receipts SET response_bytes=1")],
 ['lossless invalid UTF8 text bytes',db=>db.exec("UPDATE byte_probe SET payload=CAST(X'FF00FF' AS TEXT)")],
 ['large integer precision',db=>db.exec('UPDATE byte_probe SET large_integer=9007199254740994')],
 ['implicit rowid only',db=>db.exec('UPDATE jobs SET rowid=rowid+9')],
 ['schema object',db=>db.exec('CREATE INDEX synthetic_late_index ON jobs(status)')],
 ['late complete0021',db=>db.exec(sql)],
])test(`atomic recheck rejects changed ${name} after the before snapshot`,()=>{
 const db=seed();try{
  const session=createLocalManualSummaryMigrationSession({database:db}),before=session.captureBefore();change(db);
  assert.throws(()=>session.apply({before,scope:createManualSummaryMigrationScope()}),/BEFORE_STATE_CHANGED/);
  if(name!=='late complete0021')assert.deepEqual(importRows(db),[]);
 }finally{db.close();}
});

test('a denied second table creation rolls back the first table and index atomically',()=>{
 const db=seed();try{
  const session=createLocalManualSummaryMigrationSession({database:db}),before=session.captureBefore();
  db.setAuthorizer((action,name)=>action===constants.SQLITE_CREATE_TABLE&&name==='yta_summary_import_requests'?constants.SQLITE_DENY:constants.SQLITE_OK);
  assert.throws(()=>session.apply({before,scope:createManualSummaryMigrationScope()}),/ATOMIC_APPLY_FAILED/);
  db.setAuthorizer(null);
  assert.equal(db.isTransaction,false);assert.deepEqual(importRows(db),[]);
  assert.equal(session.captureBefore().originalSha256,before.originalSha256);
  assert.equal(session.apply({before,scope:createManualSummaryMigrationScope()}).state,'APPLIED');
 }finally{db.close();}
});

for(const [name,extraSql,error] of [
 ['extra import index','CREATE INDEX synthetic_unexpected_index ON yta_summary_imports(content_text)','POST_SCHEMA_MISMATCH'],
 ['changed original approval',"UPDATE yta_paid_summary_approvals SET model='synthetic-unexpected-write'",'ORIGINAL_DATA_CHANGED'],
])test(`full postcheck rolls back ${name} and all0021 objects`,()=>{
 const db=seed();try{
  const session=createLocalManualSummaryMigrationSession({database:db}),before=session.captureBefore(),exec=db.exec.bind(db);
  db.exec=statement=>{const value=exec(statement);if(statement===sql)exec(extraSql);return value;};
  assert.throws(()=>session.apply({before,scope:createManualSummaryMigrationScope()}),new RegExp(error));
  assert.deepEqual(importRows(db),[]);assert.equal(session.captureBefore().originalSha256,before.originalSha256);
 }finally{db.close();}
});

test('file-backed temporary SQLite retains exactDDL and original records after close and reopen',()=>{
 const directory=mkdtempSync(join(tmpdir(),'synthetic-0021-db-')),path=join(directory,'local.sqlite');let db;
 try{
  db=seed(new DatabaseSync(path));const result=apply(db);db.close();db=new DatabaseSync(path);
  assert.equal(inspectManualSummaryImportSchema(db).state,'EXACT');
  const reopened=createLocalManualSummaryMigrationSession({database:db}).captureBefore();
  assert.equal(reopened.originalSha256,result.afterOriginalSha256);
  assert.equal(db.prepare('SELECT state FROM yta_paid_summary_reservations').get().state,'UNCERTAIN');
 }finally{db?.close();rmSync(directory,{recursive:true,force:true});}
});

test('lost commit acknowledgement requires fresh reopen/readback and exact replay performs no DDL',()=>{
 const directory=mkdtempSync(join(tmpdir(),'synthetic-0021-ack-')),path=join(directory,'local.sqlite');let db;
 try{
  db=seed(new DatabaseSync(path));
  const session=createLocalManualSummaryMigrationSession({database:db}),before=session.captureBefore(),scope=createManualSummaryMigrationScope(),exec=db.exec.bind(db);
  let ddlCalls=0;
  db.exec=statement=>{const result=exec(statement);if(statement===sql)ddlCalls++;if(statement==='COMMIT')throw Error('SYNTHETIC_LOCAL_ACK_LOSS');return result;};
  assert.throws(()=>session.apply({before,scope}),/COMMIT_OUTCOME_UNCONFIRMED/);
  assert.equal(ddlCalls,1);assert.equal(db.isTransaction,false);
  db.close();db=new DatabaseSync(path);
  const reopened=createLocalManualSummaryMigrationSession({database:db}),fresh=reopened.captureBefore();
  assert.equal(fresh.schema.state,'EXACT');assert.equal(fresh.originalSha256,before.originalSha256);
  const nextExec=db.exec.bind(db);db.exec=statement=>{if(statement.includes('CREATE TABLE'))ddlCalls++;return nextExec(statement);};
  const recovered=reopened.apply({before:fresh,scope:createManualSummaryMigrationScope()});
  assert.equal(recovered.state,'ALREADY_EXACT');assert.equal(recovered.migrationHistoryWritten,false);assert.equal(ddlCalls,1);
  assert.equal(recovered.afterOriginalSha256,before.originalSha256);
 }finally{db?.close();rmSync(directory,{recursive:true,force:true});}
});

for(const [name,alter] of [
 ['missing active source',directory=>rmSync(join(directory,manualSummaryMigrationPath))],
 ['extra top-level source',directory=>writeFileSync(join(directory,'migrations/0099_synthetic.sql'),'CREATE TABLE synthetic_extra(id TEXT);\n')],
 ['changed historical source',directory=>writeFileSync(join(directory,'migrations/0002_live.sql'),'-- synthetic altered source\n')],
 ['changed0021source',directory=>writeFileSync(join(directory,manualSummaryMigrationPath),sql+'\n')],
 ['catalog hash forged',directory=>{const file=join(directory,'scripts/migration-source-catalog.mjs');writeFileSync(file,readFileSync(file,'utf8').replace(manualSummaryMigrationSha256,'0'.repeat(64)));}],
])test(`catalog validation rejects ${name}`,async()=>{
 await isolatedModule(async(module,directory)=>{
  // A forged catalog module must be loaded after mutation, while all other
  // cases exercise fresh byte revalidation in the already loaded module.
  alter(directory);
  let checked=module;
  if(name==='catalog hash forged'){
   const isolatedPath=join(directory,'scripts/manual-summary-migration-second.mjs');
   writeFileSync(isolatedPath,readFileSync(join(directory,'scripts/manual-summary-migration.mjs'),'utf8').replace("'./migration-source-catalog.mjs'","'./migration-source-catalog.mjs?forged'"));
   checked=await import(pathToFileURL(isolatedPath).href);
  }
  const db=seed();try{assert.throws(()=>checked.createLocalManualSummaryMigrationSession({database:db}).captureBefore(),/CATALOG_UNVERIFIED|SOURCE_NOT_CATALOGUED/);assert.deepEqual(importRows(db),[]);}finally{db.close();}
 });
});

test('exact reviewed CRLF checkout is authenticated and yields identical fullDDL',async()=>{
 await isolatedModule(async(module,directory)=>{
  writeFileSync(join(directory,manualSummaryMigrationPath),sql.replaceAll('\n','\r\n'));
  const db=seed();try{
   const session=module.createLocalManualSummaryMigrationSession({database:db});
   const result=session.apply({before:session.captureBefore(),scope:module.createManualSummaryMigrationScope()});
   assert.equal(result.state,'APPLIED');assert.notEqual(result.sourceSha256,manualSummaryMigrationSha256);
   assert.equal(module.inspectManualSummaryImportSchema(db).state,'EXACT');
   assert.equal(module.inspectManualSummaryImportSchema(db).schemaSha256,inspectManualSummaryImportSchema(db).schemaSha256);
  }finally{db.close();}
 });
});

test('catalog/source changes during apply fail the postcheck and roll back all newly created objects',async()=>{
 await isolatedModule(async(module,directory)=>{
  const db=seed();try{
   const session=module.createLocalManualSummaryMigrationSession({database:db}),before=session.captureBefore(),scope=module.createManualSummaryMigrationScope(),exec=db.exec.bind(db);
   db.exec=statement=>{const value=exec(statement);if(statement===sql)writeFileSync(join(directory,manualSummaryMigrationPath),sql+'\n');return value;};
   assert.throws(()=>session.apply({before,scope}),/CATALOG_UNVERIFIED/);
   assert.deepEqual(importRows(db),[]);
   assert.equal(db.prepare('SELECT state FROM yta_paid_summary_approvals').get().state,'CANCELLED');
  }finally{db.close();}
 });
});
