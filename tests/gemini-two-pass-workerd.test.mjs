import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {encryptProviderKey} from '../src/vault.mjs';
import {TWO_PASS_MODEL} from '../src/gemini-two-pass-contract.mjs';
import {sourceSnapshot,summaryRequest,sha} from '../src/gemini-two-pass-contract.mjs';
import {capacityIdentity} from '../src/observed-capacity.mjs';
import {promptAudit} from '../src/groq-summary.mjs';

const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);
const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});

test('legacy one-quote recovery uses local Workerd D1 and never authorizes generation',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'legacy-quote-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'legacy-quote-local'}}]}));
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0015_gemini_two_pass.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const id='a69c6a73-6aa6-4ccb-a912-1fab0c35d6a9',segments=[{id:1,startMs:0,endMs:1000,text:'offline fixture'}],raw=segments[0].text,audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'d'.repeat(64)},stamp=new Date().toISOString();
  await DB.prepare("INSERT INTO jobs(id,owner_id,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','audio','TRANSCRIBED',1,?,?,'null',?)").bind(id,stamp,stamp,JSON.stringify(audit)).run();
  await DB.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").bind(id,raw,JSON.stringify(segments),stamp).run();
  const root=Buffer.alloc(32,9),secret=await encryptProviderKey(root,'gemini','OFFLINE_KEY');await DB.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','gemini',?,?,?,?)").bind(secret.version,secret.ivB64,secret.ciphertextB64,stamp).run();
  let models=0,counts=0,generations=0;
  const env={DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_GEMINI_TWO_PASS:'true',GEMINI_TWO_PASS_ALLOWED_JOB_ID:id,ALLOW_PAID_API:'false',GEMINI_TWO_PASS_TEST_PROVIDER:{getModel:async()=>{models++;return {name:`models/${TWO_PASS_MODEL}`,supportedGenerationMethods:['generateContent'],inputTokenLimit:1_048_576,outputTokenLimit:65_536};},countTokens:async()=>{counts++;return 300;},generate:async()=>{generations++;throw Error('forbidden');}}};
  const source={raw,segments,provenance:'GROQ_OWNED_AUDIO'},prompt=promptAudit({duration_seconds:1,audit}),legacyEvidence={offlineFixture:true,residualUncertainty:'SAMPLED_LOGS_CANNOT_EXCLUDE_OTHER_REQUESTS'};
  env.GEMINI_LEGACY_QUOTE_RECOVERY_JSON=JSON.stringify({kind:'LEGACY_UNCERTAIN_NEW_QUOTE_ONCE_V1',approvalId:'Sentinel_48e6e35a627081918873a47c108571dd',ownerId:'owner',jobId:id,model:TWO_PASS_MODEL,projectMode:'PAID_APPROVED',maxMetadataCalls:1,maxCountCalls:1,maxGenerationCalls:0,maxRetries:0,countTokensNoChargeVerified:true,countTokensMaxMicroUsd:0,countTokensBillingEvidence:'OFFLINE_MOCK_ONLY',residualUncertaintyAccepted:true,confirmFullTranscriptSentToGoogleForTokenCount:true,approvedAt:Date.now()-1,expiresAt:Date.now()+600000,sourceSha256:await sha(JSON.stringify([sourceSnapshot(source),source.provenance,audit.audioFileSha256])),auditSha256:await sha(JSON.stringify(prompt)),firstRequestSha256:await sha(JSON.stringify(summaryRequest(source,prompt))),credentialGeneration:await capacityIdentity(env,'gemini'),legacyEvidence,legacyEvidenceSha256:await sha(JSON.stringify(legacyEvidence))});
  const path='/api/jobs/'+id+'/gemini-two-pass-',body={projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true};
  const first=await routeApi(request(path+'quote','POST',body),env);assert.equal(first.status,200,await first.clone().text());
  const attempt=await DB.prepare("SELECT state,result_json FROM yta_operations WHERE provider='gemini-two-pass-quote'").first();assert.equal(attempt.state,'QUOTE_SAVED');assert.ok(JSON.parse(attempt.result_json).recoveryApproval);
  assert.equal((await routeApi(request(path+'quote','POST',body),env)).status,409);assert.equal(models,1);assert.equal(counts,1);assert.equal(generations,0);
  assert.equal((await DB.prepare('SELECT state FROM yta_gemini_two_pass_jobs').first()).state,'QUOTED');assert.equal((await DB.prepare('SELECT count(*) n FROM yta_gemini_two_pass_calls').first()).n,0);
 }finally{await mf.dispose();}
});
test('two-pass quote, approval, two reservations, receipts and export run on local Workerd D1',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'gemini-two-pass-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'two-pass-local'}}]}));
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0015_gemini_two_pass.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const id='44444444-4444-4444-8444-444444444444',path='/api/jobs/'+id,segments=[{id:1,startMs:0,endMs:1000,text:'첫 발언'},{id:2,startMs:1000,endMs:2000,text:'둘째 발언'}],audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'c'.repeat(64)};
  await DB.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Two pass Workerd','audio','TRANSCRIBED',2,?,?,?,?)").bind(id,new Date().toISOString(),new Date().toISOString(),'null',JSON.stringify(audit)).run();
  await DB.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").bind(id,segments.map(s=>s.text).join('\n'),JSON.stringify(segments),new Date().toISOString()).run();
  const root=Buffer.alloc(32,9),secret=await encryptProviderKey(root,'gemini','OFFLINE_WORKERD_KEY');await DB.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','gemini',?,?,?,?)").bind(secret.version,secret.ivB64,secret.ciphertextB64,new Date().toISOString()).run();
  let sends=0;const report={summary:[{text:'두 발언',evidenceIds:[1,2]}],chapters:[{windowKey:'w000',kind:'CONTENT',text:'첫 발언'+' '+'둘째 발언',evidenceIds:[1,2]}],claims:[],numbers:[],critical:[],conclusion:'두 발언을 종합했다'};
  const env={DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_GEMINI_TWO_PASS:'true',ENABLE_GEMINI_TWO_PASS_PAID:'true',GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED:'true',GEMINI_TWO_PASS_ALLOWED_JOB_ID:id,ALLOW_PAID_API:'false',GEMINI_TWO_PASS_COST_BUFFER_APPROVED:'true',GEMINI_TWO_PASS_TEST_PROVIDER:{getModel:async()=>({name:`models/${TWO_PASS_MODEL}`,supportedGenerationMethods:['generateContent','countTokens'],inputTokenLimit:1_048_576,outputTokenLimit:65_536}),countTokens:async()=>300,generate:async()=>{sends++;const responseText=JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(sends===1?report:{verdict:'PASS',issues:[]})}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:100,thoughtsTokenCount:10}});return {responseText,responseBytes:new TextEncoder().encode(responseText).length,httpStatus:200,complete:true};}}};
  const issued=await(await routeApi(request(path+'/gemini-two-pass-quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true}),env)).json();assert.equal(issued.state,'QUOTED',JSON.stringify(issued));const q=issued.quote;
  assert.equal((await DB.prepare("SELECT state FROM yta_operations WHERE id=? AND provider='gemini-two-pass-quote'").bind(id+':gemini-two-pass-quote').first()).state,'QUOTE_SAVED');
  const approved=await routeApi(request(path+'/gemini-two-pass-approve','POST',{quoteSha256:q.quoteSha256,maxMicroUsd:q.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true}),env);assert.equal(approved.status,200,await approved.clone().text());
  for(const phase of [0,1]){const ran=await routeApi(request(path+'/gemini-two-pass-run','POST',{phase,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true}),env);assert.equal(ran.status,200,await ran.clone().text());}
  assert.equal(sends,2);assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM yta_gemini_two_pass_calls WHERE state='SETTLED' AND response_complete=1").first()).n,2);
  const publicJob=(await(await routeApi(request(path),env)).json()).job;assert.equal(publicJob.report,null);assert.equal(publicJob.status,'TRANSCRIBED');const status=(await(await routeApi(request(path+'/gemini-two-pass-status'),env)).json());assert.equal(status.reviewStage,'REVIEW_REQUIRED');assert.equal(status.meaningReview,'SOURCE_REVIEW_REQUIRED');
 }finally{await mf.dispose();}
});
