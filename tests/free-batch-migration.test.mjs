import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

test('bounded batch migration adds only two tables and preserves prior schema and rows',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  for(const file of ['schema.sql','migrations/0002_live.sql','migrations/0003_observed_capacity.sql','migrations/0005_reviewed_free_recovery.sql','migrations/0006_unknown_groq_probe.sql'])db.exec(readFileSync(new URL('../'+file,import.meta.url),'utf8'));
  db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run('historical','job','groq',10,'FAILED_UNCERTAIN','2026-10-11T00:00:00.000Z');
  const before=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  db.exec(readFileSync(new URL('../migrations/0007_bounded_free_batch.sql',import.meta.url),'utf8'));
  const after=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('yta_free_batches','yta_free_batch_chunks') ORDER BY name").all();
  assert.deepEqual(after,before);
  assert.equal(db.prepare("SELECT state FROM yta_operations WHERE id='historical'").get().state,'FAILED_UNCERTAIN');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_free_batches').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_free_batch_chunks').get().n,0);
 }finally{db.close();}
});
