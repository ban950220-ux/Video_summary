import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {encryptProviderKey} from '../src/vault.mjs';

const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);
const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});

test('first trial quote, atomic D1 claim and mock final save work in local Workerd',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'paid-summary-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'paid-summary-local'}}]}));
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0008_paid_summary_budget.sql','../migrations/0009_paid_first_trial.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const id='33333333-3333-4333-8333-333333333333',path='/api/jobs/'+id,segments=[{id:1,startMs:0,endMs:1000,text:'첫 발언'},{id:2,startMs:1000,endMs:2000,text:'둘째 발언'}],audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
  await DB.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Workerd paid mock','audio','TRANSCRIBED',2,?,?,?,?)").bind(id,new Date().toISOString(),new Date().toISOString(),'null',JSON.stringify(audit)).run();
  await DB.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").bind(id,segments.map(s=>s.text).join('\n'),JSON.stringify(segments),new Date().toISOString()).run();
  const root=Buffer.alloc(32,7),secret=await encryptProviderKey(root,'gemini','WORKERD_TEST_KEY');await DB.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','gemini',?,?,?,?)").bind(secret.version,secret.ivB64,secret.ciphertextB64,new Date().toISOString()).run();
  const env={DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_PAID_SUMMARY:'false',ALLOW_PAID_API:'false'};
  const issued=await(await routeApi(request(path+'/paid-summary-quote','POST'),env)).json();assert.ok(issued.quoteId,JSON.stringify(issued));
  env.ENABLE_PAID_SUMMARY='true';env.ALLOW_PAID_API='false';env.PAID_SUMMARY_EXECUTION_APPROVED='true';env.PAID_FIRST_GENERATION_TRIAL_ENABLED='true';env.PAID_FIRST_TRIAL_USD_COST_REVIEWED='true';
  const approved=await routeApi(request(path+'/paid-summary-approve','POST',{quoteId:issued.quoteId,maxMicroUsd:issued.quote.maxMicroUsd,maxCalls:1,expiresAt:issued.quote.expiresAt,confirmExactQuote:true,confirmNoAutomaticFallback:true,trialKind:'FIRST_GENERATION_UNTESTED',confirmUnknownGeneration:true,confirmExistingPrepayOnly:true,confirmCurrentKeyProject:true}),env);assert.equal(approved.status,200,await approved.clone().text());
  let sends=0;env.PAID_SUMMARY_TEST_RUNNER=async({beforeFetch})=>{await beforeFetch();sends++;return {text:JSON.stringify({summary:[{text:'발언 종합',evidenceIds:[1,2]}],chapters:[{text:'첫 발언',evidenceIds:[1]},{text:'둘째 발언',evidenceIds:[2]}],claims:[],numbers:[],critical:[],conclusion:'발언을 요약했다'}),usage:{promptTokenCount:300,candidatesTokenCount:90,thoughtsTokenCount:20}};};
  const saved=await routeApi(request(path+'/paid-summary-execute','POST',{approvalId:issued.quoteId}),env);assert.equal(saved.status,200,await saved.clone().text());assert.equal(sends,1);
  const row=await DB.prepare('SELECT state,reserved_micro_usd,token_estimate_micro_usd FROM yta_paid_summary_reservations').first();assert.equal(row.state,'SETTLED');assert.equal(row.reserved_micro_usd,issued.quote.maxCallMicroUsd);assert.ok(row.token_estimate_micro_usd>0);
  assert.equal((await DB.prepare('SELECT state FROM yta_paid_first_trial').first()).state,'CONSUMED');
 }finally{await mf.dispose();}
});
