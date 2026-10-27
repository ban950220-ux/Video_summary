// Local SQLite/API integration. Audio/provider receipts and summaries are fixtures.
// An optional existing SRT is read locally; it is never sent to a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {routeApi} from '../src/worker.mjs';
import {planMp3,mergeAudioSegments} from '../src/audio.mjs';
import {parseCaptions,transcriptAudit} from '../src/core.mjs';
import {windowManifest} from '../src/two-pass-windows.mjs';
import {encryptProviderKey} from '../src/vault.mjs';
import {TWO_PASS_MODEL} from '../src/gemini-two-pass-contract.mjs';
let networkAttempts=0;globalThis.fetch=async()=>{networkAttempts++;throw Error('EXTERNAL_NETWORK_FORBIDDEN');};
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of ['schema.sql','migrations/0002_live.sql','migrations/0003_observed_capacity.sql','migrations/0005_reviewed_free_recovery.sql','migrations/0006_unknown_groq_probe.sql','migrations/0007_bounded_free_batch.sql','migrations/0015_gemini_two_pass.sql'])sqlite.exec(readFileSync(new URL('../'+file,import.meta.url),'utf8'));
 const DB={prepare(sql){const make=args=>({sql,args,bind(...v){return make(v);},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}});return make([]);},async batch(statements){sqlite.exec('BEGIN');try{const out=statements.map(s=>({meta:{changes:Number(sqlite.prepare(s.sql).run(...s.args).changes)}}));sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB};
 const call=async(path,method='GET',body)=>routeApi(new Request('https://local-fixture.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),env);
 return {sqlite,DB,env,call};
}

for(const tailKind of ['duplicate','empty','invalid'])test(`audio finish from stored checkpoints: ${tailKind} tail, cached chunks, source persistence`,async()=>{
 const f=fixture();try{
  const bytes=new Uint8Array(11570*417);for(let i=0;i<11570;i++)bytes.set([255,251,144,0],i*417);
  const plan=planMp3(bytes);assert.equal(plan.chunks.length,2);const tail=plan.chunks[1],hash='a'.repeat(64);
  const result=[[{start:.1,end:.5,text:'Opening fixture speech.'},{start:tail.start+.25,end:tail.start+.75,text:'Final fixture speech.'}],tailKind==='duplicate'?[{start:.25,end:.75,text:'Final fixture speech.'}]:tailKind==='invalid'?[{start:-4,end:-3,text:'Invalid fixture speech.'}]:[]];
  const merged=mergeAudioSegments(plan.chunks.map((c,i)=>({...c,segments:result[i]})));
  assert.deepEqual(merged.missingChunks,tailKind==='duplicate'?[]:[1]);
  if(tailKind==='duplicate'){assert.equal(merged.deduplicatedByChunk[1],1);assert.equal(merged.segments.length,2);}
  const created=await(await f.call('/api/jobs','POST',{sourceType:'audio',title:'LOCAL AUDIO FIXTURE',durationSeconds:plan.durationSeconds})).json();const id=created.job.id,path='/api/jobs/'+id;
  assert.equal((await f.call(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:hash,chunks:plan.chunks.map(({index,start,end})=>({index,start,end}))})).status,200);
  // Simulate completed provider checkpoints, not real transcription.
  for(const [i,segments] of result.entries())f.sqlite.prepare("UPDATE yta_audio SET state='DONE',result_json=? WHERE job_id=? AND chunk_index=?").run(JSON.stringify({fileSha256:hash,provider:'groq',model:'whisper-large-v3-turbo',segments}),id,i);
  const oldRows=JSON.stringify(f.sqlite.prepare('SELECT * FROM yta_audio WHERE job_id=? ORDER BY chunk_index').all(id));
  const progress=await(await f.call(path+'/audio-progress')).json();assert.equal(progress.complete,true);
  const cached=await(await f.call(path+'/audio-chunk?index=1','POST',{})).json();assert.equal(cached.cached,true);
  const finish=await f.call(path+'/audio-finish','POST',{});assert.equal(finish.status,tailKind==='duplicate'?200:409);
  if(tailKind==='duplicate'){
   const source=await(await f.call(path+'/source')).json();assert.equal(source.source.segments.length,2);
   const repeated=await(await f.call(path+'/audio-finish','POST',{})).json();assert.equal(repeated.cached,true);
   const reopened=(await(await f.call(path)).json()).job;assert.equal(reopened.audit.audioProcessingCoverage,1);assert.notEqual(reopened.status,'FULL_TRANSCRIPT_VERIFIED');
   const txt=await(await f.call(path+'/export?format=txt')).text();assert.equal(txt.split('## 정제 스크립트')[1].match(/Final fixture speech\./g).length,1);
  }else assert.equal(f.sqlite.prepare('SELECT count(*) n FROM yta_sources WHERE job_id=?').get(id).n,0);
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM yta_audio WHERE job_id=? ORDER BY chunk_index').all(id)),oldRows);assert.equal(networkAttempts,0);
 }finally{f.sqlite.close();}
});

const realSrt=process.env.LOCAL_REVIEW_SRT;
const sourceSegments=()=>realSrt?parseCaptions(readFileSync(realSrt,'utf8')).segments.map((s,i)=>({...s,id:i+1})):Array.from({length:1226},(_,i)=>({id:i+1,startMs:Math.round(i*5891242/1226),endMs:Math.round((i+1)*5891242/1226),text:'합성 전사 발언입니다.'}));
for(const mode of ['complete','missing-window'])test(`1226-segment summary input → ${mode} fixture → SQLite/reopen/TXT`,async()=>{
 const f=fixture();try{
  const segments=sourceSegments();assert.equal(segments.length,1226);const duration=5892.888,id='77777777-7777-4777-8777-777777777777',path='/api/jobs/'+id;
  const audit={...transcriptAudit(segments,duration,false),audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:process.env.LOCAL_REVIEW_AUDIO_SHA??'c'.repeat(64)};
  const source={segments,raw:segments.map(s=>s.text).join('\n'),provenance:'GROQ_OWNED_AUDIO'},stamp=new Date().toISOString();
  f.sqlite.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','LOCAL MOCK SUMMARY — NOT AI RESULT','audio','TRANSCRIBED',?,?,?,'null',?)").run(id,duration,stamp,stamp,JSON.stringify(audit));
  f.sqlite.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').run(id,source.raw,JSON.stringify(segments),source.provenance,stamp);
  // Preserve unrelated historical uncertainty instead of resetting it.
  f.sqlite.prepare("INSERT INTO yta_operations(id,job_id,provider,state,units,created_at,error_code) VALUES('fixture-prior','fixture-parent','gemini','FAILED_UNCERTAIN',123,?,'FIXTURE_PRIOR_FAILURE')").run(stamp);
  const history=JSON.stringify(f.sqlite.prepare("SELECT * FROM yta_operations WHERE id='fixture-prior'").get());
  const root=Buffer.alloc(32,9),key=await encryptProviderKey(root,'gemini','LOCAL_TEST_KEY_NOT_A_CREDENTIAL');
  f.sqlite.prepare("INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES('owner','gemini',?,?,?,?)").run(key.version,key.ivB64,key.ciphertextB64,stamp);
  const windows=windowManifest(source),report={summary:[{text:'로컬 모의 검사 결과이며 실제 AI 요약이 아닙니다.',evidenceIds:[1,1226]}],chapters:windows.map(w=>({windowKey:w.key,kind:w.primaryIds.length?'CONTENT':w.boundaryIds.length?'BOUNDARY_ONLY':'TRANSCRIPT_GAP',text:'저장 구간 연결을 검사하는 모의 출력입니다.',evidenceIds:w.primaryIds.length?[w.primaryIds[0]]:w.boundaryIds.slice(0,1)})),claims:[],numbers:[],critical:[],conclusion:'모의 응답이며 실제 의미 요약은 수행하지 않았습니다.'};
  if(mode==='missing-window')report.chapters.splice(4,1);
  let mockGenerations=0,mockCounts=0;const observedInputs=[];
  Object.assign(f.env,{KEY_ENCRYPTION_KEY_B64:root.toString('base64'),ENABLE_GEMINI_TWO_PASS:'true',ENABLE_GEMINI_TWO_PASS_PAID:'true',GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED:'true',GEMINI_TWO_PASS_COST_BUFFER_APPROVED:'true',GEMINI_TWO_PASS_ALLOWED_JOB_ID:id,ALLOW_PAID_API:'false',GEMINI_TWO_PASS_TEST_PROVIDER:{getModel:async()=>({name:`models/${TWO_PASS_MODEL}`,supportedGenerationMethods:['generateContent','countTokens'],inputTokenLimit:1048576,outputTokenLimit:65536}),countTokens:async request=>{mockCounts++;observedInputs.push(JSON.stringify(request));return 300;},generate:async request=>{observedInputs.push(JSON.stringify(request));mockGenerations++;const responseText=JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(mockGenerations===1?report:{verdict:'PASS',issues:[]})}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:100,thoughtsTokenCount:10}});return {responseText,responseBytes:Buffer.byteLength(responseText),httpStatus:200,complete:true};}}});
  const q=(await(await f.call(path+'/gemini-two-pass-quote','POST',{projectMode:'PAID_APPROVED',confirmFullTranscriptSentToGoogleForTokenCount:true})).json()).quote;assert.ok(q);
  assert.equal((await f.call(path+'/gemini-two-pass-approve','POST',{quoteSha256:q.quoteSha256,maxMicroUsd:q.maxMicroUsd,maxCalls:2,confirmNoAutomaticRetry:true,confirmProjectMode:'PAID_APPROVED',confirmSeparatePaidApproval:true})).status,200);
  const first=await f.call(path+'/gemini-two-pass-run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true});
  if(mode==='missing-window'){
   assert.notEqual(first.status,200);assert.equal(mockGenerations,1);assert.equal((await(await f.call(path)).json()).job.report,null);
   assert.notEqual((await f.call(path+'/gemini-two-pass-run','POST',{phase:0,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true})).status,200);assert.equal(mockGenerations,1);
  }else{
   assert.equal(first.status,200);assert.equal((await f.call(path+'/gemini-two-pass-run','POST',{phase:1,quoteSha256:q.quoteSha256,confirmSeparatePaidApproval:true})).status,200);
   const status=await(await f.call(path+'/gemini-two-pass-status')).json();assert.equal(status.finalReportSaved,false);
   const acceptance={confirmNoProviderCall:true,confirmSourceBasedSummary:true,acknowledgeTranscriptionUnverified:true,acknowledgeSemanticReviewUnverified:true,sourceSha256:q.sourceSha256,auditSha256:status.auditSha256,sourceAssessmentSha256:status.sourceAssessmentSha256,quoteSha256:q.quoteSha256,reviewReceiptSha256:status.calls[1].responseSha256};
   assert.equal((await f.call(path+'/gemini-two-pass-accept','POST',acceptance)).status,200);
   const reopened=(await(await f.call(path)).json()).job;assert.equal(reopened.report.sourceCoverage.segmentCount,1226);assert.equal(reopened.report.chapters.length,windows.length);assert.equal(reopened.report.sourceBinding,'CURRENT');assert.equal(reopened.report.sourceAssessment.status,'TRANSCRIPT_UNVERIFIED');assert.equal(reopened.report.audioAccuracy,'NOT_VERIFIED');
   const txt=await(await f.call(path+'/export?format=txt')).text();assert.match(txt,/실제 AI 요약이 아닙니다/);assert.match(txt,/TRANSCRIPT_UNVERIFIED/);assert.match(txt,/#1226/);
   const stored=JSON.stringify(f.sqlite.prepare('SELECT raw,segments_json,provenance FROM yta_sources WHERE job_id=?').get(id));
   assert.equal((await f.call(path+'/gemini-two-pass-accept','POST',acceptance)).status,200);assert.equal(mockGenerations,2);
   assert.equal(JSON.stringify(f.sqlite.prepare('SELECT raw,segments_json,provenance FROM yta_sources WHERE job_id=?').get(id)),stored);
   if(realSrt&&process.env.LOCAL_REVIEW_OUTPUT){const out=process.env.LOCAL_REVIEW_OUTPUT;mkdirSync(out,{recursive:true});writeFileSync(join(out,'MOCK-ONLY-report.txt'),'LOCAL TEST ONLY — NO REAL AI GENERATION\n'+txt);writeFileSync(join(out,'RESULT.json'),JSON.stringify({inputKind:'EXISTING_USER_SRT',inputSha256:createHash('sha256').update(readFileSync(realSrt)).digest('hex'),segments:segments.length,rangeMs:[segments[0].startMs,segments.at(-1).endMs],windows:windows.length,mockGenerations,mockCounts,realProviderCalls:0,networkAttempts,sourceBinding:reopened.report.sourceBinding,sourceStatus:reopened.report.sourceAssessment.status,summaryContent:'MOCK_ONLY_NOT_REAL_AI',saveReopenExport:true},null,2)+'\n');}
  }
  // Every local model/count request contains the entire stored tuple list.
  const allTuples=JSON.stringify(segments.map(s=>[s.id,s.startMs,s.endMs,s.text]));
  for(const input of observedInputs)assert.ok(input.includes(JSON.stringify(allTuples).slice(1,-1)));
  assert.equal(JSON.stringify(f.sqlite.prepare("SELECT * FROM yta_operations WHERE id='fixture-prior'").get()),history);assert.equal(networkAttempts,0);
 }finally{f.sqlite.close();}
});
