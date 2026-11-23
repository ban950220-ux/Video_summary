import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleSiteRequest} from '../src/site-worker.mjs';
import {syntheticApprovedSource,syntheticApprovedReport} from './fixtures/approved-summary-synthetic.mjs';

// Synthetic local route integration only. No real video, credentials, provider
// request, D1 binding, saved-ASR task, manual-summary import or receipt exists.
const origin='https://pipeline.synthetic.invalid';
const accessDomain='https://pipeline-synthetic.cloudflareaccess.com';
const audience='synthetic-pipeline-owner-audience';
const owner='pipeline-owner@example.test';
const profile='approved-four-part-v1';
const video='synthetic01';
const submission='00000000-0000-4000-8000-000000000701';
const source=syntheticApprovedSource();
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const publicJwk=publicKey.export({format:'jwk'});
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function token(email=owner){
 const now=Math.floor(Date.now()/1000),head=encode({alg:'RS256',typ:'JWT',kid:'synthetic-pipeline-key'});
 const body=encode({iss:accessDomain,aud:[audience],iat:now-10,exp:now+3600,email,sub:'synthetic-owner-subject'});
 return head+'.'+body+'.'+sign('RSA-SHA256',Buffer.from(head+'.'+body),privateKey).toString('base64url');
}
const captionBody=()=>({content:source.segments.map(s=>({text:s.text,offset:s.startMs,duration:s.endMs-s.startMs})),lang:'ko'});
const modelBody=report=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}]});

function fixture({native='available',poll=['available'],durationSeconds=80,model='valid'}={}){
 const dir=mkdtempSync(join(tmpdir(),'synthetic-pipeline-path-')),path=join(dir,'synthetic.sqlite');
 let db=new DatabaseSync(path),pollIndex=0,afterModel=null;
 for(const file of ['schema.sql','migrations/0002_live.sql','migrations/0003_observed_capacity.sql','migrations/0017_audio_submission_idempotency.sql'])db.exec(readFileSync(new URL('../'+file,import.meta.url),'utf8'));
 const key='SYNTHETIC_ONLY_NO_PROVIDER_ACCOUNT',stamp=Date.now();
 const counts={native:0,poll:0,summary:0,unexpected:0};
 for(const provider of ['supadata','gemini'])db.prepare('INSERT INTO yta_quota(provider,allowance,consumed,request_limit,request_count,expires_at,confirmed_at,billing_disabled) VALUES(?,250000,0,100,0,?,?,1)').run(provider,stamp+3600000,stamp);
 const remaining={requestsMinute:1000,tokensMinute:1000000000,requestsDay:1000};
 db.prepare('INSERT INTO yta_capacity(provider,model,source,observed_at,valid_until,reset_json,remaining_json,reserved_json,billing_disabled) VALUES(?,?,?,?,?,?,?,?,1)').run('gemini','gemini-2.5-flash','AI_STUDIO_LIVE:'+createHash('sha256').update('gemini:'+key).digest('hex'),stamp,stamp+600000,JSON.stringify(Object.fromEntries(Object.keys(remaining).map(k=>[k,stamp+3600000]))),JSON.stringify(remaining),JSON.stringify(Object.fromEntries(Object.keys(remaining).map(k=>[k,0]))));
 const DB={prepare(sql){const make=args=>({sql,args,bind(...values){return make(values);},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}});return make([]);},async batch(statements){
  // BEGIN belongs only to this local SQLite fake, never a remote D1 request.
  db.exec('BEGIN');try{const results=statements.map(s=>({meta:{changes:Number(db.prepare(s.sql).run(...s.args).changes)}}));db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}
 }};
 const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',SUPADATA_API_KEY:key,GEMINI_API_KEY:key,ACCESS_TEAM_DOMAIN:accessDomain,ACCESS_AUD:audience,ACCESS_OWNER_EMAIL:owner};
 const fetcher=async url=>{assert.equal(url,accessDomain+'/cdn-cgi/access/certs');return Response.json({keys:[{...publicJwk,kid:'synthetic-pipeline-key',alg:'RS256'}]});};
 const call=(route,{method='GET',body,email=owner,requestOrigin=origin}={})=>handleSiteRequest(new Request(origin+route,{method,headers:{'Cf-Access-Jwt-Assertion':token(email),...(body===undefined?{}:{'content-type':'application/json'}),...(method==='GET'?{}:{Origin:requestOrigin})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{fetcher,nowMs:Date.now()});
 const provider=async(url,options={})=>{
  const u=new URL(String(url));
  if(u.hostname==='api.supadata.ai'&&u.pathname==='/v1/transcript'){
   counts.native++;assert.equal(u.searchParams.get('mode'),'native');assert.equal(u.searchParams.get('text'),'false');assert.equal(u.searchParams.get('url'),'https://www.youtube.com/watch?v='+video);
   if(native==='uncertain')throw new TypeError('Synthetic response transport interrupted');
   if(native==='none')return new Response(null,{status:206});
   if(native==='pending')return Response.json({jobId:'synthetic-native-pending'});
   return Response.json(captionBody());
  }
  if(u.hostname==='api.supadata.ai'&&u.pathname==='/v1/transcript/synthetic-native-pending'){
   counts.poll++;const state=poll[Math.min(pollIndex++,poll.length-1)];
   return Response.json(state==='available'?{status:'completed',result:captionBody()}:{status:'processing'});
  }
  if(u.hostname==='generativelanguage.googleapis.com'){
   counts.summary++;const body=JSON.parse(options.body);assert.match(body.contents[0].parts[0].text,/approvedSummary/);assert.equal(body.generationConfig.maxOutputTokens,8192);
   afterModel?.();return Response.json(modelBody(model==='valid'?syntheticApprovedReport(source):{summary:[]}));
  }
  counts.unexpected++;throw new Error('UNEXPECTED_SYNTHETIC_NETWORK_ROUTE');
 };
 return {env,call,counts,provider,get db(){return db;},set afterModel(fn){afterModel=fn;},input:{sourceType:'url',url:'https://youtu.be/'+video,durationSeconds,title:'Synthetic caption pipeline',submissionId:submission},quota(provider){return db.prepare('SELECT consumed,request_count FROM yta_quota WHERE provider=?').get(provider);},source(id){return db.prepare('SELECT raw,segments_json,provenance FROM yta_sources WHERE job_id=?').get(id);},job(id){return db.prepare('SELECT status,report_json,audit_json,owner_id FROM jobs WHERE id=?').get(id);},reopen(){db.close();db=new DatabaseSync(path);},close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
async function usingFixture(options,run){const f=fixture(options),old=globalThis.fetch;globalThis.fetch=f.provider;try{return await run(f);}finally{globalThis.fetch=old;f.close();}}
async function expectJson(response,status){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function create(f,input=f.input){const result=await expectJson(await f.call('/api/jobs',{method:'POST',body:input}),202);assert.equal(result.persisted,true);return result.job;}
const base=id=>'/api/jobs/'+id;
const native=f=>id=>f.call(base(id)+'/native',{method:'POST',body:{}});
const summarize=f=>id=>f.call(base(id)+'/summary',{method:'POST',body:{formatProfile:profile}});
function assertApproved(data){assert.equal(data.persisted,true);assert.equal(data.job.report.kind,'GEMINI_EVIDENCE_LINKED');assert.equal(data.job.report.approvedSummary.formatVersion,profile);assert.equal(data.job.approvedSummaryView.origin,'APPROVED_STRUCTURED');assert.equal(data.job.approvedSummaryView.sourceStatus,'MATCHED');assert.equal(data.job.report.approvedSummary.semanticReview,'NOT_PERFORMED');}

for(const partial of [false,true])test('caption URL crosses owner auth, native acquisition, four-part save and durable list/reopen'+(partial?' with partial source retained':''),async()=>usingFixture({durationSeconds:partial?800:80},async f=>{
 const job=await create(f),id=job.id;
 assert.equal((await expectJson(await f.call('/api/jobs'),200)).jobs.length,1);
 const acquired=await expectJson(await native(f)(id),200);assert.equal(acquired.persisted,true);assert.equal(acquired.job.status,partial?'PARTIAL_TRANSCRIPT':'TRANSCRIPT_UNVERIFIED');
 const storedSource=f.source(id);assert.equal(storedSource.provenance,'SUPADATA_NATIVE');assert.equal(storedSource.raw,source.raw);
 const plan=await expectJson(await f.call(base(id)+'/summary-plan?formatProfile='+profile),200);assert.equal(plan.formatProfile,profile);
 const result=await expectJson(await summarize(f)(id),200);assertApproved(result);assert.equal(result.job.status,acquired.job.status);
 const stored=f.job(id),quota=f.quota('gemini'),usage=f.db.prepare('SELECT COUNT(*) n FROM usage_events').get().n;
 f.reopen();const list=await expectJson(await f.call('/api/jobs'),200);assert.equal(list.jobs.length,1);assert.equal(list.jobs[0].id,id);assert.deepEqual(list.jobs[0].summary,result.job.report.summary);
 const reopened=await expectJson(await f.call(base(id)),200);assert.deepEqual(reopened.job.report,result.job.report);assert.equal(reopened.job.approvedSummaryView.sourceStatus,'MATCHED');
 for(const format of ['txt','md']){const exported=await f.call(base(id)+'/export?format='+format);assert.equal(exported.status,200);const text=await exported.text();for(const part of ['핵심 결론','목차','인과관계','가정','반례','원본 스크립트'])assert.ok(text.includes(part),part);assert.ok(text.includes(source.segments[3].text));}
 const replay=await expectJson(await summarize(f)(id),200);assert.equal(replay.cached,true);assert.equal(replay.formatMismatch,false);
 assert.deepEqual(f.counts,{native:1,poll:0,summary:1,unexpected:0});assert.deepEqual(f.job(id),stored);assert.deepEqual(f.source(id),storedSource);assert.deepEqual(f.quota('gemini'),quota);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,usage);
}));

test('SQL NULL report remains null through caption acquisition and can enter four-part summary',async()=>usingFixture({},async f=>{
 const job=await create(f);f.db.prepare('UPDATE jobs SET report_json=NULL WHERE id=?').run(job.id);
 await expectJson(await native(f)(job.id),200);assert.equal(f.job(job.id).report_json,null);
 assertApproved(await expectJson(await summarize(f)(job.id),200));assert.equal(f.counts.summary,1);
}));

test('NO_CAPTIONS stays NEED_UPLOAD without source, automatic audio worker, ASR or summary',async()=>usingFixture({native:'none'},async f=>{
 const job=await create(f),id=job.id;const result=await expectJson(await native(f)(id),202);
 assert.equal(result.job.status,'NEED_UPLOAD');assert.equal(result.job.audit.status,'NO_CAPTIONS');assert.match(result.job.audit.reason,/연결|미완료|미연결/);
 assert.equal(f.source(id),undefined);assert.equal(JSON.parse(f.job(id).report_json),null);
 assert.equal((await f.call(base(id)+'/summary-plan?formatProfile='+profile)).status,400);assert.equal((await summarize(f)(id)).status,400);
 const quota=f.quota('supadata');await expectJson(await native(f)(id),202);assert.deepEqual(f.quota('supadata'),quota);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_audio').get().n,0);
 assert.deepEqual(f.counts,{native:1,poll:0,summary:0,unexpected:0});assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider!='supadata'").get().n,0);
}));

test('pending captions require explicit poll then explicit four-part summary, with no second app credit reservation',async()=>usingFixture({native:'pending',poll:['pending','available']},async f=>{
 const job=await create(f),id=job.id;const waiting=await expectJson(await native(f)(id),202);assert.equal(waiting.job.status,'NATIVE_PENDING');
 const list=await expectJson(await f.call('/api/jobs'),200);assert.equal(list.jobs[0].nativePollReady,true);
 assert.equal((await summarize(f)(id)).status,400);assert.equal(f.counts.summary,0);const quota=f.quota('supadata');
 const pending=await expectJson(await f.call(base(id)+'/native-poll',{method:'POST',body:{}}),202);assert.equal(pending.job.status,'NATIVE_PENDING');
 await expectJson(await f.call(base(id)+'/native-poll',{method:'POST',body:{}}),200);assert.deepEqual(f.quota('supadata'),quota);assert.equal(f.counts.summary,0);
 assertApproved(await expectJson(await summarize(f)(id),200));assert.deepEqual(f.counts,{native:1,poll:2,summary:1,unexpected:0});
}));

test('discarded job acknowledgement reuses the same URL submission and preserves source and operation history',async()=>usingFixture({},async f=>{
 // The first server response is deliberately discarded after its DB commit.
 assert.equal((await f.call('/api/jobs',{method:'POST',body:f.input})).status,202);
 const replay=await expectJson(await f.call('/api/jobs',{method:'POST',body:f.input}),202);assert.equal(replay.reused,true);assert.equal(replay.job.id,submission);
 await expectJson(await native(f)(submission),200);const stored=f.source(submission),quota=f.quota('supadata');f.reopen();
 const resumed=await expectJson(await f.call('/api/jobs',{method:'POST',body:f.input}),202);assert.equal(resumed.reused,true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,1);assert.deepEqual(f.source(submission),stored);assert.deepEqual(f.quota('supadata'),quota);assert.equal(f.counts.native,1);
}));

test('discarded native-save acknowledgement is recovered by owner readback without reacquiring captions',async()=>usingFixture({},async f=>{
 const job=await create(f);assert.equal((await native(f)(job.id)).status,200);const stored=f.source(job.id),quota=f.quota('supadata');f.reopen();
 const readback=await expectJson(await f.call(base(job.id)+'/source'),200);assert.deepEqual(readback.source.segments,source.segments);
 const replay=await f.call(base(job.id)+'/native',{method:'POST',body:{}});assert.equal(replay.status,409);assert.equal((await replay.json()).error.code,'NATIVE_SOURCE_EXISTS');
 assert.deepEqual(f.source(job.id),stored);assert.deepEqual(f.quota('supadata'),quota);assertApproved(await expectJson(await summarize(f)(job.id),200));assert.equal(f.counts.native,1);
}));

test('discarded final-save acknowledgement reopens and reuses the saved report without another generation',async()=>usingFixture({},async f=>{
 const job=await create(f);await expectJson(await native(f)(job.id),200);assert.equal((await summarize(f)(job.id)).status,200);
 const stored=f.job(job.id),quota=f.quota('gemini');f.reopen();const result=await expectJson(await f.call(base(job.id)),200);assert.equal(result.job.approvedSummaryView.sourceStatus,'MATCHED');
 const replay=await expectJson(await summarize(f)(job.id),200);assert.equal(replay.cached,true);assert.deepEqual(f.job(job.id),stored);assert.deepEqual(f.quota('gemini'),quota);assert.equal(f.counts.summary,1);
}));

test('uncertain caption request preserves its reservation and stops repeated dispatch and downstream generation',async()=>usingFixture({native:'uncertain'},async f=>{
 const job=await create(f);const interrupted=await native(f)(job.id);assert.equal(interrupted.status,500);assert.equal((await interrupted.json()).error.code,'LIVE_INTERNAL_ERROR');const quota=f.quota('supadata');
 assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(job.id+':native').state,'FAILED_UNCERTAIN');
 const readback=await expectJson(await f.call(base(job.id)),200);assert.equal(readback.job.audit.status,'CAPTION_RESULT_UNAVAILABLE');assert.equal(readback.job.audit.nativeAcquisition,'NO_STORED_RESULT');assert.doesNotMatch(readback.job.audit.reason,/아직 요청하지 않았/);
 assert.equal((await native(f)(job.id)).status,409);assert.equal((await summarize(f)(job.id)).status,400);assert.equal(f.source(job.id),undefined);assert.deepEqual(f.quota('supadata'),quota);assert.equal(f.counts.native,1);assert.equal(f.counts.summary,0);
}));

test('complete malformed model output is retained and repeating the request never regenerates it',async()=>usingFixture({model:'invalid'},async f=>{
 const job=await create(f);await expectJson(await native(f)(job.id),200);const stored=f.source(job.id);
 for(let i=0;i<2;i++){const bad=await summarize(f)(job.id);assert.equal(bad.status,409);assert.equal((await bad.json()).error.code,'REPORT_VALIDATION_FAILED');}
 assert.equal(f.counts.summary,1);assert.equal(JSON.parse(f.job(job.id).report_json),null);assert.deepEqual(f.source(job.id),stored);
 const op=f.db.prepare("SELECT state,result_json FROM yta_operations WHERE job_id=? AND provider='gemini'").get(job.id);assert.equal(op.state,'DONE');assert.equal(typeof JSON.parse(op.result_json).text,'string');
}));

test('changed source during a mocked generation cannot commit a summary or trigger an automatic retry',async()=>usingFixture({},async f=>{
 const job=await create(f);await expectJson(await native(f)(job.id),200);
 f.afterModel=()=>f.db.prepare('UPDATE yta_sources SET raw=? WHERE job_id=?').run('Synthetic changed raw source',job.id);
 const failed=await summarize(f)(job.id);assert.equal(failed.status,409);assert.equal((await failed.json()).error.code,'SUMMARY_INPUT_CHANGED');assert.equal(JSON.parse(f.job(job.id).report_json),null);assert.equal(f.counts.summary,1);
}));

test('owner auth and source ownership stay enforced across native, summary and saved readback paths',async()=>usingFixture({},async f=>{
 const job=await create(f);const before=f.job(job.id);
 assert.equal((await f.call(base(job.id),{email:'other@example.test'})).status,401);
 assert.equal((await f.call(base(job.id)+'/native',{method:'POST',body:{},requestOrigin:'https://foreign.invalid'})).status,403);
 f.db.prepare('UPDATE jobs SET owner_id=? WHERE id=?').run('synthetic-other-owner',job.id);
 for(const suffix of ['', '/source','/export?format=txt'])assert.equal((await f.call(base(job.id)+suffix)).status,404);
 assert.equal((await native(f)(job.id)).status,404);assert.equal((await summarize(f)(job.id)).status,404);assert.equal((await expectJson(await f.call('/api/jobs'),200)).jobs.length,0);
 assert.deepEqual(f.counts,{native:0,poll:0,summary:0,unexpected:0});assert.equal(f.job(job.id).report_json,before.report_json);
}));

test('declared duration mismatch fails without saving or treating captions as complete audio',async()=>usingFixture({durationSeconds:30},async f=>{
 const job=await create(f);for(let i=0;i<2;i++){const result=await native(f)(job.id);assert.equal(result.status,409);assert.equal((await result.json()).error.code,'CAPTION_OUTSIDE_DECLARED_DURATION');}
 assert.equal(f.source(job.id),undefined);assert.equal(JSON.parse(f.job(job.id).report_json),null);assert.equal(f.counts.native,1);assert.equal(f.counts.summary,0);
}));
