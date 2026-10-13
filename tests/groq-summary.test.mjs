import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {routeApi} from '../src/worker.mjs';
import {handleSiteRequest} from '../src/site-worker.mjs';
import {partitionGroqTranscript,groqInputUpperBound,groqSummaryMessages,groqRawPrompt,groqMergePrompt,promptAudit,GROQ_SUMMARY_INPUT_BOUND} from '../src/groq-summary.mjs';
import {reportPrompt} from '../src/report.mjs';
import {encryptProviderKey} from '../src/vault.mjs';
import {capacityIdentity} from '../src/observed-capacity.mjs';
import {mergeAudioSegments} from '../src/audio.mjs';
import {GROQ_SUMMARY_CONTRACT_VERSION,GROQ_SUMMARY_RESPONSE_FORMAT,groqSummaryRequestBody} from '../src/groq-summary-contract.mjs';

const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
async function fixture({complete=true,large=false,sourceText=null,longSource=false}={}){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0002_live.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){const make=args=>({bind(...a){return make(a);},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:r.changes}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}});return make([]);}};
 const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GROQ_API_KEY:'NOT_REAL_TEST_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')};
 const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:longSource?6000:600,title:'Offline Groq summary'}),env)).json(),id=created.job.id,path='/api/jobs/'+id;
 const count=longSource?125:large?25:2,span=longSource?48000:large?24000:300000;
 const segments=Array.from({length:count},(_,i)=>({id:i+1,startMs:i*span,endMs:(i+1)*span,text:sourceText??`원문 ${i+1} ${longSource?'가나다라마바사아자차카타파하 '.repeat(28):large?'가나다라마바사 '.repeat(12):'검증'}`}));
 const raw=segments.map(part=>part.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:complete?1:0,audioFileSha256:'a'.repeat(64),audioSegmentOrigins:large?Array.from({length:500},(_,i)=>({segmentId:i+1,chunkIndex:i,startMs:i*1000,endMs:i*1000+900})):[]};
 db.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').run(id,raw,JSON.stringify(segments),'GROQ_OWNED_AUDIO',new Date().toISOString());
 db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify(audit),id);
 const plan=complete?await(await routeApi(request(path+'/groq-summary-plan'),env)).json():null;
 const review=plan&&await(await routeApi(request(path+'/groq-summary-approval'),env)).json();
 const approval=plan&&{jobId:id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
 return {db,env,id,path,plan,approval,segments};
}
async function sibling(f,{approve=true}={}){
 const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600,title:'Second owner job'}),f.env)).json(),id=created.job.id,path='/api/jobs/'+id;
 const raw=f.segments.map(part=>part.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
 f.db.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').run(id,raw,JSON.stringify(f.segments),'GROQ_OWNED_AUDIO',new Date().toISOString());
 f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify(audit),id);
 if(!approve)return {id,path};
 const plan=await(await routeApi(request(path+'/groq-summary-plan'),f.env)).json();
 const review=await(await routeApi(request(path+'/groq-summary-approval'),f.env)).json();
 const approval={jobId:id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
 assert.equal((await routeApi(request(path+'/groq-summary-approval','POST',approval),f.env)).status,200);
 return {id,path};
}
const valid=id=>({summary:[{text:'원문 검증',evidenceIds:[id]}],chapters:[{text:'시간대 요약',evidenceIds:[id]}],claims:[],numbers:[],critical:[],conclusion:'외부 사실은 미확인'});
const response=(body=valid(1),extra={})=>Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'stop',message:{content:JSON.stringify(body)}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390,completion_tokens_details:{reasoning_tokens:10}},...extra});
async function approvedCorrectionFixture({storedCredential=false}={}){
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),row=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(row.audit_json),groups=partitionGroqTranscript(f.segments,promptAudit({audit,duration_seconds:row.duration_seconds})),group=groups[8],hash=f.plan.transcriptHash,stamp=new Date(Date.now()-120000).toISOString();
 if(storedCredential){const encrypted=await encryptProviderKey(Buffer.alloc(32,7),'groq','STORED_TEST_ONLY_KEY');f.db.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','groq',?,?,?,?)").run(encrypted.version,encrypted.ivB64,encrypted.ciphertextB64,stamp);}
 const identity=await capacityIdentity(f.env,'groq');
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'STOPPED',?,?)").run(f.id+':groq-summary:approval:0',f.id,stamp,JSON.stringify({...f.approval,sequence:0,keyIdentity:identity}));
 const failedId=f.id+':groq-summary:'+hash+':raw:8',oldUnits=groqInputUpperBound(groqSummaryMessages(groqRawPrompt(group,promptAudit({audit,duration_seconds:row.duration_seconds}))))+1800,oldResult=JSON.stringify({reviewResult:{partialText:JSON.stringify({...valid(group[0].id),summary:[{text:'근거 없는 999원',evidenceIds:[group[0].id]}]}),usage:{inputTokens:1152,outputTokens:987,reasoningTokens:50,totalTokens:2139}}});
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',?,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(failedId,f.id,oldUnits,stamp,oldResult);
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2139,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),f.id,stamp);
 const url=f.path+'/groq-summary-correction',quoteResponse=await routeApi(request(url,'POST',{step:'quote'}),f.env);assert.equal(quoteResponse.status,200);const quote=await quoteResponse.json();
 const approved=await routeApi(request(url,'POST',{step:'approve',quoteId:quote.quoteId,quoteSha256:quote.contract.quoteSha256,reservedUnits:quote.contract.reservedUnits,maxCalls:1,confirmExactQuote:true,confirmPriorUsagePreserved:true,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200);const approval=await approved.json();
 return {f,group,url,quote,approval,failedId,oldResult};
}

test('owner-only raw:8 diagnostic classifies saved response without writes, provider calls or private text',async()=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),priorFetch=globalThis.fetch;let fetches=0;
 try{
  const jobRow=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),groups=partitionGroqTranscript(f.segments,promptAudit({audit:JSON.parse(jobRow.audit_json),duration_seconds:jobRow.duration_seconds})),group=groups[8],id=group[0].id,hash=f.plan.transcriptHash,stamp=new Date().toISOString();
  assert.ok(group&&groups.length>8);
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'STOPPED',?,?)").run(f.id+':groq-summary:approval:0',f.id,stamp,JSON.stringify({...f.approval,sequence:0}));
  for(let i=0;i<8;i++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(f.id+':groq-summary:'+hash+':raw:'+i,f.id,stamp,JSON.stringify({hash,key:'raw:'+i,report:valid(groups[i][0].id)}));
  const failedId=f.id+':groq-summary:'+hash+':raw:8',url=f.path+'/groq-summary-stage-diagnostic?stage=raw%3A8';
  const cases=[
   ['SCHEMA',JSON.stringify({...valid(id),summary:'PRIVATE_RESPONSE_CONTENT'}),null],
   ['EVIDENCE_ID',JSON.stringify({...valid(id),summary:[{text:'PRIVATE_RESPONSE_CONTENT',evidenceIds:[groups[9][0].id]}]}),1],
   ['GROUP_COVERAGE',JSON.stringify({...valid(id),chapters:[]}),1],
   ['UNSUPPORTED_NUMBER',JSON.stringify({...valid(id),summary:[{text:'PRIVATE_RESPONSE_CONTENT 999원',evidenceIds:[id]}]}),1],
   ['UNSUPPORTED_NUMBER',JSON.stringify({...valid(id),summary:[{text:'PRIVATE_RESPONSE_CONTENT 999원 999원',evidenceIds:[id]}]}),2],
   ['UNSUPPORTED_QUOTE',JSON.stringify({...valid(id),summary:[{text:'“PRIVATE_RESPONSE_CONTENT”',evidenceIds:[id]}]}),1],
   ['VALIDATION_PASS_ONLY',JSON.stringify({...valid(id),conclusion:'PRIVATE_RESPONSE_CONTENT'}),0],
   ['JSON_PARSE','{',null],
  ];
  globalThis.fetch=async()=>{fetches++;throw Error('MODEL_CALL_FORBIDDEN');};
  const denied=await handleSiteRequest(request(url),{...f.env,ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'diagnostic-owner-audience',ACCESS_OWNER_EMAIL:'owner@example.com'});assert.equal(denied.status,401);
  for(const [classification,raw,count] of cases){
   const result=JSON.stringify({reviewResult:{partialText:raw,usage:{inputTokens:1152,outputTokens:987,totalTokens:2139}}});
   f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?) ON CONFLICT(id) DO UPDATE SET result_json=excluded.result_json").run(failedId,f.id,stamp,result);
   const before={...f.db.prepare('SELECT * FROM yta_operations WHERE id=?').get(failedId)},reply=await routeApi(request(url),f.env),body=await reply.json();
   assert.equal(reply.status,200,classification);assert.equal(body.classification,classification);assert.equal(body.mismatchCount,count);assert.equal(body.stage,'raw:8');assert.equal(body.firstId,group[0].id);assert.equal(body.lastId,group.at(-1).id);assert.equal(body.segmentCount,group.length);assert.equal(body.providerCalls,0);assert.equal(body.responseCompleteVerified,false);assert.equal(body.providerReceiptVerified,false);
   assert.ok(!JSON.stringify(body).includes('PRIVATE_RESPONSE_CONTENT'));assert.deepEqual({...f.db.prepare('SELECT * FROM yta_operations WHERE id=?').get(failedId)},before);
  }
  assert.equal(fetches,0);
  const invalid=await routeApi(request(f.path+'/groq-summary-stage-diagnostic?stage=merge%3A0%3A0'),f.env);assert.equal(invalid.status,409);
 }finally{globalThis.fetch=priorFetch;f.db.close();}
});

test('a separately approved free raw:8 correction preserves old ledgers and resumes at raw:9',async()=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),oldFetch=globalThis.fetch;
 try{
  const jobRow=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(jobRow.audit_json),groups=partitionGroqTranscript(f.segments,promptAudit({audit,duration_seconds:jobRow.duration_seconds})),hash=f.plan.transcriptHash,group=groups[8],stamp=new Date(Date.now()-120000).toISOString(),identity=await capacityIdentity(f.env,'groq');
  assert.ok(group&&groups.length>9);
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'STOPPED',?,?)").run(f.id+':groq-summary:approval:0',f.id,stamp,JSON.stringify({...f.approval,sequence:0,keyIdentity:identity,state:undefined}));
  for(let i=0;i<8;i++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(f.id+':groq-summary:'+hash+':raw:'+i,f.id,stamp,JSON.stringify({hash,key:'raw:'+i,report:valid(groups[i][0].id)}));
  const failedId=f.id+':groq-summary:'+hash+':raw:8',oldUnits=groqInputUpperBound(groqSummaryMessages(groqRawPrompt(group,promptAudit({audit,duration_seconds:jobRow.duration_seconds}))))+1800,oldResult=JSON.stringify({reviewResult:{partialText:JSON.stringify({...valid(group[0].id),summary:[{text:'원문에서 확인되지 않은 999원',evidenceIds:[group[0].id]}]}),usage:{inputTokens:1152,outputTokens:987,reasoningTokens:50,totalTokens:2139}}});
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',?,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(failedId,f.id,oldUnits,stamp,oldResult);
  f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2139,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),f.id,stamp);
  const url=f.path+'/groq-summary-correction';
  for(const badUsage of [{inputTokens:1152,outputTokens:1801,reasoningTokens:50,totalTokens:2953},{inputTokens:oldUnits-100,outputTokens:101,reasoningTokens:0,totalTokens:oldUnits+1}]){
   f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify({reviewResult:{partialText:JSON.parse(oldResult).reviewResult.partialText,usage:badUsage}}),failedId);
   f.db.prepare("UPDATE usage_events SET used_units=? WHERE job_id=? AND provenance='PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN'").run(badUsage.totalTokens,f.id);
   const rejected=await routeApi(request(url),f.env);assert.equal(rejected.status,409,await rejected.clone().text());assert.equal((await rejected.json()).error.code,'SUMMARY_CORRECTION_EVIDENCE_INVALID');
  }
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(oldResult,failedId);
  f.db.prepare("UPDATE usage_events SET used_units=2139 WHERE job_id=? AND provenance='PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN'").run(f.id);
  const denied=await handleSiteRequest(request(url),{...f.env,ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'diagnostic-owner-audience',ACCESS_OWNER_EMAIL:'owner@example.com'});assert.equal(denied.status,401);
  const initial=await routeApi(request(url),f.env);assert.equal(initial.status,200,await initial.clone().text());assert.equal((await initial.json()).originalMismatchCount,1);
  const quoteResponse=await routeApi(request(url,'POST',{step:'quote'}),f.env);assert.equal(quoteResponse.status,200,await quoteResponse.clone().text());const quote=await quoteResponse.json();assert.equal(quote.contract.maxCalls,1);assert.equal(quote.contract.automaticRetries,0);
  const approveBody={step:'approve',quoteId:quote.quoteId,quoteSha256:quote.contract.quoteSha256,reservedUnits:quote.contract.reservedUnits,maxCalls:1,confirmExactQuote:true,confirmPriorUsagePreserved:true,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,noAutomaticRetry:true};
  const approved=await routeApi(request(url,'POST',approveBody),f.env);assert.equal(approved.status,200,await approved.clone().text());const approval=await approved.json();
  let calls=0;globalThis.fetch=async(_url,options)=>{calls++;const body=JSON.parse(options.body);assert.match(body.messages[1].content,/올해\/내년\/작년\/오늘 등 상대 시점은 원문 그대로 유지하고 달력 연도나 날짜를 추정하지 마라/);assert.deepEqual(body.response_format,GROQ_SUMMARY_RESPONSE_FORMAT);return response(valid(group[0].id));};
  f.env.GROQ_API_KEY='ROTATED_TEST_KEY';
  const changedKey=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(changedKey.status,409);assert.equal((await changedKey.json()).error.code,'SUMMARY_CORRECTION_SCOPE_CHANGED');assert.equal(calls,0);
  f.env.GROQ_API_KEY='NOT_REAL_TEST_KEY';
  f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify({...audit,changedAfterApproval:true}),f.id);
  const changedSource=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(changedSource.status,409);assert.equal(calls,0);
  f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify(audit),f.id);
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify({...quote.contract,expiresAt:Date.now()-1}),quote.quoteId);
  const expired=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(expired.status,409);assert.equal(calls,0);
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(quote.contract),quote.quoteId);
  const executed=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(executed.status,202,await executed.clone().text());assert.equal(calls,1);
  const savedAttempt=f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(approval.attemptId).result_json,savedObject=JSON.parse(savedAttempt),readStatus=()=>routeApi(request(f.path+'/groq-summary-status'),f.env);
  for(const changed of [{...savedObject,quoteSha256:'unverified'},{...savedObject,requestSha256:'unverified'},{...savedObject,usageEventId:'missing'},{...savedObject,usage:{...savedObject.usage,totalTokens:9999}},{...savedObject,model:'wrong-model'}]){
   f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(changed),approval.attemptId);
   assert.equal((await readStatus()).status,409);
  }
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(savedAttempt,approval.attemptId);
  for(const [id,state] of [[quote.quoteId,'STOPPED'],[approval.approvalId,'STOPPED']]){
   f.db.prepare('UPDATE yta_operations SET state=? WHERE id=?').run(state,id);assert.equal((await readStatus()).status,409);f.db.prepare('UPDATE yta_operations SET state=? WHERE id=?').run(id===quote.quoteId?'ISSUED':'APPROVED',id);
  }
  for(const id of [quote.quoteId,approval.approvalId,f.id+':groq-summary:approval:0']){
   const original=f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(id).result_json;
   f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(original),requestSha256:'unverified'}),id);
   assert.equal((await readStatus()).status,409);f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(original,id);
  }
  for(const [table,id] of [['yta_operations',quote.quoteId],['yta_operations',approval.approvalId],['usage_events',savedObject.usageEventId]]){
   const row=f.db.prepare('SELECT * FROM '+table+' WHERE id=?').get(id),columns=Object.keys(row);
   f.db.prepare('DELETE FROM '+table+' WHERE id=?').run(id);assert.equal((await readStatus()).status,409);
   f.db.prepare('INSERT INTO '+table+'('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(column=>row[column]));
  }
  f.db.prepare('UPDATE usage_events SET provenance=? WHERE id=?').run('TAMPERED',savedObject.usageEventId);assert.equal((await readStatus()).status,409);f.db.prepare('UPDATE usage_events SET provenance=? WHERE id=?').run('PROVIDER_REPORTED_CORRECTIVE_ACCOUNT_REMAINING_UNKNOWN',savedObject.usageEventId);
  assert.deepEqual({...f.db.prepare('SELECT state,error_code,result_json,units FROM yta_operations WHERE id=?').get(failedId)},{state:'FAILED_UNCERTAIN',error_code:'SUMMARY_RESPONSE_INVALID',result_json:oldResult,units:oldUnits});
  assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(approval.attemptId).state,'DONE');assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE job_id=? AND provider='groq'").get(f.id).n,2);
  const status=await routeApi(request(f.path+'/groq-summary-status'),f.env);assert.equal(status.status,200,await status.clone().text());assert.equal((await status.json()).completedStages,9);
  const realNow=Date.now;try{Date.now=()=>quote.contract.expiresAt+1;assert.equal((await readStatus()).status,200);}finally{Date.now=realNow;}
  f.env.GROQ_API_KEY='ROTATED_TEST_KEY';assert.equal((await readStatus()).status,200);f.env.GROQ_API_KEY='NOT_REAL_TEST_KEY';
  const next=await routeApi(request(f.path+'/groq-summary-approval'),f.env);assert.equal(next.status,200,await next.clone().text());assert.equal((await next.json()).windowStart,9);
  for(let i=9;i<groups.length;i++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(f.id+':groq-summary:'+hash+':raw:'+i,f.id,stamp,JSON.stringify({hash,key:'raw:'+i,report:valid(groups[i][0].id)}));
  const promptScope=promptAudit({audit,duration_seconds:jobRow.duration_seconds});
  let parts=groups.map(item=>({ids:item.map(segment=>segment.id),firstIds:[item[0].id],startMs:item[0].startMs,endMs:item.at(-1).endMs,report:valid(item[0].id)}));
  for(let level=0;parts.length>1;level++){
   const batches=[];let batch=[];
   for(const part of parts){const candidate=[...batch,part];if(groqInputUpperBound(groqSummaryMessages(groqMergePrompt(candidate,promptScope,{final:true})))>GROQ_SUMMARY_INPUT_BOUND){batches.push(batch);batch=[part];}else batch=candidate;}
   if(batch.length)batches.push(batch);
   const nextParts=[];
   for(let i=0;i<batches.length;i++){
    const items=batches[i];if(items.length===1){nextParts.push(items[0]);continue;}
    const firstIds=items.flatMap(item=>item.firstIds),ids=items.flatMap(item=>item.ids),key='merge:'+level+':'+i,report={...valid(firstIds[0]),chapters:firstIds.map(id=>({text:'시간대 요약',evidenceIds:[id]}))};
    f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(f.id+':groq-summary:'+hash+':'+key,f.id,stamp,JSON.stringify({hash,key,report}));
    nextParts.push({ids,firstIds,startMs:items[0].startMs,endMs:items.at(-1).endMs,report});
   }
   assert.ok(nextParts.length<parts.length);parts=nextParts;
  }
  const finalized=await routeApi(request(f.path+'/groq-summary','POST',{finalizeOnly:true,transcriptHash:hash}),f.env);assert.equal(finalized.status,200,await finalized.clone().text());
  assert.equal((await readStatus()).status,200);
  const reopened=await routeApi(request(f.path+'/groq-summary-approval'),f.env);assert.equal(reopened.status,200,await reopened.clone().text());
  const duplicate=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.notEqual(duplicate.status,202);assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('raw:8 correction cancelled before send cannot call the provider',async()=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),oldFetch=globalThis.fetch;let calls=0;
 try{
  const row=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(row.audit_json),groups=partitionGroqTranscript(f.segments,promptAudit({audit,duration_seconds:row.duration_seconds})),group=groups[8],hash=f.plan.transcriptHash,stamp=new Date(Date.now()-120000).toISOString(),identity=await capacityIdentity(f.env,'groq');
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'STOPPED',?,?)").run(f.id+':groq-summary:approval:0',f.id,stamp,JSON.stringify({...f.approval,sequence:0,keyIdentity:identity}));
  const failedId=f.id+':groq-summary:'+hash+':raw:8',oldUnits=groqInputUpperBound(groqSummaryMessages(groqRawPrompt(group,promptAudit({audit,duration_seconds:row.duration_seconds}))))+1800,oldResult=JSON.stringify({reviewResult:{partialText:JSON.stringify({...valid(group[0].id),summary:[{text:'근거 없는 999원',evidenceIds:[group[0].id]}]}),usage:{inputTokens:1152,outputTokens:987,reasoningTokens:50,totalTokens:2139}}});
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',?,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(failedId,f.id,oldUnits,stamp,oldResult);
  f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2139,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),f.id,stamp);
  const url=f.path+'/groq-summary-correction',quoted=await routeApi(request(url,'POST',{step:'quote'}),f.env);assert.equal(quoted.status,200);let quote=await quoted.json();const oldQuoteId=quote.quoteId;
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify({...quote.contract,expiresAt:Date.now()-1}),quote.quoteId);
  const expiredPreview=await(await routeApi(request(url),f.env)).json();assert.equal(expiredPreview.quote,null);assert.equal(expiredPreview.quoteExpired,true);
  const requoted=await routeApi(request(url,'POST',{step:'quote'}),f.env);assert.equal(requoted.status,200);quote=await requoted.json();assert.notEqual(quote.quoteId,oldQuoteId);
  const approved=await routeApi(request(url,'POST',{step:'approve',quoteId:quote.quoteId,quoteSha256:quote.contract.quoteSha256,reservedUnits:quote.contract.reservedUnits,maxCalls:1,confirmExactQuote:true,confirmPriorUsagePreserved:true,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200);const approval=await approved.json();
  assert.equal((await routeApi(request(url,'POST',{step:'cancel',confirmCancelBeforeSend:true}),f.env)).status,200);
  globalThis.fetch=async()=>{calls++;throw Error('PROVIDER_CALL_FORBIDDEN');};
  const blocked=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(blocked.status,409);assert.equal(calls,0);
  assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(failedId).result_json,oldResult);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('raw:8 correction missing vault root is BLOCKED before provider dispatch',async()=>{
 const {f,url,approval,quote,failedId,oldResult}=await approvedCorrectionFixture({storedCredential:true}),priorFetch=globalThis.fetch;let calls=0;
 try{
  delete f.env.KEY_ENCRYPTION_KEY_B64;
  globalThis.fetch=async()=>{calls++;throw Error('PROVIDER_CALL_FORBIDDEN');};
  const attempted=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(attempted.status,409);assert.equal((await attempted.json()).error.code,'VAULT_NOT_READY');assert.equal(calls,0);
  const row=f.db.prepare('SELECT state,error_code,units FROM yta_operations WHERE id=?').get(approval.attemptId);assert.equal(row.state,'BLOCKED');assert.equal(row.error_code,'VAULT_NOT_READY');assert.equal(row.units,quote.contract.reservedUnits);
  assert.equal(f.db.prepare("SELECT COALESCE(SUM(units),0) AS reserved FROM yta_operations WHERE id=? AND state IN ('CLAIMED','DONE','FAILED_UNCERTAIN')").get(approval.attemptId).reserved,0);
  assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(failedId).result_json,oldResult);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE job_id=? AND provenance LIKE 'PROVIDER_REPORTED_CORRECTIVE%'").get(f.id).n,0);
 }finally{globalThis.fetch=priorFetch;f.db.close();}
});

test('raw:8 correction preserves safe rate limit headers after an uncertain 429',async()=>{
 const {f,url,approval,failedId,oldResult}=await approvedCorrectionFixture(),priorFetch=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;return Response.json({}, {status:429,headers:{'retry-after':'120','x-ratelimit-remaining-requests':'0','x-ratelimit-remaining-tokens':'0'}});};
  const attempted=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(attempted.status,409);assert.equal((await attempted.json()).error.code,'429');assert.equal(calls,1);
  const row=f.db.prepare('SELECT state,error_code,result_json FROM yta_operations WHERE id=?').get(approval.attemptId);assert.equal(row.state,'FAILED_UNCERTAIN');assert.equal(row.error_code,'429');assert.deepEqual(JSON.parse(row.result_json).safeRateLimit,{retryAfterSeconds:120,remainingRequests:0,remainingTokens:0,tokenReset:null});
  assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(failedId).result_json,oldResult);
  assert.equal((await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env)).status,409);assert.equal(calls,1);
 }finally{globalThis.fetch=priorFetch;f.db.close();}
});

test('ordinary Groq status distinguishes the new raw:8 correction claim and failure from the old failure',async()=>{
 const {f,approval,failedId,oldResult}=await approvedCorrectionFixture(),priorFetch=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;throw Error('PROVIDER_CALL_FORBIDDEN');};
  const at=new Date().toISOString();
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'groq-summary',6600,'CLAIMED',?)").run(approval.attemptId,f.id,at);
  const statusUrl=f.path+'/groq-summary-status',claimed=await(await routeApi(request(statusUrl),f.env)).json();
  assert.equal(claimed.activeStage.key,'raw:8:correction');assert.equal(claimed.activeStage.state,'CLAIMED');assert.equal(claimed.correctionAttempt.state,'CLAIMED');assert.equal(claimed.completedStages,0);assert.equal(claimed.nextEligibleAt,null);assert.equal(calls,0);
  f.db.prepare("UPDATE yta_operations SET state='FAILED_UNCERTAIN',error_code='429' WHERE id=?").run(approval.attemptId);
  const failed=await(await routeApi(request(statusUrl),f.env)).json();assert.equal(failed.activeStage.key,'raw:8:correction');assert.equal(failed.activeStage.state,'FAILED_UNCERTAIN');assert.equal(failed.activeStage.errorCode,'429');assert.equal(failed.correctionAttempt.state,'FAILED_UNCERTAIN');assert.equal(failed.completedStages,0);assert.equal(failed.nextEligibleAt,null);assert.equal(calls,0);
  f.db.prepare("UPDATE yta_operations SET state='BLOCKED',error_code='VAULT_NOT_READY' WHERE id=?").run(approval.attemptId);
  const blocked=await(await routeApi(request(statusUrl),f.env)).json();assert.equal(blocked.activeStage.key,'raw:8:correction');assert.equal(blocked.activeStage.state,'BLOCKED');assert.equal(blocked.activeStage.errorCode,'VAULT_NOT_READY');assert.equal(calls,0);
  assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(failedId).result_json,oldResult);
 }finally{globalThis.fetch=priorFetch;f.db.close();}
});

test('strict summary schema is included in the request estimate and fresh approval hash',async()=>{
 const f=await fixture(),old=fetch;let calls=0;
 const stored=f.db.prepare('SELECT raw,segments_json FROM yta_sources WHERE job_id=?').get(f.id),job=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(job.audit_json);
 const legacyInput=[stored.raw,JSON.parse(stored.segments_json),audit.audioFileSha256,promptAudit({audit,duration_seconds:job.duration_seconds})];
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(legacyInput)));
 assert.notEqual(f.plan.transcriptHash,Buffer.from(digest).toString('hex'));
 assert.equal(GROQ_SUMMARY_RESPONSE_FORMAT.json_schema.strict,true);
 assert.equal(GROQ_SUMMARY_RESPONSE_FORMAT.json_schema.schema.properties.summary.type,'array');
 const messages=groqSummaryMessages(groqRawPrompt(f.segments,promptAudit({audit,duration_seconds:job.duration_seconds})));
 assert.ok(groqInputUpperBound(messages)>=Buffer.byteLength(JSON.stringify(groqSummaryRequestBody(messages,1800)))+512);
 globalThis.fetch=async(_url,options)=>{calls++;const body=JSON.parse(options.body);assert.deepEqual(body.response_format,GROQ_SUMMARY_RESPONSE_FORMAT);return response();};
 try{assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);assert.ok([200,202].includes((await routeApi(request(f.path+'/groq-summary','POST',{}),f.env)).status));assert.equal(calls,1);}finally{globalThis.fetch=old;f.db.close();}
});

test('legacy failed raw response is diagnosed without disclosing text or changing its ledger',async()=>{
 const f=await fixture({large:true});
 try{
  const stored=f.db.prepare('SELECT raw,segments_json FROM yta_sources WHERE job_id=?').get(f.id),job=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(job.audit_json);
  const legacyInput=[stored.raw,JSON.parse(stored.segments_json),audit.audioFileSha256,promptAudit({audit,duration_seconds:job.duration_seconds})];
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(legacyInput))),legacyHash=Buffer.from(digest).toString('hex');
  const approvalId=f.id+':groq-summary:approval:0',approval={...f.approval,sequence:0,transcriptHash:legacyHash};
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)").run(approvalId,f.id,'groq-summary',6600,'STOPPED',new Date().toISOString(),JSON.stringify(approval));
  const raw=JSON.stringify({...valid(1),summary:'PRIVATE_RESPONSE_CONTENT'}),operationId=f.id+':groq-summary:'+legacyHash+':raw:0';
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)").run(operationId,f.id,'groq-summary',6600,'FAILED_UNCERTAIN',new Date().toISOString(),'SUMMARY_RESPONSE_INVALID',JSON.stringify({reviewResult:{partialText:raw,usage:{inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220}}}));
  const before=f.db.prepare('SELECT state,error_code,result_json FROM yta_operations WHERE id=?').get(operationId);
  const reply=await routeApi(request(f.path+'/groq-summary-failure-diagnostic'),f.env),body=await reply.json();
  assert.equal(reply.status,200,JSON.stringify(body));assert.equal(body.sourceHashMatchesApproval,true);assert.equal(body.summaryType,'string');assert.equal(body.firstFailedCheck,'SCHEMA');assert.equal(body.storedUtf16Length,raw.length);assert.ok(body.raw0LastId>0);assert.ok(!JSON.stringify(body).includes('PRIVATE_RESPONSE_CONTENT'));
  assert.deepEqual(f.db.prepare('SELECT state,error_code,result_json FROM yta_operations WHERE id=?').get(operationId),before);
 }finally{f.db.close();}
});

test('reviewed pilot admits one strict-schema raw call and leaves legacy failure intact',async()=>{
 const f=await fixture({large:true}),oldFetch=fetch;let calls=0;
 try{
  const stored=f.db.prepare('SELECT raw,segments_json FROM yta_sources WHERE job_id=?').get(f.id),job=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(job.audit_json);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([stored.raw,JSON.parse(stored.segments_json),audit.audioFileSha256,promptAudit({audit,duration_seconds:job.duration_seconds})]))),legacyHash=Buffer.from(digest).toString('hex');
  const approvalId=f.id+':groq-summary:approval:0',oldId=f.id+':groq-summary:'+legacyHash+':raw:0',raw=JSON.stringify({...valid(1),summary:'PRIVATE_RESPONSE_CONTENT'}),usage={inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220};
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(approvalId,f.id,'groq-summary',6600,'STOPPED',new Date().toISOString(),JSON.stringify({...f.approval,sequence:0,transcriptHash:legacyHash}));
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)').run(oldId,f.id,'groq-summary',6600,'FAILED_UNCERTAIN',new Date(Date.now()-120000).toISOString(),'SUMMARY_RESPONSE_INVALID',JSON.stringify({reviewResult:{partialText:raw,usage}}));
  f.db.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),f.id,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2220,0,null,'TEST',new Date().toISOString());
  const before=f.db.prepare('SELECT * FROM yta_operations WHERE id=?').get(oldId),url=f.path+'/groq-summary-pilot';
  const preview=await(await routeApi(request(url),f.env)).json();
  assert.equal(preview.confirmedUsage.totalTokens,2220);assert.equal(preview.firstFailedCheck,'SCHEMA');assert.notEqual(preview.oldRange.lastId,preview.newRange.lastId);assert.equal(preview.newOneCallReservation,6600);assert.equal(preview.remainingAccountTokens,'UNKNOWN');assert.equal(preview.finishReasonEvidence,'CODE_PATH_INFERRED_NOT_SEPARATELY_STORED');assert.ok(!JSON.stringify(preview).includes('PRIVATE_RESPONSE_CONTENT'));
  const body={evidenceHash:preview.evidenceHash,oldOperationId:oldId,newOperationId:preview.newOperationId,newTranscriptHash:preview.newTranscriptHash,model:preview.model,credentialGeneration:preview.credentialGeneration};
  const denied=await routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),f.env);assert.notEqual(denied.status,200);
  const reviewed=await routeApi(request(url,'POST',{...body,step:'review',acknowledgeInferredFinishReason:true,acknowledgePreviousUsage:2220,acknowledgeDuplicateUsageRisk:true,acknowledgeChangedRange:true}),f.env);assert.equal(reviewed.status,200,JSON.stringify(await reviewed.clone().json()));
  const approved=await routeApi(request(url,'POST',{...body,step:'approve',freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,oneCallOnly:true,totalTokenUpperBound:6600}),f.env);assert.equal(approved.status,200,JSON.stringify(await approved.clone().json()));
  globalThis.fetch=async(_url,options)=>{calls++;assert.equal(JSON.parse(options.body).response_format.json_schema.strict,true);return response();};
  const [a,b]=await Promise.all([routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),f.env),routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),f.env)]);
  assert.equal([a.status,b.status].filter(code=>code===202).length,1,JSON.stringify([await a.clone().json(),await b.clone().json()]));assert.equal(calls,1);assert.deepEqual(f.db.prepare('SELECT * FROM yta_operations WHERE id=?').get(oldId),before);
  assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(preview.newOperationId).state,'DONE');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM yta_operations WHERE provider='groq-summary' AND state='DONE'").get().count,1);
  assert.equal((await routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),f.env)).status,409);assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('pilot provider failure consumes the one call and cannot be retried',async()=>{
 const f=await fixture(),oldFetch=fetch;let calls=0;
 try{
  const source=f.db.prepare('SELECT raw,segments_json FROM yta_sources WHERE job_id=?').get(f.id),job=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(job.audit_json),oldHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([source.raw,JSON.parse(source.segments_json),audit.audioFileSha256,promptAudit({audit,duration_seconds:job.duration_seconds})])))).toString('hex'),oldId=f.id+':groq-summary:'+oldHash+':raw:0',usage={inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220};
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(f.id+':groq-summary:approval:0',f.id,'groq-summary',6600,'STOPPED',new Date().toISOString(),JSON.stringify({...f.approval,sequence:0,transcriptHash:oldHash}));
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)').run(oldId,f.id,'groq-summary',6600,'FAILED_UNCERTAIN',new Date(Date.now()-120000).toISOString(),'SUMMARY_RESPONSE_INVALID',JSON.stringify({reviewResult:{partialText:JSON.stringify({...valid(1),summary:'bad shape'}),usage}}));
  f.db.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),f.id,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2220,0,null,'TEST',new Date().toISOString());
  const url=f.path+'/groq-summary-pilot',p=await(await routeApi(request(url),f.env)).json(),body={evidenceHash:p.evidenceHash,oldOperationId:oldId,newOperationId:p.newOperationId,newTranscriptHash:p.newTranscriptHash,model:p.model,credentialGeneration:p.credentialGeneration};
  assert.equal((await routeApi(request(url,'POST',{...body,step:'review',acknowledgeInferredFinishReason:true,acknowledgePreviousUsage:2220,acknowledgeDuplicateUsageRisk:true,acknowledgeChangedRange:true}),f.env)).status,200);
  assert.equal((await routeApi(request(url,'POST',{...body,step:'approve',freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,oneCallOnly:true,totalTokenUpperBound:6600}),f.env)).status,200);
  f.env.GROQ_API_KEY='ROTATED_OFFLINE_KEY';const rotated=await(await routeApi(request(url),f.env)).json();assert.equal(rotated.reviewRecordExists,true);assert.equal(rotated.reviewed,false);assert.equal(rotated.approvalRecordExists,true);assert.equal(rotated.approved,false);assert.equal((await routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),f.env)).status,409);f.env.GROQ_API_KEY='NOT_REAL_TEST_KEY';
  const originalAudit=f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(f.id).audit_json;f.db.prepare("UPDATE jobs SET audit_json=json_set(audit_json,'$.audioBoundaryReview','CHANGED') WHERE id=?").run(f.id);assert.ok((await routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),f.env)).status>=400);f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(originalAudit,f.id);
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'deletion',0,'DELETING',?)").run(f.id+':deleting',f.id,new Date().toISOString());assert.equal((await routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),f.env)).status,404);f.db.prepare('DELETE FROM yta_operations WHERE id=?').run(f.id+':deleting');
  globalThis.fetch=async()=>{calls++;throw Error('offline simulated transport loss');};
  assert.ok((await routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),f.env)).status>=400);assert.equal(calls,1);
  assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(p.newOperationId).state,'FAILED_UNCERTAIN');
  assert.equal((await routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),f.env)).status,409);assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('pre-schema approval cannot authorize a request under the new contract',async()=>{
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no provider call');};
 try{
  const stored=f.db.prepare('SELECT raw,segments_json FROM yta_sources WHERE job_id=?').get(f.id),job=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(job.audit_json);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([stored.raw,JSON.parse(stored.segments_json),audit.audioFileSha256,promptAudit({audit,duration_seconds:job.duration_seconds})]))),legacyHash=Buffer.from(digest).toString('hex');
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)").run(f.id+':groq-summary:approval:0',f.id,'groq-summary',6600,'APPROVED',new Date().toISOString(),JSON.stringify({...f.approval,sequence:0,transcriptHash:legacyHash}));
  const review=await routeApi(request(f.path+'/groq-summary-approval'),f.env);
  assert.equal((await review.json()).error.code,'SUMMARY_APPROVAL_CHANGED');
  const run=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);
  assert.equal(run.status,409);assert.equal(calls,0);
 }finally{globalThis.fetch=old;f.db.close();}
});

test('strict-shape failure retains original usage and a read-only diagnostic without retry',async()=>{
 const f=await fixture(),old=fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return response({...valid(1),summary:'PRIVATE_RESPONSE_CONTENT'});};
 try{
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
  const failed=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);
  assert.equal((await failed.json()).error.code,'SUMMARY_RESPONSE_INVALID');assert.equal(calls,1);
  const row=f.db.prepare("SELECT state,error_code,result_json FROM yta_operations WHERE job_id=? AND provider='groq-summary' AND state='FAILED_UNCERTAIN'").get(f.id);
  assert.equal(row.error_code,'SUMMARY_RESPONSE_INVALID');assert.equal(JSON.parse(row.result_json).reviewResult.usage.totalTokens,390);
  const diagnostic=await routeApi(request(f.path+'/groq-summary-failure-diagnostic'),f.env),safe=await diagnostic.json();
  assert.equal(diagnostic.status,200);assert.equal(safe.firstFailedCheck,'SCHEMA');assert.equal(safe.summaryType,'string');assert.ok(!JSON.stringify(safe).includes('PRIVATE_RESPONSE_CONTENT'));
  assert.equal((await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json()).error.code,'SUMMARY_OPERATION_REVIEW_REQUIRED');
  assert.equal((await routeApi(request(f.path+'/groq-summary','POST',{}),f.env)).status,409);assert.equal(calls,1);
  assert.deepEqual(f.db.prepare("SELECT state,error_code,result_json FROM yta_operations WHERE job_id=? AND provider='groq-summary' AND state='FAILED_UNCERTAIN'").get(f.id),row);
 }finally{globalThis.fetch=old;f.db.close();}
});

test('cached audio boundary reconciliation preserves speech, invalidates old review and blocks after approval',async()=>{
 const prepare=async()=>{
  const f=await fixture(),segments=[{id:1,startMs:1000,endMs:4000,text:'앞 조각 발언'},{id:2,startMs:3500,endMs:5000,text:'뒤 조각 다른 발언'}];
  const audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64),audioProviders:['groq'],audioChunks:[{index:0,start:0,end:4,provider:'groq'},{index:1,start:3,end:6,provider:'groq'}],audioSegmentOrigins:[{segmentId:1,chunkIndex:0,startMs:1000,endMs:4000},{segmentId:2,chunkIndex:1,startMs:3500,endMs:5000}],audioBoundaryReview:'NO_NONIDENTICAL_OVERLAP_TEXT',audioBoundaryAmbiguities:[]};
  f.db.prepare('UPDATE jobs SET audit_json=?,duration_seconds=6 WHERE id=?').run(JSON.stringify(audit),f.id);
  f.db.prepare('UPDATE yta_sources SET raw=?,segments_json=? WHERE job_id=?').run(segments.map(part=>part.text).join('\n'),JSON.stringify(segments),f.id);
  return f;
 };
 const f=await prepare();try{
  const before=f.db.prepare('SELECT raw,segments_json,provenance FROM yta_sources WHERE job_id=?').get(f.id),oldPlan=await(await routeApi(request(f.path+'/groq-summary-plan'),f.env)).json(),oldReview=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();
  const preview=await(await routeApi(request(f.path+'/audio-boundary-reconcile'),f.env)).json();
  assert.deepEqual(preview.currentMarkerIds,[]);assert.deepEqual(preview.revisedMarkerIds,[1,2]);
  const body={...preview,confirmBoundaryMetadataReconcile:true};
  assert.equal((await routeApi(request(f.path+'/audio-boundary-reconcile','POST',body),f.env)).status,200);
  assert.deepEqual(f.db.prepare('SELECT raw,segments_json,provenance FROM yta_sources WHERE job_id=?').get(f.id),before);
  assert.equal((await(await routeApi(request(f.path+'/audio-finish','POST',{}),f.env)).json()).cached,true);
  const newPlan=await(await routeApi(request(f.path+'/groq-summary-plan'),f.env)).json();assert.notEqual(newPlan.transcriptHash,oldPlan.transcriptHash);
  const stale={...f.approval,transcriptHash:oldPlan.transcriptHash,credentialGeneration:oldReview.credentialGeneration};
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',stale),f.env)).status,400);
  assert.equal((await(await routeApi(request(f.path+'/audio-boundary-reconcile','POST',{...body,currentMarkerIds:[1,2]}),f.env)).json()).cached,true);
 }finally{f.db.close();}
 const locked=await prepare();try{
  const preview=await(await routeApi(request(locked.path+'/audio-boundary-reconcile'),locked.env)).json();
  const review=await(await routeApi(request(locked.path+'/groq-summary-approval'),locked.env)).json(),plan=await(await routeApi(request(locked.path+'/groq-summary-plan'),locked.env)).json();
  const approval={...locked.approval,transcriptHash:plan.transcriptHash,credentialGeneration:review.credentialGeneration};
  assert.equal((await routeApi(request(locked.path+'/groq-summary-approval','POST',approval),locked.env)).status,200);
  const blocked=await routeApi(request(locked.path+'/audio-boundary-reconcile','POST',{...preview,confirmBoundaryMetadataReconcile:true}),locked.env);
  assert.equal((await blocked.json()).error.code,'BOUNDARY_RECONCILE_CONFLICT');
  assert.deepEqual(JSON.parse(locked.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(locked.id).audit_json).audioBoundaryAmbiguities,[]);
 }finally{locked.db.close();}
 for(const mode of ['gemini-summary','deletion-race','string-timestamps','late-first-chunk']){
  const candidate=await prepare();try{
   if(mode==='string-timestamps'||mode==='late-first-chunk'){
    const source=candidate.db.prepare('SELECT segments_json FROM yta_sources WHERE job_id=?').get(candidate.id),segments=JSON.parse(source.segments_json),audit=JSON.parse(candidate.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(candidate.id).audit_json);
    if(mode==='string-timestamps'){segments[0].startMs='1000';audit.audioSegmentOrigins[0].startMs='1000';}
    else audit.audioChunks[0].start=.5;
    candidate.db.prepare('UPDATE yta_sources SET segments_json=? WHERE job_id=?').run(JSON.stringify(segments),candidate.id);
    candidate.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify(audit),candidate.id);
    const invalid=await routeApi(request(candidate.path+'/audio-boundary-reconcile'),candidate.env);
    assert.equal((await invalid.json()).error.code,'BOUNDARY_RECONCILE_SOURCE_INVALID');continue;
   }
   const preview=await(await routeApi(request(candidate.path+'/audio-boundary-reconcile'),candidate.env)).json();
   if(mode==='gemini-summary')candidate.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'gemini',1,'CLAIMED',?)").run(candidate.id+':summary:prior:raw:0',candidate.id,new Date().toISOString());
   else{
    const original=candidate.env.DB;candidate.env.DB={...original,prepare(sql){const statement=original.prepare(sql);if(!sql.startsWith('UPDATE jobs SET audit_json=?,updated_at=?'))return statement;return {bind(...args){const bound=statement.bind(...args);return {...bound,async run(){candidate.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'deletion',0,'DELETING',?)").run(candidate.id+':deleting',candidate.id,new Date().toISOString());return bound.run();}};}};}};
   }
   const blocked=await routeApi(request(candidate.path+'/audio-boundary-reconcile','POST',{...preview,confirmBoundaryMetadataReconcile:true}),candidate.env);
   assert.equal((await blocked.json()).error.code,'BOUNDARY_RECONCILE_CONFLICT');
   assert.deepEqual(JSON.parse(candidate.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(candidate.id).audit_json).audioBoundaryAmbiguities,[]);
  }finally{candidate.db.close();}
 }
});

test('conservative UTF-8 bound partitions long Korean source below Groq Free input ceiling',()=>{
 const segments=Array.from({length:25},(_,i)=>({id:i+1,startMs:i*24000,endMs:(i+1)*24000,text:'가나다라마바사 '.repeat(12)}));
 const groups=partitionGroqTranscript(segments,{audioFileSha256:'a'.repeat(64)});
 assert.ok(groups.length>1);assert.deepEqual(groups.flat().map(x=>x.id),segments.map(x=>x.id));
 for(const group of groups)assert.ok(groqInputUpperBound(groqSummaryMessages(groqRawPrompt(group,{audioFileSha256:'a'.repeat(64)})))<=GROQ_SUMMARY_INPUT_BOUND);
 const fullLength=Array.from({length:125},(_,i)=>({id:i+1,startMs:i*47136,endMs:(i+1)*47136,text:'가나다라마바사아자차카타파하 '.repeat(8)}));
 const bounded=partitionGroqTranscript(fullLength,{durationSeconds:5892,audioProcessingCoverage:1,independentVerification:false});
 assert.equal(fullLength.map(part=>part.text).join('').length,15000);
 assert.ok(bounded.length<=120);
 assert.ok(Math.min(bounded.length*2-1,Math.floor(195000/6600))*6600<=195000);
});
test('corrective wording keeps the original raw prompt, partition and strict response contract unchanged',()=>{
 const segments=Array.from({length:25},(_,i)=>({id:i+1,startMs:i*24000,endMs:(i+1)*24000,text:'가나다라마바사 '.repeat(12)}));
 const audit={audioFileSha256:'a'.repeat(64)},digest=value=>createHash('sha256').update(value).digest('hex');
 assert.equal(digest(groqRawPrompt(segments.slice(0,2),audit)),'011dcbede6e8a260e50c0848b44e5bc8337805e4acd23a4c2ed2391dfde02d82');
 assert.deepEqual(partitionGroqTranscript(segments,audit).map(group=>[group[0].id,group.at(-1).id]),[[1,7],[8,14],[15,21],[22,25]]);
 assert.equal(GROQ_SUMMARY_CONTRACT_VERSION,'evidence-summary-v2');
 assert.equal(digest(JSON.stringify(GROQ_SUMMARY_RESPONSE_FORMAT)),'8c891cb8ec7a91c867660bbd56f553ef2876ffe41eeada882a9437b3d9d74bee');
});
test('500-segment future merge packs consecutive source IDs without losing the checkpoint guard',()=>{
 const segments=Array.from({length:500},(_,i)=>({id:i+1,startMs:i*11786,endMs:(i+1)*11786,text:'가나다라마바사아자차'.repeat(10)}));
 const audit={durationSeconds:5893,audioProcessingCoverage:1,independentVerification:false,externalFactCheck:'NOT_PERFORMED',audioBoundarySegmentIds:Array.from({length:14},(_,i)=>2+33*i)};
 const groups=partitionGroqTranscript(segments,audit),firstIds=groups.map(group=>group[0].id);
 assert.ok(groups.length>52&&groups.length<=120);
 const part=(first,last,chapterIds)=>({ids:Array.from({length:last-first+1},(_,i)=>first+i),startMs:(first-1)*11786,endMs:last*11786,report:{summary:[{text:'원문',evidenceIds:[first]}],chapters:[{text:'구간',evidenceIds:chapterIds}],claims:[],numbers:[],critical:[],conclusion:'원문'}});
 const large=part(1,397,firstIds.filter(id=>id<=397)),small=part(398,500,[398]);
 const size=(parts,final=false)=>groqInputUpperBound(groqSummaryMessages(groqMergePrompt(parts,audit,{final})));
 assert.match(groqMergePrompt([large,small],audit),/"idRange":\[1,397\]/);
 assert.ok(size([large,large],true)<=GROQ_SUMMARY_INPUT_BOUND);
 assert.ok(size([large,small],true)<=GROQ_SUMMARY_INPUT_BOUND);
 assert.ok(size([small,small],true)<=GROQ_SUMMARY_INPUT_BOUND);
 assert.match(groqMergePrompt([{...small,ids:[398,400]}],audit),/"ids":\[398,400\]/);
});
test('500-segment mocked summary exposes a separate raw checkpoint bundle without finalizing',async()=>{
 const f=await fixture({complete:false}),old=fetch;
 const segments=Array.from({length:500},(_,i)=>({id:i+1,startMs:i*11786,endMs:(i+1)*11786,text:'가나다라마바사아자차'.repeat(10)}));
 const audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64),audioBoundaryAmbiguities:Array.from({length:14},(_,i)=>({segmentId:2+33*i,chunkIndex:i+1,startMs:(2+33*i)*11786,endMs:(3+33*i)*11786}))};
 f.db.prepare('UPDATE jobs SET duration_seconds=?,audit_json=? WHERE id=?').run(5893,JSON.stringify(audit),f.id);
 f.db.prepare('UPDATE yta_sources SET raw=?,segments_json=? WHERE job_id=?').run(segments.map(segment=>segment.text).join('\n'),JSON.stringify(segments),f.id);
 let calls=0;
 globalThis.fetch=async(_url,options)=>{
  calls++;
  const prompt=JSON.parse(options.body).messages[1].content;
  let ids;
  if(prompt.includes('전사 배열 [id,startMs,endMs,text]:'))ids=[JSON.parse(prompt.split('전사 배열 [id,startMs,endMs,text]:\n')[1])[0][0]];
  else ids=[...new Set(JSON.parse(prompt.split('시간 순서별 부분 보고서:\n')[1]).flatMap(part=>part.report.chapters.flatMap(chapter=>chapter.evidenceIds)))];
  return response({summary:[{text:'원문',evidenceIds:[ids[0]]}],chapters:[{text:'구간',evidenceIds:ids}],claims:[],numbers:[],critical:[],conclusion:'원문'});
 };
 const approve=async()=>{
  const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();
  const body={jobId:f.id,transcriptHash:review.transcriptHash,model:review.model,outputKind:review.outputKind,windowStart:review.windowStart,totalRequests:review.totalRequests,maxRequests:review.maxRequests,maxInputTokensPerRequest:review.maxInputTokensPerRequest,maxCompletionTokensPerRequest:review.maxCompletionTokensPerRequest,totalTokenUpperBound:review.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',body),f.env)).status,200);
 };
 try{
  const plan=await(await routeApi(request(f.path+'/groq-summary-plan'),f.env)).json();assert.equal(plan.rawStages,partitionGroqTranscript(segments,promptAudit({duration_seconds:5893,audit})).length);
  await approve();
  let ready=false;
  for(let step=0;step<240;step++){
   const result=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env),body=await result.json();
   assert.ok([200,202].includes(result.status),JSON.stringify({step,calls,body}));
   if(body.bundleAvailable){ready=true;break;}
   if(body.windowComplete){f.db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary' AND state='DONE'").run(new Date(Date.now()-90_000_000).toISOString(),f.id);await approve();}
   else if(body.pending)f.db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary' AND state='DONE' AND created_at>?").run(new Date(Date.now()-62_000).toISOString(),f.id,new Date(Date.now()-60_000).toISOString());
  }
  assert.equal(ready,true);
  const bundle=await(await routeApi(request(f.path+'/groq-summary-bundle'),f.env)).json();
  assert.equal(bundle.report.compositionMode,'LOSSLESS_RAW_CHECKPOINTS');assert.equal(bundle.finalSummaryComplete,false);
  assert.equal(calls,plan.rawStages);
  assert.equal(bundle.report.chapters.length,plan.rawStages);
  assert.ok([null,'null'].includes(f.db.prepare('SELECT report_json FROM jobs WHERE id=?').get(f.id).report_json));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider='groq-summary' AND state='FAILED_UNCERTAIN'").get(f.id).n,0);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('Gemini and Groq summary payloads disclose retained boundary uncertainty within input caps',()=>{
 const segments=[{id:1,startMs:0,endMs:1000,text:'첫 발언'},{id:2,startMs:500,endMs:1500,text:'겹친 다른 발언'}],marker={segmentId:2,chunkIndex:1,startMs:500,endMs:1500};
 const job={duration_seconds:2,audit:{audioProcessingCoverage:1,audioBoundaryAmbiguities:[marker]}};
 const audit=promptAudit(job);
 assert.deepEqual(audit.audioBoundarySegmentIds,[2]);
 const raw=groqRawPrompt(segments,audit);
 assert.match(raw,/"audioBoundarySegmentIds":\[2\]/);
 assert.match(raw,/같은 발언을 두 번 집계하거나 어느 표현이 맞는지 단정하지 말고/);
 assert.ok(groqInputUpperBound(groqSummaryMessages(raw))<=GROQ_SUMMARY_INPUT_BOUND);
 const merged=groqMergePrompt([{ids:[1,2],startMs:0,endMs:1500,report:valid(1)}],audit,{final:true});
 assert.match(merged,/"audioBoundaryAmbiguityCount":1/);
 assert.match(merged,/독립 확인되지 않았다/);
 assert.ok(groqInputUpperBound(groqSummaryMessages(merged))<=GROQ_SUMMARY_INPUT_BOUND);
 const gemini=reportPrompt(segments,job.audit);
 assert.match(gemini,/"segmentId":2/);
 assert.match(gemini,/같은 발언을 두 번 집계하거나 어느 표현이 맞는지 단정하지 말고/);
});
test('both sides of a late boundary overlap reach Groq summary evidence warnings',()=>{
 const merged=mergeAudioSegments([{index:0,start:0,end:60,segments:[{start:59.4,end:60,text:'앞 발언'}]},{index:1,start:58,end:120,segments:[{start:1.7,end:3.3,text:'뒤 발언'}]}]);
 const audit=promptAudit({duration_seconds:120,audit:{audioProcessingCoverage:1,audioBoundaryAmbiguities:merged.boundaryAmbiguities}});
 assert.deepEqual(audit.audioBoundarySegmentIds,[1,2]);
 const segments=merged.segments.map((segment,index)=>({...segment,id:index+1}));
 const raw=groqRawPrompt(segments,audit);
 assert.match(raw,/"audioBoundarySegmentIds":\[1,2\]/);
 const mergedPrompt=groqMergePrompt([{ids:[1,2],startMs:59400,endMs:61300,report:valid(1)}],audit,{final:true});
 assert.match(mergedPrompt,/"audioBoundaryAmbiguityCount":2/);
});
test('Groq summary requires complete stored transcript and exact one-time approval without provider call',async()=>{
 const incomplete=await fixture({complete:false});try{assert.equal((await incomplete.db.prepare('SELECT COUNT(*) n FROM yta_operations').get()).n,0);assert.equal((await routeApi(request(incomplete.path+'/groq-summary-plan'),incomplete.env)).status,409);}finally{incomplete.db.close();}
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no provider call');};
 try{assert.equal(f.plan.remainingAccountTokens,'UNKNOWN');assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',{...f.approval,transcriptHash:'b'.repeat(64)}),f.env)).status,400);
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);assert.equal(calls,0);
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,409);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('read-only summary review reports safe failure stage without leaking backend errors',async()=>{
 const f=await fixture();
 const breakRead=pattern=>({...f.env,DB:{...f.env.DB,prepare(sql){if(sql.includes(pattern))throw Error('PRIVATE_BACKEND_DETAIL');return f.env.DB.prepare(sql);}}});
 try{
  const source=await routeApi(request(f.path+'/groq-summary-plan'),breakRead('SELECT * FROM yta_sources'));
  assert.equal(source.status,500);
  const sourceError=(await source.json()).error;
  assert.equal(sourceError.code,'SUMMARY_REVIEW_SOURCE_INTERNAL');
  assert.doesNotMatch(JSON.stringify(sourceError),/PRIVATE_BACKEND_DETAIL/);
  const credential=await routeApi(request(f.path+'/groq-summary-approval'),breakRead('SELECT cipher_version,iv_b64,ciphertext_b64,updated_at FROM provider_credentials'));
  assert.equal(credential.status,500);
  const credentialError=(await credential.json()).error;
  assert.equal(credentialError.code,'SUMMARY_REVIEW_CREDENTIAL_INTERNAL');
  assert.doesNotMatch(JSON.stringify(credentialError),/PRIVATE_BACKEND_DETAIL/);
 }finally{f.db.close();}
});
test('D1 50-byte LIKE limit does not block scoped approval and checkpoint reads',async()=>{
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected provider call');};
 try{
  assert.equal(Buffer.byteLength(f.id+':groq-summary:approval:%'),60);
  assert.equal(Buffer.byteLength(f.id+':groq-summary:'+f.plan.transcriptHash+':%'),116);
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'groq',0,'DONE',?)").run(f.id+':audio:0',f.id,new Date().toISOString());
  const env={...f.env,DB:{...f.env.DB,prepare(sql){const statement=f.env.DB.prepare(sql);return {bind(...args){if(sql.includes(' LIKE ?')&&args.some(value=>typeof value==='string'&&Buffer.byteLength(value)>50))throw Error('LIKE or GLOB pattern too complex');return statement.bind(...args);}};}}};
  const plan=await routeApi(request(f.path+'/groq-summary-plan'),env);assert.equal(plan.status,200,await plan.clone().text());
  const approval=await routeApi(request(f.path+'/groq-summary-approval'),env);assert.equal(approval.status,200,await approval.clone().text());
  assert.equal((await approval.json()).approved,false);assert.equal(calls,0);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('approval sequence and job scope reject lookalikes without provider calls',async()=>{
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected provider call');};
 const insert=(suffix,jobId,provider,scope)=>f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)").run(f.id+':groq-summary:approval:'+suffix,jobId,provider,0,'STOPPED',new Date().toISOString(),JSON.stringify(scope));
 try{
  insert('999','another-job','groq-summary',{sequence:999});insert('998',f.id,'groq',{sequence:998});
  assert.equal((await routeApi(request(f.path+'/groq-summary-plan'),f.env)).status,200);
  for(let sequence=0;sequence<=10;sequence++)insert(String(sequence),f.id,'groq-summary',{sequence});
  const posted=await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);assert.equal(posted.status,200,await posted.clone().text());
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yta_operations WHERE id=?').get(f.id+':groq-summary:approval:11').n,1);
  insert('999evil',f.id,'groq-summary',{sequence:999});
  const rejected=await routeApi(request(f.path+'/groq-summary-plan'),f.env);assert.equal((await rejected.json()).error.code,'SUMMARY_APPROVAL_INVALID');
  assert.equal(calls,0);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('checkpoint prefix reads only the current transcript hash and owner job',async()=>{
 const f=await fixture();
 const insert=(key,jobId,provider)=>f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)").run(key,jobId,provider,0,'DONE',new Date().toISOString(),'{}');
 const base=f.id+':groq-summary:'+f.plan.transcriptHash+':';
 try{
  insert(f.id+':groq-summary:'+'b'.repeat(64)+':raw:0',f.id,'groq-summary');
  insert(base+'raw:99','another-job','groq-summary');
  insert(base+'raw:98',f.id,'groq');
  const before=await(await routeApi(request(f.path+'/groq-summary-plan'),f.env)).json();assert.equal(before.windowStart,0);
  insert(base+'raw:0',f.id,'groq-summary');
  const after=await(await routeApi(request(f.path+'/groq-summary-plan'),f.env)).json();assert.equal(after.windowStart,1);
 }finally{f.db.close();}
});
test('1,226-segment audio source produces a read-only summary scope without provider calls',async()=>{
 const f=await fixture({complete:false});
 try{
  const segments=Array.from({length:1226},(_,i)=>({id:i+1,startMs:Math.round(i*5892888/1226),endMs:Math.round((i+1)*5892888/1226),text:'가나다라마바사아자차'.repeat(4)}));
  const audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64),audioBoundaryAmbiguities:Array.from({length:14},(_,i)=>({segmentId:2+33*i,chunkIndex:i+1,startMs:0,endMs:1}))};
  f.db.prepare('UPDATE jobs SET duration_seconds=?,audit_json=? WHERE id=?').run(5892.888000011206,JSON.stringify(audit),f.id);
  f.db.prepare('UPDATE yta_sources SET raw=?,segments_json=? WHERE job_id=?').run(segments.map(segment=>segment.text).join('\n'),JSON.stringify(segments),f.id);
  const plan=await routeApi(request(f.path+'/groq-summary-plan'),f.env);assert.equal(plan.status,200,await plan.clone().text());
  const scope=await plan.json();assert.ok(scope.rawStages>1&&scope.rawStages<=120);assert.ok(scope.totalRequests>scope.rawStages);
  const approval=await routeApi(request(f.path+'/groq-summary-approval'),f.env);assert.equal(approval.status,200,await approval.clone().text());
  assert.equal((await approval.json()).maxRequests,29);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE provider='groq-summary'").get().n,0);
 }finally{f.db.close();}
});
test('one approved Groq stage saves usage and report once; cached reopen needs no second provider call',async()=>{
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return response();};
 // Node's SQLite shim tolerates missing bindings; Workerd D1 rejects them.
 const originalDb=f.env.DB;
 f.env.DB={...originalDb,prepare(sql){
  const statement=originalDb.prepare(sql);
  if(!sql.startsWith('INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at) SELECT'))return statement;
  return {bind(...args){assert.equal(args.length,(sql.match(/\?/g)||[]).length,'D1 claim binding count');return statement.bind(...args);}};
 }};
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  const first=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(first.status,202,await first.clone().text());
  assert.equal((await first.json()).pending,true);assert.equal(calls,1);
  const second=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(second.status,200,await second.clone().text());
  assert.equal((await second.json()).job.report.kind,'GROQ_EVIDENCE_LINKED');
  assert.equal((await(await routeApi(request(f.path+'/groq-summary','POST',{}),f.env)).json()).cached,true);
  assert.equal((await(await routeApi(request(f.path),f.env)).json()).job.report.kind,'GROQ_EVIDENCE_LINKED');
  assert.match(await(await routeApi(request(f.path+'/export?format=txt'),f.env)).text(),/원문 1 검증/);
  assert.equal(calls,1);
  const op=f.db.prepare("SELECT result_json FROM yta_operations WHERE provider='groq-summary' AND state='DONE'").get();assert.deepEqual(JSON.parse(op.result_json).usage,{inputTokens:300,outputTokens:90,reasoningTokens:10,totalTokens:390});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM usage_events WHERE capability='LIVE_FREE_SUMMARY'").get().n,1);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('hierarchical Groq stages preserve source evidence and resume completed checkpoints',async()=>{
 const f=await fixture({large:true}),old=fetch;let calls=0;assert.ok(f.plan.rawStages>1);
 globalThis.fetch=async(_url,options)=>{
  calls++;const body=JSON.parse(options.body),prompt=body.messages[1].content;
  let ids;
  if(prompt.includes('전사 배열 [id,startMs,endMs,text]:'))ids=JSON.parse(prompt.split('전사 배열 [id,startMs,endMs,text]:\n')[1]).map(part=>part[0]);
  else ids=JSON.parse(prompt.split('시간 순서별 부분 보고서:\n')[1]).flatMap(part=>part.idRange?Array.from({length:part.idRange[1]-part.idRange[0]+1},(_,i)=>part.idRange[0]+i):part.ids);
  const report={summary:[{text:'원문에 기반한 한국어 정리',evidenceIds:[ids[0]]}],chapters:[{text:'해당 구간 요약',evidenceIds:ids}],claims:[],numbers:[],critical:[],conclusion:'외부 사실은 미확인'};
  return response(report);
 };
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  let final;
  for(let i=0;i<f.plan.maxRequests+1;i++){
   const result=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.ok([200,202].includes(result.status),await result.clone().text());
   final=await result.json();if(!final.pending)break;
   f.db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary' AND state='DONE'").run(new Date(Date.now()-62_000).toISOString(),f.id);
  }
  assert.equal(final.job?.report?.kind,'GROQ_EVIDENCE_LINKED');assert.ok(calls>f.plan.rawStages);assert.ok(calls<=f.plan.maxRequests);
  const refs=new Set(final.job.report.chapters.flatMap(item=>item.evidenceIds));
  assert.ok(refs.has(1));assert.ok(refs.has(f.segments.at(-1).id));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='groq-summary' AND state='DONE'").get().n,calls);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('four mergeable raw checkpoints keep approval and synthesis available',async()=>{
 const f=await fixture({large:true}),old=fetch,calls=[];
 try{
  const groups=partitionGroqTranscript(f.segments,promptAudit({duration_seconds:600,audit:JSON.parse(f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(f.id).audit_json)}));
  assert.equal(groups.length,4);
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
  for(const [i,group] of groups.entries()){
   const report={summary:[{text:'구간 요약',evidenceIds:[group[0].id]}],chapters:group.map(segment=>({text:'구간 장면',evidenceIds:[segment.id]})),claims:[],numbers:[],critical:[],conclusion:'검증된 구간'};
   f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?, 'groq-summary',6600,'DONE',?,?)").run(f.id+':groq-summary:'+f.plan.transcriptHash+':raw:'+i,f.id,new Date(Date.now()-62000).toISOString(),JSON.stringify({hash:f.plan.transcriptHash,key:'raw:'+i,report}));
  }
  const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();
  assert.equal(review.bundleAvailable,undefined);assert.equal(review.approved,true);
  const bundle=await routeApi(request(f.path+'/groq-summary-bundle'),f.env);assert.equal((await bundle.json()).error.code,'SUMMARY_BUNDLE_NOT_READY');
  globalThis.fetch=async(_url,options)=>{calls.push(options);const ids=JSON.parse(JSON.parse(options.body).messages[1].content.split('시간 순서별 부분 보고서:\n')[1]).flatMap(part=>part.idRange?Array.from({length:part.idRange[1]-part.idRange[0]+1},(_,i)=>part.idRange[0]+i):part.ids);return response({summary:[{text:'종합 요약',evidenceIds:[ids[0]]}],chapters:[{text:'종합 장',evidenceIds:ids}],claims:[],numbers:[],critical:[],conclusion:'전체 종합'});};
  const next=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(next.status,202,await next.clone().text());assert.equal(calls.length,1);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('saved intermediate merge does not turn a short synthesis into a bundle',async()=>{
 const f=await fixture({large:true}),old=fetch;
 try{
  const audit=promptAudit({duration_seconds:600,audit:JSON.parse(f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(f.id).audit_json)}),groups=partitionGroqTranscript(f.segments,audit);
  assert.equal(groups.length,4);
  const make=(group,n)=>({summary:[{text:'요'.repeat(n),evidenceIds:[group[0].id]}],chapters:group.map(segment=>({text:'구간 장',evidenceIds:[segment.id]})),claims:[],numbers:[],critical:[],conclusion:'결'.repeat(n)});
  let reports,parts;
  for(let n=10;n<250;n+=5){reports=groups.map(group=>make(group,n));parts=groups.map((group,i)=>({ids:group.map(segment=>segment.id),startMs:group[0].startMs,endMs:group.at(-1).endMs,report:reports[i]}));const bound=k=>groqInputUpperBound(groqSummaryMessages(groqMergePrompt(parts.slice(0,k),audit,{final:true})));if(bound(2)<=4800&&bound(3)>4800&&bound(1)<=4800)break;}
  assert.ok(groqInputUpperBound(groqSummaryMessages(groqMergePrompt(parts.slice(0,2),audit,{final:true})))<=4800);
  assert.ok(groqInputUpperBound(groqSummaryMessages(groqMergePrompt(parts.slice(0,3),audit,{final:true})))>4800);
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
  for(const [i,report] of reports.entries())f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?, 'groq-summary',6600,'DONE',?,?)").run(f.id+':groq-summary:'+f.plan.transcriptHash+':raw:'+i,f.id,new Date(Date.now()-62000).toISOString(),JSON.stringify({hash:f.plan.transcriptHash,key:'raw:'+i,report}));
  let calls=0;globalThis.fetch=async(_url,options)=>{calls++;const ids=JSON.parse(JSON.parse(options.body).messages[1].content.split('시간 순서별 부분 보고서:\n')[1]).flatMap(part=>part.idRange?Array.from({length:part.idRange[1]-part.idRange[0]+1},(_,i)=>part.idRange[0]+i):part.ids);return response({summary:[{text:'중간 종합',evidenceIds:[ids[0]]}],chapters:[{text:'중간 장',evidenceIds:ids}],claims:[],numbers:[],critical:[],conclusion:'중간 결과'});};
  const first=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(first.status,202,await first.clone().text());assert.equal(calls,1);
  const review=await routeApi(request(f.path+'/groq-summary-approval'),f.env),body=await review.json();assert.equal(review.status,200);assert.equal(body.bundleAvailable,undefined);assert.equal(body.approved,true);
  f.db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary' AND state='DONE'").run(new Date(Date.now()-62000).toISOString(),f.id);
  const next=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(next.status,202,await next.clone().text());assert.equal(calls,2);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('429, truncation, unsupported number and invalid evidence stop approval without automatic retries',async()=>{
 for(const mode of ['429','truncated','invalid','unsupported-number']){
  const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return mode==='429'?Response.json({}, {status:429,headers:{'retry-after':'60'}}):mode==='truncated'?response(valid(1),{choices:[{finish_reason:'length',message:{content:JSON.stringify(valid(1))}}]}):mode==='unsupported-number'?response({...valid(1),numbers:[{text:'999명',evidenceIds:[1]}]}):response(valid(999));};
  try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
   assert.equal((await routeApi(request(f.path+'/groq-summary','POST',{}),f.env)).status,409);
   assert.equal((await routeApi(request(f.path+'/groq-summary','POST',{}),f.env)).status,409);assert.equal(calls,1);
   assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE id=?").get(f.id+':groq-summary:approval:0').state,'STOPPED');
   if(mode==='truncated'||mode==='invalid'||mode==='unsupported-number'){
    const failed=f.db.prepare("SELECT result_json FROM yta_operations WHERE provider='groq-summary' AND state='FAILED_UNCERTAIN'").get();
    assert.equal(JSON.parse(failed.result_json).reviewResult.usage.totalTokens,390);
    assert.equal(f.db.prepare("SELECT SUM(used_units) AS used FROM usage_events WHERE capability='LIVE_FREE_SUMMARY'").get().used,390);
   }
   if(mode==='429'){
    const failed=f.db.prepare("SELECT result_json,error_code FROM yta_operations WHERE provider='groq-summary' AND state='FAILED_UNCERTAIN'").get();
    assert.equal(failed.error_code,'429');assert.equal(JSON.parse(failed.result_json).safeRateLimit.retryAfterSeconds,60);
   }
   assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='gemini'").get().n,0);
  }finally{globalThis.fetch=old;f.db.close();}
 }
});
test('expired or changed-key approval blocks without provider call',async()=>{
 for(const mode of ['expired','key']){const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no provider call');};try{
  await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  if(mode==='expired'){const id=f.id+':groq-summary:approval:0',stored=JSON.parse(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(id).result_json);stored.expiresAt='not-a-time';f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(stored),id);}else f.env.GROQ_API_KEY='OTHER_TEST_ONLY_KEY';
  assert.equal((await routeApi(request(f.path+'/groq-summary','POST',{}),f.env)).status,409);assert.equal(calls,0);
 }finally{globalThis.fetch=old;f.db.close();}}
});
test('concurrent summary stage requests claim one operation and send once',async()=>{
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return response();};
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  const attempts=await Promise.all([routeApi(request(f.path+'/groq-summary','POST',{}),f.env),routeApi(request(f.path+'/groq-summary','POST',{}),f.env)]);
  assert.deepEqual(attempts.map(x=>x.status).sort(),[202,409]);assert.equal(calls,1);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('approval revoked at final D1 guard cannot reach Groq fetch',async()=>{
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no provider call');};
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  const original=f.env.DB;let changed=false;f.env.DB={...original,prepare(sql){const statement=original.prepare(sql);if(!sql.startsWith('SELECT 1 AS ok FROM yta_operations a JOIN'))return statement;return {bind(...args){const bound=statement.bind(...args);return {...bound,async first(){if(!changed){changed=true;f.db.prepare("UPDATE yta_operations SET state='STOPPED' WHERE id=?").run(f.id+':groq-summary:approval:0');}return bound.first();}};}};}};
  assert.equal((await routeApi(request(f.path+'/groq-summary','POST',{}),f.env)).status,409);assert.equal(calls,0);
  assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE provider='groq-summary' AND id LIKE ?").get(f.id+':groq-summary:'+f.plan.transcriptHash+':%').state,'BLOCKED');
 }finally{globalThis.fetch=old;f.db.close();}
});
test('boundary audit changed during final D1 admission cannot reach Groq fetch',async()=>{
 const f=await fixture(),old=fetch;let calls=0,guardReads=0;globalThis.fetch=async()=>{calls++;throw Error('no provider call');};
 try{assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
  const original=f.env.DB;f.env.DB={...original,prepare(sql){const statement=original.prepare(sql);if(!sql.startsWith('SELECT 1 AS ok FROM yta_operations a JOIN'))return statement;return {bind(...args){const bound=statement.bind(...args);return {...bound,async first(){if(++guardReads===3){const row=f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(row.audit_json);audit.audioBoundaryAmbiguities=[{segmentId:1,chunkIndex:1,startMs:0,endMs:1}];f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify(audit),f.id);}return bound.first();}};}};}};
  const result=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);
  assert.equal(result.status,409,await result.clone().text());assert.equal(calls,0);assert.equal(guardReads,3);
  assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE provider='groq-summary' AND id LIKE ?").get(f.id+':groq-summary:'+f.plan.transcriptHash+':%').state,'BLOCKED');
 }finally{globalThis.fetch=old;f.db.close();}
});
test('deleting an in-flight job erases private content but retains the global Groq summary lock',async()=>{
 const f=await fixture(),old=fetch;let release,started;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});let calls=0;
 globalThis.fetch=async()=>{calls++;started();await gate;return response();};
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  const first=routeApi(request(f.path+'/groq-summary','POST',{}),f.env);await entered;
  assert.equal((await routeApi(request(f.path,'DELETE'),f.env)).status,200);
  const next=await sibling(f);
  assert.equal((await routeApi(request(next.path+'/groq-summary','POST',{}),f.env)).status,409);assert.equal(calls,1);
  assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE job_id=? AND state='CLAIMED'").get(f.id).state,'CLAIMED');
  release();assert.equal((await first).status,404);
  assert.equal((await routeApi(request(next.path+'/groq-summary','POST',{}),f.env)).status,409);assert.equal(calls,1);
  assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE job_id=? AND state='FAILED_UNCERTAIN'").get(f.id).state,'FAILED_UNCERTAIN');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_sources WHERE job_id=?').get(f.id).n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs WHERE id=?').get(f.id).n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_operations WHERE job_id=? AND result_json IS NOT NULL').get(f.id).n,0);
 }finally{release();globalThis.fetch=old;f.db.close();}
});
test('job deletion retains recent completed and uncertain summary usage for later jobs',async()=>{
 for(const mode of ['success','429']){
  const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return mode==='success'?response():Response.json({}, {status:429,headers:{'retry-after':'60'}});};
  try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
   const first=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(first.status,mode==='success'?202:409);
   const prior=f.db.prepare("SELECT state,units FROM yta_operations WHERE job_id=? AND id LIKE ?").get(f.id,f.id+':groq-summary:'+f.plan.transcriptHash+':%');
   assert.equal((await routeApi(request(f.path,'DELETE'),f.env)).status,200);
   const retained=f.db.prepare("SELECT state,units,result_json FROM yta_operations WHERE job_id=? AND id LIKE ?").get(f.id,f.id+':groq-summary:'+f.plan.transcriptHash+':%');
   assert.equal(retained.state,prior.state);assert.equal(retained.units,prior.units);assert.equal(retained.result_json,null);
   const next=await sibling(f,{approve:mode==='success'});
   if(mode==='429')assert.equal((await routeApi(request(next.path+'/groq-summary-approval'),f.env)).status,409);
   assert.equal((await routeApi(request(next.path+'/groq-summary','POST',{}),f.env)).status,409);assert.equal(calls,1);
   assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE job_id=?").get(f.id).n,3);
   assert.equal(f.db.prepare("SELECT state,result_json FROM yta_operations WHERE id=?").get(f.id+':deleting').state,'DELETING');
   assert.equal(f.db.prepare("SELECT COUNT(*) n FROM usage_events WHERE job_id=?").get(f.id).n,mode==='success'?1:0);
  }finally{globalThis.fetch=old;f.db.close();}
 }
});
test('a job outside the owner scope cannot be deleted or have its summary records erased',async()=>{
 const f=await fixture();try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  f.db.prepare("UPDATE jobs SET owner_id='different-owner' WHERE id=?").run(f.id);
  assert.equal((await routeApi(request(f.path,'DELETE'),f.env)).status,404);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_sources WHERE job_id=?').get(f.id).n,1);
  assert.ok(f.db.prepare("SELECT result_json FROM yta_operations WHERE id=?").get(f.id+':groq-summary:approval:0').result_json);
 }finally{f.db.close();}
});
test('review credential is opaque and a changed key blocks approval before any provider call',async()=>{
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no provider call');};
 try{assert.ok(f.approval.credentialGeneration);assert.ok(!JSON.stringify(f.approval).includes('NOT_REAL_TEST_KEY'));
  f.env.GROQ_API_KEY='NEW_TEST_ONLY_KEY';
  const r=await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  assert.equal(r.status,409);assert.equal(calls,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='groq-summary'").get().n,0);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('summary ledger rejects negative offsets and malformed timestamps without erasing history',async()=>{
 for(const [units,at] of [[-195000,new Date().toISOString()],[5,'bad-time']]){
  const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no provider call');};
  try{assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
   f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run('corrupt:groq-summary:ledger',f.id,'groq-summary',units,'DONE',at);
   const r=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal((await r.json()).error.code,'SUMMARY_LEDGER_REVIEW_REQUIRED');assert.equal(calls,0);
   assert.equal(f.db.prepare('SELECT units,created_at FROM yta_operations WHERE id=?').get('corrupt:groq-summary:ledger').units,units);
  }finally{globalThis.fetch=old;f.db.close();}
 }
});
test('grounding rejects Korean numeric substrings, decimals, signs and percent mismatches',async()=>{
 for(const claim of ['5명','1.5%','5%','+5명']){
  const f=await fixture({sourceText:'원문 15명 -5명 11.5%'}),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return response({...valid(1),numbers:[{text:claim,evidenceIds:[1]}]});};
  try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
   const r=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal((await r.json()).error.code,'SUMMARY_RESPONSE_INVALID',claim);assert.equal(calls,1);
  }finally{globalThis.fetch=old;f.db.close();}
 }
});
test('long Korean transcript offers a bounded first window and resumes completed stages in a new window',async()=>{
 const f=await fixture({longSource:true,sourceText:'가나다라마바사아자차카타파하 '.repeat(18)}),old=fetch;let calls=0,reply=response();globalThis.fetch=async()=>{calls++;return reply;};
 try{assert.ok(f.segments.map(x=>x.text).join('').length>30000);assert.ok(f.plan.rawStages>29);assert.equal(f.plan.maxRequests,29);assert.ok(f.plan.totalRequests>29);
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
  const groups=partitionGroqTranscript(f.segments,{durationSeconds:6000,audioProcessingCoverage:1,independentVerification:false,externalFactCheck:'NOT_PERFORMED'});
  for(let i=0;i<29;i++){const group=groups[i],ids=group.map(x=>x.id),report={summary:[{text:'원문',evidenceIds:ids}],chapters:[{text:'원문',evidenceIds:ids}],claims:[],numbers:[],critical:[],conclusion:'원문'};
   f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(f.id+':groq-summary:'+f.plan.transcriptHash+':raw:'+i,f.id,'groq-summary',6600,'DONE',new Date(Date.now()-100000).toISOString(),JSON.stringify({hash:f.plan.transcriptHash,key:'raw:'+i,report}));}
  const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();assert.equal(review.approved,false);assert.equal(review.windowStart,29);
  const approval={...f.approval,windowStart:29,maxRequests:review.maxRequests,totalTokenUpperBound:review.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',approval),f.env)).status,200);
  const ids=groups[29].map(part=>part.id);reply=response({summary:[{text:'원문',evidenceIds:ids}],chapters:[{text:'원문',evidenceIds:ids}],claims:[],numbers:[],critical:[],conclusion:'원문'});
  const sameDay=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal((await sameDay.json()).error.code,'SUMMARY_LOCAL_LIMIT');assert.equal(calls,0);
  f.db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary' AND state='DONE'").run(new Date(Date.now()-90000000).toISOString(),f.id);
  const r=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(r.status,202,await r.clone().text());assert.equal(calls,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE id LIKE ? AND state='DONE'").get(f.id+':groq-summary:'+f.plan.transcriptHash+':raw:%').n,30);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('original 50,000-character fixture reports the strict-schema planning limit without a provider call',async()=>{
 const f=await fixture({longSource:true});
 try{assert.ok(f.segments.map(x=>x.text).join('').length>50000);assert.equal(f.plan.error?.code,'INVALID_INPUT');assert.match(f.plan.error.message,/단계 계획 상한/);}finally{f.db.close();}
});
test('1,226 synthetic Korean segments expose a reviewed raw bundle without claiming final synthesis',async()=>{
 const f=await fixture({complete:false}),old=fetch;
 const count=1226,durationMs=5892864;
 const segments=Array.from({length:count},(_,i)=>({id:i+1,startMs:Math.round(i*durationMs/count),endMs:Math.round((i+1)*durationMs/count),text:'가'.repeat(i<45?41:40)}));
 const raw=segments.map(segment=>segment.text).join('\n');assert.equal(raw.length,50310);
 const audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64),audioBoundaryAmbiguities:Array.from({length:14},(_,i)=>({segmentId:2+i*33,chunkIndex:i+1,startMs:0,endMs:1}))};
 f.db.prepare('UPDATE jobs SET duration_seconds=?,audit_json=? WHERE id=?').run(durationMs/1000,JSON.stringify(audit),f.id);
 f.db.prepare('UPDATE yta_sources SET raw=?,segments_json=? WHERE job_id=?').run(raw,JSON.stringify(segments),f.id);
 let calls=0;
 globalThis.fetch=async(_url,options)=>{
  calls++;
  const body=JSON.parse(options.body),prompt=body.messages[1].content;
  assert.deepEqual(body.response_format,GROQ_SUMMARY_RESPONSE_FORMAT);
  assert.ok(groqInputUpperBound(body.messages)<=GROQ_SUMMARY_INPUT_BOUND);
  let ids;
  if(prompt.includes('전사 배열 [id,startMs,endMs,text]:'))ids=[JSON.parse(prompt.split('전사 배열 [id,startMs,endMs,text]:\n')[1])[0][0]];
  else ids=[...new Set(JSON.parse(prompt.split('시간 순서별 부분 보고서:\n')[1]).flatMap(part=>part.report.chapters.flatMap(chapter=>chapter.evidenceIds)))];
  return response({summary:[{text:'요약',evidenceIds:[ids[0]]}],chapters:[{text:'구간 요약',evidenceIds:ids}],claims:[],numbers:[],critical:[],conclusion:'검토'});
 };
 const approve=async()=>{
  const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();
  assert.equal(review.approved,false);
  const approval={jobId:f.id,transcriptHash:review.transcriptHash,model:review.model,outputKind:review.outputKind,windowStart:review.windowStart,totalRequests:review.totalRequests,maxRequests:review.maxRequests,maxInputTokensPerRequest:review.maxInputTokensPerRequest,maxCompletionTokensPerRequest:review.maxCompletionTokensPerRequest,totalTokenUpperBound:review.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',approval),f.env)).status,200);
 };
 try{
  const plan=await(await routeApi(request(f.path+'/groq-summary-plan'),f.env)).json();
  assert.ok(plan.rawStages>1&&plan.rawStages<=120,JSON.stringify(plan));
  assert.equal(plan.totalRequests,plan.rawStages*2-1);
  assert.equal(plan.rawStages,90);assert.equal(plan.totalRequests,179);
  await approve();
  let bundleAvailable=false;
  for(let step=0;step<plan.totalRequests+plan.rawStages+10;step++){
   const result=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env),body=await result.json();
   assert.ok([200,202].includes(result.status),JSON.stringify({step,calls,code:body.error?.code,message:body.error?.message}));
   if(body.bundleAvailable){bundleAvailable=true;break;}
   if(body.windowComplete){f.db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary' AND state='DONE'").run(new Date(Date.now()-90000000).toISOString(),f.id);await approve();}
   else f.db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary' AND state='DONE' AND created_at>?").run(new Date(Date.now()-62000).toISOString(),f.id,new Date(Date.now()-61000).toISOString());
  }
  assert.equal(bundleAvailable,true);
  const bundle=await(await routeApi(request(f.path+'/groq-summary-bundle'),f.env)).json();
  assert.equal(bundle.report.kind,'GROQ_RAW_CHECKPOINT_BUNDLE');assert.equal(bundle.finalSummaryComplete,false);
  assert.equal(calls,90);
  assert.equal(bundle.report.compositionMode,'LOSSLESS_RAW_CHECKPOINTS');
  assert.equal(bundle.report.chapters.length,90);
  assert.ok([null,'null'].includes(f.db.prepare('SELECT report_json FROM jobs WHERE id=?').get(f.id).report_json));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE job_id=? AND provider='groq-summary' AND state='DONE'").get(f.id).n,calls);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('oversized valid checkpoint is preserved for lossless local composition',async()=>{
 const f=await fixture({large:true}),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return response({...valid(1),summary:[{text:'가'.repeat(800),evidenceIds:[1]}]});};
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  const r=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(r.status,202,await r.clone().text());assert.equal(calls,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='groq-summary' AND state='DONE'").get().n,1);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('1,954-character stored strict report recovers without a provider call and preserves both failed usages',async()=>{
 const f=await fixture({complete:false}),oldFetch=fetch;
 const count=1226,durationMs=5892864;
 const segments=Array.from({length:count},(_,i)=>({id:i+1,startMs:i<20?Math.round(i*90602/20):Math.round(90602+(i-20)*(durationMs-90602)/(count-20)),endMs:i<20?Math.round((i+1)*90602/20):Math.round(90602+(i-19)*(durationMs-90602)/(count-20)),text:'가'.repeat(i<20?23:40)}));
 const raw=segments.map(part=>part.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64),audioBoundaryAmbiguities:Array.from({length:14},(_,i)=>({segmentId:2+i*33,chunkIndex:i+1,startMs:0,endMs:1}))};
 f.db.prepare('UPDATE jobs SET duration_seconds=?,audit_json=? WHERE id=?').run(durationMs/1000,JSON.stringify(audit),f.id);
 f.db.prepare('UPDATE yta_sources SET raw=?,segments_json=? WHERE job_id=?').run(raw,JSON.stringify(segments),f.id);
 const plan=await(await routeApi(request(f.path+'/groq-summary-plan'),f.env)).json();
 const first=partitionGroqTranscript(segments,promptAudit({duration_seconds:durationMs/1000,audit}))[0];
 assert.equal(first.length,20);assert.equal(first.at(-1).endMs,90602);
 const report={summary:Array.from({length:4},(_,i)=>({text:'요약'.repeat(16),evidenceIds:[i*5+1]})),chapters:first.map(part=>({text:'장면'.repeat(17),evidenceIds:[part.id]})),claims:[],numbers:[],critical:[],conclusion:'결론'.repeat(33)};
 const base=JSON.stringify(report).length;report.chapters[0].text+='가'.repeat(1954-base);
 const savedText=JSON.stringify(report),part={ids:first.map(part=>part.id),startMs:0,endMs:90602,report};
 assert.equal(savedText.length,1954);
 const mergeMessages=groqSummaryMessages(groqMergePrompt([part,part],promptAudit({duration_seconds:durationMs/1000,audit}),{final:true}));
 assert.equal(Buffer.byteLength(JSON.stringify(GROQ_SUMMARY_RESPONSE_FORMAT)),807);
 assert.equal(Buffer.byteLength(JSON.stringify(groqSummaryRequestBody(mergeMessages,1800))),11357);
 assert.equal(groqInputUpperBound(mergeMessages),11869);
 assert.equal(groqInputUpperBound(mergeMessages)-GROQ_SUMMARY_INPUT_BOUND,7069);
 const legacyInput=[raw,segments,audit.audioFileSha256,promptAudit({duration_seconds:durationMs/1000,audit})],legacyHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(legacyInput)))).toString('hex');
 const oldId=f.id+':groq-summary:'+legacyHash+':raw:0',newId=f.id+':groq-summary:'+plan.transcriptHash+':raw:0',now=new Date(Date.now()-120000).toISOString(),oldResult=JSON.stringify({reviewResult:{partialText:JSON.stringify({...valid(1),summary:'오래된 실패'}),usage:{inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220}}}),newResult=JSON.stringify({reviewResult:{partialText:savedText,usage:{inputTokens:1157,outputTokens:1012,reasoningTokens:59,totalTokens:2169}}});
 f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(f.id+':groq-summary:approval:0',f.id,'groq-summary',6600,'STOPPED',now,JSON.stringify({...f.approval,jobId:f.id,sequence:0,transcriptHash:legacyHash}));
 f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)').run(oldId,f.id,'groq-summary',6600,'FAILED_UNCERTAIN',now,'SUMMARY_RESPONSE_INVALID',oldResult);
 f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)').run(newId,f.id,'groq-summary',6600,'FAILED_UNCERTAIN',now,'SUMMARY_CHECKPOINT_TOO_LARGE',newResult);
 for(const [kind,state] of [['review','REVIEWED'],['approval','APPROVED']])f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(f.id+':groq-summary-pilot:'+kind+':'+legacyHash,f.id,'groq-summary-pilot-'+kind,0,state,now,'{}');
 for(const units of [2220,2169])f.db.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),f.id,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',units,0,null,'TEST',now);
 let providerCalls=0;globalThis.fetch=async()=>{providerCalls++;throw Error('provider call prohibited');};
 try{
  const url=f.path+'/groq-summary-checkpoint-recovery',preview=await(await routeApi(request(url),f.env)).json();
  assert.equal(preview.chapterCount,20);assert.equal(preview.summaryCount,4);assert.equal(preview.storedUtf16Length,1954);assert.equal(preview.confirmedUsage.totalTokens,2169);
  assert.ok(!JSON.stringify(preview).includes(report.chapters[0].text));
  const body={step:'recover',evidenceHash:preview.evidenceHash,failedOperationId:preview.failedOperationId,contractHash:preview.contractHash,responseSha256:preview.responseSha256,acknowledgeOriginalUsage:2169,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true};
  assert.equal((await routeApi(request(url,'POST',{...body,responseSha256:'b'.repeat(64)}),f.env)).status,400);
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run('{}',newId);
  assert.notEqual((await routeApi(request(url,'POST',body),f.env)).status,200);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE provider='groq-summary-recovery'").get().n,0);
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(newResult,newId);
  const recovered=await routeApi(request(url,'POST',body),f.env);assert.equal(recovered.status,200,await recovered.clone().text());assert.equal((await recovered.json()).automaticContinuation,false);
  const choice=await(await routeApi(request(f.path+'/summary-choice'),f.env)).json();assert.equal(choice.summary.savedRawStages,1);assert.equal(choice.summary.remainingRawStages,choice.summary.rawStages-1);
  assert.equal(providerCalls,0);
  assert.deepEqual({...f.db.prepare('SELECT state,error_code,result_json FROM yta_operations WHERE id=?').get(oldId)},{state:'FAILED_UNCERTAIN',error_code:'SUMMARY_RESPONSE_INVALID',result_json:oldResult});
  assert.deepEqual({...f.db.prepare('SELECT state,error_code,result_json FROM yta_operations WHERE id=?').get(newId)},{state:'FAILED_UNCERTAIN',error_code:'SUMMARY_CHECKPOINT_TOO_LARGE',result_json:newResult});
  assert.deepEqual(f.db.prepare("SELECT used_units FROM usage_events WHERE job_id=? ORDER BY used_units").all(f.id).map(row=>row.used_units),[2169,2220]);
  const next=await(await routeApi(request(f.path+'/groq-summary-plan'),f.env)).json();assert.equal(next.windowStart,1);
  assert.equal((await routeApi(request(url,'POST',body),f.env)).status,409);assert.equal(providerCalls,0);
  const status=await(await routeApi(request(f.path+'/groq-summary-status'),f.env)).json();assert.equal(status.completedStages,1);assert.equal(status.activeStage,null);
  const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();
  const approval={jobId:f.id,transcriptHash:review.transcriptHash,model:review.model,outputKind:review.outputKind,windowStart:review.windowStart,totalRequests:review.totalRequests,maxRequests:review.maxRequests,maxInputTokensPerRequest:review.maxInputTokensPerRequest,maxCompletionTokensPerRequest:review.maxCompletionTokensPerRequest,totalTokenUpperBound:review.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',approval),f.env)).status,200);
  assert.equal(providerCalls,0);
  const second=partitionGroqTranscript(segments,promptAudit({duration_seconds:durationMs/1000,audit}))[1],secondId=second[0].id;
  globalThis.fetch=async()=>{providerCalls++;return response(valid(secondId));};
  const nextStage=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(nextStage.status,202,await nextStage.clone().text());assert.equal(providerCalls,1);
  assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(newId).state,'FAILED_UNCERTAIN');
  f.db.prepare("UPDATE jobs SET audit_json=json_set(audit_json,'$.summaryProvider','groq','$.externalFactCheck','NOT_PERFORMED') WHERE id=?").run(f.id);
  const afterMetadata=await routeApi(request(f.path+'/groq-summary-status'),f.env);assert.equal(afterMetadata.status,200,await afterMetadata.clone().text());
  f.db.prepare("UPDATE jobs SET audit_json=json_set(audit_json,'$.audioBoundaryReview','CHANGED_INPUT') WHERE id=?").run(f.id);
  const afterInputChange=await routeApi(request(f.path+'/groq-summary-status'),f.env);assert.equal((await afterInputChange.json()).error.code,'SUMMARY_RECOVERY_SCOPE_CHANGED');
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});
test('1,226 source segments and 1,954-character chapter-rich checkpoints compose without loss or model input overflow',async()=>{
 const f=await fixture({complete:false}),oldFetch=fetch,count=1226,durationMs=5892864;
 const segments=Array.from({length:count},(_,i)=>({id:i+1,startMs:i<20?Math.round(i*90602/20):Math.round(90602+(i-20)*(durationMs-90602)/(count-20)),endMs:i<20?Math.round((i+1)*90602/20):Math.round(90602+(i-19)*(durationMs-90602)/(count-20)),text:'가'.repeat(i<20?23:40)}));
 const raw=segments.map(part=>part.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64),audioBoundaryAmbiguities:Array.from({length:14},(_,i)=>({segmentId:2+i*33,chunkIndex:i+1,startMs:0,endMs:1}))};
 f.db.prepare('UPDATE jobs SET duration_seconds=?,audit_json=? WHERE id=?').run(durationMs/1000,JSON.stringify(audit),f.id);
 f.db.prepare('UPDATE yta_sources SET raw=?,segments_json=? WHERE job_id=?').run(raw,JSON.stringify(segments),f.id);
 const plan=await(await routeApi(request(f.path+'/groq-summary-plan'),f.env)).json(),groups=partitionGroqTranscript(segments,promptAudit({duration_seconds:durationMs/1000,audit}));
 assert.equal(groups[0].length,20);assert.ok(groups.length>16);
 const originals=[];
 for(let i=0;i<groups.length;i++){
  const group=groups[i],summary=Array.from({length:4},(_,index)=>({text:'요약'.repeat(16),evidenceIds:[group[Math.min(group.length-1,Math.floor(index*group.length/4))].id]}));
  const report={summary,chapters:group.map(part=>({text:'장면'.repeat(17),evidenceIds:[part.id]})),claims:[],numbers:[],critical:[],conclusion:'결론'.repeat(33)};
  report.chapters[0].text+='가'.repeat(1954-JSON.stringify(report).length);
  assert.equal(JSON.stringify(report).length,1954);originals.push(report);
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(f.id+':groq-summary:'+plan.transcriptHash+':raw:'+i,f.id,'groq-summary',6600,'DONE',new Date().toISOString(),JSON.stringify({hash:plan.transcriptHash,key:'raw:'+i,report}));
 }
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no model call');};
 try{
  const firstId=f.id+':groq-summary:'+plan.transcriptHash+':raw:0',originalResult=f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(firstId).result_json;
  const oversized=JSON.parse(originalResult);oversized.report.summary[0].text='가'.repeat(400000);
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(oversized),firstId);
  const blocked=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();
  assert.equal(blocked.error.code,'SUMMARY_COMPOSED_REPORT_TOO_LARGE');
  assert.ok([null,'null'].includes(f.db.prepare('SELECT report_json FROM jobs WHERE id=?').get(f.id).report_json));
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(originalResult,firstId);
  const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();assert.equal(review.bundleAvailable,true);assert.equal(review.outputKind,'RAW_CHECKPOINT_BUNDLE');
  const denied=await routeApi(request(f.path+'/groq-summary','POST',{finalizeOnly:true,transcriptHash:plan.transcriptHash}),f.env);
  assert.equal((await denied.json()).error.code,'SUMMARY_FINALIZATION_NOT_READY');
  const bundle=await(await routeApi(request(f.path+'/groq-summary-bundle'),f.env)).json(),report=bundle.report;
  assert.equal(bundle.bundleContractVersion,'raw-checkpoint-bundle-v1');assert.equal(bundle.finalSummaryComplete,false);assert.equal(report.kind,'GROQ_RAW_CHECKPOINT_BUNDLE');
  assert.equal(calls,0);assert.equal(report.compositionMode,'LOSSLESS_RAW_CHECKPOINTS');assert.equal(report.sourceCheckpointCount,groups.length);
  assert.equal(report.summary.length,groups.length*4);assert.equal(report.chapters.length,count);
  assert.deepEqual(report.chapters.map(item=>item.evidenceIds[0]),segments.map(part=>part.id));
  assert.equal(report.chapters[0].text,originals[0].chapters[0].text);
  assert.equal(report.conclusion,originals.map(item=>item.conclusion).join('\n'));
  assert.ok(Buffer.byteLength(JSON.stringify(report))<1_000_000);
  const exported=await routeApi(request(f.path+'/groq-summary-bundle?format=txt'),f.env),txt=await exported.text();
  assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition'),/\.txt"$/);
  assert.ok(txt.includes('전체 종합 요약 미완료'));assert.ok(txt.includes(originals[0].chapters[0].text));assert.ok(txt.includes('#1226'));
  assert.ok(txt.includes('보존된 겹침 경계 불확실성: 14개'));assert.ok(txt.includes('영향 근거 ID: #2, #35'));
  assert.ok(txt.includes(`#1226 @ ${segments.at(-1).startMs}–${segments.at(-1).endMs}ms`));
  assert.ok([null,'null'].includes(f.db.prepare('SELECT report_json FROM jobs WHERE id=?').get(f.id).report_json));
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});
test('completed checkpoints finalize without a further provider request even after approval expiry',async()=>{
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return response();};
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  assert.equal((await routeApi(request(f.path+'/groq-summary','POST',{}),f.env)).status,202);assert.equal(calls,1);
  const approvalId=f.id+':groq-summary:approval:0',stored=JSON.parse(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(approvalId).result_json);
  stored.expiresAt=Date.now()-1;f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(stored),approvalId);
  const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();assert.equal(review.finalizationReady,true);
  const saved=await routeApi(request(f.path+'/groq-summary','POST',{finalizeOnly:true,transcriptHash:f.plan.transcriptHash}),f.env);
  assert.equal(saved.status,200,await saved.clone().text());assert.equal((await saved.json()).job.report.kind,'GROQ_EVIDENCE_LINKED');assert.equal(calls,1);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('finalizeOnly never dispatches when one checkpoint is missing',async()=>{
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no provider call');};
 try{const r=await routeApi(request(f.path+'/groq-summary','POST',{finalizeOnly:true,transcriptHash:f.plan.transcriptHash}),f.env);
  assert.equal((await r.json()).error.code,'SUMMARY_FINALIZATION_NOT_READY');assert.equal(calls,0);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('Korean words adjoining a number do not hide a substring mismatch',async()=>{
 const f=await fixture({sourceText:'참가자는 15명입니다.'}),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return response({...valid(1),numbers:[{text:'총5명',evidenceIds:[1]}]});};
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  const r=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal((await r.json()).error.code,'SUMMARY_RESPONSE_INVALID');assert.equal(calls,1);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('encrypted D1 key rotation during approval cannot bind the unreviewed key',async()=>{
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no provider call');};
 try{const root=Buffer.alloc(32,7),first=await encryptProviderKey(root,'groq','FIRST_TEST_ONLY_KEY'),next=await encryptProviderKey(root,'groq','SECOND_TEST_ONLY_KEY');
  const insert=(record)=>f.db.prepare('INSERT OR REPLACE INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES(?,?,?,?,?,?)').run('owner','groq',record.version,record.ivB64,record.ciphertextB64,new Date().toISOString());
  insert(first);const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();
  const original=f.env.DB;let reads=0;f.env.DB={...original,prepare(sql){const stmt=original.prepare(sql);if(!sql.startsWith('SELECT cipher_version,iv_b64,ciphertext_b64,updated_at FROM provider_credentials'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {...bound,async first(){reads++;if(reads===2)insert(next);return bound.first();}};}};}};
  const r=await routeApi(request(f.path+'/groq-summary-approval','POST',{...f.approval,credentialGeneration:review.credentialGeneration}),f.env);
  assert.equal((await r.json()).error.code,'SUMMARY_CREDENTIAL_CHANGED');assert.equal(calls,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE state='APPROVED' AND provider='groq-summary'").get().n,0);
 }finally{globalThis.fetch=old;f.db.close();}
});
test('rotation while approval insert awaits leaves no usable approval',async()=>{
 const f=await fixture(),root=Buffer.alloc(32,7),first=await encryptProviderKey(root,'groq','FIRST_TEST_ONLY_KEY'),next=await encryptProviderKey(root,'groq','SECOND_TEST_ONLY_KEY');
 try{const put=record=>f.db.prepare('INSERT OR REPLACE INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES(?,?,?,?,?,?)').run('owner','groq',record.version,record.ivB64,record.ciphertextB64,new Date().toISOString());
  put(first);const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();
  const original=f.env.DB;f.env.DB={...original,prepare(sql){const stmt=original.prepare(sql);if(!sql.startsWith('INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json)'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {...bound,async run(){put(next);return bound.run();}};}};}};
  const r=await routeApi(request(f.path+'/groq-summary-approval','POST',{...f.approval,credentialGeneration:review.credentialGeneration}),f.env);
  assert.equal((await r.json()).error.code,'SUMMARY_CREDENTIAL_CHANGED');
  const row=f.db.prepare("SELECT state,error_code,result_json FROM yta_operations WHERE provider='groq-summary'").get();
  assert.equal(row.state,'STOPPED');assert.equal(row.error_code,'SUMMARY_CREDENTIAL_CHANGED');assert.notEqual(JSON.parse(row.result_json).keyIdentity,await capacityIdentity(f.env,'groq'));
 }finally{f.db.close();}
});
test('ordinary summary final D1 admission rejects a key rotated after identity reads',async()=>{
 const f=await fixture(),oldFetch=fetch,root=Buffer.alloc(32,7),first=await encryptProviderKey(root,'groq','FIRST_TEST_ONLY_KEY'),next=await encryptProviderKey(root,'groq','SECOND_TEST_ONLY_KEY');
 const put=record=>f.db.prepare('INSERT OR REPLACE INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES(?,?,?,?,?,?)').run('owner','groq',record.version,record.ivB64,record.ciphertextB64,new Date().toISOString());
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error('provider must not be reached');};
 try{
  put(first);const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json();
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',{...f.approval,credentialGeneration:review.credentialGeneration}),f.env)).status,200);
  const original=f.env.DB;let changed=false;f.env.DB={...original,prepare(sql){const stmt=original.prepare(sql);if(!sql.startsWith('SELECT 1 AS ok FROM yta_operations a JOIN'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {...bound,async first(){if(!changed){changed=true;put(next);}return bound.first();}};}};}};
  const result=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);
  assert.equal(changed,true);assert.equal(result.status,409);assert.equal((await result.json()).error.code,'SUMMARY_APPROVAL_CHANGED');assert.equal(calls,0);
  assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE job_id=? AND provider='groq-summary' AND state='BLOCKED'").get(f.id).state,'BLOCKED');
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});
test('deleting during an abnormal provider response retains uncertainty without resurrecting private text',async()=>{
 const f=await fixture(),old=fetch;let release,started;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);let calls=0;
 globalThis.fetch=async()=>{calls++;started();await gate;return Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'length',message:{content:'PRIVATE_RESPONSE_TEXT'}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390}});};
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  const pending=routeApi(request(f.path+'/groq-summary','POST',{}),f.env);await entered;
  assert.equal((await routeApi(request(f.path,'DELETE'),f.env)).status,200);release();assert.equal((await pending).status,409);
  const row=f.db.prepare("SELECT state,result_json FROM yta_operations WHERE job_id=? AND state='FAILED_UNCERTAIN'").get(f.id);
  assert.equal(row.state,'FAILED_UNCERTAIN');assert.equal(row.result_json,null);assert.equal(calls,1);
 }finally{release();globalThis.fetch=old;f.db.close();}
});
test('late truncated response cannot refill cleared payload while final DELETE awaits',async()=>{
 const f=await fixture(),old=fetch;let releaseFetch,fetchStarted,releaseDelete,deleteReached;
 const fetchGate=new Promise(resolve=>releaseFetch=resolve),enteredFetch=new Promise(resolve=>fetchStarted=resolve),deleteGate=new Promise(resolve=>releaseDelete=resolve),enteredDelete=new Promise(resolve=>deleteReached=resolve);
 globalThis.fetch=async()=>{fetchStarted();await fetchGate;return Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'length',message:{content:'PRIVATE_PARTIAL_TEXT'}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390}});};
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  const pending=routeApi(request(f.path+'/groq-summary','POST',{}),f.env);await enteredFetch;
  const original=f.env.DB;f.env.DB={...original,prepare(sql){const stmt=original.prepare(sql);if(sql!=='DELETE FROM jobs WHERE id=? AND owner_id=?')return stmt;return {bind(...args){const bound=stmt.bind(...args);return {...bound,async run(){deleteReached();await deleteGate;return bound.run();}};}};}};
  const deleting=routeApi(request(f.path,'DELETE'),f.env);await enteredDelete;
  assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE id=?").get(f.id+':deleting').state,'DELETING');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE job_id=? AND result_json IS NOT NULL").get(f.id).n,0);
  releaseFetch();assert.equal((await pending).status,409);
  assert.equal(f.db.prepare("SELECT state,result_json FROM yta_operations WHERE job_id=? AND state='FAILED_UNCERTAIN'").get(f.id).result_json,null);
  releaseDelete();assert.equal((await deleting).status,200);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE job_id=? AND result_json IS NOT NULL").get(f.id).n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE id=?").get(f.id).n,0);
 }finally{releaseFetch();releaseDelete();globalThis.fetch=old;f.db.close();}
});
test('deletion marker blocks the final D1 admission read before any Groq fetch',async()=>{
 const f=await fixture(),old=fetch;let calls=0,releaseDelete,deleteReached,deleting;
 const deleteGate=new Promise(resolve=>releaseDelete=resolve),enteredDelete=new Promise(resolve=>deleteReached=resolve);
 globalThis.fetch=async()=>{calls++;throw Error('provider must not be reached');};
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  const original=f.env.DB;let interleaved=false;f.env.DB={...original,prepare(sql){const stmt=original.prepare(sql);
   if(sql==='DELETE FROM yta_sources WHERE job_id=?')return {bind(...args){const bound=stmt.bind(...args);return {...bound,async run(){deleteReached();await deleteGate;return bound.run();}};}};
   if(!sql.startsWith('SELECT 1 AS ok FROM yta_operations a JOIN'))return stmt;
   return {bind(...args){const bound=stmt.bind(...args);return {...bound,async first(){if(!interleaved){interleaved=true;deleting=routeApi(request(f.path,'DELETE'),f.env);await enteredDelete;}return bound.first();}};}};
  }};
  const stage=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);
  assert.equal(stage.status,409);assert.equal((await stage.json()).error.code,'SUMMARY_APPROVAL_CHANGED');assert.equal(calls,0);
  assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE id=?").get(f.id+':deleting').state,'DELETING');
  assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE job_id=? AND state='BLOCKED'").get(f.id).state,'BLOCKED');
  releaseDelete();assert.equal((await deleting).status,200);
 }finally{releaseDelete();globalThis.fetch=old;f.db.close();}
});
