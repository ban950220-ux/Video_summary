// Offline assessment of a read-only operator snapshot. This module never connects to D1.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export const databaseId='d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34';
export const migrationName='0016_full_coverage_write_lock.sql';
const migrationSql=readFileSync(resolve(import.meta.dirname,'../migrations',migrationName),'utf8');
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

// Snapshot fields must come from a fresh read-only D1/Build inspection, not from
// this script. A pass is a review aid, not an authorization to apply a migration.
export function assessFullCoverageMigration(snapshot,{now=Date.now()}={}){
 const blocks=[];
 if(snapshot?.kind!=='FULL_COVERAGE_MIGRATION_READONLY_V1'||snapshot.databaseId!==databaseId)blocks.push('TARGET_UNVERIFIED');
 const at=isUtc(snapshot?.capturedAt)?Date.parse(snapshot.capturedAt):NaN;
 if(!Number.isFinite(at)||at>now||now-at>5*60_000)blocks.push('SNAPSHOT_STALE');
 if(!same(snapshot?.pendingMigrations,[migrationName]))blocks.push('PENDING_MIGRATIONS_UNEXPECTED');
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
export function verifyFullCoverageMigration(after){
 const actual=after?.triggers;
 if(!Array.isArray(actual)||actual.length!==triggerNames.length||!same(after?.pendingMigrations,[]))return {verified:false,reason:'POST_MIGRATION_SHAPE_UNVERIFIED'};
 const byName=new Map(actual.map(row=>[row?.name,normalizeSql(row?.sql)]));
 if(byName.size!==triggerNames.length||triggerNames.some(name=>byName.get(name)!==expectedTriggerSql[name]))return {verified:false,reason:'TRIGGER_DEFINITION_MISMATCH'};
 return {verified:true,reason:null};
}
