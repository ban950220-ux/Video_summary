import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {routeApi} from '../src/worker.mjs';
import {handleSiteRequest} from '../src/site-worker.mjs';
import {encryptProviderKey} from '../src/vault.mjs';
import {fullSummaryRequest,paidRequestCostPreview,PAID_SUMMARY_CATALOG} from '../src/paid-summary-contract.mjs';
import {runPaidGeminiFullSummary} from '../src/paid-summary-adapter.mjs';
import {priceSummaryQuote} from '../src/paid-summary-budget.mjs';
import {consumeFirstTrial} from '../src/paid-summary-trial.mjs';

const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
async function fixture(){
 const db=new DatabaseSync(':memory:');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0008_paid_summary_budget.sql','../migrations/0009_paid_first_trial.sql','../migrations/0010_paid_summary_receipts.sql'])db.exec(readFileSync(new URL(file,import.meta.url),'utf8'));
 const DB={prepare(sql){const make=args=>({bind(...next){return make(next);},async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}});return make([]);}};
 const id='22222222-2222-4222-8222-222222222222',path='/api/jobs/'+id,segments=[{id:1,startMs:0,endMs:1000,text:'첫 발언'},{id:2,startMs:1000,endMs:2000,text:'둘째 발언'}],audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
 db.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Paid mock','audio','TRANSCRIBED',2,?,?,?,?)").run(id,new Date().toISOString(),new Date().toISOString(),'null',JSON.stringify(audit));
 db.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").run(id,segments.map(s=>s.text).join('\n'),JSON.stringify(segments),new Date().toISOString());
 const root=Buffer.alloc(32,7),secret=await encryptProviderKey(root,'gemini','OFFLINE_MOCK_KEY');
 db.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','gemini',?,?,?,?)").run(secret.version,secret.ivB64,secret.ciphertextB64,new Date().toISOString());
 return {db,DB,id,path,segments,env:{DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_PAID_SUMMARY:'false',ALLOW_PAID_API:'false'}};
}
const report={summary:[{text:'첫 발언과 둘째 발언을 종합했다',evidenceIds:[1,2]}],chapters:[{text:'첫 발언',evidenceIds:[1]},{text:'둘째 발언',evidenceIds:[2]}],claims:[],numbers:[],critical:[],conclusion:'발언 두 개를 요약했다'};

test('owner site path accepts JSON quote, approval and cancellation then reads status',async()=>{
 const f=await fixture();try{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=publicKey.export({format:'jwk'}),domain='https://paid-test.cloudflareaccess.com',aud='paid-test-audience',origin='https://private.example.com';
  Object.assign(f.env,{ACCESS_TEAM_DOMAIN:domain,ACCESS_AUD:aud,ACCESS_OWNER_EMAIL:'owner@example.com'});
  const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),now=Math.floor(Date.now()/1000),header=encode({alg:'RS256',kid:'paid-test'}),payload=encode({iss:domain,aud:[aud],iat:now-10,exp:now+3600,email:'owner@example.com'}),token=`${header}.${payload}.${sign('RSA-SHA256',Buffer.from(`${header}.${payload}`),privateKey).toString('base64url')}`;
  const fetcher=async url=>{assert.equal(url,domain+'/cdn-cgi/access/certs');return Response.json({keys:[{...jwk,kid:'paid-test',alg:'RS256'}]});};
  const call=(action,method='GET',body)=>handleSiteRequest(new Request(origin+f.path+'/'+action,{method,headers:{'Cf-Access-Jwt-Assertion':token,...(method==='GET'?{}:{Origin:origin,'Content-Type':'application/json'})},body:method==='GET'?undefined:JSON.stringify(body??{})}),f.env,{fetcher,nowMs:Date.now()});
  const issuedResponse=await call('paid-summary-quote','POST');assert.equal(issuedResponse.status,200,await issuedResponse.clone().text());const issued=await issuedResponse.json();
  const approvedResponse=await call('paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true});assert.equal(approvedResponse.status,200,await approvedResponse.clone().text());
  const cancelledResponse=await call('paid-summary-cancel','POST');assert.equal(cancelledResponse.status,200,await cancelledResponse.clone().text());
  const statusResponse=await call('paid-summary-status');assert.equal(statusResponse.status,200,await statusResponse.clone().text());const status=await statusResponse.json();assert.equal(status.approval.state,'CANCELLED');assert.equal(status.executionReady,false);assert.deepEqual(status.reservations,[]);
 }finally{f.db.close();}
});

test('server quote ID, explicit approval, gated mock execution, reopen and TXT keep one full synthesis',async()=>{
 const f=await fixture();try{
  let calls=0;const disabled=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:'none'}),f.env);assert.equal((await disabled.json()).error.code,'PAID_EXECUTION_DISABLED');assert.equal(calls,0);
  const quoted=await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env);assert.equal(quoted.status,200,await quoted.clone().text());const {quoteId,quote}=await quoted.json();assert.equal(quote.model,'gemini-3.1-flash-lite');assert.equal(quote.requestSha256.length,64);assert.equal(quote.maxRetries,0);assert.equal(quote.inputTokensUpper,1_048_576);assert.equal(quote.outputTokensUpper,65_536);assert.equal(quote.maxCallMicroUsd,720896);assert.ok(quote.costEstimate.estimatedPreTaxHighMicroUsd<quote.perCallMicroUsd);
  const again=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();assert.equal(again.quoteId,quoteId);
  const invalid=await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId,maxMicroUsd:quote.maxMicroUsd+1,maxCalls:1,expiresAt:quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);assert.equal((await invalid.json()).error.code,'PAID_APPROVAL_SCOPE_CHANGED');
  const underfunded=await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId,maxMicroUsd:quote.maxCallMicroUsd-1,maxCalls:1,expiresAt:quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);assert.equal((await underfunded.json()).error.code,'PAID_APPROVAL_SCOPE_CHANGED');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_paid_summary_approvals').get().n,0);
  const approved=await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId,maxMicroUsd:quote.maxMicroUsd,maxCalls:1,expiresAt:quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());assert.equal((await approved.json()).automaticExecution,false);
  f.db.prepare("UPDATE jobs SET audit_json=json_set(audit_json,'$.summaryProvider','prior-metadata','$.externalFactCheck','NOT_PERFORMED') WHERE id=?").run(f.id);
  f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='false';f.env.PAID_SUMMARY_EXECUTION_APPROVED='true';
  const unverified=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:quoteId}),f.env);assert.equal((await unverified.json()).error.code,'PAID_EXECUTION_DISABLED');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_paid_summary_reservations').get().n,0);
  f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='false';f.env.PAID_SUMMARY_EXECUTION_APPROVED='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch,body})=>{calls++;assert.equal(body.generationConfig.maxOutputTokens,8192);await beforeFetch();return {text:JSON.stringify(report),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20},modelVersion:'mock-model'};};
  assert.equal((await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json()).executionReady,true);
  const executed=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:quoteId}),f.env);assert.equal(executed.status,200,await executed.clone().text());const result=await executed.json();assert.equal(result.job.report.kind,'GEMINI_PAID_FULL_EVIDENCE_LINKED');assert.equal(result.job.report.outputKind,'FULL_VIDEO_SYNTHESIS');assert.equal(result.settlement.state,'SETTLED');assert.equal(calls,1);
  const reopened=await(await routeApi(request(f.path),f.env)).json();assert.equal(reopened.job.report.summary[0].evidenceIds.length,2);
  const exported=await routeApi(request(f.path+'/export?format=txt'),f.env),txt=await exported.text();assert.ok(txt.includes('첫 발언'));assert.ok(txt.includes('둘째 발언'));
  const cached=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:quoteId}),f.env);assert.equal(cached.status,200);assert.equal(calls,1);
  const status=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(status.finalReportSaved,true);assert.equal(status.reservations[0].state,'SETTLED');assert.equal(status.reservations[0].usage.thoughtsTokenCount,20);assert.equal(status.providerInvoiceAmount,'UNKNOWN');
 }finally{f.db.close();}
});

test('first generation trial is scoped, cost-gated and consumed once without claiming prior success',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();
  assert.equal(issued.firstTrialAvailable,true);assert.equal(issued.firstTrialEvidence.metadataGet,'NOT_REQUESTED');assert.equal(issued.firstTrialEvidence.generation,'UNTESTED');
  const approvalBody={quoteId:issued.quoteId,maxMicroUsd:720896,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true,trialKind:'FIRST_GENERATION_UNTESTED',confirmUnknownGeneration:true,confirmExistingPrepayOnly:true,confirmCurrentKeyProject:true};
  const missingConsent=await routeApi(request(f.path+'/paid-summary-approve','POST',{...approvalBody,confirmUnknownGeneration:false}),f.env);assert.equal((await missingConsent.json()).error.code,'PAID_FIRST_TRIAL_SCOPE_CHANGED');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_paid_summary_approvals').get().n,0);
  Object.assign(f.env,{ENABLE_PAID_SUMMARY:'true',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_FIRST_GENERATION_TRIAL_ENABLED:'true'});
  f.env.PAID_TAX_MAX_BPS_VERIFIED='true'; // The ordinary paid gate alone cannot authorize the scoped first trial.
  const unverifiedCost=await routeApi(request(f.path+'/paid-summary-approve','POST',approvalBody),f.env);assert.equal((await unverifiedCost.json()).error.code,'PAID_FIRST_TRIAL_SCOPE_CHANGED');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_paid_summary_approvals').get().n,0);
  f.env.PAID_FIRST_TRIAL_USD_COST_REVIEWED='true'; // Offline fixture only; production settings stay untouched.
  const approved=await routeApi(request(f.path+'/paid-summary-approve','POST',approvalBody),f.env);assert.equal(approved.status,200,await approved.clone().text());assert.equal((await approved.json()).trial.generation,'UNTESTED');
  const trial=f.db.prepare('SELECT * FROM yta_paid_first_trial').get();assert.equal(trial.job_id,f.id);assert.equal(trial.source_sha256,issued.quote.sourceSha256);assert.equal(trial.request_sha256,issued.quote.requestSha256);assert.equal(trial.quote_sha256,issued.quote.quoteSha256);assert.equal(trial.model,issued.quote.model);assert.equal(trial.credential_generation,issued.quote.credentialGeneration);assert.equal(trial.expires_at,issued.quote.expiresAt);assert.equal(trial.max_calls,1);assert.equal(trial.max_micro_usd,720896);
  let sends=0;f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();sends++;return {text:JSON.stringify(report),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}};};
  f.env.PAID_FIRST_TRIAL_USD_COST_REVIEWED='false';
  const before=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(before.firstTrial.generation,'UNTESTED');assert.equal(before.firstTrial.evidence.observedPrepayTopup,'OWNER_UI_2026_10_11_KRW_8000_EQUALS_CREDIT_7273_PLUS_VAT_727');assert.equal(before.executionReady,false);
  const blocked=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal((await blocked.json()).error.code,'PAID_EXECUTION_DISABLED');assert.equal(sends,0);assert.equal(f.db.prepare('SELECT state FROM yta_paid_first_trial').get().state,'APPROVED');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_paid_summary_reservations').get().n,0);
  f.env.PAID_FIRST_TRIAL_USD_COST_REVIEWED='true';
  assert.equal((await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json()).executionReady,true);
  const done=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(done.status,200,await done.clone().text());assert.equal(sends,1);
  assert.equal(f.db.prepare('SELECT state FROM yta_paid_first_trial').get().state,'CONSUMED');
  const after=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(after.firstTrial.generation,'SUCCEEDED');assert.equal(after.firstTrial.metadataGet,'NOT_REQUESTED');assert.equal(after.executionReady,false);
  const same=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(same.status,200);assert.equal(sends,1);
 }finally{f.db.close();}
});

test('concurrent first-trial claims consume the global permission only once',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();
  const body={quoteId:issued.quoteId,maxMicroUsd:720896,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true,trialKind:'FIRST_GENERATION_UNTESTED',confirmUnknownGeneration:true,confirmExistingPrepayOnly:true,confirmCurrentKeyProject:true};
  Object.assign(f.env,{ENABLE_PAID_SUMMARY:'true',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_FIRST_GENERATION_TRIAL_ENABLED:'true',PAID_FIRST_TRIAL_USD_COST_REVIEWED:'true'});
  assert.equal((await routeApi(request(f.path+'/paid-summary-approve','POST',body),f.env)).status,200);
  const reservationId=issued.quoteId+':call:0';f.db.prepare("INSERT INTO yta_paid_summary_reservations(id,approval_id,call_index,reserved_micro_usd,state,created_at) VALUES(?,?,0,720896,'RESERVED',?)").run(reservationId,issued.quoteId,new Date().toISOString());
  const source=f.db.prepare('SELECT raw,segments_json FROM yta_sources WHERE job_id=?').get(f.id),job=f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(f.id),credential=f.db.prepare("SELECT cipher_version,iv_b64,ciphertext_b64,updated_at FROM provider_credentials WHERE owner_id='owner' AND provider='gemini'").get();
  const args={approvalId:issued.quoteId,reservationId,quote:issued.quote,credential,current:{sourceSha256:issued.quote.sourceSha256,requestSha256:issued.quote.requestSha256,sourceSnapshot:{raw:source.raw,segmentsJson:source.segments_json,auditJson:job.audit_json}}};
  await assert.rejects(consumeFirstTrial(f.DB,{...args,current:{...args.current,requestSha256:'f'.repeat(64)}}),{code:'PAID_FIRST_TRIAL_SCOPE_CHANGED'});assert.equal(f.db.prepare('SELECT state FROM yta_paid_first_trial').get().state,'APPROVED');
  const results=await Promise.allSettled([consumeFirstTrial(f.DB,args),consumeFirstTrial(f.DB,args)]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);assert.equal(results.filter(item=>item.status==='rejected'&&item.reason.code==='PAID_FIRST_TRIAL_SCOPE_CHANGED').length,1);
  assert.equal(f.db.prepare('SELECT state FROM yta_paid_first_trial').get().state,'CONSUMED');
 }finally{f.db.close();}
});

test('trial consume rechecks key, source, deletion, cancellation and expiry before provider fetch',async()=>{
 for(const mode of ['key','source','deletion','cancel','expiry']){
  const f=await fixture();try{
   const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();
   Object.assign(f.env,{ENABLE_PAID_SUMMARY:'true',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_FIRST_GENERATION_TRIAL_ENABLED:'true',PAID_FIRST_TRIAL_USD_COST_REVIEWED:'true'});
   const body={quoteId:issued.quoteId,maxMicroUsd:720896,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true,trialKind:'FIRST_GENERATION_UNTESTED',confirmUnknownGeneration:true,confirmExistingPrepayOnly:true,confirmCurrentKeyProject:true};
   assert.equal((await routeApi(request(f.path+'/paid-summary-approve','POST',body),f.env)).status,200,mode);
   const original=f.env.DB;let injected=false;f.env.DB={prepare(sql){const statement=original.prepare(sql);if(!sql.startsWith("UPDATE yta_paid_first_trial SET state='CONSUMED'"))return statement;return {bind(...args){const bound=statement.bind(...args);return {async run(){if(!injected){injected=true;if(mode==='key')f.db.prepare("UPDATE provider_credentials SET ciphertext_b64='rotated' WHERE provider='gemini'").run();if(mode==='source')f.db.prepare("UPDATE yta_sources SET raw='changed' WHERE job_id=?").run(f.id);if(mode==='deletion')f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'gemini',0,'DELETING',?)").run(f.id+':deleting',f.id,new Date().toISOString());if(mode==='cancel')f.db.prepare("UPDATE yta_paid_summary_approvals SET state='CANCELLED' WHERE id=?").run(issued.quoteId);if(mode==='expiry')f.db.prepare('UPDATE yta_paid_summary_approvals SET expires_at=? WHERE id=?').run(Date.now()-1,issued.quoteId);}return bound.run();}};}};}};
   let sent=0;f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();sent++;};
   const response=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(response.status,409,mode+': '+await response.clone().text());assert.equal(sent,0,mode);assert.equal(injected,true,mode);
   assert.equal(f.db.prepare('SELECT state FROM yta_paid_first_trial').get().state,'APPROVED',mode);assert.equal(f.db.prepare('SELECT state FROM yta_paid_summary_reservations').get().state,'RELEASED',mode);
  }finally{f.db.close();}
 }
});

test('trial consume returning after approval expiry cannot reach provider fetch',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json(),expiresAt=Date.now()+700;
  Object.assign(f.env,{ENABLE_PAID_SUMMARY:'true',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_FIRST_GENERATION_TRIAL_ENABLED:'true',PAID_FIRST_TRIAL_USD_COST_REVIEWED:'true'});
  const body={quoteId:issued.quoteId,maxMicroUsd:720896,maxCalls:1,expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true,trialKind:'FIRST_GENERATION_UNTESTED',confirmUnknownGeneration:true,confirmExistingPrepayOnly:true,confirmCurrentKeyProject:true};
  assert.equal((await routeApi(request(f.path+'/paid-summary-approve','POST',body),f.env)).status,200);
  const original=f.env.DB;f.env.DB={prepare(sql){const statement=original.prepare(sql);if(!sql.startsWith("UPDATE yta_paid_first_trial SET state='CONSUMED'"))return statement;return {bind(...args){const bound=statement.bind(...args);return {async run(){const result=await bound.run();await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiresAt-Date.now()+20)));return result;}};}};}};
  let sent=0;f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();sent++;};
  const response=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(response.status,409,await response.clone().text());assert.equal(sent,0);
  assert.equal(f.db.prepare('SELECT state FROM yta_paid_first_trial').get().state,'CONSUMED');assert.equal(f.db.prepare('SELECT state FROM yta_paid_summary_reservations').get().state,'RELEASED');
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
  f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='false';f.env.PAID_SUMMARY_EXECUTION_APPROVED='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';let calls=0;
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

test('98-minute, 50,300-character synthetic transcript has a separate scenario and full-model reserve',()=>{
 const segments=Array.from({length:100},(_,i)=>({id:i+1,startMs:i*58920,endMs:(i+1)*58920,text:'가'.repeat(503)})),source={raw:segments.map(s=>s.text).join('\n'),segments};
 const request=fullSummaryRequest(source,{audioProcessingCoverage:1}),preview=paidRequestCostPreview(request);
 assert.equal(segments.map(s=>s.text).join('').length,50300);assert.equal(segments.at(-1).endMs,5_892_000);
 assert.equal(request.inputChargeCeiling,1_048_576);assert.equal(request.outputChargeCeiling,65_536);assert.equal(request.estimatedInputUpper,request.requestBytes*2+8192);
 assert.ok(preview.estimatedPreTaxLowMicroUsd<preview.estimatedPreTaxHighMicroUsd);
 assert.ok(preview.estimatedPreTaxHighMicroUsd<preview.reservationPreTaxMicroUsd);
 assert.equal(preview.reservationWithBufferMicroUsd,720896);
 assert.equal(preview.inputTokenCountVerified,false);
 const oversized=[{id:1,startMs:0,endMs:1000,text:'a'.repeat(600000)}];
 assert.throws(()=>fullSummaryRequest({raw:oversized[0].text,segments:oversized},{audioProcessingCoverage:1}),{code:'PAID_INPUT_LIMIT'});
});

test('cancel, expiry and source changes at the final guard prove no dispatch',async()=>{
 for(const mode of ['cancel','expire','source','audit']){
  const f=await fixture();try{
   const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
   f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='false';f.env.PAID_SUMMARY_EXECUTION_APPROVED='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';let sent=0;
   f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{if(mode==='cancel')await routeApi(request(f.path+'/paid-summary-cancel','POST'),f.env);if(mode==='expire')f.db.prepare('UPDATE yta_paid_summary_approvals SET expires_at=?').run(Date.now()-1);if(mode==='source')f.db.prepare("UPDATE yta_sources SET raw='changed'").run();if(mode==='audit')f.db.prepare("UPDATE jobs SET audit_json=json_set(audit_json,'$.audioBoundaryReview','CHANGED_INPUT')").run();await beforeFetch();sent++;};
   const reply=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(reply.status,409,mode+': '+await reply.clone().text());assert.equal(sent,0);
   const status=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(status.reservations[0].state,'RELEASED');assert.equal(status.reservations[0].outcome,'PROVEN_NOT_SENT');
  }finally{f.db.close();}
 }
});

test('approval expiring while the final D1 read waits blocks provider dispatch',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json(),expiresAt=Date.now()+700;
  const approved=await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);assert.equal(approved.status,200);
  f.env.ENABLE_PAID_SUMMARY='true';f.env.PAID_SUMMARY_EXECUTION_APPROVED='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';let sent=0;
  const original=f.env.DB;f.env.DB={prepare(sql){const statement=original.prepare(sql);if(!sql.startsWith('SELECT a.expires_at AS approval_expires_at'))return statement;return {bind(...args){const bound=statement.bind(...args);return {async first(){const row=await bound.first();await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiresAt-Date.now()+20)));return row;}};}};}};
  f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();sent++;};
  const response=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal((await response.json()).error.code,'PAID_DISPATCH_SCOPE_CHANGED');assert.equal(sent,0);
  assert.equal(f.db.prepare('SELECT state FROM yta_paid_summary_reservations').get().state,'RELEASED');
 }finally{f.db.close();}
});

test('separate paid gate leaves a selected Groq Free summary call available',async()=>{
 const f=await fixture(),prior=globalThis.fetch;try{
  f.env.ENABLE_LIVE_FREE='true';f.env.GROQ_API_KEY='OFFLINE_GROQ_FREE_KEY';f.env.ENABLE_PAID_SUMMARY='true';f.env.PAID_SUMMARY_EXECUTION_APPROVED='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';assert.equal(f.env.ALLOW_PAID_API,'false');
  f.env.ALLOW_PAID_API='true';assert.equal((await(await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:'none'}),f.env)).json()).error.code,'PAID_EXECUTION_DISABLED');f.env.ALLOW_PAID_API='false';
  const planResponse=await routeApi(request(f.path+'/groq-summary-plan'),f.env);assert.equal(planResponse.status,200,await planResponse.clone().text());const plan=await planResponse.json();
  const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();
  const approval={jobId:f.id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
  const approved=await routeApi(request(f.path+'/groq-summary-approval','POST',approval),f.env);assert.equal(approved.status,200,await approved.clone().text());
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'stop',message:{content:JSON.stringify(report)}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390}});};
  const started=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(started.status,202,await started.clone().text());assert.equal(calls,1);
 }finally{globalThis.fetch=prior;f.db.close();}
});

test('unknown provider result remains reserved and invalid output with receipt is settled without a report',async()=>{
 for(const mode of ['unknown','invalid']){
  const f=await fixture();try{
   const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
   f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='false';f.env.PAID_SUMMARY_EXECUTION_APPROVED='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';let sends=0;
   f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();sends++;if(mode==='unknown')throw Error('mock lost response');return {text:JSON.stringify({...report,chapters:[]}),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}};};
   const reply=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.ok(reply.status>=409);assert.equal(sends,1);
   const status=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(status.finalReportSaved,false);assert.equal(status.reservations[0].state,mode==='unknown'?'UNCERTAIN':'SETTLED');assert.equal(status.reservations[0].reserved_micro_usd,issued.quote.maxCallMicroUsd);
   if(mode==='invalid'){
    const receipt=f.db.prepare('SELECT state,error_code,response_complete,response_sha256,response_json,validation_version FROM yta_paid_summary_receipts').get();assert.equal(receipt.state,'VALIDATION_FAILED');assert.equal(receipt.error_code,'PAID_REPORT_WINDOW_COVERAGE');assert.equal(receipt.response_complete,1);assert.equal(receipt.response_sha256,createHash('sha256').update(receipt.response_json).digest('hex'));assert.ok(receipt.response_json.includes('promptTokenCount'));
    const recovery=await routeApi(request(f.path+'/paid-summary-revalidate','POST',{reservationId:issued.quoteId+':call:0',confirmNoProviderCall:true}),f.env);assert.equal(recovery.status,409);assert.equal((await recovery.json()).error.code,'PAID_RESPONSE_UNGROUNDED');assert.equal(f.db.prepare('SELECT revalidation_version,revalidation_code FROM yta_paid_summary_receipts').get().revalidation_code,'PAID_REPORT_WINDOW_COVERAGE');assert.equal(sends,1);
   }
   const again=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(again.status,409);assert.equal(sends,1);
  }finally{f.db.close();}
 }
});

test('saved response survives a failed report write and revalidates once without provider or ledger changes',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
  Object.assign(f.env,{ENABLE_PAID_SUMMARY:'true',ALLOW_PAID_API:'false',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_MODEL_ACCESS_VERIFIED:'true',PAID_TAX_MAX_BPS_VERIFIED:'true'});
  let calls=0;f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();calls++;return {text:JSON.stringify(report),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}};};
  const original=f.env.DB;let failed=false;f.env.DB={prepare(sql){const statement=original.prepare(sql);if(!sql.startsWith('UPDATE jobs SET report_json='))return statement;return {bind(...args){const bound=statement.bind(...args);return {async run(){if(!failed){failed=true;return {meta:{changes:0}};}return bound.run();}};}};}};
  const first=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal((await first.json()).error.code,'PAID_SAVE_SCOPE_CHANGED');assert.equal(calls,1);
  const before=f.db.prepare('SELECT state,outcome,usage_json,token_estimate_micro_usd FROM yta_paid_summary_reservations').get();assert.equal(before.state,'SETTLED');assert.equal(before.outcome,'REPORT_NOT_SAVED');assert.equal(f.db.prepare('SELECT state FROM yta_paid_summary_receipts').get().state,'SAVE_FAILED');
  f.env.DB=original;
  const unauthorized=await handleSiteRequest(new Request('https://private.example.com'+f.path+'/paid-summary-revalidate',{method:'POST',headers:{Origin:'https://private.example.com','Content-Type':'application/json'},body:'{}'}),{...f.env,ACCESS_TEAM_DOMAIN:'https://paid-test.cloudflareaccess.com',ACCESS_AUD:'paid-test-audience',ACCESS_OWNER_EMAIL:'owner@example.com'});assert.equal(unauthorized.status,401);
  const originalRaw=f.db.prepare('SELECT raw FROM yta_sources WHERE job_id=?').get(f.id).raw;f.db.prepare("UPDATE yta_sources SET raw='changed' WHERE job_id=?").run(f.id);
  assert.equal((await routeApi(request(f.path+'/paid-summary-revalidate','POST',{reservationId:issued.quoteId+':call:0',confirmNoProviderCall:true}),f.env)).status,409);f.db.prepare('UPDATE yta_sources SET raw=? WHERE job_id=?').run(originalRaw,f.id);
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'deletion',0,'DELETING',?)").run(f.id+':deleting',f.id,new Date().toISOString());assert.equal((await routeApi(request(f.path+'/paid-summary-revalidate','POST',{reservationId:issued.quoteId+':call:0',confirmNoProviderCall:true}),f.env)).status,404);f.db.prepare('DELETE FROM yta_operations WHERE id=?').run(f.id+':deleting');assert.equal(calls,1);
  const attempts=await Promise.all([0,1].map(()=>routeApi(request(f.path+'/paid-summary-revalidate','POST',{reservationId:issued.quoteId+':call:0',confirmNoProviderCall:true}),f.env)));assert.equal(attempts.filter(response=>response.status===200).length,1);assert.equal(attempts.filter(response=>response.status===409).length,1);assert.equal((await attempts.find(response=>response.status===200).json()).providerCalled,false);
  const again=await routeApi(request(f.path+'/paid-summary-revalidate','POST',{reservationId:issued.quoteId+':call:0',confirmNoProviderCall:true}),f.env);assert.equal(again.status,200);assert.equal(calls,1);assert.deepEqual(f.db.prepare('SELECT state,outcome,usage_json,token_estimate_micro_usd FROM yta_paid_summary_reservations').get(),before);assert.equal(f.db.prepare('SELECT state,revalidation_code FROM yta_paid_summary_receipts').get().revalidation_code,'REPORT_SAVED');
 }finally{f.db.close();}
});

test('an older settled run without a receipt remains unrecoverable',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
  f.db.prepare("INSERT INTO yta_paid_summary_reservations(id,approval_id,call_index,reserved_micro_usd,token_estimate_micro_usd,usage_json,outcome,state,created_at) VALUES(?,?,0,?,14247,?,'REPORT_NOT_SAVED','SETTLED',?)").run(issued.quoteId+':call:0',issued.quoteId,issued.quote.maxCallMicroUsd,JSON.stringify({promptTokenCount:50524,candidatesTokenCount:1077,thoughtsTokenCount:0}),new Date().toISOString());
  const status=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(status.receipt,null);assert.equal(status.finalReportSaved,false);
  const attempt=await routeApi(request(f.path+'/paid-summary-revalidate','POST',{reservationId:issued.quoteId+':call:0',confirmNoProviderCall:true}),f.env);assert.equal(attempt.status,409);assert.equal((await attempt.json()).error.code,'PAID_RECEIPT_SCOPE_CHANGED');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_paid_summary_reservations').get().n,1);
 }finally{f.db.close();}
});

test('failed receipt write settles known usage but never offers recovery',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
  Object.assign(f.env,{ENABLE_PAID_SUMMARY:'true',ALLOW_PAID_API:'false',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_MODEL_ACCESS_VERIFIED:'true',PAID_TAX_MAX_BPS_VERIFIED:'true'});
  let calls=0;f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();calls++;return {text:JSON.stringify(report),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}};};
  const original=f.env.DB;f.env.DB={prepare(sql){const statement=original.prepare(sql);if(!sql.startsWith('INSERT OR IGNORE INTO yta_paid_summary_receipts'))return statement;return {bind(){return {async run(){return {meta:{changes:0}};}};}};}};
  const reply=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal((await reply.json()).error.code,'PAID_RECEIPT_SCOPE_CHANGED');assert.equal(calls,1);
  f.env.DB=original;const status=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(status.reservations[0].outcome,'REPORT_NOT_SAVED');assert.equal(status.receipt,null);assert.equal(status.finalReportSaved,false);
  assert.equal((await routeApi(request(f.path+'/paid-summary-revalidate','POST',{reservationId:issued.quoteId+':call:0',confirmNoProviderCall:true}),f.env)).status,409);assert.equal(calls,1);
 }finally{f.db.close();}
});

test('job deletion scrubs paid response text while retaining the cost ledger',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
  Object.assign(f.env,{ENABLE_PAID_SUMMARY:'true',ALLOW_PAID_API:'false',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_MODEL_ACCESS_VERIFIED:'true',PAID_TAX_MAX_BPS_VERIFIED:'true'});
  f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();return {text:JSON.stringify({...report,chapters:[]}),usage:{promptTokenCount:300,candidatesTokenCount:90}};};
  await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.ok(f.db.prepare('SELECT response_json FROM yta_paid_summary_receipts').get().response_json);
  const before=f.db.prepare('SELECT state,outcome,usage_json,token_estimate_micro_usd FROM yta_paid_summary_reservations').get();const deleted=await routeApi(request(f.path,'DELETE'),f.env);assert.equal(deleted.status,200);
  const receipt=f.db.prepare('SELECT state,error_code,response_json,response_sha256,response_complete FROM yta_paid_summary_receipts').get();assert.equal(receipt.state,'SOURCE_DELETED');assert.equal(receipt.error_code,'PAID_SOURCE_DELETED');assert.equal(receipt.response_json,null);assert.equal(receipt.response_sha256,null);assert.equal(receipt.response_complete,0);
  assert.deepEqual(f.db.prepare('SELECT state,outcome,usage_json,token_estimate_micro_usd FROM yta_paid_summary_reservations').get(),before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_paid_summary_approvals').get().n,1);
 }finally{f.db.close();}
});

test('deletion tombstone blocks a late paid receipt insert',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
  Object.assign(f.env,{ENABLE_PAID_SUMMARY:'true',ALLOW_PAID_API:'false',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_MODEL_ACCESS_VERIFIED:'true',PAID_TAX_MAX_BPS_VERIFIED:'true'});
  f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();return {text:JSON.stringify(report),usage:{promptTokenCount:300,candidatesTokenCount:90}};};
  const original=f.env.DB;let removed=false;f.env.DB={prepare(sql){const statement=original.prepare(sql);if(!sql.startsWith('INSERT OR IGNORE INTO yta_paid_summary_receipts'))return statement;return {bind(...args){const bound=statement.bind(...args);return {async run(){if(!removed){removed=true;assert.equal((await routeApi(request(f.path,'DELETE'),{...f.env,DB:original})).status,200);}return bound.run();}};}};}};
  const response=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(response.status,409);assert.equal(removed,true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_paid_summary_receipts').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
 }finally{f.db.close();}
});

test('real adapter mock response recovers after metadata write failure or lost receipt readback without a second fetch',async()=>{
 for(const mode of ['metadata','readback','interrupted']){
  const f=await fixture();try{
   const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();
   Object.assign(f.env,{ENABLE_PAID_SUMMARY:'true',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_FIRST_GENERATION_TRIAL_ENABLED:'true',PAID_FIRST_TRIAL_USD_COST_REVIEWED:'true',ALLOW_PAID_API:'false'});
   const approvalBody={quoteId:issued.quoteId,maxMicroUsd:720896,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true,trialKind:'FIRST_GENERATION_UNTESTED',confirmUnknownGeneration:true,confirmExistingPrepayOnly:true,confirmCurrentKeyProject:true};assert.equal((await routeApi(request(f.path+'/paid-summary-approve','POST',approvalBody),f.env)).status,200);
   let sends=0;f.env.PAID_SUMMARY_TEST_RUNNER=args=>runPaidGeminiFullSummary({...args,fetchFn:async()=>{sends++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20},modelVersion:'gemini-3.1-flash-lite'});}});
   const original=f.env.DB;let failed=false;f.env.DB={prepare(sql){const statement=original.prepare(sql),target=mode==='metadata'?sql.startsWith('UPDATE yta_paid_summary_receipts SET state='):sql.startsWith('SELECT response_sha256,response_bytes,response_json,response_complete FROM yta_paid_summary_receipts')||mode==='interrupted'&&sql.startsWith("UPDATE yta_paid_summary_reservations SET state='UNCERTAIN'");if(!target)return statement;return {bind(...args){const bound=statement.bind(...args);return {async run(){if(mode==='metadata'&&!failed){failed=true;throw Error('offline metadata write failure');}if(mode==='interrupted')throw Error('offline worker interrupted before cost settlement');return bound.run();},async first(){if(mode!=='metadata'&&!failed){failed=true;throw Error('offline readback response lost');}return bound.first();}};}};}};
   const first=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.ok(first.status>=409,mode);assert.equal(failed,true);assert.equal(sends,1);
   f.env.DB=original;const receipt=f.db.prepare('SELECT response_json,response_sha256,model_version,finish_reason,usage_json FROM yta_paid_summary_receipts').get();assert.ok(receipt.response_json);assert.equal(receipt.response_sha256,createHash('sha256').update(receipt.response_json).digest('hex'));assert.equal(receipt.model_version,null);assert.equal(receipt.finish_reason,null);assert.equal(receipt.usage_json,null);
   const approvalBefore=f.db.prepare('SELECT * FROM yta_paid_summary_approvals').get(),trialBefore=f.db.prepare('SELECT * FROM yta_paid_first_trial').get(),costBefore=f.db.prepare('SELECT * FROM yta_paid_summary_reservations').get();assert.equal(trialBefore.state,'CONSUMED');assert.equal(costBefore.state,mode==='metadata'?'SETTLED':mode==='readback'?'UNCERTAIN':'RESERVED');
   const status=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(status.receipt.revalidationAvailable,true);
   const recovery=await routeApi(request(f.path+'/paid-summary-revalidate','POST',{reservationId:issued.quoteId+':call:0',confirmNoProviderCall:true}),f.env);assert.equal(recovery.status,200,mode+': '+await recovery.clone().text());assert.equal((await recovery.json()).costReconciliation,mode==='metadata'?'SETTLED_PRIOR':'REVIEW_REQUIRED');assert.equal((await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json()).costReconciliation,mode==='metadata'?'SETTLED_PRIOR':'REVIEW_REQUIRED');assert.equal(sends,1);
   assert.deepEqual(f.db.prepare('SELECT * FROM yta_paid_summary_approvals').get(),approvalBefore);assert.deepEqual(f.db.prepare('SELECT * FROM yta_paid_first_trial').get(),trialBefore);assert.deepEqual(f.db.prepare('SELECT * FROM yta_paid_summary_reservations').get(),costBefore);
  }finally{f.db.close();}
 }
});

test('exact 256000-byte UTF-8 response is stored whole and a larger response is never treated as complete',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
  Object.assign(f.env,{ENABLE_PAID_SUMMARY:'true',ALLOW_PAID_API:'false',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_MODEL_ACCESS_VERIFIED:'true',PAID_TAX_MAX_BPS_VERIFIED:'true'});
  const body=JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:90},modelVersion:'모의 한글 모델'}),bytes=new TextEncoder().encode(body).length,responseText=body+' '.repeat(256000-bytes);assert.equal(new TextEncoder().encode(responseText).length,256000);
  f.env.PAID_SUMMARY_TEST_RUNNER=args=>runPaidGeminiFullSummary({...args,fetchFn:async()=>new Response(responseText)});
  const response=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(response.status,200,await response.clone().text());const receipt=f.db.prepare('SELECT response_bytes,response_json,response_sha256,response_complete FROM yta_paid_summary_receipts').get();assert.equal(receipt.response_bytes,256000);assert.equal(receipt.response_json,responseText);assert.equal(receipt.response_sha256,createHash('sha256').update(responseText).digest('hex'));assert.equal(receipt.response_complete,1);
 }finally{f.db.close();}
});

test('concurrent paid mock execution claims one call and a lost response reconciles through status',async()=>{
 const f=await fixture();try{
  const issued=await(await routeApi(request(f.path+'/paid-summary-quote','POST'),f.env)).json();await routeApi(request(f.path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true}),f.env);
  f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='false';f.env.PAID_SUMMARY_EXECUTION_APPROVED='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';let release,started,calls=0;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  f.env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();calls++;started();await gate;return {text:JSON.stringify(report),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}};};
  const first=routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);await entered;
  const duplicate=await routeApi(request(f.path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),f.env);assert.equal(duplicate.status,409);assert.equal(calls,1);
  release();const saved=await first;assert.equal(saved.status,200);
  const reconciled=await(await routeApi(request(f.path+'/paid-summary-status'),f.env)).json();assert.equal(reconciled.finalReportSaved,true);assert.equal(reconciled.reservations.length,1);assert.equal(reconciled.reservations[0].state,'SETTLED');
 }finally{f.db.close();}
});

test('paid adapter uses stored encrypted key and official model endpoint only after the final callback',async()=>{
 const f=await fixture();try{
  const current={segments:f.segments,raw:f.segments.map(s=>s.text).join('\n')},planned=fullSummaryRequest(current,{audioProcessingCoverage:1}),body=planned.body,quote={requestBytes:planned.requestBytes,inputTokensUpper:planned.inputChargeCeiling,outputTokensUpper:planned.outputChargeCeiling,requestSha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
  f.env.ENABLE_PAID_SUMMARY='true';f.env.ALLOW_PAID_API='false';f.env.PAID_SUMMARY_EXECUTION_APPROVED='true';f.env.PAID_MODEL_ACCESS_VERIFIED='true';f.env.PAID_TAX_MAX_BPS_VERIFIED='true';let guard=false,calls=0;
  let recorded=false;const result=await runPaidGeminiFullSummary({env:f.env,body,quote,beforeFetch:()=>{guard=true;},recordResponse:({responseText,complete})=>{assert.equal(complete,true);assert.match(responseText,/promptTokenCount/);recorded=true;},fetchFn:async(url,options)=>{calls++;assert.equal(guard,true);assert.equal(options.body,JSON.stringify(body));assert.match(url,/models\/gemini-3\.1-flash-lite:generateContent$/);assert.equal(options.headers['x-goog-api-key'],'OFFLINE_MOCK_KEY');return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:80,thoughtsTokenCount:10}});}});
  assert.equal(calls,1);assert.equal(recorded,true);assert.equal(result.usage.thoughtsTokenCount,10);
  await assert.rejects(runPaidGeminiFullSummary({env:f.env,body:{...body,contents:[{role:'user',parts:[{text:'changed'}]}]},quote,beforeFetch:()=>{guard=true;},fetchFn:async()=>{calls++;throw Error('must not send');}}),{code:'PAID_WIRE_SCOPE_CHANGED'});assert.equal(calls,1);
  const sameBytes=structuredClone(body);sameBytes.contents[0].parts[0].text=sameBytes.contents[0].parts[0].text.replace('첫','셋');
  await assert.rejects(runPaidGeminiFullSummary({env:f.env,body:sameBytes,quote,beforeFetch:()=>{guard=true;},fetchFn:async()=>{calls++;throw Error('must not send');}}),{code:'PAID_WIRE_SCOPE_CHANGED'});assert.equal(calls,1);
  const overOutput=structuredClone(body);overOutput.generationConfig.maxOutputTokens=8193;
  await assert.rejects(runPaidGeminiFullSummary({env:f.env,body:overOutput,quote,beforeFetch:()=>{guard=true;},fetchFn:async()=>{calls++;throw Error('must not send');}}),{code:'PAID_WIRE_SCOPE_CHANGED'});assert.equal(calls,1);
 }finally{f.db.close();}
});

test('adapter records bounded response bytes before parsing and rejects partial, oversized and non-STOP output',async()=>{
 const f=await fixture();try{
  Object.assign(f.env,{ENABLE_PAID_SUMMARY:'true',ALLOW_PAID_API:'false',PAID_SUMMARY_EXECUTION_APPROVED:'true',PAID_MODEL_ACCESS_VERIFIED:'true',PAID_TAX_MAX_BPS_VERIFIED:'true'});
  const planned=fullSummaryRequest({segments:f.segments,raw:f.segments.map(s=>s.text).join('\n')},{audioProcessingCoverage:1}),body=planned.body,quote={requestBytes:planned.requestBytes,inputTokensUpper:planned.inputChargeCeiling,outputTokensUpper:planned.outputChargeCeiling,requestSha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
  const cases=[
   {name:'bad-json',response:()=>new Response('{bad',{headers:{'content-length':'4'}}),code:'PAID_RESPONSE_INVALID',complete:true},
   {name:'max-tokens',response:()=>Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'partial'}]}}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:10}}),code:'PAID_PROVIDER_UNCERTAIN',complete:true},
   {name:'empty',response:()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[]}}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:0}}),code:'PAID_PROVIDER_UNCERTAIN',complete:true},
   {name:'large',response:()=>new Response('a'.repeat(256001),{headers:{'content-length':'10'}}),code:'PAID_RESPONSE_TOO_LARGE',complete:false},
   {name:'partial',response:()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"candidates":'));controller.error(Error('lost response'));}})),code:'PAID_PROVIDER_UNCERTAIN',complete:false},
  ];
  for(const item of cases){let stored=null;await assert.rejects(runPaidGeminiFullSummary({env:f.env,body,quote,beforeFetch:()=>{},fetchFn:async()=>item.response(),recordResponse:response=>{stored=response;},recordEnvelope:()=>{assert.ok(stored?.complete);}}),{code:item.code},item.name);assert.equal(stored?.complete,item.complete,item.name);if(item.name==='large')assert.ok(stored.responseBytes>256000);}
 }finally{f.db.close();}
});
