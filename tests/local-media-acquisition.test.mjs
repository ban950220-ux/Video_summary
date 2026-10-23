import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,stat,readdir,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {prepareLocalMedia} from '../scripts/local-media-acquisition.mjs';
import {boundedAcquisitionCommands,acquisitionLimits,acquisitionVersionCommands,isBoundedAcquisitionCommand} from '../scripts/local-acquisition-contract.mjs';
import {runLocalCommand} from '../scripts/local-runner-process.mjs';
import {planMp3} from '../src/audio.mjs';
import {verifyRunnerFiles} from '../scripts/local-runner-session.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const url='https://www.youtube.com/watch?v=2hUkTmwYm3A',jobId='44444444-4444-4444-8444-444444444444',requestId='55555555-5555-4555-8555-555555555555';
// Syntactically valid frame fixture, NOT encoded speech or a provider result.
function mp3(frames=12500){const bytes=Buffer.alloc(frames*288);for(let i=0;i<frames;i++)bytes.set([255,243,136,192],i*288);return bytes;}
async function cleanup(root){const absolute=resolve(root),base=resolve(tmpdir());assert.ok(absolute.startsWith(base+'\\')||absolute.startsWith(base+'/'));await rm(absolute,{recursive:true,force:true});}
async function fixture(fn,audio=mp3()){
 const root=await mkdtemp(join(tmpdir(),'media-acquire-'));
 try{
  const bytes=audio,duration=planMp3(bytes).durationSeconds;let calls=[],now=Date.now(),active=true;
  const options={workDir:root,url,jobId,requestId,consent:{kind:'LOCAL_MEDIA_ACQUISITION_CONSENT_V1',jobId,requestId,canonicalUrl:url,rightsConfirmed:true,...acquisitionLimits,expiresAt:now+600000},toolPaths:{'yt-dlp':process.execPath,ffmpeg:process.execPath},toolHashes:{'yt-dlp':'a'.repeat(64),ffmpeg:'b'.repeat(64)},foreground:()=>active,clock:()=>now};
  const metadata={id:'2hUkTmwYm3A',duration,is_live:false,live_status:'not_live',availability:'public'};
  const runner=async(command,settings)=>{
   settings.beforeSpawn();calls.push(command);
   if(command.args.includes('--version'))return {code:0,stdout:'2026.10.01\n'};
   if(command.args[0]==='-version')return {code:0,stdout:'ffmpeg version N-126374-g089a48eb36-20261001 fixture\n'};
   if(command.args.includes('--skip-download'))return {code:0,stdout:JSON.stringify(metadata)};
   if(command.executable==='yt-dlp'){await writeFile(join(root,'source.m4a'),'synthetic acquired bytes');return {code:0,stdout:join(root,'source.m4a')+'\n'};}
   await writeFile(join(root,'audio.mp3'),bytes);return {code:0,stdout:''};
  };
  options.commandRunner=runner;await fn({root,options,runner,metadata,bytes,calls,setActive:v=>active=v,setNow:v=>now=v});
 }finally{await cleanup(root);}
}

function encodedHeaders(header,frameBytes,frames=600){const bytes=Buffer.alloc(frames*frameBytes);for(let i=0;i<frames;i++)bytes.set(header,i*frameBytes);return bytes;}
const wrongRateStereo=encodedHeaders([255,251,144,0],417);
const wrongRateMono=encodedHeaders([255,251,144,192],417);
const wrongChannels=encodedHeaders([255,243,136,0],288);
for(const [name,bytes]of [
 ['44.1kHz stereo',wrongRateStereo],['44.1kHz mono',wrongRateMono],['16kHz stereo',wrongChannels],
 ['mixed sample rates',Buffer.concat([mp3(300),wrongRateMono,mp3(300)])],
 ['late channel change',Buffer.concat([mp3(599),wrongChannels.subarray(0,288)])]
])test(`conversion format rejects ${name} before chunks/checkpoint and never repeats automatically`,()=>fixture(async f=>{
 await assert.rejects(prepareLocalMedia(f.options),{code:'RUNNER_CONVERSION_FORMAT_MISMATCH'});
 const names=await readdir(f.root);assert.equal(names.includes('runner-checkpoint.json'),false);assert.equal(names.some(n=>n.startsWith('chunk-')),false);
 assert.deepEqual(await readFile(join(f.root,'audio.mp3')),bytes);assert.equal(await readFile(join(f.root,'source.m4a'),'utf8'),'synthetic acquired bytes');
 const state=JSON.parse(await readFile(join(f.root,'runner-acquisition.json'),'utf8'));assert.equal(state.status,'RECONCILIATION_REQUIRED');assert.equal(state.error,'RUNNER_CONVERSION_FORMAT_MISMATCH');
 assert.equal(f.calls.length,5);await assert.rejects(prepareLocalMedia(f.options),{code:'RUNNER_ACQUISITION_RECONCILIATION_REQUIRED'});assert.equal(f.calls.length,5);
},bytes));
test('conversion format validates real frame offsets after an ID3 tag',()=>fixture(async f=>{
 const result=await prepareLocalMedia(f.options);assert.equal(result.state,'LOCAL_MEDIA_READY');assert.equal(result.providerCalls,0);
 assert.deepEqual(result.manifest.conversion,{audioChannels:1,sampleRate:16000,format:'mp3'});
 const state=JSON.parse(await readFile(join(f.root,'runner-acquisition.json'),'utf8'));assert.equal(state.evidence.outputFormat.frameCount,600);
},Buffer.concat([Buffer.from([73,68,51,4,0,0,0,0,0,4]),Buffer.alloc(4),mp3(600)])));
test('conversion format revalidates a historical READY checkpoint even when every byte hash agrees',()=>fixture(async f=>{
 await prepareLocalMedia(f.options);const checkpoint=JSON.parse(await readFile(join(f.root,'runner-checkpoint.json'),'utf8'));
 assert.equal(checkpoint.chunkFiles.length,1);await writeFile(join(f.root,checkpoint.audioFile),wrongChannels);await writeFile(join(f.root,checkpoint.chunkFiles[0]),wrongChannels);
 checkpoint.manifest.fileSha256=sha(wrongChannels);checkpoint.manifest.chunks[0].sha256=sha(wrongChannels);checkpoint.manifestSha256=sha(JSON.stringify(checkpoint.manifest));
 await writeFile(join(f.root,'runner-checkpoint.json'),JSON.stringify(checkpoint));
 const state=JSON.parse(await readFile(join(f.root,'runner-acquisition.json'),'utf8'));state.evidence.manifestSha256=checkpoint.manifestSha256;const raw=JSON.stringify(state);await writeFile(join(f.root,'runner-acquisition.json'),raw);
 await assert.rejects(prepareLocalMedia(f.options),{code:'RUNNER_CONVERSION_FORMAT_MISMATCH'});assert.equal(f.calls.length,5);assert.equal(await readFile(join(f.root,'runner-acquisition.json'),'utf8'),raw);
},mp3(600)));
test('URL acquisition fixture creates source-bound exact frame chunks and reusable runner checkpoint, no transcription claim',()=>fixture(async f=>{
 f.metadata.authorization='fixture-do-not-store';f.metadata.formats=[{url:'https://invalid.example/fixture-private'}];
 const result=await prepareLocalMedia(f.options);assert.equal(result.state,'LOCAL_MEDIA_READY');assert.equal(result.providerCalls,0);assert.equal(result.transcriptComplete,false);assert.equal(result.summaryComplete,false);assert.equal(f.calls.length,5);
 const c=await verifyRunnerFiles(f.root),expected=planMp3(f.bytes);assert.equal(c.manifest.chunks.length,expected.chunks.length);assert.ok(c.manifest.chunks.length>1);
 for(const [i,chunk]of expected.chunks.entries()){const bytes=await readFile(join(f.root,c.chunkFiles[i]));assert.deepEqual(bytes,f.bytes.subarray(chunk.byteStart,chunk.byteEnd));assert.equal(sha(bytes),c.manifest.chunks[i].sha256);}
 const state=JSON.parse(await readFile(join(f.root,'runner-acquisition.json'),'utf8'));assert.equal(state.evidence.source.measurement.sha256,sha('synthetic acquired bytes'));assert.equal(state.evidence.manifestSha256,c.manifestSha256);
 assert.equal(JSON.stringify(state).includes('fixture-do-not-store'),false);assert.equal(JSON.stringify(state).includes('fixture-private'),false);
 const again=await prepareLocalMedia(f.options);assert.equal(again.reused,true);assert.equal(f.calls.length,5);assert.equal(again.manifestSha256,result.manifestSha256);
 await writeFile(join(f.root,'source.m4a'),'different acquired bytes');await assert.rejects(prepareLocalMedia(f.options),{code:'RUNNER_LOCAL_FILES_CHANGED'});assert.equal(f.calls.length,5);
}));
test('two real Node processes share the acquisition lock and READY restart makes no second download',async()=>{
 const outer=await mkdtemp(join(tmpdir(),'media-acquire-process-')),root=join(outer,'media');await mkdir(root);const children=[];
 const start=mode=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/local-media-acquisition-child.mjs',import.meta.url)),root,mode],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});children.push(child);
  let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);const done=once(child,'close').then(([code])=>({code,stdout,stderr}));return {child,done};
 };
 try{
  const first=start('hold');const [message]=await once(first.child,'message');assert.equal(message,'LOCKED');
  const second=await start('run').done;assert.equal(second.code,2);assert.equal(JSON.parse(second.stdout).error,'RUNNER_PROCESS_LOCKED');
  first.child.send('continue');const completed=await first.done;assert.equal(completed.code,0,completed.stderr);assert.equal(JSON.parse(completed.stdout).state,'LOCAL_MEDIA_READY');
  const again=await start('run').done;assert.equal(again.code,0,again.stderr);assert.equal(JSON.parse(again.stdout).reused,true);
  assert.equal((await readFile(join(outer,'download.log'),'utf8')).trim().split('\n').length,1);
 }finally{for(const child of children)if(child.exitCode===null){child.kill();await once(child,'close');}await cleanup(outer);}
});
test('real local subprocess adapter aborts an active fixture and excludes inherited credentials',()=>fixture(async f=>{
 const controller=new AbortController(),hash=sha(await readFile(process.execPath));let child,closed;
 const running=runLocalCommand(acquisitionVersionCommands[1],{cwd:f.root,toolPaths:{ffmpeg:process.execPath},toolHashes:{ffmpeg:hash},signal:controller.signal,spawnImpl(executable,args,settings){
  assert.equal(executable,process.execPath);assert.deepEqual(args,['-version']);assert.equal(settings.shell,false);assert.equal(settings.windowsHide,true);assert.deepEqual(Object.keys(settings.env).sort(),['PATH','SystemRoot','TEMP','TMP']);
  // Only the test substitutes a Node fixture. Production uses the pinned tool and exact argv.
  child=spawn(process.execPath,['-e','process.stdout.write("started"); setInterval(()=>{},1000)'],settings);closed=once(child,'close');child.stdout.once('data',()=>controller.abort());return child;
 }});
 await assert.rejects(running,{code:'RUNNER_COMMAND_ABORTED'});await closed;assert.ok(child.exitCode!==null||child.signalCode!==null);
}));
test('unknown consent fields, URL playlist and missing foreground block before any command',()=>fixture(async f=>{
 for(const options of [{...f.options,consent:{...f.options.consent,authorization:'fixture-secret'}},{...f.options,url:url+'&list=PL1'},{...f.options,foreground:()=>false}])await assert.rejects(prepareLocalMedia(options));
 assert.equal(f.calls.length,0);assert.deepEqual(await readdir(f.root),[]);
}));
test('restricted, live, mismatched and overlong metadata stop before download',async()=>{
 for(const mutation of [m=>m.availability='private',m=>m.is_live=true,m=>m.id='abcdefghijk',m=>m.duration=7201])await fixture(async f=>{
  mutation(f.metadata);await assert.rejects(prepareLocalMedia(f.options),{code:'RUNNER_VIDEO_NOT_ELIGIBLE'});assert.equal(f.calls.length,3);
  const before=f.calls.length;await assert.rejects(prepareLocalMedia(f.options),{code:'RUNNER_ACQUISITION_RECONCILIATION_REQUIRED'});assert.equal(f.calls.length,before);
 });
});
test('cancellation and expiry during awaited metadata prevent the download',async()=>{
 for(const cancel of [true,false])await fixture(async f=>{
  f.options.commandRunner=async(command,settings)=>{const r=await f.runner(command,settings);if(command.args.includes('--skip-download')){if(cancel)f.setActive(false);else f.setNow(f.options.consent.expiresAt);}return r;};
  await assert.rejects(prepareLocalMedia(f.options),{code:cancel?'RUNNER_ACQUISITION_STOPPED':'RUNNER_ACQUISITION_CONSENT_EXPIRED'});assert.equal(f.calls.length,3);
 });
});
test('lost downloader result persists uncertainty and never automatically reruns',()=>fixture(async f=>{
 f.options.commandRunner=async(command,settings)=>{const r=await f.runner(command,settings);if(command.args.includes('after_move:filepath'))throw Error('fixture lost stdout');return r;};
 await assert.rejects(prepareLocalMedia(f.options));assert.equal(f.calls.length,4);assert.ok((await stat(join(f.root,'source.m4a'))).isFile());
 await assert.rejects(prepareLocalMedia(f.options),{code:'RUNNER_ACQUISITION_RECONCILIATION_REQUIRED'});assert.equal(f.calls.length,4);
 assert.equal(JSON.parse(await readFile(join(f.root,'runner-acquisition.json'),'utf8')).phase,'DOWNLOAD');
}));
test('out-of-workspace downloader path, changed request and wrong duration cannot create a ready checkpoint',async()=>{
 await fixture(async f=>{f.options.commandRunner=async(c,s)=>c.args.includes('after_move:filepath')?{code:0,stdout:process.execPath}:f.runner(c,s);await assert.rejects(prepareLocalMedia(f.options),{code:'RUNNER_SOURCE_PATH_INVALID'});});
 await fixture(async f=>{f.metadata.duration=100;await assert.rejects(prepareLocalMedia(f.options),{code:'RUNNER_DURATION_MISMATCH'});assert.ok(!(await readdir(f.root)).includes('runner-checkpoint.json'));});
 await fixture(async f=>{await prepareLocalMedia(f.options);const next='66666666-6666-4666-8666-666666666666';await assert.rejects(prepareLocalMedia({...f.options,requestId:next,consent:{...f.options.consent,requestId:next}}),{code:'RUNNER_ACQUISITION_SCOPE_CHANGED'});assert.equal(f.calls.length,5);});
});
test('two callers cannot acquire the same work directory concurrently',()=>fixture(async f=>{
 let release,entered;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 f.options.commandRunner=async(c,s)=>{if(!f.calls.length){entered();await held;}return f.runner(c,s);};
 const first=prepareLocalMedia(f.options);await started;await assert.rejects(prepareLocalMedia(f.options),{code:'RUNNER_PROCESS_LOCKED'});release();await first;assert.equal(f.calls.length,5);
}));
test('exact argv uses sparse metadata and no shell/config/cookies; final guard rejects before spawn',()=>fixture(async f=>{
 const commands=boundedAcquisitionCommands({url,workDir:f.root});assert.equal(commands[0].args.includes('--dump-single-json'),false);assert.ok(commands[0].args.includes('%(.{id,duration,is_live,live_status,availability,_type})j'));
 for(const command of commands){assert.equal(isBoundedAcquisitionCommand(command,f.root),true);assert.equal(isBoundedAcquisitionCommand({...command,args:[...command.args,'--cookies','private']},f.root),false);}
 const hash=sha(await readFile(process.execPath));let spawns=0;
 await assert.rejects(runLocalCommand(acquisitionVersionCommands[1],{cwd:f.root,toolPaths:{ffmpeg:process.execPath},toolHashes:{ffmpeg:hash},beforeSpawn(){throw Object.assign(Error('expired'),{code:'RUNNER_ACQUISITION_CONSENT_EXPIRED'});},spawnImpl(){spawns++;}}),{code:'RUNNER_ACQUISITION_CONSENT_EXPIRED'});assert.equal(spawns,0);
}));
