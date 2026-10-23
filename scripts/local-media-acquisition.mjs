import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,readFileSync} from 'node:fs';
import {open,readFile,rename,readdir,realpath,stat,lstat} from 'node:fs/promises';
import {join,basename,extname,relative,isAbsolute} from 'node:path';
import {canonicalYouTubeUrl,checkPublicVideoMetadata} from '../src/local-runner-contract.mjs';
import {scanMp3,planMp3,prepareMp3Chunk} from '../src/audio.mjs';
import {withRunnerLock} from './local-runner-lock.mjs';
import {runLocalCommand} from './local-runner-process.mjs';
import {conversionCommand} from './local-runner-commands.mjs';
import {buildVerifiedManifest} from './local-runner-manifest.mjs';
import {createRunnerCheckpoint,verifyRunnerFiles} from './local-runner-session.mjs';
import {acquisitionLimits,acquisitionVersionCommands,boundedAcquisitionCommands} from './local-acquisition-contract.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stateName='runner-acquisition.json';
function verifyConvertedFormat(bytes){
 const {frames}=scanMp3(bytes);
 // Use parsed frame offsets (including ID3 handling), and inspect EVERY frame.
 // Hash agreement and a successful process exit do not establish conversion format.
 for(const {byteStart} of frames){
  const version=(bytes[byteStart+1]>>3)&3,rateIndex=(bytes[byteStart+2]>>2)&3;
  const sampleRate=[44100,48000,32000][rateIndex]/(version===3?1:version===2?2:4);
  const audioChannels=((bytes[byteStart+3]>>6)&3)===3?1:2;
  if(sampleRate!==16000||audioChannels!==1)fail('RUNNER_CONVERSION_FORMAT_MISMATCH');
 }
 return {audioChannels:1,sampleRate:16000,format:'mp3',frameCount:frames.length};
}
async function measure(path){const hash=createHash('sha256');let bytes=0;for await(const part of createReadStream(path)){bytes+=part.length;if(bytes>acquisitionLimits.maxSourceBytes)fail('RUNNER_SOURCE_TOO_LARGE');hash.update(part);}if(!bytes)fail('RUNNER_EMPTY_FILE');return {sha256:hash.digest('hex'),bytes};}
async function sourceFile(root,path){
 const file=await realpath(path),tail=relative(root,file);
 if(!tail||tail.startsWith('..')||isAbsolute(tail)||tail!==basename(file)||!(await stat(file)).isFile()||(await lstat(path)).isSymbolicLink())fail('RUNNER_SOURCE_PATH_INVALID');
 if(!/^source\./.test(tail)||!['.m4a','.mp3','.webm','.ogg','.opus','.mp4'].includes(extname(file).toLowerCase()))fail('RUNNER_SOURCE_PATH_INVALID');
 if((await stat(file)).size>acquisitionLimits.maxSourceBytes)fail('RUNNER_SOURCE_TOO_LARGE');return file;
}
function context(options){
 const {url,jobId,requestId,consent,toolHashes}=options,{videoId,url:canonicalUrl}=canonicalYouTubeUrl(url);
 if(!uuid.test(jobId||'')||!uuid.test(requestId||'')||!exact(toolHashes,['yt-dlp','ffmpeg'])||Object.values(toolHashes).some(v=>typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v)))fail('RUNNER_ACQUISITION_SCOPE_INVALID');
 const scope={jobId,requestId,canonicalUrl,videoId,toolHashes:{'yt-dlp':toolHashes['yt-dlp'],ffmpeg:toolHashes.ffmpeg},...acquisitionLimits};
 if(!exact(consent,['kind','jobId','requestId','canonicalUrl','rightsConfirmed','maxDurationSeconds','maxSourceBytes','expiresAt'])||consent.kind!=='LOCAL_MEDIA_ACQUISITION_CONSENT_V1'||consent.rightsConfirmed!==true||['jobId','requestId','canonicalUrl','maxDurationSeconds','maxSourceBytes'].some(k=>consent[k]!==scope[k]))fail('RUNNER_ACQUISITION_CONSENT_REQUIRED');
 return {scope,scopeHash:sha(JSON.stringify(scope))};
}
// User-invoked module, not a daemon or production route. No upload, provider,
// transcription or summary call is made here. commandRunner is fixture injection.
export function prepareLocalMedia(options){return withRunnerLock(options.workDir,assertHeld=>prepareLocked(options,assertHeld));}
async function prepareLocked(options,assertHeld){
 const {scope,scopeHash}=context(options),{foreground=()=>false,signal,clock=Date.now,commandRunner=runLocalCommand}=options;
 const consent={...options.consent},toolPaths={...options.toolPaths},toolHashes={...scope.toolHashes};
 const root=await realpath(options.workDir),path=join(root,stateName);let state,raw;
 const guard=()=>{
  const now=clock();if(!foreground()||signal?.aborted)fail('RUNNER_ACQUISITION_STOPPED');
  if(!Number.isSafeInteger(consent.expiresAt)||consent.expiresAt<=now||consent.expiresAt>now+3600000)fail('RUNNER_ACQUISITION_CONSENT_EXPIRED');
  if(raw!==undefined&&readFileSync(path,'utf8')!==raw)fail('RUNNER_ACQUISITION_STATE_CHANGED');
 };
 guard();
 try{raw=await readFile(path,'utf8');if(raw.length>256000)fail('RUNNER_ACQUISITION_STATE_INVALID');state=JSON.parse(raw);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(state){
  if(!exact(state,['kind','scopeHash','status','phase','evidence','error'])||state.kind!=='LOCAL_MEDIA_PREPARATION_V1'||state.scopeHash!==scopeHash)fail('RUNNER_ACQUISITION_SCOPE_CHANGED');
  if(state.status!=='READY')fail('RUNNER_ACQUISITION_RECONCILIATION_REQUIRED');
  const checkpoint=await verifyRunnerFiles(root),file=await sourceFile(root,join(root,state.evidence.source.name));
  if(checkpoint.manifestSha256!==state.evidence.manifestSha256||checkpoint.manifest.jobId!==scope.jobId||checkpoint.manifest.requestId!==scope.requestId||checkpoint.manifest.canonicalUrl!==scope.canonicalUrl||JSON.stringify(await measure(file))!==JSON.stringify(state.evidence.source.measurement))fail('RUNNER_LOCAL_FILES_CHANGED');
  const readyAudio=new Uint8Array(await readFile(join(root,checkpoint.audioFile)));
  if(sha(readyAudio)!==checkpoint.manifest.fileSha256)fail('RUNNER_LOCAL_FILES_CHANGED');
  verifyConvertedFormat(readyAudio);
  guard();return {state:'LOCAL_MEDIA_READY',manifest:checkpoint.manifest,manifestSha256:checkpoint.manifestSha256,providerCalls:0,transcriptComplete:false,summaryComplete:false,reused:true};
 }
 if((await readdir(root)).some(name=>name!=='.runner-session.lock'))fail('RUNNER_ACQUISITION_DIRECTORY_NOT_EMPTY');
 state={kind:'LOCAL_MEDIA_PREPARATION_V1',scopeHash,status:'IN_PROGRESS',phase:'START',evidence:{},error:null};
 async function persist(initial=false){
  await assertHeld();guard();const next=JSON.stringify(state),target=initial?path:join(root,`.acquisition-${randomUUID()}.tmp`),f=await open(target,'wx',0o600);
  try{await f.writeFile(next);await f.sync();}finally{await f.close();}
  if(!initial){await assertHeld();guard();await rename(target,path);}raw=next;
 }
 await persist(true);
 async function command(phase,description){
  state.phase=phase;await persist();await assertHeld();guard();
  const lock=readFileSync(join(root,'.runner-session.lock'),'utf8');
  const beforeSpawn=()=>{guard();if(readFileSync(join(root,'.runner-session.lock'),'utf8')!==lock)fail('RUNNER_PROCESS_LOCK_CHANGED');};
  const result=await commandRunner(description,{cwd:root,toolPaths,toolHashes,beforeSpawn,signal,timeoutMs:Math.max(1000,Math.min(600000,consent.expiresAt-clock())),maxOutputBytes:65536});
  guard();await assertHeld();if(typeof result?.stdout!=='string'||result.code!==0)fail('RUNNER_COMMAND_FAILED');return result.stdout;
 }
 try{
  const ytdlp=(await command('YT_DLP_VERSION',acquisitionVersionCommands[0])).trim();
  const ffmpeg=(await command('FFMPEG_VERSION',acquisitionVersionCommands[1])).match(/^ffmpeg version (\S+)/)?.[1];
  if(!/^\d{4}\.\d{2}\.\d{2}$/.test(ytdlp)||!/^(?:\d[\w.+-]{0,79}|N-\d+-g[0-9a-f]+(?:-[\w.+-]+)?)$/.test(ffmpeg||''))fail('RUNNER_TOOL_VERSION_UNVERIFIED');
  const commands=boundedAcquisitionCommands({url:scope.canonicalUrl,workDir:root});
  let metadata;try{metadata=JSON.parse(await command('METADATA',commands[0]));}catch(error){if(error.code)throw error;fail('RUNNER_METADATA_INVALID');}
  const checked=checkPublicVideoMetadata(metadata,scope.videoId);
  state.evidence.metadata={id:checked.videoId,durationSeconds:checked.durationSeconds,availability:'public',isLive:false};
  state.evidence.toolVersions={ytDlp:ytdlp,ffmpeg};
  const downloaded=(await command('DOWNLOAD',commands[1])).trim();if(/[\r\n\0]/.test(downloaded))fail('RUNNER_SOURCE_PATH_INVALID');
  const source=await sourceFile(root,downloaded),sourceMeasurement=await measure(source);
  state.evidence.source={name:basename(source),measurement:sourceMeasurement};
  await command('CONVERT',await conversionCommand({workDir:root,downloadedPath:source}));
  if(JSON.stringify(await measure(source))!==JSON.stringify(sourceMeasurement))fail('RUNNER_LOCAL_FILES_CHANGED');
  const audioPath=join(root,'audio.mp3');if((await lstat(audioPath)).isSymbolicLink()||(await stat(audioPath)).size>acquisitionLimits.maxSourceBytes)fail('RUNNER_SOURCE_PATH_INVALID');
  const audioBytes=new Uint8Array(await readFile(audioPath));
  state.evidence.outputFormat=verifyConvertedFormat(audioBytes);
  const plan=planMp3(audioBytes);
  if(Math.abs(plan.durationSeconds-checked.durationSeconds)>2||plan.chunks.length>160)fail('RUNNER_DURATION_MISMATCH');
  state.phase='CHUNKS';await persist();const chunks=[],chunkPaths=[];
  for(const chunk of plan.chunks){
   guard();const part=prepareMp3Chunk(audioBytes.slice(chunk.byteStart,chunk.byteEnd));
   const chunkPath=join(root,`chunk-${String(chunk.index).padStart(4,'0')}.mp3`),file=await open(chunkPath,'wx',0o600);
   try{await file.writeFile(part.bytes);await file.sync();}finally{await file.close();}
   chunks.push({path:chunkPath,index:chunk.index,start:chunk.start,end:chunk.end});chunkPaths.push(chunkPath);
  }
  const manifest=await buildVerifiedManifest({workDir:root,jobId:scope.jobId,requestId:scope.requestId,videoId:scope.videoId,audioPath,durationSeconds:plan.durationSeconds,ytDlpVersion:ytdlp,ffmpegVersion:ffmpeg,chunks});
  if(manifest.fileSha256!==sha(audioBytes)||JSON.stringify(await measure(source))!==JSON.stringify(sourceMeasurement))fail('RUNNER_LOCAL_FILES_CHANGED');
  guard();await assertHeld();const checkpoint=await createRunnerCheckpoint({workDir:root,manifest,audioPath,chunkPaths});
  state.evidence.manifestSha256=checkpoint.manifestSha256;state.evidence.chunkDerivation=plan.chunks.map(c=>({index:c.index,byteStart:c.byteStart,byteEnd:c.byteEnd,start:c.start,end:c.end}));
  state.status='READY';state.phase='COMPLETE';await persist();
  return {state:'LOCAL_MEDIA_READY',manifest,manifestSha256:checkpoint.manifestSha256,providerCalls:0,transcriptComplete:false,summaryComplete:false,reused:false};
 }catch(error){
  // Keep partial files and the last phase. No automatic command replay or cleanup.
  state.status='RECONCILIATION_REQUIRED';state.error=/^RUNNER_[A-Z_]+$/.test(error.code||'')?error.code:'RUNNER_ACQUISITION_FAILED';
  try{await assertHeld();if(readFileSync(path,'utf8')===raw){const temporary=join(root,`.acquisition-failed-${randomUUID()}.tmp`),f=await open(temporary,'wx',0o600);try{await f.writeFile(JSON.stringify(state));await f.sync();}finally{await f.close();}await assertHeld();if(readFileSync(path,'utf8')===raw)await rename(temporary,path);}}catch{}
  throw error;
 }
}
