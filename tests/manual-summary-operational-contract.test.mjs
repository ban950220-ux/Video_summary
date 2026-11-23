// Synthetic local fixtures only. No production identities, personal records,
// credentials, D1 requests, provider requests, or deployment operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {
 requiredOperationalWriterClasses, canonicalOperationalIdentity,
 createOfflineOperationalStore, createOfflineOperationalController,
 captureOfflineOperationalDataSnapshot,captureOfflineOperationalTarget,
 assertOfflineOperationalCapability,beginOfflineOperationalMutation,
 finishOfflineOperationalMutation,createOfflineD1FixtureBinding
} from '../scripts/manual-summary-operational-contract.mjs';

const SOURCE='04de16a15c295e1d1c172dcc799dc15d293b8721b5db58f9dae0d94ed9f21e01';
const bytes=value=>Buffer.from(value,'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const artifact=bytes('synthetic current artifact'), targetArtifact=bytes('synthetic rollback artifact');
const config=bytes('synthetic configuration'), policy=bytes('synthetic owner-only policy');
const current=canonicalOperationalIdentity({evidenceKind:'SYNTHETIC_OFFLINE_CONTRACT',sourceCommit:'a'.repeat(40),versionId:'11111111-1111-1111-1111-111111111111',artifactSha256:hash(artifact),databaseIdentitySha256:'b'.repeat(64),configurationSha256:hash(config),ownerPolicySha256:hash(policy),ownerOnlyEnforced:true,importDeletionCompatibility:'OWNER_TOMBSTONE_IMPORT_CLEANUP_V1'});
const target={...current,sourceCommit:'c'.repeat(40),versionId:'22222222-2222-2222-2222-222222222222',artifactSha256:hash(targetArtifact)};
const inventoryFor=(identity=current)=>requiredOperationalWriterClasses.map((writerClass,index)=>({writerClass,instances:[{id:'fixture-writer-'+index,sourceCommit:identity.sourceCommit}],absence:null}));
const migration=readFileSync(new URL('../migrations/0021_manual_summary_imports.sql',import.meta.url),'utf8');
const args=(identity=current,binding)=>({operation:'MIGRATION_0021',identity,sourceSha256:SOURCE,binding});
const expected=code=>error=>error?.code==='OPERATIONAL_CONTRACT_'+code;

async function fixture(t,{imports=false,cancelled=false,storeDb,dataDb,inventory=inventoryFor()}={}) {
 const ownedStore=!storeDb,ownedData=!dataDb;
 storeDb??=new DatabaseSync(':memory:');dataDb??=new DatabaseSync(':memory:');
 if(ownedStore)t.after(()=>{try{storeDb.close();}catch{}});
 if(ownedData)t.after(()=>{try{dataDb.close();}catch{}});
 if(!dataDb.prepare("SELECT name FROM sqlite_master WHERE name='jobs'").get()) {
  dataDb.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL); CREATE TABLE yta_operations(id TEXT PRIMARY KEY,job_id TEXT,provider TEXT,state TEXT); CREATE TABLE fixture_usage(id INTEGER PRIMARY KEY,amount INTEGER); INSERT INTO jobs VALUES ('fixture-analysis','fixture-owner'); INSERT INTO fixture_usage VALUES (1,7)");
 }
 if(imports || cancelled) {
  dataDb.exec(migration);
  if(imports) dataDb.prepare("INSERT INTO yta_summary_imports VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run('fixture-import','fixture-owner','fixture-analysis',1,'1'.repeat(64),'SYNTHETIC_TRANSCRIPT','2'.repeat(64),12,'Synthetic note','EXISTING_TRANSCRIPT_IMPORTED','OWNER_SOURCE_RECONCILIATION','2000-01-01T00:00:00Z');
  if(cancelled)dataDb.exec("INSERT INTO yta_summary_import_requests VALUES ('fixture-owner','fixture-analysis','fixture-request','CANCELLED',NULL,NULL,'2000-01-01T00:00:00Z')");
 }
 let time=1000;
 const now=()=>time,store=createOfflineOperationalStore({database:storeDb});
 const {binding}=createOfflineD1FixtureBinding(dataDb);
 const controller=createOfflineOperationalController({store,now});
 await controller.initialize({identity:current,inventory});
 const writers=inventory.flatMap(item=>item.instances.map(instance=>controller.createWriter({writerClass:item.writerClass,writerId:instance.id,sourceCommit:current.sourceCommit})));
 const snapshot=(identity=current)=>captureOfflineOperationalDataSnapshot({database:dataDb,identity,now:time});
 const targetObservation=(identity=target)=>captureOfflineOperationalTarget({identity,artifactBytes:targetArtifact,configurationBytes:config,ownerPolicyBytes:policy,now:time});
 const close=async()=>{
  await controller.close();
  for(const writer of writers)await writer.checkpointClosed();
  for(const category of inventory.filter(item=>item.instances.length===0))await controller.acknowledgeAbsentClass({writerClass:category.writerClass});
  await controller.sealWindow({snapshot:controller.captureDrainedSnapshot({database:dataDb})});
 };
 return {storeDb,dataDb,store,controller,writers,snapshot,targetObservation,close,now,binding,args:(identity=current)=>args(identity,binding),setTime(value){time=value;}};
}

test('complete synthetic inventory closes every writer class and grants no production authority',async t=>{
 const f=await fixture(t);await f.close();
 const status=f.controller.status();assert.equal(status.phase,'FENCED');assert.equal(status.acknowledgedWriters,14);
 assert.equal(status.productionExecutionSupported,false);assert.equal(status.operationallyAuthorized,false);assert.equal(status.productionEnforcementVerified,false);assert.equal(status.writesMayResume,false);
 assert.equal(typeof f.controller.resume,'undefined');
 for(const writer of f.writers)await assert.rejects(writer.admit(),expected('WRITES_CLOSED'));
});

test('read side effects, continuations and external admin/build classes cannot be omitted',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const c=createOfflineOperationalController({store:createOfflineOperationalStore({database:db})});
 for(const absent of ['READ_PATH_SIDE_EFFECTS','PROVIDER_DISPATCH_AND_CONTINUATIONS','BUILDS_AND_DEPLOYMENTS','RESTORE_AND_DIRECT_DATABASE_WRITERS']) {
  await assert.rejects(c.initialize({identity:current,inventory:inventoryFor().filter(item=>item.writerClass!==absent)}),expected('FULL_WRITER_INVENTORY_REQUIRED'));
 }
});

test('duplicate class cannot substitute for missing external writer class',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const inventory=inventoryFor();inventory[13]=inventory[0];
 await assert.rejects(createOfflineOperationalController({store:createOfflineOperationalStore({database:db})}).initialize({identity:current,inventory}),expected('WRITER_CLASS_DUPLICATED'));
});

test('empty category requires explicit synthetic absence and a close checkpoint',async t=>{
 const inventory=inventoryFor();inventory[9]={writerClass:inventory[9].writerClass,instances:[],absence:'SYNTHETIC_FIXTURE_NOT_CONFIGURED'};
 const f=await fixture(t,{inventory});await f.controller.close();for(const w of f.writers)await w.checkpointClosed();
 await assert.rejects(f.controller.sealWindow({snapshot:f.snapshot()}),expected('ALL_WRITER_ACKS_REQUIRED'));
 await f.controller.acknowledgeAbsentClass({writerClass:'QUEUES_AND_SCHEDULES'});await f.controller.sealWindow({snapshot:f.controller.captureDrainedSnapshot({database:f.dataDb})});assert.equal(f.controller.status().phase,'FENCED');
});

test('unknown absence is not promoted to an observed empty writer category',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const inventory=inventoryFor();inventory[9]={writerClass:inventory[9].writerClass,instances:[],absence:null};
 await assert.rejects(createOfflineOperationalController({store:createOfflineOperationalStore({database:db})}).initialize({identity:current,inventory}),expected('WRITER_ABSENCE_UNPROVED'));
});

test('registered writer cannot be falsely acknowledged absent',async t=>{
 const f=await fixture(t);await f.controller.close();await assert.rejects(f.controller.acknowledgeAbsentClass({writerClass:'HTTP_MUTATIONS'}),expected('WRITER_ABSENCE_UNPROVED'));
});

test('unknown writer incident closes the controller durably and prevents capability issuance',async t=>{
 const f=await fixture(t);await f.close();await f.controller.reportUnknownWriter();
 await assert.rejects(f.controller.issueMigrationCapability({sourceSha256:SOURCE}),expected('ALL_WRITERS_NOT_FENCED'));
 const reopened=createOfflineOperationalController({store:createOfflineOperationalStore({database:f.storeDb}),now:f.now});
 assert.equal(reopened.status().phase,'BLOCKED');assert.equal(reopened.status().reason,'UNKNOWN_WRITER');await reopened.close();assert.equal(reopened.status().phase,'BLOCKED');
});

test('unregistered or wrong-source writer cannot acquire an admission',async t=>{
 const f=await fixture(t);assert.throws(()=>f.controller.createWriter({writerClass:'UNLISTED',writerId:'fixture-writer-0',sourceCommit:current.sourceCommit}),expected('WRITER_UNREGISTERED'));
 assert.throws(()=>f.controller.createWriter({writerClass:'HTTP_MUTATIONS',writerId:'fixture-writer-0',sourceCommit:'d'.repeat(40)}),expected('WRITER_UNREGISTERED'));
});

test('close racing an admitted operation retains it until confirmed completion',async t=>{
 const f=await fixture(t);const ticket=await f.writers[0].admit();await f.controller.close();
 await assert.rejects(f.writers[0].checkpointClosed(),expected('WRITER_NOT_DRAINED'));
 await assert.rejects(f.controller.sealWindow({snapshot:f.snapshot()}),expected('ADMISSIONS_NOT_DRAINED'));
 await f.writers[0].complete({ticket,outcome:'CONFIRMED'});for(const w of f.writers)await w.checkpointClosed();await f.controller.sealWindow({snapshot:f.controller.captureDrainedSnapshot({database:f.dataDb})});assert.equal(f.controller.status().activeAdmissions,0);
});

test('closing first rejects a concurrent later admission',async t=>{
 const f=await fixture(t);const closing=f.controller.close();const admission=f.writers[0].admit();await closing;await assert.rejects(admission,expected('WRITES_CLOSED'));assert.equal(f.controller.status().activeAdmissions,0);
});

test('uncertain provider completion persists as unknown and never drains by lease expiry',async t=>{
 const f=await fixture(t);const ticket=await f.writers[2].admit();await f.controller.close();await f.writers[2].complete({ticket,outcome:'UNKNOWN'});
 f.setTime(999999);const reopened=createOfflineOperationalController({store:createOfflineOperationalStore({database:f.storeDb}),now:f.now});
 assert.equal(reopened.status().unknownAdmissions,1);assert.equal(reopened.status().phase,'CLOSING');await reopened.close();assert.equal(reopened.status().unknownAdmissions,1);
 await assert.rejects(f.writers[2].checkpointClosed(),expected('WRITER_NOT_DRAINED'));assert.equal(typeof reopened.resolveUnknown,'undefined');
});

test('another writer cannot finish a different writer admission',async t=>{
 const f=await fixture(t);const ticket=await f.writers[0].admit();await assert.rejects(f.writers[1].complete({ticket,outcome:'CONFIRMED'}),expected('ADMISSION_NOT_PENDING'));assert.equal(f.controller.status().activeAdmissions,1);
});

test('confirmed completion is one-shot; replay cannot alter outcome',async t=>{
 const f=await fixture(t);const ticket=await f.writers[0].admit();await f.writers[0].complete({ticket,outcome:'CONFIRMED'});await assert.rejects(f.writers[0].complete({ticket,outcome:'UNKNOWN'}),expected('ADMISSION_NOT_PENDING'));
});

test('stale inventory cannot admit or seal; closing never refreshes inventory age',async t=>{
 const f=await fixture(t);f.setTime(302000);await assert.rejects(f.writers[0].admit(),expected('EVIDENCE_STALE'));await f.controller.close();for(const w of f.writers)await w.checkpointClosed();await assert.rejects(f.controller.sealWindow({snapshot:f.snapshot()}),expected('EVIDENCE_STALE'));
});

test('clock rollback blocks both new admissions and status observations',async t=>{
 const f=await fixture(t);f.setTime(999);await assert.rejects(f.writers[0].admit(),expected('CLOCK_ROLLBACK'));assert.throws(()=>f.controller.status(),expected('CLOCK_ROLLBACK'));
});

test('pre-close observation cannot stand in for the drained baseline',async t=>{
 const f=await fixture(t);const snapshot=f.snapshot();f.setTime(1001);await f.controller.close();for(const w of f.writers)await w.checkpointClosed();await assert.rejects(f.controller.sealWindow({snapshot}),expected('DRAINED_OBSERVATION_REQUIRED'));
});

test('cloned or hand-written data verification does not issue a capability',async t=>{
 const f=await fixture(t);await f.controller.close();for(const w of f.writers)await w.checkpointClosed();
 await assert.rejects(f.controller.sealWindow({snapshot:JSON.parse(JSON.stringify(f.snapshot()))}),expected('DATA_OBSERVATION_UNISSUED'));
 await assert.rejects(f.controller.sealWindow({snapshot:{verified:true}}),expected('DATA_OBSERVATION_UNISSUED'));
});

test('partial imported-summary DDL is refused before a fence is sealed',async t=>{
 const f=await fixture(t);f.dataDb.exec('CREATE TABLE yta_summary_imports(id TEXT)');assert.throws(()=>f.snapshot(),expected('FULL_IMPORT_DDL_REQUIRED'));
});

test('unfinished durable deletion tombstone blocks despite empty admission ledger',async t=>{
 const f=await fixture(t,{imports:true});f.dataDb.exec("INSERT INTO yta_operations VALUES ('fixture-delete','fixture-analysis','deletion','DELETING')");assert.throws(()=>f.snapshot(),expected('DELETION_NOT_DRAINED'));
});

test('orphan private text is never silently treated as rollback-ready',async t=>{
 const f=await fixture(t,{imports:true});f.dataDb.exec("DELETE FROM jobs WHERE id='fixture-analysis'");assert.throws(()=>f.snapshot(),expected('IMPORT_INTEGRITY_FAILED'));
});

test('0021 exact scope required; 0016 or all-migration approval is rejected',async t=>{
 const f=await fixture(t);await f.close();for(const sourceSha256 of ['0'.repeat(64),'0016','all'])await assert.rejects(f.controller.issueMigrationCapability({sourceSha256}),expected('0021_EXACT_SOURCE_REQUIRED'));
});

test('capability is opaque and bound to exact identity, operation and migration hash',async t=>{
 const f=await fixture(t);await f.close();const capability=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});
 await assert.rejects(assertOfflineOperationalCapability({...capability},f.args()),expected('CAPABILITY_UNISSUED'));
 await assert.rejects(assertOfflineOperationalCapability(capability,{...f.args(),operation:'MIGRATION_0016'}),expected('CAPABILITY_SCOPE_MISMATCH'));
 await assert.rejects(assertOfflineOperationalCapability(capability,f.args({...current,versionId:target.versionId})),expected('CAPABILITY_SCOPE_MISMATCH'));
 await assert.rejects(assertOfflineOperationalCapability(capability,{...f.args(),sourceSha256:'0'.repeat(64)}),expected('CAPABILITY_SCOPE_MISMATCH'));
 assert.equal((await assertOfflineOperationalCapability(capability,f.args())).operationallyAuthorized,false);
});

test('concurrent adapters can claim only one durable migration attempt',async t=>{
 const f=await fixture(t);await f.close();const capability=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});
 const results=await Promise.allSettled([beginOfflineOperationalMutation(capability,f.args()),beginOfflineOperationalMutation(capability,f.args())]);
 assert.equal(results.filter(item=>item.status==='fulfilled').length,1);assert.equal(results.find(item=>item.status==='rejected').reason.code,'OPERATIONAL_CONTRACT_MUTATION_ALREADY_ATTEMPTED');
});

test('crash after reservation cannot produce a second capability after restart',async t=>{
 const f=await fixture(t);await f.close();await f.controller.issueMigrationCapability({sourceSha256:SOURCE});
 const reopened=createOfflineOperationalController({store:createOfflineOperationalStore({database:f.storeDb}),now:f.now});
 await assert.rejects(reopened.issueMigrationCapability({sourceSha256:SOURCE}),expected('OPERATION_ALREADY_RESERVED'));assert.equal(reopened.status().phase,'MIGRATION_RESERVED');
});

test('unknown ACK allows only readback and prevents automatic mutation retry',async t=>{
 const f=await fixture(t);await f.close();const cap=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});await beginOfflineOperationalMutation(cap,f.args());await finishOfflineOperationalMutation(cap,{outcome:'UNKNOWN'});
 assert.equal((await assertOfflineOperationalCapability(cap,f.args())).phase,'MIGRATION_UNKNOWN');await assert.rejects(beginOfflineOperationalMutation(cap,f.args()),expected('MUTATION_ALREADY_ATTEMPTED'));
 const restarted=createOfflineOperationalController({store:createOfflineOperationalStore({database:f.storeDb}),now:f.now});assert.equal(restarted.status().phase,'MIGRATION_UNKNOWN');await assert.rejects(restarted.issueMigrationCapability({sourceSha256:SOURCE}),expected('OPERATION_ALREADY_RESERVED'));
});

test('postcheck after ACK can fail closed but never claims rollback of D1 commit',async t=>{
 const f=await fixture(t);await f.close();const cap=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});await beginOfflineOperationalMutation(cap,f.args());await finishOfflineOperationalMutation(cap,{outcome:'ACKNOWLEDGED'});await finishOfflineOperationalMutation(cap,{outcome:'POSTCHECK_FAILED'});
 assert.equal(f.controller.status().phase,'MIGRATION_POSTCHECK_FAILED');assert.equal(f.controller.status().writesMayResume,false);await assert.rejects(beginOfflineOperationalMutation(cap,f.args()),expected('MUTATION_ALREADY_ATTEMPTED'));
});

test('expiry invalidates capability without reopening writes or forgetting attempt',async t=>{
 const f=await fixture(t);await f.close();const cap=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});await beginOfflineOperationalMutation(cap,f.args());f.setTime(302000);
 await assert.rejects(assertOfflineOperationalCapability(cap,f.args()),expected('EVIDENCE_STALE'));assert.equal(f.controller.status().phase,'MIGRATION_ACTIVE');await assert.rejects(f.writers[0].admit(),expected('WRITES_CLOSED'));
});

test('newly observed unknown writer invalidates an existing capability immediately',async t=>{
 const f=await fixture(t);await f.close();const cap=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});await f.controller.reportUnknownWriter();await assert.rejects(assertOfflineOperationalCapability(cap,f.args()),expected('ALL_WRITERS_NOT_FENCED'));
});

test('target observation requires exact artifact, configuration and owner policy bytes',()=>{
 for(const change of [{artifactBytes:bytes('changed')},{configurationBytes:bytes('changed')},{ownerPolicyBytes:bytes('changed')}])assert.throws(()=>captureOfflineOperationalTarget({identity:target,artifactBytes:targetArtifact,configurationBytes:config,ownerPolicyBytes:policy,now:1000,...change}),expected('TARGET_ARTIFACT_BYTES_MISMATCH'));
});

test('production claims and unprotected owner target cannot become offline evidence',()=>{
 assert.throws(()=>canonicalOperationalIdentity({...current,evidenceKind:'VERIFIED_PRODUCTION'}),expected('SYNTHETIC_IDENTITY_REQUIRED'));
 assert.throws(()=>canonicalOperationalIdentity({...current,ownerOnlyEnforced:false}),expected('SYNTHETIC_IDENTITY_REQUIRED'));
 assert.throws(()=>canonicalOperationalIdentity({...current,verified:true}),expected('SYNTHETIC_IDENTITY_REQUIRED'));
});

test('legacy code rollback blocked when imported text exists',async t=>{
 const f=await fixture(t,{imports:true});await f.close();const legacy=f.targetObservation({...target,importDeletionCompatibility:'NONE'});await assert.rejects(f.controller.prepareRollback({target:legacy,snapshot:f.snapshot()}),expected('ROLLBACK_CLEANUP_INCOMPATIBLE'));
});

test('cancel request ledger also requires compatible cleanup despite no saved summary',async t=>{
 const f=await fixture(t,{cancelled:true});await f.close();const legacy=f.targetObservation({...target,importDeletionCompatibility:'NONE'});await assert.rejects(f.controller.prepareRollback({target:legacy,snapshot:f.snapshot()}),expected('ROLLBACK_CLEANUP_INCOMPATIBLE'));
});

test('truly empty imported storage may rehearse legacy rollback while writes stay closed',async t=>{
 const f=await fixture(t);await f.close();const legacy=f.targetObservation({...target,importDeletionCompatibility:'NONE'});const plan=await f.controller.prepareRollback({target:legacy,snapshot:f.snapshot()});
 const result=await f.controller.verifyRollback({plan,observedTarget:f.targetObservation({...target,importDeletionCompatibility:'NONE'}),snapshot:f.snapshot({...target,importDeletionCompatibility:'NONE'})});assert.equal(result.status,'OFFLINE_CONTRACT_VERIFIED_CLOSED');assert.equal(f.controller.status().writesMayResume,false);
});

test('compatible rollback preserves actual synthetic imports, approvals and usage bytes',async t=>{
 const f=await fixture(t,{imports:true,cancelled:true});f.dataDb.exec("CREATE TABLE fixture_approvals(id TEXT PRIMARY KEY,state TEXT);INSERT INTO fixture_approvals VALUES ('fixture-approval','RECORDED')");await f.close();const before=f.snapshot();const observation=f.targetObservation();const plan=await f.controller.prepareRollback({target:observation,snapshot:before});
 const result=await f.controller.verifyRollback({plan,observedTarget:f.targetObservation(),snapshot:f.snapshot(target)});assert.equal(result.writesMayResume,false);assert.equal(f.controller.status().phase,'ROLLBACK_VERIFIED_CLOSED');assert.equal(f.snapshot(target).databaseSha256,before.databaseSha256);assert.equal(f.dataDb.prepare('SELECT count(*) n FROM yta_summary_imports').get().n,1);
});

test('rollback preserves database binding, runtime configuration and owner policy identity',async t=>{
 for(const field of ['databaseIdentitySha256','configurationSha256','ownerPolicySha256']) {
  const f=await fixture(t);await f.close();const changed={...target,[field]:'d'.repeat(64)};
  if(field==='databaseIdentitySha256')await assert.rejects(f.controller.prepareRollback({target:f.targetObservation(changed),snapshot:f.snapshot()}),expected('ROLLBACK_IDENTITY_PRESERVATION_FAILED'));
  else assert.throws(()=>f.targetObservation(changed),expected('TARGET_ARTIFACT_BYTES_MISMATCH'));
 }
});

test('rollback plan and target receipt clones are rejected',async t=>{
 const f=await fixture(t);await f.close();const observation=f.targetObservation();await assert.rejects(f.controller.prepareRollback({target:{...observation},snapshot:f.snapshot()}),expected('ROLLBACK_OBSERVATION_UNISSUED'));
 const plan=await f.controller.prepareRollback({target:observation,snapshot:f.snapshot()});await assert.rejects(f.controller.verifyRollback({plan:{...plan},observedTarget:f.targetObservation(),snapshot:f.snapshot(target)}),expected('ROLLBACK_OBSERVATION_UNISSUED'));
});

test('rollback plan cannot be consumed by a different controller',async t=>{
 const f=await fixture(t),other=await fixture(t);await f.close();await other.close();const observation=f.targetObservation();const plan=await f.controller.prepareRollback({target:observation,snapshot:f.snapshot()});await assert.rejects(other.controller.verifyRollback({plan,observedTarget:f.targetObservation(),snapshot:f.snapshot(target)}),expected('ROLLBACK_OBSERVATION_UNISSUED'));
});

test('same contents in a different database cannot replace the bound rollback database',async t=>{
 const f=await fixture(t),other=await fixture(t);await f.close();const observation=f.targetObservation();const plan=await f.controller.prepareRollback({target:observation,snapshot:f.snapshot()});
 await assert.rejects(f.controller.verifyRollback({plan,observedTarget:f.targetObservation(),snapshot:other.snapshot(target)}),expected('ROLLBACK_DATA_CHANGED'));assert.equal(f.controller.status().phase,'BLOCKED');
});

test('post-rollback data mutation fails closed and never deletes or restores user data',async t=>{
 const f=await fixture(t,{imports:true});await f.close();const observation=f.targetObservation();const plan=await f.controller.prepareRollback({target:observation,snapshot:f.snapshot()});f.dataDb.exec('UPDATE fixture_usage SET amount=8 WHERE id=1');
 await assert.rejects(f.controller.verifyRollback({plan,observedTarget:f.targetObservation(),snapshot:f.snapshot(target)}),expected('ROLLBACK_DATA_CHANGED'));assert.equal(f.controller.status().phase,'BLOCKED');assert.equal(f.dataDb.prepare('SELECT amount FROM fixture_usage').get().amount,8);assert.equal(f.dataDb.prepare('SELECT count(*) n FROM yta_summary_imports').get().n,1);
});

test('wrong rollback target version fails even when data and artifact bytes match',async t=>{
 const f=await fixture(t);await f.close();const observation=f.targetObservation();const plan=await f.controller.prepareRollback({target:observation,snapshot:f.snapshot()});const wrong={...target,versionId:'33333333-3333-3333-3333-333333333333'};
 await assert.rejects(f.controller.verifyRollback({plan,observedTarget:f.targetObservation(wrong),snapshot:f.snapshot(wrong)}),expected('ROLLBACK_TARGET_MISMATCH'));assert.equal(f.controller.status().phase,'BLOCKED');
});

test('stale rollback readback never auto-opens the fence',async t=>{
 const f=await fixture(t);await f.close();const observation=f.targetObservation();const plan=await f.controller.prepareRollback({target:observation,snapshot:f.snapshot()});f.setTime(302000);
 await assert.rejects(f.controller.verifyRollback({plan,observedTarget:f.targetObservation(),snapshot:f.snapshot(target)}),expected('EVIDENCE_STALE'));assert.equal(f.controller.status().phase,'BLOCKED');
});

test('durable closure, admission and unknown mutation survive closing and reopening local files',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'fixture-operational-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'contract.sqlite');
 let database=new DatabaseSync(path);const f=await fixture(t,{storeDb:database});await f.close();const cap=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});await beginOfflineOperationalMutation(cap,f.args());await finishOfflineOperationalMutation(cap,{outcome:'UNKNOWN'});database.close();
 database=new DatabaseSync(path);t.after(()=>database.close());const reopened=createOfflineOperationalController({store:createOfflineOperationalStore({database}),now:f.now});
 assert.equal(reopened.status().phase,'MIGRATION_UNKNOWN');assert.equal(reopened.status().epoch,1);await assert.rejects(reopened.initialize({identity:current,inventory:inventoryFor()}),expected('ALREADY_INITIALIZED'));await assert.rejects(reopened.issueMigrationCapability({sourceSha256:SOURCE}),expected('OPERATION_ALREADY_RESERVED'));
});

test('two store connections share the same closed state rather than per-isolate booleans',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'fixture-operational-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'contract.sqlite');
 const db1=new DatabaseSync(path),db2=new DatabaseSync(path);t.after(()=>{db1.close();db2.close();});const f=await fixture(t,{storeDb:db1});const second=createOfflineOperationalController({store:createOfflineOperationalStore({database:db2}),now:f.now});
 const writer=second.createWriter({writerClass:'HTTP_MUTATIONS',writerId:'fixture-writer-0',sourceCommit:current.sourceCommit});await f.controller.close();await assert.rejects(writer.admit(),expected('WRITES_CLOSED'));assert.equal(second.status().epoch,1);
});

test('failed durable CAS does not acknowledge closure or invent a mutation result',async t=>{
 const f=await fixture(t);f.storeDb.exec('PRAGMA query_only=ON');await assert.rejects(f.controller.close(),expected('STORE_OUTCOME_UNCONFIRMED'));assert.equal(f.controller.status().phase,'OPEN');f.storeDb.exec('PRAGMA query_only=OFF');await f.controller.close();assert.equal(f.controller.status().phase,'CLOSING');
});

test('store cannot be created inside an application database or from a pretend remote object',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE jobs(id TEXT)');assert.throws(()=>createOfflineOperationalStore({database:db}),expected('STORE_SCHEMA_MISMATCH'));assert.throws(()=>createOfflineOperationalStore({database:{prepare(){throw Error('remote');}}}),expected('LOCAL_DATABASE_REQUIRED'));
 assert.throws(()=>createOfflineOperationalController({store:{verified:true}}),expected('OFFLINE_STORE_REQUIRED'));
});

test('attached/temp schemas cannot hide another operational store or database',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("ATTACH ':memory:' AS foreign_database");assert.throws(()=>createOfflineOperationalStore({database:db}),expected('ATTACHED_DATABASE_FORBIDDEN'));db.exec('DETACH foreign_database');db.exec('CREATE TEMP TABLE fixture_temp(id INTEGER)');assert.throws(()=>createOfflineOperationalStore({database:db}),expected('TEMP_SCHEMA_FORBIDDEN'));
});

test('all public reports are flags, counts and digests, never synthetic private payload text',async t=>{
 const f=await fixture(t,{imports:true});await f.close();const cap=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});const reports=JSON.stringify([f.controller.status(),f.snapshot(),cap,await assertOfflineOperationalCapability(cap,f.args())]);
 for(const value of ['Synthetic note','fixture-import','fixture-analysis','fixture-owner'])assert.equal(reports.includes(value),false);
 assert.equal(reports.includes('productionEnforcementVerified":true'),false);
});

test('same-time snapshot taken before drain is rejected even after every writer finishes',async t=>{
 const f=await fixture(t);const ticket=await f.writers[0].admit();await f.controller.close();
 const stale=f.snapshot();assert.throws(()=>f.controller.captureDrainedSnapshot({database:f.dataDb}),expected('ADMISSIONS_NOT_DRAINED'));
 f.dataDb.exec('UPDATE fixture_usage SET amount=8');await f.writers[0].complete({ticket,outcome:'CONFIRMED'});for(const writer of f.writers)await writer.checkpointClosed();
 await assert.rejects(f.controller.sealWindow({snapshot:stale}),expected('DRAINED_OBSERVATION_REQUIRED'));
 const drained=f.controller.captureDrainedSnapshot({database:f.dataDb});await f.controller.sealWindow({snapshot:drained});assert.equal(f.controller.status().phase,'FENCED');
});

test('captured drain receipt expires after any durable state revision change',async t=>{
 const f=await fixture(t);await f.controller.close();for(const writer of f.writers)await writer.checkpointClosed();
 const snapshot=f.controller.captureDrainedSnapshot({database:f.dataDb});await f.controller.close();
 await assert.rejects(f.controller.sealWindow({snapshot}),expected('DRAINED_OBSERVATION_REQUIRED'));
});

test('drain receipt from another controller store cannot authorize this store',async t=>{
 const f=await fixture(t),other=await fixture(t);for(const one of [f,other]){await one.controller.close();for(const writer of one.writers)await writer.checkpointClosed();}
 const foreign=other.controller.captureDrainedSnapshot({database:f.dataDb});await assert.rejects(f.controller.sealWindow({snapshot:foreign}),expected('DRAINED_OBSERVATION_REQUIRED'));
});

test('a different actual local D1 database cannot be relabeled by identical identity claims',async t=>{
 const f=await fixture(t),other=await fixture(t);await f.close();const cap=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});
 await assert.rejects(assertOfflineOperationalCapability(cap,{...f.args(),binding:other.binding}),expected('D1_FIXTURE_DATABASE_MISMATCH'));
 await assert.rejects(beginOfflineOperationalMutation(cap,{...f.args(),binding:other.binding}),expected('D1_FIXTURE_DATABASE_MISMATCH'));
 assert.equal(f.controller.status().phase,'MIGRATION_RESERVED');
});

test('arbitrary network-shaped object and cloned fixture binding are never registered authority',async t=>{
 const f=await fixture(t);await f.close();const cap=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});
 for(const binding of [{withSession(){throw Error('Must not call');}},{...f.binding},undefined])await assert.rejects(assertOfflineOperationalCapability(cap,{...f.args(),binding}),expected('D1_FIXTURE_DATABASE_MISMATCH'));
 assert.equal(Object.isFrozen(f.binding),true);assert.throws(()=>{f.binding.withSession=()=>{};},TypeError);
});

test('out-of-band data drift between sealing and preflight blocks before any mutation claim',async t=>{
 const f=await fixture(t);await f.close();const cap=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});f.dataDb.exec('UPDATE fixture_usage SET amount=8');
 await assert.rejects(assertOfflineOperationalCapability(cap,f.args()),expected('FENCED_DATA_BASELINE_CHANGED'));assert.equal(f.controller.status().phase,'MIGRATION_RESERVED');
});

test('new controller can rehydrate read-only capability after an attempted unknown migration',async t=>{
 const f=await fixture(t);await f.close();const oldCap=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});await beginOfflineOperationalMutation(oldCap,f.args());await finishOfflineOperationalMutation(oldCap,{outcome:'UNKNOWN'});
 const restarted=createOfflineOperationalController({store:createOfflineOperationalStore({database:f.storeDb}),now:f.now});
 const readback=restarted.issueMigrationReadbackCapability({sourceSha256:SOURCE});const checked=await assertOfflineOperationalCapability(readback,f.args());assert.equal(checked.readOnly,true);assert.equal(checked.phase,'MIGRATION_UNKNOWN');
 await assert.rejects(beginOfflineOperationalMutation(readback,f.args()),expected('READBACK_ONLY_CAPABILITY'));await assert.rejects(finishOfflineOperationalMutation(readback,{outcome:'ACKNOWLEDGED'}),expected('READBACK_ONLY_CAPABILITY'));assert.equal(restarted.status().phase,'MIGRATION_UNKNOWN');
});

test('reserved-but-unattempted operation cannot be rehydrated as an attempted readback',async t=>{
 const f=await fixture(t);await f.close();await f.controller.issueMigrationCapability({sourceSha256:SOURCE});assert.throws(()=>f.controller.issueMigrationReadbackCapability({sourceSha256:SOURCE}),expected('NO_ATTEMPT_TO_READ_BACK'));
});

test('contract data database must be separate and store schema must stay dedicated',async t=>{
 const f=await fixture(t);await f.controller.close();for(const writer of f.writers)await writer.checkpointClosed();assert.throws(()=>f.controller.captureDrainedSnapshot({database:f.storeDb}),expected('SEPARATE_DATA_DATABASE_REQUIRED'));
 f.storeDb.exec('CREATE TABLE fixture_intruder(id INTEGER)');assert.throws(()=>f.controller.status(),expected('STORE_SCHEMA_MISMATCH'));
});

test('lost CAS acknowledgement is not retried and durable closure remains visible',async t=>{
 const f=await fixture(t),original=f.storeDb.prepare.bind(f.storeDb);let updates=0;
 f.storeDb.prepare=function(sql){
  const statement=original(sql);if(!sql.startsWith('UPDATE offline_operational_contract'))return statement;
  const run=statement.run.bind(statement);statement.run=function(...values){updates++;run(...values);throw Error('Synthetic committed CAS ACK lost');};return statement;
 };
 await assert.rejects(f.controller.close(),expected('STORE_OUTCOME_UNCONFIRMED'));assert.equal(updates,1);
 f.storeDb.prepare=original;assert.equal(f.controller.status().phase,'CLOSING');await assert.rejects(f.writers[0].admit(),expected('WRITES_CLOSED'));
});

test('lost acknowledgement of migration claim leaves attempted durable state and only readback recovery',async t=>{
 const f=await fixture(t);await f.close();const capability=await f.controller.issueMigrationCapability({sourceSha256:SOURCE});
 const original=f.storeDb.prepare.bind(f.storeDb);let updates=0;
 f.storeDb.prepare=function(sql){
  const statement=original(sql);if(!sql.startsWith('UPDATE offline_operational_contract'))return statement;
  const run=statement.run.bind(statement);statement.run=function(...values){updates++;run(...values);throw Error('Synthetic claim ACK lost');};return statement;
 };
 await assert.rejects(beginOfflineOperationalMutation(capability,f.args()),expected('STORE_OUTCOME_UNCONFIRMED'));assert.equal(updates,1);f.storeDb.prepare=original;
 const restarted=createOfflineOperationalController({store:createOfflineOperationalStore({database:f.storeDb}),now:f.now});assert.equal(restarted.status().phase,'MIGRATION_ACTIVE');
 const readback=restarted.issueMigrationReadbackCapability({sourceSha256:SOURCE});assert.equal((await assertOfflineOperationalCapability(readback,f.args())).readOnly,true);await assert.rejects(beginOfflineOperationalMutation(readback,f.args()),expected('READBACK_ONLY_CAPABILITY'));
});

test('CAS conflict between observed OPEN and concurrent close cannot admit a late writer',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'fixture-operational-cas-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'contract.sqlite');
 const db1=new DatabaseSync(path),db2=new DatabaseSync(path);t.after(()=>{db1.close();db2.close();});const f=await fixture(t,{storeDb:db1});const second=createOfflineOperationalController({store:createOfflineOperationalStore({database:db2}),now:f.now});
 const original=db1.prepare.bind(db1);let trigger=true,closing;
 db1.prepare=function(sql){
  const statement=original(sql);if(sql!=='SELECT marker,revision,payload FROM offline_operational_contract')return statement;
  const all=statement.all.bind(statement);statement.all=function(...values){const result=all(...values);if(trigger){trigger=false;closing=second.close();}return result;};return statement;
 };
 await assert.rejects(f.writers[0].admit(),expected('WRITES_CLOSED'));await closing;db1.prepare=original;assert.equal(f.controller.status().activeAdmissions,0);assert.equal(second.status().phase,'CLOSING');
});

test('rollback postcheck cannot reuse earlier opaque observations at the same timestamp',async t=>{
 const f=await fixture(t);await f.close();const targetBefore=f.targetObservation(),dataBefore=f.snapshot(target);
 const plan=await f.controller.prepareRollback({target:targetBefore,snapshot:f.snapshot()});
 await assert.rejects(f.controller.verifyRollback({plan,observedTarget:targetBefore,snapshot:dataBefore}),expected('ROLLBACK_POSTCHECK_NOT_CAUSAL'));assert.equal(f.controller.status().phase,'BLOCKED');
});

test('data changed after drain capture cannot be sealed from stale local snapshot',async t=>{
 const f=await fixture(t);await f.controller.close();for(const writer of f.writers)await writer.checkpointClosed();const snapshot=f.controller.captureDrainedSnapshot({database:f.dataDb});
 f.dataDb.exec('UPDATE fixture_usage SET amount=8');await assert.rejects(f.controller.sealWindow({snapshot}),expected('DATA_CAPTURE_CHANGED'));
});

test('rollback verifies actual current database after a newly issued postcheck receipt',async t=>{
 const f=await fixture(t);await f.close();const plan=await f.controller.prepareRollback({target:f.targetObservation(),snapshot:f.snapshot()});
 const observedTarget=f.targetObservation(),snapshot=f.snapshot(target);f.dataDb.exec('UPDATE fixture_usage SET amount=8');
 await assert.rejects(f.controller.verifyRollback({plan,observedTarget,snapshot}),expected('ROLLBACK_DATA_CHANGED'));assert.equal(f.controller.status().phase,'BLOCKED');
});

test('rollback cannot prepare from stale local baseline after out-of-band data mutation',async t=>{
 const f=await fixture(t);await f.close();const snapshot=f.snapshot();f.dataDb.exec('UPDATE fixture_usage SET amount=8');
 await assert.rejects(f.controller.prepareRollback({target:f.targetObservation(),snapshot}),expected('ROLLBACK_BASELINE_CHANGED'));
});
