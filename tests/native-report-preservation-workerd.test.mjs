import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';

const request=(id,action,body={})=>new Request(`https://test.invalid/api/jobs/${id}/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);
const segments=[{id:1,startMs:0,endMs:1000,text:'Synthetic native caption'}];
const available={status:'TRANSCRIPT_AVAILABLE',segments};

test('Workerd native acquisition preserves reports and sources across cached replay, races and failed commits',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'native-report-preservation',modules:true,script:'export default {fetch(){return new Response("local fixture")}}',d1Databases:{DB:'native-report-preservation'}}]}));
 const originalFetch=globalThis.fetch;let mockPolls=0;
 globalThis.fetch=async()=>{throw Error('Unexpected provider request');};
 try{
  const DB=await mf.getD1Database('DB');
  for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0008_paid_summary_budget.sql','../migrations/0009_paid_first_trial.sql','../migrations/0010_paid_summary_receipts.sql','../migrations/0015_gemini_two_pass.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',SUPADATA_API_KEY:'MOCK_ONLY_NOT_A_REAL_KEY'};
  await DB.prepare("INSERT INTO yta_quota(provider,allowance,request_limit,expires_at,confirmed_at,billing_disabled) VALUES('supadata',2,2,?,?,1)").bind(Date.now()+600000,Date.now()).run();
  const sourceRow=async id=>DB.prepare('SELECT * FROM yta_sources WHERE job_id=?').bind(id).first();
  const jobRow=async id=>DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
  const snapshot=async id=>({job:await jobRow(id),source:await sourceRow(id)});
  const addSource=async id=>DB.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'SUPADATA_NATIVE',?)").bind(id,segments[0].text,JSON.stringify(segments),new Date().toISOString()).run();
  const seed=async({type='url',poll=false,report=null,source=false,result=available,nullValue=false}={})=>{
   const id=crypto.randomUUID(),stamp=new Date().toISOString(),audit=poll?{status:'NATIVE_PENDING',providerJobId:'mock-poll'}:{status:'NOT_RUN'};
   await DB.prepare("INSERT INTO jobs(id,owner_id,source_type,source_url,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner',?,'https://youtu.be/2hUkTmwYm3A',?,200,?,?,?,?)").bind(id,type,poll?'NATIVE_PENDING':'NEED_UPLOAD',stamp,stamp,nullValue?null:JSON.stringify(report),JSON.stringify(audit)).run();
   if(source)await addSource(id);
   if(!poll)await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'supadata',1,'DONE',?,?)").bind(id+':native',id,stamp,JSON.stringify(result)).run();
   return id;
  };
  const call=(id,action='native',db=DB,body={})=>routeApi(request(id,action,body),{...env,DB:db});
  const pollFixture=()=>{globalThis.fetch=async url=>{mockPolls++;assert.equal(new URL(url).pathname,'/v1/transcript/mock-poll');return Response.json({status:'completed',result:{content:[{text:segments[0].text,offset:0,duration:1000}]}});};};

  // Cached negative/positive/pending results cannot change an audio job.
  for(const result of [available,{status:'NO_CAPTIONS',segments:[]},{status:'PENDING',jobId:'mock-poll',segments:[]}]){
   const id=await seed({type:'audio',source:true,report:{kind:'GEMINI_TWO_PASS_EVIDENCE_LINKED'},result}),before=await snapshot(id);
   assert.equal((await call(id)).status,400);assert.deepEqual(await snapshot(id),before);
  }
  for(const kind of ['GEMINI_TWO_PASS_EVIDENCE_LINKED','GEMINI_PAID_FULL_EVIDENCE_LINKED','GEMINI_EVIDENCE_LINKED','GROQ_FULL_COVERAGE_GLOBAL']){
   for(const poll of [false,true]){
    const id=await seed({poll,report:{kind,compositionMode:kind==='GROQ_FULL_COVERAGE_GLOBAL'?'groq-full-coverage-global-v1':null},source:true}),before=await snapshot(id);
    const response=await call(id,poll?'native-poll':'native');assert.equal(response.status,409);assert.equal((await response.json()).error.code,'NATIVE_REPORT_EXISTS');
    assert.deepEqual(await snapshot(id),before);
    const oldSummary=await call(id,'summary');assert.equal(oldSummary.status,kind==='GEMINI_EVIDENCE_LINKED'?200:409);
    for(const action of ['groq-full-coverage','groq-full-coverage-global'])assert.equal((await call(id,action,DB,{action:'finalize'})).status,200);
    const revalidate=await call(id,'paid-summary-revalidate',DB,{confirmNoProviderCall:true,reservationId:'fixture'});assert.equal(revalidate.status,kind==='GEMINI_PAID_FULL_EVIDENCE_LINKED'?200:409);
    assert.deepEqual(await snapshot(id),before);
   }
  }
  for(const poll of [false,true]){const id=await seed({poll,source:true}),before=await snapshot(id);const response=await call(id,poll?'native-poll':'native');assert.equal(response.status,409);assert.equal((await response.json()).error.code,'NATIVE_SOURCE_EXISTS');assert.deepEqual(await snapshot(id),before);}

  // Mutations occur immediately before the real D1 CAS/batch, after admission
  // and after a cached response or a mocked provider result was obtained.
  const mutations={
   report: id=>DB.prepare('UPDATE jobs SET report_json=? WHERE id=?').bind(JSON.stringify({kind:'CONCURRENT_SAVED_REPORT'}),id).run(),
   audit: id=>DB.prepare('UPDATE jobs SET audit_json=? WHERE id=?').bind('{"status":"CONCURRENT_AUDIT"}',id).run(),
   source:addSource,
   duration:id=>DB.prepare('UPDATE jobs SET duration_seconds=201 WHERE id=?').bind(id).run(),
   url:id=>DB.prepare("UPDATE jobs SET source_url='https://youtu.be/abcdefghi12' WHERE id=?").bind(id).run(),
   type:id=>DB.prepare("UPDATE jobs SET source_type='audio' WHERE id=?").bind(id).run(),
   owner:id=>DB.prepare("UPDATE jobs SET owner_id='other' WHERE id=?").bind(id).run(),
   status:id=>DB.prepare("UPDATE jobs SET status='OTHER_STATE' WHERE id=?").bind(id).run(),
   deletion:id=>DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'deletion',0,'DELETING',?)").bind(id+':deleting',id,new Date().toISOString()).run(),
   removed:id=>DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run()
  };
  let raceCases=0;
  for(const mode of ['cached-result','cached-missing','cached-pending','poll-result'])for(const [name,mutate] of Object.entries(mutations)){
   const poll=mode==='poll-result',result=mode==='cached-missing'?{status:'NO_CAPTIONS',segments:[]}:mode==='cached-pending'?{status:'PENDING',jobId:'mock-poll',segments:[]}:available;
   const id=await seed({poll,result});let fired=false,afterMutation;
   const inject=async()=>{if(!fired){fired=true;await mutate(id);afterMutation=await snapshot(id);}};
   const db={prepare(sql){const make=args=>({bind(...values){return make(values);},first:()=>DB.prepare(sql).bind(...args).first(),all:()=>DB.prepare(sql).bind(...args).all(),async run(){if(sql.startsWith('UPDATE jobs SET status=?,audit_json=?,updated_at=?'))await inject();return DB.prepare(sql).bind(...args).run();},sql,args});return make([]);},async batch(items){await inject();return DB.batch(items.map(item=>DB.prepare(item.sql).bind(...item.args)));}};
   if(poll)pollFixture();
   const response=await call(id,poll?'native-poll':'native',db);assert.equal(response.status,409,`${mode}/${name}: ${await response.clone().text()}`);assert.equal(fired,true);
   assert.deepEqual(await snapshot(id),afterMutation,`${mode}/${name} modified preserved data`);raceCases++;
  }

  // An insert failure must roll back the preceding job/audit update.
  const failed=await seed(),beforeFailure=await snapshot(failed);
  await DB.prepare(`CREATE TRIGGER native_fixture_fail BEFORE INSERT ON yta_sources WHEN NEW.job_id='${failed}' BEGIN SELECT RAISE(ABORT,'fixture insert failed'); END`).run();
  assert.equal((await call(failed)).status,500);assert.deepEqual(await snapshot(failed),beforeFailure);
  await DB.prepare('DROP TRIGGER native_fixture_fail').run();
  assert.equal((await call(failed)).status,200);assert.ok(await sourceRow(failed));

  // A committed transaction with lost ACK is found on retry, never overwritten.
  const lost=await seed();const lostDB={prepare:sql=>DB.prepare(sql),async batch(items){await DB.batch(items);throw Error('fixture commit ACK lost');}};
  assert.equal((await call(lost,'native',lostDB)).status,500);const savedAfterLoss=await snapshot(lost);assert.ok(savedAfterLoss.source);
  assert.equal((await call(lost)).status,409);assert.deepEqual(await snapshot(lost),savedAfterLoss);
  const concurrent=await seed({nullValue:true});const replies=await Promise.all([call(concurrent),call(concurrent)]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);assert.equal((await DB.prepare('SELECT COUNT(*) n FROM yta_sources WHERE job_id=?').bind(concurrent).first()).n,1);

  // Both routes still reject out-of-range captions when the source slot is empty.
  for(const poll of [false,true]){
   const id=await seed({poll,result:{status:'TRANSCRIPT_AVAILABLE',segments:[{id:1,startMs:300000,endMs:301000,text:'outside fixture'}]}}),before=await snapshot(id);
   if(poll)globalThis.fetch=async()=>{mockPolls++;return Response.json({status:'completed',result:{content:[{text:'outside fixture',offset:300000,duration:1000}]}});};
   const response=await call(id,poll?'native-poll':'native');assert.equal(response.status,409);assert.equal((await response.json()).error.code,'CAPTION_OUTSIDE_DECLARED_DURATION');assert.deepEqual(await snapshot(id),before);
  }
  const unknown=await seed();await DB.prepare('UPDATE jobs SET duration_seconds=0 WHERE id=?').bind(unknown).run();assert.equal((await(await call(unknown)).json()).error.code,'CAPTION_DURATION_UNVERIFIED');assert.equal(await sourceRow(unknown),null);
  // A real (mocked) polling result and its replay preserve accounting and data.
  const pollId=await seed({poll:true});pollFixture();assert.equal((await call(pollId,'native-poll')).status,200);const pollSaved=await snapshot(pollId),pollCount=mockPolls;assert.equal((await call(pollId,'native-poll')).status,400);assert.equal(mockPolls,pollCount);assert.deepEqual(await snapshot(pollId),pollSaved);
  assert.deepEqual(await DB.prepare("SELECT consumed,request_count FROM yta_quota WHERE provider='supadata'").first(),{consumed:0,request_count:0});
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM usage_events').first()).n,0);
  console.log(JSON.stringify({case:'NATIVE_REPORT_PRESERVATION',raceCases,realProviderCalls:0,mockedPollRequests:mockPolls,atomicRollback:true,ackLossPreserved:true,concurrentStatuses:replies.map(r=>r.status).sort()}));
 }finally{globalThis.fetch=originalFetch;await mf.dispose();}
});
