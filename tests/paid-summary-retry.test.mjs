import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fullSummaryRequest} from '../src/paid-summary-contract.mjs';
import {summaryInputAudit,promptAudit} from '../src/groq-summary.mjs';
import {routeApi} from '../src/worker.mjs';
import {handleSiteRequest} from '../src/site-worker.mjs';
import {runPaidGeminiFullSummary} from '../src/paid-summary-adapter.mjs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {encryptProviderKey} from '../src/vault.mjs';

const call=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
async function fixture(){
 const db=new DatabaseSync(':memory:');
 for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0008_paid_summary_budget.sql','../migrations/0009_paid_first_trial.sql','../migrations/0010_paid_summary_receipts.sql','../migrations/0011_paid_summary_retry.sql'])db.exec(readFileSync(new URL(file,import.meta.url),'utf8'));
 const DB={prepare(sql){const make=args=>({bind(...next){return make(next);},async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}});return make([]);}};
 const id='22222222-2222-4222-8222-222222222222',path='/api/jobs/'+id,segments=[{id:1,startMs:0,endMs:1000,text:'첫 발언'},{id:2,startMs:1000,endMs:2000,text:'둘째 발언'}],stamp=new Date().toISOString();
 db.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Paid retry mock','audio','TRANSCRIBED',2,?,?,'null',?)").run(id,stamp,stamp,JSON.stringify({audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)}));
 db.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").run(id,segments.map(s=>s.text).join('\n'),JSON.stringify(segments),stamp);
 const root=Buffer.alloc(32,7),key=await encryptProviderKey(root,'gemini','OFFLINE_MOCK_KEY');
 db.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','gemini',?,?,?,?)").run(key.version,key.ivB64,key.ciphertextB64,stamp);
 const oldQuote={model:'gemini-3.1-flash-lite'},job={duration_seconds:2,audit:JSON.parse(db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(id).audit_json)},source={raw:segments.map(s=>s.text).join('\n'),segments,segments_json:JSON.stringify(segments)};
 const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),sourceSha=digest({raw:source.raw,segmentsJson:source.segments_json,auditJson:JSON.stringify(summaryInputAudit(job.audit))}),requestSha=digest(fullSummaryRequest(source,promptAudit(job)).body);
 db.prepare("INSERT INTO yta_paid_summary_approvals(id,job_id,owner_id,source_sha256,quote_sha256,quote_json,model,price_version,credential_generation,max_micro_usd,max_call_micro_usd,max_calls,expires_at,state,created_at) VALUES(?,?,'owner',?,?,?,?,?,?,720896,720896,1,?,'APPROVED',?)").run('old-approval',id,sourceSha,'b'.repeat(64),JSON.stringify(oldQuote),oldQuote.model,'old-price','old-key',Date.now()+600000,stamp);
 db.prepare("INSERT INTO yta_paid_summary_reservations(id,approval_id,call_index,reserved_micro_usd,token_estimate_micro_usd,usage_json,outcome,state,created_at) VALUES(? ,?,0,720896,19,?,'REPORT_NOT_SAVED','SETTLED',?)").run('old-reservation','old-approval',JSON.stringify({promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}),stamp);
 db.prepare("INSERT INTO yta_paid_first_trial(id,approval_id,job_id,source_sha256,request_sha256,quote_sha256,model,credential_generation,expires_at,max_calls,max_micro_usd,evidence_json,state,created_at,consumed_at) VALUES('FIRST_GENERATION',?,?,?,?,?,?,?,?,1,720896,?,'CONSUMED',?,?)").run('old-approval',id,sourceSha,requestSha,'b'.repeat(64),oldQuote.model,'old-key',Date.now()+600000,'{}',stamp,stamp);
 const env={DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_PAID_SUMMARY:'false',ALLOW_PAID_API:'false'};
 const api=async(action,method='GET',body)=>routeApi(call(path+'/'+action,method,body),env);
 return {db,DB,id,path,env,api};
}
const report={summary:[{text:'첫 발언과 둘째 발언을 종합했다',evidenceIds:[1,2]}],chapters:[{text:'첫 발언',evidenceIds:[1]},{text:'둘째 발언',evidenceIds:[2]}],claims:[],numbers:[],critical:[],conclusion:'발언 두 개를 요약했다'};
const paidGate=env=>Object.assign(env,{ENABLE_PAID_SUMMARY:'true',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_MODEL_ACCESS_VERIFIED:'true',PAID_TAX_MAX_BPS_VERIFIED:'true'});

test('a separate one-call approval preserves consumed first-trial cost and saves report',async()=>{
 const f=await fixture();try{
  const initial=await(await f.api('paid-retry-status')).json();assert.equal(initial.firstTrial.tokenEstimateMicroUsd,19);assert.equal(initial.quoteIssueReady,true);assert.equal(initial.attempt,null);
  const quotedResponse=await f.api('paid-retry-quote','POST',{});assert.equal(quotedResponse.status,200,await quotedResponse.clone().text());const issued=await quotedResponse.json();
  const body={quoteId:issued.quoteId,priorReservationId:'old-reservation',maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmPriorCostPreserved:true,confirmNoAutomaticRetry:true,confirmNoAutomaticFallback:true};
  const blocked=await f.api('paid-retry-approve','POST',body);assert.equal((await blocked.json()).error.code,'PAID_EXECUTION_DISABLED');
  paidGate(f.env);const approvedResponse=await f.api('paid-retry-approve','POST',body);assert.equal(approvedResponse.status,200,await approvedResponse.clone().text());const approved=await approvedResponse.json();
  const duplicate=await f.api('paid-retry-approve','POST',body);assert.notEqual(duplicate.status,200);
  let calls=0;f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();calls++;return {text:JSON.stringify(report),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}};};
  const executed=await f.api('paid-retry-execute','POST',{attemptId:approved.attemptId});assert.equal(executed.status,200,await executed.clone().text());assert.equal(calls,1);
  const second=await f.api('paid-retry-execute','POST',{attemptId:approved.attemptId});assert.notEqual(second.status,200);assert.equal(calls,1);
  const status=await(await f.api('paid-retry-status')).json();assert.equal(status.firstTrial.tokenEstimateMicroUsd,19);assert.equal(status.firstTrial.trialState,'CONSUMED');assert.equal(status.attempt.state,'SETTLED');assert.equal(status.attempt.outcome,'REPORT_SAVED');assert.equal(status.finalReportSaved,true);assert.equal(status.providerInvoiceAmount,'UNKNOWN');
  const old=f.db.prepare('SELECT state,outcome,token_estimate_micro_usd FROM yta_paid_summary_reservations WHERE id=?').get('old-reservation');assert.deepEqual({...old},{state:'SETTLED',outcome:'REPORT_NOT_SAVED',token_estimate_micro_usd:19});
  const txt=await(await f.api('export?format=txt')).text();assert.match(txt,/첫 발언/);
  const deleted=await routeApi(call(f.path,'DELETE'),f.env);assert.equal(deleted.status,200,await deleted.clone().text());
  const scrubbed=f.db.prepare('SELECT response_json,response_sha256,response_complete,state FROM yta_paid_retry_receipts WHERE attempt_id=?').get(approved.attemptId);assert.equal(scrubbed.response_json,null);assert.equal(scrubbed.response_sha256,null);assert.equal(scrubbed.response_complete,0);assert.equal(scrubbed.state,'SOURCE_DELETED');
 }finally{f.db.close();}
});


test('retained first response and nonterminal first reservation block a new call',async()=>{
 const f=await fixture();try{
  f.db.prepare("INSERT INTO yta_paid_summary_receipts(reservation_id,job_id,owner_id,source_sha256,request_sha256,quote_sha256,response_sha256,response_bytes,response_json,response_complete,http_status,state,created_at,updated_at) VALUES(?,?,'owner',?,?,?,?,?,?,1,200,'VALIDATION_FAILED',?,?)").run('old-reservation',f.id,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'d'.repeat(64),2,'{}',new Date().toISOString(),new Date().toISOString());
  const status=await(await f.api('paid-retry-status')).json();assert.equal(status.blockedReason,'PAID_REVALIDATION_FIRST');
  const blocked=await f.api('paid-retry-quote','POST',{});assert.equal((await blocked.json()).error.code,'PAID_REVALIDATION_FIRST');
  f.db.prepare('DELETE FROM yta_paid_summary_receipts').run();f.db.prepare("UPDATE yta_paid_summary_reservations SET state='UNCERTAIN' WHERE id='old-reservation'").run();
  const uncertain=await f.api('paid-retry-quote','POST',{});assert.equal((await uncertain.json()).error.code,'PAID_RETRY_PRIOR_NOT_TERMINAL');
 }finally{f.db.close();}
});

test('key change after approval releases reserved retry without provider fetch',async()=>{
 const f=await fixture();try{
  paidGate(f.env);const issued=await(await f.api('paid-retry-quote','POST',{})).json();
  const approvedResponse=await f.api('paid-retry-approve','POST',{quoteId:issued.quoteId,priorReservationId:'old-reservation',maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmPriorCostPreserved:true,confirmNoAutomaticRetry:true,confirmNoAutomaticFallback:true});assert.equal(approvedResponse.status,200,await approvedResponse.clone().text());const approved=await approvedResponse.json();
  let fetched=0;f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{f.db.prepare("UPDATE provider_credentials SET updated_at=? WHERE owner_id='owner' AND provider='gemini'").run(new Date(Date.now()+1000).toISOString());await beforeFetch();fetched++;throw Error('MUST_NOT_FETCH');};
  const blocked=await f.api('paid-retry-execute','POST',{attemptId:approved.attemptId});assert.notEqual(blocked.status,200);assert.equal(fetched,0);
  const state=f.db.prepare('SELECT state,outcome FROM yta_paid_retry_attempts WHERE id=?').get(approved.attemptId);assert.equal(state.state,'RELEASED');assert.equal(state.outcome,'PROVEN_NOT_SENT');assert.equal(f.db.prepare("SELECT state FROM yta_paid_first_trial WHERE id='FIRST_GENERATION'").get().state,'CONSUMED');
 }finally{f.db.close();}
});

test('bad second response keeps a full receipt and revalidation never calls provider',async()=>{
 const f=await fixture();try{
  paidGate(f.env);const issued=await(await f.api('paid-retry-quote','POST',{})).json();
  const approved=await(await f.api('paid-retry-approve','POST',{quoteId:issued.quoteId,priorReservationId:'old-reservation',maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmPriorCostPreserved:true,confirmNoAutomaticRetry:true,confirmNoAutomaticFallback:true})).json();
  let fetched=0;f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();fetched++;return {text:'{}',usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}};};
  const failed=await f.api('paid-retry-execute','POST',{attemptId:approved.attemptId});assert.notEqual(failed.status,200);assert.equal(fetched,1);
  const stored=f.db.prepare('SELECT state,response_complete,response_json FROM yta_paid_retry_receipts WHERE attempt_id=?').get(approved.attemptId);assert.equal(stored.state,'VALIDATION_FAILED');assert.equal(stored.response_complete,1);assert.match(stored.response_json,/usageMetadata/);
  const before=f.db.prepare('SELECT state,usage_json,token_estimate_micro_usd FROM yta_paid_retry_attempts WHERE id=?').get(approved.attemptId);assert.equal(before.state,'SETTLED');
  const again=await f.api('paid-retry-revalidate','POST',{attemptId:approved.attemptId,confirmNoProviderCall:true});assert.notEqual(again.status,200);assert.equal(fetched,1);
  const after=f.db.prepare('SELECT state,usage_json,token_estimate_micro_usd FROM yta_paid_retry_attempts WHERE id=?').get(approved.attemptId);assert.deepEqual({...after},{...before});
 }finally{f.db.close();}
});

test('a complete second receipt can recover from RESERVED with zero new calls and keeps review cost state',async()=>{
 const f=await fixture();try{
  paidGate(f.env);const issued=await(await f.api('paid-retry-quote','POST',{})).json();
  const approved=await(await f.api('paid-retry-approve','POST',{quoteId:issued.quoteId,priorReservationId:'old-reservation',maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmPriorCostPreserved:true,confirmNoAutomaticRetry:true,confirmNoAutomaticFallback:true})).json();
  let fetched=0;f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();fetched++;return {text:JSON.stringify(report),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}};};
  assert.equal((await f.api('paid-retry-execute','POST',{attemptId:approved.attemptId})).status,200);
  f.db.prepare("UPDATE jobs SET report_json='null',status='TRANSCRIBED',audit_json=json_remove(audit_json,'$.summaryProvider','$.externalFactCheck') WHERE id=?").run(f.id);
  f.db.prepare("UPDATE yta_paid_retry_attempts SET state='RESERVED',outcome=NULL,usage_json=NULL,token_estimate_micro_usd=NULL WHERE id=?").run(approved.attemptId);
  f.db.prepare("UPDATE yta_paid_retry_receipts SET state='RECEIVED' WHERE attempt_id=?").run(approved.attemptId);
  const before=await(await f.api('paid-retry-status')).json();assert.equal(before.receipt.revalidationAvailable,true);assert.equal(before.attempt.state,'RESERVED');
  const result=await f.api('paid-retry-revalidate','POST',{attemptId:approved.attemptId,confirmNoProviderCall:true});assert.equal(result.status,200,await result.clone().text());assert.equal(fetched,1);
  const after=await(await f.api('paid-retry-status')).json();assert.equal(after.finalReportSaved,true);assert.equal(after.attempt.state,'RESERVED');assert.equal(after.receipt.state,'SAVED');
 }finally{f.db.close();}
});

test('second approval cancels separately and leaves first cost ledger unchanged',async()=>{
 const f=await fixture();try{
  paidGate(f.env);const issued=await(await f.api('paid-retry-quote','POST',{})).json();
  const approved=await(await f.api('paid-retry-approve','POST',{quoteId:issued.quoteId,priorReservationId:'old-reservation',maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmPriorCostPreserved:true,confirmNoAutomaticRetry:true,confirmNoAutomaticFallback:true})).json();
  const firstBefore={...f.db.prepare("SELECT state,outcome,token_estimate_micro_usd FROM yta_paid_summary_reservations WHERE id='old-reservation'").get()};
  const cancelled=await f.api('paid-retry-cancel','POST',{attemptId:approved.attemptId,confirmCancelSecondAttempt:true});assert.equal(cancelled.status,200,await cancelled.clone().text());
  const state=await(await f.api('paid-retry-status')).json();assert.equal(state.attempt.state,'CANCELLED');assert.equal(state.firstTrial.trialState,'CONSUMED');assert.equal(state.cancelReady,false);assert.deepEqual({...f.db.prepare("SELECT state,outcome,token_estimate_micro_usd FROM yta_paid_summary_reservations WHERE id='old-reservation'").get()},firstBefore);
  let fetched=0;f.env.PAID_SUMMARY_TEST_RUNNER=async()=>{fetched++;throw Error('MUST_NOT_CALL');};const blocked=await f.api('paid-retry-execute','POST',{attemptId:approved.attemptId});assert.notEqual(blocked.status,200);assert.equal(fetched,0);
  const again=await f.api('paid-retry-cancel','POST',{attemptId:approved.attemptId,confirmCancelSecondAttempt:true});assert.notEqual(again.status,200);
 }finally{f.db.close();}
});


test('concurrent approval and execute still admit one real adapter fetch',async()=>{
 const f=await fixture();try{
  paidGate(f.env);const issued=await(await f.api('paid-retry-quote','POST',{})).json();
  const body={quoteId:issued.quoteId,priorReservationId:'old-reservation',maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmPriorCostPreserved:true,confirmNoAutomaticRetry:true,confirmNoAutomaticFallback:true};
  const approvals=await Promise.all([f.api('paid-retry-approve','POST',body),f.api('paid-retry-approve','POST',body)]);assert.equal(approvals.filter(item=>item.status===200).length,1);
  const approved=await approvals.find(item=>item.status===200).json();let fetches=0;
  f.env.PAID_SUMMARY_TEST_RUNNER=options=>runPaidGeminiFullSummary({...options,fetchFn:async()=>{fetches++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20},modelVersion:'mock'});}});
  const executions=await Promise.all([f.api('paid-retry-execute','POST',{attemptId:approved.attemptId}),f.api('paid-retry-execute','POST',{attemptId:approved.attemptId})]);assert.equal(executions.filter(item=>item.status===200).length,1);assert.equal(fetches,1);
  const receipt=f.db.prepare('SELECT response_complete,state FROM yta_paid_retry_receipts WHERE attempt_id=?').get(approved.attemptId);assert.equal(receipt.response_complete,1);assert.equal(receipt.state,'SAVED');
 }finally{f.db.close();}
});

test('final awaited D1 expiry check and failed receipt write stop unsafe replay',async()=>{
 const f=await fixture();try{
  paidGate(f.env);const issued=await(await f.api('paid-retry-quote','POST',{})).json();const body={quoteId:issued.quoteId,priorReservationId:'old-reservation',maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmPriorCostPreserved:true,confirmNoAutomaticRetry:true,confirmNoAutomaticFallback:true};
  const approved=await(await f.api('paid-retry-approve','POST',body)).json();let fetches=0;
  const originalDB=f.env.DB;f.env.DB={prepare(sql){const statement=originalDB.prepare(sql);if(!sql.startsWith('SELECT a.expires_at FROM yta_paid_retry_attempts'))return statement;return {bind(...args){const bound=statement.bind(...args);return {async first(){const row=await bound.first();return {...row,expires_at:Date.now()-1};}};}};}};
  f.env.PAID_SUMMARY_TEST_RUNNER=options=>runPaidGeminiFullSummary({...options,fetchFn:async()=>{fetches++;throw Error('MUST_NOT_FETCH');}});
  const expired=await f.api('paid-retry-execute','POST',{attemptId:approved.attemptId});assert.notEqual(expired.status,200);assert.equal(fetches,0);assert.equal(f.db.prepare('SELECT state FROM yta_paid_retry_attempts WHERE id=?').get(approved.attemptId).state,'RELEASED');
 }finally{f.db.close();}
 const g=await fixture();try{
  paidGate(g.env);const issued=await(await g.api('paid-retry-quote','POST',{})).json();const approved=await(await g.api('paid-retry-approve','POST',{quoteId:issued.quoteId,priorReservationId:'old-reservation',maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmPriorCostPreserved:true,confirmNoAutomaticRetry:true,confirmNoAutomaticFallback:true})).json();
  let fetches=0;const originalDB=g.env.DB;g.env.DB={prepare(sql){if(sql.startsWith('INSERT OR IGNORE INTO yta_paid_retry_receipts'))return {bind(){return {async run(){throw Error('OFFLINE_RECEIPT_WRITE_FAILURE');}};}};return originalDB.prepare(sql);}};
  g.env.PAID_SUMMARY_TEST_RUNNER=options=>runPaidGeminiFullSummary({...options,fetchFn:async()=>{fetches++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}});}});
  const failed=await g.api('paid-retry-execute','POST',{attemptId:approved.attemptId});assert.notEqual(failed.status,200);assert.equal(fetches,1);assert.equal(g.db.prepare('SELECT state FROM yta_paid_retry_attempts WHERE id=?').get(approved.attemptId).state,'UNCERTAIN');
  const replay=await g.api('paid-retry-execute','POST',{attemptId:approved.attemptId});assert.notEqual(replay.status,200);assert.equal(fetches,1);
 }finally{g.db.close();}
});

test('owner Access and same-origin CSRF protect second approval and cancellation',async()=>{
 const f=await fixture();try{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=publicKey.export({format:'jwk'}),domain='https://paid-retry.cloudflareaccess.com',aud='paid-retry-audience',origin='https://private.example.com';
  Object.assign(f.env,{ACCESS_TEAM_DOMAIN:domain,ACCESS_AUD:aud,ACCESS_OWNER_EMAIL:'owner@example.com'});
  const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),now=Math.floor(Date.now()/1000),header=encode({alg:'RS256',kid:'retry'}),payload=encode({iss:domain,aud:[aud],iat:now-10,exp:now+3600,email:'owner@example.com'}),token=`${header}.${payload}.${sign('RSA-SHA256',Buffer.from(`${header}.${payload}`),privateKey).toString('base64url')}`;
  const fetcher=async()=>Response.json({keys:[{...jwk,kid:'retry',alg:'RS256'}]});
  const site=(action,method,body,headers={})=>handleSiteRequest(new Request(origin+f.path+'/'+action,{method,headers:{'Cf-Access-Jwt-Assertion':token,...headers},body:method==='POST'?JSON.stringify(body??{}):undefined}),f.env,{fetcher,nowMs:Date.now()});
  const unauthorized=await handleSiteRequest(new Request(origin+f.path+'/paid-retry-status'),f.env,{fetcher,nowMs:Date.now()});assert.equal(unauthorized.status,401);
  const quoted=await site('paid-retry-quote','POST',{}, {'Origin':origin,'Content-Type':'application/json'});assert.equal(quoted.status,200,await quoted.clone().text());const issued=await quoted.json();
  const body={quoteId:issued.quoteId,priorReservationId:'old-reservation',maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmPriorCostPreserved:true,confirmNoAutomaticRetry:true,confirmNoAutomaticFallback:true};
  paidGate(f.env);assert.equal((await site('paid-retry-approve','POST',body,{'Origin':'https://foreign.example','Content-Type':'application/json'})).status,403);
  const approved=await site('paid-retry-approve','POST',body,{'Origin':origin,'Content-Type':'application/json'});assert.equal(approved.status,200,await approved.clone().text());const attempt=await approved.json();
  assert.equal((await site('paid-retry-cancel','POST',{attemptId:attempt.attemptId,confirmCancelSecondAttempt:true},{'Origin':'https://foreign.example','Content-Type':'application/json'})).status,403);
  assert.equal((await site('paid-retry-cancel','POST',{attemptId:attempt.attemptId,confirmCancelSecondAttempt:true},{'Origin':origin,'Content-Type':'application/json'})).status,200);
 }finally{f.db.close();}
});

test('real adapter mock fetch is called once and receipt revalidation calls it zero times',async()=>{
 const f=await fixture();try{
  paidGate(f.env);const issued=await(await f.api('paid-retry-quote','POST',{})).json();const approved=await(await f.api('paid-retry-approve','POST',{quoteId:issued.quoteId,priorReservationId:'old-reservation',maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmPriorCostPreserved:true,confirmNoAutomaticRetry:true,confirmNoAutomaticFallback:true})).json();
  let fetches=0;f.env.PAID_SUMMARY_TEST_RUNNER=options=>runPaidGeminiFullSummary({...options,fetchFn:async()=>{fetches++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{}'}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}});}});
  assert.notEqual((await f.api('paid-retry-execute','POST',{attemptId:approved.attemptId})).status,200);assert.equal(fetches,1);
  assert.notEqual((await f.api('paid-retry-revalidate','POST',{attemptId:approved.attemptId,confirmNoProviderCall:true})).status,200);assert.equal(fetches,1);
  assert.equal(f.db.prepare('SELECT state FROM yta_paid_retry_attempts WHERE id=?').get(approved.attemptId).state,'SETTLED');
 }finally{f.db.close();}
});
