import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,copyFileSync,mkdirSync,mkdtempSync,readdirSync,rmSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {assessFullCoverageMigration,verifyFullCoverageMigration} from '../scripts/full-coverage-migration-preflight.mjs';
import {reviewedMigrationSource} from '../scripts/migration-source-catalog.mjs';
import {migrationBefore,migrationAfter} from './fixtures/migration-review-snapshot.mjs';

test('fixed commit/tree/catalog metadata is required, cannot omit a tail or replace a same-name hash',()=>{
 const catalog=reviewedMigrationSource();assert.equal(catalog.sourceCommit,'043ba56ee716f044698a6de66f079a7c7bae8753');
 assert.equal(catalog.sourceTree,'4e5eeda2d4781719af3e543d5eeaef62de342df0');assert.equal(catalog.files.length,14);
 for(const mutate of [s=>s.sourceCommit='0'.repeat(40),s=>s.sourceTree='0'.repeat(40),s=>s.files.pop(),s=>s.files.reverse(),s=>s.files.push(s.files.at(-1)),s=>s.files[10].sha256='0'.repeat(64),s=>s.files[10].crlfSha256='0'.repeat(64)]){
  const b=migrationBefore();mutate(b.repositorySource);
  assert.ok(assessFullCoverageMigration(b).blocks.includes('MIGRATION_SOURCE_UNVERIFIED'));
  assert.equal(verifyFullCoverageMigration(migrationAfter(b),{before:b}).verified,false);
  const valid=migrationBefore(),a=migrationAfter(valid);mutate(a.repositorySource);
  assert.deepEqual(verifyFullCoverageMigration(a,{before:valid}),{verified:false,reason:'MIGRATION_SOURCE_UNVERIFIED'});
 }
 catalog.files.pop();assert.equal(reviewedMigrationSource().files.length,14,'callers receive a copy, not the validator trust anchor');
 const legacy=migrationBefore();legacy.kind='FULL_COVERAGE_MIGRATION_READONLY_V1';legacy.pendingMigrations=legacy.pendingMigrations.slice(0,1);delete legacy.executionScope;delete legacy.repositorySource;
 assert.equal(assessFullCoverageMigration(legacy).readyForOperatorReview,false);
 assert.deepEqual(verifyFullCoverageMigration({pendingMigrations:[],triggers:migrationAfter(migrationBefore()).triggers}),{verified:false,reason:'BEFORE_SNAPSHOT_REQUIRED'});
});

test('physical same-name SQL changes, extra/missing files and changes after initial assessment fail without executing SQL',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'migration-catalog-fixture-'));
 try{
  mkdirSync(join(folder,'scripts'));mkdirSync(join(folder,'migrations'));
  for(const name of ['full-coverage-migration-preflight.mjs','migration-source-catalog.mjs'])copyFileSync(new URL('../scripts/'+name,import.meta.url),join(folder,'scripts',name));
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)))if(name.endsWith('.sql'))copyFileSync(new URL('../migrations/'+name,import.meta.url),join(folder,'migrations',name));
  const local=await import(pathToFileURL(join(folder,'scripts/full-coverage-migration-preflight.mjs')));
  const b=migrationBefore(),a=migrationAfter(b);assert.equal(local.assessFullCoverageMigration(b).readyForOperatorReview,true);
  for(const file of b.repositorySource.files){
   const path=join(folder,'migrations',file.name),original=readFileSync(path);
   const changed=Buffer.concat([original,Buffer.from('\nSELECT 12345; -- inert fixture, never executed\n')]);writeFileSync(path,changed);
   assert.ok(local.assessFullCoverageMigration(b).blocks.includes('MIGRATION_SOURCE_UNVERIFIED'),file.name);
   assert.equal(local.verifyFullCoverageMigration(a,{before:b}).verified,false,file.name+' after-import change');
   const rewritten=structuredClone(b);rewritten.repositorySource.files.find(x=>x.name===file.name).sha256=createHash('sha256').update(changed).digest('hex');
   if(file.name.startsWith('0016'))rewritten.executionScope.files[0].sha256=rewritten.repositorySource.files.find(x=>x.name===file.name).sha256;
   assert.equal(local.assessFullCoverageMigration(rewritten).readyForOperatorReview,false,'self-updated hash is not a reviewed catalog');
   writeFileSync(path,original);
  }
  const extra=join(folder,'migrations','0021_unreviewed.sql');writeFileSync(extra,'SELECT 1;');
  assert.equal(local.assessFullCoverageMigration(b).readyForOperatorReview,false);rmSync(extra);
  const last=join(folder,'migrations','0020_local_runner_blocked_resume.sql');renameSync(last,last+'.missing');
  assert.equal(local.assessFullCoverageMigration(b).readyForOperatorReview,false);renameSync(last+'.missing',last);
  assert.equal(local.verifyFullCoverageMigration(a,{before:b}).verified,true);
  for(const file of b.repositorySource.files){
   const path=join(folder,'migrations',file.name);
   writeFileSync(path,readFileSync(path,'utf8').replaceAll('\r\n','\n').replaceAll('\n','\r\n'));
  }
  const crlf=migrationBefore();crlf.executionScope.files[0].sha256=crlf.repositorySource.files.find(file=>file.name.startsWith('0016_')).crlfSha256;
  assert.equal(local.assessFullCoverageMigration(crlf).readyForOperatorReview,true,'only the separately pinned exact CRLF bytes are accepted');
  assert.equal(local.verifyFullCoverageMigration(migrationAfter(crlf),{before:crlf}).verified,true);
  const switched=migrationAfter(crlf);switched.executionScope.files[0].sha256=b.executionScope.files[0].sha256;
  assert.equal(local.verifyFullCoverageMigration(switched,{before:crlf}).verified,false,'isolated SQL bytes cannot change across the stage');
  const target=join(folder,'migrations','0016_full_coverage_write_lock.sql');
  writeFileSync(target,readFileSync(target,'utf8').replace("'groq-full-coverage'","'GROQ-FULL-COVERAGE'"));
  assert.equal(local.assessFullCoverageMigration(crlf).readyForOperatorReview,false,'no semantic SQL normalization');
 }finally{rmSync(folder,{recursive:true,force:true});}
});
