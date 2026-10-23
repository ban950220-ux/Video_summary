// Local review aid only. No D1/network client and no production write function.
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {reviewedMigrationSource} from './migration-source-catalog.mjs';

export const target=Object.freeze({accountId:'fe9d7e2a164274b1ff6cef150a75cb0b',databaseId:'d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34'});
export const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const schemaHashes=['fc5868b84b27df1569dc78472805f16928b733fcd7b3303e393870ad9d56f61b','efe2f265f9360a0b2ea1aeb54f9f1347a4571da2080a31cb8248bb0e1b20d32d'];
const sorted=rows=>rows.toSorted((a,b)=>`${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
// sha() emits canonical lowercase hex. Do not trim, coerce or normalize evidence.
const isSha256=value=>typeof value==='string'&&value.length===64&&/^[0-9a-f]{64}$/.test(value);

// Token comparison permits whitespace and unquoted SQL keyword case only.
// Quoted identifiers/literals, numeric values and operators retain exact tokens.
// Comments are rejected instead of normalized away. Observed SQL is never run.
export function sqlTokens(sql){
 if(sql===null)return null;
 if(typeof sql!=='string'||!sql.length)fail('SQL_DEFINITION_INVALID');
 const tokens=[];
 for(let i=0;i<sql.length;){
  if(/\s/.test(sql[i])){i++;continue;}
  if(sql.slice(i,i+2)==='--'||sql.slice(i,i+2)==='/*')fail('SQL_COMMENTS_UNSUPPORTED');
  if(/["'`\[]/.test(sql[i])){
   const start=i,open=sql[i++],close=open==='['?']':open;let ended=false;
   while(i<sql.length){if(sql[i++]!==close)continue;if(close!==']'&&sql[i]===close){i++;continue;}ended=true;break;}
   if(!ended)fail('SQL_QUOTE_UNTERMINATED');tokens.push(sql.slice(start,i));continue;
  }
  const word=sql.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/);
  if(word){tokens.push(word[0].toLowerCase());i+=word[0].length;continue;}
  const number=sql.slice(i).match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if(number){tokens.push(number[0]);i+=number[0].length;continue;}
  const op=sql.slice(i).match(/^(?:<=|>=|<>|!=|==|\|\||->>|->)/);
  if(op){tokens.push(op[0]);i+=op[0].length;continue;}
  if(/[(),.;=<>+*/%!-]/.test(sql[i])){tokens.push(sql[i++]);continue;}
  fail('SQL_TOKEN_UNSUPPORTED');
 }
 if(tokens.at(-1)===';')tokens.pop();
 return tokens;
}

export function schemaFingerprint(rows){
 if(!Array.isArray(rows))fail('SCHEMA_ROWS_REQUIRED');
 const seen=new Set();
 const records=sorted(rows).map(row=>{
  if(!row||!['table','index','trigger'].includes(row.type)||typeof row.name!=='string'||typeof row.tbl_name!=='string')fail('SCHEMA_ROW_INVALID');
  const key=`${row.type}:${row.name}`;if(seen.has(key))fail('SCHEMA_DUPLICATE_OBJECT');seen.add(key);
  if(row.sql===null&&!(row.type==='index'&&row.name.startsWith('sqlite_autoindex_')))fail('SCHEMA_NULL_SQL_INVALID');
  return [row.type,row.name,row.tbl_name,sqlTokens(row.sql)];
 });
 return sha(JSON.stringify(records));
}

export function trustedBuffers(repo){
 const catalog=reviewedMigrationSource(),base=readFileSync(join(repo,'schema.sql'));
 if(!schemaHashes.includes(sha(base)))fail('BASE_SCHEMA_SOURCE_MISMATCH');
 const entries=readdirSync(join(repo,'migrations'),{withFileTypes:true}).filter(file=>file.name.endsWith('.sql')).sort((a,b)=>a.name.localeCompare(b.name));
 if(entries.length!==catalog.files.length||entries.some((entry,index)=>!entry.isFile()||entry.name!==catalog.files[index].name))fail('MIGRATION_CATALOG_INCOMPLETE');
 const files=catalog.files.map(file=>{
  const bytes=readFileSync(join(repo,'migrations',file.name));
  if(![file.sha256,file.crlfSha256].includes(sha(bytes)))fail('MIGRATION_SOURCE_MISMATCH');
  return {...file,bytes};
 });
 return {base,files,catalog};
}

export function createExpectedSchema(repo){
 // Each exact authenticated buffer is also the buffer executed in local memory.
 const source=trustedBuffers(repo),db=new DatabaseSync(':memory:');
 try{
  db.exec(source.base.toString('utf8'));
  for(const file of source.files.filter(file=>file.name<'0016'))db.exec(file.bytes.toString('utf8'));
  const rows=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN ('jobs','usage_events') OR tbl_name GLOB 'yta_*' ORDER BY type,name").all();
  return {rows,fingerprint:schemaFingerprint(rows),catalog:source.catalog,catalogDigest:sha(JSON.stringify(source.catalog)),scope:rows.filter(row=>row.type==='table').map(row=>row.name).sort()};
 }finally{db.close();}
}

export function parseObservedMarkdown(text){
 // Parse only schema rows from the two explicitly labeled result blocks.
 const blocks=[['## Prior 02_schema result: all 32 rows',32],['## Additional metadata SELECT 1: all 18 rows',18]];
 const collected=new Map();let repeated=0;
 for(const [heading,count] of blocks){
  const start=text.indexOf(heading);if(start<0)fail('OBSERVATION_BLOCK_MISSING');
  const end=text.indexOf('\n## ',start+heading.length),part=text.slice(start,end<0?undefined:end);
  const rows=part.split(/\r?\n/).filter(line=>/^(table|index|trigger) \| /.test(line)).map(line=>{
   const match=line.match(/^(table|index|trigger) \| ([a-zA-Z_0-9]+) \| ([a-zA-Z_0-9]+) \| (.+)$/);
   if(!match)fail('OBSERVATION_ROW_INVALID');
   return {type:match[1],name:match[2],tbl_name:match[3],sql:match[4]==='<null>'?null:match[4]};
  });
  if(rows.length!==count)fail('OBSERVATION_ROW_COUNT_MISMATCH');
  const local=new Set();
  for(const row of rows){
   const key=`${row.type}:${row.name}`;if(local.has(key))fail('OBSERVATION_DUPLICATE_WITHIN_QUERY');local.add(key);
   if(collected.has(key)){
    if(schemaFingerprint([row])!==schemaFingerprint([collected.get(key)]))fail('OBSERVATION_CHANGED_BETWEEN_READS');
    repeated++;
   }else collected.set(key,row);
  }
 }
 return {rows:sorted([...collected.values()]),repeated,queryRowCounts:[32,18]};
}

export function compareManagedSchema(actual,expected){
 const expectedByKey=new Map(expected.rows.map(row=>[`${row.type}:${row.name}`,row]));
 const actualByKey=new Map(actual.map(row=>[`${row.type}:${row.name}`,row]));
 const mismatches=[];
 for(const [key,row] of expectedByKey){
  const observed=actualByKey.get(key);
  if(!observed)mismatches.push({object:key,reason:'MISSING'});
  else if(schemaFingerprint([row])!==schemaFingerprint([observed]))mismatches.push({object:key,reason:'DEFINITION_CHANGED'});
 }
 for(const key of actualByKey.keys())if(!expectedByKey.has(key))mismatches.push({object:key,reason:'UNEXPECTED'});
 const fingerprint=schemaFingerprint(actual);
 return {matches:mismatches.length===0&&fingerprint===expected.fingerprint,fingerprint,expectedFingerprint:expected.fingerprint,mismatches};
}

// A FUTURE adoption review contract, not accepted by current deployment guards.
// Hashes bind supplied evidence; they do not authenticate remote truth or approval.
export function assessAdoptionReview({observation,expected,review,controls},{now=Date.now()}={}){
 const blocks=[],fresh=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now&&now-Date.parse(value)<=300000;
 const observationDigest=observation.digest,reviewDigest=review?.observationDigest;
 const observationDigestValid=Object.hasOwn(observation,'digest')&&isSha256(observationDigest);
 const digestBound=observationDigestValid&&Object.hasOwn(review??{},'observationDigest')&&isSha256(reviewDigest)&&reviewDigest===observationDigest;
 if(!observationDigestValid)blocks.push('OBSERVATION_DIGEST_INVALID');
 const comparison=compareManagedSchema(observation.rows,expected);
 if(!comparison.matches)blocks.push('MANAGED_SCHEMA_MISMATCH');
 if(observation.accountId!==target.accountId||observation.databaseId!==target.databaseId)blocks.push('TARGET_MISMATCH');
 if(!fresh(observation.startedAt)||!fresh(observation.completedAt)||Date.parse(observation.completedAt)<Date.parse(observation.startedAt))blocks.push('SCHEMA_OBSERVATION_STALE');
 if(review?.kind!=='EXISTING_MANAGED_SCHEMA_ADOPTION_REVIEW_V1'||review?.accountId!==target.accountId||review?.databaseId!==target.databaseId||review?.historyClaim!=='UNKNOWN_NO_HISTORICAL_APPLIED_ROWS'||review?.schemaFingerprint!==comparison.fingerprint||!digestBound||review?.catalogDigest!==expected.catalogDigest||!fresh(review?.reviewedAt)||Date.parse(review.reviewedAt)<Date.parse(observation.completedAt))blocks.push('INDEPENDENT_REVIEW_UNVERIFIED');
 if(controls?.accountId!==target.accountId||controls?.databaseId!==target.databaseId||controls?.schemaFingerprint!==comparison.fingerprint||controls?.writersQuiesced!==true||controls?.relevantDispatchPaused!==true||controls?.productionBuildsDisabled!==true||controls?.previewBuildsDisabled!==true||controls?.runningOrQueuedBuildCount!==0||controls?.unsettledRelevantOperationCount!==0||!fresh(controls?.capturedAt)||Date.parse(controls.capturedAt)<Date.parse(observation.completedAt))blocks.push('CHANGE_WINDOW_UNVERIFIED');
 if(typeof controls?.timeTravel?.bookmark!=='string'||!controls.timeTravel.bookmark||controls.timeTravel.databaseId!==target.databaseId||!fresh(controls.timeTravel.capturedAt))blocks.push('RESTORE_POINT_UNVERIFIED');
 if(controls?.commandsAndProtectedEvidenceReviewed!==true)blocks.push('DEPLOYMENT_EVIDENCE_UNVERIFIED');
 if(controls?.scope!=='BASELINE_RECORD_ONLY_NO_MIGRATION_EXECUTION')blocks.push('EXECUTION_SCOPE_INVALID');
 return {readyForIndependentOperatorReview:blocks.length===0,blocks,comparison,productionExecutionSupported:false,createsHistoricalAppliedRows:false};
}
