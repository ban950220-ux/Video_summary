import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {routeApi} from '../src/worker.mjs';
import {partitionGroqTranscript,groqInputUpperBound,groqSummaryMessages,groqRawPrompt,GROQ_SUMMARY_INPUT_BOUND} from '../src/groq-summary.mjs';

const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
async function fixture({complete=true,large=false}={}){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0002_live.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){const make=args=>({bind(...a){return make(a);},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:r.changes}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}});return make([]);}};
 const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GROQ_API_KEY:'NOT_REAL_TEST_KEY'};
 const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600,title:'Offline Groq summary'}),env)).json(),id=created.job.id,path='/api/jobs/'+id;
 const segments=Array.from({length:large?25:2},(_,i)=>({id:i+1,startMs:i*(large?24000:300000),endMs:(i+1)*(large?24000:300000),text:`원문 ${i+1} ${large?'가나다라마바사 '.repeat(12):'검증'}`}));
 const raw=segments.map(part=>part.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:complete?1:0,audioFileSha256:'a'.repeat(64),audioSegmentOrigins:large?Array.from({length:500},(_,i)=>({segmentId:i+1,chunkIndex:i,startMs:i*1000,endMs:i*1000+900})):[]};
 db.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').run(id,raw,JSON.stringify(segments),'GROQ_OWNED_AUDIO',new Date().toISOString());
 db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify(audit),id);
 const plan=complete?await(await routeApi(request(path+'/groq-summary-plan'),env)).json():null;
 const approval=plan&&{jobId:id,transcriptHash:plan.transcriptHash,model:plan.model,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
 return {db,env,id,path,plan,approval,segments};
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
test('Groq summary requires complete stored transcript and exact one-time approval without provider call',async()=>{
 const incomplete=await fixture({complete:false});try{assert.equal((await incomplete.db.prepare('SELECT COUNT(*) n FROM yta_operations').get()).n,0);assert.equal((await routeApi(request(incomplete.path+'/groq-summary-plan'),incomplete.env)).status,409);}finally{incomplete.db.close();}
 const f=await fixture(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no provider call');};
 try{assert.equal(f.plan.remainingAccountTokens,'UNKNOWN');assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',{...f.approval,transcriptHash:'b'.repeat(64)}),f.env)).status,400);
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);assert.equal(calls,0);
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,409);
 }finally{globalThis.fetch=old;f.db.close();}
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
  else ids=JSON.parse(prompt.split('시간 순서별 부분 보고서:\n')[1]).flatMap(part=>part.ids);
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
   assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE id=?").get(f.id+':groq-summary:approval').state,'STOPPED');
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
  if(mode==='expired'){const id=f.id+':groq-summary:approval',stored=JSON.parse(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(id).result_json);stored.expiresAt='not-a-time';f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(stored),id);}else f.env.GROQ_API_KEY='OTHER_TEST_ONLY_KEY';
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
  const original=f.env.DB;let changed=false;f.env.DB={...original,prepare(sql){const statement=original.prepare(sql);if(!sql.startsWith('SELECT 1 AS ok FROM yta_operations a JOIN'))return statement;return {bind(...args){const bound=statement.bind(...args);return {...bound,async first(){if(!changed){changed=true;f.db.prepare("UPDATE yta_operations SET state='STOPPED' WHERE id=?").run(f.id+':groq-summary:approval');}return bound.first();}};}};}};
  assert.equal((await routeApi(request(f.path+'/groq-summary','POST',{}),f.env)).status,409);assert.equal(calls,0);
  assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE provider='groq-summary' AND id LIKE ?").get(f.id+':groq-summary:'+f.plan.transcriptHash+':%').state,'BLOCKED');
 }finally{globalThis.fetch=old;f.db.close();}
});
