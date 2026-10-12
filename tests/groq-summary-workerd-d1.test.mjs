import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';

const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);

test('first Groq summary admission executes every SQL binding against local Workerd D1',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'summary-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'summary-test-local'}}]}));
 const oldFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database('DB');
  for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  await assert.rejects(DB.prepare('SELECT ? AS value').bind().first(),/Wrong number of parameter bindings/);
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GROQ_API_KEY:'OFFLINE_TEST_ONLY_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')};
  const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:5892.888,title:'Local D1 summary test'}),env)).json();
  const id=created.job.id,path='/api/jobs/'+id;
  const segments=Array.from({length:1226},(_,i)=>({id:i+1,startMs:Math.round(i*5892888/1226),endMs:Math.round((i+1)*5892888/1226),text:'가나다라마바사아자차'.repeat(4)}));
  const raw=segments.map(segment=>segment.text).join('\n');
  const audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64),audioBoundaryAmbiguities:Array.from({length:14},(_,i)=>({segmentId:2+33*i,chunkIndex:i+1,startMs:0,endMs:1}))};
  await DB.prepare('UPDATE jobs SET duration_seconds=?,audit_json=? WHERE id=?').bind(5892.888,JSON.stringify(audit),id).run();
  await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(id,raw,JSON.stringify(segments),'GROQ_OWNED_AUDIO',new Date().toISOString()).run();
  const plan=await(await routeApi(request(path+'/groq-summary-plan'),env)).json();
  const review=await(await routeApi(request(path+'/groq-summary-approval'),env)).json();
  assert.equal(plan.maxRequests,29);
  const approval={jobId:id,transcriptHash:plan.transcriptHash,model:plan.model,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
  const approved=await routeApi(request(path+'/groq-summary-approval','POST',approval),env);
  assert.equal(approved.status,200,await approved.clone().text());
  let providerCalls=0;
  globalThis.fetch=async()=>{
   providerCalls++;
   const report={summary:[{text:'원문',evidenceIds:[1]}],chapters:[{text:'구간',evidenceIds:[1]}],claims:[],numbers:[],critical:[],conclusion:'원문'};
   return Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'stop',message:{content:JSON.stringify(report)}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390}});
  };
  const first=await routeApi(request(path+'/groq-summary','POST',{}),env);
  assert.equal(first.status,202,await first.clone().text());
  assert.equal((await first.json()).stage,'raw:0');
  assert.equal(providerCalls,1);
  const operations=(await DB.prepare("SELECT state FROM yta_operations WHERE provider='groq-summary' ORDER BY created_at").all()).results;
  assert.deepEqual(operations.map(row=>row.state),['APPROVED','DONE']);
 }finally{globalThis.fetch=oldFetch;await mf.dispose();}
});
