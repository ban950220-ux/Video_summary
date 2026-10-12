import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {routeApi} from '../src/worker.mjs';
import {encryptProviderKey} from '../src/vault.mjs';
import {fullSummaryRequest,PAID_SUMMARY_CATALOG} from '../src/paid-summary-contract.mjs';
import {runPaidGeminiFullSummary} from '../src/paid-summary-adapter.mjs';
import {priceSummaryQuote} from '../src/paid-summary-budget.mjs';

const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
async function fixture(){
 const db=new DatabaseSync(':memory:');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0008_paid_summary_budget.sql'])db.exec(readFileSync(new URL(file,import.meta.url),'utf8'));
 const DB={prepare(sql){const make=args=>({bind(...next){return make(next);},async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}});return make([]);}};
 const id='22222222-2222-4222-8222-222222222222',path='/api/jobs/'+id,segments=[{id:1,startMs:0,endMs:1000,text:'첫 발언'},{id:2,startMs:1000,endMs:2000,text:'둘째 발언'}],audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
 db.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Paid mock','audio','TRANSCRIBED',2,?,?,?,?)").run(id,new Date().toISOString(),new Date().toISOString(),'null',JSON.stringify(audit));
 db.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").run(id,segments.map(s=>s.text).join('\n'),JSON.stringify(segments),new Date().toISOString());
 const root=Buffer.alloc(32,7),secret=await encryptProviderKey(root,'gemini','OFFLINE_MOCK_KEY');
 db.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','gemini',?,?,?,?)").run(secret.version,secret.ivB64,secret.ciphertextB64,new Date().toISOString());
 return {db,DB,id,path,segments,env:{DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_PAID_SUMMARY:'false',ALLOW_PAID_API:'false'}};
}
const report={summary:[{text:'첫 발언과 둘째 발언을 종합했다',evidenceIds:[1,2]}],chapters:[{text:'첫 발언',evidenceIds:[1]},{text:'둘째 발언',evidenceIds:[2]}],claims:[],numbers:[],critical:[],conclusion:'발언 두 개를 요약했다'};

test('server quote ID, explicit approval, gated mock execution, reopen and TXT keep one full synthesis',async()=>{
 const f=await fixture();try{
  let calls=0;const disabled=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:'none'}),f.env);assert.equal((await disabled.json()).error.code,'PAID_EXECUTION_DISABLED');assert.equal(calls,0);
  const quoted=await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env);assert.equal(quoted.status,200,await quoted.clone().text());const {quoteId,quote}=await quoted.json();assert.equal(quote.model,'gemini-3.1-flash-lite');assert.equal(quote.requestSha256.length,64);assert.equal(quote.maxRetries,0);
  const again=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();assert.equal(again.quoteId,quoteId);
  const invalid=await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId,maxMicroUsd:quote.maxMicroUsd+1,maxCalls:1,expiresAt:quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);assert.equal((await invalid.json()).error.code,'PAID_APPROVAL_SCOPE_CHANGED');
  const approved=await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId,maxMicroUsd:quote.maxMicroUsd,maxCalls:1,expiresAt:quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());assert.equal((await approved.json()).automaticExecution,false);
  f.db.prepare("UPDATE jobs SET audit_json=json_set(audit_json,'$.summaryProvider','prior-metadata','$.externalFactCheck','NOT_PERFORMED') WHERE id=?").run(f.id);
  f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='true';
  const unverified=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:quoteId}),f.env);assert.equal((await unverified.json()).error.code,'PAID_EXECUTION_DISABLED');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_paid_summary_reservations').get().n,0);
  f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch,body})=>{calls++;assert.equal(body.generationConfig.maxOutputTokens,8192);await beforeFetch();return {text:JSON.stringify(report),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20},modelVersion:'mock-model'};};
  const executed=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:quoteId}),f.env);assert.equal(executed.status,200,await executed.clone().text());const result=await executed.json();assert.equal(result.job.report.kind,'GEMINI_PAID_FULL_EVIDENCE_LINKED');assert.equal(result.job.report.outputKind,'FULL_VIDEO_SYNTHESIS');assert.equal(result.settlement.state,'SETTLED');assert.equal(calls,1);
  const reopened=await(await routeApi(request(f.path),f.env)).json();assert.equal(reopened.job.report.summary[0].evidenceIds.length,2);
  const exported=await routeApi(request(f.path+'/export?format=txt'),f.env),txt=await exported.text();assert.ok(txt.includes('첫 발언'));assert.ok(txt.includes('둘째 발언'));
  const cached=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:quoteId}),f.env);assert.equal(cached.status,200);assert.equal(calls,1);
  const status=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(status.finalReportSaved,true);assert.equal(status.reservations[0].state,'SETTLED');assert.equal(status.reservations[0].usage.thoughtsTokenCount,20);assert.equal(status.providerInvoiceAmount,'UNKNOWN');
 }finally{f.db.close();}
});

test('simultaneous quote requests return one server-issued scope and non-owner access is denied',async()=>{
 const f=await fixture();try{
  const [a,b]=await Promise.all([routeApi(request(f.path+'/paid-summary-quote','POST'),f.env),routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)]);
  assert.equal(a.status,200,await a.clone().text());assert.equal(b.status,200,await b.clone().text());
  const [first,second]=await Promise.all([a.json(),b.json()]);assert.equal(first.quoteId,second.quoteId);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_paid_summary_quotes WHERE state='ISSUED'").get().n,1);
  f.db.prepare("UPDATE jobs SET owner_id='different' WHERE id=?").run(f.id);
  const denied=await routeApi(request(f.path+'/paid-summary-status'),f.env);assert.equal((await denied.json()).error.code,'NOT_FOUND');
 }finally{f.db.close();}
});

test('approval rejects a stored quote whose price and hash were changed away from the server catalog',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();
  const forged=await priceSummaryQuote({...issued.quote,priceInputMicroUsdPerMillion:1});
  f.db.prepare('UPDATE yta_paid_summary_quotes SET quote_json=?,quote_sha256=? WHERE id=?').run(JSON.stringify(forged),forged.quoteSha256,issued.quoteId);
  const rejected=await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:forged.maxMicroUsd,maxCalls:1,expiresAt:forged.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
  assert.equal((await rejected.json()).error.code,'PAID_QUOTE_SCOPE_CHANGED');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_paid_summary_approvals').get().n,0);
 }finally{f.db.close();}
});

test('mock dispatch guard blocks changed key and releases only a proven unsent reservation',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();
  await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
  f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';let calls=0;
  f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{f.db.prepare("UPDATE provider_credentials SET ciphertext_b64='rotated' WHERE provider='gemini'").run();await beforeFetch();calls++;};
  const blocked=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal((await blocked.json()).error.code,'PAID_CREDENTIAL_CHANGED');assert.equal(calls,0);
  const state=f.db.prepare('SELECT state,outcome FROM yta_paid_summary_reservations').get();assert.equal(state.state,'RELEASED');assert.equal(state.outcome,'PROVEN_NOT_SENT');
 }finally{f.db.close();}
});

test('official-model request budgets a full synthetic 1,226-segment transcript with schema',()=>{
 const segments=Array.from({length:1226},(_,i)=>({id:i+1,startMs:i*4807,endMs:(i+1)*4807,text:'저장된 한국어 발언 '.repeat(4)})),source={raw:segments.map(s=>s.text).join('\n'),segments};
 const planned=fullSummaryRequest(source,{audioProcessingCoverage:1,audioBoundaryAmbiguityCount:47});
 assert.ok(planned.requestBytes>source.raw.length);assert.ok(planned.estimatedInputUpper<PAID_SUMMARY_CATALOG.inputLimit);
 assert.equal(planned.inputChargeCeiling,1_048_576);assert.equal(planned.outputChargeCeiling,65_536);assert.equal(planned.body.generationConfig.maxOutputTokens,8192);assert.ok(planned.body.generationConfig.responseJsonSchema.properties.chapters);
});

test('cancel, expiry and source changes at the final guard prove no dispatch',async()=>{
 for(const mode of ['cancel','expire','source','audit']){
  const f=await fixture();try{
   const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
   f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';let sent=0;
   f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{if(mode==='cancel')await routeApi(request(f.path+'/paid-summary-cancel','POST'),f.env);if(mode==='expire')f.db.prepare('UPDATE yta_paid_summary_approvals SET expires_at=?').run(Date.now()-1);if(mode==='source')f.db.prepare("UPDATE yta_sources SET raw='changed'").run();if(mode==='audit')f.db.prepare("UPDATE jobs SET audit_json=json_set(audit_json,'$.audioBoundaryReview','CHANGED_INPUT')").run();await beforeFetch();sent++;};
   const reply=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(reply.status,409,mode+': '+await reply.clone().text());assert.equal(sent,0);
   const status=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(status.reservations[0].state,'RELEASED');assert.equal(status.reservations[0].outcome,'PROVEN_NOT_SENT');
  }finally{f.db.close();}
 }
});

test('unknown provider result remains reserved and invalid output with receipt is settled without a report',async()=>{
 for(const mode of ['unknown','invalid']){
  const f=await fixture();try{
   const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
   f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';let sends=0;
   f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();sends++;if(mode==='unknown')throw Error('mock lost response');return {text:JSON.stringify({...report,chapters:[]}),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}};};
   const reply=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.ok(reply.status>=409);assert.equal(sends,1);
   const status=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(status.finalReportSaved,false);assert.equal(status.reservations[0].state,mode==='unknown'?'UNCERTAIN':'SETTLED');assert.equal(status.reservations[0].reserved_micro_usd,issued.quote.maxCallMicroUsd);
   const again=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(again.status,409);assert.equal(sends,1);
  }finally{f.db.close();}
 }
});

test('concurrent paid mock execution claims one call and a lost response reconciles through status',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
  f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';let release,started,calls=0;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();calls++;started();await gate;return {text:JSON.stringify(report),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}};};
  const first=routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);await entered;
  const duplicate=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(duplicate.status,409);assert.equal(calls,1);
  release();const saved=await first;assert.equal(saved.status,200);
  const reconciled=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(reconciled.finalReportSaved,true);assert.equal(reconciled.reservations.length,1);assert.equal(reconciled.reservations[0].state,'SETTLED');
 }finally{f.db.close();}
});

test('paid adapter uses stored encrypted key and official model endpoint only after the final callback',async()=>{
 const f=await fixture();try{
  const current={segments:f.segments,raw:f.segments.map(s=>s.text).join('\n')},body=fullSummaryRequest(current,{audioProcessingCoverage:1}).body;
  f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';let guard=false,calls=0;
  const result=await runPaidGeminiFullSummary({env:f.env,body,beforeFetch:()=>{guard=true;},fetchFn:async(url,options)=>{calls++;assert.equal(guard,true);assert.match(url,/models\/gemini-3\.1-flash-lite:generateContent$/);assert.equal(options.headers['x-goog-api-key'],'OFFLINE_MOCK_KEY');return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:80,thoughtsTokenCount:10}});}});
  assert.equal(calls,1);assert.equal(result.usage.thoughtsTokenCount,10);
 }finally{f.db.close();}
});
