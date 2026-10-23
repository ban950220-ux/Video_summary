// Offline assessment of a read-only operator snapshot. This module never connects to D1.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {reviewedMigrationSource,matchesReviewedMigrationSource} from './migration-source-catalog.mjs';
import {validBaselineReadback} from './schema-baseline-registration.mjs';

export const databaseId='d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34';
export const migrationName='0016_full_coverage_write_lock.sql';
// Authenticate the SAME buffer used to derive expectations. A later file hash
// cannot authenticate SQL that was read before the file was restored or changed.
const migrationBytes=readFileSync(resolve(import.meta.dirname,'../migrations',migrationName));
const reviewedMigration=reviewedMigrationSource().files.find(file=>file.name===migrationName);
const importHash=createHash('sha256').update(migrationBytes).digest('hex');
if(!reviewedMigration||![reviewedMigration.sha256,reviewedMigration.crlfSha256].includes(importHash))throw Error('FULL_COVERAGE_MIGRATION_SOURCE_INVALID');
const migrationSql=migrationBytes.toString('utf8');
const statements=[...migrationSql.matchAll(/^CREATE TRIGGER IF NOT EXISTS (full_coverage_[a-z_]+) [\s\S]*?END;/gm)];
export const triggerNames=statements.map(match=>match[1]).sort();
// SQLite drops IF NOT EXISTS from sqlite_master.sql. Fold only unquoted SQL
// syntax: literals (including their case and whitespace) are evidence.
const normalizeSql=value=>{
 if(typeof value!=='string')return null;
 let out='',quote=null,pendingSpace=false;
 for(let i=0;i<value.length;i++){
  const char=value[i];
  if(quote){
   out+=char;
   if(char===quote){
    if(quote!==']'&&value[i+1]===quote)out+=value[++i];
    else quote=null;
   }
   continue;
  }
  if(/\s/.test(char)){pendingSpace=true;continue;}
  if(pendingSpace&&out)out+=' ';
  pendingSpace=false;
  out+=['"',"'",'`','['].includes(char)?char:char.toLowerCase();
  if(char==='[')quote=']';
  else if(['"',"'",'`'].includes(char))quote=char;
 }
 if(quote)return null;
 return out.trim().replace(/;$/,'').replace(/^create trigger(?: if not exists)? /,'create trigger ');
};
export const expectedTriggerSql=Object.fromEntries(statements.map(match=>[match[1],normalizeSql(match[0])]));
if(triggerNames.length!==11||new Set(triggerNames).size!==11)throw Error('FULL_COVERAGE_MIGRATION_SOURCE_INVALID');

const isUtc=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value));
const nonEmpty=value=>typeof value==='string'&&value.length>0;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const requiredTables=['jobs','usage_events','yta_operations','yta_sources'];
const source=reviewedMigrationSource(),migrationIndex=source.files.findIndex(file=>file.name===migrationName);
const prerequisiteMigrations=source.files.slice(0,migrationIndex).map(file=>file.name);
const deferredMigrations=source.files.slice(migrationIndex+1).map(file=>file.name);
const migrationHashes=[source.files[migrationIndex].sha256,source.files[migrationIndex].crlfSha256];
const fresh=(value,now)=>isUtc(value)&&Date.parse(value)<=now&&now-Date.parse(value)<=5*60_000;
// Explicit single-file tooling scope, separately observed from the FULL repo
// pending list. This never filters or rewrites the supplied remote observation.
// Installed Wrangler applies EVERY pending file in its configured directory.
function singleFileScope(scope,pending){
 return scope?.kind==='SINGLE_MIGRATION_DIRECTORY_V1'&&scope.databaseId===databaseId
  &&scope.migrationsTable==='d1_migrations'
  &&Array.isArray(scope.files)&&scope.files.length===1
  &&migrationHashes.some(sha256=>same(scope.files,[{name:migrationName,sha256}]))
  &&same(scope.pendingMigrations,pending);
}

// Snapshot fields must come from a fresh read-only D1/Build inspection, not from
// this script. A pass is a review aid, not an authorization to apply a migration.
export function assessFullCoverageMigration(snapshot,{now=Date.now()}={}){
 const blocks=[];
 const adopted=snapshot?.schemaBaseline!==undefined;
 const adoptionVerified=adopted&&validBaselineReadback(snapshot.schemaBaseline,{now});
 if(snapshot?.kind!=='FULL_COVERAGE_MIGRATION_READONLY_V2'||snapshot.databaseId!==databaseId)blocks.push('TARGET_UNVERIFIED');
 const at=isUtc(snapshot?.capturedAt)?Date.parse(snapshot.capturedAt):NaN;
 if(!Number.isFinite(at)||at>now||now-at>5*60_000)blocks.push('SNAPSHOT_STALE');
 if(!matchesReviewedMigrationSource(snapshot?.repositorySource))blocks.push('MIGRATION_SOURCE_UNVERIFIED');
 // Adoption never invents the historical nine rows: a full-repository listing
 // still reports those files pending. Only the isolated 0016 directory may run.
 const expectedPending=adopted?source.files.map(file=>file.name):[migrationName,...deferredMigrations];
 if(!same(snapshot?.pendingMigrations,expectedPending))blocks.push('PENDING_MIGRATIONS_UNEXPECTED');
 if(!singleFileScope(snapshot?.executionScope,[migrationName]))blocks.push('SINGLE_MIGRATION_SCOPE_UNVERIFIED');
 if(adopted){
  if(!adoptionVerified)blocks.push('SCHEMA_BASELINE_UNVERIFIED');
  if(!same(snapshot?.appliedMigrations,[])||!['ABSENT','PRESENT_EMPTY'].includes(snapshot?.migrationHistoryTable))blocks.push('MIGRATION_HISTORY_UNVERIFIED');
 }else if(!same(snapshot?.appliedMigrations,prerequisiteMigrations))blocks.push('MIGRATION_HISTORY_UNVERIFIED');
 if(!same(snapshot?.managedTriggerNames,[]))blocks.push('MANAGED_TRIGGERS_PRESENT');
 if(!Array.isArray(snapshot?.presentTables)||!requiredTables.every(table=>snapshot.presentTables.includes(table)))blocks.push('TABLES_MISSING');
 if(snapshot?.unsettledRelevantOperationCount!==0)blocks.push('OPERATIONS_IN_FLIGHT');
 if(snapshot?.runningOrQueuedBuildCount!==0||snapshot?.productionBuildsDisabled!==true)blocks.push('BUILDS_NOT_QUIET');
 if(snapshot?.fullCoverageDispatchDisabled!==true||snapshot?.synthesisDispatchDisabled!==true)blocks.push('DISPATCH_NOT_PAUSED');
 const backupAt=isUtc(snapshot?.timeTravel?.capturedAt)?Date.parse(snapshot.timeTravel.capturedAt):NaN;
 if(!nonEmpty(snapshot?.timeTravel?.bookmark)||!Number.isFinite(backupAt)||backupAt>now||now-backupAt>5*60_000)blocks.push('BACKUP_BOOKMARK_UNVERIFIED');
 return {readyForOperatorReview:blocks.length===0,blocks,expectedMigration:migrationName,expectedTriggerNames:triggerNames};
}

// Review the D1 sqlite_master SQL after apply. Names alone cannot prove the
// installed triggers match the reviewed migration, especially with IF NOT EXISTS.
export function verifyFullCoverageMigration(after,{before,now=Date.now()}={}){
 if(!before)return {verified:false,reason:'BEFORE_SNAPSHOT_REQUIRED'};
 if(!assessFullCoverageMigration(before,{now}).readyForOperatorReview)return {verified:false,reason:'BEFORE_SNAPSHOT_UNVERIFIED'};
 // Re-read ALL source bytes after the operation as well. Same filenames do not
 // establish unchanged SQL, even though only 0016 may run in this stage.
 if(!matchesReviewedMigrationSource(after?.repositorySource))return {verified:false,reason:'MIGRATION_SOURCE_UNVERIFIED'};
 const adopted=before.schemaBaseline!==undefined;
 if(adopted&&(!validBaselineReadback(after?.schemaBaseline,{now,phase:'after'})||!same(after.schemaBaseline.row,before.schemaBaseline.row)||after.migrationHistoryTable!=='PRESENT'))return {verified:false,reason:'SCHEMA_BASELINE_POSTCHECK_UNVERIFIED'};
 if(after?.databaseId!==databaseId||!fresh(after?.capturedAt,now)||Date.parse(after.capturedAt)<Date.parse(before.capturedAt)
  ||!singleFileScope(after?.executionScope,[])||!same(after.executionScope.files,before.executionScope.files)
  ||!same(after?.appliedMigrations,adopted?[migrationName]:[...prerequisiteMigrations,migrationName]))return {verified:false,reason:'POST_MIGRATION_SCOPE_UNVERIFIED'};
 const pendingAfter=adopted?source.files.filter(file=>file.name!==migrationName).map(file=>file.name):deferredMigrations;
 if(!same(after?.pendingMigrations,pendingAfter))return {verified:false,reason:'POST_MIGRATION_SHAPE_UNVERIFIED'};
 return verifyFullCoverageTriggerDefinitions(after?.triggers);
}

// Schema comparison only. This does not assess a queue, execution scope, backup,
// authorization or migration completion. Production postcheck is the function above.
export function verifyFullCoverageTriggerDefinitions(actual){
 if(!Array.isArray(actual)||actual.length!==triggerNames.length)return {verified:false,reason:'POST_MIGRATION_SHAPE_UNVERIFIED'};
 const byName=new Map(actual.map(row=>[row?.name,normalizeSql(row?.sql)]));
 if(byName.size!==triggerNames.length||triggerNames.some(name=>byName.get(name)!==expectedTriggerSql[name]))return {verified:false,reason:'TRIGGER_DEFINITION_MISMATCH'};
 return {verified:true,reason:null};
}
