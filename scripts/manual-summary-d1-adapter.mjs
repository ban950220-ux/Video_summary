// Offline, injected D1 Workers-binding protocol candidate. No URL, credentials,
// fetch, CLI, route, or production activation exists in this module.
// References: developers.cloudflare.com/d1/worker-api/d1-database/ and
// developers.cloudflare.com/d1/sql-api/sql-statements/ .
import {
 assertOfflineOperationalCapability,
 beginOfflineOperationalMutation,
 finishOfflineOperationalMutation,
 canonicalOperationalIdentity,
} from './manual-summary-operational-contract.mjs';

export const productionExecutionSupported = false;
export const D1_MANUAL_SUMMARY_SOURCE_SHA256 = '04de16a15c295e1d1c172dcc799dc15d293b8721b5db58f9dae0d94ed9f21e01';
export const D1_MANUAL_SUMMARY_CATALOG_SHA256 = '6e124b1d7087d1b0fbc389e753789fb3f484cd471b54ad486fde8653183536c5';
const CRLF_SHA256 = 'c76eab87d0dcbf5ada0ed4597b1ab79b5ca3836f7f43d26bcc91d0b2e6621377';
const EXPECTED_SCHEMA_SHA256 = '6c0e7219bf6ef48ad6f55599b6c2e4349f36dcc30997d622fbf7210819fd346f';
const IMPORT_TABLES = ['yta_summary_import_requests', 'yta_summary_imports'];
const SOURCE_PATH = 'migrations/0021_manual_summary_imports.sql';
const MODE = 'OFFLINE_D1_BINDING_FIXTURE';
const MAX_AGE = 300_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function fail(code) { throw Object.assign(new Error(`D1_0021_${code}`), {code: `D1_0021_${code}`}); }
function canonical(value) {
 return JSON.stringify(value, (_key, part) => plain(part)
  ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]])) : part);
}
async function hash(value) {
 const input = typeof value === 'string' ? encoder.encode(value) : value;
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input)), byte => byte.toString(16).padStart(2, '0')).join('');
}
const digest = value => hash(canonical(value));
function freeze(value) {
 if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
 return value;
}
const quote = value => '"' + value.replaceAll('"', '""') + '"';
function safeIdentifier(value) { if (typeof value !== 'string' || !value || value.includes('\0') || encoder.encode(value).length > 1000) fail('IDENTIFIER_INVALID'); return value; }
function integer(value) { if (!Number.isSafeInteger(value)) fail('RESPONSE_INTEGER_INVALID'); return value; }
function decimal(value) { if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) fail('RESPONSE_DECIMAL_INVALID'); return value; }
function clock(value) { if (!Number.isSafeInteger(value) || value < 0) fail('CLOCK_INVALID'); return value; }
function fresh(at, now) { return at <= now && now - at <= MAX_AGE; }
function same(a, b) { return canonical(a) === canonical(b); }
function normalizedSql(sql) {
 if (sql === null) return null;
 if (typeof sql !== 'string') fail('SCHEMA_RESPONSE_INVALID');
 let out = '', quoted = null, space = false;
 for (let i = 0; i < sql.length; i++) {
  const c = sql[i];
  if (quoted) { out += c; if (c === quoted) { if (quoted !== ']' && sql[i + 1] === quoted) out += sql[++i]; else quoted = null; } continue; }
  if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; space = true; continue; }
  if (c === '/' && sql[i + 1] === '*') { i += 2; while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++; if (i >= sql.length) fail('SCHEMA_SQL_INVALID'); i++; space = true; continue; }
  if (/\s/.test(c)) { space = true; continue; }
  if (space && out) out += ' '; space = false;
  if (['"', "'", '`', '['].includes(c)) { quoted = c === '[' ? ']' : c; out += c; } else out += c.toLowerCase();
 }
 if (quoted) fail('SCHEMA_SQL_INVALID');
 return out.trim().replace(/;$/, '').replace(/^create (table|index) if not exists /, 'create $1 ');
}
function managed(row) {
 return [row.name, row.tbl_name].some(value => /^(?:yta_summary_import|idx_summary_import|sqlite_autoindex_yta_summary_import)/i.test(value))
  || /\byta_summary_import(?:s|_requests)\b/i.test(row.sql || '');
}
function safeResult(rows) { return freeze({executionMode: MODE, productionExecutionSupported: false, operationallyAuthorized: false, writesMayResume: false, migrationHistoryWritten: false, authenticatedTransportVerified: false, databaseIdentityVerified: false, ...rows}); }
function limitsOf(value = {}) {
 const defaults = {maxTables: 100, maxSchemaObjects: 500, maxRowsPerTable: 10000, maxTotalRows: 50000, pageRows: 100, maxPageBytes: 4_000_000, maxSnapshotBytes: 32_000_000, maxEncodedRowBytes: 1_900_000, maxPages: 1000, maxBatches: 45};
 if (Object.keys(value).some(key => !(key in defaults))) fail('LIMIT_UNKNOWN');
 for (const [key, cap] of Object.entries(defaults)) if (key in value && (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > cap)) fail('LIMIT_INVALID');
 return {...defaults, ...value};
}
async function compileSource(sourceBytes, catalog) {
 if (!(sourceBytes instanceof Uint8Array)) fail('SOURCE_BYTES_REQUIRED');
 const bytes = new Uint8Array(sourceBytes), sourceSha256 = await hash(bytes);
 if (![D1_MANUAL_SUMMARY_SOURCE_SHA256, CRLF_SHA256].includes(sourceSha256)) fail('SOURCE_HASH_MISMATCH');
 let source; try { source = decoder.decode(bytes).replaceAll('\r\n', '\n'); } catch { fail('SOURCE_ENCODING_INVALID'); }
 if (await hash(source) !== D1_MANUAL_SUMMARY_SOURCE_SHA256) fail('SOURCE_CANONICAL_HASH_MISMATCH');
 if (await digest(catalog) !== D1_MANUAL_SUMMARY_CATALOG_SHA256 || catalog.fileCount !== 15 || catalog.files?.length !== 15) fail('CATALOG_MISMATCH');
 // Splitting is safe only AFTER the whole byte string matches the reviewed SQL.
 const statements = source.replace(/^--[^\n]*\n/gm, '').split(';').map(value => value.trim()).filter(Boolean);
 if (statements.length !== 3 || statements.some(sql => !/^CREATE (?:TABLE|INDEX) IF NOT EXISTS /.test(sql))) fail('SINGLE_FILE_SCOPE_INVALID');
 return freeze({sourceSha256, statements, catalogSha256: D1_MANUAL_SUMMARY_CATALOG_SHA256});
}
function objectRows(rows, limits) {
 if (!Array.isArray(rows) || rows.length > limits.maxSchemaObjects) fail('SCHEMA_LIMIT');
 return rows.map(row => {
  if (!plain(row) || !['table', 'index', 'view', 'trigger'].includes(row.type) || !(row.sql === null || typeof row.sql === 'string')) fail('SCHEMA_RESPONSE_INVALID');
  return {type: row.type, name: safeIdentifier(row.name), tbl_name: safeIdentifier(row.tbl_name), sql: row.sql};
 }).sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
const CATALOG_SQL = 'SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name COLLATE BINARY';
const CATALOG_GUARD_SQL = "SELECT CASE WHEN (SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name COLLATE BINARY)) = ? THEN 1 ELSE abs(-9223372036854775808) END AS catalog_guard";

export async function createOfflineD1ManualSummaryAdapter({binding, sourceBytes, catalog, identity, fenceCapability, now = Date.now, limits: requestedLimits, executionMode = MODE} = {}) {
 if (executionMode !== MODE) fail('PRODUCTION_EXECUTION_UNSUPPORTED');
 if (!binding || typeof binding.withSession !== 'function') fail('WORKERS_SESSION_BINDING_REQUIRED');
 if (typeof now !== 'function') fail('CLOCK_REQUIRED');
 const limits = limitsOf(requestedLimits), source = await compileSource(sourceBytes, catalog);
 const target = canonicalOperationalIdentity(identity);
 const requirements = {operation: 'MIGRATION_0021', identity: target, sourceSha256: D1_MANUAL_SUMMARY_SOURCE_SHA256, binding};
 let windowSha256;
 const issued = new WeakMap();
 let outstandingMutation = false, batchCalls = 0, writeDispatched = false, writeAcknowledged = false;
 async function fence() {
  let observation;
  try { observation = await assertOfflineOperationalCapability(fenceCapability, requirements); } catch { fail('GLOBAL_FENCE_UNVERIFIED'); }
  if (!observation || observation.productionExecutionSupported !== false || observation.operationallyAuthorized !== false || observation.writesMayResume !== false || !/^[0-9a-f]{64}$/.test(observation.windowSha256)) fail('GLOBAL_FENCE_UNVERIFIED');
  if (windowSha256 && observation.windowSha256 !== windowSha256) fail('GLOBAL_FENCE_WINDOW_CHANGED');
  windowSha256 ??= observation.windowSha256;
  return observation;
 }
 await fence();
 function newSession() {
  let session; try { session = binding.withSession('first-primary'); } catch { fail('SESSION_START_FAILED'); }
  if (!session || typeof session.prepare !== 'function' || typeof session.batch !== 'function' || typeof session.getBookmark !== 'function') fail('SESSION_INTERFACE_INVALID');
  return session;
 }
 async function bookmark(session) {
  let value; try { value = session.getBookmark(); } catch { fail('BOOKMARK_READ_FAILED'); }
  // Bookmarks are opaque strings; no lexical/numeric comparisons or logging.
  if (typeof value !== 'string' || !value || value.length > 8192) fail('BOOKMARK_UNAVAILABLE');
  return hash(value);
 }
 async function batch(session, queries, {write = false} = {}) {
  await fence();
  if (++batchCalls > limits.maxBatches) fail('BATCH_BUDGET_EXHAUSTED');
  if (!Array.isArray(queries) || !queries.length) fail('EMPTY_BATCH');
  let prepared;
  try {
   prepared = queries.map(({sql, params = []}) => {
    if (typeof sql !== 'string' || encoder.encode(sql).length > 100000 || params.length > 100 || /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) fail('STATEMENT_SCOPE_INVALID');
    let statement = session.prepare(sql);
    if (params.length) statement = statement.bind(...params);
    return statement;
   });
  } catch { fail('PREPARE_FAILED'); }
  let results;
  try { if (write) writeDispatched = true; results = await session.batch(prepared); } catch { fail(write ? 'BATCH_OUTCOME_UNCONFIRMED' : 'READ_FAILED'); }
  if (!Array.isArray(results) || results.length !== queries.length || results.some(result => !plain(result) || result.success !== true || !Array.isArray(result.results))) fail(write ? 'BATCH_OUTCOME_UNCONFIRMED' : 'RESULT_SHAPE_INVALID');
  if (write) writeAcknowledged = true;
  await fence();
  await bookmark(session);
  return results.map(result => result.results);
 }
 async function snapshot(session = newSession()) {
  await fence();
  const startedAt = clock(now());
  const [catalogRows, tableList] = await batch(session, [{sql: CATALOG_SQL}, {sql: 'PRAGMA table_list'}]);
  if (encoder.encode(canonical(catalogRows)).length > limits.maxEncodedRowBytes) fail('CATALOG_GUARD_TOO_LARGE');
  const objects = objectRows(catalogRows, limits);
  if (!Array.isArray(tableList) || tableList.some(row => !plain(row) || !['main', 'temp'].includes(row.schema) || (row.schema === 'temp' && !['sqlite_temp_schema', 'sqlite_temp_master'].includes(row.name)))) fail('SCHEMA_SPACE_UNVERIFIED');
  const listed = tableList.filter(row => row.schema === 'main' && !['sqlite_schema', 'sqlite_master'].includes(row.name));
  if (new Set(listed.map(row => row.name)).size !== listed.length
   || listed.some(row => !objects.some(object => object.name === row.name && ['table', 'view'].includes(object.type)))
   || objects.filter(object => ['table', 'view'].includes(object.type)).some(object => !listed.some(row => row.name === object.name))) fail('SCHEMA_INVENTORY_INCOMPLETE');
  const tables = objects.filter(row => row.type === 'table');
  if (tables.length > limits.maxTables) fail('TABLE_LIMIT');
  // Every application's table, including migration history, is preserved. There
  // is no _cf_* blanket exclusion: inaccessible system objects fail closed.
  const metadataQueries = [], metadataKeys = [];
  for (const object of objects) {
   for (const pragma of object.type === 'table' ? ['table_xinfo', 'foreign_key_list', 'index_list'] : object.type === 'index' ? ['index_xinfo'] : []) {
    metadataQueries.push({sql: `PRAGMA ${pragma}(${quote(object.name)})`}); metadataKeys.push(`${pragma}:${object.name}`);
   }
  }
  const metadataResults = metadataQueries.length ? await batch(session, metadataQueries) : [];
  const metadata = new Map(metadataKeys.map((key, index) => [key, metadataResults[index]]));
  // WITHOUT ROWID primary-key indexes may be returned by index_list without a
  // separate sqlite_master row. Discover their exact index_xinfo explicitly.
  const extraIndexNames = [...new Set(tables.flatMap(table => metadata.get(`index_list:${table.name}`).map(index => safeIdentifier(index.name))))]
   .filter(name => !metadata.has(`index_xinfo:${name}`)).sort();
  if (extraIndexNames.length) {
   const extraQueries = extraIndexNames.map(name => ({sql: `PRAGMA index_xinfo(${quote(name)})`}));
   const extraResults = await batch(session, extraQueries);
   extraIndexNames.forEach((name, index) => {metadata.set(`index_xinfo:${name}`, extraResults[index]);metadataKeys.push(`index_xinfo:${name}`);});
   metadataQueries.push(...extraQueries); metadataResults.push(...extraResults);
  }
  const definitions = [], tablePlans = [];
  for (const object of objects) {
   const entry = {type: object.type, name: object.name, table: object.tbl_name, sql: normalizedSql(object.sql)};
   if (object.type === 'table') {
    const info = tableList.find(row => row.schema === 'main' && row.name === object.name);
    if (!info || info.type !== 'table' || ![0, 1].includes(info.wr) || ![0, 1].includes(info.strict)) fail('TABLE_PROFILE_UNSUPPORTED');
    entry.options = {type: info.type, ncol: integer(info.ncol), wr: info.wr, strict: info.strict};
    const columns = metadata.get(`table_xinfo:${object.name}`), foreignKeys = metadata.get(`foreign_key_list:${object.name}`), indexes = metadata.get(`index_list:${object.name}`);
    if (!columns.length || columns.length > 100 || columns.length !== info.ncol) fail('COLUMN_PROFILE_UNSUPPORTED');
    entry.columns = columns.map(row => ({cid: integer(row.cid), name: safeIdentifier(row.name), type: String(row.type), notnull: integer(row.notnull), dflt_value: row.dflt_value, pk: integer(row.pk), hidden: integer(row.hidden)}));
    entry.foreignKeys = foreignKeys.map(row => ({id: integer(row.id), seq: integer(row.seq), table: safeIdentifier(row.table), from: safeIdentifier(row.from), to: row.to, on_update: row.on_update, on_delete: row.on_delete, match: row.match}));
    entry.indexes = indexes.map(index => {
     const name = safeIdentifier(index.name), indexColumns = metadata.get(`index_xinfo:${name}`);
     if (!indexColumns) fail('INDEX_PROFILE_UNSUPPORTED');
     return {name, unique: integer(index.unique), origin: index.origin, partial: integer(index.partial), columns: indexColumns.map(indexColumn)};
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const names = entry.columns.map(row => row.name);
    const rowid = info.wr === 0 ? ['rowid', '_rowid_', 'oid'].find(alias => !names.some(name => name.toLowerCase() === alias)) : null;
    if (info.wr === 0 && !rowid) fail('ROWID_INACCESSIBLE');
    const ordering = rowid ? [quote(rowid)] : entry.columns.filter(row => row.pk > 0).sort((a, b) => a.pk - b.pk).map(row => quote(row.name));
    if (!ordering.length) fail('ROW_ORDER_UNVERIFIED');
    const expressions = [...names.map(quote), ...(rowid ? [quote(rowid)] : [])];
    const rowBytes = '32+' + expressions.map(expression => `(CASE WHEN typeof(${expression}) IN ('text','blob') THEN 64 + 2*length(CAST(${expression} AS BLOB)) ELSE 64 END)`).join('+');
    tablePlans.push({name: object.name, columns: names, rowid, ordering, expressions, countSql: `SELECT CAST(count(*) AS TEXT) AS n, CAST(COALESCE(max(${rowBytes}),0) AS TEXT) AS max_bytes, CAST(COALESCE(sum(${rowBytes}),0) AS TEXT) AS total_bytes FROM main.${quote(object.name)}`});
   }
   if (object.type === 'index') entry.columns = metadata.get(`index_xinfo:${object.name}`).map(indexColumn);
   definitions.push(entry);
  }
  const managedDefinitions = definitions.filter(entry => managed({name: entry.name, tbl_name: entry.table, sql: entry.sql}));
  const schemaSha256 = await digest(managedDefinitions);
  const schemaState = managedDefinitions.length === 0 ? 'ABSENT' : schemaSha256 === EXPECTED_SCHEMA_SHA256 ? 'EXACT' : 'MISMATCH';
  const counts = tablePlans.length ? await batch(session, tablePlans.map(plan => ({sql: plan.countSql}))) : [];
  let totalRows = 0, estimatedBytes = 0, totalBytes = 0;
  const pageQueries = [], pages = [];
  for (let i = 0; i < tablePlans.length; i++) {
   const plan = tablePlans[i], result = counts[i];
   if (result.length !== 1) fail('COUNT_RESULT_INVALID');
   const count = BigInt(decimal(result[0].n)), rowBytes = BigInt(decimal(result[0].max_bytes)), bytes = BigInt(decimal(result[0].total_bytes));
   if (count < 0n || count > BigInt(limits.maxRowsPerTable)) fail('ROW_LIMIT');
   if (rowBytes < 0n || rowBytes > BigInt(limits.maxEncodedRowBytes)) fail('ENCODED_ROW_BUDGET');
   if (bytes < 0n || bytes > BigInt(limits.maxSnapshotBytes)) fail('RESPONSE_BYTE_LIMIT');
   totalRows += Number(count); estimatedBytes += Number(bytes);
   if (totalRows > limits.maxTotalRows) fail('TOTAL_ROW_LIMIT');
   if (estimatedBytes > limits.maxSnapshotBytes) fail('RESPONSE_BYTE_LIMIT');
   plan.rowCount = Number(count); plan.hashes = [];
   const pageRows = Math.min(limits.pageRows, Math.max(1, Math.floor(limits.maxPageBytes / Math.max(1, Number(rowBytes)))));
   for (let offset = 0; offset < Number(count); offset += pageRows) {
    const expressions = plan.expressions.flatMap((expression, index) => [
     `typeof(${expression}) AS t${index}`,
     `CASE WHEN typeof(${expression}) IN ('text','blob') THEN hex(CAST(${expression} AS BLOB)) WHEN typeof(${expression}) = 'integer' THEN CAST(${expression} AS TEXT) ELSE ${expression} END AS v${index}`,
    ]);
    const expectedRows = Math.min(pageRows, Number(count) - offset);
    pageQueries.push({sql: `SELECT ${expressions.join(',')} FROM main.${quote(plan.name)} ORDER BY ${plan.ordering.join(',')} LIMIT ? OFFSET ?`, params: [expectedRows, offset]});
    pages.push({plan, expectedRows});
    if (pages.length > limits.maxPages) fail('PAGE_LIMIT');
   }
  }
  // All row pages and the catalog/count readbacks share one D1 batch transaction.
  // The durable all-writer fence additionally covers discovery/metadata batches.
  const fullResults = await batch(session, [...metadataQueries, ...pageQueries, {sql: CATALOG_SQL}, {sql: 'PRAGMA table_list'}, ...tablePlans.map(plan => ({sql: plan.countSql}))]);
  if (!same(fullResults.slice(0, metadataQueries.length), metadataResults)) fail('SCHEMA_CHANGED_DURING_READ');
  const dataResults = fullResults.slice(metadataQueries.length);
  for (let i = 0; i < pages.length; i++) {
   const {plan, expectedRows} = pages[i], page = dataResults[i];
   if (page.length !== expectedRows) fail('ROW_COUNT_DRIFT');
   const bytes = encoder.encode(canonical(page)).length; totalBytes += bytes;
   if (bytes > limits.maxPageBytes || totalBytes > limits.maxSnapshotBytes) fail('RESPONSE_BYTE_LIMIT');
   for (const row of page) plan.hashes.push(await digest(plan.expressions.map((_expression, index) => encodeValue(row[`t${index}`], row[`v${index}`]))));
  }
  if (!same(objectRows(dataResults[pages.length], limits), objects)) fail('SCHEMA_CHANGED_DURING_READ');
  const sortTableList = list => [...list].sort((a, b) => `${a.schema}:${a.name}` < `${b.schema}:${b.name}` ? -1 : `${a.schema}:${a.name}` > `${b.schema}:${b.name}` ? 1 : 0);
  if (!same(sortTableList(dataResults[pages.length + 1]), sortTableList(tableList))) fail('SCHEMA_CHANGED_DURING_READ');
  if (!same(dataResults.slice(pages.length + 2), counts)) fail('ROW_COUNT_DRIFT');
  const fingerprints = [];
  for (const plan of tablePlans) {
   plan.hashes.sort();
   fingerprints.push({name: plan.name, rowCount: plan.rowCount, columnsSha256: await digest({columns: plan.columns, rowidAlias: plan.rowid}), rowsSha256: await hash(plan.hashes.join('\n'))});
  }
  await fence();
  const finishedAt = clock(now());
  if (!fresh(startedAt, finishedAt)) fail('SNAPSHOT_STALE');
  const originalDefinitions = definitions.filter(entry => !managed({name: entry.name, tbl_name: entry.table, sql: entry.sql}));
  const originalTables = fingerprints.filter(table => !IMPORT_TABLES.includes(table.name));
  const body = {capturedAt: finishedAt, windowSha256, sourceSha256: source.sourceSha256, catalogSha256: source.catalogSha256, schemaState, schemaSha256, originalSha256: await digest({objects: objects.filter(object => !managed(object)), definitions: originalDefinitions, tables: originalTables}), tables: fingerprints, bookmarkSha256: await bookmark(session)};
  return {body: freeze(body), stateSha256: await digest({...body, capturedAt: null, bookmarkSha256: null}), rawCatalog: objects, session};
 }
 async function captureBefore() {
  if ((await fence()).phase !== 'MIGRATION_RESERVED') fail('RECONCILIATION_REQUIRED');
  if (outstandingMutation) fail('RECONCILIATION_REQUIRED');
  const observation = await snapshot();
  if (observation.body.schemaState === 'MISMATCH') fail('PRE_SCHEMA_MISMATCH');
  const handle = safeResult({kind: 'OFFLINE_D1_0021_BEFORE', ...observation.body});
  issued.set(handle, {...observation, attempted: false});
  return handle;
 }
 function beforeState(before) {
  const state = before && issued.get(before);
  if (!state) fail('BEFORE_UNISSUED');
  if (!fresh(before.capturedAt, clock(now()))) fail('BEFORE_STALE');
  return state;
 }
 async function apply({before} = {}) {
  const original = beforeState(before);
  if ((await fence()).phase !== 'MIGRATION_RESERVED') fail('RECONCILIATION_REQUIRED');
  if (original.attempted || outstandingMutation) fail('WRITE_RETRY_FORBIDDEN');
  const current = await snapshot();
  if (current.stateSha256 !== original.stateSha256) fail('BEFORE_STATE_CHANGED');
  if (current.body.schemaState === 'EXACT') return safeResult({state: 'ALREADY_EXACT', writeAttempted: false, preservationObservedWithinWindow: true, attributionProved: false, schemaState: 'EXACT', originalSha256: current.body.originalSha256});
  if (current.body.schemaState !== 'ABSENT') fail('PRE_SCHEMA_MISMATCH');
  const guardedCatalog = JSON.stringify(current.rawCatalog);
  if (encoder.encode(guardedCatalog).length > limits.maxEncodedRowBytes) fail('CATALOG_GUARD_TOO_LARGE');
  await fence();
  if (batchCalls + 6 > limits.maxBatches) fail('POSTCHECK_BUDGET_UNAVAILABLE');
  // Durable one-shot claim precedes the single write batch. A caller cannot
  // replace a lost acknowledgment with a second write attempt.
  try { await beginOfflineOperationalMutation(fenceCapability, requirements); } catch { fail('MUTATION_CLAIM_REJECTED'); }
  original.attempted = true; outstandingMutation = true;
  let acknowledged = false;
  try {
   const session = newSession();
   await batch(session, [{sql: CATALOG_GUARD_SQL, params: [guardedCatalog]}, ...source.statements.map(sql => ({sql}))], {write: true});
   acknowledged = true;
   const after = await snapshot(session);
   const preserved = after.body.originalSha256 === before.originalSha256;
   const emptyImports = after.body.tables.filter(table => IMPORT_TABLES.includes(table.name)).every(table => table.rowCount === 0);
   if (after.body.schemaState !== 'EXACT' || !preserved || !emptyImports) {
    await finishOfflineOperationalMutation(fenceCapability, {outcome: 'POSTCHECK_FAILED'});
    return safeResult({state: 'ACKNOWLEDGED_POSTCHECK_FAILED', writeAttempted: writeDispatched, batchAcknowledged: true, schemaState: after.body.schemaState, preservationVerified: preserved, retryAllowed: false});
   }
   await finishOfflineOperationalMutation(fenceCapability, {outcome: 'ACKNOWLEDGED'});
   return safeResult({state: 'ACKNOWLEDGED_AND_OBSERVED', writeAttempted: writeDispatched, batchAcknowledged: true, schemaState: 'EXACT', preservationVerified: true, sourceSha256: source.sourceSha256, schemaSha256: after.body.schemaSha256, beforeOriginalSha256: before.originalSha256, afterOriginalSha256: after.body.originalSha256, bookmarkSha256: after.body.bookmarkSha256, retryAllowed: false});
  } catch {
   acknowledged ||= writeAcknowledged;
   try { await finishOfflineOperationalMutation(fenceCapability, {outcome: acknowledged ? 'POSTCHECK_FAILED' : 'UNKNOWN'}); } catch { /* The durable claim remains closed even if its final status ACK is lost. */ }
   return safeResult({state: acknowledged ? 'ACKNOWLEDGED_POSTCHECK_UNCONFIRMED' : 'BATCH_OUTCOME_UNCONFIRMED', writeAttempted: writeDispatched, batchAcknowledged: acknowledged, preservationVerified: false, retryAllowed: false});
  }
 }
 async function reconcile({before} = {}) {
  const original = beforeState(before);
  if (!original.attempted) fail('NO_ATTEMPT_TO_RECONCILE');
  // Fresh primary session after uncertain acknowledgment. ABSENT is not proof
  // a still-pending write will never commit; EXACT does not prove attribution.
  const observed = await snapshot(newSession());
  return safeResult({state: 'READBACK_ONLY_UNRESOLVED', schemaState: observed.body.schemaState, preservationObserved: observed.body.originalSha256 === before.originalSha256, attributionProved: false, pendingRequestTerminalProved: false, retryAllowed: false, schemaSha256: observed.body.schemaSha256, originalSha256: observed.body.originalSha256, bookmarkSha256: observed.body.bookmarkSha256});
 }
 async function observeAfterRestart() {
  const observed = await snapshot(newSession());
  return safeResult({state: 'READBACK_WITHOUT_TRUSTED_BEFORE', schemaState: observed.body.schemaState, schemaSha256: observed.body.schemaSha256, originalSha256: observed.body.originalSha256, preservationVerified: false, attributionProved: false, retryAllowed: false});
 }
 return Object.freeze({captureBefore, apply, reconcile, observeAfterRestart, executionMode: MODE, productionExecutionSupported: false});
}
function indexColumn(row) { return {seqno: integer(row.seqno), cid: integer(row.cid), name: row.name, desc: integer(row.desc), coll: row.coll, key: integer(row.key)}; }
function encodeValue(type, value) {
 if (type === 'null' && value === null) return ['null'];
 if (type === 'integer') return [type, decimal(value)];
 if (type === 'text' || type === 'blob') { if (typeof value !== 'string' || !/^(?:[0-9A-F]{2})*$/.test(value)) fail('BYTE_ENCODING_INVALID'); return [type, value]; }
 if (type === 'real' && typeof value === 'number' && Number.isFinite(value)) {
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value, false);
  return [type, Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')];
 }
 fail('VALUE_NOT_LOSSLESS');
}
