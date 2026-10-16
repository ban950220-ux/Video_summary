import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {routeApi} from '../src/worker.mjs';
import {handleSiteRequest} from '../src/site-worker.mjs';
import {partitionGroqTranscript,groqInputUpperBound,groqSummaryMessages,groqRawPrompt,groqMergePrompt,promptAudit,GROQ_SUMMARY_INPUT_BOUND,globallyRecoveredGroq} from '../src/groq-summary.mjs';
import {reportPrompt} from '../src/report.mjs';
import {encryptProviderKey} from '../src/vault.mjs';
import {capacityIdentity} from '../src/observed-capacity.mjs';
import {mergeAudioSegments} from '../src/audio.mjs';
import {GROQ_SUMMARY_RESPONSE_FORMAT,groqSummaryRequestBody} from '../src/groq-summary-contract.mjs';
import {validateAnalysis,markdownReport} from '../src/report.mjs';
import {assertGrounding} from '../src/groq-summary.mjs';
import {completeCoverageManifest,evidenceNotes,synthesisTreeProgress,persistedSynthesisNode} from '../src/groq-complete-synthesis.mjs';

const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});

test('recovery diagnostic is owner-scoped, GET-only, bounded, and cannot approve or mutate checkpoints',async()=>{
 const f=await fixture(),originalFetch=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;throw Error('forbidden provider call');};
  const path=f.path+'/groq-summary-recovery-diagnostic';const none=await(await routeApi(request(path),f.env)).json();assert.equal(none.inspectedRecords,0);assert.equal(none.executionAllowed,false);
  const state='DONE';for(let i=0;i<5;i++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary-recovery',0,?,?,?)").run(f.id+':groq-summary-recovery:'+'0'.repeat(64)+':raw:'+i,f.id,state,new Date().toISOString(),JSON.stringify({private:'DO_NOT_LEAK_RECOVERY',report:{summary:[{text:'PRIVATE_REPORT_TEXT'}]}}));
  const before=f.db.prepare('SELECT total_changes() n').get().n,response=await routeApi(request(path),f.env),text=await response.text(),data=JSON.parse(text);assert.equal(response.status,200);assert.equal(data.inspectedRecords,3);assert.equal(data.omittedRecords,2);assert.equal(data.storedRecoveryCounts[0].count,5);assert.ok(data.records.every(row=>row.reason==='CONTRACT_HASH_CHANGED'));assert.equal(data.checkpointCountsVerified,false);assert.equal(data.remainingWork,'UNKNOWN_UNTIL_RECOVERY_SCOPE_IS_VALIDATED');assert.doesNotMatch(text,/DO_NOT_LEAK_RECOVERY|PRIVATE_REPORT_TEXT|private/);
  assert.equal((await routeApi(request(path,'POST',{}),f.env)).status,405);assert.equal((await routeApi(request('/api/jobs/99999999-9999-4999-8999-999999999999/groq-summary-recovery-diagnostic'),f.env)).status,404);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch;f.db.close();}
});
test('recovery metadata SQL stays SELECT-only and returns no IDs, hashes, report or credential material',async()=>{
 const f=await fixture();try{
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary-recovery',0,'DONE',?,?)").run(f.id+':diagnostic-fixture',f.id,new Date().toISOString(),JSON.stringify({sourceSha256:'a'.repeat(64),auditSha256:'PRIVATE_AUDIT',report:{summary:'PRIVATE_REPORT_TEXT'},private:'PRIVATE_RESULT'}));
  f.db.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','groq',1,'PRIVATE_IV','PRIVATE_CIPHER',?)").run(new Date().toISOString());
  const sql=readFileSync(new URL('../tools/groq-recovery-metadata.sql',import.meta.url),'utf8').replaceAll('a69c6a73-6aa6-4ccb-a912-1fab0c35d6a9',f.id),boundary=sql.indexOf('-- Registration does not');f.db.exec('PRAGMA query_only=ON');
  const records=f.db.prepare(sql.slice(0,boundary)).all(),registration=f.db.prepare(sql.slice(boundary)).all();assert.equal(records[0].recovery_row_number,1);assert.equal(records[0].state,'DONE');assert.equal(records[0].valid_source_hash_shape,1);assert.equal(records[0].valid_audit_hash_shape,0);assert.equal(registration[0].groq_key_registered,1);assert.equal(registration[0].project_binding_evidence,'ORG_PROJECT_MAPPING_NOT_STORED');assert.doesNotMatch(JSON.stringify({records,registration}),/PRIVATE_|[a-f0-9]{64}|diagnostic-fixture|recovery_operation_id|recorded_source_hash/);
 }finally{f.db.close();}
});
async function fixture({complete=true,large=false,sourceText=null,segmentText=null,longSource=false,fullScale=false}={}){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0002_live.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){const make=args=>({bind(...a){return make(a);},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:r.changes}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}});return make([]);}};
 const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GROQ_API_KEY:'NOT_REAL_TEST_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')};
 const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:fullScale?5892.864:longSource?6000:600,title:'Offline Groq summary'}),env)).json(),id=created.job.id,path='/api/jobs/'+id;
 const count=fullScale?1226:longSource?125:large?25:2,span=fullScale?5892864/count:longSource?48000:large?24000:300000;
 const segments=Array.from({length:count},(_,i)=>({id:i+1,startMs:Math.floor(i*span),endMs:Math.floor((i+1)*span),text:segmentText?segmentText(i+1):sourceText??`원문 ${i+1} ${longSource?'가나다라마바사아자차카타파하 '.repeat(28):large?'가나다라마바사 '.repeat(12):'검증'}`}));
 const raw=segments.map(part=>part.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:complete?1:0,audioFileSha256:'a'.repeat(64),audioSegmentOrigins:large&&!fullScale?Array.from({length:500},(_,i)=>({segmentId:i+1,chunkIndex:i,startMs:i*1000,endMs:i*1000+900})):[],...(fullScale?{audioBoundaryAmbiguities:Array.from({length:47},(_,i)=>({segmentId:2+i*25,chunkIndex:i+1,startMs:0,endMs:1}))}:{})};
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
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
const response=(body=valid(1),extra={})=>Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'stop',message:{content:JSON.stringify(body)}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390,completion_tokens_details:{reasoning_tokens:10}},...extra});
async function approvedCorrectionFixture({storedCredential=false,segmentText=null,fullScale=false}={}){
 const f=await fixture({large:true,fullScale,sourceText:fullScale?null:'가'.repeat(350),segmentText:fullScale?(segmentText??(id=>{const stem=[`주장 ${id}: ${id}% 늘었다`,`반례 ${id}: ${id}건은 줄었다`,`부정 ${id}: 증가하지 않았다`,`불확실 ${id}: 그럴 수 있다`][id%4];return stem.padEnd(36,'가')+' '+id;})):segmentText}),row=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(row.audit_json),groups=partitionGroqTranscript(f.segments,promptAudit({audit,duration_seconds:row.duration_seconds})),group=groups[8],hash=f.plan.transcriptHash,stamp=new Date(Date.now()-120000).toISOString();
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
async function reviewedGapFixture(options={}){
 const setup=await approvedCorrectionFixture(options),{f,group,approval,quote}=setup;
 const job=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),groups=partitionGroqTranscript(f.segments,promptAudit({audit:JSON.parse(job.audit_json),duration_seconds:job.duration_seconds})),stamp=new Date(Date.now()-120_000).toISOString();
 assert.ok(groups.length>9);
 for(let i=0;i<8;i++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(f.id+':groq-summary:'+f.plan.transcriptHash+':raw:'+i,f.id,stamp,JSON.stringify({hash:f.plan.transcriptHash,key:'raw:'+i,report:valid(groups[i][0].id)}));
 const correction=JSON.stringify({...valid(group[0].id),summary:[{text:'원문에 없는 2024년',evidenceIds:[group[0].id]}]}),correctionResult=JSON.stringify({reviewResult:{partialText:correction,usage:{inputTokens:1130,outputTokens:1576,reasoningTokens:53,totalTokens:2706}},safeRateLimit:null});
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',?,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(approval.attemptId,f.id,quote.contract.reservedUnits,stamp,correctionResult);
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2706,0,NULL,'PROVIDER_REPORTED_CORRECTIVE_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),f.id,stamp);
 return {...setup,groups,correctionResult};
}
async function seedDeletedOversizeRecovery(f,{deleteAfter=true}={}){
 const a=await sibling(f,{approve:false}),plan=await(await routeApi(request(a.path+'/groq-summary-plan'),f.env)).json(),stamp=new Date(Date.now()-2*86_400_000).toISOString(),failedId=a.id+':groq-summary:'+plan.transcriptHash+':raw:0';
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_CHECKPOINT_TOO_LARGE',?)").run(failedId,a.id,stamp,JSON.stringify({reviewResult:{partialText:JSON.stringify(valid(f.segments[0].id)),usage:{inputTokens:300,outputTokens:90,reasoningTokens:10,totalTokens:390}}}));
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',390,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(a.id+':usage',a.id,stamp);
 const url=a.path+'/groq-summary-checkpoint-recovery',proof=await(await routeApi(request(url),f.env)).json();assert.equal(proof.failedOperationId,failedId);const restored=await routeApi(request(url,'POST',{step:'recover',evidenceHash:proof.evidenceHash,failedOperationId:failedId,contractHash:plan.transcriptHash,responseSha256:proof.responseSha256,acknowledgeOriginalUsage:390,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}),f.env);assert.equal(restored.status,200,await restored.clone().text());
 if(deleteAfter){const deleted=await routeApi(request(a.path,'DELETE'),f.env);assert.equal(deleted.status,200,await deleted.clone().text());assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider='groq-summary-settlement'").get(a.id).n,1);}
 return a;
}

test('full-scale synthetic source partitions 1,226 distinct claims and 47 boundaries into 79 raw stages',async()=>{
 const {f,groups}=await reviewedGapFixture({fullScale:true});assert.equal(f.segments.length,1226);assert.equal(groups.length,79);assert.equal(f.segments.at(-1).endMs,5892864);assert.equal(new Set(f.segments.map(item=>item.text)).size,1226);assert.equal(JSON.parse(f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(f.id).audit_json).audioBoundaryAmbiguities.length,47);f.db.close();
});

test('1,226/79 synthetic full handler completes raw recovery, every synthesis node, save and TXT within 50 D1 queries per request',async t=>{
 const {f,groups}=await reviewedGapFixture({fullScale:true}),id=f.id,hash=f.plan.transcriptHash,stamp=new Date(Date.now()-2*86_400_000).toISOString(),completeUrl=f.path+'/groq-summary-complete',gapUrl=f.path+'/groq-summary-gap';
 assert.equal(groups.length,79);f.env.ENABLE_COMPLETE_SYNTHESIS='true';
 const raw9Id=id+':groq-summary:'+hash+':raw:9';f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(raw9Id,id,stamp,JSON.stringify({reviewResult:{partialText:JSON.stringify({...valid(groups[9][0].id),summary:[{text:'원문에 없는 2022년',evidenceIds:[groups[9][0].id]}]}),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:null,totalTokens:2078}}}));
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2078,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),id,stamp);
 const raw0Id=id+':groq-summary:'+hash+':raw:0';f.db.prepare("UPDATE yta_operations SET state='FAILED_UNCERTAIN',error_code='SUMMARY_CHECKPOINT_TOO_LARGE',result_json=? WHERE id=?").run(JSON.stringify({reviewResult:{partialText:JSON.stringify(valid(groups[0][0].id)),usage:{inputTokens:300,outputTokens:91,reasoningTokens:10,totalTokens:391}}}),raw0Id);
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',391,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),id,stamp);
 const storedSource=f.db.prepare('SELECT raw FROM yta_sources WHERE job_id=?').get(id),storedAudit=JSON.parse(f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(id).audit_json),legacyHash=await digest([storedSource.raw,f.segments,storedAudit.audioFileSha256,promptAudit({audit:storedAudit,duration_seconds:5892.864})]);
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(id+':groq-summary:'+legacyHash+':raw:0',id,stamp,JSON.stringify({reviewResult:{partialText:'{"summary":"old schema"}',usage:{inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220}}}));
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2220,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),id,stamp);
 for(const [kind,state] of [['review','REVIEWED'],['approval','APPROVED']])f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(id+':groq-summary-pilot:'+kind+':'+legacyHash,id,'groq-summary-pilot-'+kind,0,state,stamp,'{}');
 const base=f.env.DB;let queries=0,maxQueries=0,injectRaw=false,injectedRaw=0,injectUsage=false,injectedUsage=0,injectSynthesis=false,injectedSynthesis=0,synthesisFailureHandled=false,injectRecoveryProofRace=false,recoveryProofRaceApplied=false,budgetExceeded=false;const maxByAction=new Map(),sqlCounts=new Map(),rawFailureQueries=[];let synthesisFailureQueries=null;f.env.DB={prepare(sql){assert.ok(Buffer.byteLength(sql)<=100000,'D1 statement too long');const track=()=>{queries++;if(queries>50){budgetExceeded=true;throw Error('D1_QUERY_LIMIT_51');}sqlCounts.set(sql,(sqlCounts.get(sql)||0)+1);};const make=stmt=>({bind(...args){assert.ok(args.length<=100,'D1 bind limit exceeded');return make(stmt.bind(...args));},async first(){track();return stmt.first();},async all(){track();return stmt.all();},async run(){track();if(injectRecoveryProofRace&&sql.includes("'groq-summary-synthesis',?,'CLAIMED'")){injectRecoveryProofRace=false;recoveryProofRaceApplied=true;f.db.prepare("UPDATE yta_operations SET state='STOPPED' WHERE provider='groq-summary-synthesis-recovery'").run();}if(injectUsage&&sql.startsWith('INSERT INTO usage_events')){injectUsage=false;injectedUsage++;throw Error('SIMULATED_USAGE_INSERT_BEFORE_COMMIT');}if(injectRaw&&sql.startsWith('UPDATE yta_operations SET state=?,result_json=?,created_at=? WHERE id=? AND state=? AND EXISTS')){injectRaw=false;injectedRaw++;throw Error('SIMULATED_RAW_CHECKPOINT_WRITE_FAILURE');}if(injectSynthesis&&sql.startsWith("UPDATE yta_operations SET state='DONE',result_json=?")){injectSynthesis=false;injectedSynthesis++;throw Error('SIMULATED_SYNTHESIS_CHECKPOINT_WRITE_FAILURE');}return stmt.run();}});return make(base.prepare(sql));}};
 const routed=async req=>{queries=0;budgetExceeded=false;sqlCounts.clear();const body=req.method==='POST'?await req.clone().json():null,action=`${req.method} ${new URL(req.url).pathname.split('/').at(-1)}${body?.step?' '+body.step:''}`;const reply=await routeApi(req,f.env);maxQueries=Math.max(maxQueries,queries);maxByAction.set(action,Math.max(maxByAction.get(action)||0,queries));assert.equal(budgetExceeded,false,`D1 query limit exceeded: ${queries} ${action}`);return reply;};
 const oldFetch=globalThis.fetch;let providerCalls=0,rawCalls=0,synthesisCalls=0,approvalWindows=0;
 try{
  globalThis.fetch=async()=>{providerCalls++;throw Error('mock response must be explicitly selected');};
  const raw0RecoveryUrl=f.path+'/groq-summary-checkpoint-recovery',raw0Review=await(await routed(request(raw0RecoveryUrl))).json();assert.equal(raw0Review.failedOperationId,raw0Id);const raw0Saved=await routed(request(raw0RecoveryUrl,'POST',{step:'recover',evidenceHash:raw0Review.evidenceHash,failedOperationId:raw0Id,contractHash:hash,responseSha256:raw0Review.responseSha256,acknowledgeOriginalUsage:391,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}));assert.equal(raw0Saved.status,200,await raw0Saved.clone().text());assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(raw0Id).state,'FAILED_UNCERTAIN');
  for(const index of [8,9]){const stage='raw:'+index,review=await(await routed(request(completeUrl+'?stage='+stage))).json();assert.equal((await routed(request(completeUrl,'POST',{step:'register-excerpt',stage,sourceHash:hash,auditSha256:review.auditSha256,recordSha256:review.recordSha256,selectedIds:review.selectedIds,confirmExactSourceExcerpt:true,confirmNotAiSummary:true,confirmPriorFailureAndUsagePreserved:true}))).status,200);const usageReview=await(await routed(request(completeUrl+'?stage='+stage))).json(),disposition=usageReview.disposition;assert.equal((await routed(request(completeUrl,'POST',{step:'review-failure-usage',stage,sourceHash:hash,auditSha256:disposition.auditSha256,recordSha256:disposition.recordSha256,confirmSeparateFromContent:true,acknowledgeReceiptNotVerified:true,acknowledgeAccountBalanceUnknown:true,acknowledgeConservativeReservation:true,noRetry:true}))).status,200);}
  const interim=await(await routed(request(f.path+'/groq-summary-gap-bundle'))).json();assert.equal(interim.sourceCheckpointCount,8);assert.equal(interim.separatelyReviewedRanges[0].stage,'raw:9');assert.equal(interim.separatelyReviewedRanges[0].includedInRawCheckpointBundle,false);
  const interimTxt=await(await routed(request(f.path+'/groq-summary-gap-bundle?format=txt'))).text();assert.match(interimTxt,/별도 검토·이 묶음에서 제외: raw:9/);
  for(let index=10;index<79;index++){
   if(index===11){const active=f.db.prepare("SELECT id,result_json FROM yta_operations WHERE provider='groq-summary' AND state='APPROVED' ORDER BY created_at DESC LIMIT 1").get(),expired={...JSON.parse(active.result_json),expiresAt:Date.now()-1};f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(expired),active.id);const denied=await routed(request(gapUrl,'POST',{step:'execute',transcriptHash:hash,expectedStage:'raw:11',executeOnce:true}));assert.equal(denied.status,409);}
   const preview=await routed(request(gapUrl));assert.equal(preview.status,200,await preview.clone().text());const scope=await preview.json();assert.equal(scope.nextRawStage,'raw:'+index);assert.equal(scope.maxInputTokensPerRequest,4800);assert.equal(scope.maxCompletionTokensPerRequest,1800);
   if(!scope.approved){const approved=await routed(request(gapUrl,'POST',{...scope,step:'approve',freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true,acknowledgeMissingRaw8:true,acknowledgeNoFinalReport:true,noAutomaticRetry:true}));assert.equal(approved.status,200,await approved.clone().text());approvalWindows++;}
   globalThis.fetch=async()=>{providerCalls++;rawCalls++;return response(valid(groups[index][0].id));};
   injectRaw=[12,13,14,15].includes(index);injectUsage=index===16;
   const sent=await routed(request(gapUrl,'POST',{step:'execute',transcriptHash:hash,expectedStage:'raw:'+index,executeOnce:true}));
   if([12,13,14,15,16].includes(index)){rawFailureQueries.push(queries);assert.notEqual(sent.status,202);const rawId=id+':groq-summary:'+hash+':raw:'+index,failed=f.db.prepare('SELECT state,error_code,result_json FROM yta_operations WHERE id=?').get(rawId);assert.ok(failed,`raw:${index} failed operation missing: ${await sent.clone().text()}`);const saved=JSON.parse(failed.result_json);assert.equal(failed.state,'FAILED_UNCERTAIN');assert.equal(failed.error_code,'SUMMARY_RESULT_PERSISTENCE_UNCERTAIN');assert.equal(saved.reviewResult.partialText,JSON.stringify(valid(groups[index][0].id)));assert.equal(saved.reviewResult.usage.totalTokens,390);assert.equal(f.db.prepare('SELECT used_units FROM usage_events WHERE id=?').get(saved.usageEventId).used_units,390);assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE id LIKE ? AND state='STOPPED' ORDER BY created_at DESC LIMIT 1").get(id+':groq-summary:approval:%').state,'STOPPED');f.db.prepare('UPDATE yta_operations SET created_at=? WHERE id=?').run(stamp,rawId);const url=f.path+'/groq-summary-checkpoint-recovery?stage=raw:'+index,review=await(await routed(request(url))).json(),restored=await routed(request(url,'POST',{step:'recover',evidenceHash:review.evidenceHash,failedOperationId:rawId,contractHash:hash,responseSha256:review.responseSha256,acknowledgeOriginalUsage:390,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}));assert.equal(restored.status,200,await restored.clone().text());assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(rawId).state,'FAILED_UNCERTAIN');assert.equal((await(await routed(request(url))).json()).recovered,true);continue;}
   assert.equal(sent.status,202,await sent.clone().text());
   f.db.prepare("UPDATE yta_operations SET created_at=? WHERE id=? AND state='DONE'").run(stamp,id+':groq-summary:'+hash+':raw:'+index);
   if(index===10||index===44){const resumed=await routed(request(gapUrl));assert.equal(resumed.status,200);assert.equal((await resumed.json()).nextRawStage,'raw:'+(index+1));}
  }
  assert.equal(rawCalls,69);assert.equal(injectedRaw,4);assert.equal(injectedUsage,1);assert.ok(approvalWindows>=2);assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(raw9Id).state,'FAILED_UNCERTAIN');
  const firstRead=await routed(request(completeUrl));assert.equal(firstRead.status,200,await firstRead.clone().text());let scope=await firstRead.json();assert.equal(scope.ready,true);assert.equal(scope.rawStages,79);assert.equal(scope.missingSegmentIds.length,0);
  const excerpts=Array(79).fill(null),checkpoints=Array(79).fill(null),audit=JSON.parse(f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(id).audit_json);
  for(let index=0;index<79;index++){if(index===8||index===9){excerpts[index]=JSON.parse(f.db.prepare("SELECT result_json FROM yta_operations WHERE id=?").get(id+':groq-summary-complete:'+hash+':excerpt:raw:'+index).result_json);continue;}const report=validateAnalysis(valid(groups[index][0].id),groups[index],'groq'),normalized={...report,evidenceValidation:'REFERENCES_COVERAGE_NUMBERS_QUOTES_ONLY'};checkpoints[index]={key:'raw:'+index,sourceHash:hash,provenance:'AI_VALIDATED_RAW_CHECKPOINT',report:normalized,reportSha256:await digest(normalized)};}
  const manifest=await completeCoverageManifest({sourceHash:hash,auditSha256:await digest(audit),segments:f.segments,groups,checkpoints,excerpts,verifyGrounding:assertGrounding,boundarySegmentIds:promptAudit({audit,duration_seconds:5892.864}).audioBoundarySegmentIds}),notes=await evidenceNotes({manifest,checkpoints,excerpts}),saved=new Map();assert.equal(manifest.segmentCount,1226);assert.equal(manifest.boundarySegmentIds.length,47);assert.ok(notes.length>=79);
  let progress=await synthesisTreeProgress({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:saved});
  while(!progress.complete){scope=await(await routed(request(completeUrl))).json();assert.equal(scope.nextSynthesisStage,progress.next.key);assert.ok(scope.nextSynthesisInputUpper<=4800);let approval=scope.activeSynthesisApproval;if(!approval){const quoteReply=await routed(request(completeUrl,'POST',{step:'quote',sourceHash:hash,manifestSha256:scope.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}));assert.equal(quoteReply.status,200,await quoteReply.clone().text());const quote=await quoteReply.json(),approved=await routed(request(completeUrl,'POST',{step:'approve',quoteId:quote.quoteId,quoteSha256:quote.quoteSha256,reservedUnits:quote.quote.reservedUnits,maxCalls:quote.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}));assert.equal(approved.status,200,await approved.clone().text());approval=await approved.json();approvalWindows++;}
   const next=progress.next,responseBody={summary:[{text:'가',evidenceIds:[next.left.evidenceIds[0]]}],chapters:[{text:'가',evidenceIds:[next.left.evidenceIds[0]]},{text:'가',evidenceIds:[next.right.evidenceIds[0]]}],claims:[],numbers:[],critical:[],conclusion:'가'};
   if(synthesisFailureHandled&&!recoveryProofRaceApplied){injectRecoveryProofRace=true;const blockedByProof=await routed(request(completeUrl,'POST',{step:'execute',approvalId:approval.approvalId,expectedNode:next.key,requestSha256:next.requestSha256,executeOnce:true}));assert.equal(blockedByProof.status,409,await blockedByProof.clone().text());assert.equal(recoveryProofRaceApplied,true);f.db.prepare("UPDATE yta_operations SET state='DONE' WHERE provider='groq-summary-synthesis-recovery'").run();}
   injectSynthesis=synthesisCalls===2&&!synthesisFailureHandled;globalThis.fetch=async()=>{providerCalls++;synthesisCalls++;return response(responseBody);};const executed=await routed(request(completeUrl,'POST',{step:'execute',approvalId:approval.approvalId,expectedNode:next.key,requestSha256:next.requestSha256,executeOnce:true}));
   if(injectedSynthesis===1&&!synthesisFailureHandled){synthesisFailureQueries=queries;synthesisFailureHandled=true;assert.notEqual(executed.status,200);const failedId=id+':groq-summary-complete:'+hash+':note:'+next.key,failed=f.db.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').get(failedId);assert.ok(failed,`missing synthesis failure ${failedId}: ${await executed.clone().text()} ${JSON.stringify(f.db.prepare("SELECT id,state,error_code FROM yta_operations WHERE provider='groq-summary-synthesis'").all())}`);const failure=JSON.parse(failed.result_json);assert.equal(failed.state,'FAILED_UNCERTAIN');assert.equal(failure.partialText,JSON.stringify(responseBody));assert.equal(failure.usage.totalTokens,390);assert.equal(failure.responseComplete,true);assert.equal(f.db.prepare('SELECT used_units FROM usage_events WHERE id=?').get(failure.usageEventId).used_units,390);assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(approval.approvalId).state,'STOPPED');f.db.prepare('UPDATE yta_operations SET created_at=? WHERE id=?').run(stamp,failedId);globalThis.fetch=async()=>{throw Error('recovery must not call provider');};const blocked=await(await routed(request(completeUrl))).json();assert.equal(blocked.blocked,true);assert.equal(blocked.recoveryCandidate.failedOperationId,failedId);const restored=await routed(request(completeUrl,'POST',{step:'recover-node',failedOperationId:failedId,responseSha256:blocked.recoveryCandidate.responseSha256,usageTotalTokens:390,confirmNoProviderCall:true,confirmOriginalFailurePreserved:true}));assert.equal(restored.status,200,await restored.clone().text());assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(failedId).state,'FAILED_UNCERTAIN');const recoveryId=id+':groq-summary-synthesis-recovery:'+hash+':note:'+next.key,record=JSON.parse(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(recoveryId).result_json);saved.set(next.key,record);progress=await synthesisTreeProgress({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:saved});assert.equal((await(await routed(request(completeUrl))).json()).completedSynthesisNodes,progress.completed);continue;}
   assert.equal(executed.status,200,await executed.clone().text());
   const operationId=id+':groq-summary-complete:'+hash+':note:'+next.key,record=JSON.parse(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(operationId).result_json);saved.set(next.key,record);f.db.prepare('UPDATE yta_operations SET created_at=? WHERE id=?').run(stamp,operationId);progress=await synthesisTreeProgress({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:saved});
   if(synthesisCalls===1){const active=f.db.prepare("SELECT id,result_json FROM yta_operations WHERE provider='groq-summary-synthesis-approval' AND state='APPROVED' ORDER BY created_at DESC LIMIT 1").get();f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(active.result_json),expiresAt:Date.now()-1}),active.id);}
   if(synthesisCalls===2){const cancelled=await routed(request(completeUrl,'POST',{step:'cancel',approvalId:approval.approvalId,confirmCancel:true}));assert.equal(cancelled.status,200,await cancelled.clone().text());assert.equal((await cancelled.json()).cancelled,true);}
  }
  assert.equal(recoveryProofRaceApplied,true);assert.equal(synthesisCalls,notes.length-1);assert.equal(providerCalls,69+synthesisCalls);const finalRead=await routed(request(completeUrl));assert.equal(finalRead.status,200,await finalRead.clone().text());const finalScope=await finalRead.json();assert.equal(finalScope.finalizationReady,true);assert.equal(finalScope.finalizationReview.reviewedStages.length,79);
  const finalizeRequest=request(completeUrl,'POST',{step:'finalize',sourceHash:hash,manifestSha256:finalScope.manifestSha256,confirmNoProviderCall:true});await assert.rejects(async()=>{const committed=await routed(finalizeRequest);assert.equal(committed.status,200);throw Error('SIMULATED_FINAL_SAVE_HTTP_RESPONSE_LOSS');},/SIMULATED_FINAL_SAVE_HTTP_RESPONSE_LOSS/);const reopened=await(await routed(request(f.path))).json(),savedSource=await(await routed(request(f.path+'/source'))).json(),txt=await(await routed(request(f.path+'/export?format=txt'))).text();
  assert.ok(Buffer.byteLength(JSON.stringify(reopened.job.report))<2_000_000);assert.equal(reopened.job.report.appendix.length,79);assert.equal(reopened.job.report.meaningReview.status,'AUTO_CHECK_PASSED_HUMAN_UNREVIEWED');assert.equal(reopened.job.report.coverageManifest.missingSegmentIds.length,0);assert.equal(txt,markdownReport(reopened.job,savedSource.source));assert.match(txt,/#1226/);assert.match(txt,/raw:8/);assert.match(txt,/raw:9/);assert.ok(maxQueries<=50);assert.equal(rawFailureQueries.length,5);assert.ok(rawFailureQueries.every(count=>count<=50));assert.ok(synthesisFailureQueries<=50);
  const bCreated=await(await routed(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600,title:'Next offline job'}))).json(),bId=bCreated.job.id,bPath='/api/jobs/'+bId,bSegments=f.segments.slice(0,2),bRaw=bSegments.map(item=>item.text).join('\n');f.db.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').run(bId,bRaw,JSON.stringify(bSegments),'GROQ_OWNED_AUDIO',new Date().toISOString());f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify({audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64)}),bId);
  const bPlan=await(await routed(request(bPath+'/groq-summary-plan'))).json(),bReviewReply=await routed(request(bPath+'/groq-summary-approval'));assert.equal(bReviewReply.status,200,await bReviewReply.clone().text());const bReview=await bReviewReply.json(),bApproval={jobId:bId,transcriptHash:bPlan.transcriptHash,model:bPlan.model,outputKind:bPlan.outputKind,windowStart:bPlan.windowStart,totalRequests:bPlan.totalRequests,maxRequests:bPlan.maxRequests,maxInputTokensPerRequest:bPlan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:bPlan.maxCompletionTokensPerRequest,totalTokenUpperBound:bPlan.totalTokenUpperBound,credentialGeneration:bReview.credentialGeneration,freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true};assert.equal((await routed(request(bPath+'/groq-summary-approval','POST',bApproval))).status,200);
  const globalProof=await globallyRecoveredGroq(f.env,bId),aFailed=f.db.prepare("SELECT id,error_code FROM yta_operations WHERE job_id=? AND state='FAILED_UNCERTAIN'").all(id);assert.equal(aFailed.length,11);assert.equal(new Set(globalProof.ids).size,aFailed.length);assert.equal(globalProof.liveResolutionProofs.length,10);t.diagnostic(`saved A failures ${aFailed.length}; distinct global resolutions ${new Set(globalProof.ids).size}`);
  globalThis.fetch=async()=>{providerCalls++;return response({...valid(1),summary:[{text:'주장 1',evidenceIds:bSegments.map(item=>item.id)}]});};const bRun=await routed(request(bPath+'/groq-summary','POST',{}));assert.equal(bRun.status,202,await bRun.clone().text());
  const deleted=await routed(request(f.path,'DELETE'));assert.equal(deleted.status,200,await deleted.clone().text());assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE id=?').get(id).n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yta_sources WHERE job_id=?').get(id).n,0);assert.ok(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider='groq-summary-settlement'").get(id).n>=9);t.diagnostic(`post-response failure D1 queries: raw ${rawFailureQueries.join(',')}, synthesis ${synthesisFailureQueries}`);t.diagnostic(`synthetic full route: ${rawCalls} raw mock calls, ${synthesisCalls} synthesis mock calls, ${approvalWindows} approval windows, maximum ${maxQueries} D1 queries per request; action peaks ${JSON.stringify(Object.fromEntries(maxByAction))}`);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('complete synthesis review lists raw:8 and raw:9 failures separately without clearing either lock',async()=>{
 const {f,groups}=await reviewedGapFixture(),id=f.id,hash=f.plan.transcriptHash,stamp=new Date(Date.now()-120000).toISOString(),raw9Id=id+':groq-summary:'+hash+':raw:9';
 f.env.ENABLE_COMPLETE_SYNTHESIS='true';
 const raw9Result=JSON.stringify({reviewResult:{partialText:JSON.stringify({...valid(groups[9][0].id),summary:[{text:'근거 없는 2024년',evidenceIds:[groups[9][0].id]}]}),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:null,totalTokens:2078}}});
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(raw9Id,id,stamp,raw9Result);
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2078,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),id,stamp);
 const old8=f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(id+':groq-summary:'+hash+':raw:8').result_json;
 const old9=f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(raw9Id).result_json;
 const oldFetch=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;throw Error('NO_PROVIDER_CALL');};
  const url=f.path+'/groq-summary-complete',before=await(await routeApi(request(url),f.env)).json();
  assert.equal(before.ready,false,JSON.stringify(before));assert.deepEqual(before.failedStages.map(item=>item.stage),['raw:8','raw:9']);
  const review=await(await routeApi(request(url+'?stage=raw:9'),f.env)).json();
  assert.equal(review.provenance,'HUMAN_REVIEWED_SOURCE_EXCERPT');assert.equal(review.failureEvidence[0].usageTotalTokens,2078);
  const write=await routeApi(request(url,'POST',{step:'register-excerpt',stage:'raw:9',sourceHash:review.sourceHash,auditSha256:review.auditSha256,recordSha256:review.recordSha256,selectedIds:review.selectedIds,confirmExactSourceExcerpt:true,confirmNotAiSummary:true,confirmPriorFailureAndUsagePreserved:true}),f.env);
  assert.equal(write.status,200);
  const after=await(await routeApi(request(url),f.env)).json();
  assert.equal(after.ready,false);assert.equal(after.failedStages.find(item=>item.stage==='raw:9').reviewed,true);
  assert.equal(after.failedStages.find(item=>item.stage==='raw:8').reviewed,false);
  assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(id+':groq-summary:'+hash+':raw:8').result_json,old8);
  assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(raw9Id).result_json,old9);
  assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(raw9Id).state,'FAILED_UNCERTAIN');
  const raw8Review=await(await routeApi(request(url+'?stage=raw:8'),f.env)).json();
  f.db.prepare("UPDATE usage_events SET unit='audio_seconds' WHERE job_id=? AND used_units=2139").run(id);
  assert.equal((await routeApi(request(url,'POST',{step:'register-excerpt',stage:'raw:8',sourceHash:raw8Review.sourceHash,auditSha256:raw8Review.auditSha256,recordSha256:raw8Review.recordSha256,selectedIds:raw8Review.selectedIds,confirmExactSourceExcerpt:true,confirmNotAiSummary:true,confirmPriorFailureAndUsagePreserved:true}),f.env)).status,409);
  f.db.prepare("UPDATE usage_events SET unit='actual_total_tokens' WHERE job_id=? AND used_units=2139").run(id);
  assert.equal((await routeApi(request(url,'POST',{step:'register-excerpt',stage:'raw:9',sourceHash:review.sourceHash,auditSha256:review.auditSha256,recordSha256:review.recordSha256,selectedIds:review.selectedIds,confirmExactSourceExcerpt:true,confirmNotAiSummary:true,confirmPriorFailureAndUsagePreserved:true}),f.env)).status,400);
  assert.equal(calls,0);
 }finally{globalThis.fetch=oldFetch;}
});

test('reviewed raw:9 excerpt and usage permit separately approved raw:10 then synthesis quote',async()=>{
 const {f,groups}=await reviewedGapFixture(),id=f.id,hash=f.plan.transcriptHash,stamp=new Date(Date.now()-120_000).toISOString(),completeUrl=f.path+'/groq-summary-complete',gapUrl=f.path+'/groq-summary-gap';
 f.env.ENABLE_COMPLETE_SYNTHESIS='true';const raw9Id=id+':groq-summary:'+hash+':raw:9';
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(raw9Id,id,stamp,JSON.stringify({reviewResult:{partialText:JSON.stringify({...valid(groups[9][0].id),summary:[{text:'근거 없는 2024년',evidenceIds:[groups[9][0].id]}]}),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:null,totalTokens:2078}}}));
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2078,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),id,stamp);
 for(const index of [8,9]){const stage='raw:'+index,review=await(await routeApi(request(completeUrl+'?stage='+stage),f.env)).json();const content=await routeApi(request(completeUrl,'POST',{step:'register-excerpt',stage,sourceHash:hash,auditSha256:review.auditSha256,recordSha256:review.recordSha256,selectedIds:review.selectedIds,confirmExactSourceExcerpt:true,confirmNotAiSummary:true,confirmPriorFailureAndUsagePreserved:true}),f.env);assert.equal(content.status,200,await content.clone().text());const marked=await(await routeApi(request(completeUrl+'?stage='+stage),f.env)).json(),disposition=marked.disposition;const usage=await routeApi(request(completeUrl,'POST',{step:'review-failure-usage',stage,sourceHash:hash,auditSha256:disposition.auditSha256,recordSha256:disposition.recordSha256,confirmSeparateFromContent:true,acknowledgeReceiptNotVerified:true,acknowledgeAccountBalanceUnknown:true,acknowledgeConservativeReservation:true,noRetry:true}),f.env);assert.equal(usage.status,200,await usage.clone().text());}
 const preview=await routeApi(request(gapUrl),f.env);assert.equal(preview.status,200,await preview.clone().text());const scope=await preview.json();assert.equal(scope.nextRawStage,'raw:10');
 const approved=await routeApi(request(gapUrl,'POST',{...scope,step:'approve',freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true,acknowledgeMissingRaw8:true,acknowledgeNoFinalReport:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());
 const oldFetch=globalThis.fetch;let calls=0;try{globalThis.fetch=async()=>{calls++;return response(valid(groups[10][0].id));};const executed=await routeApi(request(gapUrl,'POST',{step:'execute',transcriptHash:hash,expectedStage:'raw:10',executeOnce:true}),f.env);assert.equal(executed.status,202,await executed.clone().text());assert.equal(calls,1);}finally{globalThis.fetch=oldFetch;}
 assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(raw9Id).state,'FAILED_UNCERTAIN');
 for(let index=11;index<groups.length;index++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(id+':groq-summary:'+hash+':raw:'+index,id,stamp,JSON.stringify({hash,key:'raw:'+index,report:valid(groups[index][0].id)}));
 const synthesis=await routeApi(request(completeUrl),f.env);assert.equal(synthesis.status,200,await synthesis.clone().text());const complete=await synthesis.json();assert.equal(complete.ready,true);const quoted=await routeApi(request(completeUrl,'POST',{step:'quote',sourceHash:hash,manifestSha256:complete.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),f.env);assert.equal(quoted.status,200,await quoted.clone().text());
});

test('feature-disabled year recovery only reads; explicit source-spelling review stores a separate derived record',async()=>{
 const segmentText=id=>id===19?'2020년대의 22년 금리 1.5% '+ '가'.repeat(337):id===20?'2020년대의 23년 물가 2%대 '+ '가'.repeat(337):'가'.repeat(350);
 const {f,groups}=await reviewedGapFixture({segmentText}),id=f.id,hash=f.plan.transcriptHash,group=groups[9],stamp=new Date(Date.now()-120000).toISOString(),url=f.path+'/groq-summary-complete';
 assert.equal(group[0].id,19);assert.equal(group[1].id,20);
 const original={summary:[{text:'2022년 금리 1.5%',evidenceIds:[19]},{text:'2023년 물가 2%대',evidenceIds:[20]}],chapters:[{text:'금리와 물가 언급',evidenceIds:[19,20]}],claims:[],numbers:[],critical:[],conclusion:'원문 범위의 결론'},resultJson=JSON.stringify({reviewResult:{partialText:JSON.stringify(original),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:null,totalTokens:2078}}}),operationId=id+':groq-summary:'+hash+':raw:9';
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(operationId,id,stamp,resultJson);
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2078,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),id,stamp);
 f.db.prepare("UPDATE yta_operations SET state='STOPPED' WHERE id=?").run(id+':groq-summary:approval:1');
 const review=await(await routeApi(request(url+'?stage=raw:9'),f.env)).json();assert.ok(review.derivedCandidate);assert.deepEqual(review.derivedCandidate.transformations.map(item=>[item.from,item.to]),[['2022년','22년'],['2023년','23년']]);
 const body={step:'register-recovery',stage:'raw:9',sourceHash:hash,auditSha256:review.auditSha256,recordSha256:review.derivedCandidate.recordSha256,confirmSourceSpelling:true,confirmNoCenturyInference:true,confirmOriginalUsagePreserved:true,confirmNoProviderCall:true};
 assert.equal((await routeApi(request(url,'POST',body),f.env)).status,409);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE provider='groq-summary-derived-recovery'").get().n,0);
 f.env.ENABLE_COMPLETE_SYNTHESIS='true';assert.equal((await routeApi(request(url,'POST',body),f.env)).status,200);
 const record=JSON.parse(f.db.prepare("SELECT result_json FROM yta_operations WHERE provider='groq-summary-derived-recovery'").get().result_json);
 assert.equal(record.failedResultSha256,await digest(resultJson));assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(operationId).state,'FAILED_UNCERTAIN');
 const after=await(await routeApi(request(url),f.env)).json();assert.equal(after.failedStages.find(item=>item.stage==='raw:9').contentProvenance,'AUDITED_DERIVED_CHECKPOINT');assert.equal(after.ready,false);
 assert.equal(after.failedStages.find(item=>item.stage==='raw:9').failureDispositionReviewed,false);
 const usageReview=await(await routeApi(request(url+'?stage=raw:9'),f.env)).json(),disposition=usageReview.disposition;
 const marked=await routeApi(request(url,'POST',{step:'review-failure-usage',stage:'raw:9',sourceHash:hash,auditSha256:disposition.auditSha256,recordSha256:disposition.recordSha256,confirmSeparateFromContent:true,acknowledgeReceiptNotVerified:true,acknowledgeAccountBalanceUnknown:true,acknowledgeConservativeReservation:true,noRetry:true}),f.env);
 assert.equal(marked.status,200,await marked.clone().text());
 const reviewed=await(await routeApi(request(url),f.env)).json();assert.equal(reviewed.failedStages.find(item=>item.stage==='raw:9').failureDispositionReviewed,true);
 assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(operationId).state,'FAILED_UNCERTAIN');
 const laterScope={...f.approval,sequence:2,windowStart:10,maxRequests:1,totalTokenUpperBound:6600};
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'STOPPED',?,?)").run(id+':groq-summary:approval:2',id,new Date().toISOString(),JSON.stringify(laterScope));
 const afterLaterApproval=await routeApi(request(url+'?stage=raw:9'),f.env);assert.equal(afterLaterApproval.status,200,await afterLaterApproval.clone().text());
 const raw8=await(await routeApi(request(url+'?stage=raw:8'),f.env)).json();assert.equal((await routeApi(request(url,'POST',{step:'register-excerpt',stage:'raw:8',sourceHash:hash,auditSha256:raw8.auditSha256,recordSha256:raw8.recordSha256,selectedIds:raw8.selectedIds,confirmExactSourceExcerpt:true,confirmNotAiSummary:true,confirmPriorFailureAndUsagePreserved:true}),f.env)).status,200);
 const raw8After=await(await routeApi(request(url+'?stage=raw:8'),f.env)).json(),raw8Disposition=raw8After.disposition;assert.equal((await routeApi(request(url,'POST',{step:'review-failure-usage',stage:'raw:8',sourceHash:hash,auditSha256:raw8Disposition.auditSha256,recordSha256:raw8Disposition.recordSha256,confirmSeparateFromContent:true,acknowledgeReceiptNotVerified:true,acknowledgeAccountBalanceUnknown:true,acknowledgeConservativeReservation:true,noRetry:true}),f.env)).status,200);
 assert.equal((await routeApi(request(f.path,'DELETE'),f.env)).status,200);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider='groq-summary-settlement'").get(id).n,3);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yta_sources WHERE job_id=?').get(id).n,0);
 const b=await sibling(f,{approve:false}),bPlan=await(await routeApi(request(b.path+'/groq-summary-plan'),f.env)).json(),bReview=await(await routeApi(request(b.path+'/groq-summary-approval'),f.env)).json(),bApproval={...f.approval,jobId:b.id,transcriptHash:bPlan.transcriptHash,model:bPlan.model,outputKind:bPlan.outputKind,windowStart:bPlan.windowStart,totalRequests:bPlan.totalRequests,maxRequests:bPlan.maxRequests,maxInputTokensPerRequest:bPlan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:bPlan.maxCompletionTokensPerRequest,totalTokenUpperBound:bPlan.totalTokenUpperBound,credentialGeneration:bReview.credentialGeneration};assert.equal((await routeApi(request(b.path+'/groq-summary-approval','POST',bApproval),f.env)).status,200);const oldFetch=globalThis.fetch;let calls=0;try{globalThis.fetch=async()=>{calls++;return response(valid(groups[0][0].id));};assert.equal((await routeApi(request(b.path+'/groq-summary','POST',{}),f.env)).status,202);assert.equal(calls,1);}finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('complete synthesis finalizes validated persisted nodes and actual app TXT export after owner meaning review',async()=>{
 const {f,groups}=await reviewedGapFixture(),id=f.id,hash=f.plan.transcriptHash,stamp=new Date(Date.now()-120000).toISOString(),url=f.path+'/groq-summary-complete';
 f.env.ENABLE_COMPLETE_SYNTHESIS='true';
 const raw9Id=id+':groq-summary:'+hash+':raw:9',raw9Result=JSON.stringify({reviewResult:{partialText:JSON.stringify({...valid(groups[9][0].id),summary:[{text:'근거 없는 2024년',evidenceIds:[groups[9][0].id]}]}),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:60,totalTokens:2078}}});
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(raw9Id,id,stamp,raw9Result);
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2078,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),id,stamp);
 for(let index=10;index<groups.length;index++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(id+':groq-summary:'+hash+':raw:'+index,id,stamp,JSON.stringify({hash,key:'raw:'+index,report:valid(groups[index][0].id)}));
 const excerpts=Array(groups.length).fill(null),checkpoints=Array(groups.length).fill(null),oldFailures=f.db.prepare("SELECT id,state,result_json FROM yta_operations WHERE id IN (?,?)").all(id+':groq-summary:'+hash+':raw:8',raw9Id);
 for(const index of [8,9]){
  const review=await(await routeApi(request(url+'?stage=raw:'+index),f.env)).json();
  const written=await routeApi(request(url,'POST',{step:'register-excerpt',stage:'raw:'+index,sourceHash:review.sourceHash,auditSha256:review.auditSha256,recordSha256:review.recordSha256,selectedIds:review.selectedIds,confirmExactSourceExcerpt:true,confirmNotAiSummary:true,confirmPriorFailureAndUsagePreserved:true}),f.env);
  assert.equal(written.status,200);
  const row=f.db.prepare("SELECT result_json FROM yta_operations WHERE job_id=? AND provider='groq-summary-excerpt' AND id LIKE ?").get(id,'%:raw:'+index);
  excerpts[index]=JSON.parse(row.result_json);
 }
 for(const index of [8,9]){
  const review=await(await routeApi(request(url+'?stage=raw:'+index),f.env)).json(),disposition=review.disposition;
  assert.equal((await routeApi(request(url,'POST',{step:'review-failure-usage',stage:'raw:'+index,sourceHash:hash,auditSha256:disposition.auditSha256,recordSha256:disposition.recordSha256,confirmSeparateFromContent:true,acknowledgeReceiptNotVerified:true,acknowledgeAccountBalanceUnknown:true,acknowledgeConservativeReservation:true,noRetry:true}),f.env)).status,200);
 }
 const audit=JSON.parse(f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(id).audit_json),auditSha256=await digest(audit);
 for(let index=0;index<groups.length;index++)if(![8,9].includes(index)){
  const normalized=validateAnalysis(valid(groups[index][0].id),groups[index],'groq'),report={...normalized,evidenceValidation:'REFERENCES_COVERAGE_NUMBERS_QUOTES_ONLY'};
  checkpoints[index]={key:'raw:'+index,sourceHash:hash,provenance:'AI_VALIDATED_RAW_CHECKPOINT',report,reportSha256:await digest(report)};
 }
 const manifest=await completeCoverageManifest({sourceHash:hash,auditSha256,segments:f.segments,groups,checkpoints,excerpts,verifyGrounding:assertGrounding}),notes=await evidenceNotes({manifest,checkpoints,excerpts}),saved=new Map();
 let progress=await synthesisTreeProgress({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:saved});
 f.db.prepare("UPDATE yta_operations SET created_at=? WHERE provider='groq-summary' AND state IN ('DONE','FAILED_UNCERTAIN')").run(new Date(Date.now()-2*86_400_000).toISOString());
 const scope=await(await routeApi(request(url),f.env)).json();
 const quoted=await routeApi(request(url,'POST',{step:'quote',sourceHash:hash,manifestSha256:scope.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),f.env);assert.equal(quoted.status,200,await quoted.clone().text());
 const issued=await quoted.json(),approved=await routeApi(request(url,'POST',{step:'approve',quoteId:issued.quoteId,quoteSha256:issued.quoteSha256,reservedUnits:issued.quote.reservedUnits,maxCalls:issued.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());
 const approval=await approved.json(),first=progress.next,firstResponse={summary:[{text:'원문 검증',evidenceIds:[first.left.evidenceIds[0]]}],chapters:[{text:'시간대 요약',evidenceIds:[first.left.evidenceIds[0]]},{text:'시간대 요약',evidenceIds:[first.right.evidenceIds[0]]}],claims:[],numbers:[],critical:[],conclusion:'외부 사실은 미확인'};
 const oldFetch=globalThis.fetch;let synthesisFetches=0;
 try{globalThis.fetch=async()=>{synthesisFetches++;return response(firstResponse);};const executed=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,expectedNode:first.key,requestSha256:first.requestSha256,executeOnce:true}),f.env);assert.equal(executed.status,200,await executed.clone().text());}finally{globalThis.fetch=oldFetch;}
 assert.equal(synthesisFetches,1);
 const firstSaved=JSON.parse(f.db.prepare("SELECT result_json FROM yta_operations WHERE id=? AND provider='groq-summary-synthesis'").get(id+':groq-summary-complete:'+hash+':note:'+first.key).result_json);
 saved.set(first.key,firstSaved);progress=await synthesisTreeProgress({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:saved});
 const afterFirst=await(await routeApi(request(url),f.env)).json();assert.equal(afterFirst.activeSynthesisApproval.approvalId,approval.approvalId);
 f.db.prepare("UPDATE yta_operations SET created_at=? WHERE id=?").run(new Date(Date.now()-120_000).toISOString(),id+':groq-summary-complete:'+hash+':note:'+first.key);
 const second=progress.next,secondResponse={summary:[{text:'원문 검증',evidenceIds:[second.left.evidenceIds[0]]}],chapters:[{text:'시간대 요약',evidenceIds:[second.left.evidenceIds[0]]},{text:'시간대 요약',evidenceIds:[second.right.evidenceIds[0]]}],claims:[],numbers:[],critical:[],conclusion:'외부 사실은 미확인'};
 try{globalThis.fetch=async()=>{synthesisFetches++;return response(secondResponse);};const executed=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,expectedNode:second.key,requestSha256:second.requestSha256,executeOnce:true}),f.env);assert.equal(executed.status,200,await executed.clone().text());}finally{globalThis.fetch=oldFetch;}
 assert.equal(synthesisFetches,2);
 saved.set(second.key,JSON.parse(f.db.prepare("SELECT result_json FROM yta_operations WHERE id=? AND provider='groq-summary-synthesis'").get(id+':groq-summary-complete:'+hash+':note:'+second.key).result_json));progress=await synthesisTreeProgress({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:saved});
 while(!progress.complete){
  const next=progress.next,response={summary:[{text:'원문 검증',evidenceIds:[next.left.evidenceIds[0]]}],chapters:[{text:'시간대 요약',evidenceIds:[next.left.evidenceIds[0]]},{text:'시간대 요약',evidenceIds:[next.right.evidenceIds[0]]}],claims:[],numbers:[],critical:[],conclusion:'외부 사실은 미확인'},record=await persistedSynthesisNode({next,response,sourceSegments:f.segments,verifyGrounding:assertGrounding}),usageEventId=crypto.randomUUID(),usage={inputTokens:300,outputTokens:90,totalTokens:390};
  f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SYNTHESIS','actual_total_tokens',390,0,NULL,'PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN',?)").run(usageEventId,id,stamp);
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary-synthesis',6600,'DONE',?,?)").run(id+':groq-summary-complete:'+hash+':note:'+next.key,id,stamp,JSON.stringify({...record,usageEventId,usage}));
  saved.set(next.key,record);progress=await synthesisTreeProgress({notes,sourceSegments:f.segments,verifyGrounding:assertGrounding,savedNodes:saved});
 }
 const ready=await(await routeApi(request(url),f.env)).json();assert.equal(ready.finalizationReady,true);assert.equal(ready.rootSha256,await digest(progress.root));
 const semanticReview={confirmMeaningAgainstSource:true,confirmRootIncludesAllMeaningfulPoints:true,reviewedStages:ready.finalizationReview.reviewedStages.map(({index,evidenceSha256})=>({index,evidenceSha256})),manifestSha256:manifest.manifestSha256,rootSha256:ready.rootSha256,reviewedAt:new Date().toISOString()},finished=await routeApi(request(url,'POST',{step:'finalize',sourceHash:hash,manifestSha256:manifest.manifestSha256,confirmNoProviderCall:true,semanticReview}),f.env);
 assert.equal(finished.status,200);
 const savedReport=JSON.parse(f.db.prepare('SELECT report_json FROM jobs WHERE id=?').get(id).report_json),reopened=await(await routeApi(request(f.path),f.env)).json(),savedSource=await(await routeApi(request(f.path+'/source'),f.env)).json(),txt=await(await routeApi(request(f.path+'/export?format=txt'),f.env)).text();
 assert.deepEqual(reopened.job.report,savedReport);assert.equal(savedReport.coverageManifest.missingSegmentIds.length,0);assert.equal(savedReport.appendix.length,groups.length);
 assert.equal(txt,markdownReport(reopened.job,savedSource.source));
 assert.match(txt,/전체 상세 결과 부록/);assert.match(txt,/raw:8 · 검토된 원문 발췌/);assert.match(txt,/raw:9 · 검토된 원문 발췌/);assert.match(txt,/누락 원문 ID: 없음/);
 for(const old of oldFailures){const current=f.db.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').get(old.id);assert.equal(current.state,old.state);assert.equal(current.result_json,old.result_json);}
});

test('reviewed gap recomputes the historical correction quote instead of trusting matching copies',async()=>{
 const {f,quote}=await reviewedGapFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const url=f.path+'/groq-summary-gap',approvalId=f.id+':groq-summary:correction:'+f.plan.transcriptHash+':raw:8:approval',savedApproval=f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(approvalId).result_json,savedQuote=f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(quote.quoteId).result_json;
  assert.equal((await routeApi(request(url),f.env)).status,200);
  const mutated={...JSON.parse(savedQuote),sourceSha256:'b'.repeat(64),originalApprovalSha256:'c'.repeat(64),keyIdentity:'wrong-historical-key',model:'wrong-model',requestSha256:'d'.repeat(64),maxCalls:2,reservedUnits:1};
  const {quoteSha256:_oldHash,...unsigned}=mutated;mutated.quoteSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(unsigned))))).map(value=>value.toString(16).padStart(2,'0')).join('');
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(mutated),quote.quoteId);
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify({quoteId:quote.quoteId,quote:mutated}),approvalId);
  globalThis.fetch=async()=>{calls++;throw Error('PROVIDER_CALL_FORBIDDEN');};
  assert.equal((await routeApi(request(url),f.env)).status,409);assert.equal(calls,0);
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(savedQuote,quote.quoteId);
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(savedApproval,approvalId);
  assert.equal((await routeApi(request(url),f.env)).status,200);
  const invalidExpiry={...JSON.parse(savedQuote),expiresAt:Date.parse(f.db.prepare('SELECT created_at FROM yta_operations WHERE id=?').get(quote.quoteId).created_at)+900_000};
  const {quoteSha256:_priorHash,...expiryUnsigned}=invalidExpiry;invalidExpiry.quoteSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(expiryUnsigned))))).map(value=>value.toString(16).padStart(2,'0')).join('');
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(invalidExpiry),quote.quoteId);
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify({quoteId:quote.quoteId,quote:invalidExpiry}),approvalId);
  assert.equal((await routeApi(request(url),f.env)).status,409);assert.equal(calls,0);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('reviewed gap rejects invalid reasoning usage and a non-token usage ledger row',async()=>{
 const {f,approval,correctionResult}=await reviewedGapFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const url=f.path+'/groq-summary-gap';assert.equal((await routeApi(request(url),f.env)).status,200);
  globalThis.fetch=async()=>{calls++;throw Error('PROVIDER_CALL_FORBIDDEN');};
  for(const reasoningTokens of [-1,1577,'53']){
   const mutated=JSON.parse(correctionResult);mutated.reviewResult.usage.reasoningTokens=reasoningTokens;
   f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(mutated),approval.attemptId);
   assert.equal((await routeApi(request(url),f.env)).status,409,String(reasoningTokens));assert.equal(calls,0);
  }
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(correctionResult,approval.attemptId);
  f.db.prepare("UPDATE usage_events SET unit='audio_seconds' WHERE job_id=? AND provenance='PROVIDER_REPORTED_CORRECTIVE_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN'").run(f.id);
  assert.equal((await routeApi(request(url),f.env)).status,409);assert.equal(calls,0);
  f.db.prepare("UPDATE usage_events SET unit='actual_total_tokens' WHERE job_id=? AND provenance='PROVIDER_REPORTED_CORRECTIVE_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN'").run(f.id);
  assert.equal((await routeApi(request(url),f.env)).status,200);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('reviewed gap requires actual token units for the original raw:8 failure usage',async()=>{
 const {f,failedId,oldResult,approval,correctionResult}=await reviewedGapFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const url=f.path+'/groq-summary-gap';assert.equal((await routeApi(request(url),f.env)).status,200);
  globalThis.fetch=async()=>{calls++;throw Error('PROVIDER_CALL_FORBIDDEN');};
  const original=f.db.prepare("SELECT id,unit,used_units FROM usage_events WHERE job_id=? AND provenance='PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN'").get(f.id);
  assert.equal(original.unit,'actual_total_tokens');assert.equal(original.used_units,2139);
  f.db.prepare("UPDATE usage_events SET unit='audio_seconds' WHERE id=?").run(original.id);
  const denied=await routeApi(request(url),f.env);assert.equal(denied.status,409,await denied.clone().text());assert.equal((await denied.json()).error.code,'SUMMARY_CORRECTION_EVIDENCE_INVALID');assert.equal(calls,0);
  assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(failedId).result_json,oldResult);
  assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(approval.attemptId).result_json,correctionResult);
  f.db.prepare("UPDATE usage_events SET unit='actual_total_tokens' WHERE id=?").run(original.id);
  assert.equal((await routeApi(request(url),f.env)).status,200);assert.equal(calls,0);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('reviewed gap contract preserves raw:8 failures, executes only raw:9 and exposes an incomplete bundle',async()=>{
 const {f,groups,approval,failedId,oldResult,correctionResult}=await reviewedGapFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const url=f.path+'/groq-summary-gap',preview=await routeApi(request(url),f.env);assert.equal(preview.status,200,await preview.clone().text());const scope=await preview.json();
  const denied=await handleSiteRequest(request(url),{...f.env,ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'gap-owner-audience',ACCESS_OWNER_EMAIL:'owner@example.com'});assert.equal(denied.status,401);
  assert.deepEqual([scope.contiguousRawStages,scope.completedRawStages,scope.heldRawStages,scope.nextRawStage],[8,8,1,'raw:9']);assert.equal(scope.finalSummaryComplete,false);assert.equal(scope.outputKind,'RAW_CHECKPOINTS_WITH_REVIEW_GAP');
  const bundle=await(await routeApi(request(f.path+'/groq-summary-gap-bundle'),f.env)).json();assert.equal(bundle.sourceCheckpointCount,8);assert.equal(bundle.missingRanges[0].stage,'raw:8');assert.equal(bundle.finalSummaryComplete,false);
  const approved=await routeApi(request(url,'POST',{...scope,step:'approve',freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true,acknowledgeMissingRaw8:true,acknowledgeNoFinalReport:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());
  const status=await(await routeApi(request(f.path+'/groq-summary-status'),f.env)).json();assert.deepEqual([status.rawProgress.contiguousRawStages,status.rawProgress.completedRawStages,status.rawProgress.heldRawStages,status.rawProgress.pendingRawStages],[8,8,1,groups.length-9]);
  let nextResponseId=groups[9][0].id;globalThis.fetch=async()=>{calls++;return response(valid(nextResponseId));};
  const sent=await routeApi(request(url,'POST',{step:'execute',transcriptHash:scope.transcriptHash,expectedStage:'raw:9',executeOnce:true}),f.env);assert.equal(sent.status,202,await sent.clone().text());assert.equal((await sent.json()).stage,'raw:9');assert.equal(calls,1);
  const after=await(await routeApi(request(url),f.env)).json();assert.deepEqual([after.contiguousRawStages,after.completedRawStages,after.heldRawStages,after.nextRawStage],[8,9,1,'raw:10']);
  assert.equal((await routeApi(request(url,'POST',{step:'execute',transcriptHash:scope.transcriptHash,expectedStage:'raw:9',executeOnce:true}),f.env)).status,409);assert.equal(calls,1);
  assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(failedId).result_json,oldResult);assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(approval.attemptId).result_json,correctionResult);
  assert.equal(f.db.prepare('SELECT report_json FROM jobs WHERE id=?').get(f.id).report_json,'null');
  assert.equal((await routeApi(request(f.path+'/groq-summary','POST',{finalizeOnly:true,transcriptHash:scope.transcriptHash}),f.env)).status,409);
  const later=await(await routeApi(request(f.path+'/groq-summary-gap-bundle?format=txt'),f.env)).text();assert.match(later,/raw:8/);assert.match(later,/검토 필요·미완료/);assert.match(later,/원시구간 완료 9/);
  for(let index=10;index<groups.length;index++){
   f.db.prepare("UPDATE yta_operations SET created_at=? WHERE id=? AND state='DONE'").run(new Date(Date.now()-120_000).toISOString(),f.id+':groq-summary:'+scope.transcriptHash+':raw:'+(index-1));
   nextResponseId=groups[index][0].id;
   const continued=await routeApi(request(url,'POST',{step:'execute',transcriptHash:scope.transcriptHash,expectedStage:'raw:'+index,executeOnce:true}),f.env);assert.equal(continued.status,202,await continued.clone().text());
  }
  const complete=await(await routeApi(request(url),f.env)).json();assert.equal(complete.bundleAvailable,true);assert.equal(complete.completedRawStages,groups.length-1);assert.equal(complete.heldRawStages,1);assert.equal(complete.pendingRawStages,0);assert.equal(complete.finalSummaryComplete,false);
  const finalBundle=await(await routeApi(request(f.path+'/groq-summary-gap-bundle'),f.env)).json();assert.equal(finalBundle.missingRanges[0].completed,false);assert.equal(finalBundle.sourceCheckpointCount,groups.length-1);
  assert.equal(f.db.prepare('SELECT report_json FROM jobs WHERE id=?').get(f.id).report_json,'null');assert.equal((await routeApi(request(f.path+'/groq-summary','POST',{finalizeOnly:true,transcriptHash:scope.transcriptHash}),f.env)).status,409);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('reviewed gap approval remains bound to the source and key before dispatch',async()=>{
 const {f,groups}=await reviewedGapFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const url=f.path+'/groq-summary-gap',scope=await(await routeApi(request(url),f.env)).json(),body={step:'execute',transcriptHash:scope.transcriptHash,expectedStage:'raw:9',executeOnce:true};
  assert.equal((await routeApi(request(url,'POST',{...scope,step:'approve',freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true,acknowledgeMissingRaw8:true,acknowledgeNoFinalReport:true,noAutomaticRetry:true}),f.env)).status,200);
  globalThis.fetch=async()=>{calls++;throw Error('PROVIDER_CALL_FORBIDDEN');};
  f.env.GROQ_API_KEY='ROTATED_TEST_KEY';assert.equal((await routeApi(request(url,'POST',body),f.env)).status,409);assert.equal(calls,0);
  f.env.GROQ_API_KEY='NOT_REAL_TEST_KEY';
  const oldAudit=f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(f.id).audit_json;
  f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(oldAudit),changedAfterGapApproval:true}),f.id);
  const changed=await routeApi(request(url,'POST',body),f.env);assert.equal(changed.status,409,await changed.clone().text());assert.equal(calls,0);
  f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(oldAudit,f.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yta_operations WHERE id=?').get(f.id+':groq-summary:'+scope.transcriptHash+':raw:9').n,0);
  assert.equal(groups[8][0].id,scope.gap.firstId);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('reviewed gap rejects an uncertain correction or a later 429 without another dispatch',async()=>{
 const {f,approval,correctionResult}=await reviewedGapFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  f.db.prepare("UPDATE yta_operations SET error_code='429' WHERE id=?").run(approval.attemptId);
  assert.equal((await routeApi(request(f.path+'/groq-summary-gap'),f.env)).status,409);
  f.db.prepare("UPDATE yta_operations SET error_code='SUMMARY_RESPONSE_INVALID',result_json=? WHERE id=?").run(correctionResult,approval.attemptId);
  const scope=await(await routeApi(request(f.path+'/groq-summary-gap'),f.env)).json();
  const approved=await routeApi(request(f.path+'/groq-summary-gap','POST',{...scope,step:'approve',freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true,acknowledgeMissingRaw8:true,acknowledgeNoFinalReport:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200);
  globalThis.fetch=async()=>{calls++;return Response.json({}, {status:429});};
  assert.equal((await routeApi(request(f.path+'/groq-summary-gap','POST',{step:'execute',transcriptHash:scope.transcriptHash,expectedStage:'raw:9',executeOnce:true}),f.env)).status,409);assert.equal(calls,1);
  assert.equal((await routeApi(request(f.path+'/groq-summary-gap'),f.env)).status,409);
  const status=await(await routeApi(request(f.path+'/groq-summary-status'),f.env)).json();assert.equal(status.activeStage.key,'raw:9');assert.equal(status.activeStage.state,'FAILED_UNCERTAIN');assert.equal(status.activeStage.errorCode,'429');assert.equal(status.rawProgress.heldRawStages,1);
  assert.equal((await routeApi(request(f.path+'/groq-summary-gap','POST',{step:'execute',transcriptHash:scope.transcriptHash,expectedStage:'raw:9',executeOnce:true}),f.env)).status,409);assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

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
  let calls=0;globalThis.fetch=async()=>{calls++;return response(valid(group[0].id));};
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
  const original=f.env.DB;f.env.DB={...original,prepare(sql){const statement=original.prepare(sql);if(!sql.startsWith('SELECT 1 AS ok FROM yta_operations a JOIN'))return statement;return {bind(...args){const bound=statement.bind(...args);return {...bound,async first(){if(++guardReads===1){const row=f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(row.audit_json);audit.audioBoundaryAmbiguities=[{segmentId:1,chunkIndex:1,startMs:0,endMs:1}];f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify(audit),f.id);}return bound.first();}};}};}};
  const result=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);
  assert.equal(result.status,409,await result.clone().text());assert.equal(calls,0);assert.equal(guardReads,1);
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
  release();assert.equal((await first).status,409);
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
 for(const units of [2220,2169])f.db.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),f.id,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',units,0,null,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',now);
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
  const recoveryId=f.id+':groq-summary-recovery:'+plan.transcriptHash+':raw:0',savedRecovery=f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(recoveryId).result_json;
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run('{}',recoveryId);
  const isolated=await routeApi(request(f.path+'/summary-choice'),f.env);assert.equal(isolated.status,200,await isolated.clone().text());const isolatedChoice=await isolated.json();assert.equal(isolatedChoice.summary.recoveryReviewRequired,true);assert.equal(isolatedChoice.summary.savedRawStages,0);
  const groqBlocked=await routeApi(request(f.path+'/groq-summary-status'),f.env);assert.equal((await groqBlocked.json()).error.code,'SUMMARY_RECOVERY_SCOPE_CHANGED');
   const beforeDiagnostic=f.db.prepare('SELECT total_changes() AS n').get().n;
   const diagnosticResponse=await routeApi(request(f.path+'/groq-summary-recovery-diagnostic'),f.env);assert.equal(diagnosticResponse.status,200,await diagnosticResponse.clone().text());const diagnostic=await diagnosticResponse.json();
   assert.equal(diagnostic.kind,'GROQ_RECOVERY_SCOPE_DIAGNOSTIC_V1');assert.equal(diagnostic.providerCalls,0);assert.equal(diagnostic.writes,0);assert.equal(diagnostic.executionAllowed,false);assert.equal(diagnostic.checkpointCountsVerified,false);assert.equal(diagnostic.credentialProjectBinding,'NOT_STORED_CANNOT_VERIFY');assert.equal(diagnostic.records[0].reason,'SUMMARY_RECOVERY_SCOPE_CHANGED');assert.equal(diagnostic.records[0].comparison.sameCanonicalRecord,false);assert.equal(diagnostic.records[0].comparison.fieldMatches.sourceSha256,false);assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,beforeDiagnostic);
  f.db.exec(readFileSync(new URL('../migrations/0015_gemini_two_pass.sql',import.meta.url),'utf8'));
  const geminiStatus=await routeApi(request(f.path+'/gemini-two-pass-status'),f.env);assert.equal(geminiStatus.status,200);assert.equal((await geminiStatus.json()).state,'NOT_STARTED');
  assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(recoveryId).result_json,'{}');f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(savedRecovery,recoveryId);
   const reordered=Object.fromEntries(Object.entries(JSON.parse(savedRecovery)).reverse());f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(reordered),recoveryId);
   const byteOnly=await(await routeApi(request(f.path+'/groq-summary-recovery-diagnostic'),f.env)).json();assert.equal(byteOnly.records[0].comparison.sameCanonicalRecord,true);assert.equal(byteOnly.records[0].comparison.sameSerializedRecord,false);assert.equal(byteOnly.executionAllowed,false);assert.equal((await routeApi(request(f.path+'/groq-summary-status'),f.env)).status,409);
   const privateRecord=JSON.parse(savedRecovery);privateRecord.privatePayload='DO_NOT_LEAK_RECOVERY_PAYLOAD';f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify(privateRecord),recoveryId);const redacted=await routeApi(request(f.path+'/groq-summary-recovery-diagnostic'),f.env),redactedText=await redacted.text();assert.doesNotMatch(redactedText,/DO_NOT_LEAK_RECOVERY_PAYLOAD|privatePayload/);assert.equal(JSON.parse(redactedText).records[0].comparison.unexpectedFieldCount,1);f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(savedRecovery,recoveryId);
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
   const auditDiagnostic=await(await routeApi(request(f.path+'/groq-summary-recovery-diagnostic'),f.env)).json();assert.equal(auditDiagnostic.records[0].comparison.fieldMatches.auditSha256,false);assert.equal(auditDiagnostic.records[0].comparison.fieldMatches.sourceSha256,true);assert.equal(auditDiagnostic.records[0].comparison.fieldMatches.report,true);assert.equal(auditDiagnostic.executionAllowed,false);assert.equal(providerCalls,1);
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

test('raw dispatch shares the D1 in-flight guard with synthesis',async()=>{
 const f=await fixture();
 assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
 const synthesisId=f.id+':groq-summary-complete:'+f.plan.transcriptHash+':note:note:0:0';
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'groq-summary-synthesis',6600,'CLAIMED',?)").run(synthesisId,f.id,new Date().toISOString());
 const oldFetch=globalThis.fetch;let calls=0;try{globalThis.fetch=async()=>{calls++;throw Error('unexpected provider request');};const result=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.notEqual(result.status,202);assert.equal(calls,0);}finally{globalThis.fetch=oldFetch;}
 assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(synthesisId).state,'CLAIMED');
});

test('raw final dispatch refuses an approval cancelled during the shared claim read',async()=>{
 const f=await fixture();assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
 const DB=f.env.DB,approvalId=f.id+':groq-summary:approval:0';let sharedReads=0,fetches=0;
 f.env.DB={prepare(sql){const statement=DB.prepare(sql);if(!sql.includes("SELECT id FROM yta_operations WHERE provider IN ('groq-summary','groq-summary-synthesis') AND state='CLAIMED' LIMIT 2"))return statement;return {async all(){sharedReads++;if(sharedReads===2)f.db.prepare("UPDATE yta_operations SET state='STOPPED' WHERE id=?").run(approvalId);return statement.all();}};}};
 const oldFetch=globalThis.fetch;try{globalThis.fetch=async()=>{fetches++;throw Error('unexpected provider call');};const result=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.notEqual(result.status,202);assert.equal(sharedReads,2);assert.equal(fetches,0);}finally{globalThis.fetch=oldFetch;}
});

test('raw final dispatch refuses an approval expired during the shared claim read',async()=>{
 const f=await fixture();assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
 const DB=f.env.DB,clock=Date.now;let sharedReads=0,fetches=0;
 f.env.DB={prepare(sql){const statement=DB.prepare(sql);if(!sql.includes("SELECT id FROM yta_operations WHERE provider IN ('groq-summary','groq-summary-synthesis') AND state='CLAIMED' LIMIT 2"))return statement;return {async all(){sharedReads++;if(sharedReads===2)Date.now=()=>clock()+3_600_001;return statement.all();}};}};
 const oldFetch=globalThis.fetch;try{globalThis.fetch=async()=>{fetches++;throw Error('unexpected provider call');};const result=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.notEqual(result.status,202);assert.equal(sharedReads,2);assert.equal(fetches,0);}finally{globalThis.fetch=oldFetch;Date.now=clock;}
});

test('raw dispatch rejects a key replacement between identity check and credential snapshot',async()=>{
 const f=await fixture();assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
 const DB=f.env.DB,oldFetch=globalThis.fetch;let rotations=0,fetches=0;
 f.env.DB={prepare(sql){const stmt=DB.prepare(sql);if(sql!=='SELECT cipher_version,iv_b64,ciphertext_b64,updated_at FROM provider_credentials WHERE owner_id=? AND provider=?')return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async first(){rotations++;f.db.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','groq',1,'offline-iv','offline-cipher',?)").run(new Date().toISOString());return bound.first();}};}};}};
 try{globalThis.fetch=async()=>{fetches++;throw Error('unexpected provider call');};const result=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(result.status,409,await result.clone().text());assert.equal(rotations,1);assert.equal(fetches,0);}finally{globalThis.fetch=oldFetch;f.db.close();}
});

for(const failurePoint of ['usage','usage-committed-reply-lost','checkpoint'])test(`raw valid provider response survives ${failurePoint} persistence failure without another provider call`,async()=>{
 const f=await fixture(),approvalReply=await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env);assert.equal(approvalReply.status,200);
 const report={summary:[{text:'원문 검증',evidenceIds:[1]}],chapters:[{text:'원문 검증',evidenceIds:[1,2]}],claims:[],numbers:[],critical:[],conclusion:'원문 검증'},raw=JSON.stringify(report);
 const DB=f.env.DB;let injected=false,calls=0;
 f.env.DB={prepare(sql){const stmt=DB.prepare(sql);if(!(['usage','usage-committed-reply-lost'].includes(failurePoint)&&sql.startsWith('INSERT INTO usage_events')||failurePoint==='checkpoint'&&sql.startsWith('UPDATE yta_operations SET state=?,result_json=?,created_at=? WHERE id=? AND state=? AND EXISTS')))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async run(){if(!injected){injected=true;if(failurePoint==='usage-committed-reply-lost')await bound.run();throw Error('SIMULATED_D1_WRITE_FAILURE');}return bound.run();}};}};}};
 const oldFetch=globalThis.fetch;try{globalThis.fetch=async()=>{calls++;return response(report);};const failed=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.notEqual(failed.status,202);assert.equal(calls,1);
  const row=f.db.prepare("SELECT state,error_code,result_json FROM yta_operations WHERE id=?").get(f.id+':groq-summary:'+f.plan.transcriptHash+':raw:0'),saved=JSON.parse(row.result_json);assert.equal(row.state,'FAILED_UNCERTAIN');assert.equal(row.error_code,'SUMMARY_RESULT_PERSISTENCE_UNCERTAIN');assert.equal(saved.reviewResult.partialText,raw);assert.equal(saved.reviewResult.usage.totalTokens,390);assert.equal(saved.reviewResult.responseComplete,true);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE job_id=? AND capability='LIVE_FREE_SUMMARY'").get(f.id).n,1);
  const again=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.notEqual(again.status,202);assert.equal(calls,1);
  const recoveryUrl=f.path+'/groq-summary-checkpoint-recovery',reviewReply=await routeApi(request(recoveryUrl),f.env);assert.equal(reviewReply.status,200,await reviewReply.clone().text());const review=await reviewReply.json();assert.equal(review.confirmedUsage.totalTokens,390);assert.equal(review.responseSha256,await digest(raw));
  const restored=await routeApi(request(recoveryUrl,'POST',{step:'recover',evidenceHash:review.evidenceHash,failedOperationId:review.failedOperationId,contractHash:review.contractHash,responseSha256:review.responseSha256,acknowledgeOriginalUsage:390,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}),f.env);assert.equal(restored.status,200,await restored.clone().text());assert.equal(calls,1);
  assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(f.id+':groq-summary:'+f.plan.transcriptHash+':raw:0').state,'FAILED_UNCERTAIN');assert.equal((await(await routeApi(request(recoveryUrl),f.env)).json()).recovered,true);
 }finally{globalThis.fetch=oldFetch;}
});

test('later raw persistence failure keeps original failure and admits separate zero-call checkpoint recovery',async()=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),audit=JSON.parse(f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(f.id).audit_json),groups=partitionGroqTranscript(f.segments,promptAudit({audit,duration_seconds:600})),index=10,group=groups[index],raw=JSON.stringify(valid(group[0].id)),stamp=new Date().toISOString(),operationId=f.id+':groq-summary:'+f.plan.transcriptHash+':raw:'+index;
 assert.ok(group);f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESULT_PERSISTENCE_UNCERTAIN',?)").run(operationId,f.id,stamp,JSON.stringify({reviewResult:{partialText:raw,usage:{inputTokens:300,outputTokens:90,reasoningTokens:10,totalTokens:390},responseComplete:true},usageRecorded:true}));
 const usageEventId=crypto.randomUUID();f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',390,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(usageEventId,f.id,stamp);f.db.prepare("UPDATE yta_operations SET result_json=json_set(result_json,'$.usageEventId',?) WHERE id=?").run(usageEventId,operationId);
 const url=f.path+'/groq-summary-checkpoint-recovery?stage=raw:'+index,reviewReply=await routeApi(request(url),f.env);assert.equal(reviewReply.status,200,await reviewReply.clone().text());const review=await reviewReply.json();assert.equal(review.stage,'raw:10');
 const restored=await routeApi(request(url,'POST',{step:'recover',evidenceHash:review.evidenceHash,failedOperationId:review.failedOperationId,contractHash:review.contractHash,responseSha256:review.responseSha256,acknowledgeOriginalUsage:390,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}),f.env);assert.equal(restored.status,200,await restored.clone().text());assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(operationId).state,'FAILED_UNCERTAIN');assert.equal((await(await routeApi(request(url),f.env)).json()).recovered,true);
 const statusReply=await routeApi(request(f.path+'/groq-summary-status'),f.env);assert.equal(statusReply.status,200,await statusReply.clone().text());const status=await statusReply.json();assert.equal(status.completedStages,1);assert.equal(status.activeStage,null);
});

test('raw:10 zero-call recovery permits fresh gap approval and raw:11 mock execution',async()=>{
 const {f,groups}=await reviewedGapFixture(),id=f.id,hash=f.plan.transcriptHash,stamp=new Date(Date.now()-120_000).toISOString(),usageEventId=crypto.randomUUID(),raw10Id=id+':groq-summary:'+hash+':raw:10';
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(id+':groq-summary:'+hash+':raw:9',id,stamp,JSON.stringify({hash,key:'raw:9',report:valid(groups[9][0].id)}));
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESULT_PERSISTENCE_UNCERTAIN',?)").run(raw10Id,id,stamp,JSON.stringify({reviewResult:{partialText:JSON.stringify(valid(groups[10][0].id)),usage:{inputTokens:300,outputTokens:90,reasoningTokens:10,totalTokens:390},responseComplete:true},usageRecorded:true,usageEventId}));
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',390,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(usageEventId,id,stamp);
 const recoveryUrl=f.path+'/groq-summary-checkpoint-recovery?stage=raw:10',review=await(await routeApi(request(recoveryUrl),f.env)).json();assert.equal(review.stage,'raw:10');
 const recovered=await routeApi(request(recoveryUrl,'POST',{step:'recover',evidenceHash:review.evidenceHash,failedOperationId:review.failedOperationId,contractHash:review.contractHash,responseSha256:review.responseSha256,acknowledgeOriginalUsage:390,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}),f.env);assert.equal(recovered.status,200,await recovered.clone().text());
 const gapUrl=f.path+'/groq-summary-gap',preview=await routeApi(request(gapUrl),f.env);assert.equal(preview.status,200,await preview.clone().text());const scope=await preview.json();assert.equal(scope.nextRawStage,'raw:11');
 const approved=await routeApi(request(gapUrl,'POST',{...scope,step:'approve',freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true,acknowledgeMissingRaw8:true,acknowledgeNoFinalReport:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());
 const oldFetch=globalThis.fetch;let calls=0;try{globalThis.fetch=async()=>{calls++;return response(valid(groups[11][0].id));};const next=await routeApi(request(gapUrl,'POST',{step:'execute',transcriptHash:hash,expectedStage:'raw:11',executeOnce:true}),f.env);assert.equal(next.status,202,await next.clone().text());assert.equal(calls,1);}finally{globalThis.fetch=oldFetch;}
 assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(raw10Id).state,'FAILED_UNCERTAIN');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE id=?').get(usageEventId).n,1);
});

test('recovered raw:0 remains failed while a separate synthesis approval executes one mock node',async()=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),id=f.id,hash=f.plan.transcriptHash,audit=JSON.parse(f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(id).audit_json),groups=partitionGroqTranscript(f.segments,promptAudit({audit,duration_seconds:600})),stamp=new Date(Date.now()-2*86_400_000).toISOString(),raw0Id=id+':groq-summary:'+hash+':raw:0';f.env.ENABLE_COMPLETE_SYNTHESIS='true';
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_CHECKPOINT_TOO_LARGE',?)").run(raw0Id,id,stamp,JSON.stringify({reviewResult:{partialText:JSON.stringify(valid(groups[0][0].id)),usage:{inputTokens:300,outputTokens:90,reasoningTokens:10,totalTokens:390}}}));
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',390,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),id,stamp);
 const recoveryUrl=f.path+'/groq-summary-checkpoint-recovery',review=await(await routeApi(request(recoveryUrl),f.env)).json();const recovered=await routeApi(request(recoveryUrl,'POST',{step:'recover',evidenceHash:review.evidenceHash,failedOperationId:review.failedOperationId,contractHash:review.contractHash,responseSha256:review.responseSha256,acknowledgeOriginalUsage:390,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}),f.env);assert.equal(recovered.status,200,await recovered.clone().text());
 for(let index=1;index<groups.length;index++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(id+':groq-summary:'+hash+':raw:'+index,id,stamp,JSON.stringify({hash,key:'raw:'+index,report:valid(groups[index][0].id)}));
 const url=f.path+'/groq-summary-complete',read=await routeApi(request(url),f.env);assert.equal(read.status,200,await read.clone().text());const scope=await read.json();assert.equal(scope.ready,true);
 const quoted=await routeApi(request(url,'POST',{step:'quote',sourceHash:hash,manifestSha256:scope.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),f.env);assert.equal(quoted.status,200,await quoted.clone().text());const quote=await quoted.json();
 const approved=await routeApi(request(url,'POST',{step:'approve',quoteId:quote.quoteId,quoteSha256:quote.quoteSha256,reservedUnits:quote.quote.reservedUnits,maxCalls:quote.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());const approval=await approved.json();
 const first=scope.finalizationReview?.next??null,oldFetch=globalThis.fetch;let calls=0;try{globalThis.fetch=async()=>{calls++;return response({summary:[{text:'가',evidenceIds:[groups[0][0].id]}],chapters:[{text:'가',evidenceIds:[groups[0][0].id]},{text:'가',evidenceIds:[groups[1][0].id]}],claims:[],numbers:[],critical:[],conclusion:'가'});};const execution=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,expectedNode:scope.nextSynthesisStage,requestSha256:scope.nextSynthesisRequestSha256,executeOnce:true}),f.env);assert.equal(execution.status,200,await execution.clone().text());assert.equal(calls,1);}finally{globalThis.fetch=oldFetch;}
 assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(raw0Id).state,'FAILED_UNCERTAIN');
});
test('a second owner job can run raw and synthesis after the first job recovers a stored synthesis response',async()=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),id=f.id,hash=f.plan.transcriptHash,audit=JSON.parse(f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(id).audit_json),groups=partitionGroqTranscript(f.segments,promptAudit({audit,duration_seconds:600})),stamp=new Date(Date.now()-2*86_400_000).toISOString(),url=f.path+'/groq-summary-complete',oldFetch=globalThis.fetch;f.env.ENABLE_COMPLETE_SYNTHESIS='true';
 try{
  for(let index=0;index<groups.length;index++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(id+':groq-summary:'+hash+':raw:'+index,id,stamp,JSON.stringify({hash,key:'raw:'+index,report:valid(groups[index][0].id)}));
  const scope=await(await routeApi(request(url),f.env)).json(),quoted=await(await routeApi(request(url,'POST',{step:'quote',sourceHash:hash,manifestSha256:scope.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),f.env)).json(),approved=await routeApi(request(url,'POST',{step:'approve',quoteId:quoted.quoteId,quoteSha256:quoted.quoteSha256,reservedUnits:quoted.quote.reservedUnits,maxCalls:quoted.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());const approval=await approved.json(),DB=f.env.DB;let injected=false,calls=0;
  f.env.DB={prepare(sql){const stmt=DB.prepare(sql);if(!sql.startsWith("UPDATE yta_operations SET state='DONE',result_json=?"))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async run(){if(!injected){injected=true;throw Error('SIMULATED_SYNTHESIS_CHECKPOINT_WRITE_FAILURE');}return bound.run();}};}};}};
  globalThis.fetch=async()=>{calls++;return response({summary:[{text:'가',evidenceIds:[groups[0][0].id]}],chapters:[{text:'가',evidenceIds:[groups[0][0].id]},{text:'가',evidenceIds:[groups[1][0].id]}],claims:[],numbers:[],critical:[],conclusion:'가'});};
  const attempted=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,expectedNode:scope.nextSynthesisStage,requestSha256:scope.nextSynthesisRequestSha256,executeOnce:true}),f.env);assert.notEqual(attempted.status,200);assert.equal(calls,1);f.env.DB=DB;
  const blocked=await(await routeApi(request(url),f.env)).json(),proof=blocked.recoveryCandidate;assert.ok(proof);const restored=await routeApi(request(url,'POST',{step:'recover-node',failedOperationId:proof.failedOperationId,responseSha256:proof.responseSha256,usageTotalTokens:proof.usageTotalTokens,confirmNoProviderCall:true,confirmOriginalFailurePreserved:true}),f.env);assert.equal(restored.status,200,await restored.clone().text());f.db.prepare('UPDATE yta_operations SET created_at=? WHERE id=?').run(stamp,proof.failedOperationId);const deleted=await routeApi(request(f.path,'DELETE'),f.env);assert.equal(deleted.status,200,await deleted.clone().text());assert.ok(f.db.prepare("SELECT result_json FROM yta_operations WHERE provider='groq-summary-settlement' AND job_id=?").get(id));
  const b=await sibling(f,{approve:false}),bPlan=await(await routeApi(request(b.path+'/groq-summary-plan'),f.env)).json(),reviewReply=await routeApi(request(b.path+'/groq-summary-approval'),f.env);assert.equal(reviewReply.status,200,await reviewReply.clone().text());const review=await reviewReply.json(),bApproval={...f.approval,jobId:b.id,transcriptHash:bPlan.transcriptHash,model:bPlan.model,outputKind:bPlan.outputKind,windowStart:bPlan.windowStart,totalRequests:bPlan.totalRequests,maxRequests:bPlan.maxRequests,maxInputTokensPerRequest:bPlan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:bPlan.maxCompletionTokensPerRequest,totalTokenUpperBound:bPlan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};assert.equal((await routeApi(request(b.path+'/groq-summary-approval','POST',bApproval),f.env)).status,200);
  globalThis.fetch=async()=>{calls++;return response(valid(groups[0][0].id));};const raw=await routeApi(request(b.path+'/groq-summary','POST',{}),f.env);assert.equal(raw.status,202,await raw.clone().text());assert.equal(calls,2);f.db.prepare("UPDATE yta_operations SET created_at=? WHERE id=?").run(stamp,b.id+':groq-summary:'+bPlan.transcriptHash+':raw:0');
  for(let index=1;index<groups.length;index++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(b.id+':groq-summary:'+bPlan.transcriptHash+':raw:'+index,b.id,stamp,JSON.stringify({hash:bPlan.transcriptHash,key:'raw:'+index,report:valid(groups[index][0].id)}));
  const bUrl=b.path+'/groq-summary-complete',bScope=await(await routeApi(request(bUrl),f.env)).json();assert.equal(bScope.ready,true);const bQuoted=await(await routeApi(request(bUrl,'POST',{step:'quote',sourceHash:bPlan.transcriptHash,manifestSha256:bScope.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),f.env)).json(),bApproved=await routeApi(request(bUrl,'POST',{step:'approve',quoteId:bQuoted.quoteId,quoteSha256:bQuoted.quoteSha256,reservedUnits:bQuoted.quote.reservedUnits,maxCalls:bQuoted.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}),f.env);assert.equal(bApproved.status,200,await bApproved.clone().text());const bSynthesisApproval=await bApproved.json();globalThis.fetch=async()=>{calls++;return response({summary:[{text:'가',evidenceIds:[groups[0][0].id]}],chapters:[{text:'가',evidenceIds:[groups[0][0].id]},{text:'가',evidenceIds:[groups[1][0].id]}],claims:[],numbers:[],critical:[],conclusion:'가'});};const bSynthesis=await routeApi(request(bUrl,'POST',{step:'execute',approvalId:bSynthesisApproval.approvalId,expectedNode:bScope.nextSynthesisStage,requestSha256:bScope.nextSynthesisRequestSha256,executeOnce:true}),f.env);assert.equal(bSynthesis.status,200,await bSynthesis.clone().text());assert.equal(calls,3);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});
test('a recovered raw persistence failure releases a second owner job without erasing usage',async()=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),DB=f.env.DB,oldFetch=globalThis.fetch,stamp=new Date(Date.now()-2*86_400_000).toISOString();let calls=0,failed=false;
 try{
  f.env.DB={prepare(sql){const stmt=DB.prepare(sql);if(!sql.startsWith('UPDATE yta_operations SET state=?,result_json=?,created_at=? WHERE id=? AND state=? AND EXISTS'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async run(){if(!failed){failed=true;throw Error('SIMULATED_RAW_CHECKPOINT_WRITE_FAILURE');}return bound.run();}};}};}};
  globalThis.fetch=async()=>{calls++;return response(valid(f.segments[0].id));};
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
  const attempted=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.notEqual(attempted.status,202);assert.equal(calls,1);f.env.DB=DB;
  const recoveryUrl=f.path+'/groq-summary-checkpoint-recovery',proof=await(await routeApi(request(recoveryUrl),f.env)).json();assert.ok(proof.evidenceHash);
  const recovered=await routeApi(request(recoveryUrl,'POST',{step:'recover',evidenceHash:proof.evidenceHash,failedOperationId:proof.failedOperationId,contractHash:proof.contractHash,responseSha256:proof.responseSha256,acknowledgeOriginalUsage:proof.confirmedUsage.totalTokens,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}),f.env);assert.equal(recovered.status,200,await recovered.clone().text());
  f.db.prepare('UPDATE yta_operations SET created_at=? WHERE id=?').run(stamp,proof.failedOperationId);
  const deleted=await routeApi(request(f.path,'DELETE'),f.env);assert.equal(deleted.status,200,await deleted.clone().text());assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yta_sources WHERE job_id=?').get(f.id).n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE id=?').get(f.id).n,0);const settlement=f.db.prepare("SELECT result_json FROM yta_operations WHERE provider='groq-summary-settlement' AND job_id=?").get(f.id);assert.ok(settlement);assert.ok(!settlement.result_json.includes('원문 검증'));

  const b=await sibling(f,{approve:false}),plan=await(await routeApi(request(b.path+'/groq-summary-plan'),f.env)).json(),review=await(await routeApi(request(b.path+'/groq-summary-approval'),f.env)).json(),approval={...f.approval,jobId:b.id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};assert.equal((await routeApi(request(b.path+'/groq-summary-approval','POST',approval),f.env)).status,200);
  const run=await routeApi(request(b.path+'/groq-summary','POST',{}),f.env);assert.equal(run.status,202,await run.clone().text());assert.equal(calls,2);
  assert.equal(f.db.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').get(proof.failedOperationId).state,'FAILED_UNCERTAIN');assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(proof.failedOperationId).result_json,null);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE job_id=?').get(f.id).n,1);
  const c=await sibling(f,{approve:false}),settlementId=proof.failedOperationId+':settled',original=f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(settlementId).result_json;f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(original),ownerId:'another-owner'}),settlementId);assert.equal((await routeApi(request(c.path+'/groq-summary-approval'),f.env)).status,409);f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(original,settlementId);f.db.prepare('UPDATE usage_events SET used_units=391 WHERE job_id=?').run(f.id);assert.equal((await routeApi(request(c.path+'/groq-summary-approval'),f.env)).status,409);f.db.prepare('UPDATE usage_events SET used_units=390 WHERE job_id=?').run(f.id);f.env.GROQ_API_KEY='ROTATED_TEST_KEY';assert.equal((await routeApi(request(c.path+'/groq-summary-approval'),f.env)).status,409);
 }finally{globalThis.fetch=oldFetch;f.env.DB=DB;f.db.close();}
});
for(const reviewed of [true,false])test(`deleted raw:8 excerpt and correction usage ${reviewed?'release':'retain'} the next-job lock`,async()=>{
 const {f,groups}=await reviewedGapFixture(),stamp=new Date(Date.now()-2*86_400_000).toISOString(),url=f.path+'/groq-summary-complete';f.env.ENABLE_COMPLETE_SYNTHESIS='true';let calls=0;const oldFetch=globalThis.fetch;
 try{
  if(reviewed){const evidence=await(await routeApi(request(url+'?stage=raw:8'),f.env)).json();assert.equal((await routeApi(request(url,'POST',{step:'register-excerpt',stage:'raw:8',sourceHash:evidence.sourceHash,auditSha256:evidence.auditSha256,recordSha256:evidence.recordSha256,selectedIds:evidence.selectedIds,confirmExactSourceExcerpt:true,confirmNotAiSummary:true,confirmPriorFailureAndUsagePreserved:true}),f.env)).status,200);const after=await(await routeApi(request(url+'?stage=raw:8'),f.env)).json(),disposition=after.disposition;assert.equal((await routeApi(request(url,'POST',{step:'review-failure-usage',stage:'raw:8',sourceHash:after.sourceHash,auditSha256:disposition.auditSha256,recordSha256:disposition.recordSha256,confirmSeparateFromContent:true,acknowledgeReceiptNotVerified:true,acknowledgeAccountBalanceUnknown:true,acknowledgeConservativeReservation:true,noRetry:true}),f.env)).status,200);}
  const b=await sibling(f,{approve:false}),liveReview=await routeApi(request(b.path+'/groq-summary-approval'),f.env);assert.equal(liveReview.status,reviewed?200:409,await liveReview.clone().text());if(reviewed){const usage=f.db.prepare("SELECT id,used_units FROM usage_events WHERE job_id=? AND provenance='PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN'").get(f.id);f.db.prepare('UPDATE usage_events SET used_units=? WHERE id=?').run(usage.used_units+1,usage.id);assert.equal((await routeApi(request(b.path+'/groq-summary-approval'),f.env)).status,409);f.db.prepare('UPDATE usage_events SET used_units=? WHERE id=?').run(usage.used_units,usage.id);}
  const deleted=await routeApi(request(f.path,'DELETE'),f.env);assert.equal(deleted.status,200,await deleted.clone().text());const settled=f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider='groq-summary-settlement'").get(f.id).n;assert.equal(settled,reviewed?2:0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE job_id=?').get(f.id).n,2);
  const plan=await(await routeApi(request(b.path+'/groq-summary-plan'),f.env)).json(),reviewReply=await routeApi(request(b.path+'/groq-summary-approval'),f.env);assert.equal(reviewReply.status,reviewed?200:409,await reviewReply.clone().text());if(!reviewed){assert.equal(calls,0);return;}const review=await reviewReply.json(),approval={...f.approval,jobId:b.id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};assert.equal((await routeApi(request(b.path+'/groq-summary-approval','POST',approval),f.env)).status,200);
  globalThis.fetch=async()=>{calls++;return response(valid(groups[0][0].id));};const run=await routeApi(request(b.path+'/groq-summary','POST',{}),f.env);assert.equal(run.status,202,await run.clone().text());assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});
test('deleted legacy pilot and oversized raw:0 recovery retain only two usage settlements',async()=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),stamp=new Date(Date.now()-2*86_400_000).toISOString(),job=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),audit=JSON.parse(job.audit_json),groups=partitionGroqTranscript(f.segments,promptAudit({audit,duration_seconds:job.duration_seconds})),source=f.db.prepare('SELECT raw FROM yta_sources WHERE job_id=?').get(f.id),legacyHash=await digest([source.raw,f.segments,audit.audioFileSha256,promptAudit({audit,duration_seconds:job.duration_seconds})]),newId=f.id+':groq-summary:'+f.plan.transcriptHash+':raw:0',oldId=f.id+':groq-summary:'+legacyHash+':raw:0';const oldFetch=globalThis.fetch;let calls=0;
 try{
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_CHECKPOINT_TOO_LARGE',?)").run(newId,f.id,stamp,JSON.stringify({reviewResult:{partialText:JSON.stringify(valid(groups[0][0].id)),usage:{inputTokens:300,outputTokens:90,reasoningTokens:10,totalTokens:390}}}));
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(oldId,f.id,stamp,JSON.stringify({reviewResult:{partialText:'{"summary":"old schema"}',usage:{inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220}}}));
  for(const [units,id] of [[390,'new'],[2220,'old']])f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',?,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(f.id+':usage:'+id,f.id,units,stamp);
  for(const [kind,state] of [['review','REVIEWED'],['approval','APPROVED']])f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(f.id+':groq-summary-pilot:'+kind+':'+legacyHash,f.id,'groq-summary-pilot-'+kind,0,state,stamp,'{}');
  const recoveryUrl=f.path+'/groq-summary-checkpoint-recovery',proof=await(await routeApi(request(recoveryUrl),f.env)).json();assert.equal(proof.legacyEvidence.failedOperationId,oldId);const restored=await routeApi(request(recoveryUrl,'POST',{step:'recover',evidenceHash:proof.evidenceHash,failedOperationId:newId,contractHash:f.plan.transcriptHash,responseSha256:proof.responseSha256,acknowledgeOriginalUsage:390,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}),f.env);assert.equal(restored.status,200,await restored.clone().text());
  const b=await sibling(f,{approve:false}),liveReview=await routeApi(request(b.path+'/groq-summary-approval'),f.env);assert.equal(liveReview.status,200,await liveReview.clone().text());
  const deleted=await routeApi(request(f.path,'DELETE'),f.env);assert.equal(deleted.status,200,await deleted.clone().text());assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider='groq-summary-settlement'").get(f.id).n,2);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND state='FAILED_UNCERTAIN' AND result_json IS NULL").get(f.id).n,2);
  const plan=await(await routeApi(request(b.path+'/groq-summary-plan'),f.env)).json(),review=await(await routeApi(request(b.path+'/groq-summary-approval'),f.env)).json(),approval={...f.approval,jobId:b.id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};assert.equal((await routeApi(request(b.path+'/groq-summary-approval','POST',approval),f.env)).status,200);globalThis.fetch=async()=>{calls++;return response(valid(groups[0][0].id));};assert.equal((await routeApi(request(b.path+'/groq-summary','POST',{}),f.env)).status,202);assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});
test('deleted settled failure permits a separate reviewed gap approval and dispatch',async()=>{
 const {f,groups}=await reviewedGapFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  await seedDeletedOversizeRecovery(f);
  const url=f.path+'/groq-summary-gap',read=await routeApi(request(url),f.env);assert.equal(read.status,200,await read.clone().text());const scope=await read.json();
  const approved=await routeApi(request(url,'POST',{...scope,step:'approve',freeTierConfirmed:true,billingDisabled:true,unknownBalanceAcknowledged:true,noPaidFallback:true,noGeminiFallback:true,summaryOnly:true,acknowledgeMissingRaw8:true,acknowledgeNoFinalReport:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());
  globalThis.fetch=async()=>{calls++;return response(valid(groups[9][0].id));};
  const sent=await routeApi(request(url,'POST',{step:'execute',transcriptHash:scope.transcriptHash,expectedStage:'raw:9',executeOnce:true}),f.env);assert.equal(sent.status,202,await sent.clone().text());assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});
test('deleted settled failure permits a separate raw:8 correction dispatch',async()=>{
 const {f,group,url,approval}=await approvedCorrectionFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  await seedDeletedOversizeRecovery(f);
  globalThis.fetch=async()=>{calls++;return response(valid(group[0].id));};
  const sent=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(sent.status,202,await sent.clone().text());assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});
test('real raw handler leaves no claim when preflight cannot reserve the 51st D1 query',async t=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),oldFetch=globalThis.fetch;let calls=0,queries=0,attempted51=false;
 try{
  assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',f.approval),f.env)).status,200);
  for(let i=0;i<3;i++)await seedDeletedOversizeRecovery(f,{deleteAfter:false});
  const base=f.env.DB;f.env.DB={prepare(sql){const stmt=base.prepare(sql);const wrap=bound=>({bind(...args){return wrap(bound.bind(...args));},async first(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.first();},async all(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.all();},async run(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.run();}});return wrap(stmt);}};
  globalThis.fetch=async()=>{calls++;return response(valid(f.segments[0].id));};
  const sent=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(sent.status,409,await sent.clone().text());assert.equal((await sent.json()).error.code,'GROQ_D1_BUDGET');assert.equal(attempted51,false);assert.ok(queries<=50);assert.equal(calls,0);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND state='CLAIMED'").get(f.id).n,0);t.diagnostic(`raw preflight stopped after ${queries} D1 queries`);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});
test('real synthesis handler leaves no claim when preflight cannot reserve the 51st D1 query',async t=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),oldFetch=globalThis.fetch;f.env.ENABLE_COMPLETE_SYNTHESIS='true';let calls=0,queries=0,attempted51=false;
 try{
  const audit=JSON.parse(f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(f.id).audit_json),groups=partitionGroqTranscript(f.segments,promptAudit({audit,duration_seconds:600})),stamp=new Date(Date.now()-2*86_400_000).toISOString();
  for(let i=0;i<groups.length;i++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(f.id+':groq-summary:'+f.plan.transcriptHash+':raw:'+i,f.id,stamp,JSON.stringify({hash:f.plan.transcriptHash,key:'raw:'+i,report:valid(groups[i][0].id)}));
  const url=f.path+'/groq-summary-complete',scope=await(await routeApi(request(url),f.env)).json(),quoted=await(await routeApi(request(url,'POST',{step:'quote',sourceHash:f.plan.transcriptHash,manifestSha256:scope.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),f.env)).json(),approved=await routeApi(request(url,'POST',{step:'approve',quoteId:quoted.quoteId,quoteSha256:quoted.quoteSha256,reservedUnits:quoted.quote.reservedUnits,maxCalls:quoted.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());const approval=await approved.json();
  for(let i=0;i<3;i++)await seedDeletedOversizeRecovery(f,{deleteAfter:false});
  const base=f.env.DB;f.env.DB={prepare(sql){const stmt=base.prepare(sql);const wrap=bound=>({bind(...args){return wrap(bound.bind(...args));},async first(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.first();},async all(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.all();},async run(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.run();}});return wrap(stmt);}};
  globalThis.fetch=async()=>{calls++;throw Error('provider must stay idle');};
  const sent=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,expectedNode:scope.nextSynthesisStage,requestSha256:scope.nextSynthesisRequestSha256,executeOnce:true}),f.env);assert.equal(sent.status,409,await sent.clone().text());assert.equal((await sent.json()).error.code,'GROQ_D1_BUDGET');assert.equal(attempted51,false);assert.ok(queries<=50);assert.equal(calls,0);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider='groq-summary-synthesis' AND state='CLAIMED'").get(f.id).n,0);t.diagnostic(`synthesis preflight stopped after ${queries} D1 queries`);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

function tamperBeforeLiveFinalGuard(f,mutate){
 const DB=f.env.DB;let injected=false;
 f.env.DB={prepare(sql){const stmt=DB.prepare(sql);if(!sql.startsWith('WITH live_resolution_proof AS MATERIALIZED'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async first(){if(!injected){injected=true;await mutate();}return bound.first();}};}};}};
 return ()=>{f.env.DB=DB;assert.equal(injected,true,'final D1 proof guard must run');};
}

test('live recovered failure permits another raw job, but proof tamper at final D1 guard blocks dispatch',async()=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),oldFetch=globalThis.fetch;let calls=0;
 try{
  const a=await seedDeletedOversizeRecovery(f,{deleteAfter:false});
  const b=await sibling(f,{approve:false}),plan=await(await routeApi(request(b.path+'/groq-summary-plan'),f.env)).json(),reviewReply=await routeApi(request(b.path+'/groq-summary-approval'),f.env);assert.equal(reviewReply.status,200,await reviewReply.clone().text());const review=await reviewReply.json();
  const approval={...f.approval,jobId:b.id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};
  assert.equal((await routeApi(request(b.path+'/groq-summary-approval','POST',approval),f.env)).status,200);
  globalThis.fetch=async()=>{calls++;return response(valid(f.segments[0].id));};
  const first=await routeApi(request(b.path+'/groq-summary','POST',{}),f.env);assert.equal(first.status,202,await first.clone().text());assert.equal(calls,1);
  f.db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary' AND state='DONE'").run(new Date(Date.now()-120000).toISOString(),b.id);
  const c=await sibling(f);const restore=tamperBeforeLiveFinalGuard(f,()=>f.db.prepare('UPDATE usage_events SET used_units=391 WHERE id=?').run(a.id+':usage'));
  try{const blocked=await routeApi(request(c.path+'/groq-summary','POST',{}),f.env);assert.equal(blocked.status,409,await blocked.clone().text());assert.equal(calls,1);assert.equal(f.db.prepare("SELECT state FROM yta_operations WHERE job_id=? AND provider='groq-summary' AND state='BLOCKED'").get(c.id)?.state,'BLOCKED');}finally{restore();}
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('live recovery tamper at correction final D1 guard blocks provider',async()=>{
 const {f,group,url,approval}=await approvedCorrectionFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const a=await seedDeletedOversizeRecovery(f,{deleteAfter:false});
  const restore=tamperBeforeLiveFinalGuard(f,()=>f.db.prepare('UPDATE usage_events SET used_units=391 WHERE id=?').run(a.id+':usage'));
  globalThis.fetch=async()=>{calls++;return response(valid(group[0].id));};
  try{const blocked=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(blocked.status,409,await blocked.clone().text());assert.equal(calls,0);}finally{restore();}
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('live recovery tamper at synthesis final D1 guard blocks provider',async()=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),oldFetch=globalThis.fetch;f.env.ENABLE_COMPLETE_SYNTHESIS='true';let calls=0;
 try{
  const audit=JSON.parse(f.db.prepare('SELECT audit_json FROM jobs WHERE id=?').get(f.id).audit_json),groups=partitionGroqTranscript(f.segments,promptAudit({audit,duration_seconds:600})),stamp=new Date(Date.now()-2*86_400_000).toISOString();
  for(let i=0;i<groups.length;i++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(f.id+':groq-summary:'+f.plan.transcriptHash+':raw:'+i,f.id,stamp,JSON.stringify({hash:f.plan.transcriptHash,key:'raw:'+i,report:valid(groups[i][0].id)}));
  const url=f.path+'/groq-summary-complete',scope=await(await routeApi(request(url),f.env)).json(),quoted=await(await routeApi(request(url,'POST',{step:'quote',sourceHash:f.plan.transcriptHash,manifestSha256:scope.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),f.env)).json(),approved=await routeApi(request(url,'POST',{step:'approve',quoteId:quoted.quoteId,quoteSha256:quoted.quoteSha256,reservedUnits:quoted.quote.reservedUnits,maxCalls:quoted.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());const approval=await approved.json();
  const a=await seedDeletedOversizeRecovery(f,{deleteAfter:false}),restore=tamperBeforeLiveFinalGuard(f,()=>f.db.prepare('UPDATE usage_events SET used_units=391 WHERE id=?').run(a.id+':usage'));
  globalThis.fetch=async()=>{calls++;throw Error('provider must stay idle');};
  try{const blocked=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,expectedNode:scope.nextSynthesisStage,requestSha256:scope.nextSynthesisRequestSha256,executeOnce:true}),f.env);assert.equal(blocked.status,409,await blocked.clone().text());assert.equal(calls,0);}finally{restore();}
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('live reviewed raw:8 and corrective failures use each operation reservation for next raw dispatch',async()=>{
 const {f,groups,approval}=await reviewedGapFixture(),oldFetch=globalThis.fetch;f.env.ENABLE_COMPLETE_SYNTHESIS='true';let calls=0;
 try{
  const url=f.path+'/groq-summary-complete',evidence=await(await routeApi(request(url+'?stage=raw:8'),f.env)).json();assert.equal((await routeApi(request(url,'POST',{step:'register-excerpt',stage:'raw:8',sourceHash:evidence.sourceHash,auditSha256:evidence.auditSha256,recordSha256:evidence.recordSha256,selectedIds:evidence.selectedIds,confirmExactSourceExcerpt:true,confirmNotAiSummary:true,confirmPriorFailureAndUsagePreserved:true}),f.env)).status,200);const after=await(await routeApi(request(url+'?stage=raw:8'),f.env)).json(),disposition=after.disposition;assert.equal((await routeApi(request(url,'POST',{step:'review-failure-usage',stage:'raw:8',sourceHash:after.sourceHash,auditSha256:disposition.auditSha256,recordSha256:disposition.recordSha256,confirmSeparateFromContent:true,acknowledgeReceiptNotVerified:true,acknowledgeAccountBalanceUnknown:true,acknowledgeConservativeReservation:true,noRetry:true}),f.env)).status,200);
  const originalUnits=f.db.prepare('SELECT units FROM yta_operations WHERE id=?').get(approval.attemptId).units;assert.notEqual(originalUnits,f.db.prepare("SELECT units FROM yta_operations WHERE job_id=? AND state='FAILED_UNCERTAIN' AND id!=?").get(f.id,approval.attemptId).units);
  const b=await sibling(f,{approve:false}),plan=await(await routeApi(request(b.path+'/groq-summary-plan'),f.env)).json(),reviewReply=await routeApi(request(b.path+'/groq-summary-approval'),f.env);assert.equal(reviewReply.status,200,await reviewReply.clone().text());const review=await reviewReply.json(),bApproval={...f.approval,jobId:b.id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};assert.equal((await routeApi(request(b.path+'/groq-summary-approval','POST',bApproval),f.env)).status,200);
  globalThis.fetch=async()=>{calls++;return response(valid(groups[0][0].id));};const sent=await routeApi(request(b.path+'/groq-summary','POST',{}),f.env);assert.equal(sent.status,202,await sent.clone().text());assert.equal(calls,1);
  const proof=await globallyRecoveredGroq(f.env,b.id),corrective=proof.liveResolutionProofs.find(item=>item.failedId===approval.attemptId);assert.equal(corrective.failedUnits,originalUnits);assert.equal(proof.liveResolutionProofs.length,2);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('settling a live recovery at final guard blocks stale dispatch and permits a fresh job',async()=>{
 const f=await fixture({large:true,sourceText:'가'.repeat(350)}),oldFetch=globalThis.fetch;let calls=0;
 try{
  const a=await seedDeletedOversizeRecovery(f,{deleteAfter:false}),b=await sibling(f);
  globalThis.fetch=async()=>{calls++;return response(valid(f.segments[0].id));};
  const restore=tamperBeforeLiveFinalGuard(f,async()=>{const deleted=await routeApi(request(a.path,'DELETE'),f.env);assert.equal(deleted.status,200,await deleted.clone().text());});
  try{const blocked=await routeApi(request(b.path+'/groq-summary','POST',{}),f.env);assert.equal(blocked.status,409,await blocked.clone().text());assert.equal(calls,0);}finally{restore();}
  const c=await sibling(f),sent=await routeApi(request(c.path+'/groq-summary','POST',{}),f.env);assert.equal(sent.status,202,await sent.clone().text());assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

for(const write of ['usage-before','usage-after','checkpoint-before','checkpoint-after'])test(`raw:8 correction retains provider response when ${write} fails`,async()=>{
 const {f,url,approval,group,failedId,oldResult}=await approvedCorrectionFixture(),oldFetch=globalThis.fetch,DB=f.env.DB;let calls=0,injected=false;
 const body=valid(group[0].id),rawResponse=JSON.stringify(body);
 try{
  f.env.DB={prepare(sql){const stmt=DB.prepare(sql),target=write.startsWith('usage')?sql.startsWith('INSERT INTO usage_events'):sql.startsWith("UPDATE yta_operations SET state='DONE'");if(!target)return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async run(){if(!injected){injected=true;if(write.endsWith('after'))await bound.run();throw Error('SIMULATED_CORRECTION_WRITE_REPLY_LOSS');}return bound.run();}};}};}};
  globalThis.fetch=async()=>{calls++;return response(body);};
  const sent=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env),row=f.db.prepare('SELECT state,error_code,result_json FROM yta_operations WHERE id=?').get(approval.attemptId);assert.equal(injected,true);assert.equal(calls,1);
  if(write==='checkpoint-after'){assert.equal(sent.status,202,await sent.clone().text());assert.equal(row.state,'DONE');assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(approval.approvalId).state,'APPROVED');}
  else{assert.equal(sent.status,500,await sent.clone().text());assert.equal(row.state,'FAILED_UNCERTAIN');assert.equal(row.error_code,'SUMMARY_RESULT_PERSISTENCE_UNCERTAIN');const saved=JSON.parse(row.result_json);assert.equal(saved.reviewResult.partialText,rawResponse);assert.equal(saved.reviewResult.usage.totalTokens,390);assert.equal(saved.reviewResult.responseComplete,true);assert.equal(saved.usageRecorded,true);assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(approval.approvalId).state,'STOPPED');}
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE job_id=? AND provenance LIKE 'PROVIDER_REPORTED_CORRECTIVE%'").get(f.id).n,1);assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(failedId).result_json,oldResult);
  assert.equal((await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env)).status,409);assert.equal(calls,1);
 }finally{f.env.DB=DB;globalThis.fetch=oldFetch;f.db.close();}
});

test('raw:8 correction recovers a complete saved response without another provider call',async()=>{
 const {f,url,approval,group,failedId,oldResult}=await approvedCorrectionFixture(),oldFetch=globalThis.fetch,DB=f.env.DB;let calls=0,injected=false;
 try{
  f.env.DB={prepare(sql){const stmt=DB.prepare(sql);if(!sql.startsWith("UPDATE yta_operations SET state='DONE'"))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async run(){if(!injected){injected=true;throw Error('SIMULATED_CORRECTION_CHECKPOINT_FAILURE');}return bound.run();}};}};}};
  globalThis.fetch=async()=>{calls++;return response(valid(group[0].id));};
  const sent=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(sent.status,500);assert.equal(calls,1);f.env.DB=DB;
  const reviewReply=await routeApi(request(url),f.env);assert.equal(reviewReply.status,200,await reviewReply.clone().text());const candidate=(await reviewReply.json()).recoveryCandidate;assert.ok(candidate);
  const recovered=await routeApi(request(url,'POST',{step:'recover',failedOperationId:approval.attemptId,responseSha256:candidate.responseSha256,recordSha256:candidate.recordSha256,usageTotalTokens:candidate.usageTotalTokens,confirmNoProviderCall:true,confirmOriginalFailurePreserved:true}),f.env);assert.equal(recovered.status,200,await recovered.clone().text());assert.equal(calls,1);
  assert.equal(f.db.prepare('SELECT state,error_code FROM yta_operations WHERE id=?').get(approval.attemptId).state,'FAILED_UNCERTAIN');assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(failedId).result_json,oldResult);const resolution=await globallyRecoveredGroq(f.env,f.id,{includeCurrent:true});assert.deepEqual(new Set(resolution.liveResolutionProofs.map(item=>item.failedId)),new Set([failedId,approval.attemptId]));
  const status=await routeApi(request(f.path+'/groq-summary-status'),f.env);assert.equal(status.status,200,await status.clone().text());assert.equal((await status.json()).correctionAttempt,null);
  f.env.ENABLE_COMPLETE_SYNTHESIS='true';const complete=await routeApi(request(f.path+'/groq-summary-complete'),f.env);assert.equal(complete.status,200,await complete.clone().text());assert.equal((await complete.json()).completedRawStages,1);
  const repeated=await routeApi(request(url,'POST',{step:'recover',failedOperationId:approval.attemptId,responseSha256:candidate.responseSha256,recordSha256:candidate.recordSha256,usageTotalTokens:candidate.usageTotalTokens,confirmNoProviderCall:true,confirmOriginalFailurePreserved:true}),f.env);assert.equal(repeated.status,200,await repeated.clone().text());assert.equal(calls,1);
 }finally{f.env.DB=DB;globalThis.fetch=oldFetch;f.db.close();}
});

test('full-scale correction reserves D1 writes before the one provider call',async t=>{
 const {f,url,approval,group}=await approvedCorrectionFixture({fullScale:true}),oldFetch=globalThis.fetch,DB=f.env.DB;let calls=0,queries=0,attempted51=false;
 try{
  f.env.DB={prepare(sql){const stmt=DB.prepare(sql);const wrap=bound=>({bind(...args){return wrap(bound.bind(...args));},async first(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.first();},async all(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.all();},async run(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.run();}});return wrap(stmt);}};
  globalThis.fetch=async()=>{calls++;return response(valid(group[0].id));};
  const sent=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(attempted51,false);assert.ok(queries<=50);assert.equal(sent.status,202,await sent.clone().text());assert.equal(calls,1);t.diagnostic(`full-scale correction used ${queries} D1 queries`);
 }finally{f.env.DB=DB;globalThis.fetch=oldFetch;f.db.close();}
});

test('full-scale correction stops before claim when D1 failure-write reserve cannot fit',async t=>{
 const {f,url,approval}=await approvedCorrectionFixture({fullScale:true}),oldFetch=globalThis.fetch,DB=f.env.DB;let calls=0,queries=0,attempted51=false;
 try{
  const originalSegments=f.segments;f.segments=Array.from({length:25},(_,i)=>({id:i+1,startMs:i*24000,endMs:(i+1)*24000,text:'가'.repeat(350)}));for(let i=0;i<3;i++)await seedDeletedOversizeRecovery(f,{deleteAfter:false});f.segments=originalSegments;
  f.env.DB={prepare(sql){const stmt=DB.prepare(sql);const wrap=bound=>({bind(...args){return wrap(bound.bind(...args));},async first(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.first();},async all(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.all();},async run(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.run();}});return wrap(stmt);}};
  globalThis.fetch=async()=>{calls++;throw Error('provider must stay idle');};
  const sent=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(sent.status,409,await sent.clone().text());assert.equal((await sent.json()).error.code,'GROQ_D1_BUDGET');assert.equal(attempted51,false);assert.ok(queries<=50);assert.equal(calls,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yta_operations WHERE id=?').get(approval.attemptId).n,0);t.diagnostic(`correction preflight stopped after ${queries} D1 queries`);
 }finally{f.env.DB=DB;globalThis.fetch=oldFetch;f.db.close();}
});

test('raw:8 correction no-call recovery rejects changed usage and failed response evidence',async()=>{
 const {f,url,approval,group}=await approvedCorrectionFixture(),oldFetch=globalThis.fetch,DB=f.env.DB;let calls=0,injected=false;
 try{
  f.env.DB={prepare(sql){const stmt=DB.prepare(sql);if(!sql.startsWith("UPDATE yta_operations SET state='DONE'"))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async run(){if(!injected){injected=true;throw Error('SIMULATED_CHECKPOINT_FAILURE');}return bound.run();}};}};}};
  globalThis.fetch=async()=>{calls++;return response(valid(group[0].id));};assert.equal((await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env)).status,500);f.env.DB=DB;
  const candidate=(await(await routeApi(request(url),f.env)).json()).recoveryCandidate;assert.ok(candidate);const recover=()=>routeApi(request(url,'POST',{step:'recover',failedOperationId:approval.attemptId,responseSha256:candidate.responseSha256,recordSha256:candidate.recordSha256,usageTotalTokens:candidate.usageTotalTokens,confirmNoProviderCall:true,confirmOriginalFailurePreserved:true}),f.env);
  f.db.prepare('UPDATE usage_events SET used_units=used_units+1 WHERE id=?').run(candidate.usageEventId);assert.equal((await recover()).status,409);f.db.prepare('UPDATE usage_events SET used_units=used_units-1 WHERE id=?').run(candidate.usageEventId);
  const failure=f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(approval.attemptId).result_json;f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(failure+' ',approval.attemptId);assert.equal((await recover()).status,409);f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(failure,approval.attemptId);
  assert.equal((await recover()).status,200);assert.equal(calls,1);
 }finally{f.env.DB=DB;globalThis.fetch=oldFetch;f.db.close();}
});

test('full-scale correction reconciles a lost usage write within D1 budget',async t=>{
 const {f,url,approval,group}=await approvedCorrectionFixture({fullScale:true}),DB=f.env.DB,oldFetch=globalThis.fetch;let calls=0,queries=0,injected=false,attempted51=false;
 try{
  f.env.DB={prepare(sql){const stmt=DB.prepare(sql),wrap=bound=>({bind(...args){return wrap(bound.bind(...args));},async first(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.first();},async all(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.all();},async run(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}if(!injected&&sql.startsWith('INSERT INTO usage_events')){injected=true;throw Error('SIMULATED_USAGE_WRITE_FAILURE');}return bound.run();}});return wrap(stmt);}};
  globalThis.fetch=async()=>{calls++;return response(valid(group[0].id));};
  const sent=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env),row=f.db.prepare('SELECT state,error_code,result_json FROM yta_operations WHERE id=?').get(approval.attemptId);assert.equal(sent.status,500);assert.equal(injected,true);assert.equal(attempted51,false);assert.ok(queries<=50);assert.equal(calls,1);assert.equal(row.state,'FAILED_UNCERTAIN');assert.equal(JSON.parse(row.result_json).reviewResult.responseComplete,true);assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(approval.approvalId).state,'STOPPED');t.diagnostic(`full-scale failed correction used ${queries} D1 queries`);
 }finally{f.env.DB=DB;globalThis.fetch=oldFetch;f.db.close();}
});

async function recoveredCorrectionFixture({fullScale=false,beforeCorrection=null}={}){
 const setup=await approvedCorrectionFixture({fullScale}),{f,group,url,approval}=setup,job=f.db.prepare('SELECT audit_json,duration_seconds FROM jobs WHERE id=?').get(f.id),groups=partitionGroqTranscript(f.segments,promptAudit({audit:JSON.parse(job.audit_json),duration_seconds:job.duration_seconds})),stamp=new Date(Date.now()-120000).toISOString(),DB=f.env.DB,oldFetch=globalThis.fetch;let calls=0,injected=false;
 try{
  for(let i=0;i<8;i++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(f.id+':groq-summary:'+f.plan.transcriptHash+':raw:'+i,f.id,stamp,JSON.stringify({hash:f.plan.transcriptHash,key:'raw:'+i,report:valid(groups[i][0].id)}));
  const earlier=beforeCorrection?await beforeCorrection({f,groups,stamp,job}):null;
  f.env.DB={prepare(sql){const stmt=DB.prepare(sql);if(!sql.startsWith("UPDATE yta_operations SET state='DONE'"))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async run(){if(!injected){injected=true;throw Error('SIMULATED_CHECKPOINT_FAILURE');}return bound.run();}};}};}};
  globalThis.fetch=async()=>{calls++;return response(valid(group[0].id));};const sent=await routeApi(request(url,'POST',{step:'execute',approvalId:approval.approvalId,confirmExecuteOnce:true}),f.env);assert.equal(sent.status,500,await sent.clone().text());assert.equal(calls,1);f.env.DB=DB;
  const candidate=(await(await routeApi(request(url),f.env)).json()).recoveryCandidate;assert.ok(candidate);const recovered=await routeApi(request(url,'POST',{step:'recover',failedOperationId:approval.attemptId,responseSha256:candidate.responseSha256,recordSha256:candidate.recordSha256,usageTotalTokens:candidate.usageTotalTokens,confirmNoProviderCall:true,confirmOriginalFailurePreserved:true}),f.env);assert.equal(recovered.status,200,await recovered.clone().text());f.db.prepare('UPDATE yta_operations SET created_at=? WHERE id=?').run(stamp,approval.attemptId);return {...setup,groups,calls,earlier};
 }finally{f.env.DB=DB;globalThis.fetch=oldFetch;}
}

async function mixedRecoveredCorrectionFixture(){
 const {f,groups,approval,failedId,earlier}=await recoveredCorrectionFixture({beforeCorrection:async({f,groups,stamp,job})=>{
  const audit=JSON.parse(job.audit_json),hash=f.plan.transcriptHash,source=f.db.prepare('SELECT raw FROM yta_sources WHERE job_id=?').get(f.id),legacyHash=await digest([source.raw,f.segments,audit.audioFileSha256,promptAudit({audit,duration_seconds:job.duration_seconds})]),raw0Id=f.id+':groq-summary:'+hash+':raw:0',legacyId=f.id+':groq-summary:'+legacyHash+':raw:0';
  f.db.prepare("UPDATE yta_operations SET state='FAILED_UNCERTAIN',error_code='SUMMARY_CHECKPOINT_TOO_LARGE',result_json=? WHERE id=?").run(JSON.stringify({reviewResult:{partialText:JSON.stringify(valid(groups[0][0].id)),usage:{inputTokens:300,outputTokens:91,reasoningTokens:10,totalTokens:391}}}),raw0Id);
  f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',391,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),f.id,stamp);
  f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(legacyId,f.id,stamp,JSON.stringify({reviewResult:{partialText:'{"summary":"old schema"}',usage:{inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220}}}));
  f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2220,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),f.id,stamp);
  for(const [kind,state] of [['review','REVIEWED'],['approval','APPROVED']])f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(f.id+':groq-summary-pilot:'+kind+':'+legacyHash,f.id,'groq-summary-pilot-'+kind,0,state,stamp,'{}');
  const url=f.path+'/groq-summary-checkpoint-recovery',review=await(await routeApi(request(url),f.env)).json();assert.equal(review.failedOperationId,raw0Id);const recovered=await routeApi(request(url,'POST',{step:'recover',evidenceHash:review.evidenceHash,failedOperationId:raw0Id,contractHash:hash,responseSha256:review.responseSha256,acknowledgeOriginalUsage:391,confirmNoProviderCall:true,confirmNoAutomaticContinuation:true}),f.env);assert.equal(recovered.status,200,await recovered.clone().text());return {raw0Id,legacyId};
 }});
 f.env.ENABLE_COMPLETE_SYNTHESIS='true';const raw9Id=f.id+':groq-summary:'+f.plan.transcriptHash+':raw:9',stamp=new Date(Date.now()-120000).toISOString(),url=f.path+'/groq-summary-complete';
 f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").run(raw9Id,f.id,stamp,JSON.stringify({reviewResult:{partialText:JSON.stringify({...valid(groups[9][0].id),summary:[{text:'원문에 없는 2022년',evidenceIds:[groups[9][0].id]}]}),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:null,totalTokens:2078}}}));
 f.db.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(? ,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2078,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").run(crypto.randomUUID(),f.id,stamp);
 const review=await(await routeApi(request(url+'?stage=raw:9'),f.env)).json(),excerpt=await routeApi(request(url,'POST',{step:'register-excerpt',stage:'raw:9',sourceHash:f.plan.transcriptHash,auditSha256:review.auditSha256,recordSha256:review.recordSha256,selectedIds:review.selectedIds,confirmExactSourceExcerpt:true,confirmNotAiSummary:true,confirmPriorFailureAndUsagePreserved:true}),f.env);assert.equal(excerpt.status,200,await excerpt.clone().text());const after=await(await routeApi(request(url+'?stage=raw:9'),f.env)).json(),disposition=after.disposition,marked=await routeApi(request(url,'POST',{step:'review-failure-usage',stage:'raw:9',sourceHash:f.plan.transcriptHash,auditSha256:disposition.auditSha256,recordSha256:disposition.recordSha256,confirmSeparateFromContent:true,acknowledgeReceiptNotVerified:true,acknowledgeAccountBalanceUnknown:true,acknowledgeConservativeReservation:true,noRetry:true}),f.env);assert.equal(marked.status,200,await marked.clone().text());
 return {f,groups,approval,failedId,...earlier,raw9Id};
}

test('recovered correction permits a fresh raw approval and raw:9 execution with both failures retained',async()=>{
 const {f,groups,approval,failedId,oldResult}=await recoveredCorrectionFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const reviewReply=await routeApi(request(f.path+'/groq-summary-approval'),f.env);assert.equal(reviewReply.status,200,await reviewReply.clone().text());const review=await reviewReply.json();assert.equal(review.windowStart,9);
  const scope={...f.approval,windowStart:review.windowStart,maxRequests:review.maxRequests,totalTokenUpperBound:review.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};const approved=await routeApi(request(f.path+'/groq-summary-approval','POST',scope),f.env);assert.equal(approved.status,200,await approved.clone().text());
  globalThis.fetch=async()=>{calls++;return response(valid(groups[9][0].id));};const sent=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(sent.status,202,await sent.clone().text());assert.equal(calls,1);
  assert.equal(f.db.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').get(failedId).result_json,oldResult);assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(approval.attemptId).state,'FAILED_UNCERTAIN');
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('recovered correction proof changed at final D1 guard blocks raw:9 before fetch',async()=>{
 const {f}=await recoveredCorrectionFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json(),scope={...f.approval,windowStart:review.windowStart,maxRequests:review.maxRequests,totalTokenUpperBound:review.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',scope),f.env)).status,200);
  const seal=f.db.prepare("SELECT id,result_json FROM yta_operations WHERE job_id=? AND provider='groq-summary-live-resolution' LIMIT 1").get(f.id);assert.ok(seal);
  const restore=tamperBeforeLiveFinalGuard(f,async()=>f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(seal.result_json),usageTokens:0}),seal.id));
  try{globalThis.fetch=async()=>{calls++;throw Error('provider must stay idle');};const sent=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(sent.status,409,await sent.clone().text());assert.equal(calls,0);}finally{restore();}
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('mixed raw:0 legacy recovery, corrective seals and reviewed raw:9 permit another job only with all proofs',async()=>{
 const {f,groups,approval,failedId,raw0Id,legacyId,raw9Id}=await mixedRecoveredCorrectionFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const b=await sibling(f,{approve:false}),expected=new Set([raw0Id,legacyId,failedId,approval.attemptId,raw9Id]),global=await globallyRecoveredGroq(f.env,b.id);assert.deepEqual(new Set(global.ids),expected);
  const reviewPath=b.path+'/groq-summary-approval';assert.equal((await routeApi(request(reviewPath),f.env)).status,200);
  const recoveryId=f.db.prepare("SELECT id FROM yta_operations WHERE job_id=? AND provider='groq-summary-recovery'").get(f.id)?.id,dispositionId=f.db.prepare("SELECT id FROM yta_operations WHERE job_id=? AND provider='groq-summary-failure-disposition'").get(f.id)?.id;
  for(const [id,field] of [[recoveryId,'state'],[dispositionId,'state'],[failedId+':live-resolved','result_json'],[approval.attemptId+':live-resolved','result_json']]){
   const row=f.db.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').get(id);assert.ok(row,id);f.db.prepare('UPDATE yta_operations SET '+field+'=? WHERE id=?').run(field==='state'?'STOPPED':JSON.stringify({...JSON.parse(row.result_json),usageTokens:0}),id);assert.equal((await routeApi(request(reviewPath),f.env)).status,409,id);f.db.prepare('UPDATE yta_operations SET '+field+'=? WHERE id=?').run(row[field],id);
  }
  for(const total of [2220,2078]){const usage=f.db.prepare('SELECT id,used_units FROM usage_events WHERE job_id=? AND used_units=?').get(f.id,total);assert.ok(usage);f.db.prepare('UPDATE usage_events SET used_units=? WHERE id=?').run(total+1,usage.id);assert.equal((await routeApi(request(reviewPath),f.env)).status,409);f.db.prepare('UPDATE usage_events SET used_units=? WHERE id=?').run(total,usage.id);}
  const plan=await(await routeApi(request(b.path+'/groq-summary-plan'),f.env)).json(),review=await(await routeApi(request(reviewPath),f.env)).json(),scope={...f.approval,jobId:b.id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};assert.equal((await routeApi(request(reviewPath,'POST',scope),f.env)).status,200);
  globalThis.fetch=async()=>{calls++;return response(valid(groups[0][0].id));};const sent=await routeApi(request(b.path+'/groq-summary','POST',{}),f.env);assert.equal(sent.status,202,await sent.clone().text());assert.equal(calls,1);for(const id of expected)assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(id).state,'FAILED_UNCERTAIN');
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('mixed recovery checks reviewed raw:9 again at the final D1 guard',async()=>{
 const {f}=await mixedRecoveredCorrectionFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const b=await sibling(f,{approve:false}),plan=await(await routeApi(request(b.path+'/groq-summary-plan'),f.env)).json(),review=await(await routeApi(request(b.path+'/groq-summary-approval'),f.env)).json(),scope={...f.approval,jobId:b.id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};assert.equal((await routeApi(request(b.path+'/groq-summary-approval','POST',scope),f.env)).status,200);
  const dispositionId=f.db.prepare("SELECT id FROM yta_operations WHERE job_id=? AND provider='groq-summary-failure-disposition'").get(f.id).id,restore=tamperBeforeLiveFinalGuard(f,()=>f.db.prepare("UPDATE yta_operations SET state='STOPPED' WHERE id=?").run(dispositionId));
  try{globalThis.fetch=async()=>{calls++;throw Error('provider must stay idle');};const blocked=await routeApi(request(b.path+'/groq-summary','POST',{}),f.env);assert.equal(blocked.status,409,await blocked.clone().text());assert.equal(calls,0);}finally{restore();}
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('a live incomplete recovered correction releases another job only while both proofs stay intact',async()=>{
 const {f,groups,approval,failedId}=await recoveredCorrectionFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const b=await sibling(f,{approve:false}),seal=f.db.prepare("SELECT id,result_json FROM yta_operations WHERE job_id=? AND provider='groq-summary-live-resolution' AND id LIKE ?").get(f.id,approval.attemptId+'%');assert.ok(seal);
  f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(seal.result_json),failedUnits:JSON.parse(seal.result_json).failedUnits+1}),seal.id);assert.equal((await routeApi(request(b.path+'/groq-summary-approval'),f.env)).status,409);f.db.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').run(seal.result_json,seal.id);
  const usage=f.db.prepare("SELECT id,used_units FROM usage_events WHERE job_id=? AND provenance='PROVIDER_REPORTED_CORRECTIVE_ACCOUNT_REMAINING_UNKNOWN'").get(f.id);f.db.prepare('UPDATE usage_events SET used_units=? WHERE id=?').run(usage.used_units+1,usage.id);assert.equal((await routeApi(request(b.path+'/groq-summary-approval'),f.env)).status,409);f.db.prepare('UPDATE usage_events SET used_units=? WHERE id=?').run(usage.used_units,usage.id);
  const plan=await(await routeApi(request(b.path+'/groq-summary-plan'),f.env)).json(),reviewReply=await routeApi(request(b.path+'/groq-summary-approval'),f.env);assert.equal(reviewReply.status,200,await reviewReply.clone().text());const review=await reviewReply.json(),scope={...f.approval,jobId:b.id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};assert.equal((await routeApi(request(b.path+'/groq-summary-approval','POST',scope),f.env)).status,200);
  globalThis.fetch=async()=>{calls++;return response(valid(groups[0][0].id));};const sent=await routeApi(request(b.path+'/groq-summary','POST',{}),f.env);assert.equal(sent.status,202,await sent.clone().text());assert.equal(calls,1);
  assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(failedId).state,'FAILED_UNCERTAIN');assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(approval.attemptId).state,'FAILED_UNCERTAIN');
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('deleting a recovered correction settles both failures before another job runs',async()=>{
 const {f,groups,approval,failedId}=await recoveredCorrectionFixture(),oldFetch=globalThis.fetch;let calls=0;
 try{
  const deleted=await routeApi(request(f.path,'DELETE'),f.env);assert.equal(deleted.status,200,await deleted.clone().text());assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider='groq-summary-settlement'").get(f.id).n,2);assert.equal(f.db.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').get(failedId).state,'FAILED_UNCERTAIN');assert.equal(f.db.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').get(approval.attemptId).state,'FAILED_UNCERTAIN');
  const b=await sibling(f,{approve:false}),plan=await(await routeApi(request(b.path+'/groq-summary-plan'),f.env)).json(),reviewReply=await routeApi(request(b.path+'/groq-summary-approval'),f.env);assert.equal(reviewReply.status,200,await reviewReply.clone().text());const review=await reviewReply.json(),scope={...f.approval,jobId:b.id,transcriptHash:plan.transcriptHash,model:plan.model,outputKind:plan.outputKind,windowStart:plan.windowStart,totalRequests:plan.totalRequests,maxRequests:plan.maxRequests,maxInputTokensPerRequest:plan.maxInputTokensPerRequest,maxCompletionTokensPerRequest:plan.maxCompletionTokensPerRequest,totalTokenUpperBound:plan.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};assert.equal((await routeApi(request(b.path+'/groq-summary-approval','POST',scope),f.env)).status,200);globalThis.fetch=async()=>{calls++;return response(valid(groups[0][0].id));};assert.equal((await routeApi(request(b.path+'/groq-summary','POST',{}),f.env)).status,202);assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('recovered correction enters synthesis with two original failures still preserved',async()=>{
 const {f,groups,approval,failedId}=await recoveredCorrectionFixture(),oldFetch=globalThis.fetch;f.env.ENABLE_COMPLETE_SYNTHESIS='true';let calls=0;
 try{
  const stamp=new Date(Date.now()-120000).toISOString(),hash=f.plan.transcriptHash;
  for(let i=9;i<groups.length;i++)f.db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").run(f.id+':groq-summary:'+hash+':raw:'+i,f.id,stamp,JSON.stringify({hash,key:'raw:'+i,report:valid(groups[i][0].id)}));
  const url=f.path+'/groq-summary-complete',readyReply=await routeApi(request(url),f.env);assert.equal(readyReply.status,200,await readyReply.clone().text());const ready=await readyReply.json();assert.equal(ready.ready,true);
  const quoted=await routeApi(request(url,'POST',{step:'quote',sourceHash:hash,manifestSha256:ready.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),f.env);assert.equal(quoted.status,200,await quoted.clone().text());const quote=await quoted.json(),approved=await routeApi(request(url,'POST',{step:'approve',quoteId:quote.quoteId,quoteSha256:quote.quoteSha256,reservedUnits:quote.quote.reservedUnits,maxCalls:quote.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}),f.env);assert.equal(approved.status,200,await approved.clone().text());const scope=await approved.json();
  globalThis.fetch=async()=>{calls++;return response({summary:[{text:'가',evidenceIds:[groups[0][0].id]}],chapters:[{text:'가',evidenceIds:[groups[0][0].id]},{text:'가',evidenceIds:[groups[1][0].id]}],claims:[],numbers:[],critical:[],conclusion:'가'});};
  const sent=await routeApi(request(url,'POST',{step:'execute',approvalId:scope.approvalId,expectedNode:ready.nextSynthesisStage,requestSha256:ready.nextSynthesisRequestSha256,executeOnce:true}),f.env);assert.equal(sent.status,200,await sent.clone().text());assert.equal(calls,1);assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(failedId).state,'FAILED_UNCERTAIN');assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(approval.attemptId).state,'FAILED_UNCERTAIN');
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});

test('full-scale recovered correction admits raw:9 within D1 query budget',async t=>{
 const {f,groups}=await recoveredCorrectionFixture({fullScale:true}),oldFetch=globalThis.fetch,DB=f.env.DB;let calls=0,queries=0,attempted51=false;
 try{
  const review=await(await routeApi(request(f.path+'/groq-summary-approval'),f.env)).json(),scope={...f.approval,windowStart:review.windowStart,maxRequests:review.maxRequests,totalTokenUpperBound:review.totalTokenUpperBound,credentialGeneration:review.credentialGeneration};assert.equal((await routeApi(request(f.path+'/groq-summary-approval','POST',scope),f.env)).status,200);
  f.env.DB={prepare(sql){const stmt=DB.prepare(sql),wrap=bound=>({bind(...args){return wrap(bound.bind(...args));},async first(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.first();},async all(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.all();},async run(){if(++queries>50){attempted51=true;throw Error('D1_QUERY_LIMIT_51');}return bound.run();}});return wrap(stmt);}};
  globalThis.fetch=async()=>{calls++;return response(valid(groups[9][0].id));};const sent=await routeApi(request(f.path+'/groq-summary','POST',{}),f.env);assert.equal(attempted51,false);assert.ok(queries<=50);assert.equal(sent.status,202,await sent.clone().text());assert.equal(calls,1);t.diagnostic(`recovered full-scale raw:9 used ${queries} D1 queries`);
 }finally{f.env.DB=DB;globalThis.fetch=oldFetch;f.db.close();}
});
