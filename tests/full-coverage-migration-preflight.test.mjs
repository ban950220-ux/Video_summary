import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {assessFullCoverageMigration,verifyFullCoverageTriggerDefinitions,migrationName,triggerNames,expectedTriggerSql} from '../scripts/full-coverage-migration-preflight.mjs';
import {migrationBefore as snapshot} from './fixtures/migration-review-snapshot.mjs';

test('offline migration review requires the full pinned queue, single-file scope and eleven absent triggers',()=>{
 assert.equal(triggerNames.length,11);
 assert.equal(assessFullCoverageMigration(snapshot()).readyForOperatorReview,true);
 const extra=snapshot();extra.pendingMigrations.unshift('0015_gemini_two_pass.sql');
 assert.deepEqual(assessFullCoverageMigration(extra).blocks,['PENDING_MIGRATIONS_UNEXPECTED']);
 const partial=snapshot();partial.managedTriggerNames=[triggerNames[0]];
 assert.deepEqual(assessFullCoverageMigration(partial).blocks,['MANAGED_TRIGGERS_PRESENT']);
});
test('offline migration review fails closed on live work, missing backup, stale evidence and wrong D1',()=>{
 const live=snapshot();live.unsettledRelevantOperationCount=1;live.runningOrQueuedBuildCount=1;live.fullCoverageDispatchDisabled=false;live.productionBuildsDisabled=false;live.timeTravel.bookmark='';
 assert.deepEqual(assessFullCoverageMigration(live).blocks,['OPERATIONS_IN_FLIGHT','BUILDS_NOT_QUIET','DISPATCH_NOT_PAUSED','BACKUP_BOOKMARK_UNVERIFIED']);
 const stale=snapshot();stale.databaseId='different';stale.capturedAt=new Date(Date.now()-6*60_000).toISOString();
 assert.deepEqual(assessFullCoverageMigration(stale).blocks,['TARGET_UNVERIFIED','SNAPSHOT_STALE']);
 assert.equal(assessFullCoverageMigration({}).readyForOperatorReview,false);
});
test('post-migration review compares all eleven installed SQL definitions, not names alone',()=>{
 const installed={pendingMigrations:[],triggers:triggerNames.map(name=>({name,sql:expectedTriggerSql[name]}))};
 assert.equal(verifyFullCoverageTriggerDefinitions(installed.triggers).verified,true);
 const wrong=structuredClone(installed);wrong.triggers[0].sql+=' AND 1=1';
 assert.deepEqual(verifyFullCoverageTriggerDefinitions(wrong.triggers),{verified:false,reason:'TRIGGER_DEFINITION_MISMATCH'});
 const providerChanged=structuredClone(installed);providerChanged.triggers[0].sql=providerChanged.triggers[0].sql.replace("'groq-full-coverage'","'GROQ-FULL-COVERAGE'");
 assert.deepEqual(verifyFullCoverageTriggerDefinitions(providerChanged.triggers),{verified:false,reason:'TRIGGER_DEFINITION_MISMATCH'});
 const stateChanged=structuredClone(installed);stateChanged.triggers[0].sql=stateChanged.triggers[0].sql.replace("'CLAIMED'","'claimed'");
 assert.deepEqual(verifyFullCoverageTriggerDefinitions(stateChanged.triggers),{verified:false,reason:'TRIGGER_DEFINITION_MISMATCH'});
 const literalSpaceChanged=structuredClone(installed);literalSpaceChanged.triggers[0].sql=literalSpaceChanged.triggers[0].sql.replace("'CLAIMED'","'CLA  IMED'");
 assert.deepEqual(verifyFullCoverageTriggerDefinitions(literalSpaceChanged.triggers),{verified:false,reason:'TRIGGER_DEFINITION_MISMATCH'});
 const formatting=structuredClone(installed);formatting.triggers[0].sql=formatting.triggers[0].sql.replace('create trigger','CREATE   TRIGGER');
 assert.equal(verifyFullCoverageTriggerDefinitions(formatting.triggers).verified,true);
 const missing=structuredClone(installed);missing.triggers.pop();
 assert.equal(verifyFullCoverageTriggerDefinitions(missing.triggers).verified,false);
});
test('reviewed SQL definitions match sqlite_master after local trigger migration',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE jobs(id TEXT,audit_json TEXT,report_json TEXT,duration_seconds REAL,source_type TEXT); CREATE TABLE yta_sources(job_id TEXT); CREATE TABLE yta_operations(job_id TEXT,provider TEXT,state TEXT); CREATE TABLE usage_events(job_id TEXT,provider TEXT,capability TEXT)');
  db.exec(readFileSync(resolve(import.meta.dirname,'../migrations',migrationName),'utf8'));
  const rows=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'full_coverage_%' ORDER BY name").all();
  assert.deepEqual(verifyFullCoverageTriggerDefinitions(rows),{verified:true,reason:null});
 }finally{db.close();}
});
