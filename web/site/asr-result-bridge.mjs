import {capacityReady} from './audio-runner.mjs';

// Existing-owner HTTP flow only. No worker credentials, media acquisition or ASR
// execution is provided here. Selected result bytes remain in this view's memory.
export const ASR_RESULT_MAX_BYTES=2_000_000;
export const ASR_TRANSCRIPT_MAX_BYTES=1_500_000;
const profile='approved-four-part-v1',provenance='OWNER_SUBMITTED_LOCAL_ASR';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,sha=/^[a-f0-9]{64}$/;
const encoder=new TextEncoder();
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof text==='string'?encoder.encode(text):text)),byte=>byte.toString(16).padStart(2,'0')).join('');
const problem=message=>new Error(message);
const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const normalizedSegments=segments=>segments.map((segment,index)=>({id:index+1,startMs:Number.isFinite(segment.startMs)?segment.startMs:null,endMs:Number.isFinite(segment.endMs)?segment.endMs:null,text:String(segment.text).replace(/\s+/g,' ').trim()})).filter(segment=>segment.text);
const inputSegments=segments=>segments.map(({id,startMs,endMs,text})=>({id,startMs,endMs,text}));
const normalizedSourceDigest=source=>digest(JSON.stringify({raw:source.raw,segments:normalizedSegments(source.segments),provenance}));
const activeStates=['WAITING_FOR_WORKER','SOURCE_BOUND'];
const states=['NO_REQUEST','WAITING_FOR_WORKER','SOURCE_BOUND','RESULT_STORED','CANCELLED','EXPIRED','SOURCE_REVIEW_REQUIRED'];
const phases=['LOADING','CREATING','PREPARING','BINDING','SAVING','CANCELLING','VERIFYING','PLANNING','EXECUTING'];
const boundedText=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max;

function sourceMatches(source,status){return !!source&&source.jobId===status.jobId&&source.requestId===status.requestId&&source.jobSourceSha256===status.jobSourceSha256&&status.source&&canonical(source)===canonical(status.source)&&sha.test(status.sourceBindingSha256??'');}
function statusIsValid(status,jobId){
 return status?.kind==='ASR_RESULT_BRIDGE_STATUS_V1'&&status.jobId===jobId&&typeof status.eligible==='boolean'&&['OWNED_AUDIO','URL_NO_CAPTIONS',null].includes(status.sourceKind??null)&&sha.test(status.jobSourceSha256??'')&&status.workerConnected===false&&status.executionAvailable===false&&typeof status.transferAvailable==='boolean'&&states.includes(status.state)&&typeof status.transcriptStored==='boolean'&&status.sourceAccuracy==='UNVERIFIED'&&status.summaryComplete===false&&status.providerCalls===0&&(status.state==='NO_REQUEST'?status.requestId===null&&status.revision===null:uuid.test(status.requestId??'')&&Number.isSafeInteger(status.revision)&&status.revision>0&&Number.isSafeInteger(status.expiresAt));
}
function contextForDownload(status){
 const context=status?.context,identity=context?.sourceIdentity;
 if(!context||context.kind!=='ASR_RESULT_BRIDGE_CONTEXT_V1'||context.jobId!==status.jobId||context.requestId!==status.requestId||context.jobSourceSha256!==status.jobSourceSha256||context.revision!==status.revision||context.expiresAt!==status.expiresAt||(status.sourceKind!==null&&context.sourceKind!==status.sourceKind)||!Number.isFinite(context.declaredDurationMs)||context.declaredDurationMs<=0)throw problem('현재 요청 파일의 분석·입력 연결을 확인하지 못했습니다. 상태를 다시 조회하세요.');
 let sourceIdentity;
 if(context.sourceKind==='OWNED_AUDIO'&&identity?.kind==='OWNED_AUDIO'&&sha.test(identity.originalAudioSha256??''))sourceIdentity={kind:'OWNED_AUDIO',originalAudioSha256:identity.originalAudioSha256};
 else if(context.sourceKind==='URL_NO_CAPTIONS'&&identity?.kind==='YOUTUBE_ACQUISITION'&&/^[A-Za-z0-9_-]{11}$/.test(identity.videoId??'')&&identity.canonicalUrl==='https://www.youtube.com/watch?v='+identity.videoId)sourceIdentity={kind:'YOUTUBE_ACQUISITION',videoId:identity.videoId,canonicalUrl:identity.canonicalUrl};
 else throw problem('현재 요청 파일의 음성 출처를 확인하지 못했습니다.');
 return {kind:context.kind,jobId:context.jobId,requestId:context.requestId,jobSourceSha256:context.jobSourceSha256,sourceKind:context.sourceKind,declaredDurationMs:context.declaredDurationMs,revision:context.revision,expiresAt:context.expiresAt,sourceIdentity};
}

export async function prepareAsrResultFile(file,{jobId,requestId,jobSourceSha256,context}={}){
 if(!file||typeof file.name!=='string'||!/\.json$/i.test(file.name)||typeof file.arrayBuffer!=='function'||!Number.isSafeInteger(file.size)||file.size<1||file.size>ASR_RESULT_MAX_BYTES)throw problem('2,000,000바이트 이하 UTF-8 JSON 결과 파일을 선택하세요.');
 const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.byteLength!==file.size||bytes.byteLength>ASR_RESULT_MAX_BYTES)throw problem('선택한 파일의 크기가 바뀌었거나 UTF-8 용량 제한을 넘었습니다.');
 let text,document;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);document=JSON.parse(text);}catch{throw problem('올바른 UTF-8 JSON 결과 파일이 필요합니다.');}
 if(!document||Array.isArray(document)||Object.keys(document).sort().join(',')!=='result,source')throw problem('source와 result를 포함한 오프라인 결과 전달 파일이 필요합니다.');
 const {source,result}=document;
 if(!exact(source,['kind','jobId','requestId','jobSourceSha256','sourceIdentity','originalAudio','asrInput'])||!exact(result,['kind','jobId','requestId','revision','jobSourceSha256','sourceBindingSha256','originalAudioSha256','asrInputSha256','asrPcmSha256','transcript','engine','confirmOwnerSubmitted','confirmNoProviderCall']))throw problem('전사 전달 파일에 지원하지 않는 필드가 있거나 필요한 항목이 빠졌습니다.');
 if(!uuid.test(jobId??'')||!uuid.test(requestId??'')||!sha.test(jobSourceSha256??'')||source?.kind!=='OWNER_SUBMITTED_ASR_SOURCE_V1'||result?.kind!=='OWNER_SUBMITTED_LOCAL_ASR_RESULT_V1'||source.jobId!==jobId||result.jobId!==jobId||source.requestId!==requestId||result.requestId!==requestId||source.jobSourceSha256!==jobSourceSha256||result.jobSourceSha256!==jobSourceSha256)throw problem('결과 파일의 분석·요청·입력 연결이 현재 작업과 다릅니다.');
 const original=source.originalAudio,input=source.asrInput,identity=source.sourceIdentity;
 if(!exact(original,['sha256','bytes','durationMs','startTimeMs','measurement','measurementSha256'])||!exact(input,['sha256','pcmSha256','bytes','durationMs','measurement','measurementSha256','sampleRate','channels','sampleCount','format','timeOrigin'])||!(identity?.kind==='OWNED_AUDIO'?exact(identity,['kind','originalAudioSha256']):exact(identity,['kind','videoId','canonicalUrl','officialDurationMs','metadataSha256'])))throw problem('원음·ASR 입력의 메타데이터 형식이 맞지 않습니다.');
 if(!original||!input||!sha.test(original.sha256??'')||!sha.test(input.sha256??'')||!sha.test(input.pcmSha256??'')||!sha.test(original.measurementSha256??'')||!sha.test(input.measurementSha256??'')||original.measurement!=='FFPROBE'||input.measurement!=='PCM_SAMPLE_COUNT'||!Number.isSafeInteger(original.bytes)||original.bytes<1||!Number.isSafeInteger(input.bytes)||input.bytes<1||!Number.isFinite(original.durationMs)||original.durationMs<=0||!Number.isFinite(input.durationMs)||input.durationMs<=0||!(original.startTimeMs===null||Number.isFinite(original.startTimeMs))||input.sampleRate!==16000||input.channels!==1||!Number.isSafeInteger(input.sampleCount)||input.sampleCount<1||input.format!=='WAV_PCM_S16LE'||input.timeOrigin!=='NORMALIZED_AUDIO_FRAME_ZERO')throw problem('원음·ASR 입력의 해시와 측정 길이 정보가 완전하지 않습니다.');
 if(context?.sourceKind==='OWNED_AUDIO'&&(identity?.kind!=='OWNED_AUDIO'||identity.originalAudioSha256!==context.sourceIdentity?.originalAudioSha256||original.sha256!==identity.originalAudioSha256))throw problem('선택한 결과의 원음 해시가 이 분석의 보유 음성과 다릅니다.');
 if(context?.sourceKind==='URL_NO_CAPTIONS'&&(identity?.kind!=='YOUTUBE_ACQUISITION'||identity.videoId!==context.sourceIdentity?.videoId||identity.canonicalUrl!==context.sourceIdentity?.canonicalUrl||!Number.isFinite(identity.officialDurationMs)||identity.officialDurationMs<=0||!sha.test(identity.metadataSha256??'')))throw problem('오프라인 취득 결과의 영상 연결과 메타데이터 근거를 확인하세요.');
 if(result.originalAudioSha256!==original.sha256||result.asrInputSha256!==input.sha256||result.asrPcmSha256!==input.pcmSha256||result.confirmOwnerSubmitted!==true||result.confirmNoProviderCall!==true||!(result.revision===null||Number.isSafeInteger(result.revision)&&result.revision>=0)||!(result.sourceBindingSha256===null||sha.test(result.sourceBindingSha256??'')))throw problem('결과와 음성 입력의 해시 연결 또는 외부 결과 출처 표시가 일치하지 않습니다.');
 const transcript=result.transcript,engine=result.engine;
 if(!exact(transcript,['raw','segments','rawSha256','segmentsSha256'])||!exact(engine,['name','model','version','device','computeType'])||!Array.isArray(transcript.segments)||transcript.segments.some(segment=>!exact(segment,['id','startMs','endMs','text'])))throw problem('전사 원문·구간·엔진 정보의 형식이 맞지 않습니다.');
 if(!transcript||typeof transcript.raw!=='string'||!transcript.raw.trim()||!Array.isArray(transcript.segments)||!transcript.segments.length||transcript.segments.length>20000||transcript.segments.some((segment,index)=>!segment||segment.id!==index+1||typeof segment.text!=='string'||!segment.text.trim()||!Number.isSafeInteger(segment.startMs)||segment.startMs<0||!Number.isSafeInteger(segment.endMs)||segment.endMs<segment.startMs||segment.endMs>Math.round(input.durationMs)||index>0&&segment.startMs<transcript.segments[index-1].startMs)||new Set(transcript.segments.map(segment=>segment.id)).size!==transcript.segments.length||!sha.test(transcript.rawSha256??'')||!sha.test(transcript.segmentsSha256??'')||engine?.name!=='faster-whisper'||engine.device!=='cpu'||!boundedText(engine.model,160)||!boundedText(engine.computeType,80)||!(engine.version===null||boundedText(engine.version,160)))throw problem('전사 구간·해시·외부 ASR 엔진 정보가 올바르지 않습니다.');
 const normalized=normalizedSegments(transcript.segments);
 if(encoder.encode(transcript.raw).length+encoder.encode(JSON.stringify(normalized)).length>ASR_TRANSCRIPT_MAX_BYTES)throw problem('원문과 정리된 전사 구간은 UTF-8 합계 1,500,000바이트 이하여야 합니다.');
 if(transcript.raw.replace(/\s+/g,' ').trim()!==transcript.segments.map(segment=>segment.text).join(' ').replace(/\s+/g,' ').trim())throw problem('전사 원문과 구간별 텍스트의 내용이 다릅니다.');
 if(await digest(transcript.raw)!==transcript.rawSha256||await digest(JSON.stringify(inputSegments(transcript.segments)))!==transcript.segmentsSha256)throw problem('선택한 결과 파일의 원문 또는 구간 해시가 일치하지 않습니다.');
 return {source:clone(source),result:clone(result),fileSha256:await digest(bytes),fileBytes:bytes.byteLength,normalizedSourceSha256:await normalizedSourceDigest(transcript)};
}

function validReceipt(receipt,status){return receipt&&receipt.kind==='OWNER_SUBMITTED_LOCAL_ASR_RECEIPT_V1'&&receipt.jobId===status.jobId&&receipt.requestId===status.requestId&&receipt.revision===status.revision&&receipt.provenance===provenance&&receipt.sourceAccuracy==='UNVERIFIED'&&receipt.identityVerification==='OWNER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED'&&['submittedBodySha256','rawSha256','segmentsSha256','normalizedSourceSha256','sourceBindingSha256','originalAudioSha256','asrInputSha256','asrPcmSha256'].every(key=>sha.test(receipt[key]??''))&&receipt.sourceBindingSha256===status.sourceBindingSha256&&receipt.originalAudioSha256===status.source?.originalAudio?.sha256&&receipt.asrInputSha256===status.source?.asrInput?.sha256&&receipt.asrPcmSha256===status.source?.asrInput?.pcmSha256&&Number.isSafeInteger(receipt.segmentCount)&&receipt.segmentCount>0;}
function approvedSummaryValid(result,jobId){
 const job=result?.job,report=job?.report,approved=report?.approvedSummary,view=job?.approvedSummaryView;
 const matches=result?.cached===true?result.requestedFormatProfile===profile&&result.storedFormatProfile===profile:result?.formatProfile===profile;
 return result?.formatMismatch!==true&&result?.persisted===true&&job?.id===jobId&&matches&&report?.kind==='GEMINI_EVIDENCE_LINKED'&&approved?.formatVersion===profile&&approved.structuralValidation==='REFERENCES_QUOTES_LINKS_ONLY'&&approved.semanticReview==='NOT_PERFORMED'&&approved.sourceBinding?.kind==='EXACT_TRANSCRIPT_SEGMENTS_V1'&&sha.test(approved.sourceBinding.segmentsSha256??'')&&view?.formatVersion===profile&&view.origin==='APPROVED_STRUCTURED'&&view.sourceStatus==='MATCHED'&&view.semanticReview==='NOT_PERFORMED'&&Array.isArray(view.sources)&&view.sources.length>0;
}

export function createAsrResultBridgeController({jobId,api,isCurrent=()=>true,onChange=()=>{},onReport=()=>{},storage,randomUUID=()=>crypto.randomUUID(),now=Date.now}){
 if(!uuid.test(jobId??'')||typeof api!=='function')throw problem('전사 결과를 연결할 분석을 확인하세요.');
 const root='/api/jobs/'+encodeURIComponent(jobId),journalKey='asr-result-request-v1:'+jobId;
 let state={phase:'IDLE',status:null,draft:null,verifiedJob:null,summaryPlan:null,message:'오디오 요청 상태를 확인하세요.'},prepared=null,version=0,operation=null,boundFileSha256=null;
 const snapshot=()=>clone(state),busy=()=>phases.includes(state.phase);
 const update=patch=>{state={...state,...patch};if(isCurrent())onChange(snapshot());};
 const fresh=async()=>{const response=await api(root+'/audio-request');if(!statusIsValid(response,jobId))throw problem('서버의 오디오 요청 상태와 대상 분석을 확인하지 못했습니다.');return response;};
 const expired=status=>!Number.isSafeInteger(status.expiresAt)||status.expiresAt<=now();
 const getStorage=()=>storage??globalThis.sessionStorage;
 const journal=()=>{let value;try{value=JSON.parse(getStorage().getItem(journalKey)||'null');}catch{throw problem('브라우저 임시 저장소를 확인할 수 없어 새 오디오 요청을 보내지 않았습니다.');}if(value&&(!uuid.test(value.requestId??'')||!sha.test(value.jobSourceSha256??'')||!['PREPARED','SENT','CONFIRMED','UNKNOWN'].includes(value.state)))throw problem('이전 오디오 요청 식별자를 확인하지 못했습니다. 상태를 먼저 조회하세요.');return value;};
 const keep=value=>{try{getStorage().setItem(journalKey,JSON.stringify(value));}catch{throw problem('요청 식별자를 브라우저에 보존할 수 없어 새 오디오 요청을 보내지 않았습니다.');}};
 const exclusive=work=>{if(operation||busy()||!isCurrent())return operation??Promise.resolve(snapshot());operation=Promise.resolve().then(work).finally(()=>{operation=null;});return operation;};
 function accept(status){
  if(prepared&&(prepared.source.requestId!==status.requestId||prepared.source.jobSourceSha256!==status.jobSourceSha256)){prepared=null;boundFileSha256=null;state={...state,draft:null,summaryPlan:null,verifiedJob:null};version++;}
  update({status});
 }
 async function recover(message){
  if(!isCurrent())return;update({phase:'UNKNOWN',summaryPlan:null,message:message+' 자동 재전송하지 않습니다. 상태를 조회합니다.'});
  try{const status=await fresh();if(!isCurrent())return;accept(status);update({phase:'IDLE',message:message+' 현재 저장 상태를 다시 확인했습니다. 다음 단계는 직접 선택하세요.'});}catch{if(isCurrent())update({phase:'UNKNOWN',message:message+' 상태 조회도 확인되지 않았습니다. 새 요청을 만들지 말고 다시 조회하세요.'});}
 }
 async function verifySource(){
  const status=await fresh();if(!isCurrent())return null;accept(status);
  if(status.state!=='RESULT_STORED'||status.transcriptStored!==true||status.sourceBinding!=='MATCHED_OWNER_SUBMITTED_SOURCE'||!validReceipt(status.receipt,status))throw problem('저장된 전사와 음성 연결 영수증을 확인하지 못했습니다.');
  const [detail,found]=await Promise.all([api(root),api(root+'/source')]);if(!isCurrent())return null;
  const context=contextForDownload(status),expectedType=context.sourceKind==='OWNED_AUDIO'?'audio':'url',job=detail.job,source=found.source;
  const audit=job?.audit?.localAsrReceipt;
  if(audit?.requestId!==status.requestId||audit.sourceBindingSha256!==status.sourceBindingSha256||audit.submittedBodySha256!==status.receipt.submittedBodySha256||audit.normalizedSourceSha256!==status.receipt.normalizedSourceSha256||audit.provenance!==provenance||audit.sourceAccuracy!=='UNVERIFIED'||audit.inputProcessingCoverage!=='NOT_INDEPENDENTLY_VERIFIED'||audit.summaryGenerated!==false||audit.receiptSha256!==await digest(JSON.stringify(status.receipt)))throw problem('현재 분석에 저장된 전사 수신 기록의 무결성을 확인하지 못했습니다.');
  if(job?.id!==jobId||(job.source_type??job.source)!==expectedType||Number(job.duration_seconds??job.durationSeconds)*1000!==status.context?.declaredDurationMs||source?.provenance!==provenance||typeof source.raw!=='string'||!Array.isArray(source.segments)||source.segments.length!==status.receipt.segmentCount||await normalizedSourceDigest(source)!==status.receipt.normalizedSourceSha256||await digest(source.raw)!==status.receipt.rawSha256)throw problem('저장된 원문의 대상·내용·해시를 확인하지 못했습니다. 요약은 시작하지 않았습니다.');
  if(prepared&&(status.receipt.rawSha256!==prepared.result.transcript.rawSha256||status.receipt.segmentsSha256!==prepared.result.transcript.segmentsSha256||status.receipt.normalizedSourceSha256!==prepared.normalizedSourceSha256))throw problem('저장된 전사는 현재 선택한 결과 파일과 다릅니다. 기존 원문을 보존하고 확인하세요.');
  const after=await fresh();if(!isCurrent())return null;
  if(after.state!=='RESULT_STORED'||after.requestId!==status.requestId||after.revision!==status.revision||after.jobSourceSha256!==status.jobSourceSha256||canonical(after.receipt)!==canonical(status.receipt))throw problem('원문 조회 중 요청 상태가 바뀌었습니다. 다시 확인하세요.');
  accept(after);update({verifiedJob:job});return {status:after,job,source};
 }
 const load=()=>exclusive(async()=>{update({phase:'LOADING',summaryPlan:null,message:'현재 오디오 요청 상태를 읽는 중입니다…'});try{const status=await fresh();if(!isCurrent())return snapshot();accept(status);update({phase:'IDLE',message:'저장된 상태를 확인했습니다. 워커는 연결되지 않았으며 자동 실행은 시작하지 않습니다.'});}catch(error){if(isCurrent())update({phase:'UNKNOWN',status:null,message:error.message});}return snapshot();});
 const request=({rightsConfirmed=false}={})=>exclusive(async()=>{
  if(rightsConfirmed!==true){update({message:'음성 처리 권한과 요청 기록만 생성한다는 범위를 확인하세요.'});return snapshot();}
  update({phase:'CREATING',summaryPlan:null,message:'현재 분석과 기존 요청을 확인 중입니다…'});
  try{const status=await fresh();if(!isCurrent())return snapshot();accept(status);
   if(!['NO_REQUEST','CANCELLED','EXPIRED'].includes(status.state)){update({phase:'IDLE',message:'기존 요청이 있습니다. 같은 요청의 상태를 확인하며 새 작업을 만들지 않습니다.'});return snapshot();}
   if(status.canRequest!==true||!status.eligible||!status.transferAvailable)throw problem('현재 분석은 오디오 요청을 생성할 수 없습니다. 기존 원문과 실행 상태를 확인하세요.');
   let entry=journal();if(['CANCELLED','EXPIRED'].includes(status.state)){if(entry&&entry.requestId!==status.requestId)throw problem('브라우저의 미확정 요청과 서버의 현재 요청이 다릅니다. 기존 상태를 확인하세요.');entry=null;}if(entry&&entry.state!=='PREPARED')throw problem('이전 요청 생성 결과가 불명확합니다. 보존된 요청의 상태를 먼저 확인하세요.');
   if(entry&&entry.jobSourceSha256!==status.jobSourceSha256)throw problem('이전 요청의 입력 연결이 달라졌습니다. 새 요청으로 대체하지 않았습니다.');
   entry??={requestId:randomUUID(),jobSourceSha256:status.jobSourceSha256,state:'PREPARED'};if(!uuid.test(entry.requestId)||entry.requestId===status.requestId)throw problem('새 요청 식별자를 확인하지 못했습니다.');keep(entry);entry={...entry,state:'SENT'};keep(entry);
   if(!isCurrent())return snapshot();await api(root+'/audio-request',{method:'POST',body:{requestId:entry.requestId,jobSourceSha256:entry.jobSourceSha256,rightsConfirmed:true,confirmLocalOnly:true}});if(!isCurrent())return snapshot();
   const saved=await fresh();if(!isCurrent())return snapshot();if(saved.requestId!==entry.requestId||saved.jobSourceSha256!==entry.jobSourceSha256||!['WAITING_FOR_WORKER','SOURCE_BOUND','RESULT_STORED'].includes(saved.state))throw problem('생성 요청의 저장 대상을 확인하지 못했습니다.');accept(saved);keep({...entry,state:'CONFIRMED'});update({phase:'IDLE',message:'오디오 요청 기록을 확인했습니다. 요청 생성은 워커 연결이나 음성 취득·전사 실행의 증거가 아닙니다.'});
  }catch(error){await recover(error.message);}return snapshot();
 });
 async function prepare(file){
  if(!isCurrent()||busy()||operation)return snapshot();const own=++version;prepared=null;boundFileSha256=null;update({phase:'PREPARING',draft:null,summaryPlan:null,message:'결과 파일의 UTF-8 용량과 분석·원음·전사 연결을 확인 중입니다…'});
  try{const status=await fresh();if(!isCurrent()||own!==version)return snapshot();accept(status);if(!activeStates.includes(status.state)&&status.state!=='RESULT_STORED')throw problem('먼저 오디오 요청을 생성하고 현재 요청 파일로 준비한 결과를 선택하세요.');const context=contextForDownload(status),value=await prepareAsrResultFile(file,{jobId,requestId:status.requestId,jobSourceSha256:status.jobSourceSha256,context});if(!isCurrent()||own!==version)return snapshot();prepared=value;update({phase:'IDLE',draft:{source:value.source,fileSha256:value.fileSha256,fileBytes:value.fileBytes,segmentCount:value.result.transcript.segments.length,raw:value.result.transcript.raw,engine:value.result.engine},message:'소유자가 제출한 외부 로컬 ASR 결과입니다. 앱의 워커 생성 증거나 전사 정확성 검증으로 간주하지 않습니다.'});}
  catch(error){if(isCurrent()&&own===version)update({phase:'IDLE',draft:null,message:error.message});}return snapshot();
 }
 const bind=({ownerConfirmed=false}={})=>exclusive(async()=>{
  if(!prepared||ownerConfirmed!==true){update({message:'결과 파일과 이 분석의 원음 연결을 확인해야 합니다.'});return snapshot();}const file=prepared,own=version;update({phase:'BINDING',summaryPlan:null,message:'현재 요청과 원음 메타데이터를 대조 중입니다…'});
  try{let status=await fresh();if(!isCurrent()||own!==version)return snapshot();accept(status);if(prepared!==file||status.canBind!==true||!status.eligible||status.requestId!==file.source.requestId||status.jobSourceSha256!==file.source.jobSourceSha256||!activeStates.includes(status.state)||expired(status))throw problem('요청이 만료·취소되었거나 입력이 바뀌었습니다. 음성 연결을 등록하지 않았습니다.');
   if(status.state==='WAITING_FOR_WORKER'){await api(root+'/audio-request-bind',{method:'POST',body:{requestId:status.requestId,revision:status.revision,jobSourceSha256:status.jobSourceSha256,source:file.source,confirmSourceBinding:true,confirmNoProviderCall:true}});if(!isCurrent()||own!==version)return snapshot();status=await fresh();}
   if(!isCurrent()||own!==version)return snapshot();if(status.state!=='SOURCE_BOUND'||!sourceMatches(file.source,status))throw problem('등록된 음성과 선택한 결과 파일의 연결이 일치하지 않습니다.');accept(status);boundFileSha256=file.fileSha256;update({phase:'IDLE',message:'소유자 제출 음성 메타데이터의 연결을 확인했습니다. 실제 워커 생성·원음 정확성의 독립 검증은 아닙니다. 전사 수신은 별도로 선택하세요.'});
  }catch(error){boundFileSha256=null;await recover(error.message);}return snapshot();
 });
 const receive=({ownerConfirmed=false}={})=>exclusive(async()=>{
  if(!prepared||boundFileSha256!==prepared.fileSha256||ownerConfirmed!==true){update({message:'음성 연결 확인과 외부 ASR 결과 수신 동의가 필요합니다.'});return snapshot();}const file=prepared,own=version;update({phase:'SAVING',summaryPlan:null,message:'현재 음성 연결을 확인하고 전사 결과를 수신 중입니다…'});
  try{const status=await fresh();if(!isCurrent()||own!==version)return snapshot();accept(status);if(prepared!==file||status.canReceive!==true||!status.eligible||status.state!=='SOURCE_BOUND'||expired(status)||!sourceMatches(file.source,status))throw problem('현재 요청·음성 연결이 달라졌거나 만료되었습니다. 전사를 전송하지 않았습니다.');
   const result={...file.result,revision:status.revision,sourceBindingSha256:status.sourceBindingSha256};
   await api(root+'/asr-result',{method:'POST',body:result});if(!isCurrent()||own!==version)return snapshot();
   const stored=await verifySource();if(!stored)return snapshot();onReport(stored.job,{persisted:true,transcriptOnly:true});update({phase:'IDLE',message:'외부 로컬 ASR 전사의 저장과 해시 연결을 확인했습니다. 음성 정확성은 미검증이며 요약을 자동으로 시작하지 않았습니다.'});
  }catch(error){await recover(error.message);}return snapshot();
 });
 const cancel=({confirmed=false}={})=>exclusive(async()=>{
  if(confirmed!==true){update({message:'현재 오디오 요청의 취소 범위를 확인하세요.'});return snapshot();}update({phase:'CANCELLING',summaryPlan:null,message:'현재 요청의 취소 가능 상태를 확인 중입니다…'});
  try{const status=await fresh();if(!isCurrent())return snapshot();accept(status);if(status.canCancel!==true)throw problem('현재 요청은 취소 대상이 아닙니다. 저장된 전사와 기존 기록은 유지됩니다.');
   await api(root+'/audio-request-cancel',{method:'POST',body:{requestId:status.requestId,revision:status.revision,confirmCancel:true}});if(!isCurrent())return snapshot();const saved=await fresh();if(!isCurrent())return snapshot();if(saved.requestId!==status.requestId||saved.jobSourceSha256!==status.jobSourceSha256||saved.state!=='CANCELLED')throw problem('취소가 확정되었는지 확인하지 못했습니다.');accept(saved);prepared=null;boundFileSha256=null;version++;update({phase:'IDLE',draft:null,verifiedJob:null,message:'현재 요청의 취소 상태를 확인했습니다. 기존 전사·요약·공급자 기록은 삭제하지 않았습니다.'});
  }catch(error){await recover(error.message);}return snapshot();
 });
 const checkSource=()=>exclusive(async()=>{update({phase:'VERIFYING',summaryPlan:null,message:'저장된 분석과 전사 원문을 다시 확인 중입니다…'});try{const stored=await verifySource();if(stored){onReport(stored.job,{persisted:true,transcriptOnly:true});update({phase:'IDLE',message:'저장된 전사와 음성 연결을 확인했습니다. 자동 음성 취득 또는 정확성 검증 완료를 뜻하지 않습니다.'});}}catch(error){if(isCurrent())update({phase:'IDLE',verifiedJob:null,message:error.message});}return snapshot();});
 const planSummary=()=>exclusive(async()=>{update({phase:'PLANNING',summaryPlan:null,message:'저장된 원문과 승인 형식의 요약 계획을 확인 중입니다…'});try{const stored=await verifySource();if(!stored)return snapshot();if(stored.job.report){onReport(stored.job,{persisted:true,existing:true});update({phase:'IDLE',message:'기존 저장 보고서를 열었습니다. 새 요약 생성 요청은 보내지 않았습니다.'});return snapshot();}
   const plan=await api(root+'/summary-plan?formatProfile='+profile);if(!isCurrent())return snapshot();if(plan.formatProfile!==profile||!Number.isSafeInteger(plan.firstPassUnits)||plan.firstPassUnits<1||!Number.isSafeInteger(plan.stages)||plan.stages<1)throw problem('승인한 형식과 정확히 일치하는 요약 계획을 확인하지 못했습니다.');
   update({phase:'IDLE',summaryPlan:{...plan,jobSourceSha256:stored.status.jobSourceSha256,requestId:stored.status.requestId,normalizedSourceSha256:stored.status.receipt.normalizedSourceSha256},message:'계획만 조회했습니다. 최신 무료 승인·용량을 확인한 뒤 명시적으로 한 단계를 실행할 수 있습니다.'});
  }catch(error){if(isCurrent())update({phase:'IDLE',summaryPlan:null,message:error.message});}return snapshot();});
 const executeSummary=({confirmed=false}={})=>exclusive(async()=>{
  const reviewed=state.summaryPlan;if(!reviewed||confirmed!==true){update({message:'현재 요약 계획과 한 단계 실행 범위를 확인하세요.'});return snapshot();}update({phase:'EXECUTING',message:'현재 전사·요약 계획과 무료 실행 조건을 다시 확인 중입니다…'});
  try{const stored=await verifySource();if(!stored)return snapshot();if(stored.job.report){onReport(stored.job,{persisted:true,existing:true});update({phase:'IDLE',summaryPlan:null,message:'기존 저장 보고서를 열었습니다. 새 요약을 생성하지 않았습니다.'});return snapshot();}
   if(stored.status.jobSourceSha256!==reviewed.jobSourceSha256||stored.status.requestId!==reviewed.requestId||stored.status.receipt.normalizedSourceSha256!==reviewed.normalizedSourceSha256)throw problem('검토한 요약 계획 이후 전사 연결이 달라졌습니다. 계획을 다시 확인하세요.');
   const plan=await api(root+'/summary-plan?formatProfile='+profile);if(!isCurrent())return snapshot();if(plan.formatProfile!==profile||plan.firstPassUnits!==reviewed.firstPassUnits||plan.stages!==reviewed.stages||plan.segmentCount!==reviewed.segmentCount)throw problem('요약 계획이 변경되었습니다. 새 계획을 별도로 확인하세요.');
   const [progress,capacity,quota]=await Promise.all([api(root+'/audio-progress'),api('/api/live/capacity'),api('/api/live/quota')]);if(!isCurrent())return snapshot();
   if(!capacityReady('gemini',0,capacity.snapshots??[],quota.grants??[],now())||progress.operationInFlight?.gemini||(Number.isFinite(progress.nextEligibleAt?.gemini)&&progress.nextEligibleAt.gemini>now()))throw problem('현재 무료 승인·용량 또는 진행 중인 요청·대기 시각을 먼저 확인하세요. 공급자 요청을 보내지 않았습니다.');
   const result=await api(root+'/summary',{method:'POST',body:{formatProfile:profile,allowStaged:plan.firstPassUnits>250000}});if(!isCurrent())return snapshot();
   if(result.job?.id!==jobId||result.persisted!==true)throw problem('요약 응답의 대상과 저장 여부를 확인하지 못했습니다.');
   if(result.pending){if(result.formatProfile!==profile)throw problem('저장된 요약 단계의 형식을 확인하지 못했습니다.');onReport(result.job,{persisted:true,pending:true});update({phase:'IDLE',summaryPlan:null,message:'요약 중간 단계가 저장되었습니다. 대기 시각을 확인한 뒤 다음 계획과 한 단계 실행을 직접 선택하세요. 자동 반복 실행은 없습니다.'});return snapshot();}
   if(result.formatMismatch&&result.cached===true&&result.requestedFormatProfile===profile){onReport(result.job,{persisted:true,existing:true,formatMismatch:true});update({phase:'IDLE',summaryPlan:null,message:'기존 저장 보고서를 보존해 열었습니다. 승인한 새 형식으로 생성된 결과는 아닙니다.'});return snapshot();}
   if(!approvedSummaryValid(result,jobId))throw problem('요약의 승인 형식·저장·현재 전사 연결을 모두 확인하지 못했습니다. 완료로 판정하지 않습니다.');
   onReport(result.job,{persisted:true,existing:result.cached===true});update({phase:'IDLE',summaryPlan:null,message:result.cached?'저장된 승인 형식 보고서를 열었습니다. 새로 생성하지 않았습니다.':'승인 형식 요약의 저장과 현재 전사 연결을 확인했습니다. 원음 정확성·의미 품질·외부 사실은 별도 검토가 필요합니다.'});
  }catch(error){if(isCurrent())update({phase:'IDLE',summaryPlan:null,message:error.message+' 자동 재전송하지 않습니다. 저장된 보고서를 다시 조회하세요.'});}return snapshot();
 });
 function clearFile(){if(operation||busy()||!isCurrent())return;version++;prepared=null;boundFileSha256=null;update({draft:null,summaryPlan:null,message:'파일 선택을 해제했습니다. 저장된 요청·원문은 변경하지 않았습니다.'});}
 return {load,request,prepare,bind,receive,cancel,checkSource,planSummary,executeSummary,clearFile,getState:snapshot,canReceive:()=>!!prepared&&boundFileSha256===prepared.fileSha256,downloadContext:()=>{if(!isCurrent()||!state.status||!activeStates.includes(state.status.state)||expired(state.status))throw problem('유효한 대기 요청의 상태를 확인한 뒤 요청 파일을 받으세요.');return contextForDownload(state.status);}};
}

function downloadJson(value){const blob=new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='audio-request-context.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function mountAsrResultBridge({host,jobId,api,isCurrent=()=>true,onReport=()=>{},document:dom=globalThis.document,storage,download=downloadJson,now=Date.now}){
 const element=(tag,text,className)=>{const node=dom.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 const heading=element('h3','오디오 요청·외부 ASR 결과 연결'),intro=element('p','요청 기록과 소유자가 제출한 로컬 ASR 결과를 연결합니다. 실제 음성 취득 워커는 연결되지 않았으며 이 화면은 ASR이나 유료 호출을 시작하지 않습니다.','tip');
 const message=element('p'),status=element('p'),measurement=element('p'),actions=element('div',undefined,'library-actions');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
 const refresh=element('button','상태 다시 조회','btn secondary small'),request=element('button','오디오 요청 기록 만들기','btn secondary small'),context=element('button','오디오 작업 요청 파일 받기','btn secondary small'),cancel=element('button','현재 오디오 요청 취소','btn secondary small');
 const rights=element('input');rights.type='checkbox';const rightsLabel=element('label','이 음성을 처리할 권한이 있으며, 요청 기록 생성이 워커 실행·ASR 완료를 뜻하지 않음을 확인했습니다.');rightsLabel.prepend(rights);
 const cancelCheck=element('input');cancelCheck.type='checkbox';const cancelLabel=element('label','현재 요청만 취소하며 저장된 전사·요약·과금 기록을 삭제하지 않습니다.');cancelLabel.prepend(cancelCheck);
 actions.append(refresh,request,context,cancel);
 const file=element('input');file.type='file';file.accept='.json,application/json';const fileLabel=element('label','소유자 제출 로컬 ASR 전달 파일 · UTF-8 JSON 최대 2,000,000바이트');fileLabel.append(file);
 const preview=element('pre');preview.hidden=true;
 const owner=element('input');owner.type='checkbox';const ownerLabel=element('label','선택한 결과의 분석·원음·측정 길이를 확인했습니다. 이 파일은 소유자가 제출한 외부 결과이며 앱 워커 생성 증거가 아닙니다.');ownerLabel.prepend(owner);
 const receiveCheck=element('input');receiveCheck.type='checkbox';const receiveLabel=element('label','외부 전사를 별도로 수신합니다. 음성 정확성 검증이나 자동 요약 완료로 처리하지 않습니다.');receiveLabel.prepend(receiveCheck);
 const bind=element('button','음성 연결 확인·등록','btn secondary small'),receive=element('button','외부 ASR 전사 수신','btn primary small'),clear=element('button','파일 선택 해제','btn secondary small'),verify=element('button','저장된 원문 확인','btn secondary small'),plan=element('button','요약 계획 확인·기존 보고서 열기','btn secondary small'),execute=element('button','검토한 요약 한 단계 실행','btn primary small');
 const transfer=element('div',undefined,'library-actions');transfer.append(bind,receive,clear,verify);
 const planText=element('p'),summaryCheck=element('input');summaryCheck.type='checkbox';const summaryLabel=element('label','표시한 요약 계획을 확인했습니다. 최신 무료 승인·용량 검사를 유지하고 한 단계만 요청합니다. 이후 단계는 별도로 선택합니다.');summaryLabel.prepend(summaryCheck);
 const summaryActions=element('div',undefined,'library-actions');summaryActions.append(plan,execute);
 for(const button of [refresh,request,context,cancel,bind,receive,clear,verify,plan,execute])button.type='button';
 host.replaceChildren(heading,intro,message,status,measurement,rightsLabel,cancelLabel,actions,fileLabel,preview,ownerLabel,receiveLabel,transfer,planText,summaryLabel,summaryActions);
 let scope=null,lastFile=null,lastPlan=null;
 const current=()=>isCurrent()&&host.isConnected!==false;
 const controller=createAsrResultBridgeController({jobId,api,isCurrent:current,onChange:render,onReport,storage,now});
 function render(state){
  if(!current())return;const busy=phases.includes(state.phase),s=state.status,active=s&&activeStates.includes(s.state),expired=s?.expiresAt<=now();
  const newScope=s?JSON.stringify([s.requestId,s.revision,s.jobSourceSha256]):null;if(scope!==newScope){scope=newScope;cancelCheck.checked=false;rights.checked=false;summaryCheck.checked=false;}
  if(lastFile!==state.draft?.fileSha256){lastFile=state.draft?.fileSha256??null;owner.checked=false;receiveCheck.checked=false;}
  const planKey=canonical(state.summaryPlan);if(lastPlan!==planKey){lastPlan=planKey;summaryCheck.checked=false;}
  message.textContent=state.message;
  const labels={NO_REQUEST:'등록된 오디오 요청 없음',WAITING_FOR_WORKER:'요청 저장됨 · 워커 연결 대기',SOURCE_BOUND:'소유자 제출 음성 연결됨 · 전사 수신 대기',RESULT_STORED:'외부 로컬 ASR 전사 저장됨 · 음성 정확성 미검증',CANCELLED:'오디오 요청 취소됨',EXPIRED:'오디오 요청 만료됨 · 이전 동의로 수신하지 않음',SOURCE_REVIEW_REQUIRED:'저장된 전사 연결 확인 필요 · 완료 판정 보류'};
  status.textContent=s?`${labels[s.state]}\n실제 워커: 연결되지 않음 · 전사 수신에 의한 자동 요약 없음${expired&&active?' · 요청 만료':''}`:'오디오 요청 경로 또는 저장 상태를 확인하지 못했습니다.';
  const original=state.draft?.source?.originalAudio??s?.source?.originalAudio,input=state.draft?.source?.asrInput??s?.source?.asrInput;
  measurement.textContent=`분석 선언 길이: ${s?.context?.declaredDurationMs===undefined?'미확인':s.context.declaredDurationMs+' ms'}\n소유자 제출 ffprobe 원음 측정 길이: ${original?.durationMs===undefined?'자료 없음':original.durationMs+' ms'}\n소유자 제출 PCM 샘플 수 기준 ASR 입력 길이: ${input?.durationMs===undefined?'자료 없음':input.durationMs+' ms'}\n측정 메타데이터의 제출·연결 확인과 음성 내용의 정확성 검증은 다릅니다.`;
  preview.hidden=!state.draft;preview.textContent=state.draft?`선택한 외부 결과 · ${state.draft.fileBytes}바이트 · ${state.draft.segmentCount}구간\n원음 SHA-256 ${state.draft.source.originalAudio.sha256}\nASR 입력 SHA-256 ${state.draft.source.asrInput.sha256}\n\n${state.draft.raw}`:'';
  refresh.disabled=busy;request.disabled=busy||s?.canRequest!==true||rights.checked!==true;rights.disabled=busy||s?.canRequest!==true;request.textContent=['CANCELLED','EXPIRED'].includes(s?.state)?'새 오디오 요청 기록 만들기':'오디오 요청 기록 만들기';
  context.disabled=busy||!active||expired||!s?.context;cancel.disabled=busy||s?.canCancel!==true||cancelCheck.checked!==true;cancelCheck.disabled=busy||s?.canCancel!==true;
  file.disabled=busy||!s?.transferAvailable||!(active||s?.state==='RESULT_STORED')||expired&&active;owner.disabled=busy||!state.draft;receiveCheck.disabled=busy||!state.draft;
  bind.disabled=busy||s?.canBind!==true||!s?.eligible||!state.draft||!active||expired||owner.checked!==true;receive.disabled=busy||s?.canReceive!==true||!s?.eligible||s?.state!=='SOURCE_BOUND'||expired||!controller.canReceive()||receiveCheck.checked!==true;clear.disabled=busy||!state.draft;
  verify.disabled=busy||s?.state!=='RESULT_STORED';plan.disabled=busy||s?.state!=='RESULT_STORED';execute.disabled=busy||!state.summaryPlan||summaryCheck.checked!==true;summaryCheck.disabled=busy||!state.summaryPlan;
  planText.textContent=state.summaryPlan?`승인 형식 ${state.summaryPlan.formatProfile} · ${state.summaryPlan.stages}구간 · 첫 단계 예약 상한 ${state.summaryPlan.firstPassUnits}단위. 최종 합성 비용은 ${state.summaryPlan.additionalSynthesisUnits??'UNKNOWN'}이며 실제 무료 승인·잔여량을 다시 확인합니다. 한 번 클릭하면 한 단계만 요청합니다.`:'전사 수신만으로 요약은 실행되지 않습니다. 원문 확인 후 계획을 별도로 조회하세요.';
 }
 for(const check of [rights,cancelCheck,owner,receiveCheck,summaryCheck])check.onchange=()=>render(controller.getState());
 refresh.onclick=()=>controller.load();request.onclick=()=>controller.request({rightsConfirmed:rights.checked});cancel.onclick=()=>controller.cancel({confirmed:cancelCheck.checked});
 context.onclick=()=>{if(context.disabled||!current())return;try{download(controller.downloadContext());}catch(error){message.textContent=error.message;}};
 file.onchange=()=>{if(file.disabled||!current())return;owner.checked=false;receiveCheck.checked=false;return file.files?.[0]?controller.prepare(file.files[0]):controller.clearFile();};
 bind.onclick=()=>controller.bind({ownerConfirmed:owner.checked});receive.onclick=()=>controller.receive({ownerConfirmed:receiveCheck.checked});clear.onclick=()=>{file.value='';controller.clearFile();};verify.onclick=()=>controller.checkSource();plan.onclick=()=>controller.planSummary();execute.onclick=()=>controller.executeSummary({confirmed:summaryCheck.checked});
 render(controller.getState());return {controller,ready:controller.load()};
}
