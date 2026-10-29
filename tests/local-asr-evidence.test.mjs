import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {inspectPcmWav,prepareLocalAsrDelivery,verifyFasterWhisperArtifacts,producerManifestConfigDigest} from '../scripts/prepare-local-asr-result.mjs';

// Invented text and generated tone only. No recording, actual ASR output,
// account, owner identity, provider request, database, or cloud worker exists.
const execute=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function tone(frames=32000){
 const data=Buffer.alloc(frames*2),out=Buffer.alloc(44+data.length);
 for(let index=0;index<frames;index++)data.writeInt16LE(Math.round(1000*Math.sin(2*Math.PI*440*index/16000)),index*2);
 out.write('RIFF',0);out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(16000,24);out.writeUInt32LE(32000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(data.length,40);data.copy(out,44);return out;
}
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'synthetic-asr-evidence-')),originalAudioPath=join(directory,'tone.mp3'),asrInputPath=join(directory,'normalized.wav'),manifestPath=join(directory,'manifest.json'),mergedPath=join(directory,'merged.json'),tonePath=join(directory,'tone.wav');
 await writeFile(tonePath,tone());
 await execute('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',tonePath,'-c:a','libmp3lame','-b:a','128k',originalAudioPath],{timeout:30000});
 await execute('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',originalAudioPath,'-ar','16000','-ac','1','-c:a','pcm_s16le',asrInputPath],{timeout:30000});
 const original=await readFile(originalAudioPath),input=await readFile(asrInputPath),wav=inspectPcmWav(input),duration=wav.durationMs/1000;
 const config={pipeline_version:'1.0.0',source_sha256:sha(input),model_sha256:'b'.repeat(64),device:'cpu',compute_type:'int8',word_timestamps:true};
 // Independent JS golden serializer is exact for this string/bool-only fixture.
 const producerId=sha(JSON.stringify(Object.fromEntries(Object.entries(config).sort(([a],[b])=>a.localeCompare(b))),null,2)+'\n');
 const words=[{start:.1,end:.5,word:' Synthetic',probability:.9},{start:.6,end:1,word:' speech.',probability:.8}];
 const chunk={index:0,start:0,end:duration,core_start:0,core_end:duration,start_frame:0,end_frame:wav.sampleCount,core_start_frame:0,core_end_frame:wav.sampleCount};
 const manifest={job_id:producerId,config,duration_seconds:duration,sample_count:wav.sampleCount,chunks:[chunk],input_coverage:{coverage_fraction:1,gaps:[],missing_seconds:0}};
 const merged={algorithm:'word_midpoint_core_ownership',words:words.map(word=>({...word,chunk:0})),discarded_overlap_words:[],boundary_review_words:[],text:'Synthetic speech.',processed_input_coverage:{coverage_fraction:1,gaps:[],missing_seconds:0},unprocessed_chunks:[]};
 const cached={job_id:producerId,index:0,segments:[{start:0,end:1,words}]};
 await mkdir(join(directory,'chunks'));const cachedPath=join(directory,'chunks','0000.json');
 const save=async(path,value)=>writeFile(path,JSON.stringify(value)+'\n');await save(manifestPath,manifest);await save(mergedPath,merged);await save(cachedPath,cached);
 const context={jobId:'00000000-0000-4000-8000-000000000901',requestId:'00000000-0000-4000-8000-000000000902',jobSourceSha256:'c'.repeat(64),sourceIdentity:{kind:'OWNED_AUDIO',originalAudioSha256:sha(original)}};
 return {directory,originalAudioPath,asrInputPath,manifestPath,mergedPath,cachedPath,manifest,merged,cached,context,wav,save,args:{originalAudioPath,asrInputPath,manifestPath,mergedPath,context,model:'synthetic-small'},inspect:()=>verifyFasterWhisperArtifacts({manifestPath,mergedPath,asrInputSha256:sha(input),wav}),close:()=>rm(directory,{recursive:true,force:true})};
}
async function using(run){const f=await fixture(),prior=globalThis.fetch;globalThis.fetch=()=>{throw new Error('NETWORK_NOT_PERMITTED');};try{return await run(f);}finally{globalThis.fetch=prior;await f.close();}}

test('WAV sample duration derives from actual PCM bytes and rejects forged headers',()=>{
 const audio=tone(),wav=inspectPcmWav(audio);assert.equal(wav.sampleCount,32000);assert.equal(wav.durationMs,2000);assert.equal(wav.pcmSha256,sha(audio.subarray(44)));
 const wrong=Buffer.from(audio);wrong.writeUInt32LE(8000,24);assert.throws(()=>inspectPcmWav(wrong),{code:'ASR_WAV_PCM_CONTRACT_INVALID'});
 const short=audio.subarray(0,-2);assert.throws(()=>inspectPcmWav(short),{code:'ASR_WAV_SIZE_MISMATCH'});
});
test('producer configuration digest preserves Python float spelling from original JSON bytes',async()=>{
 const bytes=Buffer.from('{"config":{"language":"합성","window":60.0,"overlap":0.0}}');
 const golden='{\n  "language": "합성",\n  "overlap": 0.0,\n  "window": 60.0\n}\n';
 assert.equal(await producerManifestConfigDigest(bytes),sha(golden));
 assert.notEqual(await producerManifestConfigDigest(bytes),sha(JSON.stringify(JSON.parse(bytes).config,null,2)+'\n'));
});
test('generated tone, local ffprobe and decoded bytes form a repeatable owner delivery without ASR or network',async()=>using(async f=>{
 const first=await prepareLocalAsrDelivery(f.args),second=await prepareLocalAsrDelivery(f.args);
 assert.deepEqual(first,second);assert.equal(first.delivery.source.sourceIdentity.kind,'OWNED_AUDIO');
 assert.equal(first.delivery.source.originalAudio.measurement,'FFPROBE');assert.equal(first.delivery.source.asrInput.measurement,'PCM_SAMPLE_COUNT');assert.equal(first.delivery.source.asrInput.timeOrigin,'NORMALIZED_AUDIO_FRAME_ZERO');
 assert.equal(first.delivery.source.asrInput.durationMs,2000);assert.ok(first.delivery.source.originalAudio.durationMs>first.delivery.source.asrInput.durationMs);
 assert.notEqual(first.delivery.source.originalAudio.sha256,first.delivery.source.asrInput.sha256);assert.notEqual(first.delivery.source.asrInput.sha256,first.delivery.source.asrInput.pcmSha256);
 assert.equal(first.delivery.result.transcript.raw,'Synthetic speech.');assert.equal(first.delivery.result.transcript.segments.length,2);assert.equal(first.delivery.result.revision,null);assert.equal(first.delivery.result.sourceBindingSha256,null);
 assert.equal(first.evidence.decodedOriginalMatchesAsrPcm,true);assert.equal(first.evidence.processedInputCoverage,1);assert.equal(first.evidence.lastCueEndMs,1000);assert.equal(first.evidence.transcriptionAccuracy,'NOT_VERIFIED');assert.equal(first.evidence.newAsrInference,false);assert.equal(first.evidence.cloudWorkerCreated,false);assert.equal(first.evidence.providerCalls,0);
}));
test('public or owned audio cannot be relabelled as a YouTube acquisition by this adapter',async()=>using(async f=>{
 await assert.rejects(prepareLocalAsrDelivery({...f.args,context:{...f.context,sourceIdentity:{kind:'YOUTUBE_ACQUISITION',videoId:'synthetic01',canonicalUrl:'https://www.youtube.com/watch?v=synthetic01',officialDurationMs:2000,metadataSha256:'d'.repeat(64)}}}),{code:'ASR_URL_ACQUISITION_PROOF_REQUIRED'});
}));
test('PCM WAV original selected by the owner follows the same complete decode and binding path',async()=>using(async f=>{
 const bytes=await readFile(f.asrInputPath),context={...f.context,sourceIdentity:{kind:'OWNED_AUDIO',originalAudioSha256:sha(bytes)}};
 const prepared=await prepareLocalAsrDelivery({...f.args,originalAudioPath:f.asrInputPath,context});
 assert.equal(prepared.delivery.source.originalAudio.sha256,sha(bytes));assert.equal(prepared.evidence.originalProbe.codec,'pcm_s16le');
 assert.equal(prepared.delivery.source.originalAudio.durationMs,2000);assert.equal(prepared.evidence.decodedOriginalMatchesAsrPcm,true);
 assert.equal(prepared.delivery.result.transcript.raw,'Synthetic speech.');assert.equal(prepared.evidence.newAsrInference,false);assert.equal(prepared.evidence.providerCalls,0);
}));
test('original audio hash must match the pre-existing owned input binding',async()=>using(async f=>{
 await assert.rejects(prepareLocalAsrDelivery({...f.args,context:{...f.context,sourceIdentity:{kind:'OWNED_AUDIO',originalAudioSha256:'d'.repeat(64)}}}),{code:'ASR_OWNED_AUDIO_HASH_MISMATCH'});
}));
test('a different normalized PCM fails even when its WAV container is well-formed',async()=>using(async f=>{
 const input=await readFile(f.asrInputPath),changed=Buffer.from(input),start=changed.indexOf(Buffer.from('data'))+8;changed[start]^=1;await writeFile(f.asrInputPath,changed);
 await assert.rejects(prepareLocalAsrDelivery(f.args),{code:'ASR_AUDIO_TRANSFORMATION_MISMATCH'});
}));
test('ASR manifest must bind the complete normalized WAV file hash',async()=>using(async f=>{
 f.manifest.config.source_sha256='d'.repeat(64);await f.save(f.manifestPath,f.manifest);await assert.rejects(f.inspect(),{code:'ASR_MANIFEST_SOURCE_MISMATCH'});
}));
test('changing producer model/config cannot reuse old cache identity',async()=>using(async f=>{
 f.manifest.config.model_sha256='d'.repeat(64);await f.save(f.manifestPath,f.manifest);await assert.rejects(f.inspect(),{code:'ASR_PRODUCER_CONFIG_DIGEST_MISMATCH'});
}));
test('changing only manifest source hash to a new input cannot relabel older ASR caches',async()=>using(async f=>{
 const currentHash='d'.repeat(64);f.manifest.config.source_sha256=currentHash;await f.save(f.manifestPath,f.manifest);
 await assert.rejects(verifyFasterWhisperArtifacts({manifestPath:f.manifestPath,mergedPath:f.mergedPath,asrInputSha256:currentHash,wav:f.wav}),{code:'ASR_PRODUCER_CONFIG_DIGEST_MISMATCH'});
}));
test('last cue end cannot replace the measured full-input sample duration',async()=>using(async f=>{
 f.manifest.duration_seconds=1;await f.save(f.manifestPath,f.manifest);await assert.rejects(f.inspect(),{code:'ASR_MANIFEST_DURATION_MISMATCH'});
}));
test('incomplete chunk core coverage cannot be accepted as processed entire audio',async()=>using(async f=>{
 f.manifest.chunks[0].core_end_frame-=160;f.manifest.chunks[0].core_end-=.01;await f.save(f.manifestPath,f.manifest);await assert.rejects(f.inspect(),{code:'ASR_INPUT_NOT_FULLY_PROCESSED'});
}));
test('cached chunk from a different producer job cannot be merged into the result',async()=>using(async f=>{
 f.cached.job_id='d'.repeat(64);await f.save(f.cachedPath,f.cached);await assert.rejects(f.inspect(),{code:'ASR_CHUNK_CACHE_IDENTITY_MISMATCH'});
}));
test('changed cached words cannot inherit an older merged transcript receipt',async()=>using(async f=>{
 f.cached.segments[0].words[0].word=' Changed';await f.save(f.cachedPath,f.cached);await assert.rejects(f.inspect(),{code:'ASR_MERGED_WORDS_MISMATCH'});
}));
test('subword and punctuation pieces retain original raw text without invented spaces',async()=>using(async f=>{
 const words=[{start:.1,end:.2,word:' Syn',probability:.9},{start:.2,end:.5,word:'thetic',probability:.9},{start:.6,end:.8,word:' speech',probability:.8},{start:.8,end:1,word:'.',probability:.8}];
 f.cached.segments[0].words=words;f.merged.words=words.map(word=>({...word,chunk:0}));await f.save(f.cachedPath,f.cached);await f.save(f.mergedPath,f.merged);
 const verified=await f.inspect();assert.equal(verified.raw,'Synthetic speech.');assert.deepEqual(verified.segments,[{id:1,startMs:100,endMs:500,text:'Synthetic'},{id:2,startMs:600,endMs:1000,text:'speech.'}]);assert.equal(verified.evidence.wordCount,4);assert.equal(verified.evidence.segmentCount,2);
}));
test('fractional producer times become integer app milliseconds while artifact bytes stay intact',async()=>using(async f=>{
 f.cached.segments[0].words[0].start=.123456;f.cached.segments[0].words[0].end=.456789;f.merged.words[0].start=.123456;f.merged.words[0].end=.456789;
 await f.save(f.cachedPath,f.cached);await f.save(f.mergedPath,f.merged);const before=await readFile(f.mergedPath),verified=await f.inspect();
 assert.equal(verified.segments[0].startMs,123);assert.equal(verified.segments[0].endMs,457);assert.equal(verified.evidence.appTimestampNormalization,'ROUND_TO_NEAREST_MILLISECOND');assert.equal(verified.evidence.originalArtifactTimesPreserved,true);assert.deepEqual(await readFile(f.mergedPath),before);assert.equal(f.merged.words[0].start,.123456);
}));
test('six-decimal producer EOF rounding permits only half a microsecond beyond measured samples',async()=>using(async f=>{
 const input=tone(32009),wav=inspectPcmWav(input),duration=wav.durationMs/1000;await writeFile(f.asrInputPath,input);
 f.manifest.config.source_sha256=sha(input);f.manifest.job_id=await producerManifestConfigDigest(Buffer.from(JSON.stringify(f.manifest)));
 f.manifest.sample_count=wav.sampleCount;f.manifest.duration_seconds=duration;
 Object.assign(f.manifest.chunks[0],{end:duration,core_end:duration,end_frame:wav.sampleCount,core_end_frame:wav.sampleCount});
 f.cached.job_id=f.manifest.job_id;f.cached.segments[0].end=duration;f.cached.segments[0].words[1].end=duration;
 f.merged.words[1].end=Math.round(duration*1000000)/1000000;
 await f.save(f.manifestPath,f.manifest);await f.save(f.cachedPath,f.cached);await f.save(f.mergedPath,f.merged);
 const verify=()=>verifyFasterWhisperArtifacts({manifestPath:f.manifestPath,mergedPath:f.mergedPath,asrInputSha256:sha(input),wav});
 const verified=await verify();assert.equal(wav.durationMs,2000.5625);assert.equal(verified.segments[1].endMs,2001);
 f.cached.segments[0].words[1].end=duration+.000001;await f.save(f.cachedPath,f.cached);
 await assert.rejects(verify(),{code:'ASR_WORD_OUTSIDE_INPUT'});
}));
test('edited reference-assisted text cannot silently replace actual merged ASR raw text',async()=>using(async f=>{
 f.merged.text='An edited invented reference.';await f.save(f.mergedPath,f.merged);await assert.rejects(f.inspect(),{code:'ASR_MERGED_RAW_MISMATCH'});
}));
test('out-of-input word times and claimed missing chunks fail closed',async()=>using(async f=>{
 f.cached.segments[0].words[0].end=5;await f.save(f.cachedPath,f.cached);await assert.rejects(f.inspect(),{code:'ASR_CHUNK_WORD_INVALID'});
 f.cached.segments[0].words[0].end=.5;await f.save(f.cachedPath,f.cached);f.merged.unprocessed_chunks=[1];await f.save(f.mergedPath,f.merged);await assert.rejects(f.inspect(),{code:'ASR_COVERAGE_RECEIPT_INVALID'});
}));
