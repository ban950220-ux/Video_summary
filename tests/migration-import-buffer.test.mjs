import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {migrationBefore,migrationAfter} from './fixtures/migration-review-snapshot.mjs';

function fixture(){
 const folder=fs.mkdtempSync(join(tmpdir(),'migration-import-buffer-'));
 fs.mkdirSync(join(folder,'scripts'));fs.mkdirSync(join(folder,'migrations'));
 for(const name of ['full-coverage-migration-preflight.mjs','migration-source-catalog.mjs','schema-baseline-registration.mjs','schema-baseline-review.mjs'])fs.copyFileSync(new URL('../scripts/'+name,import.meta.url),join(folder,'scripts',name));
 fs.copyFileSync(new URL('../schema.sql',import.meta.url),join(folder,'schema.sql'));
 for(const name of fs.readdirSync(new URL('../migrations/',import.meta.url)))if(name.endsWith('.sql'))fs.copyFileSync(new URL('../migrations/'+name,import.meta.url),join(folder,'migrations',name));
 const target=join(folder,'migrations','0016_full_coverage_write_lock.sql');
 return {folder,target,url:pathToFileURL(join(folder,'scripts','full-coverage-migration-preflight.mjs')).href};
}
function cleanup(folder){const full=resolve(folder),tail=relative(resolve(tmpdir()),full);if(!tail||tail.startsWith('..')||isAbsolute(tail)||!tail.startsWith('migration-import-buffer-'))throw Error('CLEANUP_SCOPE_INVALID');fs.rmSync(full,{recursive:true,force:true});}
function installed(sql){
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE jobs(id TEXT,audit_json TEXT,report_json TEXT,duration_seconds REAL,source_type TEXT); CREATE TABLE yta_sources(job_id TEXT,raw TEXT); CREATE TABLE yta_operations(job_id TEXT,provider TEXT,state TEXT); CREATE TABLE usage_events(job_id TEXT,provider TEXT,capability TEXT)');
  db.exec(sql);
  db.exec("INSERT INTO yta_sources VALUES('fixture','ORIGINAL'); INSERT INTO yta_operations VALUES('fixture','groq-full-coverage','CLAIMED')");
  let error=null;try{db.exec("UPDATE yta_sources SET raw='CHANGED' WHERE job_id='fixture'");}catch(e){error=e.message;}
  return {triggers:db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),error,raw:db.prepare("SELECT raw FROM yta_sources WHERE job_id='fixture'").get().raw};
 }finally{db.close();}
}

test('P2: altered import then trusted-file restoration cannot authenticate cached triggers (LF and CRLF)',async()=>{
 for(const eol of ['\n','\r\n']){
  const f=fixture();
  try{
   const trusted=fs.readFileSync(f.target,'utf8').replaceAll('\r\n','\n').replaceAll('\n',eol);
   const altered=trusted.replaceAll("'groq-full-coverage'","'GROQ-FULL-COVERAGE'");
   const unsafe=installed(altered),safe=installed(trusted);
   assert.equal(unsafe.triggers.length,11);assert.equal(unsafe.error,null);assert.equal(unsafe.raw,'CHANGED');
   assert.equal(safe.error,'FULL_COVERAGE_SOURCE_LOCKED');assert.equal(safe.raw,'ORIGINAL');
   fs.writeFileSync(f.target,altered);
   let untrusted,error;try{untrusted=await import(f.url);}catch(e){error=e;}
   fs.writeFileSync(f.target,trusted);
   const b=migrationBefore(),a=migrationAfter(b);a.triggers=unsafe.triggers;
   // This assertion fails on frozen v2: current hashes pass but cached altered
   // definitions are accepted even though their actual SQLite lock is ineffective.
   assert.equal(untrusted?.verifyFullCoverageMigration(a,{before:b}).verified??false,false,'restored trusted bytes must not bless import-time altered expectations');
   assert.equal(untrusted===undefined,true);assert.equal(error?.message,'FULL_COVERAGE_MIGRATION_SOURCE_INVALID');
   const clean=await import(f.url+'?trusted-restoration');
   assert.equal(clean.assessFullCoverageMigration(b).readyForOperatorReview,true);
   assert.equal(clean.verifyFullCoverageMigration(a,{before:b}).verified,false);
   a.triggers=safe.triggers;assert.equal(clean.verifyFullCoverageMigration(a,{before:b}).verified,true);
  }finally{cleanup(f.folder);}
 }
});

test('the exact buffer returned to the parser is authenticated even if disk is restored during its read',async()=>{
 const f=fixture(),read=fs.readFileSync;
 try{
  const trusted=read(f.target),altered=Buffer.from(trusted.toString('utf8').replaceAll("'groq-full-coverage'","'GROQ-FULL-COVERAGE'"));
  fs.writeFileSync(f.target,altered);let reads=0,error,loaded;
  fs.readFileSync=function(path,options){
   if(typeof path==='string'&&resolve(path)===resolve(f.target)&&reads++===0){
    fs.writeFileSync(f.target,trusted);
    return typeof options==='string'?altered.toString(options):Buffer.from(altered);
   }
   return read.apply(this,arguments);
  };
  syncBuiltinESMExports();
  try{loaded=await import(f.url);}catch(e){error=e;}
  finally{fs.readFileSync=read;syncBuiltinESMExports();}
  assert.deepEqual(read(f.target),trusted);
  assert.equal(loaded===undefined,true);assert.equal(error?.message,'FULL_COVERAGE_MIGRATION_SOURCE_INVALID');
  assert.equal(reads,1,'hashing must not re-read a different file buffer');
 }finally{fs.readFileSync=read;syncBuiltinESMExports();cleanup(f.folder);}
});
