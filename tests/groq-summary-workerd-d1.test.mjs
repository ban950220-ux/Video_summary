import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {promptAudit} from '../src/groq-summary.mjs';
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
