// Synthetic fixtures only. No application credentials, remote binding, provider,
// operational record, network call, or deployment is used in these scenarios.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {reviewedMigrationSource} from '../scripts/migration-source-catalog.mjs';
import {
 createOfflineOperationalStore, createOfflineOperationalController,
 requiredOperationalWriterClasses, captureOfflineOperationalDataSnapshot,
 captureOfflineOperationalTarget,
} from '../scripts/manual-summary-operational-contract.mjs';
import {
 createOfflineD1ManualSummaryAdapter, D1_MANUAL_SUMMARY_SOURCE_SHA256,
} from '../scripts/manual-summary-d1-adapter.mjs';
import {createSyntheticD1Binding} from './helpers/manual-summary-d1-fixture.mjs';

const sourceBytes=readFileSync(new URL('../migrations/0021_manual_summary_imports.sql',import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');
const artifactBytes=Buffer.from('synthetic current worker artifact');
const configurationBytes=Buffer.from('synthetic fixed configuration');
const ownerPolicyBytes=Buffer.from('synthetic owner-only policy');
const identity={evidenceKind:'SYNTHETIC_OFFLINE_CONTRACT',sourceCommit:'1'.repeat(40),
 versionId:'11111111-1111-4111-8111-111111111111',artifactSha256:digest(artifactBytes),
 databaseIdentitySha256:digest('synthetic database identity'),configurationSha256:digest(configurationBytes),
 ownerPolicySha256:digest(ownerPolicyBytes),ownerOnlyEnforced:true,
 importDeletionCompatibility:'OWNER_TOMBSTONE_IMPORT_CLEANUP_V1'};

function seed(database) {
 database.exec(`
  CREATE TABLE jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,report_json TEXT,status TEXT);
  CREATE TABLE yta_sources(job_id TEXT PRIMARY KEY,raw TEXT,segments_json TEXT,provenance TEXT);
  CREATE TABLE yta_operations(id TEXT PRIMARY KEY,job_id TEXT,provider TEXT,state TEXT);
  CREATE TABLE usage_events(id TEXT PRIMARY KEY,used_units INTEGER,state TEXT);
  CREATE TABLE synthetic_approval_ledger(id TEXT PRIMARY KEY,body BLOB);
  INSERT INTO jobs VALUES('fixture-job-a','owner',NULL,'TRANSCRIPT_READY');
  INSERT INTO yta_sources VALUES('fixture-job-a','합성 전사 내용','[]','SYNTHETIC_FIXTURE');
  INSERT INTO yta_operations VALUES('fixture-operation-a','fixture-job-a','synthetic-provider','NOT_RUN');
  INSERT INTO usage_events VALUES('fixture-usage-a',9007199254740993,'SYNTHETIC_ONLY');
  INSERT INTO synthetic_approval_ledger VALUES('fixture-approval-a',X'0080FF');
 `);
}
function closeQuietly(database) {try{database.close();}catch{}}
async function setup(t,{files=false,withImports=false}={}) {
 const directory=files?mkdtempSync(join(tmpdir(),'summary-offline-integration-')):null;
 const dataPath=directory?join(directory,'synthetic-app.sqlite'):':memory:';
 const storePath=directory?join(directory,'synthetic-coordination.sqlite'):':memory:';
 const fixture={dataPath,storePath,now:1000};
 fixture.database=new DatabaseSync(dataPath);seed(fixture.database);
 if(withImports) {
  fixture.database.exec(sourceBytes.toString('utf8'));
  fixture.database.prepare(`INSERT INTO yta_summary_imports
   (id,owner_id,job_id,revision,source_sha256,source_provenance,artifact_sha256,artifact_bytes,content_text,provenance,basis_method,created_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('fixture-import-a','owner','fixture-job-a',1,'a'.repeat(64),'SYNTHETIC_FIXTURE',digest('합성 요약'),Buffer.byteLength('합성 요약'),'합성 요약','EXISTING_TRANSCRIPT_IMPORTED','OWNER_SOURCE_RECONCILIATION','2000-01-01T00:00:00.000Z');
  fixture.database.prepare('INSERT INTO yta_summary_import_requests VALUES(?,?,?,?,?,?,?)')
   .run('owner','fixture-job-a','fixture-request-a','COMMITTED','c'.repeat(64),'fixture-import-a','2000-01-01T00:00:00.000Z');
 }
 fixture.storeDatabase=new DatabaseSync(storePath);
 fixture.makeController=()=>createOfflineOperationalController({store:createOfflineOperationalStore({database:fixture.storeDatabase}),now:()=>fixture.now});
 fixture.controller=fixture.makeController();
 const inventory=requiredOperationalWriterClasses.map((writerClass,index)=>({writerClass,
  instances:[{id:`fixture-writer-${index}`,sourceCommit:identity.sourceCommit}],absence:null}));
 await fixture.controller.initialize({identity,inventory});
 fixture.writers=inventory.map(item=>fixture.controller.createWriter({writerClass:item.writerClass,
  writerId:item.instances[0].id,sourceCommit:identity.sourceCommit}));
 fixture.closeAndDrain=async()=>{
  await fixture.controller.close();
  for(const writer of fixture.writers)await writer.checkpointClosed();
  const snapshot=fixture.controller.captureDrainedSnapshot({database:fixture.database});
  await fixture.controller.sealWindow({snapshot});
 };
 fixture.makeAdapter=async(capability,transport=createSyntheticD1Binding(fixture.database))=>({
  transport,
  adapter:await createOfflineD1ManualSummaryAdapter({binding:transport.binding,sourceBytes,
   catalog:reviewedMigrationSource(),identity,fenceCapability:capability,now:()=>fixture.now}),
 });
 t.after(()=>{closeQuietly(fixture.database);closeQuietly(fixture.storeDatabase);if(directory)rmSync(directory,{recursive:true,force:true});});
 return fixture;
}
function originalRows(database) {
 return {
  source:database.prepare('SELECT hex(CAST(raw AS BLOB)) AS bytes FROM yta_sources').get().bytes,
  report:database.prepare('SELECT report_json,status FROM jobs').get(),
  operation:database.prepare('SELECT provider,state FROM yta_operations').get(),
  usage:database.prepare('SELECT CAST(used_units AS TEXT) AS units,state FROM usage_events').get(),
  approval:database.prepare('SELECT hex(body) AS bytes FROM synthetic_approval_ledger').get().bytes,
 };
}

test('integration: fenced 0021 binding batch preserves original records and never resumes writers',async t=>{
 const fixture=await setup(t);const original=originalRows(fixture.database);
 await fixture.closeAndDrain();
 const capability=await fixture.controller.issueMigrationCapability({sourceSha256:D1_MANUAL_SUMMARY_SOURCE_SHA256});
 const {adapter,transport}=await fixture.makeAdapter(capability);
 const before=await adapter.captureBefore();const result=await adapter.apply({before});
 assert.equal(result.state,'ACKNOWLEDGED_AND_OBSERVED');
 assert.equal(result.preservationVerified,true);assert.equal(result.operationallyAuthorized,false);
 assert.equal(result.productionExecutionSupported,false);assert.equal(result.writesMayResume,false);
 assert.equal(transport.calls.writeBatches,1);
 assert.equal(fixture.controller.status().phase,'MIGRATION_ACKNOWLEDGED');
 assert.deepEqual(originalRows(fixture.database),original);
 assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM yta_summary_imports').get().n,0);
 assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM yta_summary_import_requests').get().n,0);
 assert.equal(transport.calls.statements.some(sql=>/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)),false);
 for(const writer of fixture.writers)await assert.rejects(writer.admit(),/WRITES_CLOSED/);
 await assert.rejects(adapter.apply({before}),/RECONCILIATION_REQUIRED|WRITE_RETRY_FORBIDDEN/);
});

test('integration: same declared identity cannot bind a different local database to the fence',async t=>{
 const fixture=await setup(t);await fixture.closeAndDrain();
 const capability=await fixture.controller.issueMigrationCapability({sourceSha256:D1_MANUAL_SUMMARY_SOURCE_SHA256});
 const other=new DatabaseSync(':memory:');t.after(()=>other.close());seed(other);
 const transport=createSyntheticD1Binding(other);
 await assert.rejects(fixture.makeAdapter(capability,transport),/GLOBAL_FENCE_UNVERIFIED|BINDING|DATABASE/);
 assert.equal(transport.calls.writeBatches,0);assert.equal(transport.calls.batches,0);
});

test('integration: a pre-drain snapshot at the same timestamp cannot authorize migration',async t=>{
 const fixture=await setup(t);const ticket=await fixture.writers[0].admit();
 await fixture.controller.close();
 const tooEarly=captureOfflineOperationalDataSnapshot({database:fixture.database,identity,now:fixture.now});
 fixture.database.prepare('UPDATE yta_sources SET raw=?').run('합성 전사 변경');
 await fixture.writers[0].complete({ticket,outcome:'CONFIRMED'});
 for(const writer of fixture.writers)await writer.checkpointClosed();
 await assert.rejects(fixture.controller.sealWindow({snapshot:tooEarly}),/DRAIN|OBSERVATION|REVISION|SNAPSHOT/);
 assert.equal(fixture.controller.status().phase,'CLOSING');
 const afterDrain=fixture.controller.captureDrainedSnapshot({database:fixture.database});
 await fixture.controller.sealWindow({snapshot:afterDrain});
 const capability=await fixture.controller.issueMigrationCapability({sourceSha256:D1_MANUAL_SUMMARY_SOURCE_SHA256});
 const {adapter}=await fixture.makeAdapter(capability);const before=await adapter.captureBefore();
 const result=await adapter.apply({before});assert.equal(result.state,'ACKNOWLEDGED_AND_OBSERVED');
 assert.equal(fixture.database.prepare('SELECT raw FROM yta_sources').get().raw,'합성 전사 변경');
});

test('integration: committed ACK loss survives close/reopen with only readback authority',async t=>{
 const fixture=await setup(t,{files:true});await fixture.closeAndDrain();
 const capability=await fixture.controller.issueMigrationCapability({sourceSha256:D1_MANUAL_SUMMARY_SOURCE_SHA256});
 const transport=createSyntheticD1Binding(fixture.database,{loseWriteAck:true});
 const {adapter}=await fixture.makeAdapter(capability,transport);
 const before=await adapter.captureBefore();const result=await adapter.apply({before});
 assert.equal(result.state,'BATCH_OUTCOME_UNCONFIRMED');assert.equal(transport.calls.writeBatches,1);
 assert.equal(fixture.controller.status().phase,'MIGRATION_UNKNOWN');
 fixture.database.close();fixture.storeDatabase.close();
 fixture.database=new DatabaseSync(fixture.dataPath);fixture.storeDatabase=new DatabaseSync(fixture.storePath);
 fixture.controller=fixture.makeController();
 assert.equal(fixture.controller.status().phase,'MIGRATION_UNKNOWN');
 const readCapability=await fixture.controller.issueMigrationReadbackCapability({sourceSha256:D1_MANUAL_SUMMARY_SOURCE_SHA256});
 const restored=await fixture.makeAdapter(readCapability);
 const readback=await restored.adapter.observeAfterRestart();
 assert.equal(readback.schemaState,'EXACT');assert.equal(readback.preservationVerified,false);
 assert.equal(readback.attributionProved,false);assert.equal(readback.retryAllowed,false);
 await assert.rejects(restored.adapter.captureBefore(),/RECONCILIATION_REQUIRED|READBACK|READ_ONLY/);
 await assert.rejects(restored.adapter.apply({before}),/BEFORE_UNISSUED|RECONCILIATION_REQUIRED|READBACK_ONLY/);
 assert.equal(restored.transport.calls.writeBatches,0);
 await assert.rejects(fixture.controller.issueMigrationCapability({sourceSha256:D1_MANUAL_SUMMARY_SOURCE_SHA256}),/OPERATION_ALREADY_RESERVED/);
 assert.equal(fixture.controller.status().writesMayResume,false);
});

test('integration: a batch failure rolls back DDL but never grants automatic replay',async t=>{
 const fixture=await setup(t);await fixture.closeAndDrain();
 const capability=await fixture.controller.issueMigrationCapability({sourceSha256:D1_MANUAL_SUMMARY_SOURCE_SHA256});
 const transport=createSyntheticD1Binding(fixture.database,{failWriteStatement:2});
 const {adapter}=await fixture.makeAdapter(capability,transport);const before=await adapter.captureBefore();
 const result=await adapter.apply({before});assert.equal(result.state,'BATCH_OUTCOME_UNCONFIRMED');
 assert.equal(fixture.database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'yta_summary_import%'").get().n,0);
 const readback=await adapter.reconcile({before});assert.equal(readback.schemaState,'ABSENT');
 assert.equal(readback.pendingRequestTerminalProved,false);assert.equal(readback.retryAllowed,false);
 await assert.rejects(adapter.apply({before}),/RECONCILIATION_REQUIRED|WRITE_RETRY_FORBIDDEN/);
 assert.equal(transport.calls.writeBatches,1);assert.equal(fixture.controller.status().phase,'MIGRATION_UNKNOWN');
});

test('integration: postcommit original-data drift keeps DDL and closes the operation as failed',async t=>{
 const fixture=await setup(t);await fixture.closeAndDrain();
 const capability=await fixture.controller.issueMigrationCapability({sourceSha256:D1_MANUAL_SUMMARY_SOURCE_SHA256});
 const transport=createSyntheticD1Binding(fixture.database,{afterWriteCommit:({database})=>{
  database.prepare('UPDATE usage_events SET state=?').run('SYNTHETIC_EXTERNAL_WRITER');
 }});
 const {adapter}=await fixture.makeAdapter(capability,transport);const before=await adapter.captureBefore();
 const result=await adapter.apply({before});
 assert.equal(result.state,'ACKNOWLEDGED_POSTCHECK_FAILED');assert.equal(result.preservationVerified,false);
 assert.equal(fixture.controller.status().phase,'MIGRATION_POSTCHECK_FAILED');
 assert.equal(fixture.database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('yta_summary_imports','yta_summary_import_requests')").get().n,2);
 assert.equal(result.writesMayResume,false);assert.equal(result.retryAllowed,false);
 for(const writer of fixture.writers)await assert.rejects(writer.admit(),/WRITES_CLOSED/);
});

test('integration: imported text prevents legacy rollback and survives compatible readback',async t=>{
 const fixture=await setup(t,{withImports:true});const original=originalRows(fixture.database);
 await fixture.closeAndDrain();
 const rollbackBytes=Buffer.from('synthetic compatible rollback artifact');
 const baseTarget={...identity,sourceCommit:'2'.repeat(40),versionId:'22222222-2222-4222-8222-222222222222',artifactSha256:digest(rollbackBytes)};
 const targetOf=importDeletionCompatibility=>captureOfflineOperationalTarget({
  identity:{...baseTarget,importDeletionCompatibility},artifactBytes:rollbackBytes,
  configurationBytes,ownerPolicyBytes,now:fixture.now});
 const snapshot=captureOfflineOperationalDataSnapshot({database:fixture.database,identity,now:fixture.now});
 await assert.rejects(fixture.controller.prepareRollback({target:targetOf('NONE'),snapshot}),/ROLLBACK_CLEANUP_INCOMPATIBLE/);
 assert.equal(fixture.controller.status().phase,'FENCED');
 const target=targetOf('OWNER_TOMBSTONE_IMPORT_CLEANUP_V1');
 const plan=await fixture.controller.prepareRollback({target,snapshot});
 const after=captureOfflineOperationalDataSnapshot({database:fixture.database,identity:baseTarget,now:fixture.now});
 const result=await fixture.controller.verifyRollback({plan,observedTarget:targetOf('OWNER_TOMBSTONE_IMPORT_CLEANUP_V1'),snapshot:after});
 assert.equal(result.status,'OFFLINE_CONTRACT_VERIFIED_CLOSED');assert.equal(result.writesMayResume,false);
 assert.equal(result.operationallyAuthorized,false);assert.deepEqual(originalRows(fixture.database),original);
 assert.equal(fixture.database.prepare('SELECT content_text FROM yta_summary_imports').get().content_text,'합성 요약');
 assert.equal(fixture.database.prepare('SELECT state FROM yta_summary_import_requests').get().state,'COMMITTED');
 assert.equal(fixture.controller.status().phase,'ROLLBACK_VERIFIED_CLOSED');
});
