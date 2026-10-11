import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {routeApi} from '../src/worker.mjs';
import {validateAnalysis} from '../src/report.mjs';
import {planMp3,scanMp3,prepareMp3Chunk,mergeAudioSegments} from '../src/audio.mjs';
import {partitionTranscript,partitionSynthesis,synthesisPrompt,SUMMARY_PROMPT_LIMIT,summaryUnits} from '../src/summary-plan.mjs';
import {reportPrompt} from '../src/report.mjs';
const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
function setup({liveSchema=true}={}){const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));if(liveSchema){db.exec(readFileSync(new URL('../migrations/0002_live.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0003_observed_capacity.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0005_reviewed_free_recovery.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0006_unknown_groq_probe.sql',import.meta.url),'utf8'));const now=Date.now();for(const [provider,model,remaining] of [['gemini','gemini-2.5-flash',{requestsMinute:1000,tokensMinute:1000000000,requestsDay:1000}],['groq','whisper-large-v3-turbo',{requestsMinute:1000,audioSecondsHour:100000,audioSecondsDay:100000}]])db.prepare('INSERT INTO yta_capacity(provider,model,source,observed_at,valid_until,reset_json,remaining_json,reserved_json,billing_disabled) VALUES(?,?,?,?,?,?,?,?,1)').run(provider,(model),({gemini:'AI_STUDIO_LIVE',groq:'GROQ_CONSOLE_LIVE'})[provider]+':'+createHash('sha256').update(provider+':NOT_REAL_TEST_KEY').digest('hex'),now,now+60000,JSON.stringify(Object.fromEntries(Object.keys(remaining).map(key=>[key,now+3600000]))),JSON.stringify(remaining),JSON.stringify(Object.fromEntries(Object.keys(remaining).map(key=>[key,0]))));}const DB={prepare(sql){const make=args=>({bind(...a){return make(a);},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}});return make([]);}};return {db,env:{DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GEMINI_API_KEY:'NOT_REAL_TEST_KEY',GROQ_API_KEY:'NOT_REAL_TEST_KEY',SUPADATA_API_KEY:'NOT_REAL_TEST_KEY'}};}
async function job(env){return (await(await routeApi(request('/api/jobs','POST',{sourceType:'text',title:'LOCAL MOCK TEST',filename:'x.srt',transcript:'1\n00:00:00,000 --> 00:01:00,000\n테스트 발언입니다.',durationSeconds:60,persistTranscript:true}),env)).json()).job;}
async function grant(env,allowance=250000){const r=await routeApi(request('/api/live/quota','PUT',{provider:'gemini',allowance,requestLimit:5,billingDisabled:true,freeOnly:true}),env);assert.equal(r.status,200);}
async function consent(env,id,sha){const r=await routeApi(request('/api/jobs/'+id+'/audio-consent','POST',{provider:'gemini',fileSha256:sha,consent:true}),env);assert.equal(r.status,200);}
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
test('concurrent grant renewal cannot erase a reservation made between renewals',async()=>{
 const {db,env}=setup(),old=fetch;let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let delayed=true;
 const delayedDB={prepare(sql){const stmt=env.DB.prepare(sql);if(!sql.startsWith('UPDATE yta_quota SET allowance='))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {...bound,async run(){if(delayed){delayed=false;entered();await gate;}return bound.run();}};}};}};
 globalThis.fetch=async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(valid())}]}}]});
 try{const j=await job(env);await grant(env);db.prepare('UPDATE yta_quota SET expires_at=0').run();const body={provider:'gemini',allowance:250000,requestLimit:5,billingDisabled:true,freeOnly:true};const second=routeApi(request('/api/live/quota','PUT',body),{...env,DB:delayedDB});await waiting;assert.equal((await routeApi(request('/api/live/quota','PUT',body),env)).status,200);assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,200);const before=db.prepare('SELECT consumed,request_count FROM yta_quota').get();assert.ok(before.consumed>0);assert.equal(before.request_count,1);release();assert.equal((await second).status,409);assert.deepEqual(db.prepare('SELECT consumed,request_count FROM yta_quota').get(),before);}finally{release();globalThis.fetch=old;db.close();}
});
test('MOCK provider: concurrent/repeated summary sends at most once and durable result reopens',async()=>{const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(valid())}]}}]});};try{const j=await job(env);await grant(env);const results=await Promise.all([1,2].map(()=>routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,200);assert.equal(calls,1);const reopened=await(await routeApi(request('/api/jobs/'+j.id),env)).json();assert.equal(reopened.job.report.kind,'GEMINI_EVIDENCE_LINKED');assert.notEqual(reopened.job.status,'FULL_TRANSCRIPT');}finally{globalThis.fetch=old;db.close();}});
test('delayed dispatch blocks other jobs even after claim ages; completion starts cooldown',async()=>{
 const {db,env}=setup(),old=fetch;let calls=0,releaseKey,enteredKey;
 const keyGate=new Promise(resolve=>{releaseKey=resolve;}),keyEntered=new Promise(resolve=>{enteredKey=resolve;});
 let firstLookup=true;
 const delayedDB={prepare(sql){const statement=env.DB.prepare(sql);if(!sql.startsWith('SELECT cipher_version,iv_b64,ciphertext_b64'))return statement;return {bind(...args){const bound=statement.bind(...args);return {...bound,async first(){if(firstLookup){firstLookup=false;enteredKey();await keyGate;}return bound.first();}};}};}};
 globalThis.fetch=async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(valid())}]}}]});};
 try{
  const a=await job(env),b=await job(env);await grant(env);
  const first=routeApi(request('/api/jobs/'+a.id+'/summary','POST',{}),{...env,DB:delayedDB});
  await Promise.race([keyEntered,new Promise((_,reject)=>setTimeout(()=>reject(Error('key lookup did not start')),1000))]);
  db.prepare("UPDATE yta_operations SET created_at=? WHERE provider='gemini' AND state='CLAIMED'").run(new Date(Date.now()-600000).toISOString());
  const blocked=await routeApi(request('/api/jobs/'+b.id+'/summary','POST',{}),env);
  assert.equal(blocked.status,409);assert.equal((await blocked.json()).error.code,'OPERATION_REVIEW_REQUIRED');assert.equal(calls,0);
  releaseKey();assert.equal((await first).status,200);assert.equal(calls,1);
  const early=await routeApi(request('/api/jobs/'+b.id+'/summary','POST',{}),env);
  assert.equal(early.status,409);assert.equal((await early.json()).error.code,'RATE_LIMIT_PENDING');assert.equal(calls,1);
  db.prepare("UPDATE yta_operations SET created_at=? WHERE provider='gemini' AND state='DONE'").run(new Date(Date.now()-14000).toISOString());
  assert.equal((await routeApi(request('/api/jobs/'+b.id+'/summary','POST',{}),env)).status,200);assert.equal(calls,2);
 }finally{releaseKey();globalThis.fetch=old;db.close();}
});
test('stale unknown Gemini claim blocks new jobs with explicit review status',async()=>{
 const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('NETWORK MUST NOT RUN');};
 try{const j=await job(env);await grant(env);db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run('stuck-claim',j.id,'gemini',1,'CLAIMED',new Date(Date.now()-3600000).toISOString());const response=await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'OPERATION_REVIEW_REQUIRED');assert.equal(calls,0);assert.equal(db.prepare('SELECT request_count FROM yta_quota').get().request_count,0);}finally{globalThis.fetch=old;db.close();}
});
test('MOCK provider 429 expires grant; uncertain operation cannot auto retry or reserve twice',async()=>{const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({}, {status:429});};try{const j=await job(env);await grant(env);assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,409);assert.equal(db.prepare('SELECT expires_at FROM yta_quota').get().expires_at,0);assert.equal(db.prepare('SELECT request_count FROM yta_quota').get().request_count,1);await grant(env);assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,409);assert.equal(calls,1);assert.equal(db.prepare('SELECT request_count FROM yta_quota').get().request_count,0);assert.equal(db.prepare("SELECT state FROM yta_operations WHERE provider='gemini'").get().state,'FAILED_UNCERTAIN');}finally{globalThis.fetch=old;db.close();}});
test('MOCK invalid evidence report never saves as validated AI summary',async()=>{const {db,env}=setup(),old=fetch;const bad=valid();bad.summary[0].evidenceIds=[999];globalThis.fetch=async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(bad)}]}}]});try{const j=await job(env);await grant(env);const r=await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env);assert.equal((await r.json()).error.code,'REPORT_VALIDATION_FAILED');assert.notEqual(JSON.parse(db.prepare('SELECT report_json FROM jobs').get().report_json).kind,'GEMINI_EVIDENCE_LINKED');}finally{globalThis.fetch=old;db.close();}});
test('valid-looking Gemini summary JSON with MAX_TOKENS or SAFETY remains uncertain and reviewable',async()=>{
 const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>Response.json({candidates:[{finishReason:++calls===1?'MAX_TOKENS':'SAFETY',content:{parts:[{text:JSON.stringify(valid())}]}}]});
 try{await grant(env);for(const reason of ['MAX_TOKENS','SAFETY']){const j=await job(env),path='/api/jobs/'+j.id;
  const response=await routeApi(request(path+'/summary','POST',{}),env);assert.equal((await response.json()).error.code,'SUMMARY_FINISH_UNVERIFIED');
  const review=await(await routeApi(request(path+'/summary-review'),env)).json();assert.equal(review.finishReason,reason);assert.match(review.partialText,/summary/);
  assert.notEqual(JSON.parse(db.prepare('SELECT report_json FROM jobs WHERE id=?').get(j.id).report_json)?.kind,'GEMINI_EVIDENCE_LINKED');
  const repeated=await routeApi(request(path+'/summary','POST',{}),env);assert.equal((await repeated.json()).error.code,'OPERATION_REVIEW_REQUIRED');assert.equal(calls,reason==='MAX_TOKENS'?1:2);
  db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=?").run(new Date(Date.now()-14000).toISOString(),j.id);
 }}finally{globalThis.fetch=old;db.close();}
});
test('report references checked, fact checking remains explicitly NOT_PERFORMED',()=>{const report=validateAnalysis(valid(),[{id:1}]);assert.equal(report.evidenceValidation,'REFERENCES_EXIST_ONLY');assert.equal(report.externalFactCheck,'NOT_PERFORMED');const bad=valid();bad.summary[0].evidenceIds=[];assert.throws(()=>validateAnalysis(bad,[{id:1}]));});
test('synthetic MP3 120 min plan covers all frames, frame-aligned byte limits and bounded overlap',()=>{const n=275600,size=417,bytes=new Uint8Array(n*size);for(let i=0;i<n;i++){const o=i*size;bytes.set([255,251,144,0],o);}const p=planMp3(bytes);assert.equal(p.chunks[0].start,0);assert.ok(p.durationSeconds>7199&&p.durationSeconds<7201);for(let i=0;i<p.chunks.length;i++){const c=p.chunks[i];assert.ok(c.byteEnd-c.byteStart<=8000000);assert.ok(Math.abs(scanMp3(bytes.subarray(c.byteStart,c.byteEnd)).durationSeconds-(c.end-c.start))<.001);if(i)assert.ok(c.start<=p.chunks[i-1].end&&c.start>=p.chunks[i-1].end-3.1);}assert.equal(p.chunks.at(-1).end,p.durationSeconds);});
test('MP3 chunk metadata correction preserves the complete frame plan and source bytes',()=>{
 const frames=4000,size=417,bytes=new Uint8Array(frames*size);for(let i=0;i<frames;i++)bytes.set([255,251,144,0],i*size);
 bytes.set(new TextEncoder().encode('Xing'),36);bytes.set([0,0,0,3],40);new DataView(bytes.buffer).setUint32(44,frames-1);new DataView(bytes.buffer).setUint32(48,bytes.length);
 const original=bytes.slice(),plan=planMp3(bytes,{chunkSeconds:10});assert.ok(plan.chunks.length>1);
 const first=bytes.subarray(plan.chunks[0].byteStart,plan.chunks[0].byteEnd),second=bytes.subarray(plan.chunks[1].byteStart,plan.chunks[1].byteEnd);
 assert.equal(new TextDecoder().decode(first.subarray(36,40)),'Xing');assert.notEqual(new TextDecoder().decode(second.subarray(36,40)),'Xing');
 const clean=prepareMp3Chunk(first);assert.equal(clean.metadataCorrected,true);assert.equal(clean.bytes.length,first.length);assert.deepEqual(clean.bytes.subarray(size),first.subarray(size));
 assert.equal(new DataView(clean.bytes.buffer).getUint32(44),scanMp3(first).frames.length-1);assert.equal(new DataView(clean.bytes.buffer).getUint32(48),clean.bytes.length);
 assert.equal(prepareMp3Chunk(clean.bytes).metadataCorrected,false);assert.deepEqual(bytes,original);assert.equal(plan.chunks[0].start,0);
 assert.equal(scanMp3(clean.bytes).durationSeconds,scanMp3(first).durationSeconds);
 const unsafe=first.slice();unsafe[36]=0;unsafe.set(new TextEncoder().encode('VBRI'),36);assert.throws(()=>prepareMp3Chunk(unsafe),/MP3_METADATA_UNSUPPORTED/);
});
test('LAME Xing correction keeps Buffer input immutable and updates tag CRC and gapless end padding',()=>{
 const bytes=Buffer.alloc(1000*417);for(let i=0;i<1000;i++)bytes.set([255,251,144,0],i*417);
 bytes.write('Xing',36);bytes.writeUInt32BE(15,40);bytes.writeUInt32BE(999,44);bytes.writeUInt32BE(bytes.length,48);bytes.write('Lavc',156);
 bytes[177]=0x12;bytes[178]=0x34;bytes[179]=0x56;
 const crc=data=>{let value=0;for(const byte of data){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>1)^((value&1)?0xa001:0);}return value;};
 bytes.writeUInt16BE(crc(bytes.subarray(0,190)),190);
 const original=Buffer.from(bytes),first=bytes.subarray(0,383*417),clean=prepareMp3Chunk(first);
 assert.equal(clean.metadataCorrected,true);assert.equal(clean.bytes.length,first.length);assert.deepEqual(bytes,original);
 assert.equal(new DataView(clean.bytes.buffer).getUint32(44),382);assert.equal(new DataView(clean.bytes.buffer).getUint32(48),first.length);
 assert.equal(clean.bytes[177],0x12);assert.equal(clean.bytes[178],0x30);assert.equal(clean.bytes[179],0);
 assert.equal(new DataView(clean.bytes.buffer).getUint16(190),crc(clean.bytes.subarray(0,190)));
 assert.deepEqual(Buffer.from(clean.bytes.subarray(417)),first.subarray(417));assert.equal(prepareMp3Chunk(clean.bytes).metadataCorrected,false);
});
test('CRC-protected Xing location and mono FFmpeg fixed-span CRC are recognized',()=>{
 const frameSize=417,frames=383,bytes=new Uint8Array(frames*frameSize);for(let i=0;i<frames;i++)bytes.set([255,250,144,0],i*frameSize);
 bytes.set(new TextEncoder().encode('Xing'),36);bytes.set([0,0,0,3],40);new DataView(bytes.buffer).setUint32(44,1000);new DataView(bytes.buffer).setUint32(48,500000);
 assert.equal(prepareMp3Chunk(bytes).metadataCorrected,true);
 const mono=new Uint8Array(frames*frameSize);for(let i=0;i<frames;i++)mono.set([255,251,144,192],i*frameSize);
 mono.set(new TextEncoder().encode('Info'),21);new DataView(mono.buffer).setUint32(25,15);new DataView(mono.buffer).setUint32(29,1000);new DataView(mono.buffer).setUint32(33,500000);mono.set(new TextEncoder().encode('Lavf'),141);
 const crc=data=>{let value=0;for(const byte of data){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>1)^((value&1)?0xa001:0);}return value;};
 const tag=mono.slice(0,190);tag.fill(0,175,177);new DataView(mono.buffer).setUint16(175,crc(tag));
 const fixed=prepareMp3Chunk(mono);assert.equal(fixed.metadataCorrected,true);const corrected=fixed.bytes.slice(0,190);corrected.fill(0,175,177);assert.equal(new DataView(fixed.bytes.buffer).getUint16(175),crc(corrected));
});
test('LAME mono MPEG-1 and MPEG-2 tags use the variable CRC span',()=>{
 const crc=data=>{let value=0;for(const byte of data){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>1)^((value&1)?0xa001:0);}return value;};
 for(const {header,size,xing} of [{header:[255,251,144,192],size:417,xing:21},{header:[255,243,144,192],size:261,xing:13}]){
  const frames=383,bytes=new Uint8Array(frames*size),view=new DataView(bytes.buffer);
  for(let i=0;i<frames;i++)bytes.set(header,i*size);
  bytes.set(new TextEncoder().encode('Info'),xing);view.setUint32(xing+4,15);view.setUint32(xing+8,1000);view.setUint32(xing+12,500000);
  bytes.set(new TextEncoder().encode('LAME'),xing+120);view.setUint16(xing+154,crc(bytes.subarray(0,xing+154)));
  const original=bytes.slice(),prepared=prepareMp3Chunk(bytes);
  assert.equal(prepared.metadataCorrected,true);assert.deepEqual(bytes,original);
  assert.equal(new DataView(prepared.bytes.buffer).getUint16(xing+154),crc(prepared.bytes.subarray(0,xing+154)));
  assert.deepEqual(prepared.bytes.subarray(size),original.subarray(size));
 }
});
test('FFmpeg mono MPEG-1 and MPEG-2 Xing tags retain decodable PCM after correction',t=>{
 if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('FFmpeg unavailable');return;}
 const dir=mkdtempSync(join(tmpdir(),'yta-ffmpeg-crc-'));
 try{for(const sampleRate of ['44100','22050']){
  const source=join(dir,`source-${sampleRate}.mp3`),sliced=join(dir,`slice-${sampleRate}.mp3`);
  assert.equal(spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=12','-ac','1','-ar',sampleRate,'-c:a','libmp3lame','-b:a','64k','-y',source]).status,0);
  const full=readFileSync(source),chunk=planMp3(full,{chunkSeconds:10}).chunks[0],input=full.subarray(chunk.byteStart,chunk.byteEnd);
  const xing=sampleRate==='44100'?21:13;assert.equal(Buffer.from(input).toString('ascii',xing,xing+4),'Info');
  const encoder=Buffer.from(input).toString('ascii',xing+120,xing+124);assert.ok(['Lavf','Lavc'].includes(encoder),encoder);
  const prepared=prepareMp3Chunk(input);assert.equal(prepared.metadataCorrected,true);
  assert.deepEqual(Buffer.from(prepared.bytes.subarray(scanMp3(input).frames[0].byteEnd)),input.subarray(scanMp3(input).frames[0].byteEnd));
  writeFileSync(sliced,prepared.bytes);const decoded=spawnSync('ffmpeg',['-v','error','-i',sliced,'-f','s16le','-'],{maxBuffer:3000000});
  assert.equal(decoded.status,0);assert.ok(decoded.stdout.length>sampleRate*2*8);
 }}finally{rmSync(dir,{recursive:true,force:true});}
});
test('flags=3 encoder extension with nonzero end padding fails closed',()=>{
 const bytes=new Uint8Array(383*417);for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);
 bytes.set(new TextEncoder().encode('Xing'),36);new DataView(bytes.buffer).setUint32(40,3);new DataView(bytes.buffer).setUint32(44,1000);new DataView(bytes.buffer).setUint32(48,500000);
 bytes.set(new TextEncoder().encode('LAME'),52);bytes[73]=0x24;bytes[74]=0x32;bytes[75]=0x10;const original=bytes.slice();
 assert.throws(()=>prepareMp3Chunk(bytes),/MP3_XING_EXTENSION_UNSUPPORTED/);assert.deepEqual(bytes,original);
});
test('FFmpeg flags=3 encoder extension fixture retains decoded samples and is rejected for slicing',t=>{
 if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('FFmpeg unavailable');return;}
 const dir=mkdtempSync(join(tmpdir(),'yta-flags3-'));
 try{const original=join(dir,'original.mp3'),altered=join(dir,'flags3.mp3');assert.equal(spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=12','-ac','1','-ar','44100','-c:a','libmp3lame','-b:a','64k','-y',original]).status,0);
  const input=readFileSync(original),output=Buffer.from(input),base=scanMp3(input).frames[0].byteStart,xing=base+21,extension=Buffer.from(input.subarray(xing+120,xing+156));
  assert.equal(output.toString('ascii',xing,xing+4),'Info');assert.ok((extension[21]<<16|extension[22]<<8|extension[23]&4095)!==0);
  output.writeUInt32BE(3,xing+4);extension.copy(output,xing+16);writeFileSync(altered,output);
  const decode=path=>{const result=spawnSync('ffmpeg',['-v','error','-i',path,'-f','s16le','-'],{maxBuffer:2000000});assert.equal(result.status,0);return result.stdout;};
  assert.equal(decode(original).length,decode(altered).length);
  const first=planMp3(output,{chunkSeconds:10}).chunks[0],slice=output.subarray(first.byteStart,first.byteEnd),before=Buffer.from(slice);
  assert.throws(()=>prepareMp3Chunk(slice),/MP3_XING_EXTENSION_UNSUPPORTED/);assert.deepEqual(slice,before);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('MP3 scan rejects an unparsed tail instead of treating a partial file as complete',()=>{const bytes=new Uint8Array(417*3+4096);for(let i=0;i<3;i++)bytes.set([255,251,144,0],i*417);assert.throws(()=>planMp3(bytes),/MP3_UNPARSED_AUDIO/);});
test('audio merge offsets timestamps, identifies missing chunk and cannot certify completeness',()=>{const r=mergeAudioSegments([{index:0,start:0,end:300,segments:[{start:0,end:2,text:'시작'}]},{index:1,start:297,end:597,segments:[{start:10,end:12,text:'두번째'}]},{index:2,start:594,end:600,segments:[]}]);assert.equal(r.segments[1].startMs,307000);assert.deepEqual(r.missingChunks,[2]);});
test('audio merge reports a chunk whose segments are all discarded and unexplained overlap',()=>{
 const invalid=mergeAudioSegments([{index:0,start:0,end:60,segments:[{start:100,end:101,text:'범위 밖'}]},{index:1,start:60,end:120,segments:[{start:1,end:2,text:'유효'}]}]);
 assert.deepEqual(invalid.missingChunks,[0]);assert.deepEqual(invalid.rejectedSegments.map(x=>x.reason),['INVALID_SEGMENT']);
 const overlap=mergeAudioSegments([{index:0,start:0,end:60,segments:[{start:58,end:60,text:'첫 말'}]},{index:1,start:58,end:120,segments:[{start:0,end:1,text:'다른 말'},{start:5,end:6,text:'나중 말'}]}]);
 assert.deepEqual(overlap.rejectedSegments.map(x=>x.reason),['OVERLAP_UNMATCHED']);
 const distinctSpeech=mergeAudioSegments([{index:0,start:0,end:60,segments:[{start:54,end:55,text:'네'}]},{index:1,start:58,end:120,segments:[{start:.5,end:1.5,text:'네'},{start:7,end:8,text:'다음'}]}]);
 assert.deepEqual(distinctSpeech.rejectedSegments.map(x=>x.reason),['OVERLAP_UNMATCHED']);
 const sameSpeech=mergeAudioSegments([{index:0,start:0,end:60,segments:[{start:58.5,end:59.5,text:'네'}]},{index:1,start:58,end:120,segments:[{start:.5,end:1.5,text:'네'},{start:7,end:8,text:'다음'}]}]);
 assert.deepEqual(sameSpeech.rejectedSegments.map(x=>x.reason),['OVERLAP_DUPLICATE']);
 assert.deepEqual(sameSpeech.segments.map(x=>x.text),['네','다음']);
});
test('audio resume skips completed chunks and rejects a different file or plan',async()=>{const {db,env}=setup();try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:600}),env)).json();const path='/api/jobs/'+created.job.id,fileSha256='a'.repeat(64),chunks=[{index:0,start:0,end:300},{index:1,start:297,end:600}];assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256,chunks}),env)).status,200);const progress=await(await routeApi(request(path+'/audio-progress'),env)).json();assert.deepEqual(progress.chunks.map(c=>c.state),['PLANNED','PLANNED']);assert.equal(progress.complete,false);db.prepare("UPDATE yta_audio SET state='DONE',result_json=? WHERE job_id=? AND chunk_index=0").run(JSON.stringify({fileSha256,segments:[{start:0,end:1,text:'done'}]}),created.job.id);assert.equal((await(await routeApi(request(path+'/audio-chunk?index=0','POST',{}),env)).json()).cached,true);assert.equal((await routeApi(request(path+'/audio-finish','POST',{}),env)).status,409);assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'b'.repeat(64),chunks}),env)).status,400);assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256,chunks:[{index:0,start:0,end:600}]}),env)).status,400);}finally{db.close();}});
test('corrected MP3 metadata is required for upload without shifting segment times or file identity',async()=>{
 const {db,env}=setup(),old=fetch,raw=new Uint8Array(383*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<383;i++)raw.set([255,251,144,0],i*417);raw.set(new TextEncoder().encode('Xing'),36);raw.set([0,0,0,3],40);new DataView(raw.buffer).setUint32(44,382);new DataView(raw.buffer).setUint32(48,raw.length);const duration=scanMp3(raw).durationSeconds;
 // The original full-file tag describes more frames than this one upload chunk.
 new DataView(raw.buffer).setUint32(44,1000);new DataView(raw.buffer).setUint32(48,500000);const clean=prepareMp3Chunk(raw);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({text:'전사',segments:[{start:1,end:2,text:'보존'}]});};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:duration}),env)).json(),id=created.job.id,path='/api/jobs/'+id,sha='d'.repeat(64);await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:sha,chunks:[{index:0,start:0,end:duration}]}),env);await routeApi(request('/api/live/quota','PUT',{provider:'groq',allowance:100,requestLimit:5,billingDisabled:true,freeOnly:true}),env);const send=body=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body}),env);assert.equal((await send(raw)).status,400);assert.equal(calls,0);assert.equal((await send(clean.bytes)).status,200);assert.equal(calls,1);const row=db.prepare('SELECT result_json FROM yta_audio WHERE job_id=?').get(id),saved=JSON.parse(row.result_json);assert.equal(saved.segments[0].start,1);assert.equal(saved.fileSha256,sha);assert.equal((await(await routeApi(request(path+'/audio-finish','POST',{}),env)).json()).persisted,true);}finally{globalThis.fetch=old;db.close();}
});
test('owner-reviewed Groq 429 recovery preserves failed history, completed chunks and TXT',async()=>{
 const {db,env}=setup(),old=fetch,frames=383,bytes=new Uint8Array(frames*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<frames;i++)bytes.set([255,251,144,0],i*417);
 const seconds=scanMp3(bytes).durationSeconds,sha='a'.repeat(64);let calls=0;
 globalThis.fetch=async()=>{calls++;if(calls===2)return Response.json({error:'rate_limit_exceeded'},{status:429});return Response.json({text:'전사',segments:[{start:1,end:2,text:'전사 '+calls}]});};
 const upload=(path,index,confirmed=false,operationId=null)=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index='+index+'&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream',...(confirmed?{'x-provider-log-429-no-output-confirmed':'true','x-provider-log-429-operation-id':operationId}:{})},body:bytes}),env);
 const grantGroq=()=>routeApi(request('/api/live/quota','PUT',{provider:'groq',allowance:100,requestLimit:5,billingDisabled:true,freeOnly:true}),env);
 try{
  const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds*2}),env)).json(),id=created.job.id,path='/api/jobs/'+id;
  assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:sha,chunks:[{index:0,start:0,end:seconds},{index:1,start:seconds,end:seconds*2}]}),env)).status,200);
  assert.equal((await grantGroq()).status,200);assert.equal((await upload(path,0)).status,200);
  const failed=await upload(path,1);assert.equal(failed.status,409);assert.equal((await failed.json()).error.code,'429');
  const progress=await(await routeApi(request(path+'/audio-progress'),env)).json();assert.equal(progress.complete,false);assert.equal(progress.chunks[1].reviewed429Required,true);assert.equal(progress.coveragePercent,50);assert.ok(Math.abs(progress.confirmedThroughSeconds-seconds)<.001);
  assert.equal((await upload(path,1,true,progress.chunks[1].reviewOperationId)).status,409);assert.equal(calls,2); // Expired grant still blocks even with confirmation.
  assert.equal((await grantGroq()).status,200);
  const denied=await upload(path,1);assert.equal((await denied.json()).error.code,'PROVIDER_429_REVIEW_REQUIRED');assert.equal(calls,2);
  const stale=await upload(path,1,true,'different-attempt');assert.equal((await stale.json()).error.code,'PROVIDER_429_REVIEW_REQUIRED');assert.equal(calls,2);
  const cooling=await upload(path,1,true,progress.chunks[1].reviewOperationId);assert.equal((await cooling.json()).error.code,'GROQ_COOLDOWN_PENDING');assert.equal(calls,2);
  db.prepare("UPDATE yta_operations SET created_at=? WHERE provider='groq' AND error_code='429'").run(new Date(Date.now()-3601000).toISOString());
  assert.equal((await upload(path,1,true,progress.chunks[1].reviewOperationId)).status,200);assert.equal(calls,3);
  const original=db.prepare('SELECT state,error_code,result_json FROM yta_operations WHERE id=?').get(id+':audio:1');assert.equal(original.state,'FAILED_UNCERTAIN');assert.equal(original.error_code,'429');assert.equal(original.result_json,null);
  assert.equal(db.prepare('SELECT state FROM yta_operations WHERE id=?').get(id+':audio:1:reviewed429:1').state,'DONE');
  const finished=await(await routeApi(request(path+'/audio-finish','POST',{}),env)).json();assert.equal(finished.persisted,true);assert.equal(finished.job.report,null);assert.match(await(await routeApi(request(path+'/export?format=txt'),env)).text(),/전사 1/);
  const cleaned=await routeApi(request(path+'/audio-cleanup','POST',{confirmTemporaryTranscriptCleanup:true}),env);assert.equal(cleaned.status,200);assert.equal(db.prepare('SELECT state,error_code FROM yta_operations WHERE id=?').get(id+':audio:1').error_code,'429');
 }finally{globalThis.fetch=old;db.close();}
});
test('Groq confirmation is bound to the latest failed attempt, never reused for a later 429',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);const seconds=scanMp3(bytes).durationSeconds;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:'rate_limit_exceeded'},{status:429});};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),id=created.job.id,path='/api/jobs/'+id;await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'e'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);const grantAudio=()=>routeApi(request('/api/live/quota','PUT',{provider:'groq',allowance:100,requestLimit:5,billingDisabled:true,freeOnly:true}),env);const upload=(attempt)=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream',...(attempt?{'x-provider-log-429-no-output-confirmed':'true','x-provider-log-429-operation-id':attempt}:{})},body:bytes}),env);await grantAudio();assert.equal((await(await upload()).json()).error.code,'429');const original=(await(await routeApi(request(path+'/audio-progress'),env)).json()).chunks[0].reviewOperationId;db.prepare('UPDATE yta_operations SET created_at=? WHERE error_code=?').run(new Date(Date.now()-3601000).toISOString(),'429');await grantAudio();assert.equal((await(await upload(original)).json()).error.code,'429');assert.equal(calls,2);const latest=(await(await routeApi(request(path+'/audio-progress'),env)).json()).chunks[0].reviewOperationId;assert.notEqual(latest,original);db.prepare('UPDATE yta_operations SET created_at=? WHERE error_code=?').run(new Date(Date.now()-3601000).toISOString(),'429');await grantAudio();assert.equal((await(await upload(original)).json()).error.code,'PROVIDER_429_REVIEW_REQUIRED');assert.equal(calls,2);assert.equal((await(await upload(latest)).json()).error.code,'429');assert.equal(calls,3);}finally{globalThis.fetch=old;db.close();}
});
test('unknown Groq failure cannot use the 429 recovery confirmation',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);const seconds=scanMp3(bytes).durationSeconds;let calls=0;
 globalThis.fetch=async()=>{calls++;throw Error('network outcome unknown');};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),id=created.job.id,path='/api/jobs/'+id;await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'b'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);await routeApi(request('/api/live/quota','PUT',{provider:'groq',allowance:100,requestLimit:5,billingDisabled:true,freeOnly:true}),env);const upload=()=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream','x-provider-log-429-no-output-confirmed':'true'},body:bytes}),env);assert.equal((await upload()).status,500);assert.equal((await(await upload()).json()).error.code,'OPERATION_REVIEW_REQUIRED');assert.equal(calls,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM yta_operations').get().n,1);}finally{globalThis.fetch=old;db.close();}
});
test('reviewed Gemini 404 permits exactly one explicit free Groq retry while retaining five DONE chunks and uncertain history',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);
 const seconds=scanMp3(bytes).durationSeconds,sha='f'.repeat(64);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({text:'재개 전사',segments:[{start:1,end:2,text:'마지막 조각'}]});};
 try{
  const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds*6}),env)).json(),id=created.job.id,path='/api/jobs/'+id;
  assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:sha,chunks:Array.from({length:6},(_,index)=>({index,start:index*seconds,end:(index+1)*seconds}))}),env)).status,200);
  for(let index=0;index<5;index++){db.prepare("UPDATE yta_audio SET state='DONE',result_json=? WHERE job_id=? AND chunk_index=?").run(JSON.stringify({fileSha256:sha,provider:'groq',model:'whisper-large-v3-turbo',segments:[{start:1,end:2,text:'보존 '+index}],operationId:id+':audio:'+index}),id,index);db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run(id+':audio:'+index,id,'groq',10,'DONE',new Date(Date.now()-7200000).toISOString());}
  const groqId=id+':audio:5',geminiId=groqId+':gemini:0';
  db.prepare("UPDATE yta_audio SET state='UNCERTAIN' WHERE job_id=? AND chunk_index=5").run(id);
  db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code) VALUES(?,?,?,?,?,?,?)').run(groqId,id,'groq',10,'FAILED_UNCERTAIN',new Date(Date.now()-7200000).toISOString(),'429');
  db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code) VALUES(?,?,?,?,?,?,?)').run(geminiId,id,'gemini',100,'FAILED_UNCERTAIN',new Date(Date.now()-600000).toISOString(),'404');
  const upload=()=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=5&provider=groq&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),env);
  assert.equal((await(await upload()).json()).error.code,'OPERATION_REVIEW_REQUIRED');assert.equal(calls,0);
  const evidence=await(await routeApi(request(path+'/audio-recovery?index=5'),env)).json();
  const approved={index:5,fileSha256:sha,geminiOperationId:geminiId,groq429OperationId:groqId,acknowledgePossibleGeminiUsage:true,acknowledgeDuplicateTranscriptionRisk:true,chooseGroqFree:true};
  assert.equal((await routeApi(request(path+'/audio-recovery','POST',{...approved,fileSha256:'a'.repeat(64)}),env)).status,409);
  assert.equal((await routeApi(request(path+'/audio-recovery','POST',{...approved,acknowledgePossibleGeminiUsage:false}),env)).status,400);
  assert.equal(evidence.geminiOperationId,geminiId);assert.equal((await routeApi(request(path+'/audio-recovery','POST',approved),env)).status,200);
  assert.equal((await routeApi(request(path+'/audio-recovery','POST',approved),env)).status,409);
  const before=(await(await routeApi(request(path+'/audio-progress'),env)).json()).chunks;assert.equal(before.filter(chunk=>chunk.state==='DONE').length,5);assert.equal(before[5].reviewedFreeRetryApproved,true);
  assert.equal((await(await upload()).json()).error.code,'QUOTA_UNVERIFIED');assert.equal(calls,0); // approval alone never bypasses free grant
  assert.equal(db.prepare("SELECT state FROM yta_free_recovery WHERE job_id=?").get(id).state,'APPROVED');
  assert.equal((await routeApi(request('/api/live/quota','PUT',{provider:'groq',allowance:100,requestLimit:3,billingDisabled:true,freeOnly:true}),env)).status,200);
  env.ALLOW_PAID_API='true';assert.equal((await(await upload()).json()).error.code,'LIVE_DISABLED');assert.equal(calls,0);env.ALLOW_PAID_API='false';
  db.prepare("UPDATE yta_capacity SET valid_until=0 WHERE provider='groq'").run();assert.equal((await(await upload()).json()).error.code,'CAPACITY_WAIT');assert.equal(calls,0);
  assert.equal(db.prepare('SELECT state FROM yta_free_recovery WHERE job_id=?').get(id).state,'APPROVED');
  db.prepare("UPDATE yta_capacity SET valid_until=? WHERE provider='groq'").run(Date.now()+60000);
  const resumed=await Promise.all([upload(),upload()]);assert.ok(resumed.some(response=>response.status===200));assert.equal(calls,1);
  assert.equal((await(await upload()).json()).cached,true);assert.equal(calls,1);
  assert.equal(db.prepare('SELECT state,error_code FROM yta_operations WHERE id=?').get(geminiId).state,'FAILED_UNCERTAIN');
  assert.equal(db.prepare('SELECT state,error_code FROM yta_operations WHERE id=?').get(groqId).error_code,'429');
  assert.equal(db.prepare('SELECT state FROM yta_operations WHERE id=?').get(evidence.retryOperationId).state,'DONE');
  assert.equal(db.prepare('SELECT state FROM yta_free_recovery WHERE job_id=?').get(id).state,'USED');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM yta_audio WHERE job_id=? AND state='DONE'").get(id).n,6);
  assert.equal((await routeApi(request(path+'/audio-finish','POST',{}),env)).status,200);
  assert.equal((await routeApi(request(path+'/audio-cleanup','POST',{confirmTemporaryTranscriptCleanup:true}),env)).status,409);
 }finally{globalThis.fetch=old;db.close();}
});

async function seededUnknownProbe({completed=0}={}){
 const {db,env}=setup(),bytes=new Uint8Array(383*417);for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);
 const seconds=scanMp3(bytes).durationSeconds,sha='c'.repeat(64),created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds*(completed+1)}),env)).json(),id=created.job.id,path='/api/jobs/'+id,index=completed;
 assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:sha,chunks:Array.from({length:completed+1},(_,i)=>({index:i,start:i*seconds,end:(i+1)*seconds}))}),env)).status,200);
 for(let i=0;i<completed;i++){db.prepare("UPDATE yta_audio SET state='DONE',result_json=? WHERE job_id=? AND chunk_index=?").run(JSON.stringify({fileSha256:sha,provider:'groq',segments:[{start:1,end:2,text:'기존 '+i}],operationId:id+':audio:'+i}),id,i);db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run(id+':audio:'+i,id,'groq',10,'DONE',new Date(Date.now()-7200000).toISOString());}
 db.prepare("UPDATE yta_audio SET state='UNCERTAIN' WHERE job_id=? AND chunk_index=?").run(id,index);
 const groq429=id+':audio:'+index,gemini404=groq429+':gemini:0';
 db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code) VALUES(?,?,?,?,?,?,?)').run(groq429,id,'groq',10,'FAILED_UNCERTAIN',new Date(Date.now()-7200000).toISOString(),'429');
 db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code) VALUES(?,?,?,?,?,?,?)').run(gemini404,id,'gemini',100,'FAILED_UNCERTAIN',new Date(Date.now()-600000).toISOString(),'404');
 const approval={index,fileSha256:sha,geminiOperationId:gemini404,groq429OperationId:groq429,acknowledgePossibleGeminiUsage:true,acknowledgeDuplicateTranscriptionRisk:true,chooseGroqFree:true};
 const probe={...approval,provider:'groq',model:'whisper-large-v3-turbo',freeTierConfirmed:true,billingDisabled:true,unknownCapacityAcknowledged:true,oneRequestOnly:true};
 const upload=()=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index='+index+'&provider=groq&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream','x-groq-free-unknown-probe':'true'},body:bytes}),env);
 return {db,env,id,path,index,sha,bytes,groq429,gemini404,approval,probe,upload};
}

test('UNKNOWN-capacity probe needs exact recovery and separate Free approval; paid gate stays closed',async()=>{
 const f=await seededUnknownProbe(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not call');};
 try{
  assert.equal((await f.upload()).status,409);assert.equal(calls,0);
  assert.equal((await routeApi(request(f.path+'/audio-recovery','POST',f.approval),f.env)).status,200);
  const other=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:10}),f.env)).json();
  assert.equal((await routeApi(request('/api/jobs/'+other.job.id+'/audio-free-probe','POST',f.probe),f.env)).status,409);
  assert.equal((await routeApi(request(f.path+'/audio-free-probe','POST',{...f.probe,fileSha256:'a'.repeat(64)}),f.env)).status,409);
  assert.equal((await routeApi(request(f.path+'/audio-free-probe','POST',{...f.probe,provider:'gemini'}),f.env)).status,400);
  assert.equal((await routeApi(request(f.path+'/audio-free-probe','POST',{...f.probe,unknownCapacityAcknowledged:false}),f.env)).status,400);
  f.env.ALLOW_PAID_API='true';assert.equal((await routeApi(request(f.path+'/audio-free-probe','POST',f.probe),f.env)).status,409);f.env.ALLOW_PAID_API='false';
  assert.equal((await routeApi(request(f.path+'/audio-free-probe','POST',f.probe),f.env)).status,200);
  assert.equal((await routeApi(request(f.path+'/audio-free-probe','POST',f.probe),f.env)).status,409);
  f.env.ALLOW_PAID_API='true';assert.equal((await f.upload()).status,409);f.env.ALLOW_PAID_API='false';assert.equal(calls,0);
  f.env.GROQ_API_KEY='DIFFERENT_TEST_KEY';assert.equal((await f.upload()).status,409);f.env.GROQ_API_KEY='NOT_REAL_TEST_KEY';assert.equal(calls,0);
  f.db.prepare('UPDATE yta_free_probe SET expires_at=0 WHERE job_id=?').run(f.id);assert.equal((await f.upload()).status,409);assert.equal(calls,0);
 }finally{globalThis.fetch=old;f.db.close();}
});

test('UNKNOWN probe respects local rolling usage and never invents provider account balance',async()=>{
 const f=await seededUnknownProbe(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not call');};
 try{await routeApi(request(f.path+'/audio-recovery','POST',f.approval),f.env);await routeApi(request(f.path+'/audio-free-probe','POST',f.probe),f.env);
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run('other-recent',f.id,'groq',6500,'DONE',new Date().toISOString());
  const response=await f.upload();assert.equal((await response.json()).error.code,'PROBE_LOCAL_LIMIT');assert.equal(calls,0);
  assert.equal(f.db.prepare('SELECT state FROM yta_free_probe WHERE job_id=?').get(f.id).state,'APPROVED');
  assert.equal((await(await routeApi(request(f.path+'/audio-free-probe?index=0'),f.env)).json()).accountCapacity,'UNKNOWN');
 }finally{globalThis.fetch=old;f.db.close();}
});

test('UNKNOWN probe cancels before network when Free gate changes during key lookup, then permits the same unsent operation',async()=>{
 const f=await seededUnknownProbe(),old=fetch;let calls=0,changed=false;globalThis.fetch=async()=>{calls++;return Response.json({text:'성공',segments:[{start:1,end:2,text:'성공'}]});};
 try{await routeApi(request(f.path+'/audio-recovery','POST',f.approval),f.env);await routeApi(request(f.path+'/audio-free-probe','POST',f.probe),f.env);
  const originalDB=f.env.DB;f.env.DB={prepare(sql){const stmt=originalDB.prepare(sql);if(!sql.startsWith('SELECT cipher_version,iv_b64,ciphertext_b64'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {...bound,async first(){if(!changed){changed=true;f.env.ENABLE_LIVE_FREE='false';}return bound.first();}};}};}};
  assert.equal((await f.upload()).status,409);assert.equal(calls,0);
  assert.equal(f.db.prepare('SELECT state FROM yta_free_probe WHERE job_id=?').get(f.id).state,'APPROVED');
  assert.equal(f.db.prepare('SELECT state,error_code FROM yta_operations WHERE id=?').get(f.id+':audio:0:reviewed404:1').error_code,'PROBE_PRE_DISPATCH_BLOCKED');
  f.env.DB=originalDB;f.env.ENABLE_LIVE_FREE='true';assert.equal((await f.upload()).status,200);assert.equal(calls,1);
 }finally{globalThis.fetch=old;f.db.close();}
});

test('one UNKNOWN probe success keeps earlier DONE and uncertain history; concurrency sends once',async()=>{
 const f=await seededUnknownProbe({completed:5}),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({text:'마지막',segments:[{start:1,end:2,text:'마지막'}]},{headers:{'retry-after':'42','x-ratelimit-remaining-requests':'2'}});};
 try{await routeApi(request(f.path+'/audio-recovery','POST',f.approval),f.env);await routeApi(request(f.path+'/audio-free-probe','POST',f.probe),f.env);
  f.db.prepare("UPDATE yta_capacity SET valid_until=0 WHERE provider='groq'").run();
  const progress=await(await routeApi(request(f.path+'/audio-progress'),f.env)).json();assert.equal(progress.chunks[f.index].unknownCapacityProbeApproved,true);
  const results=await Promise.all([f.upload(),f.upload()]);assert.ok(results.some(response=>response.status===200));assert.equal(calls,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_audio WHERE job_id=? AND state='DONE'").get(f.id).n,6);
  assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(f.gemini404).state,'FAILED_UNCERTAIN');
  assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(f.groq429).state,'FAILED_UNCERTAIN');
  const status=await(await routeApi(request(f.path+'/audio-free-probe?index='+f.index),f.env)).json();assert.equal(status.state,'USED');assert.equal(status.fullQuotaRestored,false);assert.equal(status.accountCapacity,'UNKNOWN');assert.deepEqual(status.safeRateLimit,{retryAfterSeconds:42,remainingRequests:2,remainingAudioSeconds:null});
  assert.equal((await routeApi(request(f.path+'/audio-finish','POST',{}),f.env)).status,200);
  assert.equal((await routeApi(request(f.path+'/audio-cleanup','POST',{confirmTemporaryTranscriptCleanup:true}),f.env)).status,409);
 }finally{globalThis.fetch=old;f.db.close();}
});

test('provider 429 and timeout consume one UNKNOWN probe without automatic retry or secret metadata',async()=>{
 for(const mode of ['429','timeout']){const f=await seededUnknownProbe(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;if(mode==='timeout')throw Error('timeout with secret');return Response.json({private:'do not expose'},{status:429,headers:{'retry-after':'120','x-ratelimit-remaining-requests':'0','authorization':'secret'}});};
  try{await routeApi(request(f.path+'/audio-recovery','POST',f.approval),f.env);await routeApi(request(f.path+'/audio-free-probe','POST',f.probe),f.env);
   const response=await f.upload();assert.equal(response.status,mode==='429'?409:500);assert.equal(calls,1);
   const status=await(await routeApi(request(f.path+'/audio-free-probe?index=0'),f.env)).json();assert.equal(status.state,'USED');assert.doesNotMatch(JSON.stringify(status),/secret|private/);
   if(mode==='429')assert.equal(status.safeRateLimit.retryAfterSeconds,120);else assert.equal(status.safeRateLimit,null);
   assert.equal((await f.upload()).status,409);assert.equal(calls,1);
   assert.equal(f.db.prepare('SELECT state FROM yta_operations WHERE id=?').get(f.gemini404).state,'FAILED_UNCERTAIN');
  }finally{globalThis.fetch=old;f.db.close();}}
});
test('old in-flight Groq claim blocks new work regardless of rolling-window age',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);const seconds=scanMp3(bytes).durationSeconds;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not dispatch');};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),id=created.job.id,path='/api/jobs/'+id;await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'f'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);await routeApi(request('/api/live/quota','PUT',{provider:'groq',allowance:100,requestLimit:5,billingDisabled:true,freeOnly:true}),env);db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run('old-claimed',id,'groq',6490,'CLAIMED',new Date(Date.now()-7200000).toISOString());const r=await routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),env);assert.equal((await r.json()).error.code,'OPERATION_REVIEW_REQUIRED');assert.equal(calls,0);}finally{globalThis.fetch=old;db.close();}
});
test('Groq delayed key lookup cannot dispatch after quota expiry or a concurrent 429',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);const seconds=scanMp3(bytes).durationSeconds;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not dispatch');};
 let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);let slow=true;
 const delayedDB={prepare(sql){const stmt=env.DB.prepare(sql);if(!sql.startsWith('SELECT cipher_version,iv_b64,ciphertext_b64'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {...bound,async first(){if(slow){slow=false;enter();await gate;}return bound.first();}};}};}};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),id=created.job.id,path='/api/jobs/'+id,secondJob=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),otherPath='/api/jobs/'+secondJob.job.id;for(const target of [path,otherPath])await routeApi(request(target+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'1'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);await routeApi(request('/api/live/quota','PUT',{provider:'groq',allowance:100,requestLimit:5,billingDisabled:true,freeOnly:true}),env);const upload=(target,activeEnv)=>routeApi(new Request('https://test.invalid'+target+'/audio-chunk?index=0&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),activeEnv);const first=upload(path,{...env,DB:delayedDB});await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(Error('key lookup did not start')),1000))]);const concurrent=await upload(otherPath,env);assert.equal((await concurrent.json()).error.code,'OPERATION_IN_FLIGHT');assert.equal(calls,0);db.prepare('UPDATE yta_quota SET expires_at=0 WHERE provider=?').run('groq');release();const blocked=await first;assert.equal((await blocked.json()).error.code,'QUOTA_UNVERIFIED');assert.equal(calls,0);assert.equal(db.prepare('SELECT state FROM yta_operations WHERE job_id=?').get(id).state,'BLOCKED');assert.equal(db.prepare('SELECT error_code FROM yta_operations WHERE job_id=?').get(id).error_code,'PRE_DISPATCH_BLOCKED');await routeApi(request('/api/live/quota','PUT',{provider:'groq',allowance:100,requestLimit:5,billingDisabled:true,freeOnly:true}),env);globalThis.fetch=async()=>{calls++;return Response.json({text:'전사',segments:[{start:1,end:2,text:'재개'}]});};assert.equal((await upload(path,env)).status,200);assert.equal(calls,1);}finally{release();globalThis.fetch=old;db.close();}
});
test('Groq grant expiry during the last D1 read blocks the provider fetch',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);
 const seconds=scanMp3(bytes).durationSeconds;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('provider must not run');};
 const delayedDB={prepare(sql){const stmt=env.DB.prepare(sql);if(!sql.includes("state='CLAIMED' AND id<>?"))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {...bound,async first(){const result=await bound.first();await new Promise(resolve=>setTimeout(resolve,350));return result;}};}};}};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),id=created.job.id,path='/api/jobs/'+id;await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'e'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);await routeApi(request('/api/live/quota','PUT',{provider:'groq',allowance:100,requestLimit:5,billingDisabled:true,freeOnly:true}),env);db.prepare('UPDATE yta_quota SET expires_at=? WHERE provider=?').run(Date.now()+300,'groq');const response=await routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),{...env,DB:delayedDB});assert.equal((await response.json()).error.code,'QUOTA_UNVERIFIED');assert.equal(calls,0);assert.equal(db.prepare('SELECT error_code FROM yta_operations WHERE job_id=?').get(id).error_code,'PRE_DISPATCH_BLOCKED');}finally{globalThis.fetch=old;db.close();}
});
test('Groq app-only rolling hourly reservations stop before a provider request',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);const seconds=scanMp3(bytes).durationSeconds;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({text:'전사',segments:[{start:1,end:2,text:'재개'}]});};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),id=created.job.id,path='/api/jobs/'+id;await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'c'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);await routeApi(request('/api/live/quota','PUT',{provider:'groq',allowance:100,requestLimit:5,billingDisabled:true,freeOnly:true}),env);db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run('other-job-reservation',id,'groq',6495,'DONE',new Date().toISOString());const upload=()=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),env);const blocked=await upload();assert.equal((await blocked.json()).error.code,'GROQ_HOURLY_APP_LIMIT');assert.equal(calls,0);db.prepare('UPDATE yta_operations SET created_at=? WHERE id=?').run(new Date(Date.now()-3601000).toISOString(),'other-job-reservation');assert.equal((await upload()).status,200);assert.equal(calls,1);}finally{globalThis.fetch=old;db.close();}
});
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
  const finished=await routeApi(request(path+'/audio-finish','POST',{}),env);assert.equal(finished.status,200,await finished.clone().text());
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
test('two stale audio finishes cannot overwrite a summary saved between them',async()=>{
 const {db,env}=setup(),oldFetch=globalThis.fetch;
 try{
  const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:120}),env)).json();
  const id=created.job.id,path='/api/jobs/'+id,sha='c'.repeat(64),chunks=[{index:0,start:0,end:60},{index:1,start:60,end:120}];
  assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:sha,chunks}),env)).status,200);
  for(let i=0;i<2;i++)db.prepare("UPDATE yta_audio SET state='DONE',result_json=? WHERE job_id=? AND chunk_index=?").run(JSON.stringify({fileSha256:sha,segments:[{start:1,end:2,text:'말 '+i}]}),id,i);
  let reads=0,seenBoth,releaseSecond;const bothSeen=new Promise(resolve=>seenBoth=resolve),secondHeld=new Promise(resolve=>releaseSecond=resolve);
  const racing={...env,DB:{prepare(sql){
   const prepared=env.DB.prepare(sql);
   if(sql!=='SELECT * FROM yta_sources WHERE job_id=?')return prepared;
   return {bind(...args){
    const bound=prepared.bind(...args);
    return {async first(){
     const row=await bound.first();reads++;
     if(reads===1)await bothSeen;
     else if(reads===2){seenBoth();await secondHeld;}
     return row;
    }};
   }};
  }}};
  const first=routeApi(request(path+'/audio-finish','POST',{}),racing),second=routeApi(request(path+'/audio-finish','POST',{}),racing);
  await bothSeen;
  const firstResult=await first;assert.equal(firstResult.status,200,await firstResult.clone().text());
  await grant(env);
  globalThis.fetch=async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(valid())}]}}]});
  assert.equal((await routeApi(request(path+'/summary','POST',{}),env)).status,200);
  const before=db.prepare('SELECT report_json FROM jobs WHERE id=?').get(id).report_json;
  releaseSecond();assert.equal((await second).status,200);
  assert.equal(db.prepare('SELECT report_json FROM jobs WHERE id=?').get(id).report_json,before);
  assert.equal((await(await routeApi(request(path+'/audio-finish','POST',{}),env)).json()).cached,true);
 }finally{globalThis.fetch=oldFetch;db.close();}
});
test('summary partitions full transcript without truncation or over-budget requests',()=>{const segments=Array.from({length:240},(_,i)=>({id:i+1,startMs:i*24000,endMs:(i+1)*24000,text:'발언 내용 '.repeat(65)}));const groups=partitionTranscript(segments,{status:'TRANSCRIPT_UNVERIFIED'});assert.ok(groups.length>2);assert.deepEqual(groups.flat().map(s=>s.id),segments.map(s=>s.id));for(const group of groups){const prompt=reportPrompt(group,{status:'TRANSCRIPT_UNVERIFIED'});assert.ok(prompt.length<=SUMMARY_PROMPT_LIMIT);assert.ok(summaryUnits(prompt)<=250000);}const partial=groups.map(g=>({ids:[g[0].id],report:valid()}));for(const batch of partitionSynthesis(partial,{}))assert.ok(synthesisPrompt(batch,{}).length<=SUMMARY_PROMPT_LIMIT);});
test('MOCK long summary resumes completed stages after renewed grants without duplicate calls',async()=>{
 const {db,env}=setup(),old=fetch;let calls=0;
 const transcript=Array.from({length:900},(_,i)=>{const start=i*6,end=(i+1)*6,stamp=n=>`${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n/60)%60).padStart(2,'0')}:${String(n%60).padStart(2,'0')},000`;return `${i+1}\n${stamp(start)} --> ${stamp(end)}\n${'근거 발언 '.repeat(50)}`;}).join('\n\n');
 globalThis.fetch=async(_url,options)=>{calls++;const prompt=JSON.parse(options.body).contents[0].parts[0].text;let ids;if(prompt.includes('전사 배열 [id,startMs,endMs,text]:')){const rows=JSON.parse(prompt.split('전사 배열 [id,startMs,endMs,text]:\n')[1]);ids=[rows[0][0],rows.at(-1)[0]];}else{const groups=JSON.parse(prompt.split('시간 순서별 부분 보고서:\n')[1]);ids=groups.map(g=>g.ids[0]);}return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({summary:[{text:'전체 근거 요약',evidenceIds:[ids[0]]}],chapters:ids.map(id=>({text:'시간 구간',evidenceIds:[id]})),claims:[],numbers:[],critical:[],conclusion:'전체 전사 기준, 독립 검증 필요'})}]}}]});};
 try{
  const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'text',title:'LONG MOCK',filename:'long.srt',transcript,durationSeconds:5400,persistTranscript:true}),env)).json();assert.ok(created.job,JSON.stringify(created));const id=created.job.id;
  const plan=await(await routeApi(request('/api/jobs/'+id+'/summary-plan'),env)).json();assert.ok(plan.stages>5);assert.ok(plan.firstPassUnits>250000);
  assert.equal((await routeApi(request('/api/jobs/'+id+'/summary','POST',{}),env)).status,400);assert.equal(calls,0);
  await grant(env);
  let completed=false,pending=0,renewals=0;for(let round=0;round<50;round++){
   const response=await routeApi(request('/api/jobs/'+id+'/summary','POST',{allowStaged:true}),env);
   if(response.status===200){completed=true;break;}
   const body=await response.json();
   if(response.status===202){
    pending++;assert.equal(body.pending,true);assert.equal(body.persisted,true);
    const before=calls,tooSoon=await routeApi(request('/api/jobs/'+id+'/summary','POST',{allowStaged:true}),env);
    assert.equal(tooSoon.status,409);assert.equal((await tooSoon.json()).error.code,'RATE_LIMIT_PENDING');assert.equal(calls,before);
    if(pending===1){db.prepare('UPDATE yta_quota SET expires_at=0').run();const expired=await routeApi(request('/api/jobs/'+id+'/summary','POST',{allowStaged:true}),env);assert.equal((await expired.json()).error.code,'QUOTA_UNVERIFIED');assert.equal(calls,before);await grant(env);renewals++;}
    db.prepare("UPDATE yta_operations SET created_at=? WHERE provider='gemini'").run(new Date(Date.now()-14000).toISOString());
   }else{
    assert.equal(body.error.code,'QUOTA_EXHAUSTED');
    db.prepare('UPDATE yta_quota SET expires_at=0').run();await grant(env);renewals++;
   }
  }
  assert.equal(completed,true);assert.ok(pending>5);assert.ok(renewals>1);assert.equal(calls,db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='gemini' AND state='DONE'").get().n);
  const reopened=await(await routeApi(request('/api/jobs/'+id),env)).json();assert.equal(reopened.job.report.kind,'GEMINI_EVIDENCE_LINKED');assert.ok(reopened.job.report.chapters.length>=plan.stages);
  assert.equal((await routeApi(request('/api/jobs/'+id+'/summary','POST',{}),env)).status,200);assert.equal(calls,db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='gemini' AND state='DONE'").get().n);
 }finally{globalThis.fetch=old;db.close();}
});

test('fresh observed Gemini capacity is shared by summary and audio, with durable wait and renewal',async()=>{
 const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(valid())}]}}]});};
 try{const j=await job(env);await grant(env);db.prepare("UPDATE yta_capacity SET valid_until=0 WHERE provider='gemini'").run();const first=await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env);assert.equal((await first.json()).error.code,'CAPACITY_WAIT');assert.equal(calls,0);assert.equal(db.prepare('SELECT reason FROM yta_wait').get().reason,'OBSERVATION_MISSING_OR_STALE');
  const now=Date.now(),remaining={requestsMinute:10,tokensMinute:1000000,requestsDay:10},resetAt=Object.fromEntries(Object.keys(remaining).map(key=>[key,now+3600000]));
  const invalid=await routeApi(request('/api/live/capacity','PUT',{provider:'gemini',model:'gemini-2.5-flash',source:'AI_STUDIO_LIVE',observedAt:now,remaining,resetAt,billingDisabled:true,freeOnly:true,externalActivity:true}),env);assert.equal(invalid.status,409);assert.equal(db.prepare("SELECT valid_until FROM yta_capacity WHERE provider='gemini'").get().valid_until,0);
  assert.equal((await routeApi(request('/api/live/capacity','PUT',{provider:'gemini',model:'gemini-2.5-flash',source:'AI_STUDIO_LIVE',observedAt:now,remaining,resetAt,billingDisabled:true,freeOnly:true,externalActivity:false}),env)).status,200);
  assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,200);assert.equal(calls,1);assert.ok(JSON.parse(db.prepare("SELECT reserved_json FROM yta_capacity WHERE provider='gemini'").get().reserved_json).tokensMinute>0);
 }finally{globalThis.fetch=old;db.close();}
});
test('Gemini accepts fresh sufficient capacity with unknown reset times for one mocked call',async()=>{
 const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(valid())}]}}]});};
 try{const j=await job(env);await grant(env);const response=await routeApi(request('/api/live/capacity','PUT',{provider:'gemini',model:'gemini-2.5-flash',source:'AI_STUDIO_LIVE',observedAt:Date.now(),remaining:{requestsMinute:5,tokensMinute:250000,requestsDay:20},billingDisabled:true,freeOnly:true,externalActivity:false}),env);
  assert.equal(response.status,200);assert.deepEqual(JSON.parse(db.prepare("SELECT reset_json FROM yta_capacity WHERE provider='gemini'").get().reset_json),{requestsMinute:null,tokensMinute:null,requestsDay:null});
  assert.equal((await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env)).status,200);assert.equal(calls,1);
 }finally{globalThis.fetch=old;db.close();}
});
test('unknown Gemini reset never permits insufficient capacity or invents a wait time',async()=>{
 const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('PROVIDER_MUST_NOT_RUN');};
 try{const j=await job(env);await grant(env);const base={provider:'gemini',model:'gemini-2.5-flash',source:'AI_STUDIO_LIVE',observedAt:Date.now(),remaining:{requestsMinute:5,tokensMinute:0,requestsDay:20},billingDisabled:true,freeOnly:true,externalActivity:false};
  assert.equal((await routeApi(request('/api/live/capacity','PUT',base),env)).status,200);
  const blocked=await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env);assert.equal((await blocked.json()).error.code,'CAPACITY_WAIT');assert.equal(calls,0);
  const wait=db.prepare('SELECT reason,reset_at FROM yta_wait').get();assert.equal(wait.reason,'INSUFFICIENT_tokensMinute');assert.equal(wait.reset_at,null);
  assert.equal((await routeApi(request('/api/live/capacity','PUT',{...base,resetAt:{tokensMinute:Date.now()+60000,requestsMinute:'guessed',requestsDay:null}}),env)).status,400);
 }finally{globalThis.fetch=old;db.close();}
});
test('two stale capacity attempts use zero grant slots and zero provider calls',async()=>{
 const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('PROVIDER_MUST_NOT_RUN');};
 try{const j=await job(env);await grant(env,39072);db.prepare("UPDATE yta_capacity SET valid_until=0 WHERE provider='gemini'").run();
  for(let attempt=0;attempt<2;attempt++){const response=await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env);assert.equal((await response.json()).error.code,'CAPACITY_WAIT');}
  assert.equal(calls,0);const quota=db.prepare("SELECT consumed,request_count FROM yta_quota WHERE provider='gemini'").get();assert.equal(quota.consumed,0);assert.equal(quota.request_count,0);
 }finally{globalThis.fetch=old;db.close();}
});
test('Gemini summary and audio do not dispatch after grant revocation during key lookup',async()=>{
 const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('REVOKED_PROVIDER_MUST_NOT_RUN');};
 try{await grant(env,250000);const summaryJob=await job(env),bytes=new Uint8Array(383*417);for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);
  const seconds=scanMp3(bytes).durationSeconds,audioJob=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),path='/api/jobs/'+audioJob.job.id;
  await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'a'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);
  await consent(env,audioJob.job.id,'a'.repeat(64));
  for(const mode of ['summary','audio']){
   let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
   function delayedEnv(){return {...env,DB:{prepare(sql){
    const statement=env.DB.prepare(sql);
    if(!sql.startsWith('SELECT cipher_version,iv_b64,ciphertext_b64 FROM'))return statement;
    return {bind(...args){const bound=statement.bind(...args);return {...bound,async first(){enter();await gate;return bound.first();}};}};
   }}};}
   const pending=mode==='summary'?routeApi(request('/api/jobs/'+summaryJob.id+'/summary','POST',{}),delayedEnv()):routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&provider=gemini&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),delayedEnv());
   await entered;assert.equal((await routeApi(request('/api/live/quota','DELETE',{provider:'gemini'}),env)).status,200);release();
   const response=await pending;assert.equal((await response.json()).error.code,'QUOTA_UNVERIFIED');assert.equal(calls,0);
   const quota=db.prepare("SELECT consumed,request_count FROM yta_quota WHERE provider='gemini'").get();assert.equal(quota.consumed,0);assert.equal(quota.request_count,0);
   if(mode==='summary')await grant(env,250000);
  }
 }finally{globalThis.fetch=old;db.close();}
});
test('MAX_TOKENS and one-second JSON for a five-minute chunk remain reviewable, never DONE',async()=>{
 const {db,env}=setup(),old=fetch,frames=11500,bytes=new Uint8Array(frames*417);for(let i=0;i<frames;i++)bytes.set([255,251,144,0],i*417);
 const seconds=scanMp3(bytes).durationSeconds;let calls=0;
 globalThis.fetch=async()=>Response.json({candidates:[{finishReason:++calls===1?'MAX_TOKENS':'STOP',content:{parts:[{text:JSON.stringify({segments:[{start:0,end:1,text:'첫 문장'}]})}]}}]});
 try{await grant(env,250000);
  for(const expected of ['AUDIO_FINISH_UNVERIFIED','AUDIO_COVERAGE_UNVERIFIED']){
   const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),id=created.job.id,path='/api/jobs/'+id;
   await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'f'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);
   await consent(env,id,'f'.repeat(64));
   const response=await routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&provider=gemini&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),env);
   assert.equal((await response.json()).error.code,expected);
   assert.equal(db.prepare('SELECT state FROM yta_audio WHERE job_id=?').get(id).state,'UNCERTAIN');
   const operation=db.prepare("SELECT result_json FROM yta_operations WHERE job_id=? AND provider='gemini'").get(id);assert.match(JSON.parse(operation.result_json).partialText,/첫 문장/);
   const review=await(await routeApi(request(path+'/audio-review?index=0'),env)).json();assert.equal(review.errorCode,expected);assert.match(review.partialText,/첫 문장/);
   assert.equal((await routeApi(request(path+'/audio-finish','POST',{}),env)).status,409);
   db.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=?").run(new Date(Date.now()-14000).toISOString(),id);
  }
  assert.equal(calls,2);
 }finally{globalThis.fetch=old;db.close();}
});
test('Gemini consent is bound to one job and original file hash',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);let calls=0;globalThis.fetch=async()=>{calls++;throw Error('MUST_NOT_SEND');};
 try{const seconds=scanMp3(bytes).durationSeconds;await grant(env);for(const [index,sha] of ['a','b'].entries()){
  const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),id=created.job.id,path='/api/jobs/'+id;
  await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:sha.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);
  assert.notEqual((await routeApi(request(path+'/audio-consent','POST',{provider:'gemini',fileSha256:'c'.repeat(64),consent:true}),env)).status,200);
  if(index===0)await consent(env,id,sha.repeat(64));
  else{const response=await routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&provider=gemini&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),env);assert.equal((await response.json()).error.code,'AUDIO_GEMINI_CONSENT_REQUIRED');}
 }assert.equal(calls,0);}finally{globalThis.fetch=old;db.close();}
});
test('changing the configured Gemini key invalidates observed capacity without a provider call',async()=>{
 const {db,env}=setup(),old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('MUST_NOT_SEND');};
 try{const j=await job(env);await grant(env);env.GEMINI_API_KEY='ANOTHER_TEST_KEY';const capacity=await(await routeApi(request('/api/live/capacity'),env)).json();assert.equal(capacity.snapshots.find(row=>row.provider==='gemini').valid_until,0);
  const response=await routeApi(request('/api/jobs/'+j.id+'/summary','POST',{}),env);assert.equal((await response.json()).error.code,'CAPACITY_WAIT');assert.equal(calls,0);
  const quota=db.prepare("SELECT consumed,request_count FROM yta_quota WHERE provider='gemini'").get();assert.equal(quota.consumed,0);assert.equal(quota.request_count,0);
 }finally{globalThis.fetch=old;db.close();}
});
test('known-unsent blocked Gemini attempt can switch back to Groq while preserving history',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({text:'Groq 전사',segments:[{start:1,end:2,text:'Groq 전사'}]});};
 try{const seconds=scanMp3(bytes).durationSeconds,created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),id=created.job.id,path='/api/jobs/'+id;
  await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'a'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);await consent(env,id,'a'.repeat(64));await grant(env);await routeApi(request('/api/live/quota','PUT',{provider:'groq',allowance:100,requestLimit:5,billingDisabled:true,freeOnly:true}),env);
  db.prepare("UPDATE yta_capacity SET valid_until=0 WHERE provider='gemini'").run();const upload=provider=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&provider='+provider+'&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),env);
  assert.equal((await(await upload('gemini')).json()).error.code,'CAPACITY_WAIT');assert.equal((await upload('groq')).status,200);assert.equal(calls,1);
  assert.deepEqual(db.prepare('SELECT provider,state FROM yta_operations ORDER BY provider').all().map(row=>[row.provider,row.state]),[['gemini','BLOCKED'],['groq','DONE']]);
 }finally{globalThis.fetch=old;db.close();}
});

test('Gemini audio fallback preserves mixed chunk provenance, TXT and cleanup',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);const seconds=scanMp3(bytes).durationSeconds;let groq=0,gemini=0;
 globalThis.fetch=async(url,options)=>{if(String(url).includes('groq.com')){groq++;return Response.json({text:'첫 조각',segments:[{start:1,end:2,text:'첫 조각'}]});}gemini++;const requestBody=JSON.parse(options.body);assert.equal(requestBody.contents[0].parts[1].inlineData.mimeType,'audio/mp3');return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({segments:[{start:1,end:2,text:'둘째 조각'}]})}]}}],usageMetadata:{promptTokenCount:300}});};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds*2}),env)).json(),id=created.job.id,path='/api/jobs/'+id;
  assert.equal((await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'a'.repeat(64),chunks:[{index:0,start:0,end:seconds},{index:1,start:seconds,end:seconds*2}]}),env)).status,200);
  await consent(env,id,'a'.repeat(64));
  for(const provider of ['groq','gemini'])assert.equal((await routeApi(request('/api/live/quota','PUT',{provider,allowance:provider==='groq'?100:30000,requestLimit:5,billingDisabled:true,freeOnly:true}),env)).status,200);
  const upload=(index,provider)=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index='+index+'&provider='+provider+'&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),env);
  assert.equal((await upload(0,'groq')).status,200);assert.equal((await upload(0,'gemini')).status,200);assert.equal((await upload(1,'gemini')).status,200);assert.equal(groq,1);assert.equal(gemini,1);
  const paced=await(await routeApi(request(path+'/audio-progress'),env)).json();assert.ok(paced.nextEligibleAt.gemini>Date.now());assert.equal(paced.operationInFlight.gemini,false);
  const finished=await(await routeApi(request(path+'/audio-finish','POST',{}),env)).json();assert.equal(finished.source.provenance,'MIXED_OWNED_AUDIO');assert.deepEqual(finished.job.audit.audioProviders,['gemini','groq']);
  assert.deepEqual(finished.job.audit.audioChunks.map(c=>[c.index,c.provider,c.model,Boolean(c.operationId)]),[[0,'groq','whisper-large-v3-turbo',true],[1,'gemini','gemini-2.5-flash',true]]);
  assert.deepEqual(finished.job.audit.audioSegmentOrigins.map(c=>c.chunkIndex),[0,1]);
  const exported=await routeApi(request(path+'/export?format=txt'),env);assert.equal(exported.status,200);const txt=await exported.text();assert.match(txt,/첫 조각/);assert.match(txt,/둘째 조각/);
  assert.equal((await routeApi(request(path+'/audio-cleanup','POST',{confirmTemporaryTranscriptCleanup:true}),env)).status,200);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM yta_audio').get().n,0);assert.equal((await routeApi(request(path+'/audio-finish','POST',{}),env)).status,200);
  assert.equal((await(await routeApi(request('/api/jobs/'+id),env)).json()).job.audit.audioChunks.length,2);
 }finally{globalThis.fetch=old;db.close();}
});

test('Gemini fallback from Groq 429 needs confirmation tied to exact failed operation',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);const seconds=scanMp3(bytes).durationSeconds;let calls=0;
 globalThis.fetch=async(url)=>{calls++;return String(url).includes('groq.com')?Response.json({error:'rate_limit_exceeded'},{status:429}):Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({segments:[{start:1,end:2,text:'대체 전사'}]})}]}}]});};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),id=created.job.id,path='/api/jobs/'+id;await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'b'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);await consent(env,id,'b'.repeat(64));for(const provider of ['groq','gemini'])await routeApi(request('/api/live/quota','PUT',{provider,allowance:provider==='groq'?100:30000,requestLimit:5,billingDisabled:true,freeOnly:true}),env);
  const upload=(provider,operationId)=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&provider='+provider+'&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream',...(operationId?{'x-provider-log-429-no-output-confirmed':'true','x-provider-log-429-operation-id':operationId}:{})},body:bytes}),env);
  assert.equal((await(await upload('groq')).json()).error.code,'429');const progress=await(await routeApi(request(path+'/audio-progress'),env)).json(),failedId=progress.chunks[0].reviewOperationId;assert.equal(progress.chunks[0].reviewProvider,'groq');assert.equal((await(await upload('gemini','wrong')).json()).error.code,'PROVIDER_429_REVIEW_REQUIRED');assert.equal(calls,1);
  assert.equal((await upload('gemini',failedId)).status,200);assert.equal(calls,2);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE provider='gemini' AND id LIKE ?").get(id+':audio:%').n,1);assert.equal((await routeApi(request(path+'/audio-finish','POST',{}),env)).status,200);assert.equal((await routeApi(request(path+'/audio-cleanup','POST',{confirmTemporaryTranscriptCleanup:true}),env)).status,200);
 }finally{globalThis.fetch=old;db.close();}
});

test('each observed provider dimension blocks an audio dispatch before network',async()=>{
 for(const [provider,dimensions] of [['groq',['requestsMinute','audioSecondsHour','audioSecondsDay']],['gemini',['requestsMinute','tokensMinute','requestsDay']]])for(const dimension of dimensions){
  const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not dispatch');};
  try{const row=db.prepare('SELECT remaining_json FROM yta_capacity WHERE provider=?').get(provider),remaining=JSON.parse(row.remaining_json);remaining[dimension]=0;db.prepare('UPDATE yta_capacity SET remaining_json=? WHERE provider=?').run(JSON.stringify(remaining),provider);
   const seconds=scanMp3(bytes).durationSeconds,created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),path='/api/jobs/'+created.job.id;
   await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'c'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);
   if(provider==='gemini')await consent(env,created.job.id,'c'.repeat(64));
   await routeApi(request('/api/live/quota','PUT',{provider,allowance:provider==='groq'?100:30000,requestLimit:5,billingDisabled:true,freeOnly:true}),env);
   const response=await routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&provider='+provider+'&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),env);
   assert.equal((await response.json()).error.code,'CAPACITY_WAIT',provider+':'+dimension);assert.equal(calls,0);assert.equal(db.prepare('SELECT reason FROM yta_wait').get().reason,'INSUFFICIENT_'+dimension);
   assert.equal(db.prepare('SELECT state FROM yta_audio').get().state,'PAUSED');
  }finally{globalThis.fetch=old;db.close();}
 }
});

test('external activity invalidates Gemini capacity while key lookup waits',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);const seconds=scanMp3(bytes).durationSeconds;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not dispatch');};
 let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);let slow=true;
 const delayedDB={prepare(sql){const stmt=env.DB.prepare(sql);if(!sql.startsWith('SELECT cipher_version,iv_b64,ciphertext_b64 FROM'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {...bound,async first(){if(slow){slow=false;enter();await gate;}return bound.first();}};}};}};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),path='/api/jobs/'+created.job.id;await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'d'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);await consent(env,created.job.id,'d'.repeat(64));await grant(env,30000);
  const uploading=routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&provider=gemini&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),{...env,DB:delayedDB});await entered;
  const invalidate=await routeApi(request('/api/live/capacity','PUT',{provider:'gemini',externalActivity:true}),env);assert.equal((await invalidate.json()).error.code,'CAPACITY_WAIT');release();
  const blocked=await uploading;assert.equal((await blocked.json()).error.code,'CAPACITY_WAIT');assert.equal(calls,0);assert.equal(db.prepare('SELECT reason FROM yta_wait').get().reason,'OBSERVATION_EXPIRED_BEFORE_DISPATCH');
 }finally{release();globalThis.fetch=old;db.close();}
});

test('Gemini 429 fallback retry requires the current failed ID and a renewed grant',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);const seconds=scanMp3(bytes).durationSeconds;let calls=0;
 globalThis.fetch=async()=>{calls++;return calls===1?Response.json({error:'rate_limit_exceeded'},{status:429}):Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({segments:[{start:1,end:2,text:'재개'}]})}]}}]});};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),path='/api/jobs/'+created.job.id;await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'f'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);await consent(env,created.job.id,'f'.repeat(64));await grant(env,30000);
  const upload=id=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&provider=gemini&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream',...(id?{'x-provider-log-429-no-output-confirmed':'true','x-provider-log-429-operation-id':id}:{})},body:bytes}),env);
  assert.equal((await(await upload()).json()).error.code,'429');const progress=await(await routeApi(request(path+'/audio-progress'),env)).json(),failedId=progress.chunks[0].reviewOperationId;assert.equal(progress.chunks[0].reviewProvider,'gemini');assert.equal((await(await upload('stale')).json()).error.code,'PROVIDER_429_REVIEW_REQUIRED');assert.equal(calls,1);
  assert.equal((await upload(failedId)).status,409);assert.equal(calls,1);db.prepare("UPDATE yta_operations SET created_at=? WHERE provider='gemini' AND error_code='429'").run(new Date(Date.now()-14000).toISOString());await grant(env,30000);
  assert.equal((await upload(failedId)).status,200);assert.equal(calls,2);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE provider='gemini' AND id LIKE ?").get(created.job.id+':audio:%').n,2);
 }finally{globalThis.fetch=old;db.close();}
});

test('concurrent providers cannot dispatch the same logical audio chunk twice',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);env.GROQ_API_KEY='NOT_REAL_TEST_KEY';for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);const seconds=scanMp3(bytes).durationSeconds;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({text:'한 번',segments:[{start:1,end:2,text:'한 번'}]});};let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);let slow=true;
 const delayedDB={prepare(sql){const stmt=env.DB.prepare(sql);if(!sql.startsWith('SELECT cipher_version,iv_b64,ciphertext_b64'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {...bound,async first(){if(slow){slow=false;enter();await gate;}return bound.first();}};}};}};
 try{const created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),path='/api/jobs/'+created.job.id;await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'1'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);for(const provider of ['groq','gemini'])await routeApi(request('/api/live/quota','PUT',{provider,allowance:provider==='groq'?100:30000,requestLimit:5,billingDisabled:true,freeOnly:true}),env);
  const upload=(provider,activeEnv)=>routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&provider='+provider+'&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),activeEnv);
  const first=upload('groq',{...env,DB:delayedDB});await entered;assert.equal((await upload('gemini',env)).status,409);assert.equal(calls,0);release();assert.equal((await first).status,200);assert.equal((await(await upload('gemini',env)).json()).cached,true);assert.equal(calls,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM yta_operations').get().n,1);
 }finally{release();globalThis.fetch=old;db.close();}
});

test('Gemini summary reservation reduces the same model capacity available to audio',async()=>{
 const {db,env}=setup(),old=fetch,bytes=new Uint8Array(383*417);for(let i=0;i<383;i++)bytes.set([255,251,144,0],i*417);let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(valid())}]}}]});};
 try{const remaining=JSON.parse(db.prepare("SELECT remaining_json FROM yta_capacity WHERE provider='gemini'").get().remaining_json);remaining.tokensMinute=30000;db.prepare("UPDATE yta_capacity SET remaining_json=? WHERE provider='gemini'").run(JSON.stringify(remaining));await grant(env,250000);const textJob=await job(env);assert.equal((await routeApi(request('/api/jobs/'+textJob.id+'/summary','POST',{}),env)).status,200);assert.equal(calls,1);db.prepare("UPDATE yta_operations SET created_at=? WHERE provider='gemini' AND state='DONE'").run(new Date(Date.now()-14000).toISOString());
  const seconds=scanMp3(bytes).durationSeconds,created=await(await routeApi(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:seconds}),env)).json(),path='/api/jobs/'+created.job.id;await routeApi(request(path+'/audio-plan','POST',{rightsConfirmed:true,fileSha256:'2'.repeat(64),chunks:[{index:0,start:0,end:seconds}]}),env);
  await consent(env,created.job.id,'2'.repeat(64));
  const response=await routeApi(new Request('https://test.invalid'+path+'/audio-chunk?index=0&provider=gemini&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes}),env);assert.equal((await response.json()).error.code,'CAPACITY_WAIT');assert.equal(calls,1);assert.equal(db.prepare('SELECT reason FROM yta_wait').get().reason,'INSUFFICIENT_tokensMinute');
 }finally{globalThis.fetch=old;db.close();}
});
