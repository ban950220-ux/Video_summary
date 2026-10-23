import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {encryptProviderKey} from '../src/vault.mjs';
import {TWO_PASS_MODEL} from '../src/gemini-two-pass-contract.mjs';

const req=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
const flags={confirmSeparateSummaryAttempt:true,confirmReuseStoredTranscript:true,acknowledgePriorCostAndUncertainty:true,acknowledgeDuplicateSummaryTokens:true,acknowledgeIndependentSnapshotRetention:true,confirmNoProviderCall:true};
export async function fixture({partial=false}={}){
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'source-attempt',modules:true,script:'export default {fetch(){return new Response("fixture")}}',d1Databases:{DB:'attempt-local'}}]})),DB=await mf.getD1Database('DB');
 for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0008_paid_summary_budget.sql','../migrations/0010_paid_summary_receipts.sql','../migrations/0015_gemini_two_pass.sql']){
  const text=readFileSync(new URL(file,import.meta.url),'utf8');for(const sql of text.split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(s=>s.trim()).filter(Boolean))await DB.prepare(sql).run();
 }
 const id='a69c6a73-6aa6-4ccb-a912-1fab0c35d6a9',stamp=new Date().toISOString(),segments=[{id:1,startMs:0,endMs:1000,text:'The speaker describes the first claim.'},{id:2,startMs:1000,endMs:2000,text:'The speaker qualifies the conclusion.'}],audit={status:partial?'PARTIAL_TRANSCRIPT':'TRANSCRIPT_UNVERIFIED',audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'d'.repeat(64),independentVerification:false};
 await DB.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Prior example','audio',?,?,?,?,'null',?)").bind(id,audit.status,partial?10:2,stamp,stamp,JSON.stringify(audit)).run();
 await DB.prepare("INSERT INTO yta_sources VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").bind(id,segments.map(s=>s.text).join('\n'),JSON.stringify(segments),stamp).run();
 for(let i=0;i<7;i++)await DB.prepare("INSERT INTO yta_operations VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'PERSISTENCE_UNKNOWN',?)").bind(id+':old:'+i,id,stamp,JSON.stringify({fixture:true,originalResponse:'preserve this historical response'})).run();
 await DB.prepare("INSERT INTO yta_paid_summary_approvals VALUES(?,?,'owner',?,?,?,'gemini-fixture','fixture','fixture',10000,10000,1,1,'APPROVED',?)").bind('old-approval',id,'a'.repeat(64),'b'.repeat(64),'{}',stamp).run();
 await DB.prepare("INSERT INTO yta_paid_summary_reservations VALUES('old-reservation','old-approval',0,10000,1234,'{}','REPORT_NOT_SAVED','SETTLED',?)").bind(stamp).run();
 const root=Buffer.alloc(32,9),secret=await encryptProviderKey(root,'gemini','OFFLINE_ONLY_KEY');await DB.prepare("INSERT INTO provider_credentials VALUES('owner','gemini',?,?,?,?)").bind(secret.version,secret.ivB64,secret.ciphertextB64,stamp).run();
 const calls={model:0,count:0,generate:0};
 const report={summary:[{text:'The speaker qualifies the main claim.',evidenceIds:[1,2]}],chapters:[{windowKey:'w000',kind:'CONTENT',text:'The first claim is followed by a qualified conclusion.',evidenceIds:[1,2]}],claims:[],numbers:[],critical:[],conclusion:'A qualified conclusion is given.'};
 const env={DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_GEMINI_TWO_PASS:'true',ENABLE_GEMINI_TWO_PASS_PAID:'true',GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED:'true',GEMINI_TWO_PASS_ALLOWED_JOB_ID:id,ALLOW_PAID_API:'false',GEMINI_TWO_PASS_COST_BUFFER_APPROVED:'true',GEMINI_TWO_PASS_TEST_PROVIDER:{getModel:async()=>{calls.model++;return {name:`models/${TWO_PASS_MODEL}`,supportedGenerationMethods:['generateContent'],inputTokenLimit:1048576,outputTokenLimit:65536};},countTokens:async()=>{calls.count++;return 300;},generate:async()=>{calls.generate++;const responseText=JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(calls.generate===1?report:{verdict:'PASS',issues:[]})}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:100,thoughtsTokenCount:10,totalTokenCount:410}});return {responseText,responseBytes:Buffer.byteLength(responseText),httpStatus:200,complete:true};}}};
 const path='/api/jobs/'+id,api=(suffix='',method='GET',body,override=env)=>routeApi(req(path+suffix,method,body),override);
 const capture=async()=>{const result={};for(const [table,where] of [['jobs','id=?'],['yta_sources','job_id=?'],['yta_operations','job_id=?'],['usage_events','job_id=?'],['yta_paid_summary_approvals','job_id=?'],['yta_paid_summary_reservations',"approval_id='old-approval'"]])result[table]=(await DB.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY 1`).bind(...(where.includes('?')?[id]:[])).all()).results;return result;};
 const review=async()=>{const r=await api('/source-summary-attempt');assert.equal(r.status,200,await r.clone().text());return r.json();};
 const body=async()=>({requestId:crypto.randomUUID(),evidenceSha256:(await review()).evidenceSha256,...flags});
 return {mf,DB,env,id,path,api,calls,segments,audit,capture,review,body};
}

for(const partial of [false,true])test('separate summary snapshot preserves original costs, uncertainty and quality; full fixture flow '+partial,async()=>{
 const f=await fixture({partial});try{
  const {DB,env,calls}=f,before=await f.capture(),review=await f.review(),body=await f.body();assert.equal(review.disclosure.uncertainOperations,7);assert.deepEqual(review.disclosure.paidReservations,[{state:'SETTLED',outcome:'REPORT_NOT_SAVED'}]);
  const result=await f.api('/source-summary-attempt','POST',body);assert.equal(result.status,200,await result.clone().text());const child=(await result.json()).childJobId,base='/api/jobs/'+child;
  assert.deepEqual(calls,{model:0,count:0,generate:0});assert.deepEqual(await f.capture(),before);
  const source=(await DB.prepare('SELECT * FROM yta_sources WHERE job_id=?').bind(child).first());assert.equal(source.raw,before.yta_sources[0].raw);assert.equal(source.segments_json,before.yta_sources[0].segments_json);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM yta_audio WHERE job_id=?').bind(child).first()).n,0);
  const again=await f.api('/source-summary-attempt','POST',body);assert.equal(again.status,200);assert.equal((await again.json()).childJobId,child);
  assert.equal((await f.api('/source-summary-attempt','POST',{...body,requestId:crypto.randomUUID()})).status,409);
  for(const action of ['audio-plan','audio-chunk','audio-finish','native','summary','paid-summary-execute','groq-summary','groq-full-coverage','source-summary-attempt'])assert.equal((await routeApi(req(base+'/'+action,'POST',{}),env)).status,409,action);
  const quoteBody={projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true};
  assert.equal((await routeApi(req(base+'/gemini-two-pass-quote','POST',quoteBody),env)).status,409);assert.equal(calls.model,0);
  // Explicit fixture-only operator scope change. Production requires its own review.
  env.GEMINI_TWO_PASS_ALLOWED_JOB_ID=child;
  const issued=await routeApi(req(base+'/gemini-two-pass-quote','POST',quoteBody),env);assert.equal(issued.status,200,await issued.clone().text());const q=(await issued.json()).quote;
  assert.equal((await routeApi(req(base+'/gemini-two-pass-approve','POST',{quoteSha256:q.quoteSha256,maxMicroUsd:q.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true}),env)).status,200);
  for(const phase of [0,1]){const response=await routeApi(req(base+'/gemini-two-pass-run','POST',{phase,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true}),env);assert.equal(response.status,200,await response.clone().text());}
  const status=await(await routeApi(req(base+'/gemini-two-pass-status'),env)).json();
  const accept={confirmNoProviderCall:true,confirmSourceBasedSummary:true,acknowledgeTranscriptionUnverified:true,acknowledgeSemanticReviewUnverified:true,sourceSha256:q.sourceSha256,auditSha256:status.auditSha256,sourceAssessmentSha256:status.sourceAssessmentSha256,quoteSha256:q.quoteSha256,reviewReceiptSha256:status.calls[1].responseSha256};
  const accepted=await routeApi(req(base+'/gemini-two-pass-accept','POST',accept),env);assert.equal(accepted.status,200,await accepted.clone().text());
  const saved=(await(await routeApi(req(base),env)).json()).job;assert.equal(saved.report.sourceOrigin.originalJobId,f.id);assert.equal(saved.report.summaryCompletion,'COMPLETE');assert.equal(saved.status,partial?'PARTIAL_TRANSCRIPT':'TRANSCRIPT_UNVERIFIED');assert.equal(saved.report.audioAccuracy,'NOT_VERIFIED');
  const txt=await(await routeApi(req(base+'/export?format=txt'),env)).text();assert.match(txt,new RegExp(f.id));assert.match(txt,/REPORT_NOT_SAVED/);assert.match(txt,/AUTO_CHECK_PASSED_HUMAN_UNREVIEWED/);
  assert.deepEqual(calls,{model:1,count:3,generate:2});assert.deepEqual(await f.capture(),before);
  assert.equal((await routeApi(req(base+'/gemini-two-pass-run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true}),env)).status,409);assert.equal(calls.generate,2);
 }finally{await f.mf.dispose();}
});

test('race, stale evidence, unknown body, single slot, deletion and ACK loss',async()=>{
 const f=await fixture();try{
  const body=await f.body(),before=await f.capture();
  assert.equal((await f.api('/source-summary-attempt','POST',{...body,authorization:'fake'})).status,409);
  let fired=false;const raced={...f.env,DB:{prepare:sql=>f.DB.prepare(sql),async batch(queries){fired=true;await f.DB.prepare("UPDATE yta_operations SET error_code='LATE_CHANGE' WHERE id=?").bind(f.id+':old:0').run();return f.DB.batch(queries);}}};
  assert.notEqual((await f.api('/source-summary-attempt','POST',body,raced)).status,200);assert.equal(fired,true);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM jobs').first()).n,1);
  assert.equal((await f.DB.prepare('SELECT error_code FROM yta_operations WHERE id=?').bind(f.id+':old:0').first()).error_code,'LATE_CHANGE');
  const fresh=await f.body();assert.notEqual((await f.api('/source-summary-attempt','POST',body)).status,200);
  const postCommit={...f.env,DB:{prepare:sql=>f.DB.prepare(sql),async batch(queries){await f.DB.batch(queries);throw Error('LOST_ACK');}}};
  assert.equal((await f.api('/source-summary-attempt','POST',fresh,postCommit)).status,200);
  const stored=await f.DB.prepare('SELECT COUNT(*) n FROM jobs').first();assert.equal(stored.n,2);
  assert.equal((await routeApi(req('/api/jobs/'+fresh.requestId,'DELETE'),f.env)).status,200);
  assert.equal((await f.api('/source-summary-attempt','POST',fresh)).status,409);
  assert.deepEqual(f.calls,{model:0,count:0,generate:0});assert.equal((await f.capture()).yta_paid_summary_reservations[0].usage_json,before.yta_paid_summary_reservations[0].usage_json);
 }finally{await f.mf.dispose();}
});

test('different request IDs racing create only one snapshot',async()=>{
 const f=await fixture();try{const body=await f.body();const responses=await Promise.all([f.api('/source-summary-attempt','POST',body),f.api('/source-summary-attempt','POST',{...body,requestId:crypto.randomUUID()})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM jobs').first()).n,2);}finally{await f.mf.dispose();}
});

test('registry change immediately before metadata transition stops all external calls',async()=>{
 const f=await fixture();try{
  const body=await f.body();assert.equal((await f.api('/source-summary-attempt','POST',body)).status,200);const child=body.requestId;f.env.GEMINI_TWO_PASS_ALLOWED_JOB_ID=child;
  let fired=false;const DB={prepare(sql){const stmt=f.DB.prepare(sql);if(!sql.startsWith('UPDATE yta_operations SET state=?,result_json=? WHERE id=? AND job_id=?'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async run(){if(!fired){fired=true;await f.DB.prepare("UPDATE yta_operations SET error_code='ORIGIN_TAMPERED' WHERE job_id=? AND provider='source-summary-attempt-v1'").bind(child).run();}return bound.run();}};}};}};
  const response=await routeApi(req('/api/jobs/'+child+'/gemini-two-pass-quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true}),{...f.env,DB});assert.equal(response.status,409,await response.clone().text());assert.equal(fired,true);assert.deepEqual(f.calls,{model:0,count:0,generate:0});
 }finally{await f.mf.dispose();}
});

for(const point of ['count','quote-save','generate','accept'])test('immutable lineage CAS rejects late registry change at '+point,async()=>{
 const f=await fixture();try{
  const body=await f.body();assert.equal((await f.api('/source-summary-attempt','POST',body)).status,200);const child=body.requestId,base='/api/jobs/'+child;f.env.GEMINI_TWO_PASS_ALLOWED_JOB_ID=child;
  let fired=false,armed=point==='count'||point==='quote-save';
  const DB={prepare(sql){const statement=f.DB.prepare(sql);return {first:(...args)=>statement.first(...args),all:(...args)=>statement.all(...args),run:(...args)=>statement.run(...args),bind(...args){const bound=statement.bind(...args);return {...bound,first:()=>bound.first(),all:()=>bound.all(),async run(){const target=point==='count'?sql.startsWith('UPDATE yta_operations SET state=?,result_json=? WHERE id=? AND job_id=?')&&args[0]==='COUNT_SENT':point==='quote-save'?sql.startsWith('INSERT OR IGNORE INTO yta_gemini_two_pass_jobs'):point==='generate'?sql.startsWith("UPDATE yta_gemini_two_pass_calls SET state='DISPATCHING'"):sql.startsWith('UPDATE jobs SET report_json=?,status=?');if(armed&&!fired&&target){fired=true;await f.DB.prepare("UPDATE yta_operations SET error_code='LATE_ORIGIN_CHANGE' WHERE job_id=? AND provider='source-summary-attempt-v1'").bind(child).run();}return bound.run();}};}};},batch:queries=>f.DB.batch(queries)};
  const env={...f.env,DB};
  const issued=await routeApi(req(base+'/gemini-two-pass-quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true}),env);
  if(point==='count'||point==='quote-save'){assert.equal(issued.status,409,await issued.clone().text());assert.equal(fired,true);assert.equal(f.calls.count,point==='count'?0:1);assert.equal(f.calls.generate,0);assert.equal(await f.DB.prepare('SELECT job_id FROM yta_gemini_two_pass_jobs WHERE job_id=?').bind(child).first(),null);return;}
  assert.equal(issued.status,200,await issued.clone().text());const q=(await issued.json()).quote;
  assert.equal((await routeApi(req(base+'/gemini-two-pass-approve','POST',{quoteSha256:q.quoteSha256,maxMicroUsd:q.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true}),env)).status,200);
  if(point==='generate')armed=true;
  for(const phase of [0,1]){const r=await routeApi(req(base+'/gemini-two-pass-run','POST',{phase,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true}),env);if(point==='generate'){assert.equal(r.status,409,await r.clone().text());assert.equal(fired,true);assert.equal(f.calls.generate,0);return;}assert.equal(r.status,200,await r.clone().text());}
  const status=await(await routeApi(req(base+'/gemini-two-pass-status'),env)).json();armed=true;
  const r=await routeApi(req(base+'/gemini-two-pass-accept','POST',{confirmNoProviderCall:true,confirmSourceBasedSummary:true,acknowledgeTranscriptionUnverified:true,acknowledgeSemanticReviewUnverified:true,sourceSha256:q.sourceSha256,auditSha256:status.auditSha256,sourceAssessmentSha256:status.sourceAssessmentSha256,quoteSha256:q.quoteSha256,reviewReceiptSha256:status.calls[1].responseSha256}),env);
  assert.equal(r.status,409,await r.clone().text());assert.equal(fired,true);assert.equal(f.calls.generate,2);assert.equal((await f.DB.prepare('SELECT report_json FROM jobs WHERE id=?').bind(child).first()).report_json,null);
 }finally{await f.mf.dispose();}
});

test('original deletion retains the explicitly independent snapshot; child deletion scrubs it',async()=>{
 const f=await fixture();try{const body=await f.body();assert.equal((await f.api('/source-summary-attempt','POST',body)).status,200);assert.equal((await f.api('','DELETE')).status,200);const child=(await(await routeApi(req('/api/jobs/'+body.requestId),f.env)).json()).job;assert.equal(child.audit.sourceSummaryOrigin.originalJobId,f.id);assert.ok((await f.DB.prepare("SELECT result_json FROM yta_operations WHERE job_id=? AND provider='source-summary-attempt-v1'").bind(body.requestId).first()).result_json);assert.equal((await routeApi(req('/api/jobs/'+body.requestId,'DELETE'),f.env)).status,200);assert.equal((await f.DB.prepare("SELECT result_json FROM yta_operations WHERE job_id=? AND provider='source-summary-attempt-v1'").bind(body.requestId).first()).result_json,null);}finally{await f.mf.dispose();}
});

// Independent review reproductions retained as regression tests.
const call=(f,child,action,body)=>routeApi(new Request('https://fixture.invalid/api/jobs/'+child+'/gemini-two-pass-'+action,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),f.env);
const quoteBody={projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true};
async function create(f){const b=await f.body();assert.equal((await f.api('/source-summary-attempt','POST',b)).status,200);f.env.GEMINI_TWO_PASS_ALLOWED_JOB_ID=b.requestId;return b.requestId;}
test('independent: canonical error before child quote INSERT cannot leave an approvable quote',async()=>{
 const f=await fixture();try{
  const child=await create(f),DB=f.DB;let changed=false;
  f.env.DB={prepare(sql){const wrap=s=>new Proxy(s,{get(t,k){if(k==='bind')return(...v)=>wrap(t.bind(...v));if(k==='run')return async()=>{if(!changed&&sql.startsWith('INSERT OR IGNORE INTO yta_gemini_two_pass_jobs')){changed=true;await DB.prepare("UPDATE yta_operations SET error_code='LATE_CANONICAL_UNCERTAINTY' WHERE id=?").bind(child+':gemini-two-pass-quote').run();}return t.run();};const v=t[k];return typeof v==='function'?v.bind(t):v;}});return wrap(DB.prepare(sql));},batch:list=>DB.batch(list)};
  const quoted=await call(f,child,'quote',quoteBody);f.env.DB=DB;
  const row=await DB.prepare('SELECT * FROM yta_gemini_two_pass_jobs WHERE job_id=?').bind(child).first();
  const q=(await(await call(f,child,'status')).json()).quote;
  let approved=null,run=null;
  if(q){approved=await call(f,child,'approve',{quoteSha256:q.quoteSha256,maxMicroUsd:q.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true});run=await call(f,child,'run',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});}
  const canonical=await DB.prepare('SELECT state,error_code FROM yta_operations WHERE id=?').bind(child+':gemini-two-pass-quote').first();
  console.log('REPRO_QUOTE_CANONICAL_ERROR',JSON.stringify({changed,quoteStatus:quoted.status,quoteRowState:row?.state,approvalStatus:approved?.status,runStatus:run?.status,calls:f.calls,canonical}));
  assert.equal(changed,true);assert.equal(row,null,'uncertain quote must not become approvable');
 }finally{await f.mf.dispose();}
});
for(const column of ['created_at','result_json'])test('independent: canonical '+column+' change during metadata cannot be adopted',async()=>{
 const f=await fixture();try{
  const child=await create(f),original=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.getModel;let changed=false;
  f.env.GEMINI_TWO_PASS_TEST_PROVIDER.getModel=async(...args)=>{const value=await original(...args);changed=true;if(column==='created_at')await f.DB.prepare("UPDATE yta_operations SET created_at='LATE_CANONICAL_TIME' WHERE id=?").bind(child+':gemini-two-pass-quote').run();else await f.DB.prepare("UPDATE yta_operations SET result_json=json_set(result_json,'$.sourceSha256','MUTATED_SOURCE_BINDING') WHERE id=?").bind(child+':gemini-two-pass-quote').run();return value;};
  const response=await call(f,child,'quote',quoteBody),canonical=await f.DB.prepare('SELECT state,created_at,result_json FROM yta_operations WHERE id=?').bind(child+':gemini-two-pass-quote').first();
  console.log('REPRO_CANONICAL_ADOPTION',JSON.stringify({column,status:response.status,calls:f.calls,state:canonical.state,createdAt:canonical.created_at,proofSource:JSON.parse(canonical.result_json).sourceSha256}));
  assert.equal(changed,true,'metadata mutation must be reached');assert.notEqual(response.status,200);assert.equal(f.calls.count,0);
 }finally{await f.mf.dispose();}
});
