import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname,resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {asrTranscriptDigests,ASR_BRIDGE_LIMITS} from '../src/asr-result-bridge.mjs';

// Offline evidence adapter. This neither runs an ASR model nor contacts a site,
// provider, database, or cloud worker. Actual media/results are runtime inputs,
// never repository fixtures. Owner authentication remains the receiving route's
// responsibility. Matching files is not attestation of an ASR producer.
const execute=promisify(execFile);
const MAX_JSON_BYTES=8*1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const near=(a,b,tolerance=1e-7)=>finite(a)&&finite(b)&&Math.abs(a-b)<=tolerance;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const normalized=text=>text.replace(/\s+/gu,' ').trim();
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export class LocalAsrEvidenceError extends Error{constructor(code){super(code);this.name='LocalAsrEvidenceError';this.code=code;}}
const fail=code=>{throw new LocalAsrEvidenceError(code);};
const requireThat=(condition,code)=>{if(!condition)fail(code);};

async function boundedRead(path,maxBytes){
 const info=await stat(path);requireThat(info.isFile()&&info.size>0&&info.size<=maxBytes,'ASR_INPUT_SIZE_INVALID');
 const bytes=await readFile(path);requireThat(bytes.length===info.size,'ASR_INPUT_CHANGED_DURING_READ');return bytes;
}
async function readJson(path){const bytes=await boundedRead(path,MAX_JSON_BYTES);let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('ASR_INPUT_JSON_INVALID');}return {bytes,value};}

export function inspectPcmWav(bytes){
 requireThat(Buffer.isBuffer(bytes)&&bytes.length>=44&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE','ASR_WAV_FORMAT_INVALID');
 requireThat(bytes.readUInt32LE(4)+8===bytes.length,'ASR_WAV_SIZE_MISMATCH');
 let offset=12,format=null,pcm=null,chunkCount=0;
 while(offset+8<=bytes.length){
  requireThat(++chunkCount<=1024,'ASR_WAV_CHUNKS_EXCEEDED');
  const id=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8,end=start+size;
  requireThat(end<=bytes.length,'ASR_WAV_CHUNK_INVALID');
  if(id==='fmt '){requireThat(format===null&&size>=16,'ASR_WAV_FORMAT_INVALID');format={codec:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),sampleRate:bytes.readUInt32LE(start+4),byteRate:bytes.readUInt32LE(start+8),blockAlign:bytes.readUInt16LE(start+12),bits:bytes.readUInt16LE(start+14)};}
  if(id==='data'){requireThat(pcm===null,'ASR_WAV_MULTIPLE_DATA_CHUNKS');pcm=bytes.subarray(start,end);}
  offset=end+(size%2);
 }
 requireThat(offset===bytes.length&&format?.codec===1&&format.channels===1&&format.sampleRate===16000&&format.bits===16&&format.blockAlign===2&&format.byteRate===32000&&pcm?.length>0&&pcm.length%2===0,'ASR_WAV_PCM_CONTRACT_INVALID');
 const sampleCount=pcm.length/2;requireThat(sampleCount<=16000*7200,'ASR_AUDIO_DURATION_EXCEEDED');
 return {sampleRate:16000,sampleCount,channels:1,format:'WAV_PCM_S16LE',durationMs:sampleCount/16000*1000,pcmSha256:digest(pcm),pcmBytes:pcm.length};
}

async function probe(path,format){
 let stdout;
 try{({stdout}=await execute('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-f',format,'-show_entries','format=duration,size:stream=codec_name,sample_rate,channels,duration,duration_ts,time_base,start_time','-of','json',resolve(path)],{timeout:30000,maxBuffer:1024*1024}));}catch{fail('ASR_FFPROBE_FAILED');}
 let value;try{value=JSON.parse(stdout);}catch{fail('ASR_FFPROBE_JSON_INVALID');}
 requireThat(Array.isArray(value.streams)&&value.streams.length===1&&value.format,'ASR_FFPROBE_STREAM_INVALID');
 const stream=value.streams[0],durationMs=Number(value.format.duration)*1000;
 requireThat(Number.isFinite(durationMs)&&durationMs>0&&durationMs<=7200*1000&&Number(value.format.size)>0,'ASR_FFPROBE_DURATION_INVALID');
 const measurement={method:'FFPROBE',containerDurationMs:durationMs,startTimeMs:stream.start_time===undefined?null:Number(stream.start_time)*1000,bytes:Number(value.format.size),codec:stream.codec_name,sampleRate:Number(stream.sample_rate),channels:stream.channels,timeBase:stream.time_base??null,durationTicks:stream.duration_ts??null};
 requireThat(measurement.startTimeMs===null||finite(measurement.startTimeMs),'ASR_FFPROBE_START_INVALID');
 return {measurement,sha256:digest(Buffer.from(canonical(measurement)))};
}

async function decodedPcmFingerprint(path,expectedBytes,format){
 return new Promise((accept,reject)=>{
  const proc=spawn('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-f',format,'-i',resolve(path),'-f','s16le','-acodec','pcm_s16le','-ar','16000','-ac','1','pipe:1'],{stdio:['ignore','pipe','pipe']});
  const sum=createHash('sha256');let count=0,problem=null;
  const stop=code=>{if(!problem)problem=new LocalAsrEvidenceError(code);proc.kill('SIGKILL');};
  const timer=setTimeout(()=>stop('ASR_DECODE_TIMEOUT'),120000);
  proc.stdout.on('data',bytes=>{count+=bytes.length;if(count>expectedBytes){stop('ASR_DECODE_SIZE_MISMATCH');return;}sum.update(bytes);});
  // Decoder diagnostics can contain private filenames. Consume without logging.
  proc.stderr.on('data',()=>{});
  proc.on('error',()=>{clearTimeout(timer);reject(new LocalAsrEvidenceError('ASR_FFMPEG_UNAVAILABLE'));});
  proc.on('close',code=>{clearTimeout(timer);if(problem)return reject(problem);if(code!==0)return reject(new LocalAsrEvidenceError('ASR_DECODE_FAILED'));if(count!==expectedBytes)return reject(new LocalAsrEvidenceError('ASR_DECODE_SIZE_MISMATCH'));accept({bytes:count,sha256:sum.digest('hex')});});
 });
}

const wordValue=word=>({chunk:word.chunk,start:word.start,end:word.end,word:word.word,probability:word.probability});
function validWord(word,duration){return word&&finite(word.start)&&finite(word.end)&&word.start>=0&&word.end>=word.start&&word.end<=duration+.25&&typeof word.word==='string'&&finite(word.probability)&&word.probability>=0&&word.probability<=1;}
function rounded(value){return Math.round(value*1000000)/1000000;}

export async function producerManifestConfigDigest(manifestBytes){
 // Producer v1 uses Python JSON with sorted keys, indentation and a newline.
 // Pass the ORIGINAL JSON bytes, not JSON.stringify(parsedConfig): the latter
 // loses Python's 60.0 versus 60 distinction. Only stdlib JSON data is read.
 const code='import hashlib,json,sys\nvalue=json.load(sys.stdin)\nraw=json.dumps(value["config"],ensure_ascii=False,sort_keys=True,indent=2)+"\\n"\nsys.stdout.write(hashlib.sha256(raw.encode("utf-8")).hexdigest())\n';
 return new Promise((accept,reject)=>{
  const child=execFile('python3',['-I','-c',code],{timeout:30000,maxBuffer:4096},(error,stdout)=>{
   if(error||!hash(stdout))return reject(new LocalAsrEvidenceError('ASR_PRODUCER_CANONICAL_DIGEST_FAILED'));
   accept(stdout);
  });
  child.stdin.on('error',()=>{});child.stdin.end(manifestBytes);
 });
}

function transcriptSegments(words){
 // Whisper's "words" can be subword pieces or punctuation without leading
 // spaces. Joining every piece with a new space would alter the transcript.
 // Group only those adjacent pieces that have no whitespace boundary; retain
 // the original merged raw string separately and preserve the group's times.
 const segments=[];let whitespaceBoundary=false;
 for(const word of words){
  if(!word.word.trim()){whitespaceBoundary=true;continue;}
  const previous=segments.at(-1),newSegment=!previous||whitespaceBoundary||/^\s/u.test(word.word);
  if(newSegment)segments.push({id:segments.length+1,startMs:Math.round(word.start*1000),endMs:Math.round(word.end*1000),text:word.word.trim()});
  else{previous.text+=word.word.trim();previous.endMs=Math.max(previous.endMs,Math.round(word.end*1000));}
  whitespaceBoundary=/\s$/u.test(word.word);
 }
 return segments;
}

export async function verifyFasterWhisperArtifacts({manifestPath,mergedPath,asrInputSha256,wav}){
 const manifestRead=await readJson(manifestPath),mergedRead=await readJson(mergedPath),manifest=manifestRead.value,merged=mergedRead.value;
 requireThat(manifest?.config?.pipeline_version==='1.0.0'&&manifest.config.source_sha256===asrInputSha256&&hash(manifest.job_id)&&hash(manifest.config.model_sha256),'ASR_MANIFEST_SOURCE_MISMATCH');
 requireThat(await producerManifestConfigDigest(manifestRead.bytes)===manifest.job_id,'ASR_PRODUCER_CONFIG_DIGEST_MISMATCH');
 requireThat(manifest.config.device==='cpu'&&typeof manifest.config.compute_type==='string'&&manifest.config.word_timestamps===true,'ASR_PRODUCER_CONFIG_UNSUPPORTED');
 requireThat(manifest.sample_count===wav.sampleCount&&near(manifest.duration_seconds*1000,wav.durationMs),'ASR_MANIFEST_DURATION_MISMATCH');
 requireThat(Array.isArray(manifest.chunks)&&manifest.chunks.length>0&&manifest.chunks.length<=1000,'ASR_MANIFEST_CHUNKS_INVALID');
 const duration=wav.durationMs/1000,kept=[],discarded=[],boundary=[],chunkEvidence=[];let coreEnd=0,coveredEnd=0;
 for(let index=0;index<manifest.chunks.length;index++){
  const chunk=manifest.chunks[index];
  requireThat(chunk.index===index&&['start_frame','end_frame','core_start_frame','core_end_frame'].every(key=>Number.isSafeInteger(chunk[key])),'ASR_CHUNK_INDEX_INVALID');
  requireThat(chunk.start_frame>=0&&chunk.start_frame<=chunk.core_start_frame&&chunk.core_start_frame===coreEnd&&chunk.core_start_frame<chunk.core_end_frame&&chunk.core_end_frame<=chunk.end_frame&&chunk.end_frame<=wav.sampleCount&&chunk.start_frame<=coveredEnd,'ASR_CHUNK_COVERAGE_INVALID');
  for(const [seconds,frames] of [['start','start_frame'],['end','end_frame'],['core_start','core_start_frame'],['core_end','core_end_frame']])requireThat(near(chunk[seconds],chunk[frames]/wav.sampleRate),'ASR_CHUNK_TIMEBASE_MISMATCH');
  coreEnd=chunk.core_end_frame;coveredEnd=Math.max(coveredEnd,chunk.end_frame);
  const cached=await readJson(join(dirname(manifestPath),'chunks',String(index).padStart(4,'0')+'.json')),result=cached.value;
  requireThat(result.job_id===manifest.job_id&&result.index===index&&Array.isArray(result.segments),'ASR_CHUNK_CACHE_IDENTITY_MISMATCH');
  chunkEvidence.push({index,sha256:digest(cached.bytes)});
  for(const segment of result.segments){
   requireThat(finite(segment.start)&&finite(segment.end)&&segment.start>=0&&segment.end>=segment.start&&segment.end<=chunk.end-chunk.start+.25&&Array.isArray(segment.words),'ASR_CHUNK_SEGMENT_INVALID');
   for(const word of segment.words){
    requireThat(validWord(word,chunk.end-chunk.start),'ASR_CHUNK_WORD_INVALID');
    const absolute={...wordValue({...word,chunk:index}),start:rounded(word.start+chunk.start),end:rounded(word.end+chunk.start)};
    // Producer v1 stores six decimal places in seconds. Permit only that
    // rounding error at the measured EOF, never an extra unprocessed interval.
    requireThat(absolute.end<=duration+0.000000500001,'ASR_WORD_OUTSIDE_INPUT');
    const center=(absolute.start+absolute.end)/2,last=index===manifest.chunks.length-1;
    if(chunk.core_start<=center&&(center<chunk.core_end||(last&&center<=chunk.core_end))){
     kept.push(absolute);
     if([chunk.core_start,chunk.core_end].some(value=>value>0&&value<duration&&Math.abs(center-value)<1))boundary.push(absolute);
    }else discarded.push(absolute);
   }
  }
 }
 requireThat(coreEnd===wav.sampleCount&&coveredEnd===wav.sampleCount,'ASR_INPUT_NOT_FULLY_PROCESSED');
 kept.sort((a,b)=>a.start-b.start||a.end-b.end||a.chunk-b.chunk);
 const coverage=manifest.input_coverage,processed=merged?.processed_input_coverage;
 requireThat(coverage?.coverage_fraction===1&&coverage.missing_seconds===0&&Array.isArray(coverage.gaps)&&coverage.gaps.length===0&&processed?.coverage_fraction===1&&processed.missing_seconds===0&&Array.isArray(processed.gaps)&&processed.gaps.length===0&&Array.isArray(merged.unprocessed_chunks)&&merged.unprocessed_chunks.length===0,'ASR_COVERAGE_RECEIPT_INVALID');
 requireThat(merged.algorithm==='word_midpoint_core_ownership'&&Array.isArray(merged.words)&&Array.isArray(merged.discarded_overlap_words)&&Array.isArray(merged.boundary_review_words),'ASR_MERGE_ALGORITHM_UNSUPPORTED');
 for(const [received,computed] of [[merged.words,kept],[merged.discarded_overlap_words,discarded],[merged.boundary_review_words,boundary]]){
  requireThat(received.every(word=>exactKeys(word,['chunk','start','end','word','probability']))&&canonical(received.map(wordValue))===canonical(computed),'ASR_MERGED_WORDS_MISMATCH');
 }
 requireThat(typeof merged.text==='string'&&merged.text===kept.map(word=>word.word).join('').trim()&&merged.text.length>0,'ASR_MERGED_RAW_MISMATCH');
 const segments=transcriptSegments(kept);
 requireThat(segments.length>0&&normalized(merged.text)===normalized(segments.map(segment=>segment.text).join(' ')),'ASR_TRANSCRIPT_CONTENT_MISMATCH');
 return {raw:merged.text,segments,engineMetadata:{modelSha256:manifest.config.model_sha256,computeType:manifest.config.compute_type,device:'cpu'},evidence:{manifestSha256:digest(manifestRead.bytes),mergedSha256:digest(mergedRead.bytes),chunkHashes:chunkEvidence,processedSampleCount:wav.sampleCount,processedInputCoverage:1,chunkCount:manifest.chunks.length,wordCount:kept.length,segmentCount:segments.length,discardedOverlapWords:discarded.length,boundaryReviewWords:boundary.length,lastCueEndMs:segments.at(-1).endMs,appTimestampNormalization:'ROUND_TO_NEAREST_MILLISECOND',originalArtifactTimesPreserved:true,transcriptionAccuracy:'NOT_VERIFIED',newAsrInference:false,producerExecutionAttestation:'NOT_INDEPENDENTLY_REEXECUTED'}};
}

export async function prepareLocalAsrDelivery({originalAudioPath,asrInputPath,manifestPath,mergedPath,context,model,engineVersion=null}){
 requireThat(context&&uuid(context.jobId)&&uuid(context.requestId)&&hash(context.jobSourceSha256),'ASR_REQUEST_CONTEXT_INVALID');
 // Public/owned audio cannot be used as proof of a YouTube acquisition. The URL
// worker must supply its own reviewed acquisition evidence; this adapter does
// not fetch or invent it.
 requireThat(exactKeys(context.sourceIdentity,['kind','originalAudioSha256'])&&context.sourceIdentity.kind==='OWNED_AUDIO'&&hash(context.sourceIdentity.originalAudioSha256),'ASR_URL_ACQUISITION_PROOF_REQUIRED');
 requireThat(typeof model==='string'&&/^[A-Za-z0-9._-]{1,80}$/.test(model)&&(engineVersion===null||typeof engineVersion==='string'&&/^[A-Za-z0-9._-]{1,40}$/.test(engineVersion)),'ASR_ENGINE_METADATA_INVALID');
 const [original,input]=await Promise.all([boundedRead(originalAudioPath,ASR_BRIDGE_LIMITS.originalAudioBytes),boundedRead(asrInputPath,ASR_BRIDGE_LIMITS.inputAudioBytes)]);
 const originalSha=digest(original),inputSha=digest(input);requireThat(originalSha===context.sourceIdentity.originalAudioSha256,'ASR_OWNED_AUDIO_HASH_MISMATCH');
 const originalFormat=original.length>=12&&original.toString('ascii',0,4)==='RIFF'&&original.toString('ascii',8,12)==='WAVE'?'wav':'mp3';
 const wav=inspectPcmWav(input),[originalProbe,inputProbe]=await Promise.all([probe(originalAudioPath,originalFormat),probe(asrInputPath,'wav')]);
 const originalCodecMatches=originalFormat==='mp3'?originalProbe.measurement.codec==='mp3':/^pcm_[a-z0-9]+$/.test(originalProbe.measurement.codec);
 requireThat(originalCodecMatches&&originalProbe.measurement.bytes===original.length,'ASR_ORIGINAL_PROBE_MISMATCH');
 requireThat(inputProbe.measurement.codec==='pcm_s16le'&&inputProbe.measurement.bytes===input.length&&inputProbe.measurement.sampleRate===wav.sampleRate&&inputProbe.measurement.channels===wav.channels&&near(inputProbe.measurement.containerDurationMs,wav.durationMs,.001),'ASR_NORMALIZED_PROBE_MISMATCH');
 const decoded=await decodedPcmFingerprint(originalAudioPath,wav.pcmBytes,originalFormat);requireThat(decoded.sha256===wav.pcmSha256,'ASR_AUDIO_TRANSFORMATION_MISMATCH');
 // Verify the same bytes still exist after external measurement/decoding.
 requireThat(digest(await boundedRead(originalAudioPath,ASR_BRIDGE_LIMITS.originalAudioBytes))===originalSha&&digest(await boundedRead(asrInputPath,ASR_BRIDGE_LIMITS.inputAudioBytes))===inputSha,'ASR_INPUT_CHANGED_DURING_VERIFICATION');
 const transcript=await verifyFasterWhisperArtifacts({manifestPath,mergedPath,asrInputSha256:inputSha,wav});
 const sampleMeasurement={method:'PCM_SAMPLE_COUNT',sampleRate:wav.sampleRate,sampleCount:wav.sampleCount,channels:wav.channels,format:wav.format,durationMs:wav.durationMs,pcmSha256:wav.pcmSha256,ffprobeMeasurementSha256:inputProbe.sha256};
 const source={kind:'OWNER_SUBMITTED_ASR_SOURCE_V1',jobId:context.jobId,requestId:context.requestId,jobSourceSha256:context.jobSourceSha256,sourceIdentity:{...context.sourceIdentity},originalAudio:{sha256:originalSha,bytes:original.length,durationMs:originalProbe.measurement.containerDurationMs,measurement:'FFPROBE',measurementSha256:originalProbe.sha256,startTimeMs:originalProbe.measurement.startTimeMs},asrInput:{sha256:inputSha,bytes:input.length,durationMs:wav.durationMs,measurement:'PCM_SAMPLE_COUNT',measurementSha256:digest(Buffer.from(canonical(sampleMeasurement))),sampleRate:16000,channels:1,sampleCount:wav.sampleCount,format:'WAV_PCM_S16LE',pcmSha256:wav.pcmSha256,timeOrigin:'NORMALIZED_AUDIO_FRAME_ZERO'}};
 const result={kind:'OWNER_SUBMITTED_LOCAL_ASR_RESULT_V1',jobId:context.jobId,requestId:context.requestId,revision:null,jobSourceSha256:context.jobSourceSha256,sourceBindingSha256:null,originalAudioSha256:originalSha,asrInputSha256:inputSha,asrPcmSha256:wav.pcmSha256,transcript:{raw:transcript.raw,segments:transcript.segments,...await asrTranscriptDigests(transcript.raw,transcript.segments)},engine:{name:'faster-whisper',model,version:engineVersion,device:'cpu',computeType:transcript.engineMetadata.computeType},confirmOwnerSubmitted:true,confirmNoProviderCall:true};
 const delivery={source,result};requireThat(Buffer.byteLength(JSON.stringify(delivery),'utf8')<=2000000,'ASR_DELIVERY_TOO_LARGE');
 return {delivery,evidence:{kind:'OFFLINE_ASR_FILE_BINDING_EVIDENCE_V1',originalAudioSha256:originalSha,asrInputSha256:inputSha,pcmSha256:wav.pcmSha256,originalProbe:originalProbe.measurement,normalizedProbe:inputProbe.measurement,sampleMeasurement,decodedOriginalMatchesAsrPcm:true,modelIdentity:'PRODUCER_MANIFEST_DECLARED_NOT_REEXECUTED',modelSha256:transcript.engineMetadata.modelSha256,...transcript.evidence,cloudWorkerCreated:false,providerCalls:0,siteOrDatabaseCalls:0}};
}

async function main(args){
 const options={};for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];requireThat(['--original','--asr-input','--manifest','--merged','--context','--model','--engine-version','--out','--evidence'].includes(key)&&value&&!Object.hasOwn(options,key),'ASR_ARGUMENT_INVALID');options[key]=value;}
 for(const key of ['--original','--asr-input','--manifest','--merged','--context','--model','--out'])requireThat(options[key],'ASR_ARGUMENT_REQUIRED');
 const context=(await readJson(options['--context'])).value;
 const prepared=await prepareLocalAsrDelivery({originalAudioPath:options['--original'],asrInputPath:options['--asr-input'],manifestPath:options['--manifest'],mergedPath:options['--merged'],context,model:options['--model'],engineVersion:options['--engine-version']??null});
 const output=resolve(options['--out']);const bytes=Buffer.from(JSON.stringify(prepared.delivery,null,2)+'\n');requireThat(bytes.length<=2000000,'ASR_DELIVERY_TOO_LARGE');await mkdir(dirname(output),{recursive:true});await writeFile(output,bytes,{flag:'wx',mode:0o600});
 if(options['--evidence']){const evidence=resolve(options['--evidence']);await mkdir(dirname(evidence),{recursive:true});await writeFile(evidence,JSON.stringify(prepared.evidence,null,2)+'\n',{flag:'wx',mode:0o600});}
 process.stdout.write(JSON.stringify({written:true,deliveryBytes:bytes.length,deliverySha256:digest(bytes),segments:prepared.delivery.result.transcript.segments.length,actualAsrExecuted:false,siteOrDatabaseCalls:0})+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{process.stderr.write(JSON.stringify({error:error instanceof LocalAsrEvidenceError?error.code:'ASR_LOCAL_ADAPTER_FAILED',providerCalls:0,siteOrDatabaseCalls:0})+'\n');process.exitCode=1;});
