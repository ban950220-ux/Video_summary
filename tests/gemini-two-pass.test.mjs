import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {routeApi} from '../src/worker.mjs';
import {encryptProviderKey} from '../src/vault.mjs';
import {assertRemainingApprovalBudget} from '../src/gemini-two-pass.mjs';
import {paidExecutionEnabled} from '../src/paid-summary-contract.mjs';
import {sourceSnapshot,summaryRequest,reviewRequest,validateReview,costCeiling,countTokensRequest,TWO_PASS_MODEL,TWO_PASS_OUTPUT_CAP,sha} from '../src/gemini-two-pass-contract.mjs';
import {windowedSummarySchema} from '../src/two-pass-windows.mjs';

const invalidShapes=JSON.parse(readFileSync(new URL('./fixtures/two-pass-invalid-shapes.json',import.meta.url),'utf8'));

const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
const report={summary:[{text:'첫 발언과 둘째 발언을 종합했다',evidenceIds:[1,2]}],chapters:[{windowKey:'w000',kind:'CONTENT',text:'첫 발언'+' '+'둘째 발언',evidenceIds:[1,2]}],claims:[],numbers:[],critical:[],conclusion:'발언 두 개를 요약했다'};
async function fixture(id='33333333-3333-4333-8333-333333333333'){
 const db=new DatabaseSync(':memory:');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0015_gemini_two_pass.sql'])db.exec(readFileSync(new URL(file,import.meta.url),'utf8'));
 const DB={prepare(sql){const make=args=>({bind(...next){return make(next);},async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}});return make([]);}};
 const path='/api/jobs/'+id,segments=[{id:1,startMs:0,endMs:1000,text:'첫 발언'},{id:2,startMs:1000,endMs:2000,text:'둘째 발언'}],audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'b'.repeat(64)};
 db.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Two pass mock','audio','TRANSCRIBED',2,?,?,?,?)").run(id,new Date().toISOString(),new Date().toISOString(),'null',JSON.stringify(audit));
 db.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").run(id,segments.map(s=>s.text).join('\n'),JSON.stringify(segments),new Date().toISOString());
 const root=Buffer.alloc(32,8),secret=await encryptProviderKey(root,'gemini','OFFLINE_TWO_PASS_KEY');db.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','gemini',?,?,?,?)").run(secret.version,secret.ivB64,secret.ciphertextB64,new Date().toISOString());
 let sends=0,review={verdict:'PASS',issues:[]},finishReason='STOP';
 const provider={getModel:async()=>({name:`models/${TWO_PASS_MODEL}`,supportedGenerationMethods:['generateContent','countTokens'],inputTokenLimit:1_048_576,outputTokenLimit:65_536}),countTokens:async()=>300,generate:async body=>{sends++;const output=sends===1?report:review,responseText=JSON.stringify({candidates:[{finishReason,content:{parts:[{text:JSON.stringify(output)}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:100,thoughtsTokenCount:20}});return {responseText,responseBytes:new TextEncoder().encode(responseText).length,httpStatus:200,complete:true};}};
 const env={DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_GEMINI_TWO_PASS:'true',ENABLE_GEMINI_TWO_PASS_PAID:'true',GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED:'true',GEMINI_TWO_PASS_ALLOWED_JOB_ID:id,ALLOW_PAID_API:'false',GEMINI_TWO_PASS_COST_BUFFER_APPROVED:'true',GEMINI_TWO_PASS_TEST_PROVIDER:provider};
 const call=(action,method='GET',body)=>routeApi(request(path+'/gemini-two-pass-'+action,method,body),env);
 return {db,DB,id,path,segments,env,call,get sends(){return sends;},setReview:value=>{review=value;},setFinish:value=>{finishReason=value;}};
}
async function quoteApprove(f){const issued=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});assert.equal(issued.status,200,await issued.clone().text());const quote=(await issued.json()).quote;const approved=await f.call('approve','POST',{quoteSha256:quote.quoteSha256,maxMicroUsd:quote.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true});assert.equal(approved.status,200,await approved.clone().text());return quote;}

test('two-pass contract preserves the full original transcript, schema and bounded cost',()=>{
 const source={segments:[{id:1,startMs:0,endMs:1000,text:'22년 동안 아니다'},{id:2,startMs:1000,endMs:2000,text:'2023년 12%일 수도 있다'}],raw:'22년 동안 아니다\n2023년 12%일 수도 있다'};
 assert.match(sourceSnapshot(source),/22년 동안 아니다/);assert.match(summaryRequest(source,{}).contents[0].parts[0].text,/2023년 12%일 수도 있다/);assert.match(reviewRequest(source,{},report).contents[0].parts[0].text,/22년 동안 아니다/);
 for(const body of [summaryRequest(source,{}),reviewRequest(source,{},report)])assert.deepEqual(countTokensRequest(body).generateContentRequest,{model:`models/${TWO_PASS_MODEL}`,...body});
 assert.throws(()=>validateReview(JSON.stringify({verdict:'PASS',issues:[{category:'OMISSION',description:'누락',evidenceIds:[1]}]}),source,report));
 assert.throws(()=>sourceSnapshot({...source,raw:'변조'}));assert.ok(costCeiling({inputTokensPerCall:60000}).totalApprovalMicroUsd<150000);assert.equal(TWO_PASS_OUTPUT_CAP,8192);
});
test('paid project cannot be mislabeled free, and the second call needs a separate exact approval',async()=>{
 const f=await fixture();try{
  let counts=0;const originalCount=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens;f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async(...args)=>{counts++;return originalCount(...args);};
  const noConsent=await f.call('quote','POST',{projectMode:'PAID_APPROVED'});assert.equal((await noConsent.json()).error.code,'TWO_PASS_COUNT_CONSENT_REQUIRED');assert.equal(counts,0);
  const free=await f.call('quote','POST',{projectMode:'FREE_ATTESTED',confirmBillingDisabled:true,confirmFullTranscriptSentToGoogleForTokenCount:true});assert.equal((await free.json()).error.code,'TWO_PASS_FREE_PROJECT_UNVERIFIED');assert.equal(f.sends,0);
  const q=await quoteApprove(f);assert.equal(q.maxCalls,2);assert.ok(q.inputTokensPerCallCap<120000);
  const missing=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256});assert.equal((await missing.json()).error.code,'TWO_PASS_PAID_APPROVAL_REQUIRED');assert.equal(f.sends,0);
 }finally{f.db.close();}
});
test('countTokens quote remains available while paid generation is disabled',async()=>{
 const f=await fixture();try{f.env.ENABLE_GEMINI_TWO_PASS_PAID='false';f.env.GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED='false';
  let counts=0;const count=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens;f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async(...args)=>{counts++;return count(...args);};
  const quoted=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});assert.equal(quoted.status,200,await quoted.clone().text());const q=(await quoted.json()).quote;assert.equal(counts,1);assert.equal(f.sends,0);
  const approval=await f.call('approve','POST',{quoteSha256:q.quoteSha256,maxMicroUsd:q.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true});assert.equal((await approval.json()).error.code,'TWO_PASS_PAID_DISABLED');assert.equal(f.sends,0);
 }finally{f.db.close();}
});
test('quote checks exact model metadata before any transcript count and never treats it as generation success',async()=>{
 assert.equal(paidExecutionEnabled({ENABLE_PAID_SUMMARY:'true',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_TAX_MAX_BPS_VERIFIED:'true',ALLOW_PAID_API:'false'}),false);
 const withoutConsent=await fixture();try{let metadataCalls=0;withoutConsent.env.GEMINI_TWO_PASS_TEST_PROVIDER.getModel=async()=>{metadataCalls++;throw Error('should not run');};const denied=await withoutConsent.call('quote','POST',{projectMode:'PAID_APPROVED'});assert.equal((await denied.json()).error.code,'TWO_PASS_COUNT_CONSENT_REQUIRED');assert.equal(metadataCalls,0);}finally{withoutConsent.db.close();}
 for(const bad of [()=>{throw Error('provider failure');},()=>({name:'models/other',supportedGenerationMethods:['generateContent','countTokens'],inputTokenLimit:1_048_576,outputTokenLimit:65_536}),()=>({name:`models/${TWO_PASS_MODEL}`,supportedGenerationMethods:['countTokens'],inputTokenLimit:1_048_576,outputTokenLimit:65_536}),()=>({name:`models/${TWO_PASS_MODEL}`,supportedGenerationMethods:['generateContent','countTokens'],inputTokenLimit:1,outputTokenLimit:65_536})]){
  const f=await fixture();try{let counts=0;f.env.GEMINI_TWO_PASS_TEST_PROVIDER.getModel=bad;f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async()=>{counts++;return 300;};
   const denied=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});assert.equal((await denied.json()).error.code,'TWO_PASS_MODEL_UNAVAILABLE');assert.equal(counts,0);assert.equal(f.sends,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM yta_gemini_two_pass_jobs').get().n,0);
  }finally{f.db.close();}
 }
 const f=await fixture();try{const quoted=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});assert.equal(quoted.status,200);const q=(await quoted.json()).quote;assert.equal(q.model,TWO_PASS_MODEL);assert.equal(f.env.PAID_MODEL_ACCESS_VERIFIED,undefined);assert.equal(f.sends,0);
  const stored=JSON.parse(f.db.prepare('SELECT quote_json FROM yta_gemini_two_pass_jobs').get().quote_json);assert.equal(stored.modelAccessEvidence.credentialGeneration,stored.credentialGeneration);assert.equal(stored.modelAccessEvidence.inputTokensCounted,stored.inputTokensCounted);assert.equal(stored.modelAccessEvidence.model,TWO_PASS_MODEL);assert.equal(stored.modelAccessEvidence.checkedAt+1800000,stored.expiresAt);
 }finally{f.db.close();}
 const failedCount=await fixture();try{failedCount.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async()=>0;const denied=await failedCount.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});assert.equal((await denied.json()).error.code,'TWO_PASS_TOKEN_BOUND');assert.equal(failedCount.db.prepare('SELECT count(*) AS n FROM yta_gemini_two_pass_jobs').get().n,0);}finally{failedCount.db.close();}
});
test('a non-successful model metadata HTTP response stores no quote or call',async()=>{
 const f=await fixture(),fetchBefore=globalThis.fetch;try{f.env.GEMINI_TWO_PASS_TEST_PROVIDER=undefined;let requests=0;globalThis.fetch=async()=>{requests++;return new Response('{"error":"denied"}',{status:403});};
  const denied=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});assert.equal((await denied.json()).error.code,'TWO_PASS_MODEL_UNAVAILABLE');assert.equal(requests,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM yta_gemini_two_pass_jobs').get().n,0);assert.equal(f.sends,0);
 }finally{globalThis.fetch=fetchBefore;f.db.close();}
});
test('provider timeouts stop quote before persistence without a generation or automatic retry',async()=>{
 const originalFetch=globalThis.fetch,originalTimeout=AbortSignal.timeout;
 try{
  const deadlines=[];
  AbortSignal.timeout=ms=>{deadlines.push(ms);return AbortSignal.abort();};
  const metadata=await fixture();
  try{
   metadata.env.GEMINI_TWO_PASS_TEST_PROVIDER=undefined;
   globalThis.fetch=async(_url,options)=>{assert.equal(options.signal.aborted,true);throw Error('simulated timeout');};
   const response=await metadata.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});
   assert.equal((await response.json()).error.code,'TWO_PASS_MODEL_UNAVAILABLE');
   assert.equal(metadata.db.prepare('SELECT count(*) AS n FROM yta_gemini_two_pass_jobs').get().n,0);
   assert.equal(metadata.sends,0);
  }finally{metadata.db.close();}
  const count=await fixture();
  try{
   count.env.GEMINI_TWO_PASS_TEST_PROVIDER=undefined;
   let requests=0;
   globalThis.fetch=async(url,options)=>{requests++;assert.equal(options.signal.aborted,true);if(!url.includes(':countTokens'))return new Response(JSON.stringify({name:`models/${TWO_PASS_MODEL}`,supportedGenerationMethods:['generateContent','countTokens'],inputTokenLimit:1_048_576,outputTokenLimit:65_536}),{headers:{'content-type':'application/json'}});throw Error('simulated timeout');};
   const response=await count.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});
   assert.equal((await response.json()).error.code,'TWO_PASS_COUNT_UNAVAILABLE');
   assert.equal(requests,2);assert.equal(count.db.prepare('SELECT count(*) AS n FROM yta_gemini_two_pass_jobs').get().n,0);assert.equal(count.sends,0);
  }finally{count.db.close();}
  assert.deepEqual(deadlines,[15000,15000,90000]);
 }finally{globalThis.fetch=originalFetch;AbortSignal.timeout=originalTimeout;}
});
test('metadata needs generation support; the actual countTokens response proves counting support',async()=>{
 const f=await fixture(),fetchBefore=globalThis.fetch,infoBefore=console.info,events=[];
 try{
  f.env.GEMINI_TWO_PASS_TEST_PROVIDER=undefined;console.info=line=>events.push(JSON.parse(line));
  let requests=0;globalThis.fetch=async(url)=>{requests++;return url.includes(':countTokens')?new Response(JSON.stringify({totalTokens:300}),{headers:{'content-type':'application/json'}}):new Response(JSON.stringify({name:`models/${TWO_PASS_MODEL}`,supportedGenerationMethods:['generateContent'],inputTokenLimit:1_048_576,outputTokenLimit:65_536}),{headers:{'content-type':'application/json'}});};
  const response=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});
  assert.equal(response.status,200,await response.clone().text());assert.equal(requests,2);assert.equal((await response.json()).quote.inputTokensCounted,300);assert.equal(f.sends,0);
  assert.deepEqual(events.map(item=>[item.stage,item.outcome]),[['RECEIVED','STARTED'],['MODEL_LOOKUP','STARTED'],['MODEL_LOOKUP','SUCCEEDED'],['COUNT_TOKENS','STARTED'],['COUNT_TOKENS','SUCCEEDED'],['QUOTE_SAVE','STARTED'],['QUOTE_SAVE','SUCCEEDED']]);
  assert.equal(new Set(events.map(item=>item.correlationId)).size,1);
  for(const event of events){assert.deepEqual(Object.keys(event).sort(),['at','code','correlationId','event','outcome','stage']);assert.ok(!JSON.stringify(event).includes('OFFLINE_TWO_PASS_KEY'));}
 }finally{globalThis.fetch=fetchBefore;console.info=infoBefore;f.db.close();}
});
test('abort after countTokens response headers but before the JSON body blocks the quote',async()=>{
 const f=await fixture(),fetchBefore=globalThis.fetch,timeoutBefore=AbortSignal.timeout,infoBefore=console.info,deadlines=[],events=[];
 try{
  f.env.GEMINI_TWO_PASS_TEST_PROVIDER=undefined;console.info=line=>events.push(JSON.parse(line));
  AbortSignal.timeout=ms=>{const controller=new AbortController();deadlines.push({ms,controller});return controller.signal;};
  globalThis.fetch=async(url,options)=>{
   if(!url.includes(':countTokens'))return new Response(JSON.stringify({name:`models/${TWO_PASS_MODEL}`,supportedGenerationMethods:['generateContent'],inputTokenLimit:1_048_576,outputTokenLimit:65_536}));
   assert.equal(options.signal.aborted,false);
   return {ok:true,json:()=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(Error('body aborted')),{once:true});queueMicrotask(()=>deadlines.at(-1).controller.abort());})};
  };
  const response=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});
  assert.equal((await response.json()).error.code,'TWO_PASS_COUNT_UNAVAILABLE');assert.deepEqual(deadlines.map(item=>item.ms),[15000,90000]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM yta_gemini_two_pass_jobs').get().n,0);assert.equal(f.sends,0);
  assert.equal(events.at(-1).stage,'COUNT_TOKENS');assert.equal(events.at(-1).outcome,'FAILED');assert.equal(events.at(-1).code,'TWO_PASS_COUNT_UNAVAILABLE');
 }finally{globalThis.fetch=fetchBefore;AbortSignal.timeout=timeoutBefore;console.info=infoBefore;f.db.close();}
});
test('a pending count is reserved once across concurrent POSTs and survives a new status read',async()=>{
 const f=await fixture();try{
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});let counts=0;
  f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async()=>{counts++;entered();return new Promise(resolve=>{release=resolve;});};
  const body={projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true};
  const first=f.call('quote','POST',body);await started;
  const pending=await(await f.call('status')).json();assert.equal(pending.state,'QUOTE_PENDING');assert.equal(pending.quoteAttempt.state,'COUNT_SENT');
  const second=await f.call('quote','POST',body);assert.equal((await second.json()).error.code,'TWO_PASS_QUOTE_ATTEMPT_EXISTS');assert.equal(counts,1);
  release(300);assert.equal((await first).status,200);assert.equal((await(await f.call('status')).json()).state,'QUOTED');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM yta_operations WHERE provider='gemini-two-pass-quote'").get().n,1);
  const proof=JSON.parse(f.db.prepare("SELECT result_json FROM yta_operations WHERE provider='gemini-two-pass-quote'").get().result_json);
  assert.equal(proof.ownerId,'owner');assert.equal(proof.jobId,f.id);assert.equal(proof.model,TWO_PASS_MODEL);assert.equal(proof.countedTokens,300);assert.ok(proof.sourceSha256&&proof.credentialGeneration&&proof.requestSha256);
 }finally{f.db.close();}
});
test('quote reservation before-commit sends nothing; committed ack loss reads back the same reservation',async()=>{
 for(const fault of ['before-commit','ack-loss']){
  const f=await fixture();try{
   const base=f.env.DB;let counts=0;const count=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens;
   f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async(...args)=>{counts++;return count(...args);};
   f.env.DB={prepare(sql){const prepared=base.prepare(sql);if(!sql.startsWith('INSERT OR IGNORE INTO yta_operations'))return prepared;return {bind(...args){const bound=prepared.bind(...args);return {run:async()=>{if(fault==='before-commit')throw Error('before commit');await bound.run();throw Error('ack lost');}};}};}};
   const response=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});
   assert.equal((await response.json()).state,fault==='ack-loss'?'QUOTED':undefined);
   assert.equal(counts,fault==='ack-loss'?1:0);
   assert.equal(f.db.prepare("SELECT count(*) AS n FROM yta_operations WHERE provider='gemini-two-pass-quote'").get().n,fault==='ack-loss'?1:0);
  }finally{f.db.close();}
 }
});
test('uncertain count keeps its server reservation without a timed reset or another provider call',async()=>{
 const f=await fixture();try{
  let counts=0;f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async()=>{counts++;throw Error('uncertain provider result');};
  const body={projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true};
  assert.equal((await(await f.call('quote','POST',body)).json()).error.code,'LIVE_INTERNAL_ERROR');
  const pending=await(await f.call('status')).json();assert.equal(pending.state,'QUOTE_PENDING');assert.equal(pending.quoteAttempt.state,'COUNT_SENT');
  const repeat=await f.call('quote','POST',body);assert.equal((await repeat.json()).error.code,'TWO_PASS_QUOTE_ATTEMPT_EXISTS');assert.equal(counts,1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM yta_gemini_two_pass_jobs').get().n,0);
 }finally{f.db.close();}
});
test('the earlier unrecorded production attempt remains blocked rather than being treated as unsent',async()=>{
 const f=await fixture('a69c6a73-6aa6-4ccb-a912-1fab0c35d6a9');try{
  assert.equal((await(await f.call('status')).json()).state,'QUOTE_UNCERTAIN_LEGACY');
  for(const file of ['../migrations/0008_paid_summary_budget.sql','../migrations/0009_paid_first_trial.sql','../migrations/0010_paid_summary_receipts.sql'])f.db.exec(readFileSync(new URL(file,import.meta.url),'utf8'));
  const choice=await(await routeApi(request(f.path+'/summary-choice'),f.env)).json();
  assert.equal(choice.geminiQuote.state,'QUOTE_UNCERTAIN_LEGACY');assert.equal(choice.geminiQuote.blocked,true);assert.equal(choice.paid.quoteIssueReady,false);
  const oldQuote=await routeApi(request(f.path+'/paid-summary-quote','POST',{}),f.env);assert.equal((await oldQuote.json()).error.code,'TWO_PASS_QUOTE_UNCERTAIN');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM yta_paid_summary_quotes').get().n,0);
  const denied=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});
  assert.equal((await denied.json()).error.code,'TWO_PASS_LEGACY_QUOTE_UNCERTAIN');assert.equal(f.sends,0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM yta_operations WHERE provider='gemini-two-pass-quote'").get().n,0);
 }finally{f.db.close();}
});
test('key changes and historical quotes without bound model proof cannot be approved',async()=>{
 const f=await fixture();try{
  const original=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.getModel;f.env.GEMINI_TWO_PASS_TEST_PROVIDER.getModel=async(...args)=>{const metadata=await original(...args),secret=await encryptProviderKey(Buffer.alloc(32,8),'gemini','ROTATED_OFFLINE_KEY');f.db.prepare("UPDATE provider_credentials SET cipher_version=?,iv_b64=?,ciphertext_b64=?,updated_at=? WHERE provider='gemini'").run(secret.version,secret.ivB64,secret.ciphertextB64,new Date(Date.now()+1000).toISOString());return metadata;};
  const denied=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});assert.equal((await denied.json()).error.code,'TWO_PASS_KEY_CHANGED');assert.equal(f.db.prepare('SELECT count(*) AS n FROM yta_gemini_two_pass_jobs').get().n,0);
 }finally{f.db.close();}
 for(const mutation of ['key','old-proof','expiry']){const g=await fixture();try{const issued=await g.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true}),q=(await issued.json()).quote;
  if(mutation==='key'){const secret=await encryptProviderKey(Buffer.alloc(32,8),'gemini','ROTATED_OFFLINE_KEY');g.db.prepare("UPDATE provider_credentials SET cipher_version=?,iv_b64=?,ciphertext_b64=?,updated_at=? WHERE provider='gemini'").run(secret.version,secret.ivB64,secret.ciphertextB64,new Date(Date.now()+1000).toISOString());}
  if(mutation==='old-proof'){const old=JSON.parse(g.db.prepare('SELECT quote_json FROM yta_gemini_two_pass_jobs').get().quote_json);delete old.modelAccessEvidence;g.db.prepare('UPDATE yta_gemini_two_pass_jobs SET quote_json=?,quote_sha256=?').run(JSON.stringify(old),await sha(JSON.stringify(old)));}
  if(mutation==='expiry')g.db.prepare('UPDATE yta_gemini_two_pass_jobs SET expires_at=?').run(Date.now()-1);
  const blocked=await g.call('approve','POST',{quoteSha256:q.quoteSha256,maxMicroUsd:q.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true});assert.ok((await blocked.json()).error.code,mutation);assert.equal(g.sends,0,mutation);
 }finally{g.db.close();}}
});
test('two-pass cost buffer approval is separate from actual tax verification',async()=>{
 const f=await fixture();try{
  f.env.GEMINI_TWO_PASS_COST_BUFFER_APPROVED='false';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';
  const quoted=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});assert.equal(quoted.status,200);const q=(await quoted.json()).quote;
  assert.equal(q.approvalKind,'CALCULATED_COST_CEILING_NOT_PROVIDER_LIMIT');assert.equal(q.costBufferBps,10000);
  assert.equal((await(await f.call('status')).json()).actualTaxVerification,'NOT_VERIFIED');
  const denied=await f.call('approve','POST',{quoteSha256:q.quoteSha256,maxMicroUsd:q.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true});
  assert.equal((await denied.json()).error.code,'TWO_PASS_PAID_DISABLED');assert.equal(f.sends,0);
  f.env.GEMINI_TWO_PASS_COST_BUFFER_APPROVED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='false';
  const approved=await f.call('approve','POST',{quoteSha256:q.quoteSha256,maxMicroUsd:q.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true});assert.equal(approved.status,200,await approved.clone().text());
 }finally{f.db.close();}
});
test('remaining approval budget counts stored actual usage and blocks excess before phase two',async()=>{
 const quote={inputTokensPerCallCap:1000,costBufferBps:10000,maxMicroUsd:26000};
 const receipt={state:'SETTLED',response_complete:1,usage_json:JSON.stringify({promptTokenCount:300,candidatesTokenCount:100,thoughtsTokenCount:20}),token_estimate_micro_usd:255};
 assert.deepEqual(assertRemainingApprovalBudget(receipt,300,quote),{usageJson:receipt.usage_json,estimateMicroUsd:255});
 assert.throws(()=>assertRemainingApprovalBudget(receipt,1000,{...quote,maxMicroUsd:1000}),{code:'TWO_PASS_COST_BOUND'});
 assert.throws(()=>assertRemainingApprovalBudget({...receipt,token_estimate_micro_usd:1000},300,quote),{code:'TWO_PASS_COST_RECONCILIATION_REQUIRED'});
 const f=await fixture();try{const q=await quoteApprove(f);await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal(f.sends,1);
  f.db.prepare('UPDATE yta_gemini_two_pass_calls SET token_estimate_micro_usd=? WHERE job_id=? AND phase=0').run(1000000,f.id);
  const blocked=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await blocked.json()).error.code,'TWO_PASS_COST_RECONCILIATION_REQUIRED');assert.equal(f.sends,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yta_gemini_two_pass_calls WHERE phase=1').get().n,0);
 }finally{f.db.close();}
});
test('a first-call ledger change during second token count cannot reserve the remaining call',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f);await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal(f.sends,1);
  f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async()=>{f.db.prepare('UPDATE yta_gemini_two_pass_calls SET token_estimate_micro_usd=? WHERE job_id=? AND phase=0').run(1000000,f.id);return 300;};
  const blocked=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await blocked.json()).error.code,'TWO_PASS_DISPATCH_SCOPE_CHANGED');assert.equal(f.sends,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yta_gemini_two_pass_calls WHERE phase=1').get().n,0);
 }finally{f.db.close();}
});
test('FIRST_READY cancellation wins against a second-phase count still in flight',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f);await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});
  f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async()=>{const cancelled=await f.call('cancel','POST',{});assert.equal(cancelled.status,200);return 300;};
  const second=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await second.json()).error.code,'TWO_PASS_DISPATCH_CONFLICT');assert.equal(f.sends,1);
  assert.equal((await(await f.call('status')).json()).state,'CANCELLED');
 }finally{f.db.close();}
});
test('the final atomic claim rejects changed key, cancellation, source, audit and expiry with zero generation',async()=>{
 for(const mutation of ['key','cancel','source','audit','expiry']){
  const f=await fixture();try{const q=await quoteApprove(f),original=f.env.DB,newKey=await encryptProviderKey(Buffer.alloc(32,8),'gemini','ROTATED_UNAPPROVED_KEY');let fired=false;
   f.env.DB={prepare(sql){const statement=original.prepare(sql);if(sql.startsWith("UPDATE yta_gemini_two_pass_calls SET state='DISPATCHING'"))return {bind(...args){const bound=statement.bind(...args);return {async run(){if(!fired){fired=true;
    if(mutation==='key')f.db.prepare("UPDATE provider_credentials SET iv_b64=?,ciphertext_b64=?,updated_at=? WHERE owner_id='owner' AND provider='gemini'").run(newKey.ivB64,newKey.ciphertextB64,new Date(Date.now()+1000).toISOString());
    if(mutation==='cancel')f.db.prepare("UPDATE yta_gemini_two_pass_jobs SET state='CANCELLED' WHERE job_id=?").run(f.id);
    if(mutation==='source')f.db.prepare('UPDATE yta_sources SET raw=? WHERE job_id=?').run('changed source',f.id);
    if(mutation==='audit')f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify({audioProcessingCoverage:0.5,audioFileSha256:'b'.repeat(64)}),f.id);
    if(mutation==='expiry')f.db.prepare('UPDATE yta_gemini_two_pass_jobs SET expires_at=? WHERE job_id=?').run(Date.now()-1,f.id);
   }return bound.run();}};}};return statement;}};
   const result=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await result.json()).error.code,'TWO_PASS_DISPATCH_SCOPE_CHANGED',mutation);assert.equal(f.sends,0,mutation);
  }finally{f.db.close();}
 }
});
test('output and thinking usage above the requested cap preserves the receipt and blocks review',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f),generate=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate;f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate=async body=>{const result=await generate(body),envelope=JSON.parse(result.responseText);envelope.usageMetadata.thoughtsTokenCount=8193;result.responseText=JSON.stringify(envelope);result.responseBytes=new TextEncoder().encode(result.responseText).length;return result;};
  const first=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await first.json()).error.code,'TWO_PASS_USAGE_UNCERTAIN');const state=(await(await f.call('status')).json());assert.equal(state.state,'BLOCKED');assert.equal(state.calls[0].responseStored,true);assert.equal(state.calls[0].usage.thoughtsTokenCount,8193);assert.equal(f.sends,1);
 }finally{f.db.close();}
});
test('inconsistent total usage blocks generation continuation without losing the receipt',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f),generate=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate;f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate=async body=>{const result=await generate(body),envelope=JSON.parse(result.responseText);envelope.usageMetadata.totalTokenCount=999;result.responseText=JSON.stringify(envelope);result.responseBytes=new TextEncoder().encode(result.responseText).length;return result;};
  const first=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await first.json()).error.code,'TWO_PASS_USAGE_UNCERTAIN');assert.equal((await(await f.call('status')).json()).calls[0].responseStored,true);assert.equal(f.sends,1);
 }finally{f.db.close();}
});
test('two bounded mock generations persist both receipts and a review-required draft, duplicate POST sends nothing',async()=>{
 const f=await fixture();try{
  const q=await quoteApprove(f);
  const first=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal(first.status,200,await first.clone().text());assert.equal((await first.json()).status.state,'FIRST_READY');
  const again=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await again.json()).error.code,'TWO_PASS_DISPATCH_SCOPE_CHANGED');assert.equal(f.sends,1);
  const second=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal(second.status,200,await second.clone().text());assert.equal((await second.json()).status.state,'ISSUES');assert.equal(f.sends,2);
  const reopened=await(await routeApi(request(f.path),f.env)).json();assert.equal(reopened.job.report,null);assert.equal(reopened.job.status,'TRANSCRIBED');
  const txt=await(await routeApi(request(f.path+'/export?format=txt'),f.env)).text();assert.match(txt,/첫 발언/);assert.match(txt,/둘째 발언/);
  assert.deepEqual(f.db.prepare('SELECT state,response_complete FROM yta_gemini_two_pass_calls ORDER BY phase').all().map(row=>({...row})),[{state:'SETTLED',response_complete:1},{state:'SETTLED',response_complete:1}]);
 }finally{f.db.close();}
});
test('review issues remain visible and no third generation is sent',async()=>{
 const f=await fixture();try{f.setReview({verdict:'ISSUES',issues:[{category:'NEGATION',description:'원문 부정을 보고서가 누락',evidenceIds:[1]}]});const q=await quoteApprove(f);
  await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});const second=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});const status=(await second.json()).status;assert.equal(status.state,'ISSUES');assert.equal(status.review.issues[0].category,'NEGATION');assert.equal(f.sends,2);
  const third=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await third.json()).error.code,'TWO_PASS_DISPATCH_SCOPE_CHANGED');assert.equal(f.sends,2);
 }finally{f.db.close();}
});
test('model PASS over a NON_SUBSTANTIVE-only draft never completes the app job',async()=>{
 const f=await fixture();try{
  const generate=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate;
  f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate=async body=>{
   const result=await generate(body),envelope=JSON.parse(result.responseText);
   const candidate=JSON.parse(envelope.candidates[0].content.parts[0].text);
   if(candidate.chapters){candidate.chapters[0].kind='NON_SUBSTANTIVE';candidate.chapters[0].text='Only repeated greetings appear in this window.';envelope.candidates[0].content.parts[0].text=JSON.stringify(candidate);result.responseText=JSON.stringify(envelope);result.responseBytes=new TextEncoder().encode(result.responseText).length;}
   return result;
  };
  const q=await quoteApprove(f);await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});
  const response=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();assert.equal(result.status.reviewStage,'REVIEW_REQUIRED');assert.equal(result.status.review.verdict,'PASS');assert.equal(result.status.firstReport.synthesisComplete,false);
  const publicJob=(await(await routeApi(request(f.path),f.env)).json()).job;assert.equal(publicJob.report,null);assert.equal(publicJob.status,'TRANSCRIBED');assert.equal(f.sends,2);
 }finally{f.db.close();}
});
test('1,226 source IDs and distinct semantic traps reach both prompts; review flags stay separate from data coverage',()=>{
 const fragments=['수익은 12%가 아니라 2%라고 주장했다','22년 동안 기다렸다는 기간 표현','2023년 5월에만 가능하다고 했다','성공할 수도 있지만 확실하지 않다','반례는 조건이 깨지면 실패한다','A 때문에 B가 생겼다고 단정하지 않았다'];
 const segments=Array.from({length:1226},(_,index)=>({id:index+1,startMs:index*4807,endMs:(index+1)*4807,text:`${index+1}번째 발언: ${fragments[index%fragments.length]}`})),source={segments,raw:segments.map(segment=>segment.text).join('\n')};
 const first=summaryRequest(source,{audioBoundaryAmbiguities:[{segmentId:47}]}),second=reviewRequest(source,{},report);
 for(const body of [first,second]){const prompt=body.contents[0].parts[0].text;assert.match(prompt,/1226번째 발언/);for(const fragment of fragments)assert.ok(prompt.includes(fragment));assert.match(prompt,/\[47,221122,225929/);}
 assert.equal(segments.length,1226);assert.equal(new Set(segments.map(item=>item.id)).size,1226);
});
test('truncated second response preserves usage and blocks a third generation or blind recovery',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f);await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});f.setFinish('MAX_TOKENS');
  const second=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await second.json()).error.code,'TWO_PASS_OUTPUT_INCOMPLETE');
  const status=(await(await f.call('status')).json());assert.equal(status.state,'BLOCKED');assert.equal(status.calls[1].responseStored,true);assert.equal(status.calls[1].usage.promptTokenCount,300);assert.equal(f.sends,2);
  const recovery=await f.call('recover','POST',{phase:1,confirmNoProviderCall:true});assert.equal((await recovery.json()).error.code,'TWO_PASS_OUTPUT_INCOMPLETE');assert.equal(f.sends,2);
  const replay=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await replay.json()).error.code,'TWO_PASS_DISPATCH_SCOPE_CHANGED');assert.equal(f.sends,2);
 }finally{f.db.close();}
});
test('changed stored transcript before second stage prevents dispatch',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f);await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});f.db.prepare('UPDATE yta_sources SET raw=? WHERE job_id=?').run('변조된 원문',f.id);
  const result=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.notEqual(result.status,200);assert.equal(f.sends,1);
 }finally{f.db.close();}
});
test('concurrent execution POSTs reserve the first phase once',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f),body={phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true};
  const results=await Promise.all([f.call('run','POST',body),f.call('run','POST',body)]);assert.equal(results.filter(result=>result.status===200).length,1);assert.equal(f.sends,1);
 }finally{f.db.close();}
});
test('source changed while official token count is pending fails the final D1 guard before generation',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f);f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async()=>{f.db.prepare('UPDATE yta_sources SET raw=? WHERE job_id=?').run('바뀐 전사',f.id);return 300;};
  const result=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await result.json()).error.code,'TWO_PASS_DISPATCH_SCOPE_CHANGED');assert.equal(f.sends,0);
 }finally{f.db.close();}
});
test('complete stored responses recover without generation after final ledger writes fail',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f),original=f.env.DB;
  const failOneSettlement=()=>{let failed=false;f.env.DB={prepare(sql){if(!failed&&sql.includes("SET state='SETTLED'")){failed=true;throw Error('OFFLINE_LEDGER_FAULT');}return original.prepare(sql);}};};
  failOneSettlement();const first=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.notEqual(first.status,200);f.env.DB=original;
  let status=(await(await f.call('status')).json());assert.equal(status.state,'FIRST_READY');assert.equal(status.calls[0].responseStored,true);assert.equal(status.calls[0].state,'RECEIVED');
  assert.equal(status.next,'RECOVER_FIRST_RECEIPT');const premature=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await premature.json()).error.code,'TWO_PASS_DISPATCH_SCOPE_CHANGED');assert.equal(f.sends,1);
  const recoveredFirst=await f.call('recover','POST',{phase:0,confirmNoProviderCall:true});assert.equal(recoveredFirst.status,200,await recoveredFirst.clone().text());assert.equal(f.sends,1);
  failOneSettlement();const second=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.notEqual(second.status,200);f.env.DB=original;
  status=(await(await f.call('status')).json());assert.equal(status.state,'ISSUES');assert.equal(status.calls[1].state,'RECEIVED');
  const recoveredSecond=await f.call('recover','POST',{phase:1,confirmNoProviderCall:true});assert.equal(recoveredSecond.status,200,await recoveredSecond.clone().text());assert.equal((await recoveredSecond.json()).providerCalled,false);assert.equal(f.sends,2);
 }finally{f.db.close();}
});
test('last awaited claim rechecks execution flags, expiry and job scope before generation',async()=>{
 for(const change of ['flag','expiry','job']){const f=await fixture(),clock=Date.now;try{const q=await quoteApprove(f),original=f.env.DB;
  f.env.DB={prepare(sql){const statement=original.prepare(sql);if(sql.startsWith("UPDATE yta_gemini_two_pass_calls SET state='DISPATCHING'"))return {bind(...args){const bound=statement.bind(...args);return {async run(){const result=await bound.run();if(change==='flag')f.env.ENABLE_GEMINI_TWO_PASS_PAID='false';else if(change==='expiry')Date.now=()=>q.expiresAt+1;else f.env.GEMINI_TWO_PASS_ALLOWED_JOB_ID='other-job';return result;}};}};return statement;}};
  const result=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.notEqual(result.status,200);assert.equal(f.sends,0);assert.equal((await(await f.call('status')).json()).calls[0].state,'UNCERTAIN');
 }finally{Date.now=clock;f.db.close();}}
});
test('receipt before-commit and commit-ack failures keep exactly one response and settle without another provider call',async()=>{
 for(const fault of ['before','after']){const f=await fixture();try{const q=await quoteApprove(f),original=f.env.DB;let injected=false;
  f.env.DB={prepare(sql){const statement=original.prepare(sql);if(sql.startsWith('UPDATE yta_gemini_two_pass_calls SET state=?,response_json='))return {bind(...args){const bound=statement.bind(...args);return {async run(){if(!injected){injected=true;if(fault==='after')await bound.run();throw Error('LOCAL_RECEIPT_FAULT');}return bound.run();}};}};return statement;}};
  const result=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal(result.status,200,await result.clone().text());assert.equal(f.sends,1);assert.equal((await(await f.call('status')).json()).calls[0].state,'SETTLED');
 }finally{f.db.close();}}
});
test('review-ledger save faults retain the second receipt and recover without generation',async()=>{
 for(const fault of ['before','after']){const f=await fixture();try{const q=await quoteApprove(f);await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});const original=f.env.DB;let injected=false;
  f.env.DB={prepare(sql){const statement=original.prepare(sql);if(sql.startsWith('UPDATE yta_gemini_two_pass_jobs SET review_json='))return {bind(...args){const bound=statement.bind(...args);return {async run(){if(!injected){injected=true;if(fault==='after')await bound.run();throw Error('LOCAL_DONE_FAULT');}return bound.run();}};}};return statement;}};
  const failed=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.notEqual(failed.status,200);f.env.DB=original;
  const before=(await(await f.call('status')).json());assert.equal(before.calls[1].responseStored,true);assert.equal(f.sends,2);
  const recovered=await f.call('recover','POST',{phase:1,confirmNoProviderCall:true});assert.equal(recovered.status,200,await recovered.clone().text());assert.equal((await recovered.json()).providerCalled,false);assert.equal(f.sends,2);
 }finally{f.db.close();}}
});
test('recovery binds both audit and exact request after a boundary change',async()=>{
 for(const change of ['audit','request']){const f=await fixture();try{const q=await quoteApprove(f),original=f.env.DB;let failed=false;
  f.env.DB={prepare(sql){if(!failed&&sql.includes("SET state='SETTLED'")){failed=true;throw Error('LOCAL_SETTLEMENT_FAULT');}return original.prepare(sql);}};
  await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});f.env.DB=original;
  if(change==='audit')f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify({audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'b'.repeat(64),audioBoundaryAmbiguities:[{segmentId:1}]}),f.id);
  else f.db.prepare("UPDATE yta_gemini_two_pass_jobs SET first_request_sha256=? WHERE job_id=?").run('changed-request-hash',f.id);
  const recovered=await f.call('recover','POST',{phase:0,confirmNoProviderCall:true});assert.equal((await recovered.json()).error.code,'TWO_PASS_RECOVERY_SCOPE_CHANGED');assert.equal(f.sends,1);
 }finally{f.db.close();}}
});
test('second receipt cannot be attached to a different first report',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f);await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});f.setFinish('MAX_TOKENS');
  await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal(f.sends,2);
  const changed={...report,conclusion:'다른 1차 보고서'};f.db.prepare('UPDATE yta_gemini_two_pass_jobs SET first_report_json=? WHERE job_id=?').run(JSON.stringify(changed),f.id);
  const recovery=await f.call('recover','POST',{phase:1,confirmNoProviderCall:true});assert.equal((await recovery.json()).error.code,'TWO_PASS_RECOVERY_SCOPE_CHANGED');assert.equal(f.sends,2);
 }finally{f.db.close();}
});
test('reservation and transition before-commit or ack faults release zero-call reservations safely',async()=>{
 for(const [step,fault] of [['insert','before'],['insert','after'],['transition','before'],['transition','after']]){const f=await fixture();try{const q=await quoteApprove(f),original=f.env.DB;let injected=false;
  f.env.DB={prepare(sql){const statement=original.prepare(sql),target=step==='insert'?sql.startsWith('INSERT OR IGNORE INTO yta_gemini_two_pass_calls'):sql.startsWith('UPDATE yta_gemini_two_pass_jobs SET state=?,updated_at=?');if(target)return {bind(...args){const bound=statement.bind(...args);return {async run(){if(!injected){injected=true;if(fault==='after')await bound.run();throw Error('LOCAL_RESERVATION_FAULT');}return bound.run();}};}};return statement;}};
  const failed=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.notEqual(failed.status,200);f.env.DB=original;assert.equal(f.sends,0);
  if(fault==='after'||step==='transition'&&fault==='before'){const recovered=await f.call('recover','POST',{phase:0,confirmNoProviderCall:true});assert.equal(recovered.status,200,await recovered.clone().text());assert.equal((await recovered.json()).reservationReleased,true);}
  const ran=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal(ran.status,200,await ran.clone().text());assert.equal(f.sends,1);
 }finally{f.db.close();}}
});
test('expired and cancelled unused quotes receive a fresh revision, while any reserved phase prevents reset',async()=>{
 for(const change of ['expired','cancelled']){const f=await fixture();try{const first=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true}),old=(await first.json()).quote;
  if(change==='expired')f.db.prepare('UPDATE yta_gemini_two_pass_jobs SET expires_at=? WHERE job_id=?').run(Date.now()-1,f.id);else assert.equal((await f.call('cancel','POST',{})).status,200);
  const revised=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});assert.equal(revised.status,200,await revised.clone().text());const current=(await revised.json()).quote;assert.notEqual(current.quoteSha256,old.quoteSha256);
  const stale=await f.call('approve','POST',{quoteSha256:old.quoteSha256,maxMicroUsd:old.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true});assert.equal((await stale.json()).error.code,'TWO_PASS_APPROVAL_SCOPE_CHANGED');
  await f.call('approve','POST',{quoteSha256:current.quoteSha256,maxMicroUsd:current.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true});await f.call('run','POST',{phase:0,quoteSha256:current.quoteSha256,confirmSeparatePaidApproval:true});await f.call('cancel','POST',{});
  const blocked=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});assert.equal((await blocked.json()).error.code,'TWO_PASS_ALREADY_STARTED');assert.equal(f.sends,1);
 }finally{f.db.close();}}
});

test('historical first-response shape without windowKey and kind stops at stored receipt',async()=>{
 const f=await fixture();try{
  const q=await quoteApprove(f),original=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate;
  f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate=async body=>{
   assert.deepEqual(body.generationConfig.responseJsonSchema,windowedSummarySchema({segments:f.segments}));
   const chapter=body.generationConfig.responseJsonSchema.properties.chapters.items;
   assert.deepEqual(chapter.required,['windowKey','kind','text','evidenceIds']);
   assert.match(body.contents[0].parts[0].text,/Window manifest/);
   const result=await original(body),envelope=JSON.parse(result.responseText);
   envelope.candidates[0].content.parts[0].text=JSON.stringify(invalidShapes.first);
   result.responseText=JSON.stringify(envelope);result.responseBytes=new TextEncoder().encode(result.responseText).length;
   return result;
  };
  const first=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});
  assert.equal((await first.json()).error.code,'TWO_PASS_WINDOW_INVALID');
  let state=(await(await f.call('status')).json());
  assert.equal(state.state,'BLOCKED');assert.equal(state.next,'INSPECT_STORED_RECEIPT_NO_AUTO_RETRY');
  assert.equal(state.calls.length,1);assert.equal(state.calls[0].state,'VALIDATION_FAILED');
  assert.equal(state.calls[0].responseStored,true);assert.ok(state.calls[0].responseSha256);
  assert.equal(state.calls[0].usage.promptTokenCount,300);assert.equal(f.sends,1);
  const recover=await f.call('recover','POST',{phase:0,confirmNoProviderCall:true});
  assert.equal((await recover.json()).error.code,'TWO_PASS_WINDOW_INVALID');
  const next=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});
  assert.equal((await next.json()).error.code,'TWO_PASS_DISPATCH_SCOPE_CHANGED');
  state=(await(await f.call('status')).json());assert.equal(state.state,'BLOCKED');assert.equal(f.sends,1);
 }finally{f.db.close();}
});

test('historical second-response repair wrapper fails strict review contract without a third call',async()=>{
 const f=await fixture();try{
  const q=await quoteApprove(f),original=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate;
  f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate=async body=>{
   const result=await original(body);
   if(f.sends===2){
    assert.deepEqual(body.generationConfig.responseJsonSchema.required,['verdict','issues']);
    assert.match(body.contents[0].parts[0].text,/Compare every chapter/);
    const envelope=JSON.parse(result.responseText);
    envelope.candidates[0].content.parts[0].text=JSON.stringify(invalidShapes.second);
    result.responseText=JSON.stringify(envelope);result.responseBytes=new TextEncoder().encode(result.responseText).length;
   }
   return result;
  };
  assert.equal((await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true})).status,200);
  const second=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});
  assert.equal((await second.json()).error.code,'TWO_PASS_REVIEW_INVALID');
  let state=(await(await f.call('status')).json());
  assert.equal(state.state,'BLOCKED');assert.equal(state.next,'INSPECT_STORED_RECEIPT_NO_AUTO_RETRY');
  assert.deepEqual(state.calls.map(c=>c.state),['SETTLED','VALIDATION_FAILED']);
  assert.equal(state.calls[1].responseStored,true);assert.equal(state.calls[1].usage.promptTokenCount,300);
  assert.equal(f.sends,2);
  const recover=await f.call('recover','POST',{phase:1,confirmNoProviderCall:true});
  assert.equal((await recover.json()).error.code,'TWO_PASS_REVIEW_INVALID');
  const again=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});
  assert.equal((await again.json()).error.code,'TWO_PASS_DISPATCH_SCOPE_CHANGED');
  state=(await(await f.call('status')).json());assert.equal(state.state,'BLOCKED');assert.equal(f.sends,2);
 }finally{f.db.close();}
});

test('complete non-object and malformed response receipts block without losing the original or opening a retry',async()=>{
 for(const raw of ['null','[]','"unexpected"','123','{}','{"candidates":']){
  const f=await fixture();try{
   const q=await quoteApprove(f),original=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate;
   f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate=async body=>{
    const result=await original(body);
    result.responseText=raw;result.responseBytes=new TextEncoder().encode(raw).length;
    return result;
   };
   const first=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});
   assert.equal((await first.json()).error.code,'TWO_PASS_RECEIPT_INVALID',raw);
   const status=(await(await f.call('status')).json());
   assert.equal(status.state,'BLOCKED',raw);assert.equal(status.errorCode,'TWO_PASS_RECEIPT_INVALID',raw);
   assert.equal(status.next,'INSPECT_STORED_RECEIPT_NO_AUTO_RETRY',raw);
   assert.equal(status.calls.length,1,raw);assert.equal(status.calls[0].state,'VALIDATION_FAILED',raw);
   assert.equal(status.calls[0].responseStored,true,raw);assert.equal(status.calls[0].errorCode,'TWO_PASS_RECEIPT_INVALID',raw);
   const receipt=f.db.prepare('SELECT response_json,response_complete,request_sha256 FROM yta_gemini_two_pass_calls WHERE job_id=? AND phase=0').get(f.id);
   assert.equal(receipt.response_json,raw);assert.equal(receipt.response_complete,1);assert.ok(receipt.request_sha256);
   const recovered=await f.call('recover','POST',{phase:0,confirmNoProviderCall:true});
   assert.equal((await recovered.json()).error.code,'TWO_PASS_RECEIPT_INVALID',raw);
   assert.equal(f.db.prepare('SELECT response_json FROM yta_gemini_two_pass_calls WHERE job_id=? AND phase=0').get(f.id).response_json,raw);
   const duplicate=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});
   assert.equal((await duplicate.json()).error.code,'TWO_PASS_DISPATCH_SCOPE_CHANGED',raw);
   const newQuote=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});
   assert.equal((await newQuote.json()).error.code,'TWO_PASS_ALREADY_STARTED',raw);
   assert.equal(f.sends,1,raw);
  }finally{f.db.close();}
 }
});

test('paid flags cannot count or generate for an unlisted job, and the approved budget stays below USD 0.17',async()=>{
 const f=await fixture();try{
  let counts=0;const count=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens;
  f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async body=>{counts++;return count(body);};
  f.env.GEMINI_TWO_PASS_ALLOWED_JOB_ID='other-job';
  const denied=await f.call('quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true});
  assert.equal((await denied.json()).error.code,'TWO_PASS_JOB_NOT_ALLOWED');assert.equal(counts,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yta_gemini_two_pass_jobs').get().n,0);
  f.env.GEMINI_TWO_PASS_ALLOWED_JOB_ID=f.id;
  const q=await quoteApprove(f);assert.ok(q.maxMicroUsd<=170000);assert.match(q.executionId,/^[0-9a-f-]{36}$/i);assert.equal(counts,1);
  assert.equal((await(await f.call('status')).json()).quote.executionId,q.executionId);
  f.env.GEMINI_TWO_PASS_ALLOWED_JOB_ID='other-job';
  const run=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});
  assert.equal((await run.json()).error.code,'TWO_PASS_JOB_NOT_ALLOWED');assert.equal(counts,1);assert.equal(f.sends,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yta_gemini_two_pass_calls').get().n,0);
 }finally{f.db.close();}
});
