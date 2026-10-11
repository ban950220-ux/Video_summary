import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

test('live migration adds four tables without changing existing base rows',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
    db.prepare("INSERT INTO jobs(id,owner_id,source_type,status,duration_seconds,created_at,updated_at) VALUES('existing','owner','text','PARTIAL',60,'t','t')").run();
    const before=db.prepare("SELECT * FROM jobs WHERE id='existing'").get();
    const migration=readFileSync(new URL('../migrations/0002_live.sql',import.meta.url),'utf8');
    db.exec(migration);
    db.exec(migration);
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'yta_%' ORDER BY name").all().map(row=>row.name);
    assert.deepEqual(tables,['yta_audio','yta_operations','yta_quota','yta_sources']);
    assert.deepEqual(db.prepare("SELECT * FROM jobs WHERE id='existing'").get(),before);
  }finally{db.close();}
});
