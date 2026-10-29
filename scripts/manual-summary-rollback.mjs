// Local rollback rehearsal only. No deployment, network, credentials, D1
// transport, runtime flags, or production write-fence installation is provided.
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {inspectManualSummaryImportSchema} from './manual-summary-migration.mjs';

export const IMPORT_DELETE_COMPATIBILITY = 'OWNER_TOMBSTONE_IMPORT_CLEANUP_V1';
export const ROLLBACK_EVIDENCE_MAX_AGE_MS = 300_000;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fences = new WeakMap();
const plans = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
function fail(code) { throw Object.assign(new Error(code), {code}); }
function clock(value) { if (!Number.isSafeInteger(value) || value < 0) fail('ROLLBACK_INVALID_CLOCK'); return value; }
function freeze(value) {
 if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
 return value;
}
function scalar(value) {
 if (value === null) return ['null'];
 if (typeof value === 'string') return ['text', value];
 if (typeof value === 'bigint') return ['integer', String(value)];
 if (typeof value === 'number' && Number.isFinite(value)) { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return ['real', bytes.toString('hex')]; }
 if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('hex')];
 fail('ROLLBACK_UNSUPPORTED_SQLITE_VALUE');
}
function rows(db, sql) {
 const statement = db.prepare(sql);
 statement.setReadBigInts(true);
 return statement.all();
}
function count(db, sql) {
 const result = db.prepare(sql).get();
 const value = Number(result.n);
 if (!Number.isSafeInteger(value) || value < 0) fail('ROLLBACK_INVALID_ROW_COUNT');
 return value;
}
function localDatabase(db) {
 if (!(db instanceof DatabaseSync)) fail('ROLLBACK_LOCAL_SQLITE_REQUIRED');
 // The shared inspector also refuses attached/temp schemas and files outside
 // the temporary directory; its full-DDL result is checked by each window.
 return inspectManualSummaryImportSchema(db);
}

function readTransaction(db, inspect) {
 if (!(db instanceof DatabaseSync)) fail('ROLLBACK_LOCAL_SQLITE_REQUIRED');
 if (db.isTransaction) fail('ROLLBACK_NESTED_TRANSACTION_FORBIDDEN');
 db.exec('BEGIN DEFERRED');
 try {
  const schema = localDatabase(db);
  const result = inspect(schema);
  db.exec('COMMIT'); return result;
 } catch (error) {
  if (db.isTransaction) db.exec('ROLLBACK');
  throw error;
 }
}

function fingerprintRows(db, table) {
 const columns = db.prepare('PRAGMA main.table_xinfo(' + quote(table) + ')').all().map(row => row.name);
 const tableInfo = db.prepare('PRAGMA main.table_list').all().find(row => row.schema === 'main' && row.name === table);
 if (!tableInfo) fail('ROLLBACK_TABLE_METADATA_MISSING');
 const names = new Set(columns.map(name => name.toLowerCase()));
 const rowid = tableInfo.wr === 1 ? null : ['rowid', '_rowid_', 'oid'].find(name => !names.has(name));
 if (tableInfo.wr !== 1 && !rowid) fail('ROLLBACK_ROWID_INACCESSIBLE');
 const fields = columns.flatMap((name, index) => {
  const column = quote(name);
  return ['typeof(' + column + ') AS ' + quote('kind_' + index),
   "CASE WHEN typeof(" + column + ") IN ('text','blob') THEN hex(CAST(" + column + ' AS BLOB)) ELSE ' + column + ' END AS ' + quote('value_' + index)];
 });
 if (rowid) fields.push(quote(rowid) + ' AS __rollback_rowid');
 return rows(db, 'SELECT ' + fields.join(',') + ' FROM main.' + quote(table)).map(row => {
  const values = columns.map((name, index) => [name, row['kind_' + index], scalar(row['value_' + index])]);
  if (rowid) values.push(['implicit-sqlite-rowid', scalar(row.__rollback_rowid)]);
  return JSON.stringify(values);
 }).sort();
}

/** A process-local test fence, never a claim that existing Workers are fenced. */
export function createLocalRollbackWriteFence({now = Date.now} = {}) {
 const state = {phase: 'OPEN', id: randomUUID(), revision: 0, inFlight: 0,
  byKind: Object.create(null), requestedAt: null, drainedAt: null, waiters: []};
 const drain = () => {
  if (state.phase === 'DRAINING' && state.inFlight === 0) {
   state.phase = 'FENCED'; state.drainedAt = clock(now());
   for (const resolve of state.waiters.splice(0)) resolve();
  }
 };
 const fence = Object.freeze({
  async runWrite(kind, task) {
   if (state.phase !== 'OPEN') fail('ROLLBACK_WRITES_FENCED');
   if (typeof kind !== 'string' || !/^[A-Z][A-Z_]{0,63}$/.test(kind) || typeof task !== 'function') fail('ROLLBACK_INVALID_WRITE');
   state.inFlight++; state.byKind[kind] = (state.byKind[kind] || 0) + 1;
   try { return await task(); }
   finally { state.inFlight--; state.byKind[kind]--; drain(); }
  },
  async close() {
   if (state.phase === 'OPEN') {
    state.phase = 'DRAINING'; state.revision++; state.requestedAt = clock(now());
    drain();
   }
   if (state.phase !== 'FENCED') await new Promise(resolve => state.waiters.push(resolve));
   return fence.observe();
  },
  observe() {
   return freeze({kind: 'LOCAL_PROCESS_FENCE_ONLY', phase: state.phase,
    revision: state.revision, inFlight: state.inFlight,
    byKind: {...state.byKind}, requestedAt: state.requestedAt, drainedAt: state.drainedAt,
    productionEnforcementVerified: false});
  }
 });
 fences.set(fence, state);
 return fence;
}

/** Digests all application table contents; never returns record text or IDs. */
export function captureLocalRollbackSnapshot(db, {now = Date.now()} = {}) {
 clock(now);
 return readTransaction(db, () => snapshotInsideReadTransaction(db, now));
}
function snapshotInsideReadTransaction(db, now) {
 if (!db.isTransaction) fail('ROLLBACK_READ_TRANSACTION_REQUIRED');
 const objects = rows(db, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
 const schemaSha256 = hash(JSON.stringify(objects));
 const tables = objects.filter(object => object.type === 'table').map(object => {
  // Hash TEXT/BLOB bytes as SQLite hex before JavaScript decoding. Distinct
  // invalid UTF-8 byte sequences must not collapse to the same replacement text.
  const serialized = fingerprintRows(db, object.name);
  return {name: object.name, rows: serialized.length, rowsSha256: hash(JSON.stringify(serialized))};
 }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
 const names = new Set(tables.map(table => table.name));
 const importsExist = names.has('yta_summary_imports'), requestsExist = names.has('yta_summary_import_requests');
 if (importsExist !== requestsExist) fail('ROLLBACK_IMPORT_SCHEMA_PARTIAL');
 let importState = {storage: 'ABSENT', imports: 0, requests: 0, orphanImports: 0, orphanRequests: 0, invalidRequestStates: 0, pendingDeletions: 0};
 if (importsExist) {
  if (!names.has('jobs')) fail('ROLLBACK_IMPORT_PARENT_SCHEMA_MISSING');
  try {
   importState = {storage: 'PRESENT',
    imports: count(db, 'SELECT COUNT(*) AS n FROM yta_summary_imports'),
    requests: count(db, 'SELECT COUNT(*) AS n FROM yta_summary_import_requests'),
    orphanImports: count(db, 'SELECT COUNT(*) AS n FROM yta_summary_imports i LEFT JOIN jobs j ON j.id=i.job_id AND j.owner_id=i.owner_id WHERE j.id IS NULL'),
    orphanRequests: count(db, "SELECT COUNT(*) AS n FROM yta_summary_import_requests r LEFT JOIN jobs j ON j.id=r.job_id AND j.owner_id=r.owner_id LEFT JOIN yta_summary_imports i ON i.id=r.import_id AND i.owner_id=r.owner_id AND i.job_id=r.job_id WHERE j.id IS NULL OR (r.state='COMMITTED' AND i.id IS NULL)"),
    invalidRequestStates: count(db, "SELECT COUNT(*) AS n FROM yta_summary_import_requests WHERE state NOT IN ('COMMITTED','CANCELLED')"), pendingDeletions: 0};
  } catch { fail('ROLLBACK_IMPORT_SCHEMA_UNREADABLE'); }
 }
 if (names.has('yta_operations') && names.has('jobs')) {
  try {
   const remaining = ['EXISTS(SELECT 1 FROM jobs j WHERE j.id=o.job_id)'];
   if (importsExist) remaining.push('EXISTS(SELECT 1 FROM yta_summary_imports i WHERE i.job_id=o.job_id)', 'EXISTS(SELECT 1 FROM yta_summary_import_requests r WHERE r.job_id=o.job_id)');
   importState.pendingDeletions = count(db, "SELECT COUNT(*) AS n FROM yta_operations o WHERE o.provider='deletion' AND o.state='DELETING' AND (" + remaining.join(' OR ') + ')');
  } catch { fail('ROLLBACK_DELETE_LEDGER_UNREADABLE'); }
 }
 return freeze({kind: 'LOCAL_SQLITE_ROLLBACK_SNAPSHOT_V1', capturedAt: now,
  schemaSha256, tables, importState,
  databaseSha256: hash(JSON.stringify({schemaSha256, tables, importState}))});
}

function targetIdentity(value) {
 if (!value || value.evidenceKind !== 'SYNTHETIC_LOCAL_EXECUTION'
  || !COMMIT.test(value.sourceCommit || '') || !VERSION.test(value.versionId || '')
  || !SHA256.test(value.artifactSha256 || '') || !SHA256.test(value.ownerPolicySha256 || '')
  || !SHA256.test(value.databaseIdentitySha256 || '') || !SHA256.test(value.configurationSha256 || '')
  || value.ownerOnlyEnforced !== true
  || !['NONE', IMPORT_DELETE_COMPATIBILITY].includes(value.importDeletionCompatibility)) fail('ROLLBACK_INVALID_LOCAL_TARGET_EVIDENCE');
 return {evidenceKind: value.evidenceKind, sourceCommit: value.sourceCommit, versionId: value.versionId,
  artifactSha256: value.artifactSha256, ownerPolicySha256: value.ownerPolicySha256,
  databaseIdentitySha256: value.databaseIdentitySha256, configurationSha256: value.configurationSha256,
  ownerOnlyEnforced: true, importDeletionCompatibility: value.importDeletionCompatibility};
}
function fenced(fence, now) {
 const state = fences.get(fence);
 if (!state || state.phase !== 'FENCED' || state.inFlight !== 0) fail('ROLLBACK_WRITE_FENCE_NOT_DRAINED');
 if (state.drainedAt > now || now - state.drainedAt > ROLLBACK_EVIDENCE_MAX_AGE_MS) fail('ROLLBACK_FENCE_EVIDENCE_STALE');
 return state;
}
function clean(snapshot) {
 if (snapshot.importState.pendingDeletions) fail('ROLLBACK_ANALYSIS_DELETION_NOT_DRAINED');
 if (snapshot.importState.orphanImports || snapshot.importState.orphanRequests || snapshot.importState.invalidRequestStates) fail('ROLLBACK_EXISTING_IMPORT_INTEGRITY_FAILURE');
}

/**
 * Rehearses a decision against real local SQLite. This function cannot create
 * an operational deployment approval; synthetic identity evidence is mandatory.
 */
export function prepareLocalImportedSummaryRollback({db, fence, current, target, unresolvedReadbacks = 0, now = Date.now()}) {
 clock(now);
 const held = fenced(fence, now);
 if (!Number.isSafeInteger(unresolvedReadbacks) || unresolvedReadbacks !== 0) fail('ROLLBACK_REQUEST_READBACK_UNRESOLVED');
 const from = targetIdentity(current), to = targetIdentity(target);
 if (from.databaseIdentitySha256 !== to.databaseIdentitySha256) fail('ROLLBACK_DATABASE_BINDING_CHANGED');
 if (from.ownerPolicySha256 !== to.ownerPolicySha256) fail('ROLLBACK_OWNER_POLICY_CHANGED');
 if (from.configurationSha256 !== to.configurationSha256) fail('ROLLBACK_CONFIGURATION_CHANGED');
 const {schema, before} = readTransaction(db, schema => {
  if (schema.state !== 'ABSENT' && (schema.state !== 'EXACT' || schema.verified !== true)) fail('ROLLBACK_FULL_IMPORT_DDL_NOT_VERIFIED');
  const before = snapshotInsideReadTransaction(db, now); clean(before);
  return {schema, before};
 });
 if (before.importState.storage === 'PRESENT' && schema.state !== 'EXACT') fail('ROLLBACK_FULL_IMPORT_DDL_NOT_VERIFIED');
 const hasImportState = before.importState.imports > 0 || before.importState.requests > 0;
 if (hasImportState && to.importDeletionCompatibility !== IMPORT_DELETE_COMPATIBILITY) fail('ROLLBACK_TARGET_IMPORT_DELETE_INCOMPATIBLE');
 const scopeSha256 = hash(JSON.stringify({from, to, database: before.databaseSha256,
  importSchema: schema.schemaSha256, fence: held.id, revision: held.revision, capturedAt: now}));
 const plan = freeze({kind: 'LOCAL_IMPORTED_SUMMARY_ROLLBACK_PLAN_V1', scopeSha256,
  preparedAt: now, expiresAt: now + ROLLBACK_EVIDENCE_MAX_AGE_MS,
  from, target: to, before, importSchemaSha256: schema.schemaSha256,
  mode: hasImportState ? 'COMPATIBLE_TARGET_REHEARSAL_ONLY' : 'EMPTY_IMPORT_STATE_REHEARSAL_ONLY',
  productionExecutionSupported: false, operationallyAuthorized: false,
  writesMayResume: false, keepWriteFence: true,
  deletesData: false, runsMigration: false,
  remainingOperationalEvidence: ['DURABLE_ALL_WRITERS_FENCE', 'EXACT_ACTIVE_AND_TARGET_VERSION_PROOF',
   'OWNER_ACCESS_AND_ALL_WRITE_PATHS_READBACK', 'D1_AND_CONFIGURATION_PRESERVATION',
   'REVIEWED_COMPATIBLE_DELETE_IMPLEMENTATION', 'EXPLICIT_SAFE_RESUME_REVIEW']});
 plans.set(plan, {fence, fenceId: held.id, revision: held.revision, from, to});
 return plan;
}

/** Verifies unchanged local data after a simulated code switch, never unfences. */
export function verifyLocalImportedSummaryRollback({plan, db, fence, observedTarget, now = Date.now()}) {
 clock(now);
 const issued = plans.get(plan);
 if (!issued || issued.fence !== fence) fail('ROLLBACK_PLAN_NOT_ISSUED_IN_THIS_WINDOW');
 if (now < plan.preparedAt || now > plan.expiresAt) fail('ROLLBACK_PLAN_EXPIRED');
 const held = fenced(fence, now);
 if (held.id !== issued.fenceId || held.revision !== issued.revision) fail('ROLLBACK_FENCE_WINDOW_CHANGED');
 const target = targetIdentity(observedTarget);
 if (JSON.stringify(target) !== JSON.stringify(issued.to)) fail('ROLLBACK_TARGET_READBACK_MISMATCH');
 const after = readTransaction(db, schema => {
  if (schema.state === 'MISMATCH' || schema.schemaSha256 !== plan.importSchemaSha256) fail('ROLLBACK_SCHEMA_READBACK_MISMATCH');
  const after = snapshotInsideReadTransaction(db, now); clean(after); return after;
 });
 if (after.databaseSha256 !== plan.before.databaseSha256) fail('ROLLBACK_DATA_PRESERVATION_FAILED');
 return freeze({kind: 'LOCAL_IMPORTED_SUMMARY_ROLLBACK_READBACK_V1',
  status: 'LOCAL_REHEARSAL_VERIFIED', scopeSha256: plan.scopeSha256,
  databaseSha256: after.databaseSha256, targetSourceCommit: target.sourceCommit,
  productionExecutionSupported: false, operationallyAuthorized: false,
  writesMayResume: false, keepWriteFence: true,
  productionEnforcementVerified: false, dataDeletionPerformed: false});
}
