import {createHash,randomUUID} from 'node:crypto';
import {open,readFile,rename,realpath,stat} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {buildVerifiedManifest} from './local-runner-manifest.mjs';
import {validateAcquisitionManifest} from '../src/local-runner-contract.mjs';
import {withRunnerLock} from './local-runner-lock.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const keys=(object,expected)=>object&&Object.keys(object).sort().join(',')===expected.sort().join(',');
const checkpointName='runner-checkpoint.json';
async function inside(root,path){
 const base=await realpath(root),file=await realpath(path),tail=relative(base,file);
 if(!tail||tail.startsWith('..')||isAbsolute(tail)||!(await stat(file)).isFile())fail('RUNNER_FILE_OUTSIDE_WORKDIR');
 return {file,relative:tail};
}
function validateCheckpoint(c){
 if(!keys(c,['kind','manifest','manifestSha256','audioFile','chunkFiles','chunks','status'])||c.kind!=='LOCAL_RUNNER_CHECKPOINT_V1'||!Array.isArray(c.chunkFiles)||!Array.isArray(c.chunks)||!['READY','AUTH_REQUIRED','RECONCILIATION_REQUIRED','UPLOADS_RECEIVED_PROVIDER_NOT_DISPATCHED'].includes(c.status))fail('RUNNER_CHECKPOINT_INVALID');
 validateAcquisitionManifest(c.manifest,{jobId:c.manifest?.jobId,videoId:c.manifest?.videoId});
 if(c.manifestSha256!==digest(JSON.stringify(c.manifest))||c.chunkFiles.length!==c.manifest.chunks.length||c.chunks.length!==c.chunkFiles.length||[c.audioFile,...c.chunkFiles].some(p=>typeof p!=='string'||isAbsolute(p)||p.split(/[\\/]/).includes('..'))||c.chunks.some(v=>!['READY','UNCERTAIN','RECEIVED'].includes(v)))fail('RUNNER_CHECKPOINT_INVALID');
 return c;
}
async function persist(root,c,{initial=false}={}){
 validateCheckpoint(c);
 // Serialize only the documented checkpoint. No auth/headers/keys/lease object.
 const body=JSON.stringify(c),destination=join(root,checkpointName);
 if(initial){const f=await open(destination,'wx',0o600);try{await f.writeFile(body);await f.sync();}finally{await f.close();}return;}
 const temporary=join(root,`.runner-checkpoint-${randomUUID()}.tmp`),f=await open(temporary,'wx',0o600);
 try{await f.writeFile(body);await f.sync();}finally{await f.close();}
 await rename(temporary,destination);
}
async function verifyFiles(root,c){
 const audio=await inside(root,join(root,c.audioFile)),chunks=[];
 for(const [index,path] of c.chunkFiles.entries())chunks.push({...c.manifest.chunks[index],path:(await inside(root,join(root,path))).file});
 const measured=await buildVerifiedManifest({workDir:root,jobId:c.manifest.jobId,requestId:c.manifest.requestId,videoId:c.manifest.videoId,audioPath:audio.file,durationSeconds:c.manifest.durationSeconds,ytDlpVersion:c.manifest.ytDlpVersion,ffmpegVersion:c.manifest.ffmpegVersion,chunks});
 if(digest(JSON.stringify(measured))!==c.manifestSha256)fail('RUNNER_LOCAL_FILES_CHANGED');
}
export async function createRunnerCheckpoint({workDir,manifest,audioPath,chunkPaths}){
 const root=await realpath(workDir);
 validateAcquisitionManifest(manifest,{jobId:manifest?.jobId,videoId:manifest?.videoId});
 const audioFile=(await inside(root,audioPath)).relative,chunkFiles=[];
 for(const path of chunkPaths)chunkFiles.push((await inside(root,path)).relative);
 const c={kind:'LOCAL_RUNNER_CHECKPOINT_V1',manifest,manifestSha256:digest(JSON.stringify(manifest)),audioFile,chunkFiles,chunks:chunkFiles.map(()=> 'READY'),status:'READY'};
 validateCheckpoint(c);await verifyFiles(root,c);await persist(root,c,{initial:true});return c;
}
export async function loadRunnerCheckpoint(workDir){
 const root=await realpath(workDir),file=await inside(root,join(root,checkpointName));
 if((await stat(file.file)).size>256000)fail('RUNNER_CHECKPOINT_INVALID');
 let c;try{c=JSON.parse(await readFile(file.file,'utf8'));}catch{fail('RUNNER_CHECKPOINT_INVALID');}
 return validateCheckpoint(c);
}
export async function verifyRunnerFiles(workDir){const root=await realpath(workDir),c=await loadRunnerCheckpoint(root);await verifyFiles(root,c);return c;}
export async function readRunnerChunk(workDir,c,index){
 const root=await realpath(workDir),chunk=c.manifest.chunks[index];if(!chunk)fail('RUNNER_CHECKPOINT_INVALID');
 const file=await inside(root,join(root,c.chunkFiles[index]));
 if((await stat(file.file)).size!==chunk.bytes)fail('RUNNER_LOCAL_FILES_CHANGED');
 const bytes=await readFile(file.file);if(bytes.length!==chunk.bytes||digest(bytes)!==chunk.sha256)fail('RUNNER_LOCAL_FILES_CHANGED');return bytes;
}
function validateReceipt(receipt,c,index){
 const expected=c.manifest.chunks[index];
 if(receipt?.kind!=='LOCAL_UPLOAD_RECEIPT_V1'||receipt.jobId!==c.manifest.jobId||receipt.requestId!==c.manifest.requestId||receipt.manifestSha256!==c.manifestSha256||receipt.index!==index||receipt.sha256!==expected.sha256||receipt.bytes!==expected.bytes||receipt.providerCalls!==0||receipt.status!=='UPLOAD_RECEIVED_PROVIDER_NOT_DISPATCHED')fail('RUNNER_RECEIPT_INVALID');
}
// User-driven one pass. transport is injected; this module does not implement
// HTTP, persist authentication or start yt-dlp/FFmpeg/provider processes.
export function resumeRunnerUploads(options){return withRunnerLock(options.workDir,assertHeld=>resumeLocked(options,assertHeld));}
async function resumeLocked({workDir,runnerId,leaseNonce,transport},assertHeld){
 const root=await realpath(workDir),c=await loadRunnerCheckpoint(root);
 await verifyFiles(root,c);
 const scope={jobId:c.manifest.jobId,requestId:c.manifest.requestId,manifestSha256:c.manifestSha256,runnerId,leaseNonce};
 try{
  for(const [index,chunk] of c.manifest.chunks.entries()){
   const args={...scope,index};
   await transport.assertActive(args);
   const receipt=await transport.readReceipt(args);
   if(receipt){validateReceipt(receipt,c,index);c.chunks[index]='RECEIVED';await persist(root,c);continue;}
   if(c.chunks[index]!=='READY')fail('RUNNER_RECONCILIATION_REQUIRED');
   const file=await inside(root,join(root,c.chunkFiles[index]));
   if((await stat(file.file)).size!==chunk.bytes)fail('RUNNER_LOCAL_FILES_CHANGED');
   const bytes=await readFile(file.file);
   if(bytes.byteLength!==chunk.bytes||digest(bytes)!==chunk.sha256)fail('RUNNER_LOCAL_FILES_CHANGED');
   // Persist uncertainty before handing even local bytes to a transport. A lost
   // response only reconciles a stored receipt; missing evidence never resends.
   await assertHeld();if(JSON.stringify(await loadRunnerCheckpoint(root))!==JSON.stringify(c))fail('RUNNER_CHECKPOINT_CHANGED');
   c.chunks[index]='UNCERTAIN';await persist(root,c);await assertHeld();
   if(JSON.stringify(await loadRunnerCheckpoint(root))!==JSON.stringify(c))fail('RUNNER_CHECKPOINT_CHANGED');
   const saved=await transport.uploadChunk({...args,bytes});
   validateReceipt(saved,c,index);c.chunks[index]='RECEIVED';await persist(root,c);
  }
  c.status='UPLOADS_RECEIVED_PROVIDER_NOT_DISPATCHED';await persist(root,c);return {status:c.status,chunks:c.chunks.length,providerCalls:0};
 }catch(error){
  c.status=error.code==='RUNNER_AUTH_REQUIRED'?'AUTH_REQUIRED':'RECONCILIATION_REQUIRED';
  await persist(root,c);throw error;
 }
}
