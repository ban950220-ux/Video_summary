import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createOfflineD1ManualSummaryAdapter, D1_MANUAL_SUMMARY_SOURCE_SHA256} from '../scripts/manual-summary-d1-adapter.mjs';
import {reviewedMigrationSource} from '../scripts/migration-source-catalog.mjs';
import {createSyntheticD1Binding} from './helpers/manual-summary-d1-fixture.mjs';
import {
 createOfflineOperationalStore, createOfflineOperationalController, requiredOperationalWriterClasses,
 captureOfflineOperationalDataSnapshot, canonicalOperationalIdentity,
} from '../scripts/manual-summary-operational-contract.mjs';

const SOURCE = readFileSync(new URL('../migrations/0021_manual_summary_imports.sql', import.meta.url));
const identity = canonicalOperationalIdentity({evidenceKind: 'SYNTHETIC_OFFLINE_CONTRACT', sourceCommit: '1'.repeat(40),
 versionId: '11111111-1111-4111-8111-111111111111', artifactSha256: '2'.repeat(64), databaseIdentitySha256: '3'.repeat(64),
 configurationSha256: '4'.repeat(64), ownerPolicySha256: '5'.repeat(64), ownerOnlyEnforced: true, importDeletionCompatibility: 'OWNER_TOMBSTONE_IMPORT_CLEANUP_V1'});
async function setup(t, options = {}) {
 const db = new DatabaseSync(':memory:'), controlDb = new DatabaseSync(':memory:');
 t.after(() => { db.close(); controlDb.close(); });
 db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL); INSERT INTO jobs VALUES('fixture-job','fixture-owner'); CREATE TABLE original_data(value); CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO d1_migrations VALUES(1,'fixture_prior.sql'); CREATE TABLE fixture_usage(n INTEGER); INSERT INTO fixture_usage VALUES(7)");
 if (options.beforeSeal) options.beforeSeal(db);
 let now = 1000;
 const clock = () => now;
 const store = createOfflineOperationalStore({database: controlDb}), controller = createOfflineOperationalController({store, now: clock});
 const inventory = requiredOperationalWriterClasses.map((writerClass, index) => ({writerClass, instances: [{id: `fixture-writer-${index}`, sourceCommit: identity.sourceCommit}], absence: null}));
 await controller.initialize({identity, inventory});
 const writers = inventory.map(item => controller.createWriter({writerClass: item.writerClass, writerId: item.instances[0].id, sourceCommit: identity.sourceCommit}));
 await controller.close();
 for (const writer of writers) await writer.checkpointClosed();
 await controller.sealWindow({snapshot: await controller.captureDrainedSnapshot({database: db})});
 const cap = await controller.issueMigrationCapability({sourceSha256: D1_MANUAL_SUMMARY_SOURCE_SHA256});
 const fixture = createSyntheticD1Binding(db, options.faults);
 const args = {binding: fixture.binding, sourceBytes: SOURCE, catalog: reviewedMigrationSource(), identity, fenceCapability: cap, now: clock, limits: options.limits};
 const adapter = await createOfflineD1ManualSummaryAdapter(args);
 return {db, controller, controlDb, store, cap, fixture, args, adapter, advance: milliseconds => {now += milliseconds;}};
}
function importSchema(db) { return db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('yta_summary_imports','yta_summary_import_requests')").get().n; }

test('D1 0021 protocol applies exactly the reviewed additive file and observes preservation', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec("INSERT INTO original_data VALUES(CAST(X'C080' AS TEXT)),(9223372036854775807),(X'CAFE'),(1.25),(NULL)");}});
 const before = await s.adapter.captureBefore(), result = await s.adapter.apply({before});
 assert.equal(result.state, 'ACKNOWLEDGED_AND_OBSERVED'); assert.equal(result.preservationVerified, true); assert.equal(importSchema(s.db), 2);
 assert.equal(s.fixture.calls.writeBatches, 1); assert.equal(s.db.prepare('SELECT count(*) AS n FROM d1_migrations').get().n, 1);
 assert.equal(result.beforeOriginalSha256, result.afterOriginalSha256); assert.equal(result.productionExecutionSupported, false); assert.equal(result.databaseIdentityVerified, false);
 assert(s.fixture.calls.sessions.every(value => value === 'first-primary')); assert(s.fixture.calls.batches <= 17);
 assert.equal(s.fixture.calls.statements.filter(sql => /^CREATE/.test(sql)).length, 3);
 assert(!s.fixture.calls.statements.some(sql => /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(sql)));
});

test('already exact schema is a read-only observation within a new reserved window', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec(SOURCE.toString());}});
 const before = await s.adapter.captureBefore(), result = await s.adapter.apply({before});
 assert.equal(result.state, 'ALREADY_EXACT'); assert.equal(result.writeAttempted, false); assert.equal(result.attributionProved, false); assert.equal(s.fixture.calls.writeBatches, 0);
});

test('matching schema with existing import content is preserved without replaying CREATE', async t => {
 const s = await setup(t, {beforeSeal(db) {
  db.exec(SOURCE.toString()); db.exec("INSERT INTO yta_summary_imports VALUES('fixture-import','fixture-owner','fixture-job',1,'source','local','artifact',8,'synthetic','EXISTING_TRANSCRIPT_IMPORTED','OWNER_SOURCE_RECONCILIATION','fixture-time')");
 }});
 const result = await s.adapter.apply({before: await s.adapter.captureBefore()});
 assert.equal(result.state, 'ALREADY_EXACT'); assert.equal(s.db.prepare('SELECT content_text FROM yta_summary_imports').get().content_text, 'synthetic');
});

test('source mutation fails before any binding call', async t => {
 const s = await setup(t); const calls = s.fixture.calls.batches;
 await assert.rejects(createOfflineD1ManualSummaryAdapter({...s.args, sourceBytes: new TextEncoder().encode(SOURCE.toString() + '\n')}), /SOURCE_HASH_MISMATCH/);
 assert.equal(s.fixture.calls.batches, calls);
});

test('only exact separately reviewed CRLF representation is accepted', async t => {
 const s = await setup(t);
 const adapter = await createOfflineD1ManualSummaryAdapter({...s.args, sourceBytes: new TextEncoder().encode(SOURCE.toString().replaceAll('\n', '\r\n'))});
 const result = await adapter.apply({before: await adapter.captureBefore()}); assert.equal(result.state, 'ACKNOWLEDGED_AND_OBSERVED');
});

test('catalog and file-count tampering cannot borrow the original 0016 approval', async t => {
 const s = await setup(t); const catalog = reviewedMigrationSource(); catalog.fileCount = 14;
 await assert.rejects(createOfflineD1ManualSummaryAdapter({...s.args, catalog}), /CATALOG_MISMATCH/);
 const other = reviewedMigrationSource(); other.files = other.files.filter(file => !file.name.startsWith('0021'));
 await assert.rejects(createOfflineD1ManualSummaryAdapter({...s.args, catalog: other}), /CATALOG_MISMATCH/);
});

test('caller verified JSON does not authorize a fence', async t => {
 const s = await setup(t);
 await assert.rejects(createOfflineD1ManualSummaryAdapter({...s.args, fenceCapability: {verified: true, productionExecutionSupported: false}}), /GLOBAL_FENCE_UNVERIFIED/);
});

test('another fixture database with identical declared identity is rejected', async t => {
 const s = await setup(t), other = new DatabaseSync(':memory:'); t.after(() => other.close());
 const fixture = createSyntheticD1Binding(other);
 await assert.rejects(createOfflineD1ManualSummaryAdapter({...s.args, binding: fixture.binding}), /GLOBAL_FENCE_UNVERIFIED/);
 assert.equal(fixture.calls.batches, 0);
});

test('production execution mode is explicitly unavailable', async t => {
 const s = await setup(t);
 await assert.rejects(createOfflineD1ManualSummaryAdapter({...s.args, executionMode: 'PRODUCTION'}), /PRODUCTION_EXECUTION_UNSUPPORTED/);
});

test('before snapshot cannot be cloned or fabricated', async t => {
 const s = await setup(t), before = await s.adapter.captureBefore();
 await assert.rejects(s.adapter.apply({before: structuredClone(before)}), /BEFORE_UNISSUED/); assert.equal(s.fixture.calls.writeBatches, 0);
});

test('stale before evidence stops without a write attempt', async t => {
 const s = await setup(t), before = await s.adapter.captureBefore(); s.advance(300001);
 await assert.rejects(s.adapter.apply({before}), /BEFORE_STALE/); assert.equal(s.fixture.calls.writeBatches, 0);
});

test('same-count typed row changes between preflight and apply are detected', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec("INSERT INTO original_data VALUES(9223372036854775806)");}}), before = await s.adapter.captureBefore();
 s.db.exec('UPDATE original_data SET value=9223372036854775807');
 await assert.rejects(s.adapter.apply({before}), /BEFORE_STATE_CHANGED|GLOBAL_FENCE_UNVERIFIED/); assert.equal(s.fixture.calls.writeBatches, 0);
});

test('distinct malformed UTF-8 bytes cannot collapse through replacement characters', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec("INSERT INTO original_data VALUES(CAST(X'C080' AS TEXT))");}}), before = await s.adapter.captureBefore();
 s.db.exec("UPDATE original_data SET value=CAST(X'C181' AS TEXT)");
 await assert.rejects(s.adapter.apply({before}), /BEFORE_STATE_CHANGED|GLOBAL_FENCE_UNVERIFIED/);
});

test('implicit rowid is preserved even when row content and count are identical', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec("INSERT INTO original_data VALUES('same')");}}), before = await s.adapter.captureBefore();
 s.db.exec('UPDATE original_data SET rowid=99'); await assert.rejects(s.adapter.apply({before}), /BEFORE_STATE_CHANGED|GLOBAL_FENCE_UNVERIFIED/);
});

test('WITHOUT ROWID primary-key ordering is fingerprinted without integer coercion', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec("CREATE TABLE fixture_without_rowid(a TEXT,b INTEGER,c BLOB,PRIMARY KEY(a,b)) WITHOUT ROWID; INSERT INTO fixture_without_rowid VALUES('synthetic',9223372036854775807,X'ABCD')");}});
 const result = await s.adapter.apply({before: await s.adapter.captureBefore()}); assert.equal(result.state, 'ACKNOWLEDGED_AND_OBSERVED');
});

test('all rowid aliases shadowed fail closed instead of omitting row identity', async t => {
 const s = await setup(t); s.db.exec('CREATE TABLE aliases(rowid TEXT,_rowid_ TEXT,oid TEXT)');
 await assert.rejects(s.adapter.captureBefore(), /ROWID_INACCESSIBLE|GLOBAL_FENCE_UNVERIFIED/);
});

test('partial import tables never become a presumed successful idempotent migration', async t => {
 const s = await setup(t); s.db.exec('CREATE TABLE yta_summary_imports(id TEXT)');
 await assert.rejects(s.adapter.captureBefore(), /PRE_SCHEMA_MISMATCH|GLOBAL_FENCE_UNVERIFIED/); assert.equal(s.fixture.calls.writeBatches, 0);
});

test('full DDL comparison rejects altered CHECK despite identical column names', async t => {
 const s = await setup(t); s.db.exec(SOURCE.toString().replace('revision > 0', 'revision >= 0'));
 await assert.rejects(s.adapter.captureBefore(), /PRE_SCHEMA_MISMATCH|GLOBAL_FENCE_UNVERIFIED/);
});

test('full DDL comparison rejects extra trigger, view and index reference', async t => {
 const s = await setup(t); s.db.exec(SOURCE.toString()); s.db.exec('CREATE VIEW fixture_import_view AS SELECT * FROM yta_summary_imports');
 await assert.rejects(s.adapter.captureBefore(), /PRE_SCHEMA_MISMATCH|GLOBAL_FENCE_UNVERIFIED/);
});

test('schema changes at the write boundary fail the in-batch catalog guard', async t => {
 const s = await setup(t), before = await s.adapter.captureBefore();
 s.fixture.faults.beforeBatch = ({write, database}) => {if (write) database.exec('CREATE TABLE unexpected_boundary_table(v TEXT)');};
 const result = await s.adapter.apply({before}); assert.equal(result.state, 'BATCH_OUTCOME_UNCONFIRMED'); assert.equal(importSchema(s.db), 0); assert.equal(s.fixture.calls.writeBatches, 1);
});

test('failure after first CREATE rolls back entire synthetic D1 batch and never auto-retries', async t => {
 const s = await setup(t, {faults: {failWriteStatement: 2}}), before = await s.adapter.captureBefore();
 const result = await s.adapter.apply({before}); assert.equal(result.state, 'BATCH_OUTCOME_UNCONFIRMED'); assert.equal(importSchema(s.db), 0); assert.equal(s.fixture.calls.writeBatches, 1);
 const observed = await s.adapter.reconcile({before}); assert.equal(observed.schemaState, 'ABSENT'); assert.equal(observed.pendingRequestTerminalProved, false); assert.equal(observed.retryAllowed, false);
 await assert.rejects(s.adapter.apply({before}), /RECONCILIATION_REQUIRED|WRITE_RETRY_FORBIDDEN/); assert.equal(s.fixture.calls.writeBatches, 1);
});

test('lost committed ACK yields readback-only unresolved attribution even with exact schema', async t => {
 const s = await setup(t, {faults: {loseWriteAck: true}}), before = await s.adapter.captureBefore();
 const result = await s.adapter.apply({before}); assert.equal(result.state, 'BATCH_OUTCOME_UNCONFIRMED'); assert.equal(importSchema(s.db), 2);
 const observed = await s.adapter.reconcile({before}); assert.equal(observed.schemaState, 'EXACT'); assert.equal(observed.preservationObserved, true); assert.equal(observed.attributionProved, false); assert.equal(observed.retryAllowed, false);
 assert.equal(s.controller.status().phase, 'MIGRATION_UNKNOWN'); assert.equal(s.fixture.calls.writeBatches, 1);
});

test('another adapter cannot turn prior UNKNOWN into an ALREADY_EXACT migration success', async t => {
 const s = await setup(t, {faults: {loseWriteAck: true}}); await s.adapter.apply({before: await s.adapter.captureBefore()});
 const other = await createOfflineD1ManualSummaryAdapter(s.args);
 await assert.rejects(other.captureBefore(), /RECONCILIATION_REQUIRED/);
 const observed = await other.observeAfterRestart(); assert.equal(observed.state, 'READBACK_WITHOUT_TRUSTED_BEFORE'); assert.equal(observed.preservationVerified, false);
});

test('post-commit data drift is reported without claiming that Worker or D1 was rolled back', async t => {
 const s = await setup(t, {faults: {afterWriteCommit({database}) {database.exec('UPDATE fixture_usage SET n=8');}}});
 const result = await s.adapter.apply({before: await s.adapter.captureBefore()});
 assert.equal(result.state, 'ACKNOWLEDGED_POSTCHECK_FAILED'); assert.equal(result.preservationVerified, false); assert.equal(importSchema(s.db), 2);
 assert.equal(s.controller.status().phase, 'MIGRATION_POSTCHECK_FAILED'); assert.equal(result.writesMayResume, false);
});

test('post-commit DDL mismatch remains fenced and does not pretend transactional rollback', async t => {
 const s = await setup(t, {faults: {afterWriteCommit({database}) {database.exec('CREATE INDEX unexpected_import_index ON yta_summary_imports(content_text)');}}});
 const result = await s.adapter.apply({before: await s.adapter.captureBefore()});
 assert.equal(result.state, 'ACKNOWLEDGED_POSTCHECK_FAILED'); assert.equal(result.schemaState, 'MISMATCH'); assert.equal(importSchema(s.db), 2);
});

test('malformed write result cannot be classified as a safe write failure', async t => {
 const s = await setup(t, {faults: {malformedWriteResult: true}});
 const result = await s.adapter.apply({before: await s.adapter.captureBefore()}); assert.equal(result.state, 'BATCH_OUTCOME_UNCONFIRMED'); assert.equal(importSchema(s.db), 2);
});

test('missing bookmark and example-style object bookmark fail closed', async t => {
 for (const bookmark of ['null', 'object']) {
  const s = await setup(t, {faults: {bookmark}}); await assert.rejects(s.adapter.captureBefore(), /BOOKMARK_UNAVAILABLE/);
 }
});

test('row limit is checked before fetching private typed row bytes', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec('INSERT INTO original_data VALUES(1),(2)');}, limits: {maxRowsPerTable: 1}});
 await assert.rejects(s.adapter.captureBefore(), /ROW_LIMIT/); assert(!s.fixture.calls.statements.some(sql => /^SELECT typeof\(/.test(sql)));
});

test('encoded row byte budget fails before constructing an oversize HEX response', async t => {
 const s = await setup(t, {beforeSeal(db) {db.prepare('INSERT INTO original_data VALUES(?)').run('한'.repeat(1000));}, limits: {maxEncodedRowBytes: 1000}});
 await assert.rejects(s.adapter.captureBefore(), /ENCODED_ROW_BUDGET/); assert(!s.fixture.calls.statements.some(sql => /^SELECT typeof\(/.test(sql)));
});

test('snapshot response budget is a UTF-8 byte ceiling and cannot be loosened by configuration', async t => {
 const s = await setup(t); await assert.rejects(createOfflineD1ManualSummaryAdapter({...s.args, limits: {maxSnapshotBytes: 99_000_000}}), /LIMIT_INVALID/);
});

test('incomplete page output is never accepted as a partial preservation pass', async t => {
 const s = await setup(t, {faults: {dropReadRow: true}}); await assert.rejects(s.adapter.captureBefore(), /ROW_COUNT_DRIFT/);
});

test('all data pages plus full schema/count readbacks share a single transaction batch', async t => {
 let dataBatchCount = 0;
 const s = await setup(t, {beforeSeal(db) {db.exec('INSERT INTO original_data VALUES(1),(2),(3)');}, limits: {pageRows: 1}, faults: {beforeBatch({queries}) {
  if (queries.some(query => /^SELECT typeof\(/.test(query.sql))) {
   dataBatchCount++; assert(queries.some(query => /^PRAGMA table_xinfo/.test(query.sql))); assert(queries.some(query => /FROM main.sqlite_master/.test(query.sql))); assert(queries.some(query => /CAST\(count\(\*\) AS TEXT\)/.test(query.sql)));
  }
 }}});
 await s.adapter.captureBefore(); assert.equal(dataBatchCount, 1);
});

test('schema drift between planning and complete read batch is detected', async t => {
 let done = false;
 const s = await setup(t, {faults: {beforeBatch({queries, database}) {if (!done && queries.some(query => /^SELECT typeof\(/.test(query.sql))) {done = true; database.exec('CREATE INDEX fixture_changed_index ON original_data(value)');}}}});
 await assert.rejects(s.adapter.captureBefore(), /SCHEMA_CHANGED_DURING_READ|GLOBAL_FENCE_UNVERIFIED/);
});

test('inaccessible internal table is a blocker, not a silently skipped preservation scope', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec('CREATE TABLE _cf_fixture_system(value TEXT)');}, faults: {beforeBatch({queries}) {if (queries.some(query => /FROM main\."_cf_fixture_system"/.test(query.sql))) throw Error('synthetic protected table denied');}}});
 await assert.rejects(s.adapter.captureBefore(), /READ_FAILED/);
});

test('nonfinite REAL transport is rejected without emitting raw values', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec('INSERT INTO original_data VALUES(1.25)');}, faults: {transformResults({write,queries,results}) {if (!write) for (let i=0;i<queries.length;i++) if (/^SELECT typeof/.test(queries[i].sql)) for(const row of results[i].results) if(row.t0==='real') row.v0=Infinity; return results;}}});
 await assert.rejects(s.adapter.captureBefore(), /VALUE_NOT_LOSSLESS/);
});

test('postcheck query budget is reserved before any migration batch', async t => {
 const s = await setup(t, {limits: {maxBatches: 10}}), before = await s.adapter.captureBefore();
 await assert.rejects(s.adapter.apply({before}), /POSTCHECK_BUDGET_UNAVAILABLE/); assert.equal(s.fixture.calls.writeBatches, 0);
});

test('fixed error and receipts never expose raw record strings, SQL errors, bookmarks or payloads', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec("INSERT INTO original_data VALUES('synthetic-private-content')");}, faults: {loseWriteAck: true}});
 const before = await s.adapter.captureBefore(), result = await s.adapter.apply({before}), observed = await s.adapter.reconcile({before});
 const output = JSON.stringify({before, result, observed});
 for (const value of ['synthetic-private-content', 'fixture-job', 'fixture-owner', 'synthetic-opaque-', 'SELECT ', 'CREATE TABLE']) assert(!output.includes(value));
});

test('D1 schema response CHECK mismatch is caught independently of the local fence snapshot', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec(SOURCE.toString());}, faults: {transformResults({queries,results}) {
  for(let i=0;i<queries.length;i++) if (/SELECT type,name,tbl_name,sql FROM main.sqlite_master/.test(queries[i].sql))
   for(const row of results[i].results) if(row.name==='yta_summary_imports'&&row.sql) row.sql=row.sql.replace('revision > 0','revision >= 0');
  return results;
 }}});
 await assert.rejects(s.adapter.captureBefore(), /PRE_SCHEMA_MISMATCH/); assert.equal(s.fixture.calls.writeBatches, 0);
});

for (const field of ['type','notnull','dflt_value','pk','hidden']) {
 test(`full D1 table_xinfo field ${field} participates in exact schema proof`, async t => {
  const s = await setup(t, {beforeSeal(db) {db.exec(SOURCE.toString());}, faults: {transformResults({queries,results}) {
   for(let i=0;i<queries.length;i++) if(queries[i].sql==='PRAGMA table_xinfo("yta_summary_imports")') {
    const row=results[i].results.find(row=>row.name==='owner_id');
    row[field]=field==='type'?'BLOB':field==='dflt_value'?"'synthetic-default'":row[field]===0?1:0;
   }
   return results;
  }}});
  await assert.rejects(s.adapter.captureBefore(), /PRE_SCHEMA_MISMATCH/);
 });
}

for (const field of ['desc','coll','key']) {
 test(`full D1 index_xinfo field ${field} participates in exact schema proof`, async t => {
  const s = await setup(t, {beforeSeal(db) {db.exec(SOURCE.toString());}, faults: {transformResults({queries,results}) {
   for(let i=0;i<queries.length;i++) if(queries[i].sql==='PRAGMA index_xinfo("idx_summary_imports_job")') {
    const row=results[i].results[0]; row[field]=field==='coll'?'NOCASE':row[field]===0?1:0;
   }
   return results;
  }}});
  await assert.rejects(s.adapter.captureBefore(), /PRE_SCHEMA_MISMATCH/);
 });
}

test('large INTEGER returned as an unsafe JavaScript number is rejected at the D1 boundary', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec('INSERT INTO original_data VALUES(9223372036854775807)');}, faults: {transformResults({queries,results}) {
  for(let i=0;i<queries.length;i++) if(/^SELECT typeof/.test(queries[i].sql)) for(const row of results[i].results) if(row.t0==='integer') row.v0=Number(row.v0);
  return results;
 }}});
 await assert.rejects(s.adapter.captureBefore(), /RESPONSE_DECIMAL_INVALID/);
});

test('serialized D1 response cannot truncate a UTF-8 byte sequence into a passing digest', async t => {
 const s = await setup(t, {beforeSeal(db) {db.exec("INSERT INTO original_data VALUES('synthetic-한글')");}, faults: {transformResults({queries,results}) {
  for(let i=0;i<queries.length;i++) if(/^SELECT typeof/.test(queries[i].sql)) for(const row of results[i].results) if(row.t0==='text') row.v0+='F';
  return results;
 }}});
 await assert.rejects(s.adapter.captureBefore(), /BYTE_ENCODING_INVALID/);
});

test('catalog result byte ceiling is enforced before the JSON guard can be sent', async t => {
 const s = await setup(t, {limits: {maxEncodedRowBytes: 500}});
 await assert.rejects(s.adapter.captureBefore(), /CATALOG_GUARD_TOO_LARGE/); assert.equal(s.fixture.calls.writeBatches, 0);
});

test('all-writer fence loss after a successful batch ACK is a postcheck failure, not a false rollback', async t => {
 const s = await setup(t);
 s.fixture.faults.afterWriteCommit=async()=>s.controller.reportUnknownWriter();
 const result=await s.adapter.apply({before:await s.adapter.captureBefore()});
 assert.equal(result.state,'ACKNOWLEDGED_POSTCHECK_UNCONFIRMED'); assert.equal(result.batchAcknowledged,true); assert.equal(importSchema(s.db),2); assert.equal(result.writesMayResume,false);
});


test('main tables hidden from sqlite_master cannot be silently excluded from preservation', async t => {
 const s = await setup(t, {faults: {transformResults({queries,results}) {
  for(let i=0;i<queries.length;i++) if(queries[i].sql==='PRAGMA table_list') results[i].results.push({schema:'main',name:'_cf_fixture_unenumerated',type:'table',ncol:1,wr:0,strict:0});
  return results;
 }}});
 await assert.rejects(s.adapter.captureBefore(), /SCHEMA_INVENTORY_INCOMPLETE/); assert.equal(s.fixture.calls.writeBatches,0);
});


test('transactional snapshot rechecks table_list options and master-invisible inventory drift', async t => {
 let observedTableLists = 0;
 const s = await setup(t, {faults: {transformResults({queries,results}) {
  for(let i=0;i<queries.length;i++) if(queries[i].sql==='PRAGMA table_list' && ++observedTableLists===2)
   results[i].results.push({schema:'main',name:'_cf_fixture_late_hidden',type:'table',ncol:1,wr:0,strict:0});
  return results;
 }}});
 await assert.rejects(s.adapter.captureBefore(), /SCHEMA_CHANGED_DURING_READ/); assert.equal(s.fixture.calls.writeBatches,0);
});
