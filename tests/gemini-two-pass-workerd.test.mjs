import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {encryptProviderKey} from '../src/vault.mjs';

const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);
const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
test('two-pass quote, approval, two reservations, receipts and export run on local Workerd D1',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'gemini-two-pass-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'two-pass-local'}}]}));
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0015_gemini_two_pass.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const id='44444444-4444-4444-8444-444444444444',path='/api/jobs/'+id,segments=[{id:1,startMs:0,endMs:1000,text:'첫 발언'},{id:2,startMs:1000,endMs:2000,text:'둘째 발언'}],audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'c'.repeat(64)};
  await DB.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Two pass Workerd','audio','TRANSCRIBED',2,?,?,?,?)").bind(id,new Date().toISOString(),new Date().toISOString(),'null',JSON.stringify(audit)).run();
  await DB.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").bind(id,segments.map(s=>s.text).join('\n'),JSON.stringify(segments),new Date().toISOString()).run();
  const root=Buffer.alloc(32,9),secret=await encryptProviderKey(root,'gemini','OFFLINE_WORKERD_KEY');await DB.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','gemini',?,?,?,?)").bind(secret.version,secret.ivB64,secret.ciphertextB64,new Date().toISOString()).run();
  let sends=0;const report={summary:[{text:'두 발언',evidenceIds:[1,2]}],chapters:[{text:'첫 발언',evidenceIds:[1]},{text:'둘째 발언',evidenceIds:[2]}],claims:[],numbers:[],critical:[],conclusion:'두 발언을 종합했다'};
  const env={DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_GEMINI_TWO_PASS:'true',ENABLE_GEMINI_TWO_PASS_PAID:'true',GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED:'true',ALLOW_PAID_API:'false',PAID_MODEL_ACCESS_VERIFIED:'true',PAID_TAX_MAX_BPS_VERIFIED:'true',GEMINI_TWO_PASS_TEST_PROVIDER:{countTokens:async()=>300,generate:async()=>{sends++;const responseText=JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(sends===1?report:{verdict:'PASS',issues:[]})}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:100,thoughtsTokenCount:10}});return {responseText,responseBytes:new TextEncoder().encode(responseText).length,httpStatus:200,complete:true};}}};
  const issued=await(await routeApi(request(path+'/gemini-two-pass-quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true}),env)).json();assert.equal(issued.state,'QUOTED',JSON.stringify(issued));const q=issued.quote;
  const approved=await routeApi(request(path+'/gemini-two-pass-approve','POST',{quoteSha256:q.quoteSha256,maxMicroUsd:q.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true}),env);assert.equal(approved.status,200,await approved.clone().text());
  for(const phase of [0,1]){const ran=await routeApi(request(path+'/gemini-two-pass-run','POST',{phase,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true}),env);assert.equal(ran.status,200,await ran.clone().text());}
  assert.equal(sends,2);assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM yta_gemini_two_pass_calls WHERE state='SETTLED' AND response_complete=1").first()).n,2);
  assert.equal((await(await routeApi(request(path),env)).json()).job.report.kind,'GEMINI_TWO_PASS_REVIEWED');assert.match(await(await routeApi(request(path+'/export?format=txt'),env)).text(),/첫 발언/);
 }finally{await mf.dispose();}
});
