import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {promptAudit,partitionGroqTranscript,groqInputUpperBound,groqSummaryMessages,groqRawPrompt} from '../src/groq-summary.mjs';
import {capacityIdentity} from '../src/observed-capacity.mjs';
import {groqLiveResolutionProofSql} from '../src/groq-synthesis-execution.mjs';
import {encryptProviderKey} from '../src/vault.mjs';

const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);

test('first Groq summary admission executes every SQL binding against local Workerd D1',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'summary-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'summary-test-local'}}]}));
 const oldFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database('DB');
  for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  assert.equal((await DB.prepare(`SELECT ${groqLiveResolutionProofSql} AS ok`).bind('[]').first()).ok,1);
  await DB.prepare(`INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT json_extract(c.value,'$.failedId')||':live-resolved',j.id,'groq-summary-live-resolution',0,'DONE',?,c.value FROM jobs j CROSS JOIN json_each(?) c WHERE ${groqLiveResolutionProofSql}`).bind(new Date().toISOString(),'[]','[]').run();
  await assert.rejects(DB.prepare('SELECT ? AS value').bind().first(),/Wrong number of parameter bindings/);
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GROQ_API_KEY:'OFFLINE_TEST_ONLY_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')};
  const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:5892.888,title:'Local D1 summary test'}),env)).json();
  const id=created.job.id,path='/api/jobs/'+id;
  const segments=Array.from({length:1226},(_,i)=>({id:i+1,startMs:Math.round(i*5892888/1226),endMs:Math.round((i+1)*5892888/1226),text:'가나다라마바사아자차'.repeat(4)}));
  const raw=segments.map(segment=>segment.text).join('\n');
  const audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64),audioBoundaryAmbiguities:Array.from({length:14},(_,i)=>({segmentId:2+33*i,chunkIndex:i+1,startMs:0,endMs:1}))};
  await DB.prepare('UPDATE jobs SET duration_seconds=?,audit_json=? WHERE id=?').bind(5892.888,JSON.stringify(audit),id).run();
  await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(id,raw,JSON.stringify(segments),'GROQ_OWNED_AUDIO',new Date().toISOString()).run();
  let statusWrites=0;
  const statusEnv={...env,DB:{prepare(sql){if(!/^SELECT\b/i.test(sql.trim())){statusWrites++;throw Error('status must be read only');}return DB.prepare(sql);}}};
  const status=async()=>{const reply=await routeApi(request(path+'/groq-summary-status'),statusEnv);assert.equal(reply.status,200,await reply.clone().text());assert.equal(reply.headers.get('cache-control'),'no-store');const text=await reply.text();assert.ok(!text.includes('credentialGeneration')&&!text.includes('OFFLINE_TEST_ONLY_KEY')&&!text.includes('result_json')&&!text.includes(raw.slice(0,12)));return JSON.parse(text);};
  assert.equal((await status()).approval,null);
  const plan=await(await routeApi(request(path+'/groq-summary-plan'),env)).json();
  const review=await(await routeApi(request(path+'/groq-summary-approval'),env)).json();
  assert.equal(plan.maxRequests,29);
  const approval={jobId:id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};
  const approved=await routeApi(request(path+'/groq-summary-approval','POST',approval),env);
  assert.equal(approved.status,200,await approved.clone().text());
  const approvedStatus=await status();
  assert.equal(approvedStatus.approval.state,'APPROVED');assert.equal(approvedStatus.completedStages,0);assert.equal(approvedStatus.activeStage,null);
  let providerCalls=0,release,started;
  const gate=new Promise(resolve=>release=resolve),providerStarted=new Promise(resolve=>started=resolve);
  globalThis.fetch=async()=>{
   providerCalls++;started();await gate;
   const report={summary:[{text:'원문',evidenceIds:[1]}],chapters:[{text:'구간',evidenceIds:[1]}],claims:[],numbers:[],critical:[],conclusion:'원문'};
   return Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'stop',message:{content:JSON.stringify(report)}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390}});
  };
  const pending=routeApi(request(path+'/groq-summary','POST',{}),env);
  const early=await Promise.race([providerStarted.then(()=>null),pending.then(async reply=>({status:reply.status,body:await reply.clone().text()})),new Promise(resolve=>setTimeout(()=>resolve('provider did not start within five seconds'),5000))]);assert.equal(early,null,JSON.stringify(early));
  const claimed=await status();
  assert.equal(claimed.activeStage.state,'CLAIMED');assert.equal(claimed.activeStage.key,'raw:0');assert.equal(claimed.providerReceiptVerified,false);assert.equal(claimed.completedStages,0);
  release();
  const first=await pending;
  assert.equal(first.status,202,await first.clone().text());
  assert.equal((await first.json()).stage,'raw:0');
  assert.equal(providerCalls,1);
  const saved=await status();
  assert.equal(saved.completedStages,1);assert.equal(saved.lastSavedStage.key,'raw:0');assert.equal(saved.activeStage,null);assert.equal(saved.finalReportSaved,false);assert.equal(statusWrites,0);
  const operations=(await DB.prepare("SELECT state FROM yta_operations WHERE provider='groq-summary' ORDER BY created_at").all()).results;
  assert.deepEqual(operations.map(row=>row.state),['APPROVED','DONE']);
  await DB.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary' AND state='DONE'").bind(new Date(Date.now()-62000).toISOString(),id).run();
  globalThis.fetch=async()=>{providerCalls++;return Response.json({}, {status:429,headers:{'retry-after':'60'}});};
  const limited=await routeApi(request(path+'/groq-summary','POST',{}),env);
  assert.equal(limited.status,409);assert.equal((await limited.json()).error.code,'429');
  const uncertain=await status();
  assert.equal(uncertain.completedStages,1);assert.equal(uncertain.activeStage.state,'FAILED_UNCERTAIN');
  assert.equal(uncertain.activeStage.key,'raw:1');assert.equal(uncertain.approval.state,'STOPPED');
  assert.equal(providerCalls,2);assert.equal(statusWrites,0);
  await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'deletion',0,'DELETING',?)").bind(id+':deleting',id,new Date().toISOString()).run();
  const deleting=await routeApi(request(path+'/groq-summary-status'),statusEnv);
  assert.equal((await deleting.json()).error.code,'NOT_FOUND');
 }finally{globalThis.fetch=oldFetch;await mf.dispose();}
});

test('pilot review, approval and single-call admission execute against Workerd D1',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'pilot-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'pilot-test-local'}}]}));
 const oldFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GROQ_API_KEY:'OFFLINE_TEST_ONLY_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')};
  const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600,title:'Pilot D1'}),env)).json(),id=created.job.id,path='/api/jobs/'+id,segments=[{id:1,startMs:0,endMs:300000,text:'원문 검증'},{id:2,startMs:300000,endMs:600000,text:'원문 검증'}],raw=segments.map(part=>part.text).join('\n');
  const audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
  await DB.prepare('UPDATE jobs SET audit_json=? WHERE id=?').bind(JSON.stringify(audit),id).run();await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(id,raw,JSON.stringify(segments),'GROQ_OWNED_AUDIO',new Date().toISOString()).run();
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([raw,segments,audit.audioFileSha256,promptAudit({audit,duration_seconds:600})]))),oldHash=Buffer.from(bytes).toString('hex'),oldId=id+':groq-summary:'+oldHash+':raw:0',oldResult=JSON.stringify({reviewResult:{partialText:JSON.stringify({summary:'잘못된 형식',chapters:[],claims:[],numbers:[],critical:[],conclusion:'원문'}),usage:{inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220}}});
  await DB.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').bind(id+':groq-summary:approval:0',id,'groq-summary',6600,'STOPPED',new Date().toISOString(),JSON.stringify({jobId:id,sequence:0,transcriptHash:oldHash})).run();
  await DB.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)').bind(oldId,id,'groq-summary',6600,'FAILED_UNCERTAIN',new Date(Date.now()-120000).toISOString(),'SUMMARY_RESPONSE_INVALID',oldResult).run();
  await DB.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2220,0,null,'TEST',new Date().toISOString()).run();
  const url=path+'/groq-summary-pilot',p=await(await routeApi(request(url),env)).json(),body={evidenceHash:p.evidenceHash,oldOperationId:oldId,newOperationId:p.newOperationId,newTranscriptHash:p.newTranscriptHash,model:p.model,credentialGeneration:p.credentialGeneration};
  const reviewed=await routeApi(request(url,'POST',{...body,step:'review',acknowledgeInferredFinishReason:true,acknowledgePreviousUsage:2220,acknowledgeDuplicateUsageRisk:true,acknowledgeChangedRange:true}),env);assert.equal(reviewed.status,200,await reviewed.clone().text());
  const approved=await routeApi(request(url,'POST',{...body,step:'approve',freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,oneCallOnly:true,totalTokenUpperBound:6600}),env);assert.equal(approved.status,200,await approved.clone().text());
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:[{text:'원문 검증',evidenceIds:[1]}],chapters:[{text:'원문',evidenceIds:[1]}],claims:[],numbers:[],critical:[],conclusion:'원문'})}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390}});};
  const first=await routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),env);assert.equal(first.status,202,await first.clone().text());
  const replay=await routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),env);assert.equal(replay.status,409);assert.equal(calls,1);
  assert.deepEqual(await DB.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').bind(oldId).first(),{state:'FAILED_UNCERTAIN',result_json:oldResult});
 }finally{globalThis.fetch=oldFetch;await mf.dispose();}
});

test('pilot final D1 guard blocks concurrent key, deletion, audit and approval changes before provider fetch',async()=>{
 for(const change of ['key','deletion','audit','approval']){
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'pilot-race-'+change,modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'pilot-race-'+change}}]})),oldFetch=globalThis.fetch;
  try{
   const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
   const root=Buffer.alloc(32,7),encrypted=await encryptProviderKey(root,'groq','OFFLINE_STORED_TEST_KEY');
   await DB.prepare('INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES(?,?,?,?,?,?)').bind('owner','groq',encrypted.version,encrypted.ivB64,encrypted.ciphertextB64,new Date().toISOString()).run();
   const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',KEY_ENCRYPTION_KEY_B64:root.toString('base64')};
   const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600,title:'Pilot race'}),env)).json(),id=created.job.id,path='/api/jobs/'+id,segments=[{id:1,startMs:0,endMs:300000,text:'원문 검증'},{id:2,startMs:300000,endMs:600000,text:'원문 검증'}],raw=segments.map(part=>part.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
   await DB.prepare('UPDATE jobs SET audit_json=? WHERE id=?').bind(JSON.stringify(audit),id).run();await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(id,raw,JSON.stringify(segments),'GROQ_OWNED_AUDIO',new Date().toISOString()).run();
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([raw,segments,audit.audioFileSha256,promptAudit({audit,duration_seconds:600})]))),oldHash=Buffer.from(digest).toString('hex'),oldId=id+':groq-summary:'+oldHash+':raw:0',oldResult=JSON.stringify({reviewResult:{partialText:JSON.stringify({summary:'잘못된 형식',chapters:[],claims:[],numbers:[],critical:[],conclusion:'원문'}),usage:{inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220}}});
   await DB.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').bind(id+':groq-summary:approval:0',id,'groq-summary',6600,'STOPPED',new Date().toISOString(),JSON.stringify({jobId:id,sequence:0,transcriptHash:oldHash})).run();
   await DB.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)').bind(oldId,id,'groq-summary',6600,'FAILED_UNCERTAIN',new Date(Date.now()-120000).toISOString(),'SUMMARY_RESPONSE_INVALID',oldResult).run();
   await DB.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2220,0,null,'TEST',new Date().toISOString()).run();
   const url=path+'/groq-summary-pilot',p=await(await routeApi(request(url),env)).json(),body={evidenceHash:p.evidenceHash,oldOperationId:oldId,newOperationId:p.newOperationId,newTranscriptHash:p.newTranscriptHash,model:p.model,credentialGeneration:p.credentialGeneration};
   assert.equal((await routeApi(request(url,'POST',{...body,step:'review',acknowledgeInferredFinishReason:true,acknowledgePreviousUsage:2220,acknowledgeDuplicateUsageRisk:true,acknowledgeChangedRange:true}),env)).status,200,change);
   assert.equal((await routeApi(request(url,'POST',{...body,step:'approve',freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,oneCallOnly:true,totalTokenUpperBound:6600}),env)).status,200,change);
   const mutate=async()=>{
    if(change==='key')await DB.prepare('UPDATE provider_credentials SET updated_at=?,ciphertext_b64=? WHERE owner_id=? AND provider=?').bind(new Date(Date.now()+1000).toISOString(),'ROTATED_CIPHERTEXT','owner','groq').run();
    if(change==='deletion')await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'deletion',0,'DELETING',?)").bind(id+':deleting',id,new Date().toISOString()).run();
    if(change==='audit')await DB.prepare("UPDATE jobs SET audit_json=json_set(audit_json,'$.audioBoundaryReview','CHANGED') WHERE id=?").bind(id).run();
    if(change==='approval')await DB.prepare("UPDATE yta_operations SET state='STOPPED' WHERE id=?").bind(id+':groq-summary-pilot:approval:'+oldHash).run();
   };
   let injected=false,calls=0;
   env.DB={prepare(sql){const stmt=DB.prepare(sql);if(sql.startsWith('SELECT 1 AS ok FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=?'))return {bind(...args){const bound=stmt.bind(...args);return {async first(){if(!injected){injected=true;await mutate();}return bound.first();}}}};return stmt;}};
   globalThis.fetch=async()=>{calls++;throw Error('provider must not be reached');};
   const reply=await routeApi(request(url,'POST',{...body,step:'execute',executeOnce:true}),env);
   assert.equal(injected,true,change);assert.equal(calls,0,change);assert.notEqual(reply.status,202,change);
   assert.equal((await DB.prepare('SELECT state FROM yta_operations WHERE id=?').bind(p.newOperationId).first()).state,'BLOCKED',change);
   assert.deepEqual(await DB.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').bind(oldId).first(),{state:'FAILED_UNCERTAIN',result_json:oldResult},change);
  }finally{globalThis.fetch=oldFetch;await mf.dispose();}
 }
});

test('stored oversized strict checkpoint recovery is atomic on local Workerd D1 and sends no model request',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'checkpoint-recovery-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'checkpoint-recovery-local'}}]})),oldFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GROQ_API_KEY:'OFFLINE_TEST_ONLY_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')};
  const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600,title:'Local checkpoint recovery'}),env)).json(),id=created.job.id,path='/api/jobs/'+id;
  const segments=Array.from({length:25},(_,i)=>({id:i+1,startMs:i*24000,endMs:(i+1)*24000,text:'가'.repeat(23)})),raw=segments.map(part=>part.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
  await DB.prepare('UPDATE jobs SET audit_json=? WHERE id=?').bind(JSON.stringify(audit),id).run();
  await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(id,raw,JSON.stringify(segments),'GROQ_OWNED_AUDIO',new Date().toISOString()).run();
  const plan=await(await routeApi(request(path+'/groq-summary-plan'),env)).json(),report={summary:[{text:'요약',evidenceIds:[1]}],chapters:[{text:'장면'.repeat(900),evidenceIds:[1]}],claims:[],numbers:[],critical:[],conclusion:'결론'};
  const result=JSON.stringify({reviewResult:{partialText:JSON.stringify(report),usage:{inputTokens:1157,outputTokens:1012,reasoningTokens:59,totalTokens:2169}}}),failedId=id+':groq-summary:'+plan.transcriptHash+':raw:0';
  await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,'FAILED_UNCERTAIN',?,?,?)").bind(failedId,id,'groq-summary',6600,new Date().toISOString(),'SUMMARY_CHECKPOINT_TOO_LARGE',result).run();
  await DB.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2169,0,null,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',new Date().toISOString()).run();
  let calls=0;globalThis.fetch=async()=>{calls++;throw Error('model dispatch forbidden');};
  const url=path+'/groq-summary-checkpoint-recovery',preview=await(await routeApi(request(url),env)).json();
  const body={step:'recover',evidenceHash:preview.evidenceHash,failedOperationId:failedId,contractHash:preview.contractHash,responseSha256:preview.responseSha256,acknowledgeOriginalUsage:2169,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true};
  const saved=await routeApi(request(url,'POST',body),env);assert.equal(saved.status,200,await saved.clone().text());assert.equal(calls,0);
  assert.equal((await DB.prepare('SELECT state FROM yta_operations WHERE id=?').bind(failedId).first()).state,'FAILED_UNCERTAIN');
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider='groq-summary-recovery' AND state='DONE'").bind(id).first()).n,1);
  assert.equal((await routeApi(request(url,'POST',body),env)).status,409);
 }finally{globalThis.fetch=oldFetch;await mf.dispose();}
});
test('legacy recovery review seal inserts exactly once on local Workerd D1',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'legacy-recovery-review-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'legacy-recovery-review-local'}}]})),oldFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GROQ_API_KEY:'OFFLINE_TEST_ONLY_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')};
  const id=crypto.randomUUID(),path='/api/jobs/'+id,stamp='2020-01-02T09:00:00.000Z',segments=[{id:1,startMs:0,endMs:300000,text:'source one'},{id:2,startMs:300000,endMs:600000,text:'source two'}];
  const raw=segments.map(item=>item.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
  await DB.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Legacy Workerd review','audio','TRANSCRIBED',600,?,?,?,?)").bind(id,stamp,stamp,'null',JSON.stringify(audit)).run();
  await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(id,raw,JSON.stringify(segments),'GROQ_OWNED_AUDIO',stamp).run();
  const plan=await(await routeApi(request(path+'/groq-summary-plan'),env)).json(),hash=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value)))).toString('hex');
  const oldHash=await hash([raw,segments,audit.audioFileSha256,promptAudit({audit,duration_seconds:600})]),oldId=id+':groq-summary:'+oldHash+':raw:0',failedId=id+':groq-summary:'+plan.transcriptHash+':raw:0';
  const report={summary:[{text:'grounded summary',evidenceIds:[1]}],chapters:[{text:'grounded chapter',evidenceIds:[1]}],claims:[],numbers:[],critical:[],conclusion:'grounded conclusion'};
  const failedResult=JSON.stringify({reviewResult:{partialText:JSON.stringify(report),usage:{inputTokens:300,outputTokens:90,reasoningTokens:10,totalTokens:390}}});
  await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID','{}')").bind(oldId,id,stamp).run();
  await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_CHECKPOINT_TOO_LARGE',?)").bind(failedId,id,stamp,failedResult).run();
  for(const [kind,state] of [['review','REVIEWED'],['approval','APPROVED']])await DB.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').bind(id+':groq-summary-pilot:'+kind+':'+oldHash,id,'groq-summary-pilot-'+kind,0,state,stamp,'{}').run();
  await DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',390,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").bind(crypto.randomUUID(),id,stamp).run();
  let calls=0;globalThis.fetch=async()=>{calls++;throw Error('provider dispatch forbidden');};
  const recoveryUrl=path+'/groq-summary-checkpoint-recovery',preview=await(await routeApi(request(recoveryUrl),env)).json();
  const recovered=await routeApi(request(recoveryUrl,'POST',{step:'recover',evidenceHash:preview.evidenceHash,failedOperationId:failedId,contractHash:plan.transcriptHash,responseSha256:preview.responseSha256,acknowledgeOriginalUsage:390,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}),env);assert.equal(recovered.status,200,await recovered.clone().text());
  const recoveryId=id+':groq-summary-recovery:'+plan.transcriptHash+':raw:0',saved=(await DB.prepare('SELECT result_json FROM yta_operations WHERE id=?').bind(recoveryId).first()).result_json;
  const {evidenceHash,recovered:wasRecovered,recoveryRecordExists,automaticContinuation,providerCalls,usageEventId,usageProvenance,...historicalEvidence}=preview;
  assert.equal(evidenceHash,JSON.parse(saved).evidenceHash);assert.equal(wasRecovered,false);assert.equal(recoveryRecordExists,false);assert.equal(automaticContinuation,false);assert.equal(providerCalls,0);assert.equal(typeof usageEventId,'string');assert.equal(typeof usageProvenance,'string');
  const originalJson=JSON.stringify({...JSON.parse(saved),evidenceHash:await hash(historicalEvidence)});
  await DB.prepare('UPDATE yta_operations SET result_json=?,created_at=? WHERE id=?').bind(originalJson,'2020-01-02T09:01:00.000Z',recoveryId).run();
  const reviewUrl=path+'/groq-summary-recovery-compat-review';assert.equal((await routeApi(request(path+'/groq-summary-status'),env)).status,409);
  env.GROQ_LEGACY_RECOVERY_SCOPE_JSON=JSON.stringify({kind:'GROQ_LEGACY_RECOVERY_COMPAT_V1',jobId:id,ownerId:'owner',stage:'raw:0',recoveryOperationId:recoveryId,failedOperationId:failedId,historicalEvidenceHash:JSON.parse(originalJson).evidenceHash,recoveryCreatedBefore:'2020-01-03T00:00:00.000Z',authorizedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()});
  const approvedScope=env.GROQ_LEGACY_RECOVERY_SCOPE_JSON;
  env.GROQ_LEGACY_RECOVERY_SCOPE_JSON=JSON.stringify({...JSON.parse(approvedScope),recoveryCreatedBefore:'2026-10-13T10:51:47.001Z'});
  assert.equal((await routeApi(request(reviewUrl),env)).status,409,'cutoff after format change must not qualify');
  env.GROQ_LEGACY_RECOVERY_SCOPE_JSON=approvedScope;
  const reviewBody={step:'record-compatibility-review',confirmOriginalRecoveryPreserved:true,confirmHistoricalAndCurrentEvidence:true,confirmNoProviderCall:true,confirmSeparateFreeKeyBinding:true};
  const reviewed=await routeApi(request(reviewUrl,'POST',reviewBody),env);assert.equal(reviewed.status,200,await reviewed.clone().text());
  assert.equal((await routeApi(request(reviewUrl,'POST',reviewBody),env)).status,409);
  assert.equal((await DB.prepare('SELECT result_json FROM yta_operations WHERE id=?').bind(recoveryId).first()).result_json,originalJson);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider='groq-summary-recovery-compat-review'").bind(id).first()).n,1);
  assert.equal((await routeApi(request(path+'/groq-summary-status'),env)).status,200);assert.equal(calls,0);
  env.GROQ_LEGACY_RECOVERY_SCOPE_JSON=JSON.stringify({...JSON.parse(approvedScope),authorizedAt:new Date(Date.now()-500).toISOString(),expiresAt:new Date(Date.now()+7200000).toISOString()});
  assert.equal((await routeApi(request(path+'/groq-summary-status'),env)).status,409,'a renewed authorization period must not reuse the old seal');
  env.GROQ_LEGACY_RECOVERY_SCOPE_JSON=approvedScope;
  const sealId=id+':groq-summary-recovery-compat-review:v1',seal=await DB.prepare('SELECT units,error_code,created_at FROM yta_operations WHERE id=?').bind(sealId).first();
  for(const [column,changed] of [['units',1],['error_code','DRIFT'],['created_at','2020-01-04T00:00:00.000Z']]){
   await DB.prepare(`UPDATE yta_operations SET ${column}=? WHERE id=?`).bind(changed,sealId).run();
   assert.equal((await routeApi(request(path+'/groq-summary-status'),env)).status,409,column);
   await DB.prepare(`UPDATE yta_operations SET ${column}=? WHERE id=?`).bind(seal[column],sealId).run();
  }
  assert.equal((await routeApi(request(path+'/groq-summary-status'),env)).status,200);assert.equal(calls,0);
 }finally{globalThis.fetch=oldFetch;await mf.dispose();}
});

test('live recovered failure proof is checked within final Workerd D1 dispatch statement',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'summary-live-proof-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'summary-live-proof-local'}}]})),oldFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GROQ_API_KEY:'OFFLINE_TEST_ONLY_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')};
  const segments=Array.from({length:25},(_,i)=>({id:i+1,startMs:i*24000,endMs:(i+1)*24000,text:'가'.repeat(350)})),raw=segments.map(segment=>segment.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
  const makeJob=async()=>{const id=(await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600,title:'Live proof test'}),env)).json()).job.id,path='/api/jobs/'+id;await DB.prepare('UPDATE jobs SET audit_json=? WHERE id=?').bind(JSON.stringify(audit),id).run();await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(id,raw,JSON.stringify(segments),'GROQ_OWNED_AUDIO',new Date().toISOString()).run();return {id,path};};
  const a=await makeJob(),aPlan=await(await routeApi(request(a.path+'/groq-summary-plan'),env)).json(),failedId=a.id+':groq-summary:'+aPlan.transcriptHash+':raw:0',stamp=new Date(Date.now()-2*86_400_000).toISOString();
  await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_CHECKPOINT_TOO_LARGE',?)").bind(failedId,a.id,stamp,JSON.stringify({reviewResult:{partialText:JSON.stringify({summary:[{text:'가',evidenceIds:[1]}],chapters:[{text:'가',evidenceIds:[1]}],claims:[],numbers:[],critical:[],conclusion:'가'}),usage:{inputTokens:300,outputTokens:90,reasoningTokens:10,totalTokens:390}}})).run();
  await DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',390,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").bind(a.id+':usage',a.id,stamp).run();
  const recoveryUrl=a.path+'/groq-summary-checkpoint-recovery',proof=await(await routeApi(request(recoveryUrl),env)).json();assert.equal(proof.failedOperationId,failedId);const restored=await routeApi(request(recoveryUrl,'POST',{step:'recover',evidenceHash:proof.evidenceHash,failedOperationId:failedId,contractHash:aPlan.transcriptHash,responseSha256:proof.responseSha256,acknowledgeOriginalUsage:390,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}),env);assert.equal(restored.status,200,await restored.clone().text());
  const b=await makeJob(),plan=await(await routeApi(request(b.path+'/groq-summary-plan'),env)).json(),reviewReply=await routeApi(request(b.path+'/groq-summary-approval'),env);assert.equal(reviewReply.status,200,await reviewReply.clone().text());const review=await reviewReply.json();
  const approval={jobId:b.id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};assert.equal((await routeApi(request(b.path+'/groq-summary-approval','POST',approval),env)).status,200);
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:[{text:'가',evidenceIds:[1]}],chapters:[{text:'가',evidenceIds:[1]}],claims:[],numbers:[],critical:[],conclusion:'가'})}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390}});};
  const sent=await routeApi(request(b.path+'/groq-summary','POST',{}),env);assert.equal(sent.status,202,await sent.clone().text());assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;await mf.dispose();}
});

test('raw:8 corrective admission, budget and final guard execute on Workerd D1',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'correction-d1-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'correction-d1-local'}}]})),oldFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GROQ_API_KEY:'OFFLINE_TEST_ONLY_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')},id=(await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600,title:'Corrective D1'}),env)).json()).job.id,path='/api/jobs/'+id;
  const segments=Array.from({length:25},(_,i)=>({id:i+1,startMs:i*24000,endMs:(i+1)*24000,text:'가'.repeat(350)})),raw=segments.map(part=>part.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
  await DB.prepare('UPDATE jobs SET audit_json=? WHERE id=?').bind(JSON.stringify(audit),id).run();await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(id,raw,JSON.stringify(segments),'GROQ_OWNED_AUDIO',new Date().toISOString()).run();
  const plan=await(await routeApi(request(path+'/groq-summary-plan'),env)).json(),hash=plan.transcriptHash,groups=partitionGroqTranscript(segments,promptAudit({audit,duration_seconds:600})),group=groups[8],identity=await capacityIdentity(env,'groq'),stamp=new Date(Date.now()-120000).toISOString(),failedId=id+':groq-summary:'+hash+':raw:8',oldUnits=groqInputUpperBound(groqSummaryMessages(groqRawPrompt(group,promptAudit({audit,duration_seconds:600}))))+1800,oldResult=JSON.stringify({reviewResult:{partialText:JSON.stringify({summary:[{text:'근거 없는 999원',evidenceIds:[group[0].id]}],chapters:[{text:'원문',evidenceIds:[group[0].id]}],claims:[],numbers:[],critical:[],conclusion:'원문'}),usage:{inputTokens:1152,outputTokens:987,reasoningTokens:50,totalTokens:2139}}});
  const review=await(await routeApi(request(path+'/groq-summary-approval'),env)).json(),scope={jobId:id,transcriptHash:hash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true,sequence:0,keyIdentity:identity};
  await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'STOPPED',?,?)").bind(id+':groq-summary:approval:0',id,stamp,JSON.stringify(scope)).run();await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',?,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").bind(failedId,id,oldUnits,stamp,oldResult).run();await DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2139,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").bind(crypto.randomUUID(),id,stamp).run();
  const url=path+'/groq-summary-correction',quoteReply=await routeApi(request(url,'POST',{step:'quote'}),env);assert.equal(quoteReply.status,200,await quoteReply.clone().text());const quote=await quoteReply.json(),approved=await routeApi(request(url,'POST',{step:'approve',quoteId:quote.quoteId,quoteSha256:quote.contract.quoteSha256,reservedUnits:quote.contract.reservedUnits,maxCalls:1,confirmExactQuote:true,confirmPriorUsagePreserved:true,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,noAutomaticRetry:true}),env);assert.equal(approved.status,200,await approved.clone().text());const approval=await approved.json();
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:[{text:'가',evidenceIds:[group[0].id]}],chapters:[{text:'가',evidenceIds:[group[0].id]}],claims:[],numbers:[],critical:[],conclusion:'가'})}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390}});};
  const sent=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),env);assert.equal(sent.status,202,await sent.clone().text());assert.equal(calls,1);assert.equal((await DB.prepare('SELECT state FROM yta_operations WHERE id=?').bind(approval.attemptId).first()).state,'DONE');
 }finally{globalThis.fetch=oldFetch;await mf.dispose();}
});
