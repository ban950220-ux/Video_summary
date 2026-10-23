import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createBaselineOperatorSession} from '../scripts/baseline-operator-session.mjs';
import {target,sha} from '../scripts/schema-baseline-review.mjs';
import {source,fixtureCredential,fixtureBookmark,reviewedInput,terminal} from './fixtures/baseline-operator-fixture.mjs';

test('operator REST wire format against actual local Workerd preserves data, rolls back races and reconciles an ACK loss',async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'baseline-operator-local',modules:true,script:'export default {fetch(){return new Response("fixture only")}}',d1Databases:{GOOD:'operator-good',ACK:'operator-ack',RACE:'operator-race'}}]}));
 try{
  for(const name of ['GOOD','ACK','RACE'])await t.test(name,async()=>{
   const DB=await mf.getD1Database(name);
   for(const bytes of [source.base,...source.files.filter(f=>f.name<'0016').map(f=>f.bytes)]){
    const sql=bytes.toString().split('\n').filter(l=>!l.trim().startsWith('--')).join('\n');
    await DB.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(q=>DB.prepare(q)));
   }
   await DB.batch([
    DB.prepare("INSERT INTO jobs(id,owner_id,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES('j','owner','text','TRANSCRIPT_UNVERIFIED',98,'t','t','REPORT_FIXTURE','AUDIT_FIXTURE')"),
    DB.prepare("INSERT INTO yta_sources VALUES('j','SOURCE_FIXTURE','[]','FIXTURE','t')"),
    DB.prepare("INSERT INTO usage_events(id,owner_id,provider,capability,unit,used_units,provenance,captured_at) VALUES('u','owner','groq','summary','tokens',2169,'FIXTURE','t')"),
    ...Array.from({length:7},(_,i)=>DB.prepare("INSERT INTO yta_operations VALUES(?,'j','groq-summary',6600,'FAILED_UNCERTAIN','t','UNKNOWN','RECEIPT_FIXTURE')").bind('old-'+i))
   ]);
   const dataHash=async()=>sha(JSON.stringify(await Promise.all(['jobs','yta_sources','usage_events','yta_operations'].map(async table=>(await DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results))));
   const before=await dataHash();let writes=0;
   const fetcher=async(url,options)=>{
    const u=new URL(url);assert.equal(u.origin,'https://api.cloudflare.com');assert.equal(options.headers.Authorization,`Bearer ${fixtureCredential}`);assert.equal(options.redirect,'error');
    const response=result=>new Response(JSON.stringify({success:true,result}),{headers:{'content-type':'application/json'}});
    if(u.pathname.endsWith('/time_travel/bookmark'))return response({bookmark:fixtureBookmark});
    if(options.method==='GET')return response({uuid:target.databaseId,name:'youtube-ai-analyzer-private-db'});
    const payload=JSON.parse(options.body).batch,writing=payload.some(s=>!/^SELECT\s/.test(s.sql));
    if(writing){writes++;if(name==='RACE')await DB.prepare("INSERT INTO yta_operations VALUES('late','j','groq-summary',6600,'CLAIMED','t',NULL,NULL)").run();}
    const results=await DB.batch(payload.map(s=>DB.prepare(s.sql).bind(...s.params)));
    if(writing&&name==='ACK')throw Error('FIXTURE_ACK_LOSS');return response(results);
   };
   const session=createBaselineOperatorSession({credential:fixtureCredential,fetcher}),capture=await session.captureEvidence(),bundle=await reviewedInput({now:Date.now},capture),grant=await session.confirm(bundle.input,bundle.window,terminal());
   if(name==='RACE'){
    await assert.rejects(session.register(grant),/BASELINE_REGISTRATION_UNCONFIRMED/);
    assert.equal((await DB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='codex_schema_baselines'").first()).n,0);
    await DB.prepare("DELETE FROM yta_operations WHERE id='late'").run();
   }else{
    const result=await session.register(grant);assert.equal(result.state,name==='ACK'?'RECOVERED_AFTER_ACK_LOSS':'RECORDED');assert.equal((await session.inspect()).state,'RECORDED');
   }
   assert.equal(writes,1);assert.equal(await dataHash(),before);
   assert.equal((await DB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='d1_migrations'").first()).n,0);
   await assert.rejects(session.register(grant));assert.equal(writes,1);session.close();
  });
 }finally{await mf.dispose();}
});
