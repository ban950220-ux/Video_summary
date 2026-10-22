import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {scanMp3} from '../src/audio.mjs';
import {buildVerifiedManifest} from '../scripts/local-runner-manifest.mjs';
import {createRunnerCheckpoint} from '../scripts/local-runner-session.mjs';
import {enqueueAcquisition,claimAcquisition,sealAcquisition,approveAcquisitionUpload,cancelAcquisition} from '../src/local-runner-outbox.mjs';
import {createRunnerAudioHandler} from '../src/local-runner-audio-bridge.mjs';
import {createLoopbackAudioClient,advanceRunnerAudioSession,resumeBlockedRunnerAudioSession} from '../scripts/local-runner-audio-client.mjs';

const jobId='44444444-4444-4444-8444-444444444444',requestId='55555555-5555-4555-8555-555555555555',runnerId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const endpoint='/api/jobs/'+jobId,url='https://youtu.be/2hUkTmwYm3A';
const sha=b=>createHash('sha256').update(b).digest('hex');
const request=(path,method='GET',body)=>new Request('https://fixture.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
const sqls=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(l=>!l.trim().startsWith('--')).join('\n').split(';').map(s=>s.trim()).filter(Boolean);
function mp3(){const bytes=new Uint8Array(417*384);for(let i=0;i<384;i++)bytes.set([255,251,144,192],417*i);return bytes;}

async function fixture(fn,{approve=true,dispatch=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'runner-audio-http-'));
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'fixture',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'runner-audio-local'}}]}));
 const originalFetch=globalThis.fetch;let server;
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0003_observed_capacity.sql','../migrations/0007_bounded_free_batch.sql','../migrations/0018_local_runner_outbox.sql','../migrations/0019_local_runner_audio_bridge.sql','../migrations/0020_local_runner_blocked_resume.sql'])for(const sql of sqls(file))await DB.prepare(sql).run();
  const bytes=mp3(),duration=scanMp3(bytes).durationSeconds,total=duration*2,now=Date.now();
  const audioPath=join(dir,'audio.mp3'),chunkPaths=[join(dir,'chunk0.mp3'),join(dir,'chunk1.mp3')];
  const audio=new Uint8Array(bytes.length*2);audio.set(bytes);audio.set(bytes,bytes.length);await writeFile(audioPath,audio);for(const path of chunkPaths)await writeFile(path,bytes);
  await DB.prepare("INSERT INTO jobs(id,owner_id,source_type,source_url,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','url',?,'NEED_UPLOAD',?,'fixture','fixture','null','{}')").bind(jobId,url,total).run();
  const manifest=await buildVerifiedManifest({workDir:dir,jobId,requestId,videoId:'2hUkTmwYm3A',audioPath,durationSeconds:total,ytDlpVersion:'2026.10.01',ffmpegVersion:'9.0.2',chunks:chunkPaths.map((path,index)=>({path,index,start:index*duration,end:(index+1)*duration}))});
  await enqueueAcquisition(DB,{jobId,requestId,url});const claim=await claimAcquisition(DB,{runnerId,leaseMs:120000});
  const sealed=await sealAcquisition(DB,{jobId,runnerId,leaseNonce:claim.leaseNonce,manifest});
  await createRunnerCheckpoint({workDir:dir,manifest,audioPath,chunkPaths});
  if(approve)await approveAcquisitionUpload(DB,{jobId,approval:{kind:'LOCAL_AUDIO_BATCH_APPROVAL_V1',jobId,requestId,manifestSha256:sealed.manifestSha256,sourceSha256:manifest.fileSha256,chunkHashes:manifest.chunks.map(c=>c.sha256),provider:'groq',model:'whisper-large-v3-turbo',maxCalls:2,maxMicroUsd:0,perCallMaxMicroUsd:0,maxRetries:0,expiresAt:now+600000}});
  const env={DB,GROQ_API_KEY:'NOT_REAL_TEST_KEY',ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false'};
  const remaining={requestsMinute:10,audioSecondsHour:10000,audioSecondsDay:20000},reset=Object.fromEntries(Object.keys(remaining).map(k=>[k,now+3600000]));
  await DB.prepare("INSERT INTO yta_capacity(provider,model,source,observed_at,valid_until,reset_json,remaining_json,reserved_json,billing_disabled) VALUES('groq','whisper-large-v3-turbo',?,?,?,?,?,?,1)").bind('GROQ_CONSOLE_LIVE:'+sha('groq:NOT_REAL_TEST_KEY'),now,now+60000,JSON.stringify(reset),JSON.stringify(remaining),JSON.stringify(Object.fromEntries(Object.keys(remaining).map(k=>[k,0])))).run();
  await DB.prepare("INSERT INTO yta_quota(provider,allowance,consumed,request_limit,request_count,expires_at,confirmed_at,billing_disabled) VALUES('groq',100,0,3,0,?,?,1)").bind(now+600000,now).run();
  let authExpires=now+600000,authHook=async()=>{},providerHook=async()=>{},providerCalls=0,expectedUploadHash=manifest.chunks[0].sha256;
  globalThis.fetch=async(input,options)=>{
   const target=String(input?.url||input);
   assert.equal(target,'https://api.groq.com/openai/v1/audio/transcriptions','No external request permitted');providerCalls++;
   assert.equal(options.body.get('model'),'whisper-large-v3-turbo');const file=options.body.get('file');assert.equal(sha(new Uint8Array(await file.arrayBuffer())),expectedUploadHash);
   await providerHook();return Response.json({text:'SYNTHETIC AUDIO FIXTURE '+providerCalls,segments:[{start:0,end:duration,text:'SYNTHETIC AUDIO FIXTURE '+providerCalls}]});
  };
  const handler=createRunnerAudioHandler({env,enableDispatch:dispatch,authenticate:async req=>{await authHook();return req.headers.get('authorization')==='Bearer LOCAL_FIXTURE_ONLY'?{ownerId:'owner',expiresAt:authExpires}:null;}});
  server=createServer(async(req,res)=>{
   try{const full=new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(req.method==='GET'?{}:{body:Readable.toWeb(req),duplex:'half'})});const response=await handler(full);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end('{}');}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl='http://127.0.0.1:'+server.address().port+'/';
  const clientOptions={baseUrl,authenticationHeaders:async()=>({authorization:'Bearer LOCAL_FIXTURE_ONLY'}),binding:{jobId,requestId,runnerId,leaseNonce:claim.leaseNonce,manifestSha256:sealed.manifestSha256},fetchImpl:originalFetch};
  const client=createLoopbackAudioClient(clientOptions),step=other=>advanceRunnerAudioSession({workDir:dir,client,rightsConfirmed:true,linkUrlToAudioConfirmed:true,foreground:()=>true,...other});
  await fn({DB,env,dir,manifest,bytes,client,clientOptions,step,calls:()=>providerCalls,setAuthExpiry:n=>{authExpires=n;},setAuthHook:h=>{authHook=h;},setExpectedUploadHash:h=>{expectedUploadHash=h;},setProviderHook:h=>{providerHook=h;}});
 }finally{globalThis.fetch=originalFetch;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await mf.dispose();await rm(dir,{recursive:true,force:true});}
}

test('loopback HTTP + Workerd D1 reuses real audio plan/chunk/finish and reserved usage, not summary completion',()=>fixture(async f=>{
 assert.equal((await f.step()).state,'PLANNED');assert.equal((await f.client.progress()).audio.complete,false);
 await assert.rejects(f.client.finish(),{code:'RUNNER_TRANSCRIPTION_INCOMPLETE'});
 assert.equal((await f.step()).state,'TRANSCRIBED');assert.equal((await f.step()).state,'TRANSCRIBED');
 const finished=await f.step();assert.equal(finished.state,'TRANSCRIPT_STORED_SOURCE_UNVERIFIED');assert.equal(finished.summaryComplete,false);assert.equal(finished.report,null);assert.equal(f.calls(),2);
 assert.equal((await f.step()).persisted,true);assert.equal(f.calls(),2);
 const {source}=await(await routeApi(request(endpoint+'/source'),f.env)).json();assert.equal(source.segments.length,2);assert.equal(source.provenance,'GROQ_OWNED_AUDIO');
 const exported=await(await routeApi(request(endpoint+'/export?format=txt'),f.env)).text();assert.match(exported,/SYNTHETIC AUDIO FIXTURE 1/);assert.match(exported,/SYNTHETIC AUDIO FIXTURE 2/);
 const usage=await f.DB.prepare("SELECT COUNT(*) n,SUM(used_units) units FROM usage_events WHERE provider='groq'").first();assert.equal(usage.n,2);assert.equal(usage.units,22);
 assert.equal((await f.DB.prepare("SELECT request_count FROM yta_quota WHERE provider='groq'").first()).request_count,2);
 assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='groq' AND state='DONE'").first()).n,2);
 assert.equal((await f.DB.prepare('SELECT report_json FROM jobs WHERE id=?').bind(jobId).first()).report_json,'null');
}));

test('HTTP response loss after real audio commit reconciles without a second provider dispatch',()=>fixture(async f=>{
 await f.step();let lost=false;const client=createLoopbackAudioClient({...f.clientOptions,fetchImpl:async(...args)=>{const response=await f.clientOptions.fetchImpl(...args);if(!lost&&String(args[0]).includes('/chunk?')){lost=true;await response.arrayBuffer();throw Object.assign(new Error('fixture lost ACK'),{code:'FIXTURE_ACK_LOST'});}return response;}});
 await assert.rejects(f.step({client}),{code:'FIXTURE_ACK_LOST'});assert.equal(f.calls(),1);
 assert.equal(JSON.parse(await readFile(join(f.dir,'runner-audio-progress.json'),'utf8')).chunks[0],'UNCERTAIN');
 await f.step();assert.equal(f.calls(),2);await f.step();assert.equal(f.calls(),2);
}));

test('unknown model outcome preserves reservation and stops the local restart without retry',()=>fixture(async f=>{
 await f.step();f.setProviderHook(async()=>{throw new Error('synthetic network uncertainty');});
 await assert.rejects(f.step());assert.equal(f.calls(),1);
 await assert.rejects(f.step(),{code:'RUNNER_DISPATCH_RECONCILIATION_REQUIRED'});assert.equal(f.calls(),1);
 assert.equal((await f.DB.prepare("SELECT state FROM yta_operations WHERE provider='groq'").first()).state,'FAILED_UNCERTAIN');
 assert.equal((await f.DB.prepare("SELECT consumed FROM yta_quota WHERE provider='groq'").first()).consumed,11);
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_sources').first()).n,0);
}));

test('unapproved, disabled and paid-mode requests dispatch zero',async t=>{
 await t.test('missing bounded approval',()=>fixture(async f=>{await f.step();await assert.rejects(f.client.chunk(0,f.bytes),{code:'RUNNER_APPROVAL_REQUIRED'});assert.equal(f.calls(),0);},{approve:false}));
 await t.test('default dispatch disabled',()=>fixture(async f=>{await f.step();await assert.rejects(f.client.chunk(0,f.bytes),{code:'RUNNER_DISPATCH_DISABLED'});assert.equal(f.calls(),0);},{dispatch:false}));
 await t.test('paid mode',()=>fixture(async f=>{await f.step();f.env.ALLOW_PAID_API='true';await assert.rejects(f.client.chunk(0,f.bytes),{code:'RUNNER_DISPATCH_DISABLED'});assert.equal(f.calls(),0);}));
 await t.test('no current free quota',()=>fixture(async f=>{await f.step();await f.DB.prepare('UPDATE yta_quota SET expires_at=0').run();await assert.rejects(f.client.chunk(0,f.bytes),{code:'QUOTA_UNVERIFIED'});assert.equal(f.calls(),0);}));
});

test('chunk bytes and size must match approved manifest before legacy audio reservation',()=>fixture(async f=>{
 await f.step();const changed=Uint8Array.from(f.bytes);changed[50]^=1;
 await assert.rejects(f.client.chunk(0,changed),{code:'RUNNER_CHUNK_CHANGED'});await assert.rejects(f.client.chunk(0,f.bytes.slice(0,-1)),{code:'RUNNER_CHUNK_CHANGED'});
 assert.equal(f.calls(),0);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_audio_dispatches').first()).n,0);
}));

test('cancellation or authentication expiry after legacy claim is checked before provider fetch',async t=>{
 for(const condition of ['cancel','auth'])await t.test(condition,()=>fixture(async f=>{
  await f.step();let fired=false;
  f.setAuthHook(async()=>{if(!fired&&await f.DB.prepare("SELECT 1 AS ok FROM yta_operations WHERE provider='groq' AND state='CLAIMED'").first()){fired=true;if(condition==='cancel')await cancelAcquisition(f.DB,{jobId});else f.setAuthExpiry(Date.now()-1);}});
  await assert.rejects(f.client.chunk(0,f.bytes));assert.equal(f.calls(),0);assert.equal(fired,true);
  assert.equal((await f.DB.prepare("SELECT consumed FROM yta_quota WHERE provider='groq'").first()).consumed,0);
  assert.equal((await f.DB.prepare("SELECT state FROM yta_operations WHERE provider='groq'").first()).state,'BLOCKED');
 }));
});

test('concurrent HTTP requests cannot dispatch one chunk twice',()=>fixture(async f=>{
 await f.step();const results=await Promise.allSettled([f.client.chunk(0,f.bytes),f.client.chunk(0,f.bytes)]);assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(f.calls(),1);
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_audio_dispatches').first()).n,1);
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM usage_events').first()).n,1);
}));

test('transport cannot target production or follow a redirect; missing auth and foreground stop locally',()=>fixture(async f=>{
 assert.throws(()=>createLoopbackAudioClient({...f.clientOptions,baseUrl:'https://example.com/'}),{code:'RUNNER_LOCAL_TRANSPORT_REQUIRED'});
 const unauth=createLoopbackAudioClient({...f.clientOptions,authenticationHeaders:async()=>({})});await assert.rejects(unauth.progress(),{code:'RUNNER_AUTH_REQUIRED'});
 await assert.rejects(f.step({foreground:()=>false}),{code:'RUNNER_FOREGROUND_REQUIRED'});assert.equal(f.calls(),0);
}));

test('explicit URL-to-audio link preserves URL/hash and enables existing free-batch plan without granting dispatch',()=>fixture(async f=>{
 await assert.rejects(f.step({linkUrlToAudioConfirmed:false}),{code:'RUNNER_RIGHTS_CONFIRMATION_REQUIRED'});
 assert.equal((await f.DB.prepare('SELECT source_type FROM jobs WHERE id=?').bind(jobId).first()).source_type,'url');
 await f.step();const job=await f.DB.prepare('SELECT source_type,source_url,audit_json FROM jobs WHERE id=?').bind(jobId).first();
 assert.equal(job.source_type,'audio');assert.equal(job.source_url,url);assert.equal(JSON.parse(job.audit_json).ownedAudioSha256,f.manifest.fileSha256);
 const response=await routeApi(request(endpoint+'/audio-free-batch'),f.env);assert.equal(response.status,200);const plan=await response.json();assert.deepEqual(plan.chunkIds,[0,1]);assert.equal(plan.approved,false);assert.equal(plan.summaryIncluded,false);assert.equal(f.calls(),0);
 const outbox=await f.DB.prepare('SELECT manifest_sha256,audio_link_manifest_sha256 FROM yta_local_runner_outbox').first();assert.equal(outbox.manifest_sha256,outbox.audio_link_manifest_sha256);
}));

test('real DELETE scrubs runner URL, manifest and approval bodies while preserving usage and uncertain metadata',()=>fixture(async f=>{
 await f.step();await f.step();f.setProviderHook(async()=>{throw Error('synthetic uncertain second chunk');});await assert.rejects(f.step());
 const before=await f.DB.prepare('SELECT COUNT(*) n FROM usage_events').first();assert.equal(before.n,1);
 const deleted=await routeApi(request(endpoint,'DELETE'),f.env);assert.equal(deleted.status,200);
 const outbox=await f.DB.prepare('SELECT * FROM yta_local_runner_outbox').first();assert.equal(outbox.canonical_url,'');assert.equal(outbox.source_url_snapshot,'');assert.equal(outbox.video_id,'');assert.equal(outbox.manifest_json,null);
 const approval=await f.DB.prepare('SELECT approval_json,state FROM yta_local_runner_batches').first();assert.equal(approval.approval_json,'{}');assert.equal(approval.state,'CANCELLED');
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM usage_events').first()).n,1);
 assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM yta_operations WHERE state='FAILED_UNCERTAIN'").first()).n,1);
 assert.equal((await f.DB.prepare("SELECT COUNT(*) n FROM yta_local_runner_audio_dispatches WHERE state='DISPATCH_UNCERTAIN'").first()).n,1);
 await assert.rejects(f.client.chunk(1,f.bytes),{code:'RUNNER_SCOPE_CHANGED'});assert.equal(f.calls(),2);
}));

test('actual audio-plan transaction rolls back a failed second INSERT and a lost plan ACK is replayable',()=>fixture(async f=>{
 await f.DB.prepare("CREATE TRIGGER fixture_fail_second BEFORE INSERT ON yta_audio WHEN NEW.chunk_index=1 BEGIN SELECT RAISE(ABORT,'synthetic second INSERT failure'); END").run();
 await assert.rejects(f.step());assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_audio').first()).n,0);assert.equal(f.calls(),0);
 await f.DB.prepare('DROP TRIGGER fixture_fail_second').run();
 let lost=false;const client=createLoopbackAudioClient({...f.clientOptions,fetchImpl:async(...args)=>{const response=await f.clientOptions.fetchImpl(...args);if(!lost&&String(args[0]).endsWith('/plan')){lost=true;await response.arrayBuffer();throw Object.assign(new Error('plan ACK lost'),{code:'FIXTURE_ACK_LOST'});}return response;}});
 await assert.rejects(f.step({client}),{code:'FIXTURE_ACK_LOST'});assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_audio').first()).n,2);
 assert.equal((await f.step()).state,'PLANNED');assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_audio').first()).n,2);assert.equal(f.calls(),0);
}));

test('DELETE immediately before actual audio-finish transaction cannot resurrect a source',()=>fixture(async f=>{
 await f.step();await f.step();await f.step();
 const statements=new WeakMap();let deleted=false;
 const wrap=(statement,sql)=>{const result={bind(...args){return wrap(statement.bind(...args),sql);},run:()=>statement.run(),first:()=>statement.first(),all:()=>statement.all()};statements.set(result,{statement,sql});return result;};
 f.env.DB={prepare:sql=>wrap(f.DB.prepare(sql),sql),async batch(items){
  if(!deleted&&statements.get(items[0])?.sql.startsWith('UPDATE jobs SET status=')){deleted=true;assert.equal((await routeApi(request(endpoint,'DELETE'),{...f.env,DB:f.DB})).status,200);}
  return f.DB.batch(items.map(item=>statements.get(item).statement));
 }};
 await assert.rejects(f.client.finish());assert.equal(deleted,true);assert.equal(f.calls(),2);
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM jobs').first()).n,0);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_sources').first()).n,0);
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM usage_events').first()).n,2);
}));

async function safeBlock(f){
 await f.step();let hit=false;
 f.setAuthHook(async()=>{if(!hit&&await f.DB.prepare("SELECT 1 AS ok FROM yta_operations WHERE provider='groq' AND state='CLAIMED'").first()){hit=true;f.setAuthExpiry(Date.now()-1);}});
 await assert.rejects(f.step());assert.equal(f.calls(),0);assert.equal(hit,true);
 f.setAuthHook(async()=>{});f.setAuthExpiry(Date.now()+600000);
 const attempt=await f.DB.prepare('SELECT * FROM yta_local_runner_audio_attempts').first();assert.equal(attempt.gate,'PROVEN_ZERO');
 assert.equal((await f.DB.prepare("SELECT consumed FROM yta_quota WHERE provider='groq'").first()).consumed,0);
 return attempt;
}
async function resumeApproval(f,index=0){
 const r=(await f.client.progress()).dispatches.find(d=>d.chunk_index===index).resume;
 assert.equal(r.state,'EXPLICIT_NEW_APPROVAL_REQUIRED');
 const a=r.originalApproval;
 return {...a,kind:'LOCAL_AUDIO_BLOCKED_RESUME_V1',approvalId:crypto.randomUUID(),chunkIndex:index,blockedAttemptId:r.blockedAttemptId,evidenceSha256:r.evidenceSha256,previousApprovalSha256:r.previousApprovalSha256,confirmNoProviderCall:true,confirmResumeOnce:true};
}
const resumeStep=(f,approval)=>resumeBlockedRunnerAudioSession({workDir:f.dir,client:f.client,approval,confirmExplicitResume:true,foreground:()=>true});

test('proven pre-fetch BLOCKED requires explicit new approval; original proof survives one resumed call and finish',()=>fixture(async f=>{
 const old=await safeBlock(f),a=await resumeApproval(f);
 await assert.rejects(f.step(),{code:'RUNNER_DISPATCH_RECONCILIATION_REQUIRED'});
 const bypass=await routeApi(new Request('https://fixture.invalid'+endpoint+'/audio-chunk?index=0&provider=groq&name=chunk.mp3',{method:'POST',body:f.bytes}),f.env);assert.equal(bypass.status,409);assert.equal((await bypass.json()).error.code,'RUNNER_RESUME_ROUTE_REQUIRED');
 await assert.rejects(resumeBlockedRunnerAudioSession({workDir:f.dir,client:f.client,approval:a,foreground:()=>true}),{code:'RUNNER_EXPLICIT_RESUME_REQUIRED'});
 assert.equal((await resumeStep(f,a)).state,'TRANSCRIBED');assert.equal(f.calls(),1);
 assert.deepEqual(await f.DB.prepare('SELECT * FROM yta_local_runner_audio_attempts WHERE id=?').bind(old.id).first(),old);
 assert.equal((await f.DB.prepare('SELECT state FROM yta_local_runner_audio_resumes').first()).state,'USED');
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_audio_attempts').first()).n,2);
 assert.equal((await f.DB.prepare("SELECT consumed FROM yta_quota WHERE provider='groq'").first()).consumed,11);
 await f.step();const done=await f.step();assert.equal(done.persisted,true);assert.equal(f.calls(),2);
}));

test('pre-route quota expiry can be proved without an operation; historical BLOCKED without proof cannot',()=>fixture(async f=>{
 await f.step();await f.DB.prepare('UPDATE yta_quota SET expires_at=0').run();await assert.rejects(f.step());
 assert.equal(f.calls(),0);assert.equal((await f.DB.prepare('SELECT gate FROM yta_local_runner_audio_attempts').first()).gate,'PROVEN_ZERO');
 const a=await resumeApproval(f);await f.DB.prepare('UPDATE yta_quota SET expires_at=?').bind(Date.now()+600000).run();
 await f.DB.prepare('UPDATE yta_local_runner_audio_dispatches SET attempt_id=NULL').run();
 await assert.rejects(f.client.approveResume(0,a),{code:'RUNNER_ZERO_DISPATCH_NOT_PROVEN'});assert.equal(f.calls(),0);
}));

test('scope expansion, expiry, changed model/body and arbitrary fields require fresh consent instead of reopening',()=>fixture(async f=>{
 await safeBlock(f);const a=await resumeApproval(f);
 for(const delta of [{maxCalls:3},{maxMicroUsd:1},{perCallMaxMicroUsd:1},{model:'whisper-large-v3'},{sourceSha256:'0'.repeat(64)},{chunkHashes:[...a.chunkHashes].reverse().concat('0'.repeat(64))},{expiresAt:a.expiresAt+1},{expiresAt:Date.now()-1}])await assert.rejects(f.client.approveResume(0,{...a,...delta}),{code:'RUNNER_NEW_CONSENT_REQUIRED'});
 await assert.rejects(f.client.approveResume(0,{...a,cookie:'SYNTHETIC_UNSTORED'}),{code:'RUNNER_RESUME_APPROVAL_INVALID'});
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_audio_resumes').first()).n,0);
 await f.DB.prepare('UPDATE yta_local_runner_batches SET expires_at=0').run();
 await assert.rejects(f.client.approveResume(0,a),{code:'RUNNER_NEW_CONSENT_REQUIRED'});assert.equal(f.calls(),0);
}));

test('uncertain fetch and even a zero-call fenced attempt never acquire a zero-dispatch proof',async t=>{
 await t.test('unknown provider response',()=>fixture(async f=>{
  await f.step();f.setProviderHook(async()=>{throw Error('synthetic unknown');});await assert.rejects(f.step());assert.equal(f.calls(),1);
  assert.equal((await f.DB.prepare('SELECT gate FROM yta_local_runner_audio_attempts').first()).gate,'FENCED');
  // Even a misleading BLOCKED label cannot overwrite the durable send fence.
  await f.DB.prepare("UPDATE yta_local_runner_audio_dispatches SET state='BLOCKED'").run();
  assert.equal((await f.client.progress()).dispatches[0].resume.state,'NOT_PROVEN_OR_NEW_CONSENT_REQUIRED');await assert.rejects(f.step());assert.equal(f.calls(),1);
 }));
 await t.test('auth expired after send fence but before fetch',()=>fixture(async f=>{
  await f.step();f.setAuthHook(async()=>{if(await f.DB.prepare("SELECT 1 AS ok FROM yta_local_runner_audio_attempts WHERE gate='FENCED'").first())f.setAuthExpiry(Date.now()-1);});
  await assert.rejects(f.step());assert.equal(f.calls(),0);f.setAuthHook(async()=>{});f.setAuthExpiry(Date.now()+600000);
  assert.equal((await f.DB.prepare('SELECT gate FROM yta_local_runner_audio_attempts').first()).gate,'FENCED');assert.equal((await f.client.progress()).dispatches[0].resume.state,'NOT_PROVEN_OR_NEW_CONSENT_REQUIRED');
 }));
});

test('refund acknowledgement loss does not certify usage settlement',()=>fixture(async f=>{
 await f.step();let hit=false,lost=false;
 f.setAuthHook(async()=>{if(!hit&&await f.DB.prepare("SELECT 1 AS ok FROM yta_operations WHERE state='CLAIMED'").first()){hit=true;f.setAuthExpiry(Date.now()-1);}});
 const statements=new WeakMap();
 const wrap=(statement,sql)=>{const wrapped={bind(...a){return wrap(statement.bind(...a),sql);},first:()=>statement.first(),all:()=>statement.all(),async run(){const r=await statement.run();if(!lost&&sql.startsWith('UPDATE yta_quota SET consumed=consumed-')){lost=true;throw Error('synthetic refund ACK lost');}return r;}};statements.set(wrapped,statement);return wrapped;};
 f.env.DB={prepare:sql=>wrap(f.DB.prepare(sql),sql),batch:items=>f.DB.batch(items.map(item=>statements.get(item)))};
 await assert.rejects(f.step());f.env.DB=f.DB;f.setAuthHook(async()=>{});f.setAuthExpiry(Date.now()+600000);
 assert.equal(lost,true);assert.equal(f.calls(),0);assert.equal((await f.DB.prepare('SELECT gate FROM yta_local_runner_audio_attempts').first()).gate,'PREPARED');
 assert.equal((await f.client.progress()).dispatches[0].resume.state,'NOT_PROVEN_OR_NEW_CONSENT_REQUIRED');
}));

test('changed accounting evidence, cancellation and deletion cannot resurrect a blocked job',async t=>{
 for(const mode of ['usage','cancel','delete','source'])await t.test(mode,()=>fixture(async f=>{
  await safeBlock(f);const a=await resumeApproval(f);
  if(mode==='usage')await f.DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES('synthetic-extra',?,'owner','groq','LIVE_FREE','audio_seconds',11,0,NULL,'SYNTHETIC','now')").bind(jobId).run();
  if(mode==='cancel')await cancelAcquisition(f.DB,{jobId});
  if(mode==='delete')assert.equal((await routeApi(request(endpoint,'DELETE'),f.env)).status,200);
  if(mode==='source')await f.DB.prepare("UPDATE jobs SET audit_json=json_set(audit_json,'$.ownedAudioSha256',?)").bind('0'.repeat(64)).run();
  await assert.rejects(f.client.approveResume(0,a));assert.equal(f.calls(),0);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_audio_resumes').first()).n,0);
 }));
});

test('competing HTTP reopens consume one new approval; approval and chunk ACK losses remain idempotent',()=>fixture(async f=>{
 await safeBlock(f);const a=await resumeApproval(f);
 const approved=await Promise.all([f.client.approveResume(0,a),f.client.approveResume(0,a)]);assert.equal(approved.filter(x=>!x.cached).length,1);assert.equal(f.calls(),0);
 const results=await Promise.allSettled([f.client.chunk(0,f.bytes,a.approvalId),f.client.chunk(0,f.bytes,a.approvalId)]);assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(f.calls(),1);
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM usage_events').first()).n,1);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_audio_attempts').first()).n,2);
}));

test('two real processes cannot resume one proven BLOCKED checkpoint concurrently',{timeout:30000},()=>fixture(async f=>{
 await safeBlock(f);const approval=await resumeApproval(f),script=join(f.dir,'resume-process.mjs');
 const module=pathToFileURL(join(process.cwd(),'scripts/local-runner-audio-client.mjs')).href;
 await writeFile(script,`import {createLoopbackAudioClient,resumeBlockedRunnerAudioSession} from ${JSON.stringify(module)};const args=JSON.parse(process.argv[2]);const client=createLoopbackAudioClient({...args.options,authenticationHeaders:async()=>({authorization:'Bearer LOCAL_FIXTURE_ONLY'})});if(args.hold){const p=client.progress;client.progress=async()=>{const r=await p();process.stdout.write('READY\\n');await new Promise(resolve=>process.stdin.once('data',resolve));return r;};}try{const r=await resumeBlockedRunnerAudioSession({workDir:args.dir,client,approval:args.approval,confirmExplicitResume:true,foreground:()=>true});process.stdout.write(r.state+'\\n');}catch(e){process.stdout.write(e.code+'\\n');}`);
 const payload=hold=>JSON.stringify({options:{baseUrl:f.clientOptions.baseUrl,binding:f.clientOptions.binding},dir:f.dir,approval,hold});
 const first=spawn(process.execPath,[script,payload(true)],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});let output='';first.stdout.on('data',b=>{output+=b;});
 try{
  await new Promise((resolve,reject)=>{first.stdout.once('data',resolve);first.once('error',reject);});
  const second=spawn(process.execPath,[script,payload(false)],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let other='';second.stdout.on('data',b=>{other+=b;});await new Promise(resolve=>second.once('close',resolve));assert.match(other,/RUNNER_PROCESS_LOCKED/);assert.equal(f.calls(),0);
  const ended=new Promise(resolve=>first.once('close',resolve));first.stdin.end('continue');await ended;assert.match(output,/TRANSCRIBED/);assert.equal(f.calls(),1);
  await assert.rejects(resumeStep(f,approval));assert.equal(f.calls(),1);
 }finally{if(first.exitCode===null)first.kill();}
}));

test('B1: linked legacy route cannot bypass approval; pre-existing unbound different-byte results never become runner receipts',()=>fixture(async f=>{
 await f.step();const other=Uint8Array.from(f.bytes);other[50]^=1;f.setExpectedUploadHash(sha(other));
 const legacy=index=>routeApi(new Request('https://fixture.invalid'+endpoint+'/audio-chunk?index='+index+'&provider=groq&name=chunk.mp3',{method:'POST',body:other}),f.env);
 assert.equal((await legacy(0)).status,409);assert.equal(f.calls(),0);
 // Simulate results created outside the runner contract, before linkage existed.
 await f.DB.prepare('UPDATE yta_local_runner_outbox SET audio_link_manifest_sha256=NULL').run();
 assert.equal((await legacy(0)).status,200);assert.equal((await legacy(1)).status,200);assert.equal(f.calls(),2);
 await f.DB.prepare('UPDATE yta_local_runner_outbox SET audio_link_manifest_sha256=manifest_sha256').run();
 const rows=(await f.DB.prepare('SELECT result_json FROM yta_audio').all()).results;for(const row of rows)assert.equal(JSON.parse(row.result_json).requestAudioSha256,sha(other));
 assert.notEqual(sha(other),f.manifest.chunks[0].sha256);
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_audio_dispatches').first()).n,0);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_batches').first()).n,0);
 assert.deepEqual((await f.client.progress()).receipts,[]);await assert.rejects(f.client.finish(),{code:'RUNNER_TRANSCRIPTION_INCOMPLETE'});
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_sources').first()).n,0);
},{approve:false}));

test('B1: exact dispatch/approval identity and actual adapter byte hash are required on readback',()=>fixture(async f=>{
 await f.step();await f.step();assert.equal((await f.client.progress()).receipts.length,1);
 const audio=await f.DB.prepare('SELECT result_json FROM yta_audio WHERE chunk_index=0').first(),original=JSON.parse(audio.result_json);
 assert.equal(original.requestAudioSha256,f.manifest.chunks[0].sha256);
 await f.DB.prepare('UPDATE yta_audio SET result_json=? WHERE chunk_index=0').bind(JSON.stringify({...original,requestAudioSha256:'0'.repeat(64)})).run();assert.deepEqual((await f.client.progress()).receipts,[]);
 await f.DB.prepare('UPDATE yta_audio SET result_json=? WHERE chunk_index=0').bind(audio.result_json).run();
 await f.DB.prepare("UPDATE yta_local_runner_audio_dispatches SET chunk_sha256=? WHERE chunk_index=0").bind('0'.repeat(64)).run();assert.deepEqual((await f.client.progress()).receipts,[]);
 await f.DB.prepare('UPDATE yta_local_runner_audio_dispatches SET chunk_sha256=? WHERE chunk_index=0').bind(f.manifest.chunks[0].sha256).run();
 await f.DB.prepare('UPDATE yta_local_runner_audio_attempts SET approval_sha256=?').bind('0'.repeat(64)).run();assert.deepEqual((await f.client.progress()).receipts,[]);assert.equal(f.calls(),1);
}));

test('B2: finish final CAS binds validated duration, source URL and source type',async t=>{
 for(const field of ['duration_seconds','source_url','source_type'])await t.test(field,()=>fixture(async f=>{
  await f.step();await f.step();await f.step();let changed=false;const statements=new WeakMap();
  const wrap=(statement,sql)=>{const w={bind(...args){return wrap(statement.bind(...args),sql);},run:()=>statement.run(),first:()=>statement.first(),all:()=>statement.all()};statements.set(w,{statement,sql});return w;};
  f.env.DB={prepare:sql=>wrap(f.DB.prepare(sql),sql),async batch(items){if(!changed&&statements.get(items[0])?.sql.startsWith('UPDATE jobs SET status=')){changed=true;await f.DB.prepare('UPDATE jobs SET '+field+'=? WHERE id=?').bind(field==='duration_seconds'?200:field==='source_type'?'url':'https://youtu.be/abcdefghijk',jobId).run();}return f.DB.batch(items.map(i=>statements.get(i).statement));}};
  await assert.rejects(f.client.finish());assert.equal(changed,true);assert.equal(f.calls(),2);assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_sources').first()).n,0);
  assert.equal(JSON.parse((await f.DB.prepare('SELECT audit_json FROM jobs').first()).audit_json).audioProcessingCoverage,undefined);
 }));
});

test('an approved zero-call resume still rejects changed bytes, expired auth, cancelled approval and delete before claim',async t=>{
 for(const mode of ['bytes','auth','cancel','delete'])await t.test(mode,()=>fixture(async f=>{
  await safeBlock(f);const a=await resumeApproval(f);await f.client.approveResume(0,a);
  let bytes=f.bytes;if(mode==='bytes'){bytes=Uint8Array.from(bytes);bytes[50]^=1;}
  if(mode==='auth')f.setAuthExpiry(Date.now()-1);
  if(mode==='cancel')await cancelAcquisition(f.DB,{jobId});
  if(mode==='delete')assert.equal((await routeApi(request(endpoint,'DELETE'),f.env)).status,200);
  await assert.rejects(f.client.chunk(0,bytes,a.approvalId));assert.equal(f.calls(),0);
  if(mode==='delete'){assert.equal((await f.DB.prepare('SELECT approval_json FROM yta_local_runner_audio_resumes').first()).approval_json,'{}');assert.equal((await f.DB.prepare('SELECT evidence_json FROM yta_local_runner_audio_attempts').first()).evidence_json,null);}
 }));
});

test('resume approval ACK loss can replay its ID; resumed chunk ACK loss reconciles without another call',()=>fixture(async f=>{
 await safeBlock(f);const approval=await resumeApproval(f);let approvalLost=false,chunkLost=false;
 const client=createLoopbackAudioClient({...f.clientOptions,fetchImpl:async(...args)=>{const response=await f.clientOptions.fetchImpl(...args),url=String(args[0]);if((url.includes('/resume-blocked?')&&!approvalLost)||(url.includes('/chunk?')&&!chunkLost)){if(url.includes('/resume-blocked?'))approvalLost=true;else chunkLost=true;await response.arrayBuffer();throw Object.assign(Error('synthetic lost ACK'),{code:'FIXTURE_ACK_LOST'});}return response;}});
 const resume=()=>resumeBlockedRunnerAudioSession({workDir:f.dir,client,approval,confirmExplicitResume:true,foreground:()=>true});
 await assert.rejects(resume(),{code:'FIXTURE_ACK_LOST'});assert.equal(f.calls(),0);
 await assert.rejects(resume(),{code:'FIXTURE_ACK_LOST'});assert.equal(f.calls(),1);
 await assert.rejects(resume(),{code:'RUNNER_ZERO_DISPATCH_NOT_PROVEN'});assert.equal(f.calls(),1);
 await f.step();assert.equal(f.calls(),2);await f.step();assert.equal(f.calls(),2);
}));

test('accounting changes after resume review are rejected by the final atomic claim',()=>fixture(async f=>{
 await safeBlock(f);const approval=await resumeApproval(f);await f.client.approveResume(0,approval);let injected=false;const statements=new WeakMap();
 const wrap=(statement,sql)=>{const w={bind(...args){return wrap(statement.bind(...args),sql);},first:()=>statement.first(),all:()=>statement.all(),run:()=>statement.run()};statements.set(w,{statement,sql});return w;};
 f.env.DB={prepare:sql=>wrap(f.DB.prepare(sql),sql),async batch(items){if(!injected&&statements.get(items[0])?.sql.startsWith('UPDATE yta_local_runner_audio_dispatches')){injected=true;await f.DB.prepare("UPDATE yta_operations SET result_json='{}' WHERE job_id=?").bind(jobId).run();}return f.DB.batch(items.map(x=>statements.get(x).statement));}};
 await assert.rejects(f.client.chunk(0,f.bytes,approval.approvalId),{code:'RUNNER_RESUME_ALREADY_CLAIMED'});assert.equal(injected,true);assert.equal(f.calls(),0);
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_audio_attempts').first()).n,1);
 assert.equal((await f.DB.prepare('SELECT state FROM yta_local_runner_audio_resumes').first()).state,'APPROVED');
}));
