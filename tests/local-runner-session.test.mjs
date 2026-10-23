import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,createReadStream} from 'node:fs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {enqueueAcquisition,claimAcquisition,heartbeatAcquisition,sealAcquisition,cancelAcquisition,approveAcquisitionUpload,createLocalUploadTransport} from '../src/local-runner-outbox.mjs';
import {buildVerifiedManifest} from '../scripts/local-runner-manifest.mjs';
import {createRunnerCheckpoint,loadRunnerCheckpoint,resumeRunnerUploads} from '../scripts/local-runner-session.mjs';
import {runLocalCommand} from '../scripts/local-runner-process.mjs';
import {recoverStoppedRunnerLock} from '../scripts/local-runner-lock.mjs';
import {canonicalYouTubeUrl,checkPublicVideoMetadata,validateAcquisitionManifest} from '../src/local-runner-contract.mjs';

const jobId='44444444-4444-4444-8444-444444444444',requestId='55555555-5555-4555-8555-555555555555';
const runnerId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherRunner='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const url='https://youtu.be/2hUkTmwYm3A?si=fixture';
const sqls=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(l=>!l.trim().startsWith('--')).join('\n').split(';').map(s=>s.trim()).filter(Boolean);
const sha=b=>createHash('sha256').update(b).digest('hex');
const failure=code=>Object.assign(new Error(code),{code});

async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'runner-local-d1-'));
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'fixture',modules:true,script:'export default {fetch(){return new Response("offline fixture")}}',d1Databases:{DB:'runner-session'}}]}));
 try{
  const DB=await mf.getD1Database('DB');
  for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0018_local_runner_outbox.sql'])for(const sql of sqls(file))await DB.prepare(sql).run();
  await DB.prepare("INSERT INTO jobs(id,owner_id,source_type,source_url,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','url',?,'NEED_UPLOAD',10,'fixture','fixture','null','{}')").bind(jobId,url).run();
  const audioPath=join(root,'audio.mp3'),chunkPaths=[join(root,'chunk0.mp3'),join(root,'chunk1.mp3')];
  await Promise.all([writeFile(audioPath,'synthetic audio'),writeFile(chunkPaths[0],'synthetic first'),writeFile(chunkPaths[1],'synthetic second')]);
  const manifest=await buildVerifiedManifest({workDir:root,jobId,requestId,videoId:'2hUkTmwYm3A',audioPath,durationSeconds:10,ytDlpVersion:'2026.10.01',ffmpegVersion:'9.0.2',chunks:chunkPaths.map((path,index)=>({path,index,start:index*5,end:(index+1)*5}))});
  await enqueueAcquisition(DB,{jobId,requestId,url});
  let now=Date.now(),auth={ownerId:'owner',expiresAt:now+600000};
  const claim=await claimAcquisition(DB,{runnerId,now});
  const sealed=await sealAcquisition(DB,{jobId,runnerId,leaseNonce:claim.leaseNonce,manifest,now});
  const checkpoint=await createRunnerCheckpoint({workDir:root,manifest,audioPath,chunkPaths});
  const approval={kind:'LOCAL_AUDIO_BATCH_APPROVAL_V1',jobId,requestId,manifestSha256:sealed.manifestSha256,sourceSha256:manifest.fileSha256,chunkHashes:manifest.chunks.map(c=>c.sha256),provider:'groq',model:'whisper-large-v3',maxCalls:2,maxMicroUsd:20,perCallMaxMicroUsd:10,maxRetries:0,expiresAt:now+600000};
  const transport=(db=DB)=>createLocalUploadTransport(db,{getAuth:()=>auth,clock:()=>now});
  const options={workDir:root,runnerId,leaseNonce:claim.leaseNonce,transport:transport()};
  const uploadArgs=async index=>({jobId,requestId,manifestSha256:sealed.manifestSha256,index,runnerId,leaseNonce:claim.leaseNonce,bytes:await readFile(chunkPaths[index])});
  const approve=patch=>approveAcquisitionUpload(DB,{jobId,approval:{...approval,...patch},now});
  await fn({root,DB,manifest,checkpoint,audioPath,chunkPaths,claim,sealed,approval,transport,options,uploadArgs,approve,now,setNow:n=>{now=n;},setAuth:a=>{auth=a;}});
 }finally{await mf.dispose();assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});}
}
function beforeTransfer(DB,mutation){
 let fired=false;
 return {prepare(sql){const original=DB.prepare(sql);return {bind(...args){const bound=original.bind(...args);return {first:()=>bound.first(),run:async()=>{if(!fired&&sql.startsWith('INSERT OR IGNORE INTO yta_local_runner_transfers')){fired=true;await mutation();}return bound.run();}};}};}};
}
async function processResult(executable,args,options={}){
 return new Promise((resolve,reject)=>{const child=spawn(executable,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],...options});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(new Error(`fixture child ${code}: ${err}`)));});
}

test('real files + local D1: durable receipt ACK loss resumes without another upload; separate process reads checkpoint',()=>fixture(async f=>{
 await f.approve();let sends=0,lost=false;
 const transport={...f.options.transport,async uploadChunk(args){sends++;const receipt=await f.options.transport.uploadChunk(args);if(!lost){lost=true;throw failure('FIXTURE_ACK_LOST');}return receipt;}};
 await assert.rejects(resumeRunnerUploads({...f.options,transport}),{code:'FIXTURE_ACK_LOST'});
 let checkpoint=await loadRunnerCheckpoint(f.root);assert.deepEqual(checkpoint.chunks,['UNCERTAIN','READY']);
 const child=join(f.root,'read-checkpoint.mjs'),module=pathToFileURL(fileURLToPath(new URL('../scripts/local-runner-session.mjs',import.meta.url))).href;
 await writeFile(child,`import {loadRunnerCheckpoint} from ${JSON.stringify(module)};const c=await loadRunnerCheckpoint(process.argv[2]);process.stdout.write(JSON.stringify({hash:c.manifestSha256,chunks:c.chunks}));`);
 assert.deepEqual(JSON.parse(await processResult(process.execPath,[child,f.root])),{hash:f.checkpoint.manifestSha256,chunks:['UNCERTAIN','READY']});
 const result=await resumeRunnerUploads({...f.options,transport});assert.equal(result.providerCalls,0);assert.equal(result.status,'UPLOADS_RECEIVED_PROVIDER_NOT_DISPATCHED');assert.equal(sends,2);
 await resumeRunnerUploads({...f.options,transport});assert.equal(sends,2);
 const rows=await f.DB.prepare('SELECT * FROM yta_local_runner_transfers ORDER BY chunk_index').all();assert.equal(rows.results.length,2);assert.equal(rows.results.reduce((sum,r)=>sum+r.reserved_micro_usd,0),20);
 const job=await f.DB.prepare('SELECT report_json FROM jobs WHERE id=?').bind(jobId).first();assert.equal(job.report_json,'null');
 checkpoint=await loadRunnerCheckpoint(f.root);assert.deepEqual(checkpoint.chunks,['RECEIVED','RECEIVED']);assert.ok(!JSON.stringify(checkpoint).includes('leaseNonce'));assert.throws(()=>transport.dispatchProvider(),{code:'RUNNER_PROVIDER_NOT_CONNECTED'});
}));

test('unknown transfer with no durable receipt stops on restart instead of resending',()=>fixture(async f=>{
 await f.approve();let sends=0;const transport={...f.options.transport,async uploadChunk(){sends++;throw failure('FIXTURE_UNKNOWN');}};
 await assert.rejects(resumeRunnerUploads({...f.options,transport}),{code:'FIXTURE_UNKNOWN'});
 await assert.rejects(resumeRunnerUploads({...f.options,transport}),{code:'RUNNER_RECONCILIATION_REQUIRED'});assert.equal(sends,1);
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_transfers').first()).n,0);
}));

test('expired authentication stops before upload; fresh caller authentication resumes without disk credentials',()=>fixture(async f=>{
 await f.approve();f.setAuth({ownerId:'owner',expiresAt:f.now});
 await assert.rejects(resumeRunnerUploads(f.options),{code:'RUNNER_AUTH_REQUIRED'});
 assert.deepEqual((await loadRunnerCheckpoint(f.root)).chunks,['READY','READY']);
 assert.equal((await loadRunnerCheckpoint(f.root)).status,'AUTH_REQUIRED');
 f.setAuth({ownerId:'owner',expiresAt:f.now+100000});await resumeRunnerUploads(f.options);
 const raw=await readFile(join(f.root,'runner-checkpoint.json'),'utf8');assert.ok(!/expiresAt|authorization|cookie|token|ownerId/i.test(raw));
}));

test('missing approval, expired approval, calls and cost ceilings admit no extra chunks and never dispatch',()=>fixture(async f=>{
 const first=await f.uploadArgs(0),second=await f.uploadArgs(1);
 await assert.rejects(f.options.transport.uploadChunk(first),{code:'RUNNER_APPROVAL_OR_LIMIT_BLOCKED'});
 await f.approve({maxCalls:1,maxMicroUsd:10});
 await f.options.transport.uploadChunk(first);await f.options.transport.uploadChunk(first);
 await assert.rejects(f.options.transport.uploadChunk(second),{code:'RUNNER_APPROVAL_OR_LIMIT_BLOCKED'});
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_transfers').first()).n,1);
 await assert.rejects(f.approve({maxCalls:2,maxMicroUsd:20}),{code:'RUNNER_APPROVAL_CONFLICT'});
 await f.DB.prepare('UPDATE yta_local_runner_batches SET expires_at=?').bind(f.now).run();
 await assert.rejects(f.options.transport.uploadChunk(second),{code:'RUNNER_APPROVAL_OR_LIMIT_BLOCKED'});
 assert.throws(()=>f.options.transport.dispatchProvider(),{code:'RUNNER_PROVIDER_NOT_CONNECTED'});
}));

test('cost ceiling independently blocks a second admitted chunk even with remaining call slots',()=>fixture(async f=>{
 await f.approve({maxCalls:2,maxMicroUsd:10});await f.options.transport.uploadChunk(await f.uploadArgs(0));
 await assert.rejects(f.options.transport.uploadChunk(await f.uploadArgs(1)),{code:'RUNNER_APPROVAL_OR_LIMIT_BLOCKED'});
 assert.equal((await f.DB.prepare('SELECT SUM(reserved_micro_usd) n FROM yta_local_runner_transfers').first()).n,10);
}));

test('auth expires during D1 scope read: no final INSERT and no provider dispatch',()=>fixture(async f=>{
 await f.approve();let fired=false;
 const db={prepare(sql){return {bind(...args){const bound=f.DB.prepare(sql).bind(...args);return {first:async()=>{const row=await bound.first();if(!fired){fired=true;f.setAuth({ownerId:'owner',expiresAt:f.now});}return row;},run:()=>bound.run()};}};}};
 await assert.rejects(f.transport(db).uploadChunk(await f.uploadArgs(0)),{code:'RUNNER_AUTH_REQUIRED'});
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_transfers').first()).n,0);
}));

test('changed local bytes after initial scan are rejected immediately before handoff',()=>fixture(async f=>{
 await f.approve();let changed=false,sends=0;
 const base=f.options.transport,transport={...base,async assertActive(args){const r=await base.assertActive(args);if(!changed){changed=true;await writeFile(f.chunkPaths[0],'changed bytes!!');}return r;},async uploadChunk(args){sends++;return base.uploadChunk(args);}};
 await assert.rejects(resumeRunnerUploads({...f.options,transport}),{code:'RUNNER_LOCAL_FILES_CHANGED'});assert.equal(sends,0);
}));

test('manifest request, unknown fields, gaps and reversed ranges are rejected before sealing',()=>fixture(async f=>{
 const scope={jobId,videoId:f.manifest.videoId};
 for(const mutate of [m=>{m.chunks[1].start=8;},m=>{m.chunks[1].end=4;},m=>{m.chunks[0].bytes=8000001;},m=>{m.authorization='synthetic';}]){
  const m=structuredClone(f.manifest);mutate(m);assert.throws(()=>validateAcquisitionManifest(m,scope),{code:'RUNNER_MANIFEST_INVALID'});
 }
 const m={...f.manifest,requestId:'66666666-6666-4666-8666-666666666666'};
 await assert.rejects(sealAcquisition(f.DB,{jobId,runnerId,leaseNonce:f.claim.leaseNonce,manifest:m,now:f.now}),{code:'RUNNER_MANIFEST_INVALID'});
 await assert.rejects(createRunnerCheckpoint({workDir:f.root,manifest:f.manifest,audioPath:f.audioPath,chunkPaths:f.chunkPaths}),{code:'EEXIST'});
}));

test('upload byte hash and local checkpoint/files are checked before handoff',()=>fixture(async f=>{
 await f.approve();const args=await f.uploadArgs(0);args.bytes[0]^=1;
 await assert.rejects(f.options.transport.uploadChunk(args),{code:'RUNNER_CHUNK_CHANGED'});
 await writeFile(f.chunkPaths[0],'changed first');await assert.rejects(resumeRunnerUploads(f.options),{code:'RUNNER_LOCAL_FILES_CHANGED'});
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_transfers').first()).n,0);
 const c=JSON.parse(await readFile(join(f.root,'runner-checkpoint.json'),'utf8'));c.authorization='must-not-be-accepted';await writeFile(join(f.root,'runner-checkpoint.json'),JSON.stringify(c));
 await assert.rejects(loadRunnerCheckpoint(f.root),{code:'RUNNER_CHECKPOINT_INVALID'});
}));

test('cancel/delete/owner or source change at final INSERT cannot admit bytes; prior receipts remain metadata only',async t=>{
 const mutations={
  cancel:f=>cancelAcquisition(f.DB,{jobId}),
  delete:f=>f.DB.prepare('DELETE FROM jobs WHERE id=?').bind(jobId).run(),
  tombstone:f=>f.DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,'deletion',0,'DELETING','fixture')").bind(jobId+':deleting',jobId).run(),
  owner:f=>f.DB.prepare("UPDATE jobs SET owner_id='other' WHERE id=?").bind(jobId).run(),
  source:f=>f.DB.prepare("UPDATE jobs SET source_url='https://youtu.be/aaaaaaaaaaa' WHERE id=?").bind(jobId).run(),
  report:f=>f.DB.prepare("UPDATE jobs SET report_json='{}' WHERE id=?").bind(jobId).run()
 };
 for(const [name,mutate] of Object.entries(mutations))await t.test(name,()=>fixture(async f=>{
  await f.approve();await f.options.transport.uploadChunk(await f.uploadArgs(0));
  const transport=f.transport(beforeTransfer(f.DB,()=>mutate(f)));
  await assert.rejects(transport.uploadChunk(await f.uploadArgs(1)),{code:'RUNNER_UPLOAD_BLOCKED'});
  const rows=await f.DB.prepare('SELECT * FROM yta_local_runner_transfers').all();assert.equal(rows.results.length,1);assert.ok(!JSON.stringify(rows.results).includes('synthetic first'));
  assert.equal(await claimAcquisition(f.DB,{runnerId:otherRunner,now:f.now+120000}),null);
  await assert.rejects(heartbeatAcquisition(f.DB,{jobId,runnerId,leaseNonce:f.claim.leaseNonce,now:f.now}));
 }));
});

test('expired lease takeover and simultaneous uploads preserve one receipt per chunk',()=>fixture(async f=>{
 await f.approve();f.setNow(f.now+61000);
 const claims=await Promise.all([claimAcquisition(f.DB,{runnerId,now:f.now+61000}),claimAcquisition(f.DB,{runnerId:otherRunner,now:f.now+61000})]);
 assert.equal(claims.filter(Boolean).length,1);const claim=claims.find(Boolean),winner=claims[0]?runnerId:otherRunner;
 await assert.rejects(f.options.transport.uploadChunk(await f.uploadArgs(0)),{code:'RUNNER_UPLOAD_BLOCKED'});
 const args={...await f.uploadArgs(0),runnerId:winner,leaseNonce:claim.leaseNonce};
 const results=await Promise.all([f.options.transport.uploadChunk(args),f.options.transport.uploadChunk(args)]);assert.deepEqual(results[0],results[1]);
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_transfers').first()).n,1);
}));

test('URL/provenance contract rejects ambiguous IDs, access restrictions and malformed ranges',()=>{
 for(const bad of ['https://youtu.be/2hUkTmwYm3A?v=aaaaaaaaaaa','https://youtu.be/2hUkTmwYm3A?si=a&si=b','https://youtube.com/watch?v=2hUkTmwYm3A&v=aaaaaaaaaaa','https://youtube.com@evil.example/watch?v=2hUkTmwYm3A','https://youtu.be/2hUkTmwYm3A/../aaaaaaaaaaa','https://youtube.com/shorts/2hUkTmwYm3A'])assert.throws(()=>canonicalYouTubeUrl(bad));
 for(const field of [{availability:'private'},{is_live:true},{live_status:'was_live'},{duration:7201},{_type:'playlist'}])assert.throws(()=>checkPublicVideoMetadata({id:'2hUkTmwYm3A',availability:'public',is_live:false,live_status:'not_live',duration:10,...field},'2hUkTmwYm3A'));
});

test('real child process shim receives literal argv, minimal environment and bounded output/time',async()=>{
 const root=await mkdtemp(join(tmpdir(),'runner-real-process-'));
 try{
  const shim=join(root,'shim.mjs'),media=join(root,'space & literal; name.mp3');
  await writeFile(media,'synthetic');
  await writeFile(shim,`const last=process.argv.at(-1);if(last.includes('overflow'))process.stdout.write('x'.repeat(4096));else if(last.includes('timeout'))setTimeout(()=>{},10000);else process.stdout.write(JSON.stringify({args:process.argv.slice(2),leak:process.env.RUNNER_FIXTURE_SECRET??null}));`);
  const h=createHash('sha256');for await(const b of createReadStream(process.execPath))h.update(b);const toolHashes={ffprobe:h.digest('hex')};
  let launched=0;const spawnImpl=(exe,args,opts)=>{launched++;assert.equal(exe,process.execPath);assert.equal(opts.shell,false);assert.equal(opts.windowsHide,true);assert.equal(opts.env.RUNNER_FIXTURE_SECRET,undefined);return spawn(exe,[shim,...args],opts);};
  const command=path=>({executable:'ffprobe',args:['-v','error','-show_entries','format=duration,size,format_name','-of','json',path]});
  const opts={cwd:root,toolPaths:{ffprobe:process.execPath},toolHashes,spawnImpl};
  const result=await runLocalCommand(command(media),opts),parsed=JSON.parse(result.stdout);assert.equal(parsed.args.at(-1),media);assert.equal(parsed.leak,null);
  const overflow=join(root,'overflow.mp3'),timeout=join(root,'timeout.mp3');await writeFile(overflow,'x');await writeFile(timeout,'x');
  await assert.rejects(runLocalCommand(command(overflow),{...opts,maxOutputBytes:1024}),{code:'RUNNER_OUTPUT_TOO_LARGE'});
  await assert.rejects(runLocalCommand(command(timeout),{...opts,timeoutMs:1000}),{code:'RUNNER_COMMAND_TIMEOUT'});
  await assert.rejects(runLocalCommand({executable:'ffprobe',args:[...command(media).args,'; exit']},opts),{code:'RUNNER_COMMAND_TEMPLATE_INVALID'});
  await assert.rejects(runLocalCommand(command(media),{...opts,toolHashes:{ffprobe:'0'.repeat(64)}}),{code:'RUNNER_TOOL_CHANGED'});assert.equal(launched,3);
 }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});}
});

test('two OS processes cannot hand off from stale READY; after uncertain exit the second does not resend',{timeout:20000},()=>fixture(async f=>{
 const script=join(f.root,'two-process.mjs'),module=pathToFileURL(fileURLToPath(new URL('../scripts/local-runner-session.mjs',import.meta.url))).href;
 await writeFile(script,`import {resumeRunnerUploads} from ${JSON.stringify(module)};import {appendFile} from 'node:fs/promises';const mode=process.argv[3];try{await resumeRunnerUploads({workDir:process.argv[2],runnerId:'${runnerId}',leaseNonce:'${f.claim.leaseNonce}',transport:{async assertActive(){},async readReceipt(){if(mode==='hold'){process.stdout.write('READY\\n');await new Promise(resolve=>process.stdin.once('data',resolve));}return null;},async uploadChunk(){await appendFile(process.argv[2]+'/handoffs.txt','handoff\\n');throw Object.assign(new Error('lost'),{code:'FIXTURE_ACK_LOST'});}}});}catch(e){process.stdout.write(e.code+'\\n');}`);
 const first=spawn(process.execPath,[script,f.root,'hold'],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{first.stdout.once('data',resolve);first.once('error',reject);});
  const second=await processResult(process.execPath,[script,f.root,'second']);assert.match(second,/RUNNER_PROCESS_LOCKED/);
  const ended=new Promise(resolve=>first.once('close',resolve));first.stdin.end('continue');await ended;
  assert.equal(await readFile(join(f.root,'handoffs.txt'),'utf8'),'handoff\n');
  const later=await processResult(process.execPath,[script,f.root,'after']);assert.match(later,/RUNNER_RECONCILIATION_REQUIRED/);
  assert.equal(await readFile(join(f.root,'handoffs.txt'),'utf8'),'handoff\n');
 }finally{if(first.exitCode===null)first.kill();}
}));

test('abandoned process lock requires exact nonce, confirmed dead PID and explicit recovery',{timeout:20000},()=>fixture(async f=>{
 const script=join(f.root,'crash-lock.mjs'),module=pathToFileURL(fileURLToPath(new URL('../scripts/local-runner-lock.mjs',import.meta.url))).href;
 await writeFile(script,`import {withRunnerLock} from ${JSON.stringify(module)};await withRunnerLock(process.argv[2],async()=>{process.stdout.write('READY');await new Promise(()=>setInterval(()=>{},1000));});`);
 const child=spawn(process.execPath,[script,f.root],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
  const lock=JSON.parse(await readFile(join(f.root,'.runner-session.lock'),'utf8'));
  await assert.rejects(recoverStoppedRunnerLock({workDir:f.root,expectedNonce:lock.nonce,confirmProcessStopped:true}),{code:'RUNNER_PROCESS_STILL_ACTIVE'});
  const ended=new Promise(resolve=>child.once('close',resolve));child.kill();await ended;
  await assert.rejects(recoverStoppedRunnerLock({workDir:f.root,expectedNonce:lock.nonce}),{code:'RUNNER_LOCK_REVIEW_REQUIRED'});
  assert.equal((await recoverStoppedRunnerLock({workDir:f.root,expectedNonce:lock.nonce,confirmProcessStopped:true})).retransmissionApproved,false);
 }finally{if(child.exitCode===null)child.kill();}
}));

test('credential-shaped unknown approval fields are rejected and never persisted',()=>fixture(async f=>{
 for(const field of ['authorization','cookie','apiKey','session'])await assert.rejects(f.approve({[field]:'SYNTHETIC_MUST_NOT_PERSIST'}),{code:'RUNNER_BATCH_APPROVAL_INVALID'});
 assert.equal((await f.DB.prepare('SELECT COUNT(*) n FROM yta_local_runner_batches').first()).n,0);await f.approve();
 const row=await f.DB.prepare('SELECT approval_json FROM yta_local_runner_batches').first();assert.ok(!row.approval_json.includes('SYNTHETIC_MUST_NOT_PERSIST'));
}));
