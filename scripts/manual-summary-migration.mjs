// Local preparation only. This module has no Cloudflare/D1 transport, credentials,
// command-line execution, or authority to change a production database.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {reviewedMigrationSource,matchesReviewedMigrationSource} from './migration-source-catalog.mjs';

export const productionExecutionSupported=false;
export const manualSummaryMigrationName='0021_manual_summary_imports.sql';
export const manualSummaryMigrationPath=`migrations/${manualSummaryMigrationName}`;
export const manualSummaryMigrationSha256='04de16a15c295e1d1c172dcc799dc15d293b8721b5db58f9dae0d94ed9f21e01';
export const manualSummaryImportTables=Object.freeze(['yta_summary_import_requests','yta_summary_imports']);
const root=resolve(import.meta.dirname,'..');
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Error(`MANUAL_SUMMARY_MIGRATION_${code}`);};
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const freeze=value=>{if(value&&typeof value==='object'){for(const part of Object.values(value))freeze(part);Object.freeze(value);}return value;};
const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{integer:v.toString()}:v);
const digest=value=>sha(json(value));
const fresh=(at,now)=>Number.isSafeInteger(at)&&Number.isSafeInteger(now)&&at<=now&&now-at<=300_000;

// Preserve literals and quoted identifiers. Only unquoted syntax and whitespace
// are folded. A differently spelled CHECK/default/collation is not accepted just
// because table names and columns happen to exist.
function normalizedSql(sql){
 if(sql===null)return null;
 if(typeof sql!=='string')return fail('DDL_INVALID');
 let out='',quoted=null,space=false;
 for(let i=0;i<sql.length;i++){
  const c=sql[i];
  if(quoted){out+=c;if(c===quoted){if(quoted!==']'&&sql[i+1]===quoted)out+=sql[++i];else quoted=null;}continue;}
  if(c==='-'&&sql[i+1]==='-'){while(i<sql.length&&sql[i]!=='\n')i++;space=true;continue;}
  if(c==='/'&&sql[i+1]==='*'){i+=2;while(i<sql.length&&!(sql[i]==='*'&&sql[i+1]==='/'))i++;if(i>=sql.length)return fail('DDL_INVALID');i++;space=true;continue;}
  if(/\s/.test(c)){space=true;continue;}
  if(space&&out)out+=' ';space=false;
  if(['"',"'",'`','['].includes(c)){quoted=c==='['?']':c;out+=c;}else out+=c.toLowerCase();
 }
 if(quoted)return fail('DDL_INVALID');
 return out.trim().replace(/;$/,'').replace(/^create (table|index) if not exists /,'create $1 ');
}

function validateLocalDatabase(db){
 if(!(db instanceof DatabaseSync))fail('LOCAL_SQLITE_REQUIRED');
 const databases=db.prepare('PRAGMA database_list').all();
 if(databases.some(item=>!['main','temp'].includes(item.name)))fail('ATTACHED_DATABASE_FORBIDDEN');
 if(db.prepare("SELECT count(*) n FROM sqlite_temp_master").get().n!==0)fail('TEMP_SCHEMA_FORBIDDEN');
 const location=db.location('main');
 if(location!==null&&location!==''&&location!==':memory:'){
  const rel=relative(realpathSync(tmpdir()),realpathSync(location));
  if(rel===''||rel.startsWith('..')||isAbsolute(rel))fail('TEMPORARY_DATABASE_REQUIRED');
 }
}

function source(bytes){
 const catalog=reviewedMigrationSource();
 if(!matchesReviewedMigrationSource(catalog))fail('CATALOG_UNVERIFIED');
 const entry=catalog.files.find(item=>item.name===manualSummaryMigrationName);
 if(!entry||entry.sha256!==manualSummaryMigrationSha256)fail('SOURCE_NOT_CATALOGUED');
 const selected=bytes===undefined?readFileSync(resolve(root,manualSummaryMigrationPath)):bytes;
 if(!(selected instanceof Uint8Array))fail('SOURCE_BYTES_REQUIRED');
 const buffer=Buffer.from(selected),hash=sha(buffer);
 if(![entry.sha256,entry.crlfSha256].includes(hash))fail('SOURCE_HASH_MISMATCH');
 // A separately accepted CRLF byte representation still has to be precisely
 // the reviewed LF content. Arbitrary SQL normalization never grants authority.
 if(sha(Buffer.from(buffer.toString('utf8').replaceAll('\r\n','\n')))!==manualSummaryMigrationSha256)fail('SOURCE_CANONICAL_HASH_MISMATCH');
 return {bytes:buffer,sql:buffer.toString('utf8'),sha256:hash,catalogSha256:digest(catalog)};
}

export function manualSummaryMigrationIdentity(){
 const file=source();
 return freeze({path:manualSummaryMigrationPath,sha256:file.sha256,catalogSha256:file.catalogSha256,productionExecutionSupported:false});
}

function rows(db,sql){return db.prepare(sql).all().map(row=>({...row}));}
function objects(db){return rows(db,"SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name COLLATE BINARY");}
function managed(row){
 const names=[row.name,row.tbl_name].map(value=>String(value).toLowerCase());
 return names.some(value=>value.startsWith('yta_summary_import')||value.startsWith('idx_summary_import')||value.startsWith('sqlite_autoindex_yta_summary_import'))
  || /\byta_summary_import(?:s|_requests)\b/i.test(row.sql||'');
}
function definition(db,selected){
 const tableList=rows(db,'PRAGMA main.table_list');
 return selected.map(object=>{
  const result={type:object.type,name:object.name,table:object.tbl_name,sql:normalizedSql(object.sql)};
  if(object.type==='table'){
   const details=tableList.find(row=>row.schema==='main'&&row.name===object.name);
   result.options=details?{type:details.type,ncol:details.ncol,wr:details.wr,strict:details.strict}:null;
   result.columns=rows(db,`PRAGMA main.table_xinfo(${quote(object.name)})`);
   result.foreignKeys=rows(db,`PRAGMA main.foreign_key_list(${quote(object.name)})`);
   result.indexes=rows(db,`PRAGMA main.index_list(${quote(object.name)})`).map(index=>({...index,columns:rows(db,`PRAGMA main.index_xinfo(${quote(index.name)})`)}));
  }
  if(object.type==='index')result.columns=rows(db,`PRAGMA main.index_xinfo(${quote(object.name)})`);
  return result;
 });
}
function expectedDefinition(file){
 const db=new DatabaseSync(':memory:');
 try{db.exec(file.sql);return definition(db,objects(db));}finally{db.close();}
}

function inspect(db,file){
 const expected=expectedDefinition(file),actual=definition(db,objects(db).filter(managed));
 const state=actual.length===0?'ABSENT':same(actual,expected)?'EXACT':'MISMATCH';
 return freeze({kind:'LOCAL_MANUAL_SUMMARY_SCHEMA_V1',state,verified:state==='EXACT',schemaSha256:digest(actual),expectedSchemaSha256:digest(expected),reason:state==='MISMATCH'?'IMPORT_SCHEMA_DDL_MISMATCH':null});
}

export function inspectManualSummaryImportSchema(db){
 validateLocalDatabase(db);
 return inspect(db,source());
}

// Exact SQLite text/blob bytes are hashed inside the local process. INTEGER is
// read as BigInt and REAL is encoded as IEEE-754, avoiding JSON precision loss.
// No row, transcript, summary, credential, approval or payment value is returned.
function tableFingerprint(db,name){
 const columns=rows(db,`PRAGMA main.table_xinfo(${quote(name)})`).map(row=>row.name);
 const table=rows(db,'PRAGMA main.table_list').find(row=>row.schema==='main'&&row.name===name);
 if(!table||![0,1].includes(table.wr))fail('TABLE_METADATA_MISSING');
 const rowidAlias=table.wr===0?['rowid','_rowid_','oid'].find(alias=>!columns.some(column=>column.toLowerCase()===alias)):undefined;
 if(table.wr===0&&!rowidAlias)fail('ROWID_INACCESSIBLE');
 const expressions=columns.map(quote);
 if(rowidAlias)expressions.push(quote(rowidAlias));
 const selected=expressions.map((q,i)=>{
  return `typeof(${q}) AS t${i},CASE WHEN typeof(${q}) IN ('text','blob') THEN hex(CAST(${q} AS BLOB)) ELSE ${q} END AS v${i}`;
 });
 const statement=db.prepare(`SELECT ${selected.join(',')} FROM main.${quote(name)}`);
 statement.setReadBigInts(true);
 const hashes=[];
 for(const row of statement.iterate()){
  const encoded=expressions.map((_,i)=>{
   const type=row[`t${i}`],value=row[`v${i}`];
   if(type==='null')return ['null'];
   if(type==='integer')return [type,value.toString()];
   if(type==='real'){const bytes=Buffer.alloc(8);bytes.writeDoubleBE(value);return [type,bytes.toString('hex')];}
   if(type==='text'||type==='blob')return [type,value];
   return fail('SQLITE_VALUE_UNSUPPORTED');
  });
  hashes.push(digest(encoded));
 }
 hashes.sort();
 return {name,rowCount:hashes.length,columnsSha256:digest({columns,rowidAlias:rowidAlias??null}),rowsSha256:sha(hashes.join('\n'))};
}
function snapshot(db,file,now){
 const all=objects(db),ordinary=all.filter(row=>!managed(row));
 const tables=all.filter(row=>row.type==='table').map(row=>tableFingerprint(db,row.name));
 const originalTables=tables.filter(row=>!manualSummaryImportTables.includes(row.name));
 const original={objectsSha256:digest(ordinary),tables:originalTables,userVersion:db.prepare('PRAGMA user_version').get().user_version,applicationId:db.prepare('PRAGMA application_id').get().application_id};
 const body={kind:'LOCAL_MANUAL_SUMMARY_MIGRATION_SNAPSHOT_V1',capturedAt:now,sourceSha256:file.sha256,catalogSha256:file.catalogSha256,schema:inspect(db,file),originalSha256:digest(original),tables,schemaVersion:db.prepare('PRAGMA schema_version').get().schema_version,dataVersion:db.prepare('PRAGMA data_version').get().data_version};
 return freeze({...body,snapshotSha256:digest(body)});
}
function stateDigest(before){const{capturedAt,snapshotSha256,...state}=before;return digest(state);}

export function createManualSummaryMigrationScope(){
 const file=source();
 return freeze({kind:'LOCAL_0021_SINGLE_FILE_V1',environment:'LOCAL_SQLITE',files:[{path:manualSummaryMigrationPath,sha256:file.sha256}],catalogSha256:file.catalogSha256});
}

export function createLocalManualSummaryMigrationSession({database,environment='LOCAL_SQLITE',now=Date.now}={}){
 if(environment!=='LOCAL_SQLITE')fail('PRODUCTION_EXECUTION_UNSUPPORTED');
 if(typeof now!=='function')fail('CLOCK_REQUIRED');
 validateLocalDatabase(database);
 const issued=new WeakMap();
 function captureBefore(){
  validateLocalDatabase(database);
  if(database.isTransaction)fail('NESTED_TRANSACTION_FORBIDDEN');
  const file=source();
  database.exec('BEGIN');
  try{
   const at=now();if(!Number.isSafeInteger(at))fail('CLOCK_INVALID');
   const receipt=snapshot(database,file,at);
   database.exec('COMMIT');issued.set(receipt,receipt.snapshotSha256);return receipt;
  }catch(error){if(database.isTransaction)database.exec('ROLLBACK');if(error?.message?.startsWith('MANUAL_SUMMARY_MIGRATION_'))throw error;throw Error('MANUAL_SUMMARY_MIGRATION_SNAPSHOT_FAILED');}
 }
 function apply({before,scope,sourceBytes}={}){
  validateLocalDatabase(database);
  if(database.isTransaction)fail('NESTED_TRANSACTION_FORBIDDEN');
  if(!before||issued.get(before)!==before.snapshotSha256)fail('BEFORE_SNAPSHOT_UNISSUED');
  if(!fresh(before.capturedAt,now()))fail('SNAPSHOT_STALE');
  const file=source(sourceBytes);
  const expectedScope={kind:'LOCAL_0021_SINGLE_FILE_V1',environment:'LOCAL_SQLITE',files:[{path:manualSummaryMigrationPath,sha256:file.sha256}],catalogSha256:file.catalogSha256};
  if(!same(scope,expectedScope))fail('SINGLE_FILE_SCOPE_UNVERIFIED');
  if(before.sourceSha256!==file.sha256||before.catalogSha256!==file.catalogSha256)fail('SOURCE_CHANGED');
  if(before.schema.state==='MISMATCH')fail('PRE_SCHEMA_MISMATCH');
  database.exec('BEGIN IMMEDIATE');
  let after,commitAttempted=false;
  try{
   if(!fresh(before.capturedAt,now()))fail('SNAPSHOT_STALE');
   validateLocalDatabase(database);
   const current=snapshot(database,file,now());
   if(stateDigest(current)!==stateDigest(before))fail('BEFORE_STATE_CHANGED');
   // A verified exact replay performs no SQL mutation and preserves import rows.
   if(current.schema.state==='ABSENT')database.exec(file.sql);
   const checkedSource=source(sourceBytes);
   if(checkedSource.sha256!==file.sha256||checkedSource.catalogSha256!==file.catalogSha256)fail('SOURCE_CHANGED');
   after=snapshot(database,file,now());
   if(after.schema.state!=='EXACT')fail('POST_SCHEMA_MISMATCH');
   if(after.originalSha256!==before.originalSha256)fail('ORIGINAL_DATA_CHANGED');
   const oldImportRows=before.tables.filter(row=>manualSummaryImportTables.includes(row.name));
   const newImportRows=after.tables.filter(row=>manualSummaryImportTables.includes(row.name));
   if(before.schema.state==='EXACT'&&!same(oldImportRows,newImportRows))fail('IMPORT_DATA_CHANGED');
   if(before.schema.state==='ABSENT'&&newImportRows.some(row=>row.rowCount!==0))fail('UNEXPECTED_IMPORT_DATA');
   if(!fresh(before.capturedAt,now()))fail('SNAPSHOT_STALE');
   commitAttempted=true;
   database.exec('COMMIT');
  }catch(error){
   const transactionOpen=database.isTransaction;
   if(transactionOpen)database.exec('ROLLBACK');
   // A caller must inspect a fresh connection after an uncertain commit. Do
   // not claim rollback or automatically replay an operation whose ACK was lost.
   if(commitAttempted&&!transactionOpen)fail('COMMIT_OUTCOME_UNCONFIRMED');
   if(error?.message?.startsWith('MANUAL_SUMMARY_MIGRATION_'))throw error;
   fail('ATOMIC_APPLY_FAILED');
  }
  issued.delete(before);
  return freeze({kind:'LOCAL_MANUAL_SUMMARY_MIGRATION_RESULT_V1',state:before.schema.state==='EXACT'?'ALREADY_EXACT':'APPLIED',productionExecutionSupported:false,path:manualSummaryMigrationPath,sourceSha256:file.sha256,catalogSha256:file.catalogSha256,schemaSha256:after.schema.schemaSha256,originalDataPreserved:true,beforeOriginalSha256:before.originalSha256,afterOriginalSha256:after.originalSha256,importRowsPreserved:before.schema.state==='EXACT',migrationHistoryWritten:false,after});
 }
 return Object.freeze({captureBefore,apply,productionExecutionSupported:false});
}
