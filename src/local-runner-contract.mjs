const idPattern=/^[A-Za-z0-9_-]{11}$/;
const hashPattern=/^[0-9a-f]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const sha256=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(byte=>byte.toString(16).padStart(2,'0')).join('');

export function canonicalYouTubeUrl(value){
 // Reject lexical traversal/control spellings before URL normalizes them away.
 if(typeof value!=='string'||!/^https:\/\/(?:youtu\.be\/[A-Za-z0-9_-]{11}|(?:www\.)?youtube\.com\/watch)(?:\?[^#\s\\]*)?$/i.test(value))fail('RUNNER_URL_INVALID');
 let url;try{url=new URL(value);}catch{fail('RUNNER_URL_INVALID');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)fail('RUNNER_URL_INVALID');
 const host=url.hostname.toLowerCase(),keys=[...url.searchParams.keys()];
 if(keys.some(key=>!['v','si'].includes(key))||url.searchParams.has('list')||url.searchParams.getAll('v').length>1||url.searchParams.getAll('si').length>1||host==='youtu.be'&&url.searchParams.has('v'))fail('RUNNER_URL_INVALID');
 const id=host==='youtu.be'&&/^\/[A-Za-z0-9_-]{11}$/.test(url.pathname)?url.pathname.slice(1):
  (host==='youtube.com'||host==='www.youtube.com')&&url.pathname==='/watch'?url.searchParams.get('v'):null;
 if(!idPattern.test(id||''))fail('RUNNER_URL_INVALID');
 return {videoId:id,url:`https://www.youtube.com/watch?v=${id}`};
}
export function checkPublicVideoMetadata(meta,expectedId){
 if(meta?.id!==expectedId||meta.is_live!==false||meta.live_status!=='not_live'||meta.availability!=='public'||meta._type==='playlist'||!Number.isFinite(meta.duration)||meta.duration<=0||meta.duration>7200)fail('RUNNER_VIDEO_NOT_ELIGIBLE');
 return {videoId:expectedId,durationSeconds:meta.duration};
}
export function validateAcquisitionManifest(manifest,{videoId,jobId}){
 const exact=(obj,allowed)=>obj&&Object.keys(obj).sort().join(',')===allowed.sort().join(',');
 if(!exact(manifest,['kind','jobId','requestId','videoId','canonicalUrl','method','ytDlpVersion','ffmpegVersion','fileSha256','fileBytes','durationSeconds','conversion','chunks'])||!exact(manifest.conversion,['audioChannels','sampleRate','format']))fail('RUNNER_MANIFEST_INVALID');
 if(!uuid.test(jobId||'')||!uuid.test(manifest?.requestId||'')||!idPattern.test(videoId||''))fail('RUNNER_MANIFEST_INVALID');
 if(manifest?.kind!=='LOCAL_AUDIO_ACQUISITION_V1'||manifest.videoId!==videoId||manifest.canonicalUrl!==`https://www.youtube.com/watch?v=${videoId}`||manifest.jobId!==jobId||manifest.method!=='YT_DLP_BESTAUDIO_FFMPEG'||!hashPattern.test(manifest.fileSha256||'')||!Number.isSafeInteger(manifest.fileBytes)||manifest.fileBytes<1||!Number.isFinite(manifest.durationSeconds)||manifest.durationSeconds<=0||manifest.durationSeconds>7200||typeof manifest.ytDlpVersion!=='string'||!/^\d{4}\.\d{2}\.\d{2}/.test(manifest.ytDlpVersion)||typeof manifest.ffmpegVersion!=='string'||!/^\d/.test(manifest.ffmpegVersion)||!Array.isArray(manifest.chunks)||!manifest.chunks.length||manifest.chunks.length>160)fail('RUNNER_MANIFEST_INVALID');
 let edge=0;for(const [index,chunk] of manifest.chunks.entries()){
  if(!exact(chunk,['index','start','end','sha256','bytes']))fail('RUNNER_MANIFEST_INVALID');
  if(chunk.index!==index||!Number.isFinite(chunk.start)||!Number.isFinite(chunk.end)||chunk.start<0||chunk.end<=chunk.start||chunk.end<=edge||chunk.end-chunk.start>601||chunk.start>edge+.1||chunk.start<Math.max(0,edge-5)||!hashPattern.test(chunk.sha256||'')||!Number.isSafeInteger(chunk.bytes)||chunk.bytes<1||chunk.bytes>8000000)fail('RUNNER_MANIFEST_INVALID');edge=chunk.end;
 }
 if(Math.abs(edge-manifest.durationSeconds)>2||manifest.conversion?.audioChannels!==1||manifest.conversion?.sampleRate!==16000||!['mp3','flac'].includes(manifest.conversion?.format))fail('RUNNER_MANIFEST_INVALID');
 return manifest;
}
export function assertBoundedAudioApproval(approval,{jobId,requestId,manifestSha256,sourceSha256,chunkHashes,provider,model,now=Date.now()}){
 const fields=['kind','jobId','requestId','manifestSha256','sourceSha256','chunkHashes','provider','model','maxCalls','maxMicroUsd','perCallMaxMicroUsd','expiresAt','maxRetries'];
 if(!approval||Object.keys(approval).sort().join(',')!==fields.sort().join(','))fail('RUNNER_BATCH_APPROVAL_INVALID');
 if(!uuid.test(jobId||'')||!uuid.test(requestId||'')||!hashPattern.test(manifestSha256||'')||!({groq:['whisper-large-v3','whisper-large-v3-turbo'],gemini:['gemini-2.5-flash']}[provider]||[]).includes(model)||!Number.isSafeInteger(approval?.perCallMaxMicroUsd)||approval.perCallMaxMicroUsd<0||approval.perCallMaxMicroUsd>approval.maxMicroUsd)fail('RUNNER_BATCH_APPROVAL_INVALID');
 if(approval?.kind!=='LOCAL_AUDIO_BATCH_APPROVAL_V1'||approval.jobId!==jobId||approval.requestId!==requestId||approval.provider!==provider||approval.model!==model||approval.manifestSha256!==manifestSha256||approval.sourceSha256!==sourceSha256||!hashPattern.test(sourceSha256||'')||JSON.stringify(approval.chunkHashes)!==JSON.stringify(chunkHashes)||!chunkHashes?.length||chunkHashes.some(hash=>!hashPattern.test(hash))||!Number.isSafeInteger(approval.maxCalls)||approval.maxCalls<1||approval.maxCalls>chunkHashes.length||!Number.isSafeInteger(approval.maxMicroUsd)||approval.maxMicroUsd<0||!Number.isSafeInteger(approval.expiresAt)||approval.expiresAt<=now||approval.expiresAt>now+3600000||approval.maxRetries!==0)fail('RUNNER_BATCH_APPROVAL_INVALID');
 return approval;
}
export function serializeBoundedAudioApproval(approval){
 const {kind,jobId,requestId,manifestSha256,sourceSha256,chunkHashes,provider,model,maxCalls,maxMicroUsd,perCallMaxMicroUsd,expiresAt,maxRetries}=approval;
 return JSON.stringify({kind,jobId,requestId,manifestSha256,sourceSha256,chunkHashes:[...chunkHashes],provider,model,maxCalls,maxMicroUsd,perCallMaxMicroUsd,expiresAt,maxRetries});
}

// Command descriptions only. The application does not invoke them automatically.
export function acquisitionCommands({url,workDir,videoId}){
 const canonical=canonicalYouTubeUrl(url);if(canonical.videoId!==videoId||typeof workDir!=='string'||!workDir||/[\r\n]/.test(workDir))fail('RUNNER_PATH_INVALID');
 return [
  {executable:'yt-dlp',args:['--no-playlist','--no-config','--skip-download','--dump-single-json',canonical.url]},
  {executable:'yt-dlp',args:['--no-playlist','--no-config','-f','bestaudio','--print','after_move:filepath','-o',`${workDir}/source.%(ext)s`,canonical.url]}
 ];
}
