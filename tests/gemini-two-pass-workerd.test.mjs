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
for(const scenario of [
 {name:'full timed transcript remains unverified',duration:2,audit:{status:'TRANSCRIPT_UNVERIFIED',timelineRatio:1},status:'TRANSCRIPT_UNVERIFIED',consistency:'STORED_AUDIT_NOT_INDEPENDENTLY_VERIFIED'},
 {name:'partial transcript with every audio chunk processed',duration:10,audit:{status:'PARTIAL_TRANSCRIPT',timelineRatio:.2},status:'PARTIAL_TRANSCRIPT',consistency:'STORED_AUDIT_NOT_INDEPENDENTLY_VERIFIED'},
 {name:'genuine empty transcript window remains explicitly partial',duration:1201,gap:true,audit:{status:'TRANSCRIPT_UNVERIFIED',timelineRatio:1},status:'PARTIAL_TRANSCRIPT',consistency:'STORED_AUDIT_NOT_INDEPENDENTLY_VERIFIED'},
 {name:'missing source audit metadata',duration:2,audit:{},status:'TRANSCRIPT_UNVERIFIED',consistency:'MISSING_SOURCE_AUDIT'},
 {name:'declared full audit contradicts actual source range',duration:10,audit:{status:'FULL_TRANSCRIPT_VERIFIED',timelineRatio:1},status:'PARTIAL_TRANSCRIPT',consistency:'INCONSISTENT_SOURCE_AUDIT'},
 {name:'declared verification alone cannot verify audio',duration:2,audit:{status:'FULL_TRANSCRIPT_VERIFIED',timelineRatio:1},status:'TRANSCRIPT_UNVERIFIED',consistency:'STORED_AUDIT_NOT_INDEPENDENTLY_VERIFIED'},
 {name:'malformed timeline ratio stays unverified',duration:2,audit:{status:'TRANSCRIPT_UNVERIFIED',timelineRatio:'1'},status:'TRANSCRIPT_UNVERIFIED',consistency:'INCONSISTENT_SOURCE_AUDIT'}
])test('local D1 acceptance: '+scenario.name,async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'gemini-two-pass-test',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'two-pass-local'}}]}));
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0015_gemini_two_pass.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const id='44444444-4444-4444-8444-444444444444',path='/api/jobs/'+id,segments=[{id:1,startMs:0,endMs:1000,text:'첫 발언'},{id:2,startMs:scenario.gap?1200000:1000,endMs:scenario.gap?1201000:2000,text:'둘째 발언'}],audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'c'.repeat(64),...scenario.audit};
  await DB.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Two pass Workerd','audio','TRANSCRIBED',?,?,?,?,?)").bind(id,scenario.duration,new Date().toISOString(),new Date().toISOString(),'null',JSON.stringify(audit)).run();
  await DB.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'GROQ_OWNED_AUDIO',?)").bind(id,segments.map(s=>s.text).join('\n'),JSON.stringify(segments),new Date().toISOString()).run();
  const root=Buffer.alloc(32,9),secret=await encryptProviderKey(root,'gemini','OFFLINE_WORKERD_KEY');await DB.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','gemini',?,?,?,?)").bind(secret.version,secret.ivB64,secret.ciphertextB64,new Date().toISOString()).run();
  let sends=0;const report={summary:[{text:'두 발언',evidenceIds:[1,2]}],chapters:[{windowKey:'w000',kind:'CONTENT',text:'첫 발언'+' '+'둘째 발언',evidenceIds:[1,2]}],claims:[],numbers:[],critical:[],conclusion:'두 발언을 종합했다'};
  if(scenario.gap)report.chapters=[{windowKey:'w000',kind:'CONTENT',text:'첫 발언',evidenceIds:[1]},{windowKey:'w001',kind:'TRANSCRIPT_GAP',text:'저장된 전사 없음',evidenceIds:[]},{windowKey:'w002',kind:'CONTENT',text:'둘째 발언',evidenceIds:[2]}];
  const env={DB,KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_GEMINI_TWO_PASS:'true',ENABLE_GEMINI_TWO_PASS_PAID:'true',GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED:'true',GEMINI_TWO_PASS_ALLOWED_JOB_ID:id,ALLOW_PAID_API:'false',GEMINI_TWO_PASS_COST_BUFFER_APPROVED:'true',GEMINI_TWO_PASS_TEST_PROVIDER:{getModel:async()=>({name:`models/${TWO_PASS_MODEL}`,supportedGenerationMethods:['generateContent','countTokens'],inputTokenLimit:1_048_576,outputTokenLimit:65_536}),countTokens:async()=>300,generate:async()=>{sends++;const responseText=JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(sends===1?report:{verdict:'PASS',issues:[]})}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:100,thoughtsTokenCount:10}});return {responseText,responseBytes:new TextEncoder().encode(responseText).length,httpStatus:200,complete:true};}}};
  const issued=await(await routeApi(request(path+'/gemini-two-pass-quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true}),env)).json();assert.equal(issued.state,'QUOTED',JSON.stringify(issued));const q=issued.quote;
  assert.equal((await DB.prepare("SELECT state FROM yta_operations WHERE id=? AND provider='gemini-two-pass-quote'").bind(id+':gemini-two-pass-quote').first()).state,'QUOTE_SAVED');
  const approved=await routeApi(request(path+'/gemini-two-pass-approve','POST',{quoteSha256:q.quoteSha256,maxMicroUsd:q.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true}),env);assert.equal(approved.status,200,await approved.clone().text());
  for(const phase of [0,1]){const ran=await routeApi(request(path+'/gemini-two-pass-run','POST',{phase,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true}),env);assert.equal(ran.status,200,await ran.clone().text());}
  assert.equal(sends,2);assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM yta_gemini_two_pass_calls WHERE state='SETTLED' AND response_complete=1").first()).n,2);
  const publicJob=(await(await routeApi(request(path),env)).json()).job;assert.equal(publicJob.report,null);assert.equal(publicJob.status,'TRANSCRIBED');const status=(await(await routeApi(request(path+'/gemini-two-pass-status'),env)).json());assert.equal(status.reviewStage,'REVIEW_REQUIRED');assert.equal(status.meaningReview,'SOURCE_REVIEW_REQUIRED');
  assert.equal(status.reviewVerdict,'PASS');
  const acceptance={confirmNoProviderCall:true,confirmSourceBasedSummary:true,acknowledgeTranscriptionUnverified:true,acknowledgeSemanticReviewUnverified:true,sourceSha256:q.sourceSha256,auditSha256:status.auditSha256,sourceAssessmentSha256:status.sourceAssessmentSha256,quoteSha256:q.quoteSha256,reviewReceiptSha256:status.calls[1].responseSha256};
  await DB.prepare("UPDATE yta_sources SET raw='changed',segments_json='[]' WHERE job_id=?").bind(id).run();
  assert.equal((await routeApi(request(path+'/gemini-two-pass-accept','POST',acceptance),env)).status,409);assert.equal(sends,2);
  await DB.prepare('UPDATE yta_sources SET raw=?,segments_json=? WHERE job_id=?').bind(segments.map(s=>s.text).join('\n'),JSON.stringify(segments),id).run();
  assert.equal((await routeApi(request(path+'/gemini-two-pass-accept','POST',{...acceptance,reviewReceiptSha256:'0'.repeat(64)}),env)).status,409);
  const priorUsage=(await DB.prepare('SELECT usage_json FROM yta_gemini_two_pass_calls WHERE job_id=? AND phase=1').bind(id).first()).usage_json;
  await DB.prepare("UPDATE yta_gemini_two_pass_calls SET usage_json='{}' WHERE job_id=? AND phase=1").bind(id).run();
  assert.equal((await routeApi(request(path+'/gemini-two-pass-accept','POST',acceptance),env)).status,409);
  await DB.prepare('UPDATE yta_gemini_two_pass_calls SET usage_json=? WHERE job_id=? AND phase=1').bind(priorUsage,id).run();
  const priorFirst=(await DB.prepare('SELECT first_report_json FROM yta_gemini_two_pass_jobs WHERE job_id=?').bind(id).first()).first_report_json;
  const changedFirst=JSON.parse(priorFirst);changedFirst.chapters[0].text='A different long enough source-based claim';
  await DB.prepare('UPDATE yta_gemini_two_pass_jobs SET first_report_json=? WHERE job_id=?').bind(JSON.stringify(changedFirst),id).run();
  assert.equal((await routeApi(request(path+'/gemini-two-pass-accept','POST',acceptance),env)).status,409);
  await DB.prepare('UPDATE yta_gemini_two_pass_jobs SET first_report_json=? WHERE job_id=?').bind(priorFirst,id).run();
  const priorReview=(await DB.prepare('SELECT review_json FROM yta_gemini_two_pass_jobs WHERE job_id=?').bind(id).first()).review_json;
  await DB.prepare('UPDATE yta_gemini_two_pass_jobs SET review_json=? WHERE job_id=?').bind(JSON.stringify({verdict:'ISSUES',issues:[{category:'OMISSION',description:'A real omitted point',evidenceIds:[1]}]}),id).run();
  assert.equal((await routeApi(request(path+'/gemini-two-pass-accept','POST',acceptance),env)).status,409);
  await DB.prepare('UPDATE yta_gemini_two_pass_jobs SET review_json=? WHERE job_id=?').bind(priorReview,id).run();
  assert.equal((await routeApi(request(path+'/gemini-two-pass-accept','POST',{...acceptance,acknowledgeTranscriptionUnverified:false}),env)).status,409);
  assert.equal((await(await routeApi(request(path),env)).json()).job.report,null);

  // Changes invisible to the old prompt hash still invalidate the acceptance displayed to the owner.
  for(const changedAudit of [{...audit,status:'CHANGED_ONLY_STATUS'},{...audit,timelineRatio:.1234},{...audit,provenance:'CHANGED_AUDIT_PROVENANCE'},null]){
   await DB.prepare('UPDATE jobs SET audit_json=? WHERE id=?').bind(JSON.stringify(changedAudit),id).run();
   const rejected=await routeApi(request(path+'/gemini-two-pass-accept','POST',acceptance),env);assert.equal(rejected.status,409,await rejected.clone().text());
   assert.equal((await DB.prepare('SELECT report_json FROM jobs WHERE id=?').bind(id).first()).report_json,'null');
  }
  await DB.prepare("UPDATE jobs SET audit_json='{broken' WHERE id=?").bind(id).run();
  assert.equal((await routeApi(request(path+'/gemini-two-pass-accept','POST',acceptance),env)).status,409);
  await DB.prepare('UPDATE jobs SET audit_json=? WHERE id=?').bind(JSON.stringify(audit),id).run();
  assert.equal((await routeApi(request(path+'/gemini-two-pass-accept','POST',{...acceptance,sourceAssessmentSha256:undefined}),env)).status,409);

  if(scenario.name==='full timed transcript remains unverified'){
   for(const mutation of [
    {sql:'UPDATE jobs SET audit_json=? WHERE id=?',value:JSON.stringify({...audit,status:'PARTIAL_TRANSCRIPT'}),restore:JSON.stringify(audit)},
    {sql:'UPDATE jobs SET duration_seconds=? WHERE id=?',value:scenario.duration+1,restore:scenario.duration},
    {sql:'UPDATE jobs SET source_type=? WHERE id=?',value:'text',restore:'audio'},
    {sql:'UPDATE yta_sources SET provenance=? WHERE job_id=?',value:'GEMINI_OWNED_AUDIO',restore:'GROQ_OWNED_AUDIO'}
   ]){
    let raced=false;
    const racingDB={prepare(sql){const statement=DB.prepare(sql);if(!sql.startsWith('UPDATE jobs SET report_json=?,status=?'))return statement;return {bind(...args){const bound=statement.bind(...args);return {async run(){raced=true;await DB.prepare(mutation.sql).bind(mutation.value,id).run();return bound.run();}};}};}};
    const rejected=await routeApi(request(path+'/gemini-two-pass-accept','POST',acceptance),{...env,DB:racingDB});
    assert.equal(rejected.status,409,await rejected.clone().text());assert.equal(raced,true);assert.equal(sends,2);
    assert.equal((await DB.prepare('SELECT report_json FROM jobs WHERE id=?').bind(id).first()).report_json,'null');
    await DB.prepare(mutation.sql).bind(mutation.restore,id).run();
   }
  }
  const accepted=await routeApi(request(path+'/gemini-two-pass-accept','POST',acceptance),env),acceptedBody=await accepted.clone().json();assert.equal(accepted.status,200,JSON.stringify(acceptedBody));
  assert.equal(acceptedBody.persisted,true);assert.equal(acceptedBody.providerCalled,false);assert.equal(sends,2);
  const reopened=(await(await routeApi(request(path),env)).json()).job;assert.equal(reopened.status,scenario.status);assert.equal(reopened.report.kind,'GEMINI_TWO_PASS_EVIDENCE_LINKED');assert.equal(reopened.report.summaryCompletion,'COMPLETE');assert.equal(reopened.report.outputKind,'STORED_TRANSCRIPT_SUMMARY');assert.equal(reopened.report.sourceAssessment.status,scenario.status);assert.equal(reopened.report.sourceAssessment.auditConsistency,scenario.consistency);assert.equal(reopened.report.sourceAssessment.fullSourceCoverage,'NOT_VERIFIED');assert.equal(reopened.report.sourceAssessment.provenance,'GROQ_OWNED_AUDIO');assert.equal(reopened.report.sourceAssessment.range.lastEndMs,segments[1].endMs);assert.equal(reopened.report.sourceAssessment.range.timelineRatio,Number((segments[1].endMs/1000/scenario.duration).toFixed(4)));assert.equal(reopened.report.sourceBinding,'CURRENT');assert.equal(reopened.report.audioAccuracy,'NOT_VERIFIED');assert.equal(reopened.report.meaningReview.status,'AUTO_CHECK_PASSED_HUMAN_UNREVIEWED');assert.equal(reopened.report.sourceCoverage.segmentCount,2);
  const exported=await(await routeApi(request(path+'/export?format=txt'),env)).text();assert.match(exported,/AUTO_CHECK_PASSED_HUMAN_UNREVIEWED/);assert.match(exported,/NOT_VERIFIED/);assert.match(exported,new RegExp(scenario.status));assert.match(exported,/GROQ_OWNED_AUDIO/);assert.match(exported,new RegExp('0–'+segments[1].endMs+' ms'));
  if(scenario.gap){assert.deepEqual(reopened.report.sourceAssessment.transcriptGapWindows,[{key:'w001',startMs:600000,endMs:1200000,interpretation:'NO_STORED_TRANSCRIPT_AUDIO_CONTENT_UNKNOWN'}]);assert.equal(reopened.report.chapters[1].kind,'TRANSCRIPT_GAP');assert.match(exported,/NO_STORED_TRANSCRIPT_AUDIO_CONTENT_UNKNOWN/);assert.match(exported,/600000/);}
assert.doesNotMatch(exported,/SOURCE_BASED_FULL_SUMMARY/);
  const persisted=await DB.prepare('SELECT status,report_json,audit_json FROM jobs WHERE id=?').bind(id).first();assert.equal(persisted.status,scenario.status);assert.equal(JSON.parse(persisted.report_json).sourceAssessment.snapshotSha256,status.sourceAssessmentSha256);assert.deepEqual(JSON.parse(persisted.audit_json),audit);
  assert.equal((await DB.prepare('SELECT state FROM yta_gemini_two_pass_jobs WHERE job_id=?').bind(id).first()).state,'COMPLETE');
  // A URL association does not make an audio job eligible for native captions.
  // A cached negative response must not clear the accepted report or its audit.
  await DB.prepare('UPDATE jobs SET source_url=? WHERE id=?').bind('https://youtu.be/2hUkTmwYm3A',id).run();
  await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'supadata',1,'DONE',?,?)").bind(id+':native',id,new Date().toISOString(),JSON.stringify({status:'NO_CAPTIONS',segments:[]})).run();
  const sourceBeforeReplay=await DB.prepare('SELECT * FROM yta_sources WHERE job_id=?').bind(id).first();
  assert.equal((await routeApi(request(path+'/native','POST',{}),env)).status,400);
  assert.equal((await routeApi(request(path+'/summary','POST',{}),env)).status,409);
  assert.deepEqual(await DB.prepare('SELECT status,report_json,audit_json FROM jobs WHERE id=?').bind(id).first(),persisted);
  assert.deepEqual(await DB.prepare('SELECT * FROM yta_sources WHERE job_id=?').bind(id).first(),sourceBeforeReplay);
  assert.equal((await DB.prepare('SELECT state FROM yta_gemini_two_pass_jobs WHERE job_id=?').bind(id).first()).state,'COMPLETE');
  assert.equal((await routeApi(request(path+'/gemini-two-pass-accept','POST',acceptance),env)).status,200);assert.equal(sends,2);
  await DB.prepare("UPDATE yta_gemini_two_pass_jobs SET state='ISSUES' WHERE job_id=?").bind(id).run();
  assert.equal((await routeApi(request(path+'/gemini-two-pass-accept','POST',acceptance),env)).status,200);assert.equal(sends,2);
  assert.equal((await DB.prepare('SELECT state FROM yta_gemini_two_pass_jobs WHERE job_id=?').bind(id).first()).state,'COMPLETE');

  if(scenario.name==='full timed transcript remains unverified'){
   const copies=Array.from({length:49},()=>crypto.randomUUID());
   for(const copy of copies){
    await DB.prepare('INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) SELECT ?,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json FROM jobs WHERE id=?').bind(copy,id).run();
    await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) SELECT ?,raw,segments_json,provenance,updated_at FROM yta_sources WHERE job_id=?').bind(copy,id).run();
   }
   let reads=0;const sourceBatchSizes=[],countedDB={prepare(sql){reads++;const statement=DB.prepare(sql);if(!sql.startsWith('SELECT * FROM yta_sources WHERE job_id IN'))return statement;return {bind(...args){sourceBatchSizes.push(args.length);return statement.bind(...args);}};}};
   const listed=await(await routeApi(request('/api/jobs?limit=50'),{...env,DB:countedDB})).json();
   assert.equal(listed.jobs.length,50);assert.equal(reads,11);assert.deepEqual(sourceBatchSizes,Array(10).fill(5));assert.ok(listed.jobs.every(j=>j.summaryCompletion==='COMPLETE'&&j.sourceBinding==='CURRENT'&&j.status==='TRANSCRIPT_UNVERIFIED'&&j.audioTranscriptComplete===false));
   assert.ok(listed.jobs.every(j=>!('raw' in j)&&!('segments' in j)&&!('report_json' in j)));
   for(const copy of copies){await DB.prepare('DELETE FROM yta_sources WHERE job_id=?').bind(copy).run();await DB.prepare('DELETE FROM jobs WHERE id=?').bind(copy).run();}
  }
  // A completed summary is historical after changes; GET, status and TXT must all say so.
  for(const mutation of [
   {sql:'UPDATE jobs SET audit_json=? WHERE id=?',value:JSON.stringify({...audit,status:'CHANGED_ONLY_STATUS'}),restore:JSON.stringify(audit)},
   {sql:'UPDATE jobs SET duration_seconds=? WHERE id=?',value:scenario.duration+1,restore:scenario.duration},
   {sql:'UPDATE jobs SET duration_seconds=? WHERE id=?',value:7201,restore:scenario.duration},
   {sql:'UPDATE jobs SET source_type=? WHERE id=?',value:'text',restore:'audio'},
   {sql:'UPDATE yta_sources SET provenance=? WHERE job_id=?',value:'GEMINI_OWNED_AUDIO',restore:'GROQ_OWNED_AUDIO'},
   {sql:'UPDATE yta_sources SET segments_json=? WHERE job_id=?',value:JSON.stringify(segments.map(s=>({...s,startMs:s.startMs+50,endMs:s.endMs+50}))),restore:JSON.stringify(segments)},
   {sql:'UPDATE yta_sources SET raw=? WHERE job_id=?',value:'Changed after acceptance',restore:segments.map(s=>s.text).join('\n')}
  ]){
   await DB.prepare(mutation.sql).bind(mutation.value,id).run();
   const changed=(await(await routeApi(request(path),env)).json()).job;
   assert.equal(changed.status,'SOURCE_REVIEW_REQUIRED');assert.equal(changed.report.sourceBinding,'STALE_SOURCE');assert.equal(changed.report.summaryCompletion,'COMPLETE');
   assert.equal(changed.report.sourceAssessment.snapshotSha256,status.sourceAssessmentSha256);
   const currentStatus=await(await routeApi(request(path+'/gemini-two-pass-status'),env)).json();assert.equal(currentStatus.sourceBinding,'STALE_SOURCE');assert.equal(currentStatus.next,'REVIEW_CHANGED_SOURCE');
   const changedTxt=await(await routeApi(request(path+'/export?format=txt'),env)).text();assert.match(changedTxt,/STALE_SOURCE/);assert.match(changedTxt,/SOURCE_REVIEW_REQUIRED/);assert.match(changedTxt,/#1 source changed; timestamp unverified/);
   const listed=(await(await routeApi(request('/api/jobs'),env)).json()).jobs.find(j=>j.id===id);assert.equal(listed.status,'SOURCE_REVIEW_REQUIRED');assert.equal(listed.sourceBinding,'STALE_SOURCE');assert.equal(listed.audioTranscriptComplete,false);
   assert.equal((await routeApi(request(path+'/gemini-two-pass-accept','POST',acceptance),env)).status,409);
   await DB.prepare(mutation.sql).bind(mutation.restore,id).run();
  }
  assert.equal((await(await routeApi(request(path),env)).json()).job.report.sourceBinding,'CURRENT');assert.equal(sends,2);

 }finally{await mf.dispose();}
});
