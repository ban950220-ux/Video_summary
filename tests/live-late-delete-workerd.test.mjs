import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {ProviderError} from '../src/adapters.mjs';

const marker='PRIVATE_SYNTHETIC_CONTENT_ONLY';
const segments=[{id:1,startMs:0,endMs:1000,text:marker}];
const report=()=>({summary:[{text:marker,evidenceIds:[1]}],chapters:[{text:marker,evidenceIds:[1]}],claims:[],numbers:[],critical:[],conclusion:'Synthetic fixture, external facts unverified'});
const request=(path,method='POST',body={})=>new Request('https://test.invalid'+path,{method,headers:{'content-type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body)});
const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);
const hash=value=>createHash('sha256').update(value).digest('hex');

test('Workerd shared execute never restores private bodies after delete, while preserving usage and uncertain operations',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'late-delete',modules:true,script:'export default {fetch(){return new Response("local fixture")}}',d1Databases:{DB:'late-delete'}}]}));
 const originalFetch=globalThis.fetch;let mockedCalls=0,lateCases=0,cacheCases=0;
 try{
  const DB=await mf.getD1Database('DB');
  for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0003_observed_capacity.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  let internalError=null;
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',SUPADATA_API_KEY:'LOCAL_FAKE_KEY',GEMINI_API_KEY:'LOCAL_FAKE_KEY',__testOnlyErrorCapture:error=>{internalError={name:error?.name,code:error?.code,message:String(error?.message).slice(0,300)};}},audit={status:'TRANSCRIPT_UNVERIFIED'},now=Date.now();
  for(const provider of ['supadata','gemini'])await DB.prepare('INSERT INTO yta_quota(provider,allowance,request_limit,expires_at,confirmed_at,billing_disabled) VALUES(?,250000,100,?,?,1)').bind(provider,now+3600000,now).run();
  const remaining={requestsMinute:1000,tokensMinute:1000000000,requestsDay:1000};
  await DB.prepare("INSERT INTO yta_capacity(provider,model,source,observed_at,valid_until,reset_json,remaining_json,reserved_json,billing_disabled) VALUES('gemini','gemini-2.5-flash',?,?,?,?,?,?,1)").bind('AI_STUDIO_LIVE:'+hash('gemini:LOCAL_FAKE_KEY'),now,now+3600000,JSON.stringify(Object.fromEntries(Object.keys(remaining).map(k=>[k,now+3600000]))),JSON.stringify(remaining),JSON.stringify(Object.fromEntries(Object.keys(remaining).map(k=>[k,0])))).run();
  const seed=async kind=>{
   // Advance only local fixture pacing between independent scenarios.
   await DB.prepare("UPDATE yta_operations SET created_at=? WHERE provider='gemini'").bind(new Date(Date.now()-60000).toISOString()).run();
   const id=crypto.randomUUID(),stamp=new Date().toISOString();
   await DB.prepare("INSERT INTO jobs(id,owner_id,source_type,source_url,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner',?,'https://youtu.be/2hUkTmwYm3A','TRANSCRIPT_UNVERIFIED',1,?,?,'null',?)").bind(id,kind==='native'?'url':'text',stamp,stamp,JSON.stringify(audit)).run();
   if(kind==='summary')await DB.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'UPLOADED_CAPTIONS',?)").bind(id,marker,JSON.stringify(segments),stamp).run();
   return id;
  };
  const invoke=(id,kind,db=DB)=>routeApi(request(`/api/jobs/${id}/${kind}`),{...env,DB:db});
  const remove=async(id,mode)=>{
   if(mode==='delete'){const response=await routeApi(request('/api/jobs/'+id,'DELETE'),env);assert.equal(response.status,200,await response.clone().text());}
   if(mode==='tombstone')await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'deletion',0,'DELETING',?)").bind(id+':deleting',id,new Date().toISOString()).run();
   if(mode==='missing-owner-job')await DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run();
   if(mode==='other-owner')await DB.prepare("UPDATE jobs SET owner_id='other' WHERE id=?").bind(id).run();
  };
  const privateOperations=async id=>(await DB.prepare("SELECT id,state,provider,units,error_code,result_json FROM yta_operations WHERE job_id=? AND provider!='deletion'").bind(id).all()).results;
  const assertDeleted=async id=>{
   assert.equal((await DB.prepare('SELECT COUNT(*) n FROM jobs WHERE id=?').bind(id).first()).n,0);
   assert.equal((await DB.prepare('SELECT COUNT(*) n FROM yta_sources WHERE job_id=?').bind(id).first()).n,0);
   assert.equal((await DB.prepare("SELECT state FROM yta_operations WHERE id=?").bind(id+':deleting').first()).state,'DELETING');
   assert.ok((await privateOperations(id)).every(row=>row.result_json===null));
  };
  for(const kind of ['native','summary'])for(const outcome of ['success','failure'])for(const mode of ['delete','tombstone','missing-owner-job','other-owner']){
   const id=await seed(kind),provider=kind==='native'?'supadata':'gemini',quotaBefore=await DB.prepare('SELECT consumed,request_count FROM yta_quota WHERE provider=?').bind(provider).first();
   globalThis.fetch=async url=>{
    mockedCalls++;assert.ok(new URL(url).hostname===(kind==='native'?'api.supadata.ai':'generativelanguage.googleapis.com'));
    // The request has already dispatched; DELETE finishes while the response is delayed.
    await remove(id,mode);
    if(kind==='native'){
     if(outcome==='failure'){const error=new ProviderError('FIXTURE_UNCERTAIN','Synthetic failure');error.reviewResult={partialText:marker};throw error;}
     return Response.json({content:[{text:marker,offset:0,duration:1000}]});
    }
    return Response.json({candidates:[{finishReason:outcome==='success'?'STOP':'MAX_TOKENS',content:{parts:[{text:JSON.stringify(report())}]}}]});
   };
   internalError=null;
   const response=await invoke(id,kind);assert.equal(response.status,409,`${kind}/${outcome}/${mode}: ${await response.clone().text()} internal=${JSON.stringify(internalError)}`);
   const rows=await privateOperations(id);assert.equal(rows.length,1);assert.equal(rows[0].state,outcome==='success'?'DONE':'FAILED_UNCERTAIN');assert.equal(rows[0].result_json,null);assert.ok(rows[0].units>0);
   const quotaAfter=await DB.prepare('SELECT consumed,request_count FROM yta_quota WHERE provider=?').bind(provider).first();assert.equal(quotaAfter.request_count,quotaBefore.request_count+1);assert.equal(quotaAfter.consumed,quotaBefore.consumed+rows[0].units);
   const usage=(await DB.prepare('SELECT * FROM usage_events WHERE job_id=?').bind(id).all()).results;assert.equal(usage.length,outcome==='success'?1:0);if(usage.length)assert.equal(usage[0].used_units,rows[0].units);assert.ok(!JSON.stringify(usage).includes(marker));
   if(mode==='delete')await assertDeleted(id);
   if(mode==='delete'||mode==='missing-owner-job'||mode==='other-owner'){const sends=mockedCalls;assert.equal((await invoke(id,kind)).status,404);assert.equal(mockedCalls,sends);}
   lateCases++;
  }

  // A cache read may finish before DELETE; downstream persistence must still fail.
  for(const kind of ['native','summary'])for(const point of ['prior-read','fresh-cache-read']){
   const id=await seed(kind),provider=kind==='native'?'supadata':'gemini',operationId=kind==='native'?id+':native':id+':summary:'+hash(JSON.stringify([segments,audit]))+':single';
   const cached=kind==='native'?{status:'TRANSCRIPT_AVAILABLE',segments}:{text:JSON.stringify(report())};
   await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,1,'DONE',?,?)").bind(operationId,id,provider,new Date().toISOString(),JSON.stringify(cached)).run();
   await DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,provenance,captured_at) VALUES(?,?,'owner',?,'LIVE_FREE','fixture_units',1,'APP_RESERVED_UPPER_BOUND',?)").bind(crypto.randomUUID(),id,provider,new Date().toISOString()).run();
   let deleted=false;const delayedDB={prepare(sql){const wrap=args=>({bind(...values){return wrap(values);},async first(){const row=await DB.prepare(sql).bind(...args).first();if(!deleted&&args[0]===operationId&&((point==='prior-read'&&sql==='SELECT * FROM yta_operations WHERE id=?')||(point==='fresh-cache-read'&&sql.startsWith('SELECT result_json FROM yta_operations WHERE id=?')))){deleted=true;await remove(id,'delete');}return row;},all:()=>DB.prepare(sql).bind(...args).all(),run:()=>DB.prepare(sql).bind(...args).run(),sql,args});return wrap([]);},batch:items=>DB.batch(items.map(item=>DB.prepare(item.sql).bind(...item.args)))};
   globalThis.fetch=async()=>{throw Error('Cache replay must never dispatch');};const sends=mockedCalls;
   assert.equal((await invoke(id,kind,delayedDB)).status,409);assert.equal(deleted,true);await assertDeleted(id);assert.equal(mockedCalls,sends);
   assert.equal((await DB.prepare('SELECT COUNT(*) n FROM usage_events WHERE job_id=?').bind(id).first()).n,1);assert.equal((await privateOperations(id))[0].state,'DONE');cacheCases++;
  }

  // Reverse ordering: a stored success/failure body is scrubbed by the later DELETE.
  for(const kind of ['native','summary'])for(const outcome of ['success','failure']){
   const id=await seed(kind);globalThis.fetch=async()=>{
    mockedCalls++;
    if(kind==='native'){if(outcome==='failure'){const error=new ProviderError('FIXTURE_UNCERTAIN','Synthetic failure');error.reviewResult={partialText:marker};throw error;}return Response.json({content:[{text:marker,offset:0,duration:1000}]});}
    return Response.json({candidates:[{finishReason:outcome==='success'?'STOP':'MAX_TOKENS',content:{parts:[{text:JSON.stringify(report())}]}}]});
   };
   const response=await invoke(id,kind);assert.equal(response.status,outcome==='success'?200:409,await response.clone().text());
   const before=await privateOperations(id);assert.equal(before.length,1);assert.ok(before[0].result_json.includes(marker));const usageBefore=(await DB.prepare('SELECT * FROM usage_events WHERE job_id=?').bind(id).all()).results;
   await remove(id,'delete');await assertDeleted(id);const after=await privateOperations(id);assert.deepEqual(after.map(({result_json,...row})=>row),before.map(({result_json,...row})=>row));assert.deepEqual((await DB.prepare('SELECT * FROM usage_events WHERE job_id=?').bind(id).all()).results,usageBefore);
  }
  console.log(JSON.stringify({case:'SHARED_EXECUTE_LATE_DELETE',lateCases,cacheCases,reverseOrderCases:4,realProviderCalls:0,mockedCalls,privateResultBodiesAfterDeletion:0,accountingPreserved:true}));
 }finally{globalThis.fetch=originalFetch;await mf.dispose();}
});
