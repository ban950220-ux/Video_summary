import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {routeApi} from '../src/worker.mjs';
import {partitionGroqTranscript,groqInputUpperBound,groqSummaryMessages,groqRawPrompt,groqMergePrompt,promptAudit,GROQ_SUMMARY_INPUT_BOUND} from '../src/groq-summary.mjs';
import {reportPrompt} from '../src/report.mjs';
import {encryptProviderKey} from '../src/vault.mjs';
import {capacityIdentity} from '../src/observed-capacity.mjs';

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
 const approval=plan&&{jobId:id,transcriptHash:plan.transcriptHash,model:plan.model,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
 return {db,env,id,path,plan,approval,segments};
}
async function sibling(f){
 const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600,title:'Second owner job'}),f.env)).json(),id=created.job.id,path='/api/jobs/'+id;
 const raw=f.segments.map(part=>part.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
 f.db.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').run(id,raw,JSON.stringify(f.segments),'GROQ_OWNED_AUDIO',new Date().toISOString());
 f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify(audit),id);
 const plan=await(await routeApi(request(path+'/groq-summary-plan'),f.env)).json();
 const review=await(await routeApi(request(path+'/groq-summary-approval'),f.env)).json();
 const approval={jobId:id,transcriptHash:plan.transcriptHash,model:plan.model,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
 assert.equal((await routeApi(request(path+'/groq-summary-approval','POST',approval),f.env)).status,200);
 return {id,path};
}
const valid=id=>({summary:[{text:'원문 검증',evidenceIds:[id]}],chapters:[{text:'시간대 요약',evidenceIds:[id]}],claims:[],numbers:[],critical:[],conclusion:'외부 사실은 미확인'});
const response=(body=valid(1),extra={})=>Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'stop',message:{content:JSON.stringify(body)}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390,completion_tokens_details:{reasoning_tokens:10}},...extra});

test('conservative UTF-8 bound partitions long Korean source below Groq Free input ceiling',()=>{
 const segments=Array.from({length:25},(_,i)=>({id:i+1,startMs:i*24000,endMs:(i+1)*24000,text:'가나다라마바사 '.repeat(12)}));
 const groups=partitionGroqTranscript(segments,{audioFileSha256:'a'.repeat(64)});
 assert.ok(groups.length>1);assert.deepEqual(groups.flat().map(x=>x.id),segments.map(x=>x.id));
 for(const group of groups)assert.ok(groqInputUpperBound(groqSummaryMessages(groqRawPrompt(group,{audioFileSha256:'a'.repeat(64)})))<=GROQ_SUMMARY_INPUT_BOUND);
 const fullLength=Array.from({length:125},(_,i)=>({id:i+1,startMs:i*47136,endMs:(i+1)*47136,text:'가나다라마바사아자차카타파하 '.repeat(8)}));
 const bounded=partitionGroqTranscript(fullLength,{durationSeconds:5892,audioProcessingCoverage:1,independentVerification:false});
 assert.equal(fullLength.map(part=>part.text).join('').length,15000);
 assert.ok((bounded.length*2-1)*6600<=195000);
});
test('500-segment future merge packs consecutive source IDs without losing the checkpoint guard',()=>{
 const segments=Array.from({length:500},(_,i)=>({id:i+1,startMs:i*11786,endMs:(i+1)*11786,text:'가나다라마바사아자차'.repeat(10)}));
 const audit={durationSeconds:5893,audioProcessingCoverage:1,independentVerification:false,externalFactCheck:'NOT_PERFORMED',audioBoundarySegmentIds:Array.from({length:14},(_,i)=>2+33*i)};
 const groups=partitionGroqTranscript(segments,audit),firstIds=groups.map(group=>group[0].id).filter(id=>id<=397);
 assert.equal(groups.length,52);
 const part=(first,last,chapterIds)=>({ids:Array.from({length:last-first+1},(_,i)=>first+i),startMs:(first-1)*11786,endMs:last*11786,report:{summary:[{text:'원문',evidenceIds:[first]}],chapters:[{text:'구간',evidenceIds:chapterIds}],claims:[],numbers:[],critical:[],conclusion:'원문'}});
 const large=part(1,397,firstIds),small=part(398,500,[398]),size=(parts,final=false)=>groqInputUpperBound(groqSummaryMessages(groqMergePrompt(parts,audit,{final})));
 assert.match(groqMergePrompt([large,small],audit),/"idRange":\[1,397\]/);
 assert.ok(size([large,large],true)<=GROQ_SUMMARY_INPUT_BOUND);
 assert.ok(size([large,small],true)<=GROQ_SUMMARY_INPUT_BOUND);
 assert.ok(size([small,small],true)<=GROQ_SUMMARY_INPUT_BOUND);
 assert.match(groqMergePrompt([{...small,ids:[398,400]}],audit),/"ids":\[398,400\]/);
});
test('500-segment mocked summary reaches and saves the previously blocked merge checkpoint',async()=>{
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
  const body={jobId:f.id,transcriptHash:review.transcriptHash,model:review.model,windowStart:review.windowStart,totalRequests:review.totalRequests,maxRequests:review.maxRequests,maxInputTokensPerRequest:review.maxInputTokensPerRequest,maxCompletionTokensPerRequest:review.maxCompletionTokensPerRequest,totalTokenUpperBound:review.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',body),f.env)).status,200);
 };
 try{
  const plan=await(await routeApi(request(f.path+'/groq-summary-plan'),f.env)).json();assert.equal(plan.rawStages,52);
  await approve();
  let saved=false;
  for(let step=0;step<110;step++){
   const result=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env),body=await result.json();
   assert.ok([200,202].includes(result.status),JSON.stringify({step,calls,body}));
   saved=Boolean(f.db.prepare("SELECT 1 AS ok FROM yta_operations WHERE job_id=? AND provider='groq-summary' AND id LIKE ? AND state='DONE'").get(f.id,'%:merge:1:0'));
   if(saved)break;
   if(body.windowComplete){f.db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary' AND state='DONE'").run(new Date(Date.now()-90_000_000).toISOString(),f.id);await approve();}
   else if(body.pending)f.db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary' AND state='DONE' AND created_at>?").run(new Date(Date.now()-62_000).toISOString(),f.id,new Date(Date.now()-60_000).toISOString());
  }
  assert.equal(saved,true);
  assert.ok(calls>=52);
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
  const report={summary:[{text:'원문에 기반한 한국어 정리',evidenceIds:[ids[0]]}],chapters:ids.map(id=>({text:'해당 구간 요약',evidenceIds:[id]})),claims:[],numbers:[],critical:[],conclusion:'외부 사실은 미확인'};
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
   const next=await sibling(f);assert.equal((await routeApi(request(next.path+'/groq-summary','POST',{}),f.env)).status,409);assert.equal(calls,1);
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
test('50,000 character Korean transcript offers a bounded first window and resumes completed stages in a new window',async()=>{
 const f=await fixture({longSource:true}),old=fetch;let calls=0,reply=response();globalThis.fetch=async()=>{calls++;return reply;};
 try{assert.ok(f.segments.map(x=>x.text).join('').length>50000);assert.ok(f.plan.rawStages>29);assert.equal(f.plan.maxRequests,29);assert.ok(f.plan.totalRequests>29);
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
test('oversized but valid checkpoint is not saved DONE before an impossible merge',async()=>{
 const f=await fixture({large:true}),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return response({...valid(1),summary:[{text:'가'.repeat(800),evidenceIds:[1]}]});};
 try{await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);
  const r=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal((await r.json()).error.code,'SUMMARY_CHECKPOINT_TOO_LARGE');assert.equal(calls,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='groq-summary' AND state='DONE'").get().n,0);
 }finally{globalThis.fetch=old;f.db.close();}
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
