import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {partitionGroqTranscript,promptAudit} from '../src/groq-summary.mjs';
const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);
async function setup(){
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'dispatch-race-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'dispatch-race-test-local'}}]})),DB=await mf.getD1Database('DB');
 for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
 const env={DB,ENABLE_LIVE_FREE:'true',ENABLE_COMPLETE_SYNTHESIS:'true',ALLOW_PAID_API:'false',GROQ_API_KEY:'OFFLINE_TEST_ONLY_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')};
 const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600,title:'Dispatch race fixture'}),env)).json(),id=created.job.id,path='/api/jobs/'+id;
 const segments=Array.from({length:12},(_,i)=>({id:i+1,startMs:i*40000,endMs:(i+1)*40000,text:`발언 ${i+1} ${'가나다라마바사 '.repeat(38)}`})),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)};
 await DB.prepare('UPDATE jobs SET audit_json=? WHERE id=?').bind(JSON.stringify(audit),id).run();await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(id,segments.map(s=>s.text).join('\n'),JSON.stringify(segments),'GROQ_OWNED_AUDIO',new Date().toISOString()).run();
 const plan=await(await routeApi(request(path+'/groq-summary-plan'),env)).json(),groups=partitionGroqTranscript(segments,promptAudit({audit,duration_seconds:600})),stamp=new Date(Date.now()-2*86_400_000).toISOString();
 for(let i=0;i<groups.length;i++){const first=groups[i][0].id,report={summary:[{text:`발언 ${first}`,evidenceIds:[first]}],chapters:[{text:`발언 ${first}`,evidenceIds:[first]}],claims:[],numbers:[],critical:[],conclusion:'발언'};await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").bind(id+':groq-summary:'+plan.transcriptHash+':raw:'+i,id,stamp,JSON.stringify({hash:plan.transcriptHash,key:'raw:'+i,report})).run();}
 const url=path+'/groq-summary-complete',scope=await(await routeApi(request(url),env)).json();assert.equal(scope.ready,true);
 const quote=await(await routeApi(request(url,'POST',{step:'quote',sourceHash:scope.sourceHash,manifestSha256:scope.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),env)).json();
 const approved=await routeApi(request(url,'POST',{step:'approve',quoteId:quote.quoteId,quoteSha256:quote.quoteSha256,reservedUnits:quote.quote.reservedUnits,maxCalls:quote.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}),env);assert.equal(approved.status,200,await approved.clone().text());const approval=await approved.json();
 return {mf,DB,env,url,scope,approval};
}
for(const mode of ['cancel','expire'])test(`synthesis final D1 read blocks ${mode} before mock fetch`,async()=>{
 const f=await setup(),oldFetch=globalThis.fetch,clock=Date.now;let reads=0,calls=0;
 try{
  f.env.DB={prepare(sql){const stmt=f.DB.prepare(sql);if(!sql.startsWith('SELECT 1 AS ok FROM yta_operations a JOIN yta_operations o'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async first(){reads++;if(reads===2&&mode==='cancel'){const cancelled=await routeApi(request(f.url,'POST',{step:'cancel',approvalId:f.approval.approvalId,confirmCancel:true}),f.env);assert.equal(cancelled.status,200,await cancelled.clone().text());assert.equal((await cancelled.json()).claimedRequestOutcome,'UNKNOWN');}const result=await bound.first();if(reads===2&&mode==='expire')Date.now=()=>clock()+700_000;return result;}};}};}};
  globalThis.fetch=async()=>{calls++;throw Error('unexpected provider fetch');};
  const reply=await routeApi(request(f.url,'POST',{step:'execute',approvalId:f.approval.approvalId,expectedNode:f.scope.nextSynthesisStage,requestSha256:f.scope.nextSynthesisRequestSha256,executeOnce:true}),f.env);
  assert.notEqual(reply.status,200);assert.equal(reads,2);assert.equal(calls,0);assert.equal((await f.DB.prepare("SELECT state FROM yta_operations WHERE provider='groq-summary-synthesis'").first()).state,'BLOCKED');
 }finally{globalThis.fetch=oldFetch;Date.now=clock;await f.mf.dispose();}
});
test('synthesis rejects a key replacement between identity check and credential snapshot',async()=>{
 const f=await setup(),oldFetch=globalThis.fetch;let calls=0,rotations=0;
 try{
  f.env.DB={prepare(sql){const stmt=f.DB.prepare(sql);if(sql!=="SELECT cipher_version,iv_b64,ciphertext_b64,updated_at FROM provider_credentials WHERE owner_id='owner' AND provider='groq'")return stmt;return {async first(){rotations++;await f.DB.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','groq',1,'offline-iv','offline-cipher',?)").bind(new Date().toISOString()).run();return stmt.first();}};}};
  globalThis.fetch=async()=>{calls++;throw Error('unexpected provider fetch');};
  const reply=await routeApi(request(f.url,'POST',{step:'execute',approvalId:f.approval.approvalId,expectedNode:f.scope.nextSynthesisStage,requestSha256:f.scope.nextSynthesisRequestSha256,executeOnce:true}),f.env);
  assert.equal(rotations,1);assert.equal(calls,0);assert.equal(reply.status,409,await reply.clone().text());assert.equal((await f.DB.prepare("SELECT state FROM yta_operations WHERE provider='groq-summary-synthesis'").first()).state,'BLOCKED');
 }finally{globalThis.fetch=oldFetch;await f.mf.dispose();}
});
