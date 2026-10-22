import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {canonicalYouTubeUrl,checkPublicVideoMetadata,validateAcquisitionManifest,assertBoundedAudioApproval,acquisitionCommands} from '../src/local-runner-contract.mjs';
import {enqueueAcquisition,claimAcquisition,heartbeatAcquisition,sealAcquisition,markExternalDispatchUncertain,completeFromStoredReport} from '../src/local-runner-outbox.mjs';
import {plannedAcquisition,conversionCommand} from '../scripts/local-runner-commands.mjs';
import {buildVerifiedManifest} from '../scripts/local-runner-manifest.mjs';
import {runLocalCommand} from '../scripts/local-runner-process.mjs';

const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);
const jobId='44444444-4444-4444-8444-444444444444',requestId='55555555-5555-4555-8555-555555555555',runnerA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',runnerB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',url='https://youtu.be/2hUkTmwYm3A?si=example';

test('canonical public video and shellless commands reject playlists, live and excess duration',()=>{
 assert.deepEqual(canonicalYouTubeUrl(url),{videoId:'2hUkTmwYm3A',url:'https://www.youtube.com/watch?v=2hUkTmwYm3A'});
 for(const invalid of ['https://youtu.be/2hUkTmwYm3A?list=abc','https://youtu.be/2hUkTmwYm3A#fragment','http://youtu.be/2hUkTmwYm3A','https://youtube.com/playlist?list=abc','https://evil.example/watch?v=2hUkTmwYm3A'])assert.throws(()=>canonicalYouTubeUrl(invalid));
 const metadata={id:'2hUkTmwYm3A',is_live:false,live_status:'not_live',availability:'public',duration:5892.8};
 assert.equal(checkPublicVideoMetadata(metadata,metadata.id).durationSeconds,5892.8);
 assert.throws(()=>checkPublicVideoMetadata({...metadata,is_live:true},metadata.id));assert.throws(()=>checkPublicVideoMetadata({...metadata,duration:7201},metadata.id));assert.throws(()=>checkPublicVideoMetadata({...metadata,availability:undefined},metadata.id));
 const planned=plannedAcquisition({url,workDir:'C:/safe-task',metadata});assert.equal(planned.commands.length,2);
 for(const command of acquisitionCommands({url,workDir:'C:/safe-task',videoId:metadata.id})){assert.equal(typeof command.executable,'string');assert.ok(Array.isArray(command.args));assert.ok(!command.args.some(arg=>/cookies|login|playlist-items/i.test(arg)));}
});

test('conversion argv accepts only an existing task-local media file',async()=>{
 const root=await mkdtemp(join(tmpdir(),'video-runner-test-'));
 try{const source=join(root,'source.webm');await writeFile(source,'mock bytes');const command=await conversionCommand({workDir:root,downloadedPath:source});assert.equal(command.executable,'ffmpeg');assert.ok(command.args.includes('-nostdin'));assert.ok(command.args.includes('-n'));assert.ok(command.args.includes(source));await assert.rejects(conversionCommand({workDir:root,downloadedPath:join(tmpdir(),'outside.webm')}));}
 finally{await rm(root,{recursive:true,force:true});}
});

test('manifest hashes existing local audio and every chunk without a provider',async()=>{
 const root=await mkdtemp(join(tmpdir(),'video-manifest-test-'));
 try{const audioPath=join(root,'audio.mp3'),a=join(root,'chunk0.mp3'),b=join(root,'chunk1.mp3');await Promise.all([writeFile(audioPath,'audio bytes'),writeFile(a,'first chunk'),writeFile(b,'second chunk')]);
  const manifest=await buildVerifiedManifest({workDir:root,jobId,requestId,videoId:'2hUkTmwYm3A',audioPath,durationSeconds:10,ytDlpVersion:'2026.10.01',ffmpegVersion:'9.0.2',chunks:[{path:a,index:0,start:0,end:5},{path:b,index:1,start:5,end:10}]});
  assert.equal(manifest.chunks.length,2);assert.notEqual(manifest.fileSha256,manifest.chunks[0].sha256);assert.equal(manifest.fileBytes,11);
  await assert.rejects(buildVerifiedManifest({workDir:root,jobId,videoId:'2hUkTmwYm3A',audioPath,durationSeconds:10,ytDlpVersion:'2026.10.01',ffmpegVersion:'9.0.2',chunks:[{path:join(tmpdir(),'outside.mp3'),index:0,start:0,end:10}]}));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('local tool adapter passes argv with shell disabled and rejects command injection',async()=>{
 const root=await mkdtemp(join(tmpdir(),'video-tools-test-'));
 try{const tool=join(root,'ffprobe.exe'),media=join(root,'local.mp3'),bytes='fixture executable';await writeFile(tool,bytes);await writeFile(media,'fixture media');const toolPaths={'ffprobe':tool},toolHashes={'ffprobe':createHash('sha256').update(bytes).digest('hex')};
  let launched=0,options;const spawnImpl=(executable,args,opts)=>{launched++;options=opts;assert.equal(executable,tool);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};queueMicrotask(()=>{child.stdout.write('fixture');child.emit('close',0);});return child;};
  const opts={cwd:root,toolPaths,toolHashes,spawnImpl},command={executable:'ffprobe',args:['-v','error','-show_entries','format=duration,size,format_name','-of','json',media]};const result=await runLocalCommand(command,opts);assert.equal(result.stdout,'fixture');assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.env.PATH,root);assert.equal(options.env.GROQ_API_KEY,undefined);
  await assert.rejects(runLocalCommand({executable:'powershell',args:['-Command','bad']},opts));await assert.rejects(runLocalCommand({executable:'ffprobe',args:['a\nb']},opts));await assert.rejects(runLocalCommand({...command,args:['-i',media]},opts));await assert.rejects(runLocalCommand(command,{...opts,toolHashes:{ffprobe:'0'.repeat(64)}}));assert.equal(launched,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('two runners cannot claim one job; crash recovery preserves manifest and uncertain dispatch blocks retry',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'local-runner-test',modules:true,script:'export default {fetch(){return new Response("mock")}}',d1Databases:{DB:'local-runner-d1'}}]}));
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0018_local_runner_outbox.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  await DB.prepare("INSERT INTO jobs(id,owner_id,source_type,source_url,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','url',?,'NEED_UPLOAD',5892.8,?,?, 'null','{}')").bind(jobId,url,new Date().toISOString(),new Date().toISOString()).run();
  const first=await enqueueAcquisition(DB,{jobId,requestId,url});assert.equal(first.created,true);
  assert.equal((await enqueueAcquisition(DB,{jobId,requestId,url})).created,false);
  await assert.rejects(enqueueAcquisition(DB,{jobId,requestId:'66666666-6666-4666-8666-666666666666',url}));
  const t=Date.now(),claimed=await claimAcquisition(DB,{runnerId:runnerA,now:t});assert.equal(claimed.state,'LEASED');assert.equal(await claimAcquisition(DB,{runnerId:runnerB,now:t}),null);
  await assert.rejects(heartbeatAcquisition(DB,{jobId,runnerId:runnerB,leaseNonce:claimed.leaseNonce,now:t}));
  const manifest={kind:'LOCAL_AUDIO_ACQUISITION_V1',videoId:'2hUkTmwYm3A',canonicalUrl:'https://www.youtube.com/watch?v=2hUkTmwYm3A',jobId,requestId,method:'YT_DLP_BESTAUDIO_FFMPEG',ytDlpVersion:'2026.10.01',ffmpegVersion:'9.0.2',fileSha256:'a'.repeat(64),fileBytes:56076980,durationSeconds:5892.8,conversion:{audioChannels:1,sampleRate:16000,format:'mp3'},chunks:[{index:0,start:0,end:5892.8,sha256:'b'.repeat(64),bytes:100}]};
  assert.throws(()=>validateAcquisitionManifest(manifest,{videoId:manifest.videoId,jobId}));
  manifest.chunks=Array.from({length:10},(_,index)=>({index,start:index*590,end:index===9?5892.8:(index+1)*590,sha256:'b'.repeat(64),bytes:100}));
  const sealed=await sealAcquisition(DB,{jobId,runnerId:runnerA,leaseNonce:claimed.leaseNonce,manifest,now:t});assert.equal(sealed.state,'ACQUIRED');
  const takeover=await claimAcquisition(DB,{runnerId:runnerB,now:t+61000});assert.equal(takeover.manifestSha256,sealed.manifestSha256);
  await assert.rejects(markExternalDispatchUncertain(DB,{jobId,runnerId:runnerA,leaseNonce:claimed.leaseNonce,manifestSha256:sealed.manifestSha256,now:t+61000}));
  const uncertain=await markExternalDispatchUncertain(DB,{jobId,runnerId:runnerB,leaseNonce:takeover.leaseNonce,manifestSha256:sealed.manifestSha256,now:t+61000});assert.equal(uncertain.automaticRetry,false);
  assert.equal(await claimAcquisition(DB,{runnerId:runnerA,now:t+180000}),null);
  await assert.rejects(completeFromStoredReport(DB,{jobId,runnerId:runnerB,leaseNonce:takeover.leaseNonce}));
  await DB.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,'fixture','[]','GROQ_OWNED_AUDIO',?)").bind(jobId,new Date().toISOString()).run();
  await DB.prepare("UPDATE jobs SET status='COMPLETE',report_json='{}',audit_json=? WHERE id=?").bind(JSON.stringify({audioFileSha256:manifest.fileSha256}),jobId).run();
  await assert.rejects(completeFromStoredReport(DB,{jobId,runnerId:runnerB,leaseNonce:takeover.leaseNonce}),{code:'RUNNER_REPORT_VERIFIER_NOT_CONNECTED'});
 }finally{await mf.dispose();}
});

test('bounded batch approval binds provider, model, source, exact chunks, calls and expiry',()=>{
 const now=Date.now(),scope={jobId,requestId,manifestSha256:'a'.repeat(64),sourceSha256:'b'.repeat(64),chunkHashes:['c'.repeat(64),'d'.repeat(64)],provider:'groq',model:'whisper-large-v3',now};
 const {now:ignored,...bound}=scope;const approval={kind:'LOCAL_AUDIO_BATCH_APPROVAL_V1',...bound,maxCalls:2,maxMicroUsd:0,perCallMaxMicroUsd:0,expiresAt:now+600000,maxRetries:0};
 assert.equal(assertBoundedAudioApproval(approval,scope),approval);
 assert.throws(()=>assertBoundedAudioApproval({...approval,maxCalls:3},scope));assert.throws(()=>assertBoundedAudioApproval({...approval,sourceSha256:'e'.repeat(64)},scope));assert.throws(()=>assertBoundedAudioApproval({...approval,expiresAt:now-1},scope));
});
