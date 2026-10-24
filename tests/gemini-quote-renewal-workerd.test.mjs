import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {encryptProviderKey} from '../src/vault.mjs';
import {sha,TWO_PASS_MODEL} from '../src/gemini-two-pass-contract.mjs';

const quoteBody={projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true};
const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);
async function fixture(){
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'renewal-local',modules:true,script:'export default {fetch(){throw Error("NO_EXTERNAL_NETWORK")}}',d1Databases:{DB:'renewal'}}]}));
 const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0015_gemini_two_pass.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
 const id=crypto.randomUUID(),stamp=new Date().toISOString(),segments=[{id:1,startMs:0,endMs:1000,text:'Fixture source'}],audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'d'.repeat(64),status:'TRANSCRIPT_UNVERIFIED'};
 await DB.prepare("INSERT INTO jobs(id,owner_id,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','audio','TRANSCRIBED',1,?,?,'null',?)").bind(id,stamp,stamp,JSON.stringify(audit)).run();
 await DB.prepare("INSERT INTO yta_sources VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").bind(id,segments[0].text,JSON.stringify(segments),stamp).run();
 const root=Buffer.alloc(32,7),secret=await encryptProviderKey(root,'gemini','LOCAL_FIXTURE_ONLY');await DB.prepare("INSERT INTO provider_credentials VALUES('owner','gemini',?,?,?,?)").bind(secret.version,secret.ivB64,secret.ciphertextB64,stamp).run();
 const counters={metadata:0,count:0,generation:0};
 const env={DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_GEMINI_TWO_PASS:'true',GEMINI_TWO_PASS_ALLOWED_JOB_ID:id,ALLOW_PAID_API:'false',GEMINI_TWO_PASS_TEST_PROVIDER:{getModel:async()=>{counters.metadata++;return {name:'models/'+TWO_PASS_MODEL,supportedGenerationMethods:['generateContent','countTokens'],inputTokenLimit:1048576,outputTokenLimit:65536};},countTokens:async()=>{counters.count++;return 300;},generate:async()=>{counters.generation++;throw Error('GENERATION_NOT_AUTHORIZED');}}};
 const call=async(action,body)=>routeApi(new Request('https://fixture.invalid/api/jobs/'+id+'/gemini-two-pass-'+action,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),env);
 const row=()=>DB.prepare('SELECT * FROM yta_gemini_two_pass_jobs WHERE job_id=?').bind(id).first();
 assert.equal((await call('quote',quoteBody)).status,200);
 const expire=async()=>{const prior=await row(),q=JSON.parse(prior.quote_json);q.expiresAt=Date.now()-1000;q.modelAccessEvidence.checkedAt=q.expiresAt-1800000;const encoded=JSON.stringify(q);await DB.prepare('UPDATE yta_gemini_two_pass_jobs SET quote_json=?,quote_sha256=?,expires_at=? WHERE job_id=?').bind(encoded,await sha(encoded),q.expiresAt,id).run();};await expire();
 const review=async()=>{const r=await call('renewal');assert.equal(r.status,200);return r.json();};
 const approvalBody=async()=>({requestId:crypto.randomUUID(),evidenceSha256:(await review()).evidenceSha256,confirmArchiveUnusedQuote:true,confirmNoProviderCall:true});
 const approve=async()=>{const r=await call('renewal',await approvalBody());assert.equal(r.status,200,await r.clone().text());return r.json();};
 const renew=(grant,extra={})=>call('quote',{...quoteBody,renewalApprovalId:grant.renewalApprovalId,quoteRequestId:crypto.randomUUID(),...extra});
 return {mf,DB,id,env,counters,call,row,expire,review,approvalBody,approve,renew};
}

test('unused renewal archives original bytes, requires separate count consent and new generation approval',async()=>{
 const f=await fixture();try{
  await f.DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'groq',20,'DONE','old')").bind(f.id+':audio:0',f.id).run();
  await f.DB.prepare("INSERT INTO usage_events VALUES('audio-usage',?,'owner','groq','LIVE_FREE_BATCH','audio_seconds',20,0,NULL,'APP_RESERVED_ACCOUNT_CAPACITY_UNKNOWN','old')").bind(f.id).run();
  const audioUsage=(await f.DB.prepare('SELECT * FROM usage_events').all()).results;
  const old=await f.row(),attempt=await f.DB.prepare("SELECT * FROM yta_operations WHERE provider='gemini-two-pass-quote'").first();
  assert.equal((await f.call('quote',quoteBody)).status,409);
  const body=await f.approvalBody(),response=await f.call('renewal',body),grant=await response.json();assert.equal(response.status,200);assert.equal(grant.generationAllowed,false);assert.equal(grant.countTokensRequested,false);
  assert.equal((await f.call('renewal',body)).status,200);assert.deepEqual(f.counters,{metadata:1,count:1,generation:0});assert.deepEqual(await f.row(),old);
  const denied=await f.renew(grant,{confirmFullTranscriptSentToGoogleForTokenCount:false});assert.equal(denied.status,409);
  const fresh=await f.renew(grant);assert.equal(fresh.status,200,await fresh.clone().text());const current=await fresh.json();assert.equal(current.state,'QUOTED');assert.notEqual(current.quote.executionId,JSON.parse(old.quote_json).executionId);assert.equal(current.quote.maxCalls,2);
  const archived=await f.DB.prepare("SELECT * FROM yta_operations WHERE provider='gemini-two-pass-quote-renewal'").first();assert.equal(archived.state,'CONSUMED');const record=JSON.parse(archived.result_json);assert.deepEqual(record.archive.oldQuote,old);assert.deepEqual(record.archive.oldAttempt,attempt);assert.equal(record.maxGenerationCalls,0);assert.doesNotMatch(archived.result_json,/LOCAL_FIXTURE_ONLY|ciphertext_b64|iv_b64/);
  assert.equal((await f.call('run',{phase:0,quoteSha256:current.quote.quoteSha256,confirmSeparatePaidApproval:true})).status,409);assert.equal((await f.renew(grant)).status,409);assert.deepEqual(f.counters,{metadata:2,count:2,generation:0});
  await f.expire();const next=await f.approve();assert.equal((await f.renew(next)).status,200);assert.equal((await f.DB.prepare("SELECT count(*) n FROM yta_operations WHERE provider='gemini-two-pass-quote-renewal'").first()).n,2);assert.deepEqual(JSON.parse((await f.DB.prepare('SELECT result_json FROM yta_operations WHERE id=?').bind(grant.renewalApprovalId).first()).result_json).archive.oldQuote,old);
  assert.deepEqual((await f.DB.prepare('SELECT * FROM usage_events').all()).results,audioUsage);
 }finally{await f.mf.dispose();}
});

test('cancelled unused quote is eligible; cancelled used and every phase state are blocked without erasing history',async()=>{
 const f=await fixture();try{
  await f.DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state='CANCELLED'").run();assert.equal((await f.review()).eligible,true);
  for(const state of ['RESERVED','DISPATCHING','RECEIVED','INCOMPLETE','VALIDATION_FAILED','SETTLED','UNCERTAIN']){
   await f.DB.prepare("INSERT INTO yta_gemini_two_pass_calls(job_id,phase,request_sha256,input_tokens_counted,output_tokens_cap,state,response_json,usage_json,created_at,updated_at) VALUES(?,0,?,300,8192,?,'preserved response','preserved usage','old','old')").bind(f.id,'a'.repeat(64),state).run();
   const before=(await f.DB.prepare('SELECT * FROM yta_gemini_two_pass_calls').all()).results;assert.equal((await f.review()).eligible,false);assert.deepEqual((await f.DB.prepare('SELECT * FROM yta_gemini_two_pass_calls').all()).results,before);await f.DB.prepare('DELETE FROM yta_gemini_two_pass_calls').run(); // fixture cleanup only
  }
  assert.deepEqual(f.counters,{metadata:1,count:1,generation:0});
 }finally{await f.mf.dispose();}
});

test('summary usage, unknown or FAILED_UNCERTAIN operations and paid reservations prevent renewal',async()=>{
 const f=await fixture();try{
  await f.DB.prepare("INSERT INTO yta_operations VALUES('old',?,'groq-summary',0,'FAILED_UNCERTAIN','old',NULL,'preserved')").bind(f.id).run();assert.equal((await f.review()).eligible,false);assert.equal((await f.DB.prepare("SELECT result_json FROM yta_operations WHERE id='old'").first()).result_json,'preserved');await f.DB.prepare("DELETE FROM yta_operations WHERE id='old'").run();
  await f.DB.prepare("INSERT INTO usage_events VALUES('old',?,'owner','gemini','summary','tokens',1,0,NULL,'fixture','old')").bind(f.id).run();assert.equal((await f.review()).eligible,false);await f.DB.prepare("DELETE FROM usage_events WHERE id='old'").run();
  for(const file of ['../migrations/0008_paid_summary_budget.sql','../migrations/0010_paid_summary_receipts.sql'])for(const sql of statements(file))await f.DB.prepare(sql).run();
  assert.equal((await f.review()).eligible,true);await f.DB.prepare("INSERT INTO yta_paid_summary_approvals VALUES('old',?,'owner','s','q','{}','model','v','c',10,5,2,1,'CANCELLED','old')").bind(f.id).run();await f.DB.prepare("INSERT INTO yta_paid_summary_reservations VALUES('receipt','old',0,5,1,'usage',NULL,'SETTLED','old')").run();assert.equal((await f.review()).eligible,false);assert.equal((await f.DB.prepare('SELECT usage_json FROM yta_paid_summary_reservations').first()).usage_json,'usage');assert.deepEqual(f.counters,{metadata:1,count:1,generation:0});
 }finally{await f.mf.dispose();}
});

function intercept(f,hook){const DB=f.DB;f.env.DB={prepare(sql){const wrap=(statement,args=[])=>new Proxy(statement,{get(target,key){if(key==='bind')return (...values)=>wrap(target.bind(...values),values);if(key==='run')return ()=>hook(sql,args,()=>target.run());const value=target[key];return typeof value==='function'?value.bind(target):value;}});return wrap(DB.prepare(sql));},batch:list=>DB.batch(list)};}

test('parallel quote requests consume one approval and dispatch metadata/count only once',async()=>{
 const f=await fixture();try{const grant=await f.approve(),results=await Promise.all([f.renew(grant),f.renew(grant)]);assert.equal(results.filter(r=>r.status===200).length,1,await Promise.all(results.map(r=>r.clone().text())));assert.deepEqual(f.counters,{metadata:2,count:2,generation:0});}finally{await f.mf.dispose();}
});

test('approval ACK loss reads exact saved approval; lost reservation ACK never dispatches or automatically retries',async()=>{
 const f=await fixture();try{
  intercept(f,async(sql,args,run)=>{const r=await run();if(sql.startsWith('INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,?,?,0'))throw Error('COMMITTED_APPROVAL_ACK_LOSS');return r;});
  const grant=await f.approve();f.env.DB=f.DB;
  f.env.DB={prepare:sql=>f.DB.prepare(sql),batch:async list=>{await f.DB.batch(list);throw Error('COMMITTED_RESERVATION_ACK_LOSS');}};
  const old=await f.row();assert.equal((await f.renew(grant)).status,500);f.env.DB=f.DB;assert.equal((await f.renew(grant)).status,409);assert.deepEqual(await f.row(),old);assert.equal((await f.DB.prepare("SELECT state FROM yta_operations WHERE provider='gemini-two-pass-quote'").first()).state,'RESERVED');assert.deepEqual(f.counters,{metadata:1,count:1,generation:0});
 }finally{await f.mf.dispose();}
});

test('count response loss keeps COUNT_SENT and cannot be renewed',async()=>{
 const f=await fixture();try{const grant=await f.approve();f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async()=>{f.counters.count++;throw Error('COUNT_ACK_LOST');};assert.equal((await f.renew(grant)).status,500);assert.equal((await f.renew(grant)).status,409);assert.equal((await f.review()).eligible,false);assert.equal((await f.DB.prepare("SELECT state FROM yta_operations WHERE provider='gemini-two-pass-quote'").first()).state,'COUNT_SENT');assert.deepEqual(f.counters,{metadata:2,count:2,generation:0});}finally{await f.mf.dispose();}
});

for(const mutation of ['source','audit','duration','key','usage','uncertain','deletion','approval','flags','expiry'])test('final D1 dispatch guard rejects '+mutation+' race with provider0',async()=>{
 const f=await fixture();try{const grant=await f.approve();let changed=false;const originalNow=Date.now;
  intercept(f,async(sql,args,run)=>{
   if(!changed&&sql.startsWith('UPDATE yta_operations SET state=?,result_json=?')&&args[0]==='MODEL_LOOKUP'){
    changed=true;
    if(mutation==='source')await f.DB.prepare("UPDATE yta_sources SET raw='changed'").run();
    if(mutation==='audit')await f.DB.prepare("UPDATE jobs SET audit_json='{}'").run();
    if(mutation==='duration')await f.DB.prepare('UPDATE jobs SET duration_seconds=10').run();
    if(mutation==='key')await f.DB.prepare("UPDATE provider_credentials SET updated_at='changed'").run();
    if(mutation==='usage')await f.DB.prepare("INSERT INTO usage_events VALUES('race',?,'owner','gemini','summary','tokens',1,0,NULL,'fixture','old')").bind(f.id).run();
    if(mutation==='uncertain'||mutation==='deletion')await f.DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,0,?,'old')").bind(mutation==='deletion'?f.id+':deleting':'race',f.id,mutation==='deletion'?'deletion':'groq-summary',mutation==='deletion'?'DELETING':'FAILED_UNCERTAIN').run();
    if(mutation==='approval')await f.DB.prepare("UPDATE yta_operations SET state='STOPPED' WHERE id=?").bind(grant.renewalApprovalId).run();
    const r=await run();if(mutation==='flags')f.env.ENABLE_GEMINI_TWO_PASS='false';if(mutation==='expiry')Date.now=()=>grant.expiresAt+1;return r;
   }return run();
  });
  try{const result=await f.renew(grant);assert.notEqual(result.status,200,await result.clone().text());assert.equal(changed,true);assert.deepEqual(f.counters,{metadata:1,count:1,generation:0});}finally{Date.now=originalNow;}
 }finally{await f.mf.dispose();}
});

test('source mutation after metadata blocks count; late count result cannot replace the original quote',async()=>{
 for(const point of ['metadata','count']){const f=await fixture();try{const grant=await f.approve(),old=await f.row(),original=f.env.GEMINI_TWO_PASS_TEST_PROVIDER[point==='metadata'?'getModel':'countTokens'];f.env.GEMINI_TWO_PASS_TEST_PROVIDER[point==='metadata'?'getModel':'countTokens']=async(...args)=>{const result=await original(...args);await f.DB.prepare("UPDATE yta_sources SET raw='changed'").run();return result;};assert.equal((await f.renew(grant)).status,409);assert.deepEqual(await f.row(),old);assert.deepEqual(f.counters,{metadata:2,count:point==='metadata'?1:2,generation:0});}finally{await f.mf.dispose();}}
});

test('approval schema rejects credentials, changed evidence and request ID reuse; expiry remains separate',async()=>{
 const f=await fixture();try{
  const body=await f.approvalBody();for(const changed of [{...body,authorization:'DO_NOT_STORE'},{...body,cookie:'DO_NOT_STORE'},{...body,requestId:'bad'},{...body,evidenceSha256:null},{...body,evidenceSha256:'a'.repeat(64)}])assert.equal((await f.call('renewal',changed)).status,409);
  const replies=await Promise.all([f.call('renewal',body),f.call('renewal',body)]);for(const response of replies)assert.equal(response.status,200,await response.clone().text());const grant=await replies[0].json();assert.deepEqual(await replies[1].json(),grant);
  assert.equal((await f.DB.prepare("SELECT count(*) n FROM yta_operations WHERE provider='gemini-two-pass-quote-renewal'").first()).n,1);
  const originalNow=Date.now;try{Date.now=()=>grant.expiresAt+1;assert.equal((await f.renew(grant)).status,409);}finally{Date.now=originalNow;}
  assert.deepEqual(f.counters,{metadata:1,count:1,generation:0});
 }finally{await f.mf.dispose();}
});

test('pre-commit reservation failure rolls back; quote-save ACK loss is read back without another count',async()=>{
 const f=await fixture();try{
  const grant=await f.approve(),old=await f.row();f.env.DB={prepare:sql=>f.DB.prepare(sql),batch:async()=>{throw Error('BEFORE_COMMIT');}};assert.equal((await f.renew(grant)).status,500);assert.deepEqual(await f.row(),old);assert.deepEqual(f.counters,{metadata:1,count:1,generation:0});
  let batches=0;f.env.DB={prepare:sql=>f.DB.prepare(sql),batch:async list=>{const r=await f.DB.batch(list);if(++batches===2)throw Error('SAVED_QUOTE_ACK_LOSS');return r;}};
  assert.equal((await f.renew(grant)).status,500);f.env.DB=f.DB;const status=await(await f.call('status')).json();assert.equal(status.state,'QUOTED');assert.notEqual(status.quote.quoteSha256,old.quote_sha256);assert.equal((await f.renew(grant)).status,409);assert.deepEqual(f.counters,{metadata:2,count:2,generation:0});
 }finally{await f.mf.dispose();}
});

test('uncertain legacy identity and missing quote attempt are not inferred unused from empty call rows',async()=>{
 const f=await fixture();try{
  await f.DB.prepare("DELETE FROM yta_operations WHERE provider='gemini-two-pass-quote'").run();assert.equal((await f.review()).eligible,false);
  const legacy='a69c6a73-6aa6-4ccb-a912-1fab0c35d6a9';for(const table of ['jobs','yta_sources','yta_gemini_two_pass_jobs'])await f.DB.prepare(`UPDATE ${table} SET ${table==='jobs'?'id':'job_id'}=?`).bind(legacy).run();f.env.GEMINI_TWO_PASS_ALLOWED_JOB_ID=legacy;
  const result=await routeApi(new Request('https://fixture.invalid/api/jobs/'+legacy+'/gemini-two-pass-renewal'),f.env),body=await result.json();assert.equal(body.eligible,false);assert.equal(body.reason,'TWO_PASS_RENEWAL_LEGACY_UNCERTAIN');assert.deepEqual(f.counters,{metadata:1,count:1,generation:0});
 }finally{await f.mf.dispose();}
});

// Inject through real Workerd D1 immediately before each guarded write. These are
// concurrent evidence changes, not provider errors that may be cleared on retry.
const canonicalMutations={error_code:'LATE_QUOTE_UNCERTAINTY',units:7,job_id:'different-owner-job',provider:'different-provider',created_at:'changed-at'};
for(const point of ['approval','reservation','metadata','count','count-result','save'])test('canonical evidence remains exact at '+point,async()=>{
 for(const [column,value] of Object.entries(canonicalMutations)){
  const f=await fixture();try{
   const body=point==='approval'?await f.approvalBody():null,grant=body?null:await f.approve(),old=await f.row();
   const source=await f.DB.prepare('SELECT * FROM yta_sources').first();let changed=false,batches=0;
   const mutate=async()=>{changed=true;await f.DB.prepare(`UPDATE yta_operations SET ${column}=? WHERE id=?`).bind(value,f.id+':gemini-two-pass-quote').run();};
   intercept(f,async(sql,args,run)=>{
    const target={metadata:'MODEL_LOOKUP',count:'COUNT_SENT','count-result':'COUNT_RECEIVED'}[point];
    if(!changed&&(point==='approval'&&sql.startsWith('INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,?,?,0')||target&&sql.startsWith('UPDATE yta_operations SET state=?,result_json=?')&&args[0]===target))await mutate();
    return run();
   });
   f.env.DB.batch=async list=>{batches++;if(!changed&&(point==='reservation'&&batches===1||point==='save'&&batches===2))await mutate();return f.DB.batch(list);};
   const result=body?await f.call('renewal',body):await f.renew(grant);
   assert.equal(changed,true,point+':'+column);assert.notEqual(result.status,200,point+':'+column);
   const attempt=await f.DB.prepare('SELECT * FROM yta_operations WHERE id=?').bind(f.id+':gemini-two-pass-quote').first();
   assert.equal(attempt[column],value);assert.deepEqual(await f.row(),old);assert.deepEqual(await f.DB.prepare('SELECT * FROM yta_sources').first(),source);
   const expected={metadata:['count','count-result','save'].includes(point)?2:1,count:['count-result','save'].includes(point)?2:1,generation:0};
   assert.deepEqual(f.counters,expected);
   f.env.DB=f.DB;
   // A timestamp-only change before reservation can be inspected as new evidence;
   // it must never use the previously issued approval or erase the original row.
   const inspected=await f.review();if(!(column==='created_at'&&['approval','reservation'].includes(point)))assert.equal(inspected.eligible,false);
   if(grant)assert.notEqual((await f.renew(grant)).status,200);assert.deepEqual(f.counters,expected);
  }finally{await f.mf.dispose();}
 }
});

test('consumed approval ownership and error changes stop count and final save without clearing evidence',async()=>{
 for(const point of ['reservation','count','save'])for(const [column,value] of Object.entries(canonicalMutations)){
  const f=await fixture();try{
   const grant=await f.approve(),old=await f.row();let changed=false,batches=0;
   const mutate=async()=>{changed=true;await f.DB.prepare(`UPDATE yta_operations SET ${column}=? WHERE id=?`).bind(value,grant.renewalApprovalId).run();};
   intercept(f,async(sql,args,run)=>{if(!changed&&point==='count'&&sql.startsWith('UPDATE yta_operations SET state=?,result_json=?')&&args[0]==='COUNT_SENT')await mutate();return run();});
   f.env.DB.batch=async list=>{batches++;if(!changed&&(point==='reservation'&&batches===1||point==='save'&&batches===2))await mutate();return f.DB.batch(list);};
   assert.notEqual((await f.renew(grant)).status,200);assert.equal(changed,true);assert.deepEqual(await f.row(),old);
   assert.equal((await f.DB.prepare(`SELECT ${column} FROM yta_operations WHERE id=?`).bind(grant.renewalApprovalId).first())[column],value);
   assert.deepEqual(f.counters,{metadata:point==='reservation'?1:2,count:point==='save'?2:1,generation:0});
  }finally{await f.mf.dispose();}
 }
});

test('idempotent approval checks canonical evidence again after the existing approval read',async()=>{
 const f=await fixture();try{
  const body=await f.approvalBody();assert.equal((await f.call('renewal',body)).status,200);const old=await f.row();let changed=false;
  const DB=f.DB;
  f.env.DB={prepare(sql){const wrap=statement=>new Proxy(statement,{get(target,key){if(key==='bind')return(...args)=>wrap(target.bind(...args));if(key==='first')return async(...args)=>{const result=await target.first(...args);if(!changed&&sql==='SELECT * FROM yta_operations WHERE id=? AND provider=?'){changed=true;await DB.prepare("UPDATE yta_operations SET error_code='LATE_QUOTE_UNCERTAINTY' WHERE id=?").bind(f.id+':gemini-two-pass-quote').run();}return result;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});return wrap(DB.prepare(sql));},batch:list=>DB.batch(list)};
  assert.notEqual((await f.call('renewal',body)).status,200);assert.equal(changed,true);assert.deepEqual(await f.row(),old);assert.deepEqual(f.counters,{metadata:1,count:1,generation:0});
  assert.equal((await DB.prepare('SELECT error_code FROM yta_operations WHERE id=?').bind(f.id+':gemini-two-pass-quote').first()).error_code,'LATE_QUOTE_UNCERTAINTY');
 }finally{await f.mf.dispose();}
});
