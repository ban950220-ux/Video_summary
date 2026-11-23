import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleSiteRequest} from '../src/site-worker.mjs';
import {IMPORT_DELETE_COMPATIBILITY, ROLLBACK_EVIDENCE_MAX_AGE_MS,
 createLocalRollbackWriteFence, captureLocalRollbackSnapshot,
 prepareLocalImportedSummaryRollback, verifyLocalImportedSummaryRollback} from '../scripts/manual-summary-rollback.mjs';

// All content, identities, keys, approvals and accounting records below are
// synthetic. No production data, network client or production executor is used.
const NOW = 1_700_000_000_000;
const JOB = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const IMPORT = '33333333-3333-4333-8333-333333333333';
const OTHER_IMPORT = '44444444-4444-4444-8444-444444444444';
const REQUEST = '55555555-5555-4555-8555-555555555555';
const STAMP = '2000-01-01T00:00:00.000Z';
const digest = value => createHash('sha256').update(value).digest('hex');
function identity(overrides = {}) {
 return {evidenceKind: 'SYNTHETIC_LOCAL_EXECUTION', sourceCommit: 'a'.repeat(40),
  versionId: '77777777-7777-4777-8777-777777777777', artifactSha256: '1'.repeat(64),
  databaseIdentitySha256: '2'.repeat(64), ownerPolicySha256: '3'.repeat(64),
  configurationSha256: '4'.repeat(64), ownerOnlyEnforced: true,
  importDeletionCompatibility: IMPORT_DELETE_COMPATIBILITY, ...overrides};
}
const current = identity();
const target = identity({sourceCommit: 'b'.repeat(40), versionId: '88888888-8888-4888-8888-888888888888', artifactSha256: '5'.repeat(64)});
function seed(db, {imports = true, schema = true} = {}) {
 for (const path of ['../schema.sql', '../migrations/0002_live.sql', '../migrations/0008_paid_summary_budget.sql', '../migrations/0010_paid_summary_receipts.sql']) db.exec(readFileSync(new URL(path, import.meta.url), 'utf8'));
 if (schema) db.exec(readFileSync(new URL('../migrations/pending/0021_manual_summary_imports.sql', import.meta.url), 'utf8'));
 for (const id of [JOB, OTHER]) {
  db.prepare('INSERT INTO jobs(id,owner_id,video_id,title,source_url,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(id, 'owner', 'synthetic01', 'Synthetic rollback lesson', 'https://video.example.invalid/synthetic', 'text', 'TRANSCRIPT_UNVERIFIED', 2, STAMP, STAMP, 'null', '{"fixture":true}');
  db.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)')
   .run(id, 'Synthetic transcript retained exactly.', '[{"id":1,"startMs":0,"endMs":2000,"text":"Synthetic transcript."}]', 'SYNTHETIC_TEST_TRANSCRIPT', STAMP);
 }
 db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)')
  .run('synthetic-operation', JOB, 'groq', 7, 'FAILED_UNCERTAIN', STAMP, 'SYNTHETIC_FAILURE', '{"fixture":"preserve"}');
 db.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run('synthetic-usage', JOB, 'owner', 'groq', 'SYNTHETIC_TEST', 'tokens', 7, 0, null, 'SYNTHETIC_TEST', STAMP);
 db.prepare('INSERT INTO yta_paid_summary_approvals(id,job_id,owner_id,source_sha256,quote_sha256,quote_json,model,price_version,credential_generation,max_micro_usd,max_call_micro_usd,max_calls,expires_at,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('synthetic-approval', JOB, 'owner', 'a'.repeat(64), 'b'.repeat(64), '{"fixture":true}', 'synthetic-model', 'synthetic-price', 'synthetic-generation', 1, 1, 1, 1, 'APPROVED', STAMP);
 db.prepare('INSERT INTO yta_paid_summary_reservations(id,approval_id,call_index,reserved_micro_usd,usage_json,outcome,state,created_at) VALUES(?,?,?,?,?,?,?,?)')
  .run('synthetic-reservation', 'synthetic-approval', 0, 1, '{"fixture":true}', 'SYNTHETIC_UNCERTAIN', 'UNCERTAIN', STAMP);
 db.prepare('INSERT INTO yta_paid_summary_receipts(reservation_id,job_id,owner_id,source_sha256,request_sha256,quote_sha256,response_bytes,response_json,response_complete,state,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('synthetic-reservation', JOB, 'owner', 'a'.repeat(64), 'c'.repeat(64), 'b'.repeat(64), 0, '{"fixture":"incomplete"}', 0, 'INCOMPLETE', 'SYNTHETIC_INCOMPLETE', STAMP, STAMP);
 if (imports) {
  addImport(db, JOB, IMPORT, REQUEST, 'Synthetic imported paragraph.\r\n');
  addImport(db, OTHER, OTHER_IMPORT, '66666666-6666-4666-8666-666666666666', 'Another synthetic imported paragraph.\n');
 }
}
function addImport(db, job, id, request, text) {
 db.prepare('INSERT INTO yta_summary_imports(id,owner_id,job_id,revision,source_sha256,source_provenance,artifact_sha256,artifact_bytes,content_text,provenance,basis_method,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(id, 'owner', job, 1, 'a'.repeat(64), 'SYNTHETIC_TEST_TRANSCRIPT', digest(text), Buffer.byteLength(text), text, 'EXISTING_TRANSCRIPT_IMPORTED', 'OWNER_SOURCE_RECONCILIATION', STAMP);
 db.prepare('INSERT INTO yta_summary_import_requests(owner_id,job_id,request_id,state,request_sha256,import_id,created_at) VALUES(?,?,?,?,?,?,?)')
  .run('owner', job, request, 'COMMITTED', 'd'.repeat(64), id, STAMP);
}
function database(options) { const db = new DatabaseSync(':memory:'); seed(db, options); return db; }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const expectCode = (code, fn) => assert.throws(fn, error => error.code === code);
async function window(db, overrides = {}) {
 const fence = createLocalRollbackWriteFence({now: () => NOW}); await fence.close();
 const plan = prepareLocalImportedSummaryRollback({db, fence, current, target, now: NOW, ...overrides});
 return {fence, plan};
}

test('rollback fence blocks actual SQLite save, cancel and delete writes and drains every admitted writer', async () => {
 const db = database({imports: false});
 try {
  const fence = createLocalRollbackWriteFence({now: () => NOW});
  const save = deferred(), cancel = deferred(), remove = deferred(), callbackFlags = [];
  const first = fence.runWrite('IMPORT_SAVE', async () => { await save.promise; addImport(db, JOB, IMPORT, REQUEST, 'Synthetic late committed import.'); });
  const second = fence.runWrite('IMPORT_CANCEL', async () => { await cancel.promise; db.prepare('INSERT INTO yta_summary_import_requests VALUES(?,?,?,?,?,?,?)').run('owner', OTHER, 'synthetic-cancel', 'CANCELLED', null, null, STAMP); });
  const third = fence.runWrite('ANALYSIS_DELETE', async () => { await remove.promise; db.prepare('DELETE FROM jobs WHERE id=?').run(OTHER); db.prepare('DELETE FROM yta_summary_import_requests WHERE job_id=?').run(OTHER); });
  const draining = fence.close();
  assert.equal(fence.observe().phase, 'DRAINING'); assert.equal(fence.observe().inFlight, 3);
  for (const kind of ['IMPORT_SAVE', 'IMPORT_CANCEL', 'ANALYSIS_DELETE', 'PROVIDER_CALLBACK', 'OTHER_WRITE']) {
   await assert.rejects(fence.runWrite(kind, () => { callbackFlags.push(kind); db.exec('DELETE FROM jobs'); }), {code: 'ROLLBACK_WRITES_FENCED'});
  }
  assert.deepEqual(callbackFlags, []);
  expectCode('ROLLBACK_WRITE_FENCE_NOT_DRAINED', () => prepareLocalImportedSummaryRollback({db, fence, current, target, now: NOW}));
  save.resolve(); await first; assert.equal(fence.observe().phase, 'DRAINING');
  cancel.resolve(); await second; assert.equal(fence.observe().phase, 'DRAINING');
  remove.resolve(); await third; await draining;
  assert.equal(fence.observe().phase, 'FENCED'); assert.equal(fence.observe().inFlight, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_summary_imports').get().n, 1);
  assert.equal(fence.observe().productionEnforcementVerified, false);
  const plan = prepareLocalImportedSummaryRollback({db, fence, current, target, now: NOW});
  assert.equal(plan.before.importState.imports, 1);
  assert.equal(plan.writesMayResume, false);
 } finally { db.close(); }
});

test('failed admitted writer still drains while its transaction rolls back', async () => {
 const db = database();
 try {
  const before = captureLocalRollbackSnapshot(db, {now: NOW});
  const ready = deferred(), fence = createLocalRollbackWriteFence({now: () => NOW});
  const active = fence.runWrite('IMPORT_SAVE', async () => { await ready.promise; db.exec('BEGIN'); try { db.exec('DELETE FROM yta_summary_imports'); throw Error('synthetic failure'); } finally { db.exec('ROLLBACK'); } });
  const rejected = assert.rejects(active, /synthetic failure/), closing = fence.close();
  ready.resolve(); await rejected; await closing;
  assert.equal(captureLocalRollbackSnapshot(db, {now: NOW}).databaseSha256, before.databaseSha256);
  assert.equal(fence.observe().phase, 'FENCED');
 } finally { db.close(); }
});

test('a drained callback is insufficient when a crashed analysis deletion left its durable tombstone and content', async () => {
 const db = database();
 try {
  const fence = createLocalRollbackWriteFence({now: () => NOW});
  const deletion = fence.runWrite('ANALYSIS_DELETE', async () => {
   db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)')
    .run(JOB + ':deleting', JOB, 'deletion', 0, 'DELETING', STAMP);
   // The real path persists the tombstone before content cleanup. A process
   // failure here is not a transaction rollback of that durable tombstone.
   throw Error('synthetic crash after durable deletion marker');
  });
  await assert.rejects(deletion, /synthetic crash/); await fence.close();
  assert.equal(fence.observe().phase, 'FENCED'); assert.equal(fence.observe().inFlight, 0);
  assert.equal(captureLocalRollbackSnapshot(db, {now: NOW}).importState.pendingDeletions, 1);
  expectCode('ROLLBACK_ANALYSIS_DELETION_NOT_DRAINED', () => prepareLocalImportedSummaryRollback({db, fence, current, target, now: NOW}));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs WHERE id=?').get(JOB).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_summary_imports WHERE job_id=?').get(JOB).n, 1);
 } finally { db.close(); }
});

test('legacy schema-unaware deletion fixture leaves private imported content orphaned', async () => {
 const db = database();
 try {
  // Reproduces the missing import-table cleanup in a legacy deletion path.
  // This is a synthetic SQLite reproduction, not an execution of deployed code.
  db.prepare('DELETE FROM yta_sources WHERE job_id=?').run(JOB);
  db.prepare('DELETE FROM jobs WHERE id=? AND owner_id=?').run(JOB, 'owner');
  const snapshot = captureLocalRollbackSnapshot(db, {now: NOW});
  assert.equal(snapshot.importState.orphanImports, 1);
  assert.equal(snapshot.importState.orphanRequests, 1);
  assert.equal(db.prepare('SELECT content_text FROM yta_summary_imports WHERE id=?').get(IMPORT).content_text, 'Synthetic imported paragraph.\r\n');
  const fence = createLocalRollbackWriteFence({now: () => NOW}); await fence.close();
  expectCode('ROLLBACK_EXISTING_IMPORT_INTEGRITY_FAILURE', () => prepareLocalImportedSummaryRollback({db, fence, current, target, now: NOW}));
 } finally { db.close(); }
});

test('legacy target is refused with imports or even only a durable cancelled request', async () => {
 for (const onlyCancelled of [false, true]) {
  const db = database({imports: !onlyCancelled});
  try {
   if (onlyCancelled) db.prepare('INSERT INTO yta_summary_import_requests VALUES(?,?,?,?,?,?,?)').run('owner', JOB, REQUEST, 'CANCELLED', null, null, STAMP);
   const fence = createLocalRollbackWriteFence({now: () => NOW}); await fence.close();
   const before = captureLocalRollbackSnapshot(db, {now: NOW});
   expectCode('ROLLBACK_TARGET_IMPORT_DELETE_INCOMPATIBLE', () => prepareLocalImportedSummaryRollback({db, fence, current, target: {...target, importDeletionCompatibility: 'NONE'}, now: NOW}));
   assert.equal(captureLocalRollbackSnapshot(db, {now: NOW}).databaseSha256, before.databaseSha256);
  } finally { db.close(); }
 }
});

test('compatible local rollback preserves imported text and every original table across a database reopen', async () => {
 const folder = mkdtempSync(join(tmpdir(), 'synthetic-rollback-'));
 const file = join(folder, 'rehearsal.sqlite'); let db = new DatabaseSync(file);
 try {
  seed(db); const {fence, plan} = await window(db);
  for (const name of ['jobs', 'yta_sources', 'yta_operations', 'usage_events', 'yta_paid_summary_approvals', 'yta_paid_summary_reservations', 'yta_paid_summary_receipts', 'yta_summary_imports', 'yta_summary_import_requests']) assert.ok(plan.before.tables.some(table => table.name === name && table.rows > 0));
  assert.equal(plan.deletesData, false); assert.equal(plan.runsMigration, false);
  db.close(); db = new DatabaseSync(file, {readOnly: true});
  assert.throws(() => db.exec('DELETE FROM yta_summary_imports'), /readonly/i);
  const readback = verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget: target, now: NOW + 1});
  assert.equal(readback.status, 'LOCAL_REHEARSAL_VERIFIED');
  assert.equal(readback.productionExecutionSupported, false);
  assert.equal(readback.operationallyAuthorized, false); assert.equal(readback.writesMayResume, false);
  assert.equal(readback.databaseSha256, plan.before.databaseSha256);
  assert.equal(db.prepare('SELECT content_text FROM yta_summary_imports WHERE id=?').get(IMPORT).content_text, 'Synthetic imported paragraph.\r\n');
  assert.equal(db.prepare('SELECT state FROM yta_paid_summary_receipts').get().state, 'INCOMPLETE');
  assert.equal(JSON.stringify(plan).includes('Synthetic imported paragraph'), false);
  assert.equal(JSON.stringify(plan).includes(JOB), false);
 } finally { db.close(); rmSync(folder, {recursive: true, force: true}); }
});

test('empty import storage can be rehearsed with a legacy target but never resumes writes', async () => {
 for (const schema of [false, true]) {
  const db = database({schema, imports: false});
  try {
   const legacy = {...target, importDeletionCompatibility: 'NONE'};
   const {fence, plan} = await window(db, {target: legacy});
   assert.equal(plan.mode, 'EMPTY_IMPORT_STATE_REHEARSAL_ONLY');
   assert.equal(verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget: legacy, now: NOW}).writesMayResume, false);
  } finally { db.close(); }
 }
});

test('changed data, schema, identity, stale windows and unresolved responses fail closed', async t => {
 const cases = [
  ['owner policy', {target: {...target, ownerPolicySha256: 'f'.repeat(64)}}, 'ROLLBACK_OWNER_POLICY_CHANGED'],
  ['D1 identity', {target: {...target, databaseIdentitySha256: 'f'.repeat(64)}}, 'ROLLBACK_DATABASE_BINDING_CHANGED'],
  ['configuration', {target: {...target, configurationSha256: 'f'.repeat(64)}}, 'ROLLBACK_CONFIGURATION_CHANGED'],
  ['lost response not reconciled', {unresolvedReadbacks: 1}, 'ROLLBACK_REQUEST_READBACK_UNRESOLVED'],
  ['real identity evidence is not local authority', {target: {...target, evidenceKind: 'PRODUCTION'}}, 'ROLLBACK_INVALID_LOCAL_TARGET_EVIDENCE']
 ];
 for (const [name, change, code] of cases) await t.test(name, async () => {
  const db = database(); try { const fence = createLocalRollbackWriteFence({now: () => NOW}); await fence.close(); expectCode(code, () => prepareLocalImportedSummaryRollback({db, fence, current, target, now: NOW, ...change})); } finally { db.close(); }
 });
 for (const name of ['jobs', 'yta_sources', 'yta_operations', 'usage_events', 'yta_paid_summary_approvals', 'yta_paid_summary_reservations', 'yta_paid_summary_receipts', 'yta_summary_imports', 'yta_summary_import_requests']) await t.test('row preservation: ' + name, async () => {
  const db = database(); try {
   const {fence, plan} = await window(db);
   db.exec('DELETE FROM "' + name + '"');
   assert.throws(() => verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget: target, now: NOW}), error => ['ROLLBACK_DATA_PRESERVATION_FAILED', 'ROLLBACK_EXISTING_IMPORT_INTEGRITY_FAILURE'].includes(error.code));
  } finally { db.close(); }
 });
 await t.test('full DDL mismatch before the window', async () => {
  const db = database(); try {
   db.exec('DROP INDEX idx_summary_imports_job');
   const fence = createLocalRollbackWriteFence({now: () => NOW}); await fence.close();
   expectCode('ROLLBACK_FULL_IMPORT_DDL_NOT_VERIFIED', () => prepareLocalImportedSummaryRollback({db, fence, current, target, now: NOW}));
  } finally { db.close(); }
 });
 await t.test('full DDL mismatch after the window', async () => {
  const db = database(); try { const {fence, plan} = await window(db); db.exec('DROP INDEX idx_summary_imports_job'); expectCode('ROLLBACK_SCHEMA_READBACK_MISMATCH', () => verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget: target, now: NOW})); } finally { db.close(); }
 });
 await t.test('expired, forged, different-fence and wrong-target readbacks', async () => {
  const db = database(); try {
   const {fence, plan} = await window(db);
   expectCode('ROLLBACK_PLAN_EXPIRED', () => verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget: target, now: NOW + ROLLBACK_EVIDENCE_MAX_AGE_MS + 1}));
   expectCode('ROLLBACK_PLAN_EXPIRED', () => verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget: target, now: NOW - 1}));
   expectCode('ROLLBACK_PLAN_NOT_ISSUED_IN_THIS_WINDOW', () => verifyLocalImportedSummaryRollback({plan: JSON.parse(JSON.stringify(plan)), db, fence, observedTarget: target, now: NOW}));
   const second = createLocalRollbackWriteFence({now: () => NOW}); await second.close();
   expectCode('ROLLBACK_PLAN_NOT_ISSUED_IN_THIS_WINDOW', () => verifyLocalImportedSummaryRollback({plan, db, fence: second, observedTarget: target, now: NOW}));
   expectCode('ROLLBACK_TARGET_READBACK_MISMATCH', () => verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget: {...target, sourceCommit: 'c'.repeat(40)}, now: NOW}));
   expectCode('ROLLBACK_FENCE_EVIDENCE_STALE', () => prepareLocalImportedSummaryRollback({db, fence, current, target, now: NOW + ROLLBACK_EVIDENCE_MAX_AGE_MS + 1}));
  } finally { db.close(); }
 });
});

test('snapshot preserves SQLite text/blob bytes, wide integers and storage-class distinctions', () => {
 const db = database();
 try {
  db.exec("CREATE TABLE synthetic_bytes(id INTEGER PRIMARY KEY,payload TEXT,quantity,binary BLOB); INSERT INTO synthetic_bytes VALUES(1,CAST(X'80' AS TEXT),9007199254740992,X'000102');");
  const decoded = db.prepare('SELECT payload FROM synthetic_bytes').get().payload;
  let before = captureLocalRollbackSnapshot(db, {now: NOW}).databaseSha256;
  db.exec("UPDATE synthetic_bytes SET payload=CAST(X'81' AS TEXT)");
  assert.equal(db.prepare('SELECT payload FROM synthetic_bytes').get().payload, decoded);
  let after = captureLocalRollbackSnapshot(db, {now: NOW}).databaseSha256;
  assert.notEqual(after, before);
  before = after; db.exec('UPDATE synthetic_bytes SET quantity=9007199254740993');
  after = captureLocalRollbackSnapshot(db, {now: NOW}).databaseSha256; assert.notEqual(after, before);
  before = after; db.exec("UPDATE synthetic_bytes SET binary=X'000103'");
  after = captureLocalRollbackSnapshot(db, {now: NOW}).databaseSha256; assert.notEqual(after, before);
  db.exec('UPDATE synthetic_bytes SET quantity=1'); before = captureLocalRollbackSnapshot(db, {now: NOW}).databaseSha256;
  db.exec("UPDATE synthetic_bytes SET quantity='1'");
  assert.notEqual(captureLocalRollbackSnapshot(db, {now: NOW}).databaseSha256, before);
 } finally { db.close(); }
});

test('snapshot detects implicit rowid-only changes and supports WITHOUT ROWID tables', async () => {
 const db = database();
 try {
  db.exec("CREATE TABLE synthetic_rowids(value TEXT); INSERT INTO synthetic_rowids VALUES('unchanged synthetic value'); CREATE TABLE synthetic_keyed(key TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID; INSERT INTO synthetic_keyed VALUES('synthetic-key','synthetic-value');");
  const {fence, plan} = await window(db);
  const before = db.prepare('SELECT value FROM synthetic_rowids').get().value;
  db.exec('UPDATE synthetic_rowids SET rowid=900');
  assert.equal(db.prepare('SELECT value FROM synthetic_rowids').get().value, before);
  expectCode('ROLLBACK_DATA_PRESERVATION_FAILED', () => verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget: target, now: NOW}));
  db.exec('CREATE TABLE synthetic_shadowed(rowid TEXT,_rowid_ TEXT,oid TEXT)');
  expectCode('ROLLBACK_ROWID_INACCESSIBLE', () => captureLocalRollbackSnapshot(db, {now: NOW}));
 } finally { db.close(); }
});

test('caller-owned transactions are rejected without committing or rolling them back', async () => {
 const db = database();
 try {
  const {fence, plan} = await window(db);
  db.exec('BEGIN');
  for (const call of [() => captureLocalRollbackSnapshot(db, {now: NOW}),
   () => prepareLocalImportedSummaryRollback({db, fence, current, target, now: NOW}),
   () => verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget: target, now: NOW})]) {
   expectCode('ROLLBACK_NESTED_TRANSACTION_FORBIDDEN', call);
   assert.equal(db.isTransaction, true);
  }
  db.exec('ROLLBACK'); assert.equal(db.isTransaction, false);
 } finally { db.close(); }
});

test('a WAL writer cannot mix generations within the schema-and-data snapshot', () => {
 const folder = mkdtempSync(join(tmpdir(), 'synthetic-rollback-wal-'));
 const file = join(folder, 'rehearsal.sqlite'); const db = new DatabaseSync(file);
 let writer;
 try {
  db.exec('PRAGMA journal_mode=WAL'); seed(db); writer = new DatabaseSync(file);
  const before = captureLocalRollbackSnapshot(db, {now: NOW});
  const original = db.prepare; let injected = false;
  db.prepare = function(sql, ...args) {
   if (!injected && sql.startsWith('SELECT typeof(')) {
    injected = true; assert.equal(db.isTransaction, true);
    writer.exec("BEGIN; UPDATE jobs SET title='Synthetic changed title'; UPDATE yta_sources SET raw='Synthetic changed source'; COMMIT;");
   }
   return original.call(this, sql, ...args);
  };
  const during = captureLocalRollbackSnapshot(db, {now: NOW + 1});
  db.prepare = original;
  assert.equal(injected, true);
  assert.equal(during.databaseSha256, before.databaseSha256);
  assert.notEqual(captureLocalRollbackSnapshot(db, {now: NOW + 2}).databaseSha256, before.databaseSha256);
 } finally { writer?.close(); db.close(); rmSync(folder, {recursive: true, force: true}); }
});

test('a write from another WAL connection after the plan snapshot is caught at readback', async () => {
 const folder = mkdtempSync(join(tmpdir(), 'synthetic-rollback-wal-plan-'));
 const file = join(folder, 'rehearsal.sqlite'); const db = new DatabaseSync(file); let writer;
 try {
  db.exec('PRAGMA journal_mode=WAL'); seed(db); writer = new DatabaseSync(file);
  const before = captureLocalRollbackSnapshot(db, {now: NOW});
  const original = db.prepare; let injected = false;
  db.prepare = function(sql, ...args) {
   if (!injected && sql.startsWith('SELECT typeof(')) {
    injected = true; assert.equal(db.isTransaction, true);
    writer.exec("UPDATE yta_paid_summary_receipts SET response_json='{\"fixture\":\"changed concurrently\"}'");
   }
   return original.call(this, sql, ...args);
  };
  const {fence, plan} = await window(db); db.prepare = original;
  assert.equal(injected, true); assert.equal(plan.before.databaseSha256, before.databaseSha256);
  expectCode('ROLLBACK_DATA_PRESERVATION_FAILED', () => verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget: target, now: NOW + 1}));
  assert.equal(plan.productionExecutionSupported, false);
 } finally { writer?.close(); db.close(); rmSync(folder, {recursive: true, force: true}); }
});

function binding(db) {
 return {prepare(sql) {
  const prepared = args => ({sql, args, bind(...values) { return prepared(values); },
   async first() { return db.prepare(sql).get(...args) || null; },
   async all() { return {results: db.prepare(sql).all(...args), success: true}; },
   async run() { return {success: true, meta: {changes: Number(db.prepare(sql).run(...args).changes)}}; }});
  return prepared([]);
 }, async batch(statements) {
  db.exec('BEGIN'); try { const result = statements.map(({sql, args}) => ({success: true, meta: {changes: Number(db.prepare(sql).run(...args).changes)}})); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
 }};
}
const SITE = 'https://rollback.example.invalid', DOMAIN = 'https://rollback-fixture.cloudflareaccess.com';
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = publicKey.export({format: 'jwk'});
function token(email = 'owner@example.invalid') {
 const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
 const header = encode({alg: 'RS256', kid: 'synthetic-rollback-key'});
 const payload = encode({iss: DOMAIN, aud: ['synthetic-rollback-aud'], iat: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 300, email, sub: 'synthetic-owner'});
 return header + '.' + payload + '.' + sign('RSA-SHA256', Buffer.from(header + '.' + payload), privateKey).toString('base64url');
}
test('current authenticated explicit analysis deletion removes its imports and keeps unrelated imports and accounting identities', async () => {
 const db = database(), priorFetch = globalThis.fetch; let externalCalls = 0;
 globalThis.fetch = async () => { externalCalls++; throw Error('No external requests in rollback rehearsal'); };
 try {
  const env = {DB: binding(db), ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: 'synthetic-rollback-aud', ACCESS_OWNER_EMAIL: 'owner@example.invalid', ALLOW_PAID_API: 'false'};
  const deps = {fetcher: async url => { assert.equal(url, DOMAIN + '/cdn-cgi/access/certs'); return Response.json({keys: [{...jwk, kid: 'synthetic-rollback-key', alg: 'RS256'}]}); }};
  const call = email => handleSiteRequest(new Request(SITE + '/api/jobs/' + JOB, {method: 'DELETE', headers: {origin: SITE, 'cf-access-jwt-assertion': token(email)}}), env, deps);
  const before = captureLocalRollbackSnapshot(db, {now: NOW});
  assert.equal((await call('other@example.invalid')).status, 401);
  assert.equal(captureLocalRollbackSnapshot(db, {now: NOW}).databaseSha256, before.databaseSha256);
  assert.equal((await call('owner@example.invalid')).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_summary_imports WHERE job_id=?').get(JOB).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_summary_import_requests WHERE job_id=?').get(JOB).n, 0);
  assert.equal(db.prepare('SELECT content_text FROM yta_summary_imports WHERE id=?').get(OTHER_IMPORT).content_text, 'Another synthetic imported paragraph.\n');
  assert.equal(db.prepare('SELECT state FROM yta_operations WHERE id=?').get(JOB + ':deleting').state, 'DELETING');
  for (const name of ['usage_events', 'yta_paid_summary_approvals', 'yta_paid_summary_reservations']) {
   const after = captureLocalRollbackSnapshot(db, {now: NOW}).tables.find(table => table.name === name);
   assert.deepEqual(after, before.tables.find(table => table.name === name));
  }
  const receipt = db.prepare('SELECT reservation_id,state,response_json FROM yta_paid_summary_receipts').get();
  assert.equal(receipt.reservation_id, 'synthetic-reservation');
  assert.equal(receipt.state, 'SOURCE_DELETED'); assert.equal(receipt.response_json, null);
  assert.equal(captureLocalRollbackSnapshot(db, {now: NOW}).importState.orphanImports, 0);
  assert.equal(captureLocalRollbackSnapshot(db, {now: NOW}).importState.orphanRequests, 0);
  assert.equal(captureLocalRollbackSnapshot(db, {now: NOW}).importState.pendingDeletions, 0);
  const {fence, plan} = await window(db);
  assert.equal(verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget: target, now: NOW}).status, 'LOCAL_REHEARSAL_VERIFIED');
  assert.equal(db.prepare('SELECT state FROM yta_operations WHERE id=?').get(JOB + ':deleting').state, 'DELETING');
  assert.equal(externalCalls, 0);
 } finally { globalThis.fetch = priorFetch; db.close(); }
});
