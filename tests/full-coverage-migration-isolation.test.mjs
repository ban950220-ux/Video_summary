import test from 'node:test';
import assert from 'node:assert/strict';
import {assessFullCoverageMigration,verifyFullCoverageMigration,migrationName} from '../scripts/full-coverage-migration-preflight.mjs';
import {migrationBefore as before,migrationAfter as after} from './fixtures/migration-review-snapshot.mjs';

const previous=before().appliedMigrations,later=before().pendingMigrations.slice(1),hash=before().executionScope.files[0].sha256;

test('0016 allows a separately verified single-file scope while the full 0017-0020 queue remains unchanged',()=>{
 const b=before();
 assert.equal(assessFullCoverageMigration(b).readyForOperatorReview,true);
 assert.equal(verifyFullCoverageMigration(after(b),{before:b}).verified,true);
});
test('P2: all four PR29 tail omissions block both before and derived after observations',()=>{
 for(let n=0;n<later.length;n++){
  const truncated=before();truncated.pendingMigrations=[migrationName,...later.slice(0,n)];
  assert.ok(assessFullCoverageMigration(truncated).blocks.includes('PENDING_MIGRATIONS_UNEXPECTED'));
  assert.equal(verifyFullCoverageMigration(after(truncated),{before:truncated}).verified,false);
  const withoutScope=structuredClone(truncated);delete withoutScope.executionScope;
  assert.equal(assessFullCoverageMigration(withoutScope).readyForOperatorReview,false);
 }
});
test('ordinary bulk apply and incomplete, unknown, reordered or duplicate pending queues still block',()=>{
 const bulk=before();delete bulk.executionScope;
 assert.ok(assessFullCoverageMigration(bulk).blocks.includes('SINGLE_MIGRATION_SCOPE_UNVERIFIED'));
 for(const queue of [[previous.at(-1),migrationName,...later],[migrationName,later[1]],[migrationName,...later,'0021_unknown.sql'],[migrationName,...later].reverse(),[migrationName,later[0],later[0]]]){
  const b=before();b.pendingMigrations=queue;assert.equal(assessFullCoverageMigration(b).readyForOperatorReview,false);
 }
});
test('isolated apply binds exact target, history table, SQL bytes, files and prerequisite history',()=>{
 for(const mutate of [b=>b.executionScope.databaseId='other',b=>b.executionScope.migrationsTable='fake_history',b=>b.executionScope.files[0].sha256='0'.repeat(64),b=>b.executionScope.files.push({name:later[0],sha256:hash}),b=>b.executionScope.pendingMigrations.push(later[0]),b=>b.appliedMigrations.pop(),b=>b.managedTriggerNames=['full_coverage_job_delete_lock'],b=>b.unsettledRelevantOperationCount=1,b=>b.timeTravel.bookmark='']){
  const b=before();mutate(b);assert.equal(assessFullCoverageMigration(b).readyForOperatorReview,false);
 }
});
test('0016 postcheck is tied to the reviewed before snapshot and preserves every deferred history item',()=>{
 const b=before();
 assert.equal(verifyFullCoverageMigration(after(b)).verified,false,'postcheck requires the pinned before snapshot');
 for(const mutate of [a=>a.pendingMigrations.shift(),a=>a.pendingMigrations.push('0021_unknown.sql'),a=>a.appliedMigrations.push(later[0]),a=>a.executionScope.pendingMigrations.push(migrationName),a=>a.executionScope.files[0].sha256='0'.repeat(64),a=>a.databaseId='wrong',a=>a.capturedAt='2000-01-01T00:00:00.000Z',a=>a.triggers[0].sql=a.triggers[0].sql.replace("'groq-full-coverage'","'GROQ-FULL-COVERAGE'")]){
  const a=after(b);mutate(a);assert.equal(verifyFullCoverageMigration(a,{before:b}).verified,false);
 }
 const invalid=before();invalid.unsettledRelevantOperationCount=1;
 assert.equal(verifyFullCoverageMigration(after(invalid),{before:invalid}).verified,false);
});
