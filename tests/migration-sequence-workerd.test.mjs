import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {verifyFullCoverageTriggerDefinitions} from '../scripts/full-coverage-migration-preflight.mjs';

const root=new URL('../',import.meta.url),names=readdirSync(new URL('migrations/',root)).filter(n=>n.endsWith('.sql')).sort();
function statements(path){
 const text=readFileSync(new URL(path,root),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n');
 return path.includes('0016_')?[...text.matchAll(/CREATE TRIGGER[\s\S]*?END;/g)].map(m=>m[0]):text.split(';').map(x=>x.trim()).filter(Boolean);
}
const rows=async(DB,q)=>(await DB.prepare(q).all()).results;
const history=DB=>rows(DB,'SELECT name FROM d1_migrations ORDER BY name');
const shape=DB=>rows(DB,"SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");

test('actual local Workerd D1 atomically applies each 0016-0020 file with history, rolls back a late failure and reconciles committed state',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'local-migration-fixture',modules:true,script:'export default {fetch(){return new Response("local fixture only")}}',d1Databases:{DB:'local-migration-fixture'}}]}));
 try{
  const DB=await mf.getD1Database('DB');
  await DB.batch(statements('schema.sql').map(q=>DB.prepare(q)));
  await DB.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();
  for(const name of names.filter(n=>n<'0016'))await DB.batch([...statements('migrations/'+name).map(q=>DB.prepare(q)),DB.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)]);
  await DB.batch([
   DB.prepare("INSERT INTO jobs(id,owner_id,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES('fixture','owner','text','TRANSCRIPT_UNVERIFIED',60,'fixture','fixture','{\"summary\":[\"KEEP\"]}','{}')"),
   DB.prepare("INSERT INTO yta_sources VALUES('fixture','KEEP','[]','FIXTURE','fixture')"),
   DB.prepare("INSERT INTO yta_operations VALUES('uncertain','fixture','groq-summary',6600,'FAILED_UNCERTAIN','fixture','UNKNOWN','{\"receipt\":\"KEEP\"}')"),
   DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,provenance,captured_at) VALUES('used','fixture','owner','groq','LIVE_FREE_SUMMARY','tokens',2169,'FIXTURE','fixture')")
  ]);
  const evidence=async()=>Promise.all(['jobs','yta_sources','yta_operations','usage_events'].map(table=>rows(DB,'SELECT * FROM '+table)));
  const retained=(await evidence()).map((table,index)=>index?table:table.map(({submission_hash,...row})=>row));
  for(const name of names.filter(n=>n>='0016')){
   const beforeSchema=await shape(DB),beforeHistory=await history(DB);
   const unit=()=>[...statements('migrations/'+name).map(q=>DB.prepare(q)),DB.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)];
   // The last statement raises a runtime UNIQUE violation, after the DDL.
   await assert.rejects(DB.batch([...unit(),DB.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(beforeHistory[0].name)]),/UNIQUE constraint failed/);
   assert.deepEqual(await shape(DB),beforeSchema);assert.deepEqual(await history(DB),beforeHistory);
   await DB.batch(unit());
   // A client that lost this acknowledgement must read both history and schema.
   assert.deepEqual(await history(DB),[...beforeHistory,{name}]);
   assert.notDeepEqual(await shape(DB),beforeSchema,'the committed DDL must be visible together with its history row');
   assert.deepEqual((await evidence()).map((table,index)=>index?table:table.map(({submission_hash,...row})=>row)),retained);
   if(name.startsWith('0016')){
    const triggers=await rows(DB,"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'full_coverage_%'");
    assert.equal(verifyFullCoverageTriggerDefinitions(triggers).verified,true);
   }
  }
  assert.equal((await rows(DB,"SELECT * FROM pragma_table_info('yta_local_runner_audio_dispatches') WHERE name='attempt_id'")).length,1);
  assert.deepEqual(await rows(DB,'SELECT * FROM yta_local_runner_audio_attempts'),[]);
  assert.deepEqual(await rows(DB,'SELECT * FROM yta_local_runner_audio_resumes'),[]);
 }finally{await mf.dispose();}
});
