import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {routeApi} from '../src/worker.mjs';
import {encryptProviderKey} from '../src/vault.mjs';
import {sourceSnapshot,summaryRequest,reviewRequest,validateReview,costCeiling,countTokensRequest,TWO_PASS_MODEL,TWO_PASS_OUTPUT_CAP} from '../src/gemini-two-pass-contract.mjs';

const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
const report={summary:[{text:'첫 발언과 둘째 발언을 종합했다',evidenceIds:[1,2]}],chapters:[{text:'첫 발언',evidenceIds:[1]},{text:'둘째 발언',evidenceIds:[2]}],claims:[],numbers:[],critical:[],conclusion:'발언 두 개를 요약했다'};
async function fixture(){
 const db=new DatabaseSync(':memory:');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0015_gemini_two_pass.sql'])db.exec(readFileSync(new URL(file,import.meta.url),'utf8'));
 const DB={prepare(sql){const make=args=>({bind(...next){return make(next);},async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}});return make([]);}};
 const id='33333333-3333-4333-8333-333333333333',path='/api/jobs/'+id,segments=[{id:1,startMs:0,endMs:1000,text:'첫 발언'},{id:2,startMs:1000,endMs:2000,text:'둘째 발언'}],audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'b'.repeat(64)};
 db.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Two pass mock','audio','TRANSCRIBED',2,?,?,?,?)").run(id,new Date().toISOString(),new Date().toISOString(),'null',JSON.stringify(audit));
 db.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").run(id,segments.map(s=>s.text).join('\n'),JSON.stringify(segments),new Date().toISOString());
 const root=Buffer.alloc(32,8),secret=await encryptProviderKey(root,'gemini','OFFLINE_TWO_PASS_KEY');db.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','gemini',?,?,?,?)").run(secret.version,secret.ivB64,secret.ciphertextB64,new Date().toISOString());
 let sends=0,review={verdict:'PASS',issues:[]},finishReason='STOP';
 const provider={countTokens:async()=>300,generate:async body=>{sends++;const output=sends===1?report:review,responseText=JSON.stringify({candidates:[{finishReason,content:{parts:[{text:JSON.stringify(output)}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:100,thoughtsTokenCount:20}});return {responseText,responseBytes:new TextEncoder().encode(responseText).length,httpStatus:200,complete:true};}};
 const env={DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_GEMINI_TWO_PASS:'true',ENABLE_GEMINI_TWO_PASS_PAID:'true',GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED:'true',ALLOW_PAID_API:'false',PAID_MODEL_ACCESS_VERIFIED:'true',PAID_TAX_MAX_BPS_VERIFIED:'true',GEMINI_TWO_PASS_TEST_PROVIDER:provider};
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
test('FIRST_READY cancellation wins against a second-phase count still in flight',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f);await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});
  f.env.GEMINI_TWO_PASS_TEST_PROVIDER.countTokens=async()=>{const cancelled=await f.call('cancel','POST',{});assert.equal(cancelled.status,200);return 300;};
  const second=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await second.json()).error.code,'TWO_PASS_DISPATCH_CONFLICT');assert.equal(f.sends,1);
  assert.equal((await(await f.call('status')).json()).state,'CANCELLED');
 }finally{f.db.close();}
});
test('a key rotation after the final guard cannot change the approved dispatch credential',async()=>{
 const f=await fixture();try{const q=await quoteApprove(f),original=f.env.DB,newKey=await encryptProviderKey(Buffer.alloc(32,8),'gemini','ROTATED_UNAPPROVED_KEY');let usedKey;
  const generate=f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate;f.env.GEMINI_TWO_PASS_TEST_PROVIDER.generate=async(body,credential)=>{usedKey=credential.key;return generate(body);};
  f.env.DB={prepare(sql){const statement=original.prepare(sql);if(sql.startsWith('SELECT 1 AS ok FROM jobs j JOIN yta_sources s ON s.job_id=j.id JOIN yta_gemini_two_pass_jobs'))return {bind(...args){const bound=statement.bind(...args);return {async first(){const result=await bound.first();f.db.prepare("UPDATE provider_credentials SET iv_b64=?,ciphertext_b64=?,updated_at=? WHERE owner_id='owner' AND provider='gemini'").run(newKey.ivB64,newKey.ciphertextB64,new Date(Date.now()+1000).toISOString());return result;}};}};return statement;}};
  const result=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal(result.status,200,await result.clone().text());assert.equal(usedKey,'OFFLINE_TWO_PASS_KEY');assert.equal(f.sends,1);
 }finally{f.db.close();}
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
test('two bounded mock generations persist both receipts and a reviewed report, duplicate POST sends nothing',async()=>{
 const f=await fixture();try{
  const q=await quoteApprove(f);
  const first=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal(first.status,200,await first.clone().text());assert.equal((await first.json()).status.state,'FIRST_READY');
  const again=await f.call('run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal((await again.json()).error.code,'TWO_PASS_DISPATCH_SCOPE_CHANGED');assert.equal(f.sends,1);
  const second=await f.call('run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});assert.equal(second.status,200,await second.clone().text());assert.equal((await second.json()).status.state,'COMPLETE');assert.equal(f.sends,2);
  const reopened=await(await routeApi(request(f.path),f.env)).json();assert.equal(reopened.job.report.kind,'GEMINI_TWO_PASS_REVIEWED');
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
  status=(await(await f.call('status')).json());assert.equal(status.state,'COMPLETE');assert.equal(status.calls[1].state,'RECEIVED');
  const recoveredSecond=await f.call('recover','POST',{phase:1,confirmNoProviderCall:true});assert.equal(recoveredSecond.status,200,await recoveredSecond.clone().text());assert.equal((await recoveredSecond.json()).providerCalled,false);assert.equal(f.sends,2);
 }finally{f.db.close();}
});
