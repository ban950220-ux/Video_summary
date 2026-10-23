// Operator module. Uses an already-authorized D1 binding/adapter supplied by the
// caller. No credential acquisition, network client, automatic retry or CLI.
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {target,sha,createExpectedSchema,trustedBuffers,schemaFingerprint,compareManagedSchema,assessAdoptionReview} from './schema-baseline-review.mjs';
export {target};
export const baselineTable='codex_schema_baselines';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=value=>typeof value==='string'&&value.length===64&&/^[0-9a-f]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const exact=(obj,keys)=>obj&&typeof obj==='object'&&!Array.isArray(obj)&&same(Object.keys(obj).sort(),[...keys].sort());
const milliseconds=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
// Avoid floating-point Julian-day rounding across the approval boundary.
const dbTime="(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
// sqlite_master text retains spelling, but SQLite identifiers compare ASCII case
// insensitively. Discover aliases with NOCASE; keep returned SQL/names unchanged
// so an unreviewed definition is rejected, never normalized into approval.
const schemaSelect="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name COLLATE NOCASE IN ('jobs','usage_events') OR substr(tbl_name,1,4)='yta_' COLLATE NOCASE ORDER BY type,name";
const schemaJson=`(SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (${schemaSelect}))`;
const historyCount="(SELECT COUNT(*) FROM sqlite_master WHERE name='d1_migrations' COLLATE NOCASE)";
const tables=['yta_operations','yta_paid_summary_reservations','yta_gemini_two_pass_calls','yta_audio','yta_free_batch_chunks'];
const stateGroups=tables.map(table=>`'${table}',json((SELECT json_group_array(json_object('state',state,'n',n)) FROM (SELECT state,COUNT(*) n FROM ${table} GROUP BY state ORDER BY state)))`).join(',');
const activeCount=`((SELECT COUNT(*) FROM yta_operations WHERE state IN ('CLAIMED','RECEIPT_STORED'))+(SELECT COUNT(*) FROM yta_paid_summary_reservations WHERE state IN ('RESERVED','UNCERTAIN'))+(SELECT COUNT(*) FROM yta_gemini_two_pass_calls WHERE state IN ('RESERVED','DISPATCHING','RECEIVED','UNCERTAIN'))+(SELECT COUNT(*) FROM yta_audio WHERE state='CLAIMED')+(SELECT COUNT(*) FROM yta_free_batch_chunks WHERE state='CLAIMED'))`;
const statesJson=`json_object(${stateGroups},'inflight',${activeCount})`;
const snapshotSelect=`SELECT ${schemaJson} AS schema_json,${statesJson} AS states_json,${historyCount} AS history_count,${dbTime} AS captured_ms`;
const tableSql="CREATE TABLE IF NOT EXISTS codex_schema_baselines (id TEXT PRIMARY KEY, database_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, record_sha256 TEXT NOT NULL, registered_at_ms INTEGER NOT NULL)";
const noUpdateSql="CREATE TRIGGER IF NOT EXISTS codex_baseline_no_update BEFORE UPDATE ON codex_schema_baselines BEGIN SELECT RAISE(ABORT,'SCHEMA_BASELINE_IMMUTABLE'); END";
const noDeleteSql="CREATE TRIGGER IF NOT EXISTS codex_baseline_no_delete BEFORE DELETE ON codex_schema_baselines BEGIN SELECT RAISE(ABORT,'SCHEMA_BASELINE_IMMUTABLE'); END";
const metadataSelect="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name='codex_schema_baselines' COLLATE NOCASE ORDER BY type,name";
const expectedMetadata=[
 {type:'index',name:'sqlite_autoindex_codex_schema_baselines_1',tbl_name:baselineTable,sql:null},
 {type:'index',name:'sqlite_autoindex_codex_schema_baselines_2',tbl_name:baselineTable,sql:null},
 {type:'table',name:baselineTable,tbl_name:baselineTable,sql:tableSql.replace('IF NOT EXISTS ','')},
 {type:'trigger',name:'codex_baseline_no_delete',tbl_name:baselineTable,sql:noDeleteSql.replace('IF NOT EXISTS ','')},
 {type:'trigger',name:'codex_baseline_no_update',tbl_name:baselineTable,sql:noUpdateSql.replace('IF NOT EXISTS ','')}
];
const metadataJson=`(SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (${metadataSelect}))`;
const source=()=>createExpectedSchema(resolve(import.meta.dirname,'..'));
const statement=(db,sql,args=[])=>db.prepare(sql).bind(...args);

// Binding identity is not discoverable through sqlite_master. The caller must
// verify actual target selection in assertAuthorized, including the DB object.
async function authorize(db,approvalDigest,assertAuthorized){
 if(typeof assertAuthorized!=='function'||await assertAuthorized({db,target,approvalDigest})!==true)fail('BASELINE_AUTHORIZATION_REQUIRED');
}
function snapshotDigest(snapshot){return sha(JSON.stringify({schemaJson:snapshot.schemaJson,statesJson:snapshot.statesJson,historyTableCount:snapshot.historyTableCount}));}
export async function readRegistrationSnapshot(db){
 const row=await statement(db,snapshotSelect).first();
 if(!row||typeof row.schema_json!=='string'||typeof row.states_json!=='string'||!Number.isSafeInteger(row.captured_ms))fail('BASELINE_SNAPSHOT_INVALID');
 const result={kind:'BASELINE_DB_SNAPSHOT_V1',...target,schemaJson:row.schema_json,statesJson:row.states_json,historyTableCount:row.history_count,capturedAt:new Date(row.captured_ms).toISOString()};
 result.digest=snapshotDigest(result);return result;
}
function validateSnapshot(snapshot,expected,now){
 if(!exact(snapshot,['kind','accountId','databaseId','schemaJson','statesJson','historyTableCount','capturedAt','digest'])||snapshot.kind!=='BASELINE_DB_SNAPSHOT_V1'||snapshot.accountId!==target.accountId||snapshot.databaseId!==target.databaseId||!hash(snapshot.digest)||snapshot.digest!==snapshotDigest(snapshot))fail('BASELINE_SNAPSHOT_INVALID');
 const captured=milliseconds(snapshot.capturedAt);if(!Number.isFinite(captured)||captured>now+1||now-captured>300000)fail('BASELINE_SNAPSHOT_STALE');
 if(snapshot.historyTableCount!==0)fail('BASELINE_HISTORY_REVIEW_REQUIRED');
 const rows=JSON.parse(snapshot.schemaJson),states=JSON.parse(snapshot.statesJson);
 if(!compareManagedSchema(rows,expected).matches)fail('BASELINE_SCHEMA_MISMATCH');
 if(states.inflight!==0)fail('BASELINE_OPERATIONS_IN_FLIGHT');
 return rows;
}
function requestRecord(input,expected,now){
 if(!exact(input,['observation','review','controls','dbSnapshot','approval']))fail('BASELINE_INPUT_INVALID');
 const {observation,review,controls,dbSnapshot,approval}=input;
 const rows=validateSnapshot(dbSnapshot,expected,now);
 if(!same(observation.rows,rows))fail('BASELINE_OBSERVATION_SNAPSHOT_MISMATCH');
 const assessed=assessAdoptionReview({observation,expected,review,controls},{now});
 if(!assessed.readyForIndependentOperatorReview)fail('BASELINE_REVIEW_BLOCKED:'+assessed.blocks.join(','));
 if(!exact(approval,['kind','requestId','accountId','databaseId','action','approvedAt','expiresAt','windowId','windowStartsAt','windowEndsAt','observationDigest','snapshotDigest','schemaFingerprint','catalogDigest','controlsDigest','restoreBookmarkDigest']))fail('BASELINE_APPROVAL_INVALID');
 const approved=milliseconds(approval.approvedAt),expires=milliseconds(approval.expiresAt),start=milliseconds(approval.windowStartsAt),end=milliseconds(approval.windowEndsAt);
 if(approval.kind!=='SCHEMA_BASELINE_REGISTRATION_APPROVAL_V1'||!uuid(approval.requestId)||!uuid(approval.windowId)||approval.accountId!==target.accountId||approval.databaseId!==target.databaseId||approval.action!=='REGISTER_BASELINE_ONLY'||![approved,expires,start,end].every(Number.isFinite)||approved>now||approved<Math.max(milliseconds(observation.completedAt),milliseconds(dbSnapshot.capturedAt),milliseconds(review.reviewedAt),milliseconds(controls.capturedAt),milliseconds(controls.timeTravel.capturedAt))||now>=expires||expires-approved>300000||start>approved||expires>end||now<start||end-start>900000)fail('BASELINE_APPROVAL_SCOPE_EXPIRED');
 for(const key of ['observationDigest','snapshotDigest','schemaFingerprint','catalogDigest','controlsDigest','restoreBookmarkDigest'])if(!hash(approval[key]))fail('BASELINE_APPROVAL_DIGEST_INVALID');
 if(approval.observationDigest!==observation.digest||approval.snapshotDigest!==dbSnapshot.digest||approval.schemaFingerprint!==expected.fingerprint||approval.catalogDigest!==expected.catalogDigest||approval.controlsDigest!==sha(JSON.stringify(controls))||approval.restoreBookmarkDigest!==sha(controls.timeTravel.bookmark))fail('BASELINE_APPROVAL_BINDING_MISMATCH');
 // Persist only enumerated non-secret evidence fields, never input objects.
 return {kind:'REGISTERED_MANAGED_SCHEMA_BASELINE_V1',id:approval.requestId,...target,historyClaim:'UNKNOWN_NO_HISTORICAL_APPLIED_ROWS',schemaFingerprint:expected.fingerprint,catalogDigest:expected.catalogDigest,observationDigest:observation.digest,snapshotDigest:dbSnapshot.digest,approvalDigest:sha(JSON.stringify(approval)),controlsDigest:approval.controlsDigest,restoreBookmarkDigest:approval.restoreBookmarkDigest,approvedAt:approval.approvedAt,expiresAt:approval.expiresAt,windowId:approval.windowId,windowStartsAt:approval.windowStartsAt,windowEndsAt:approval.windowEndsAt};
}
export function validateStoredBaseline(row,expected=source()){
 if(!row||!hash(row.record_sha256)||typeof row.record_json!=='string'||sha(row.record_json)!==row.record_sha256||!Number.isSafeInteger(row.registered_at_ms))return false;
 try{
  const r=JSON.parse(row.record_json),keys=['kind','id','accountId','databaseId','historyClaim','schemaFingerprint','catalogDigest','observationDigest','snapshotDigest','approvalDigest','controlsDigest','restoreBookmarkDigest','approvedAt','expiresAt','windowId','windowStartsAt','windowEndsAt'];
  return exact(r,keys)&&r.kind==='REGISTERED_MANAGED_SCHEMA_BASELINE_V1'&&uuid(r.id)&&row.id===r.id&&row.database_id===target.databaseId&&r.accountId===target.accountId&&r.databaseId===target.databaseId&&r.historyClaim==='UNKNOWN_NO_HISTORICAL_APPLIED_ROWS'&&r.schemaFingerprint===expected.fingerprint&&r.catalogDigest===expected.catalogDigest&&['observationDigest','snapshotDigest','approvalDigest','controlsDigest','restoreBookmarkDigest'].every(k=>hash(r[k]))&&uuid(r.windowId)&&[r.approvedAt,r.expiresAt,r.windowStartsAt,r.windowEndsAt].every(v=>Number.isFinite(milliseconds(v)))&&row.registered_at_ms>=milliseconds(r.approvedAt)&&row.registered_at_ms<milliseconds(r.expiresAt)&&milliseconds(r.expiresAt)-milliseconds(r.approvedAt)<=300000&&milliseconds(r.windowStartsAt)<=milliseconds(r.approvedAt)&&milliseconds(r.expiresAt)<=milliseconds(r.windowEndsAt)&&milliseconds(r.windowEndsAt)-milliseconds(r.windowStartsAt)<=900000;
 }catch{return false;}
}
export async function inspectRegisteredBaseline(db){
 const metadata=(await statement(db,metadataSelect).all()).results;
 if(!metadata?.length)return {state:'ABSENT',row:null};
 if(!same(metadata,expectedMetadata))fail('BASELINE_STORAGE_SCHEMA_MISMATCH');
 const rows=(await statement(db,'SELECT id,database_id,record_json,record_sha256,registered_at_ms FROM codex_schema_baselines').all()).results;
 if(rows.length===0)return {state:'EMPTY_STORAGE',row:null};
 if(rows.length!==1||!validateStoredBaseline(rows[0]))fail('BASELINE_RECORD_INVALID');
 return {state:'RECORDED',row:rows[0]};
}

export async function registerManagedSchemaBaseline(db,input,{assertAuthorized,now=Date.now}={}){
 const expected=source(),record=requestRecord(input,expected,now()),recordJson=JSON.stringify(record),recordSha=sha(recordJson);
 await authorize(db,record.approvalDigest,assertAuthorized);
 const existing=await inspectRegisteredBaseline(db);
 if(existing.row){if(existing.row.record_json!==recordJson||existing.row.record_sha256!==recordSha)fail('BASELINE_CONFLICT');return {state:'ALREADY_RECORDED',row:existing.row,writeBatches:0};}
 const live=await readRegistrationSnapshot(db);validateSnapshot(live,expected,now());
 if(live.digest!==input.dbSnapshot.digest)fail('BASELINE_SNAPSHOT_CHANGED');
 await authorize(db,record.approvalDigest,assertAuthorized);
 // Last await above cannot silently extend approval lifetime. SQL also checks
 // the server clock and exact schema/state metadata inside the write transaction.
 if(JSON.stringify(requestRecord(input,expected,now()))!==recordJson)fail('BASELINE_REQUEST_CHANGED');
 const a=input.approval,freshnessFloor=Math.min(...[input.observation.startedAt,input.dbSnapshot.capturedAt,input.review.reviewedAt,input.controls.capturedAt,input.controls.timeTravel.capturedAt].map(milliseconds));
 const insert=`INSERT INTO codex_schema_baselines(id,database_id,record_json,record_sha256,registered_at_ms)
 SELECT ?,?,?,?,${dbTime} WHERE ${schemaJson}=? AND ${statesJson}=? AND ${historyCount}=0 AND ${metadataJson}=?
 AND ${dbTime}>=? AND ${dbTime}<? AND ${dbTime}>=? AND ${dbTime}<? AND ${dbTime}-? BETWEEN 0 AND 300000
 ON CONFLICT DO NOTHING`;
 const verify=`SELECT CASE WHEN ${metadataJson}=? AND EXISTS(SELECT 1 FROM codex_schema_baselines WHERE id=? AND database_id=? AND record_json=? AND record_sha256=?) THEN 1 ELSE json('BASELINE_ATOMIC_ASSERTION_FAILED') END AS verified`;
 try{
  await db.batch([statement(db,tableSql),statement(db,noUpdateSql),statement(db,noDeleteSql),statement(db,insert,[record.id,target.databaseId,recordJson,recordSha,live.schemaJson,live.statesJson,JSON.stringify(expectedMetadata),milliseconds(a.approvedAt),milliseconds(a.expiresAt),milliseconds(a.windowStartsAt),milliseconds(a.windowEndsAt),freshnessFloor]),statement(db,verify,[JSON.stringify(expectedMetadata),record.id,target.databaseId,recordJson,recordSha])]);
 }catch(error){
  // One read-only reconciliation, never repeat the batch after an unknown ACK.
  try{const found=await inspectRegisteredBaseline(db);if(found.row?.record_json===recordJson&&found.row.record_sha256===recordSha)return {state:'RECOVERED_AFTER_ACK_LOSS',row:found.row,writeBatches:1};}catch{}
  throw Object.assign(new Error('BASELINE_REGISTRATION_UNCONFIRMED'),{code:'BASELINE_REGISTRATION_UNCONFIRMED',cause:error});
 }
 const after=await inspectRegisteredBaseline(db);
 if(after.row?.record_json!==recordJson||after.row.record_sha256!==recordSha)fail('BASELINE_READBACK_UNCONFIRMED');
 return {state:'RECORDED',row:after.row,writeBatches:1};
}

export async function readBaselineForMigration(db){
 const found=await inspectRegisteredBaseline(db);if(!found.row)fail('BASELINE_NOT_RECORDED');
 const current=await statement(db,`SELECT ${schemaJson} AS schema_json,${dbTime} AS captured_ms`).first();
 return {kind:'D1_SCHEMA_BASELINE_READBACK_V1',databaseId:target.databaseId,capturedAt:new Date(current.captured_ms).toISOString(),managedSchemaFingerprint:schemaFingerprint(JSON.parse(current.schema_json)),row:found.row};
}
function after16Fingerprint(){
 const buffers=trustedBuffers(resolve(import.meta.dirname,'..')),db=new DatabaseSync(':memory:');
 try{
  db.exec(buffers.base.toString());
  for(const file of buffers.files.filter(f=>f.name<='0016_full_coverage_write_lock.sql'))db.exec(file.bytes.toString());
  return schemaFingerprint(db.prepare(schemaSelect).all());
 }finally{db.close();}
}
export function validBaselineReadback(value,{now=Date.now(),phase='before'}={}){
 const at=milliseconds(value?.capturedAt);
 const expectedFingerprint=phase==='before'?source().fingerprint:phase==='after'?after16Fingerprint():null;
 return exact(value,['kind','databaseId','capturedAt','managedSchemaFingerprint','row'])&&value.kind==='D1_SCHEMA_BASELINE_READBACK_V1'&&value.databaseId===target.databaseId&&Number.isFinite(at)&&at<=now+1&&now-at<=300000&&hash(value.managedSchemaFingerprint)&&value.managedSchemaFingerprint===expectedFingerprint&&validateStoredBaseline(value.row);
}
