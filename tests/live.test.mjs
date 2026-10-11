import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {routeApi} from '../src/worker.mjs';
import {validateAnalysis} from '../src/report.mjs';
import {planMp3,scanMp3,mergeAudioSegments} from '../src/audio.mjs';
import {partitionTranscript,partitionSynthesis,synthesisPrompt,SUMMARY_PROMPT_LIMIT,summaryUnits} from '../src/summary-plan.mjs';
import {reportPrompt} from '../src/report.mjs';
const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
function setup({liveSchema=true}={}){const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));if(liveSchema)db.exec(readFileSync(new URL('../migrations/0002_live.sql',import.meta.url),'utf8'));const DB={prepare(sql){const make=args=>({bind(...a){return make(a);},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}});return make([]);}};return {db,env:{DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GEMINI_API_KEY:'NOT_REAL_TEST_KEY',SUPADATA_API_KEY:'NOT_REAL_TEST_KEY'}};}
async function job(env){return (await(await routeApi(request('/api/jobs','POST',{sourceType:'text',title:'LOCAL MOCK TEST',filename:'x.srt',transcript:'1\n00:00:00,000 --> 00:01:00,000\n테스트 발언입니다.',durationSeconds:60,persistTranscript:true}),env)).json()).job;}
async function grant(env,allowance=250000){const r=await routeApi(request('/api/live/quota','PUT',{provider:'gemini',allowance,requestLimit:5,billingDisabled:true,freeOnly:true}),env);assert.equal(r.status,200);}
const valid=()=>({summary:[{text:'테스트 발언',evidenceIds:[1]}],chapters:[{text:'시작 발언',evidenceIds:[1]}],claims:[],numbers:[],critical:[],conclusion:'외부 사실 미검증'});
test('GET quota and health do not create live tables; writes need explicit additive schema setup',async()=>{
 const {db,env}=setup({liveSchema:false});
 try{
  const before=db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'yta_%'").all();
  const quota=await routeApi(request('/api/live/quota'),env);
  assert.equal(quota.status,409);
  assert.equal((await quota.json()).error.code,'LIVE_SCHEMA_REQUIRED');
  assert.equal((await routeApi(request('/api/health'),env)).status,200);
  assert.equal((await routeApi(request('/api/settings/providers'),env)).status,200);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'yta_%'").all(),before);
  const created=await routeApi(request('/api/jobs','POST',{sourceType:'text',filename:'x.srt',transcript:'1\n00:00:00,000 --> 00:01:00,000\n테스트',durationSeconds:60,persistTranscript:true}),env);
  assert.equal(created.status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
  const urlJob=await routeApi(request('/api/jobs','POST',{sourceType:'url',url:'https://www.youtube.com/watch?v=2hUkTmwYm3A',durationSeconds:60}),env);
  const id=(await urlJob.json()).job.id;
  assert.equal((await routeApi(request('/api/jobs/'+id+'/source'),env)).status,409);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'yta_%'").all(),before);
  db.exec(readFileSync(new URL('../migrations/0002_live.sql',import.meta.url),'utf8'));
  const readOnly={...env,DB:{prepare(sql){assert.match(sql,/^SELECT\b/i);return env.DB.prepare(sql);}}};
  assert.equal((await routeApi(request('/api/live/quota'),readOnly)).status,200);
 }finally{db.close();}
});
test('LOCAL real SQLite: raw source persisted, export and purge remove private source/results',async()=>{const {db,env}=setup();try{const j=await job(env);const source=await(await routeApi(request('/api/jobs/'+j.id+'/source'),env)).json();assert.match(source.source.raw,/테스트 발언/);const exp=await routeApi(request('/api/jobs/'+j.id+'/export'),env);assert.match(await exp.text(),/원본 스크립트/);assert.equal((await routeApi(request('/api/jobs/'+j.id,'DELETE'),env)).status,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_sources').get().n,0);}finally{db.close();}});
test('LOCAL quota missing/too small/paid enabled never sends network calls',async()=>{const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('NETWORK MUST NOT RUN');};try{const j=await job(env);assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,409);await grant(env,1);assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,409);env.ALLOW_PAID_API='true';assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,409);assert.equal(calls,0);}finally{globalThis.fetch=old;db.close();}});
test('MOCK provider: concurrent/repeated summary sends at most once and durable result reopens',async()=>{const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(valid())}]}}]});};try{const j=await job(env);await grant(env);const results=await Promise.all([1,2].map(()=>routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,200);assert.equal(calls,1);const reopened=await(await routeApi(request('/api/jobs/'+j.id),env)).json();assert.equal(reopened.job.report.kind,'GEMINI_EVIDENCE_LINKED');assert.notEqual(reopened.job.status,'FULL_TRANSCRIPT');}finally{globalThis.fetch=old;db.close();}});
test('MOCK provider 429 expires grant; uncertain operation cannot auto retry',async()=>{const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({}, {status:429});};try{const j=await job(env);await grant(env);assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,409);assert.equal(db.prepare('SELECT expires_at FROM yta_quota').get().expires_at,0);await grant(env);assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,409);assert.equal(calls,1);}finally{globalThis.fetch=old;db.close();}});
test('MOCK invalid evidence report never saves as validated AI summary',async()=>{const {db,env}=setup(),old=fetch;const bad=valid();bad.summary[0].evidenceIds=[999];globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(bad)}]}}]});try{const j=await job(env);await grant(env);const r=await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env);assert.equal((await r.json()).error.code,'REPORT_VALIDATION_FAILED');assert.notEqual(JSON.parse(db.prepare('SELECT report_json FROM jobs').get().report_json).kind,'GEMINI_EVIDENCE_LINKED');}finally{globalThis.fetch=old;db.close();}});
test('report references checked, fact checking remains explicitly NOT_PERFORMED',()=>{const report=validateAnalysis(valid(),[{id:1}]);assert.equal(report.evidenceValidation,'REFERENCES_EXIST_ONLY');assert.equal(report.externalFactCheck,'NOT_PERFORMED');const bad=valid();bad.summary[0].evidenceIds=[];assert.throws(()=>validateAnalysis(bad,[{id:1}]));});
test('synthetic MP3 120 min plan covers all frames, frame-aligned byte limits and bounded overlap',()=>{const n=275600,size=417,bytes=new Uint8Array(n*size);for(let i=0;i<n;i++){const o=i*size;bytes.set([255,251,144,0],o);}const p=planMp3(bytes);assert.equal(p.chunks[0].start,0);assert.ok(p.durationSeconds>7199&&p.durationSeconds<7201);for(let i=0;i<p.chunks.length;i++){const c=p.chunks[i];assert.ok(c.byteEnd-c.byteStart<=8000000);assert.ok(Math.abs(scanMp3(bytes.subarray(c.byteStart,c.byteEnd)).durationSeconds-(c.end-c.start))<.001);if(i)assert.ok(c.start<=p.chunks[i-1].end&&c.start>=p.chunks[i-1].end-3.1);}assert.equal(p.chunks.at(-1).end,p.durationSeconds);});
test('MP3 scan rejects an unparsed tail instead of treating a partial file as complete',()=>{const bytes=new Uint8Array(417*3+4096);for(let i=0;i<3;i++)bytes.set([255,251,144,0],i*417);assert.throws(()=>planMp3(bytes),/MP3_UNPARSED_AUDIO/);});
test('audio merge offsets timestamps, identifies missing chunk and cannot certify completeness',()=>{const r=mergeAudioSegments([{index:0,start:0,end:300,segments:[{start:0,end:2,text:'시작'}]},{index:1,start:297,end:597,segments:[{start:10,end:12,text:'두번째'}]},{index:2,start:594,end:600,segments:[]}]);assert.equal(r.segments[1].startMs,307000);assert.deepEqual(r.missingChunks,[2]);});
test('audio merge reports a chunk whose segments are all discarded and unexplained overlap',()=>{
 const invalid=mergeAudioSegments([{index:0,start:0,end:60,segments:[{start:100,end:101,text:'범위 밖'}]},{index:1,start:60,end:120,segments:[{start:1,end:2,text:'유효'}]}]);
 assert.deepEqual(invalid.missingChunks,[0]);assert.deepEqual(invalid.rejectedSegments.map(x=>x.reason),['INVALID_SEGMENT']);
 const overlap=mergeAudioSegments([{index:0,start:0,end:60,segments:[{start:58,end:60,text:'첫 말'}]},{index:1,start:58,end:120,segments:[{start:0,end:1,text:'다른 말'},{start:5,end:6,text:'나중 말'}]}]);
 assert.deepEqual(overlap.rejectedSegments.map(x=>x.reason),['OVERLAP_UNMATCHED']);
});
test('audio resume skips completed chunks and rejects a different file or plan',async()=>{const {db,env}=setup();try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600}),env)).json();const path='/api/jobs/'+created.job.id,fileSha256='a'.repeat(64),chunks=[{index:0,start:0,end:300},{index:1,start:297,end:600}];assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256,chunks}),env)).status,200);const progress=await(await routeApi(request(path+'/audio-progress'),env)).json();assert.deepEqual(progress.chunks.map(c=>c.state),['PLANNED','PLANNED']);assert.equal(progress.complete,false);db.prepare("UPDATE yta_audio SET state='DONE',result_json=? WHERE job_id=? AND chunk_index=0").run(JSON.stringify({fileSha256,segments:[{start:0,end:1,text:'done'}]}),created.job.id);assert.equal((await(await routeApi(request(path+'/audio-chunk?index=0','POST',{}),env)).json()).cached,true);assert.equal((await routeApi(request(path+'/audio-finish','POST',{}),env)).status,409);assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'b'.repeat(64),chunks}),env)).status,400);assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256,chunks:[{index:0,start:0,end:600}]}),env)).status,400);}finally{db.close();}});
test('temporary audio results need completed coverage, durable TXT readback and separate confirmation before cleanup',async()=>{
 const {db,env}=setup();try{
  const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:120}),env)).json();
  const id=created.job.id,path='/api/jobs/'+id,sha='a'.repeat(64),chunks=[{index:0,start:0,end:60},{index:1,start:60,end:120}];
  assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:sha,chunks}),env)).status,200);
  assert.equal((await routeApi(request(path+'/audio-cleanup','POST',{confirmTemporaryTranscriptCleanup:true}),env)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_audio').get().n,2);
  for(let i=0;i<2;i++)db.prepare("UPDATE yta_audio SET state='DONE',result_json=? WHERE job_id=? AND chunk_index=?").run(JSON.stringify({fileSha256:sha,segments:[{start:1,end:2,text:'전사 '+i}]}),id,i);
  db.prepare('UPDATE yta_audio SET result_json=? WHERE job_id=? AND chunk_index=0').run(JSON.stringify({fileSha256:sha,segments:[{start:100,end:101,text:'범위 밖'}]}),id);
  assert.equal((await routeApi(request(path+'/audio-finish','POST',{}),env)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_sources').get().n,0);
  db.prepare('UPDATE yta_audio SET result_json=? WHERE job_id=? AND chunk_index=0').run(JSON.stringify({fileSha256:sha,segments:[{start:1,end:2,text:'전사 0'}]}),id);
  const finished=await routeApi(request(path+'/audio-finish','POST',{}),env);assert.equal(finished.status,200);
  for(let i=0;i<2;i++)db.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)").run(id+':audio:'+i,id,'groq',60,'DONE',new Date().toISOString(),JSON.stringify({segments:[{text:'전사 '+i}]}));
  assert.equal((await routeApi(request(path+'/audio-cleanup','POST',{}),env)).status,400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_audio').get().n,2);
  const originalRaw=db.prepare('SELECT raw FROM yta_sources WHERE job_id=?').get(id).raw;
  assert.equal(originalRaw,'전사 0\n전사 1');
  assert.match(await (await routeApi(request(path+'/export?format=txt'),env)).text(),/전사 0/);
  db.prepare('UPDATE yta_sources SET raw=? WHERE job_id=?').run('corrupted',id);
  assert.equal((await routeApi(request(path+'/audio-cleanup','POST',{confirmTemporaryTranscriptCleanup:true}),env)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_audio').get().n,2);
  db.prepare('UPDATE yta_sources SET raw=? WHERE job_id=?').run(originalRaw,id);
  const report=JSON.stringify({kind:'GEMINI_EVIDENCE_LINKED',summary:[{text:'보존',evidenceIds:[1]}]});
  db.prepare('UPDATE jobs SET report_json=? WHERE id=?').run(report,id);
  assert.equal((await(await routeApi(request(path+'/audio-finish','POST',{}),env)).json()).cached,true);
  assert.equal(db.prepare('SELECT report_json FROM jobs WHERE id=?').get(id).report_json,report);
  db.prepare('UPDATE yta_audio SET result_json=? WHERE job_id=? AND chunk_index=1').run(JSON.stringify({fileSha256:'b'.repeat(64),segments:[{start:1,end:2,text:'전사 1'}]}),id);
  assert.equal((await routeApi(request(path+'/audio-finish','POST',{}),env)).status,409);
  assert.equal((await routeApi(request(path+'/audio-cleanup','POST',{confirmTemporaryTranscriptCleanup:true}),env)).status,409);
  assert.equal(db.prepare('SELECT report_json FROM jobs WHERE id=?').get(id).report_json,report);
  db.prepare('UPDATE yta_audio SET result_json=? WHERE job_id=? AND chunk_index=1').run(JSON.stringify({fileSha256:sha,segments:[{start:1,end:2,text:'전사 1'}]}),id);
  db.prepare('UPDATE yta_operations SET state=? WHERE id=?').run('FAILED_UNCERTAIN',id+':audio:1');
  assert.equal((await routeApi(request(path+'/audio-cleanup','POST',{confirmTemporaryTranscriptCleanup:true}),env)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_audio').get().n,2);
  db.prepare('UPDATE yta_operations SET state=? WHERE id=?').run('DONE',id+':audio:1');
  const cleaned=await routeApi(request(path+'/audio-cleanup','POST',{confirmTemporaryTranscriptCleanup:true}),env);assert.equal(cleaned.status,200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_audio').get().n,0);
  const operation=db.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').get(id+':audio:0');assert.equal(operation.state,'DONE');assert.equal(operation.result_json,null);
  assert.equal(db.prepare('SELECT raw FROM yta_sources WHERE job_id=?').get(id).raw,originalRaw);
  assert.equal(db.prepare('SELECT report_json FROM jobs WHERE id=?').get(id).report_json,report);
  const replay=await(await routeApi(request(path+'/audio-finish','POST',{}),env)).json();assert.equal(replay.cached,true);assert.equal(replay.job.report.kind,'GEMINI_EVIDENCE_LINKED');
  assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:sha,chunks}),env)).status,400);
 }finally{db.close();}
});
test('summary partitions full transcript without truncation or over-budget requests',()=>{const segments=Array.from({length:240},(_,i)=>({id:i+1,startMs:i*24000,endMs:(i+1)*24000,text:'발언 내용 '.repeat(65)}));const groups=partitionTranscript(segments,{status:'TRANSCRIPT_UNVERIFIED'});assert.ok(groups.length>2);assert.deepEqual(groups.flat().map(s=>s.id),segments.map(s=>s.id));for(const group of groups){const prompt=reportPrompt(group,{status:'TRANSCRIPT_UNVERIFIED'});assert.ok(prompt.length<=SUMMARY_PROMPT_LIMIT);assert.ok(summaryUnits(prompt)<=250000);}const partial=groups.map(g=>({ids:[g[0].id],report:valid()}));for(const batch of partitionSynthesis(partial,{}))assert.ok(synthesisPrompt(batch,{}).length<=SUMMARY_PROMPT_LIMIT);});
test('MOCK long summary resumes completed stages after renewed grants without duplicate calls',async()=>{
 const {db,env}=setup(),old=fetch;let calls=0;
 const transcript=Array.from({length:140},(_,i)=>{const start=i*25,end=(i+1)*25,stamp=n=>`00:${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')},000`;return `${i+1}\n${stamp(start)} --> ${stamp(end)}\n${'근거 발언 '.repeat(90)}`;}).join('\n\n');
 globalThis.fetch=async(_url,options)=>{calls++;const prompt=JSON.parse(options.body).contents[0].parts[0].text;let ids;if(prompt.includes('전사 배열 [id,startMs,endMs,text]:')){const rows=JSON.parse(prompt.split('전사 배열 [id,startMs,endMs,text]:\n')[1]);ids=[rows[0][0],rows.at(-1)[0]];}else{const groups=JSON.parse(prompt.split('시간 순서별 부분 보고서:\n')[1]);ids=groups.map(g=>g.ids[0]);}return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({summary:[{text:'전체 근거 요약',evidenceIds:[ids[0]]}],chapters:ids.map(id=>({text:'시간 구간',evidenceIds:[id]})),claims:[],numbers:[],critical:[],conclusion:'전체 전사 기준, 독립 검증 필요'})}]}}]});};
 try{
  const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'text',title:'LONG MOCK',filename:'long.srt',transcript,durationSeconds:3500,persistTranscript:true}),env)).json();const id=created.job.id;
  const plan=await(await routeApi(request('/api/jobs/'+id+'/summary-plan'),env)).json();assert.ok(plan.stages>1);assert.ok(plan.firstPassUnits>250000);
  assert.equal((await routeApi(request('/api/jobs/'+id+'/summary','POST',{}),env)).status,400);assert.equal(calls,0);
  let completed=false;for(let round=0;round<8;round++){
   await grant(env);const response=await routeApi(request('/api/jobs/'+id+'/summary','POST',{allowStaged:true}),env);
   if(response.status===200){completed=true;break;}
   assert.equal((await response.json()).error.code,'QUOTA_EXHAUSTED');
   db.prepare('UPDATE yta_quota SET expires_at=0').run();
  }
  assert.equal(completed,true);assert.equal(calls,db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='gemini' AND state='DONE'").get().n);
  const reopened=await(await routeApi(request('/api/jobs/'+id),env)).json();assert.equal(reopened.job.report.kind,'GEMINI_EVIDENCE_LINKED');assert.ok(reopened.job.report.chapters.length>=plan.stages);
  assert.equal((await routeApi(request('/api/jobs/'+id+'/summary','POST',{}),env)).status,200);assert.equal(calls,db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='gemini' AND state='DONE'").get().n);
 }finally{globalThis.fetch=old;db.close();}
});
