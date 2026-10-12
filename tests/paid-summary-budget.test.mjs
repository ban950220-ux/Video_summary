import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {routeApi} from '../src/worker.mjs';
import {priceSummaryQuote,approvePaidSummaryBudget,reservePaidSummaryCall,markPaidSummaryUncertain,cancelPaidSummaryBudget} from '../src/paid-summary-budget.mjs';

const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(b=>b.toString(16).padStart(2,'0')).join('');
function fixture(){
 const db=new DatabaseSync(':memory:');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0008_paid_summary_budget.sql'])db.exec(readFileSync(new URL(file,import.meta.url),'utf8'));
 const DB={prepare(sql){const make=args=>({bind(...next){return make(next);},async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}});return make([]);}};
 const jobId='11111111-1111-4111-8111-111111111111',snapshot={raw:'첫 발언\n둘째 발언',segmentsJson:JSON.stringify([{id:1,startMs:0,endMs:1000,text:'첫 발언'},{id:2,startMs:1000,endMs:2000,text:'둘째 발언'}]),auditJson:JSON.stringify({audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)})};
 db.prepare("INSERT INTO jobs(id,owner_id,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','audio','TRANSCRIBED',2,?,?,?,?)").run(jobId,new Date().toISOString(),new Date().toISOString(),'null',snapshot.auditJson);
 db.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").run(jobId,snapshot.raw,snapshot.segmentsJson,new Date().toISOString());
 return {db,DB,jobId,snapshot};
}

test('stored transcript choice remains read-only and never presents an unverified paid price',async()=>{
 const f=fixture();try{
  let writes=0;const env={DB:{prepare(sql){if(!/^SELECT\b/i.test(sql.trim())){writes++;throw Error('unexpected write');}return f.DB.prepare(sql);}},ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false'};
  const response=await routeApi(new Request('https://test.invalid/api/jobs/'+f.jobId+'/summary-choice'),env),choice=await response.json();
  assert.equal(response.status,200,JSON.stringify(choice));assert.equal(choice.transcription.remainingChunks,0);assert.equal(choice.summary.savedRawStages,0);
  assert.equal(choice.summary.requestedOutput,'FULL_VIDEO_SYNTHESIS');assert.equal(choice.summary.intermediateOutput,'RAW_CHECKPOINT_BUNDLE');
  assert.equal(choice.free.eta.status,'UNKNOWN');assert.equal(choice.free.automaticPaidFallback,false);
  assert.equal(choice.paid.executionEnabled,false);assert.equal(choice.paid.maxMicroUsd,null);assert.equal(choice.paid.priceVersion,null);assert.equal(choice.paid.eta.status,'UNKNOWN');assert.equal(writes,0);
 }finally{f.db.close();}
});

test('mock quote binds price, taxes, retries, source and exact user cap; concurrent reservations cannot exceed it',async()=>{
 const f=fixture();try{
  const sourceSha256=await hash(f.snapshot),quote=await priceSummaryQuote({jobId:f.jobId,sourceSha256,model:'offline-mock-model',priceVersion:'offline-v1',priceSource:'TEST_FIXTURE_ONLY',inputTokensUpper:100000,outputTokensUpper:20000,plannedCalls:2,maxRetries:1,maxTaxBps:1000,priceInputMicroUsdPerMillion:1_000_000,priceOutputMicroUsdPerMillion:2_000_000,credentialGeneration:'mock-key-generation',expiresAt:Date.now()+600000});
  assert.equal(quote.inputCostMicroUsd,100000);assert.equal(quote.outputCostMicroUsd,40000);assert.equal(quote.maxCallMicroUsd,154000);assert.equal(quote.maxMicroUsd,462000);assert.equal(quote.maxCalls,3);assert.equal(quote.transcriptionCostMicroUsd,0);assert.equal(quote.eta.status,'UNKNOWN');
  const base={id:'approval-1',sourceSnapshot:f.snapshot,maxMicroUsd:quote.maxMicroUsd,maxCalls:quote.maxCalls,expiresAt:quote.expiresAt,confirmExactQuote:true};
  await assert.rejects(approvePaidSummaryBudget(f.DB,quote,{...base,maxMicroUsd:quote.maxMicroUsd+1}),{code:'PAID_APPROVAL_SCOPE_CHANGED'});
  await assert.rejects(approvePaidSummaryBudget(f.DB,{...quote,priceVersion:'changed'},base),{code:'PAID_APPROVAL_SCOPE_CHANGED'});
  await approvePaidSummaryBudget(f.DB,quote,base);
  const input={approvalId:base.id,jobId:f.jobId,sourceSha256,sourceSnapshot:f.snapshot,quoteSha256:quote.quoteSha256,model:quote.model,priceVersion:quote.priceVersion,credentialGeneration:quote.credentialGeneration,amountMicroUsd:quote.maxCallMicroUsd};
  await assert.rejects(reservePaidSummaryCall(f.DB,{...input,id:'too-much',callIndex:0,amountMicroUsd:quote.maxCallMicroUsd+1}),{code:'PAID_BUDGET_OR_SCOPE_BLOCKED'});
  const first=await Promise.allSettled([reservePaidSummaryCall(f.DB,{...input,id:'first',callIndex:0}),reservePaidSummaryCall(f.DB,{...input,id:'duplicate',callIndex:0})]);assert.equal(first.filter(item=>item.status==='fulfilled').length,1);
  await markPaidSummaryUncertain(f.DB,'first');
  await reservePaidSummaryCall(f.DB,{...input,id:'second',callIndex:1});
  await reservePaidSummaryCall(f.DB,{...input,id:'third',callIndex:2});
  await assert.rejects(reservePaidSummaryCall(f.DB,{...input,id:'fourth',callIndex:3}),{code:'PAID_BUDGET_OR_SCOPE_BLOCKED'});
  assert.equal(f.db.prepare("SELECT SUM(reserved_micro_usd) total FROM yta_paid_summary_reservations WHERE state<>'RELEASED'").get().total,quote.maxMicroUsd);
  await cancelPaidSummaryBudget(f.DB,base.id);
  await assert.rejects(reservePaidSummaryCall(f.DB,{...input,id:'after-cancel',callIndex:4,amountMicroUsd:1}),{code:'PAID_BUDGET_OR_SCOPE_BLOCKED'});
  assert.equal(f.db.prepare("SELECT state FROM yta_paid_summary_reservations WHERE id='first'").get().state,'UNCERTAIN');
 }finally{f.db.close();}
});

test('changed source, audit, key generation, expiry and deletion marker block mock budget use',async()=>{
 const f=fixture();try{
  const sourceSha256=await hash(f.snapshot),quote=await priceSummaryQuote({jobId:f.jobId,sourceSha256,model:'mock',priceVersion:'test',priceSource:'TEST_FIXTURE_ONLY',inputTokensUpper:1000,outputTokensUpper:1000,plannedCalls:1,maxRetries:0,maxTaxBps:0,priceInputMicroUsdPerMillion:1_000_000,priceOutputMicroUsdPerMillion:1_000_000,credentialGeneration:'key-1',expiresAt:Date.now()+600000});
  await approvePaidSummaryBudget(f.DB,quote,{id:'a',sourceSnapshot:f.snapshot,maxMicroUsd:quote.maxMicroUsd,maxCalls:quote.maxCalls,expiresAt:quote.expiresAt,confirmExactQuote:true});
  const input={id:'r',approvalId:'a',callIndex:0,amountMicroUsd:quote.maxCallMicroUsd,jobId:f.jobId,sourceSha256,sourceSnapshot:f.snapshot,quoteSha256:quote.quoteSha256,model:'mock',priceVersion:'test',credentialGeneration:'key-1'};
  for(const altered of [{model:'other'},{priceVersion:'other'},{credentialGeneration:'key-2'},{now:quote.expiresAt}])await assert.rejects(reservePaidSummaryCall(f.DB,{...input,...altered}),{code:'PAID_BUDGET_OR_SCOPE_BLOCKED'});
  f.db.prepare("UPDATE jobs SET audit_json=? WHERE id=?").run(JSON.stringify({audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'changed'}),f.jobId);
  await assert.rejects(reservePaidSummaryCall(f.DB,input),{code:'PAID_BUDGET_OR_SCOPE_BLOCKED'});
  f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(f.snapshot.auditJson,f.jobId);
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'deletion',0,'DELETING',?)").run(f.jobId+':deleting',f.jobId,new Date().toISOString());
  await assert.rejects(reservePaidSummaryCall(f.DB,input),{code:'PAID_BUDGET_OR_SCOPE_BLOCKED'});
 }finally{f.db.close();}
});

test('cancellation racing with a reservation leaves no post-cancel budget use',async()=>{
 const f=fixture();try{
  const sourceSha256=await hash(f.snapshot),quote=await priceSummaryQuote({jobId:f.jobId,sourceSha256,model:'mock',priceVersion:'test',priceSource:'TEST_FIXTURE_ONLY',inputTokensUpper:1000,outputTokensUpper:1000,plannedCalls:2,maxRetries:0,maxTaxBps:0,priceInputMicroUsdPerMillion:1_000_000,priceOutputMicroUsdPerMillion:1_000_000,credentialGeneration:'key-1',expiresAt:Date.now()+600000});
  await approvePaidSummaryBudget(f.DB,quote,{id:'a',sourceSnapshot:f.snapshot,maxMicroUsd:quote.maxMicroUsd,maxCalls:quote.maxCalls,expiresAt:quote.expiresAt,confirmExactQuote:true});
  const input={approvalId:'a',amountMicroUsd:quote.maxCallMicroUsd,jobId:f.jobId,sourceSha256,sourceSnapshot:f.snapshot,quoteSha256:quote.quoteSha256,model:quote.model,priceVersion:quote.priceVersion,credentialGeneration:quote.credentialGeneration};
  const race=await Promise.allSettled([reservePaidSummaryCall(f.DB,{...input,id:'r0',callIndex:0}),cancelPaidSummaryBudget(f.DB,'a')]);
  assert.equal(race[1].status,'fulfilled');assert.equal(f.db.prepare("SELECT state FROM yta_paid_summary_approvals WHERE id='a'").get().state,'CANCELLED');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_paid_summary_reservations').get().n,race[0].status==='fulfilled'?1:0);
  await assert.rejects(reservePaidSummaryCall(f.DB,{...input,id:'r1',callIndex:1}),{code:'PAID_BUDGET_OR_SCOPE_BLOCKED'});
 }finally{f.db.close();}
});

test('user-selected lower money, call and expiry caps constrain mock reservations',async()=>{
 const f=fixture();try{
  const sourceSha256=await hash(f.snapshot),quote=await priceSummaryQuote({jobId:f.jobId,sourceSha256,model:'mock',priceVersion:'test',priceSource:'TEST_FIXTURE_ONLY',inputTokensUpper:1000,outputTokensUpper:1000,plannedCalls:2,maxRetries:1,maxTaxBps:0,priceInputMicroUsdPerMillion:1_000_000,priceOutputMicroUsdPerMillion:1_000_000,credentialGeneration:'key-1',expiresAt:Date.now()+600000});
  const expiresAt=Date.now()+300000,cap=quote.maxCallMicroUsd;
  await approvePaidSummaryBudget(f.DB,quote,{id:'limited',sourceSnapshot:f.snapshot,maxMicroUsd:cap,maxCalls:2,expiresAt,confirmExactQuote:true});
  const input={approvalId:'limited',amountMicroUsd:cap,jobId:f.jobId,sourceSha256,sourceSnapshot:f.snapshot,quoteSha256:quote.quoteSha256,model:quote.model,priceVersion:quote.priceVersion,credentialGeneration:quote.credentialGeneration};
  await reservePaidSummaryCall(f.DB,{...input,id:'one',callIndex:0});
  await assert.rejects(reservePaidSummaryCall(f.DB,{...input,id:'over-money',callIndex:1}),{code:'PAID_BUDGET_OR_SCOPE_BLOCKED'});
  await assert.rejects(reservePaidSummaryCall(f.DB,{...input,id:'expired',callIndex:1,amountMicroUsd:1,now:expiresAt}),{code:'PAID_BUDGET_OR_SCOPE_BLOCKED'});
  await assert.rejects(reservePaidSummaryCall(f.DB,{...input,id:'over-calls',callIndex:2,amountMicroUsd:1}),{code:'PAID_BUDGET_OR_SCOPE_BLOCKED'});
 }finally{f.db.close();}
});
