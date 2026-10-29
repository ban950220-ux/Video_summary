import {ProviderError} from './adapters.mjs';
import {videoIdOf,transcriptAudit} from './core.mjs';
import {normalizeSegments,auditGaps} from './report.mjs';

// Owner-submitted local ASR is a separate provenance domain. These records are
// never Groq/Gemini provider receipts, quota reservations or payment evidence.
export const ASR_BRIDGE_LIMITS=Object.freeze({jsonBytes:2000000,storedSourceBytes:1500000,segments:20000,originalAudioBytes:200000000,inputAudioBytes:268435456,durationMs:7200000,requestTtlMs:3600000,requestsPerJob:32});
const provider='local-asr-result-v1';
const provenance='OWNER_SUBMITTED_LOCAL_ASR';
const states=new Set(['WAITING_FOR_WORKER','SOURCE_BOUND','RESULT_STORED','CANCELLED']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=/^[0-9a-f]{64}$/;
const unsupportedText=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const utf8=new TextEncoder();
const sqlNow="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const runnerTables=['yta_local_runner_outbox','yta_local_runner_transfers','yta_local_runner_audio_dispatches','yta_local_runner_audio_attempts','yta_local_runner_audio_resumes'];
const fail=code=>{throw new ProviderError(code,code);};
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const positive=(value,max)=>Number.isSafeInteger(value)&&value>0&&value<=max;
const duration=value=>Number.isFinite(value)&&value>0&&value<=ASR_BRIDGE_LIMITS.durationMs;
const collapsed=value=>value.replace(/\s+/g,' ').trim();
const nowIso=()=>new Date().toISOString();
const idFor=(jobId,requestId)=>jobId+':local-asr-result:'+requestId;
const ownerScope=(j='j')=>`${j}.owner_id='owner' AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=${j}.id||':deleting' AND (d.provider='deletion' OR d.state='DELETING'))`;
const operationScope=(o='o')=>`EXISTS(SELECT 1 FROM jobs j WHERE j.id=${o}.job_id AND ${ownerScope()})`;
const emptyReport=(j='j')=>`(${j}.report_json IS NULL OR ${j}.report_json='null')`;
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});

export async function asrSha256(text){
 if(typeof text!=='string')fail('ASR_HASH_INPUT_INVALID');
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',utf8.encode(text)))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function transcriptInput(raw,segments){
 if(typeof raw!=='string'||!raw.trim()||unsupportedText.test(raw)||!Array.isArray(segments)||!segments.length||segments.length>ASR_BRIDGE_LIMITS.segments)fail('ASR_TRANSCRIPT_INVALID');
 let end=0,positiveSpan=false;
 const canonical=segments.map((segment,index)=>{
  if(!exact(segment,['id','startMs','endMs','text'])||segment.id!==index+1||typeof segment.text!=='string'||!segment.text.trim()||unsupportedText.test(segment.text)||!Number.isSafeInteger(segment.startMs)||!Number.isSafeInteger(segment.endMs)||segment.startMs<0||segment.endMs<segment.startMs||segment.endMs>ASR_BRIDGE_LIMITS.durationMs||(index&&segment.startMs<segments[index-1].startMs))fail('ASR_TRANSCRIPT_INVALID');
  end=Math.max(end,segment.endMs);positiveSpan||=segment.endMs>segment.startMs;
  return {id:segment.id,startMs:segment.startMs,endMs:segment.endMs,text:segment.text};
 });
 if(!positiveSpan||collapsed(raw)!==collapsed(canonical.map(segment=>segment.text).join(' ')))fail('ASR_TRANSCRIPT_CONTENT_MISMATCH');
 const normalized=normalizeSegments(canonical);
 if(normalized.length!==canonical.length||utf8.encode(raw+JSON.stringify(normalized)).byteLength>ASR_BRIDGE_LIMITS.storedSourceBytes)fail('ASR_TRANSCRIPT_TOO_LARGE');
 return {raw,segments:canonical,normalized,endMs:end};
}
export async function asrTranscriptDigests(raw,segments){
 const input=transcriptInput(raw,segments);
 return {rawSha256:await asrSha256(input.raw),segmentsSha256:await asrSha256(JSON.stringify(input.segments))};
}
export async function asrNormalizedSourceDigest(raw,segments){
 const input=transcriptInput(raw,segments);
 return asrSha256(JSON.stringify({raw:input.raw,segments:input.normalized,provenance}));
}
function sourceInput(value){
 if(!exact(value,['kind','jobId','requestId','jobSourceSha256','sourceIdentity','originalAudio','asrInput'])||value.kind!=='OWNER_SUBMITTED_ASR_SOURCE_V1'||!uuid.test(value.jobId||'')||!uuid.test(value.requestId||'')||!hash.test(value.jobSourceSha256||''))fail('ASR_SOURCE_BINDING_INVALID');
 const original=value.originalAudio,input=value.asrInput,identity=value.sourceIdentity;
 if(!exact(original,['sha256','bytes','durationMs','startTimeMs','measurement','measurementSha256'])||!hash.test(original.sha256||'')||!positive(original.bytes,ASR_BRIDGE_LIMITS.originalAudioBytes)||!duration(original.durationMs)||!(original.startTimeMs===null||Number.isFinite(original.startTimeMs)&&Math.abs(original.startTimeMs)<=original.durationMs)||original.measurement!=='FFPROBE'||!hash.test(original.measurementSha256||''))fail('ASR_ORIGINAL_AUDIO_INVALID');
 if(!exact(input,['sha256','pcmSha256','bytes','durationMs','measurement','measurementSha256','sampleRate','channels','sampleCount','format','timeOrigin'])||!hash.test(input.sha256||'')||!hash.test(input.pcmSha256||'')||!positive(input.bytes,ASR_BRIDGE_LIMITS.inputAudioBytes)||!duration(input.durationMs)||input.measurement!=='PCM_SAMPLE_COUNT'||!hash.test(input.measurementSha256||'')||input.sampleRate!==16000||input.channels!==1||!positive(input.sampleCount,115200000)||Math.abs(input.durationMs-input.sampleCount*1000/input.sampleRate)>0.000001||input.bytes<input.sampleCount*2+44||input.bytes>input.sampleCount*2+65536||input.format!=='WAV_PCM_S16LE'||input.timeOrigin!=='NORMALIZED_AUDIO_FRAME_ZERO'||Math.abs(original.durationMs-input.durationMs)>2000)fail('ASR_INPUT_AUDIO_INVALID');
 let sourceIdentity;
 if(identity?.kind==='OWNED_AUDIO'){
  if(!exact(identity,['kind','originalAudioSha256'])||identity.originalAudioSha256!==original.sha256)fail('ASR_SOURCE_IDENTITY_INVALID');
  sourceIdentity={kind:'OWNED_AUDIO',originalAudioSha256:identity.originalAudioSha256};
 }else{
  if(!exact(identity,['kind','videoId','canonicalUrl','officialDurationMs','metadataSha256'])||identity.kind!=='YOUTUBE_ACQUISITION'||typeof identity.videoId!=='string'||identity.canonicalUrl!==`https://www.youtube.com/watch?v=${identity.videoId}`||!duration(identity.officialDurationMs)||!hash.test(identity.metadataSha256||'')||Math.abs(identity.officialDurationMs-original.durationMs)>2000)fail('ASR_SOURCE_IDENTITY_INVALID');
  try{if(videoIdOf(identity.canonicalUrl)!==identity.videoId)fail('ASR_SOURCE_IDENTITY_INVALID');}catch{fail('ASR_SOURCE_IDENTITY_INVALID');}
  sourceIdentity={kind:'YOUTUBE_ACQUISITION',videoId:identity.videoId,canonicalUrl:identity.canonicalUrl,officialDurationMs:identity.officialDurationMs,metadataSha256:identity.metadataSha256};
 }
 return {kind:value.kind,jobId:value.jobId,requestId:value.requestId,jobSourceSha256:value.jobSourceSha256,sourceIdentity,originalAudio:{sha256:original.sha256,bytes:original.bytes,durationMs:original.durationMs,startTimeMs:original.startTimeMs,measurement:original.measurement,measurementSha256:original.measurementSha256},asrInput:{sha256:input.sha256,pcmSha256:input.pcmSha256,bytes:input.bytes,durationMs:input.durationMs,measurement:input.measurement,measurementSha256:input.measurementSha256,sampleRate:input.sampleRate,channels:input.channels,sampleCount:input.sampleCount,format:input.format,timeOrigin:input.timeOrigin}};
}
export async function asrSourceBindingDigest(source){return asrSha256(JSON.stringify(sourceInput(source)));}

async function bodyJson(request){
 if(Number(request.headers.get('content-length'))>ASR_BRIDGE_LIMITS.jsonBytes)fail('ASR_JSON_TOO_LARGE');
 const reader=request.body?.getReader();if(!reader)fail('ASR_JSON_INVALID');
 const chunks=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>ASR_BRIDGE_LIMITS.jsonBytes){await reader.cancel();fail('ASR_JSON_TOO_LARGE');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 let text,value;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);value=JSON.parse(text);}catch{fail('ASR_JSON_INVALID');}
 if(!value||typeof value!=='object'||Array.isArray(value))fail('ASR_JSON_INVALID');
 return {value,text,sha256:await asrSha256(text)};
}
async function database(env){
 if(!env?.DB)fail('ASR_DATABASE_REQUIRED');
 const db=typeof env.DB.withSession==='function'?env.DB.withSession('first-primary'):env.DB;
 const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results??[];
 for(const table of ['jobs','yta_sources','yta_operations','yta_audio','usage_events'])if(!tables.some(row=>row.name===table))fail('ASR_SCHEMA_REQUIRED');
 return {db,runner:runnerTables.filter(table=>tables.some(row=>row.name===table))};
}
async function ownedJob(db,id){
 const row=await db.prepare(`SELECT j.* FROM jobs j WHERE j.id=? AND ${ownerScope()}`).bind(id).first();
 if(!row)fail('NOT_FOUND');
 let audit;try{audit=JSON.parse(row.audit_json||'null');}catch{fail('ASR_JOB_STATE_INVALID');}
 if(!audit||typeof audit!=='object'||Array.isArray(audit))fail('ASR_JOB_STATE_INVALID');
 return {...row,audit};
}
function snapshotOf(job){return {jobId:job.id,sourceType:job.source_type,videoId:job.video_id??null,sourceUrl:job.source_url??null,declaredDurationSeconds:job.duration_seconds,status:job.status,auditJson:job.audit_json??null,reportJson:job.report_json??null,ownedAudioSha256:job.audit?.ownedAudioSha256??null,createdAt:job.created_at,updatedAt:job.updated_at};}
function snapshotInput(snapshot){
 if(!exact(snapshot,['jobId','sourceType','videoId','sourceUrl','declaredDurationSeconds','status','auditJson','reportJson','ownedAudioSha256','createdAt','updatedAt'])||!uuid.test(snapshot.jobId||'')||!['audio','url'].includes(snapshot.sourceType)||!duration(snapshot.declaredDurationSeconds*1000)||typeof snapshot.status!=='string'||typeof snapshot.auditJson!=='string'||!(snapshot.reportJson===null||snapshot.reportJson==='null')||![snapshot.createdAt,snapshot.updatedAt].every(value=>typeof value==='string'&&Number.isFinite(Date.parse(value))))fail('ASR_REQUEST_RECORD_INVALID');
 let audit;try{audit=JSON.parse(snapshot.auditJson);}catch{fail('ASR_REQUEST_RECORD_INVALID');}
 if(!audit||typeof audit!=='object'||Array.isArray(audit)||(audit.ownedAudioSha256??null)!==snapshot.ownedAudioSha256)fail('ASR_REQUEST_RECORD_INVALID');
 if(snapshot.sourceType==='audio'){
  if(!hash.test(snapshot.ownedAudioSha256||''))fail('ASR_REQUEST_RECORD_INVALID');
  if(snapshot.videoId!==null||snapshot.sourceUrl!==null){try{if(snapshot.sourceUrl!==`https://www.youtube.com/watch?v=${snapshot.videoId}`||videoIdOf(snapshot.sourceUrl)!==snapshot.videoId)fail('ASR_REQUEST_RECORD_INVALID');}catch{fail('ASR_REQUEST_RECORD_INVALID');}}
 }else{
  try{if(snapshot.ownedAudioSha256!==null||snapshot.sourceUrl!==`https://www.youtube.com/watch?v=${snapshot.videoId}`||videoIdOf(snapshot.sourceUrl)!==snapshot.videoId||snapshot.status!=='NEED_UPLOAD'||audit.status!=='NO_CAPTIONS')fail('ASR_REQUEST_RECORD_INVALID');}catch{fail('ASR_REQUEST_RECORD_INVALID');}
 }
 return snapshot;
}
function snapshotSql(j='j'){return `${j}.id=? AND ${j}.source_type IS ? AND ${j}.video_id IS ? AND ${j}.source_url IS ? AND ${j}.duration_seconds IS ? AND ${j}.status IS ? AND ${j}.audit_json IS ? AND ${j}.report_json IS ? AND ${j}.created_at IS ? AND ${j}.updated_at IS ?`;}
function snapshotArgs(snapshot){return [snapshot.jobId,snapshot.sourceType,snapshot.videoId,snapshot.sourceUrl,snapshot.declaredDurationSeconds,snapshot.status,snapshot.auditJson,snapshot.reportJson,snapshot.createdAt,snapshot.updatedAt];}
function compatibleIdentity(job,snapshot){return job.id===snapshot.jobId&&job.source_type===snapshot.sourceType&&(job.video_id??null)===snapshot.videoId&&(job.source_url??null)===snapshot.sourceUrl&&job.duration_seconds===snapshot.declaredDurationSeconds&&job.created_at===snapshot.createdAt&&(job.audit.ownedAudioSha256??null)===snapshot.ownedAudioSha256;}
function writerExclusion(runner,j='j'){
 return `NOT EXISTS(SELECT 1 FROM yta_audio a WHERE a.job_id=${j}.id) AND NOT EXISTS(SELECT 1 FROM yta_operations x WHERE x.job_id=${j}.id AND (x.provider NOT IN ('supadata','${provider}') OR (x.provider='supadata' AND x.state!='DONE'))) AND NOT EXISTS(SELECT 1 FROM usage_events u WHERE u.job_id=${j}.id AND u.provider!='supadata') AND (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (${runnerTables.map(table=>`'${table}'`).join(',')}))=${runner.length}`+runner.map(table=>` AND NOT EXISTS(SELECT 1 FROM ${table} r WHERE r.job_id=${j}.id)`).join('');
}
function sourceKind(job){
 if(job.source_type==='audio'&&hash.test(job.audit.ownedAudioSha256||'')&&!job.audit.sourceSummaryOrigin)return 'OWNED_AUDIO';
 if(job.source_type==='url'&&job.status==='NEED_UPLOAD'&&job.audit.status==='NO_CAPTIONS'&&!job.audit.sourceSummaryOrigin)return 'URL_NO_CAPTIONS';
 return null;
}
async function storedSource(db,id){return db.prepare(`SELECT s.raw,s.segments_json,s.provenance FROM yta_sources s JOIN jobs j ON j.id=s.job_id WHERE s.job_id=? AND ${ownerScope()}`).bind(id).first();}
function receiptInput(receipt,value){
 const source=value.source;
 if(!exact(receipt,['kind','jobId','requestId','revision','generation','submittedBodySha256','sourceBindingSha256','originalAudioSha256','asrInputSha256','asrPcmSha256','rawSha256','segmentsSha256','normalizedSourceSha256','segmentCount','provenance','sourceAccuracy','identityVerification','durationEvidence','engine','receivedAt'])||!source||receipt.kind!=='OWNER_SUBMITTED_LOCAL_ASR_RECEIPT_V1'||receipt.jobId!==value.snapshot.jobId||receipt.requestId!==value.requestId||receipt.revision!==value.revision||receipt.generation!==value.generation||receipt.submittedBodySha256!==value.resultBodySha256||receipt.sourceBindingSha256!==value.sourceBindingSha256||receipt.originalAudioSha256!==source.originalAudio.sha256||receipt.asrInputSha256!==source.asrInput.sha256||receipt.asrPcmSha256!==source.asrInput.pcmSha256||['submittedBodySha256','rawSha256','segmentsSha256','normalizedSourceSha256'].some(key=>!hash.test(receipt[key]||''))||!positive(receipt.segmentCount,ASR_BRIDGE_LIMITS.segments)||receipt.provenance!==provenance||receipt.sourceAccuracy!=='UNVERIFIED'||receipt.identityVerification!=='OWNER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED'||typeof receipt.receivedAt!=='string'||!Number.isFinite(Date.parse(receipt.receivedAt)))fail('ASR_RECEIPT_INVALID');
 const evidence=receipt.durationEvidence;
 if(!exact(evidence,['declaredDurationMs','originalAudioDurationMs','originalAudioStartTimeMs','asrInputDurationMs','officialVideoDurationMs','timeOrigin'])||evidence.declaredDurationMs!==value.snapshot.declaredDurationSeconds*1000||evidence.originalAudioDurationMs!==source.originalAudio.durationMs||evidence.originalAudioStartTimeMs!==source.originalAudio.startTimeMs||evidence.asrInputDurationMs!==source.asrInput.durationMs||evidence.officialVideoDurationMs!==(source.sourceIdentity.kind==='YOUTUBE_ACQUISITION'?source.sourceIdentity.officialDurationMs:null)||evidence.timeOrigin!==source.asrInput.timeOrigin)fail('ASR_RECEIPT_INVALID');
 engineInput(receipt.engine);
 return receipt;
}
async function records(db,id){
 const rows=(await db.prepare(`SELECT o.* FROM yta_operations o WHERE o.job_id=? AND o.provider=? AND ${operationScope()} ORDER BY created_at,id`).bind(id,provider).all()).results??[];
 const found=[];
 for(const row of rows){
  let value;try{if(typeof row.result_json!=='string'||utf8.encode(row.result_json).byteLength>ASR_BRIDGE_LIMITS.jsonBytes)fail('ASR_REQUEST_RECORD_INVALID');value=JSON.parse(row.result_json);}catch{fail('ASR_REQUEST_RECORD_INVALID');}
  if(!exact(value,['kind','requestId','revision','generation','jobSourceSha256','snapshot','expiresAt','requestBodySha256','bindBodySha256','cancelBodySha256','resultBodySha256','source','sourceBindingSha256','receipt'])||value.kind!=='LOCAL_ASR_REQUEST_RECORD_V1'||!uuid.test(value.requestId||'')||row.id!==idFor(id,value.requestId)||row.units!==0||row.error_code!==null||!states.has(row.state)||!positive(value.revision,3)||!positive(value.generation,ASR_BRIDGE_LIMITS.requestsPerJob)||!hash.test(value.jobSourceSha256||'')||!hash.test(value.requestBodySha256||'')||['bindBodySha256','cancelBodySha256','resultBodySha256','sourceBindingSha256'].some(key=>value[key]!==null&&!hash.test(value[key]||''))||snapshotInput(value.snapshot).jobId!==id||await asrSha256(JSON.stringify(value.snapshot))!==value.jobSourceSha256||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=0)fail('ASR_REQUEST_RECORD_INVALID');
  if(value.source&&(await asrSourceBindingDigest(value.source)!==value.sourceBindingSha256||value.source.requestId!==value.requestId||value.source.jobId!==id||value.source.jobSourceSha256!==value.jobSourceSha256))fail('ASR_REQUEST_RECORD_INVALID');
  if(value.source)matchesSourceSnapshot(value.source,{value});
  if(Boolean(value.source)!==Boolean(value.sourceBindingSha256)||Boolean(value.source)!==Boolean(value.bindBodySha256)||(row.state==='WAITING_FOR_WORKER'&&(value.source!==null||value.revision!==1))||(['SOURCE_BOUND','RESULT_STORED'].includes(row.state)&&(!value.source||value.revision!==2))||(row.state==='CANCELLED'&&(value.revision!==(value.source?3:2)||!value.cancelBodySha256))||(row.state!=='CANCELLED'&&value.cancelBodySha256!==null))fail('ASR_REQUEST_RECORD_INVALID');
  if(row.state==='RESULT_STORED'){if(!value.resultBodySha256)fail('ASR_RECEIPT_INVALID');receiptInput(value.receipt,value);}else if(value.receipt!==null||value.resultBodySha256!==null)fail('ASR_REQUEST_RECORD_INVALID');
  found.push({row,value});
 }
 const sorted=found.sort((a,b)=>a.value.generation-b.value.generation);
 if(sorted.some((item,index)=>item.value.generation!==index+1))fail('ASR_REQUEST_RECORD_INVALID');
 return sorted;
}
function liveRecord(record){if(record.row.state==='CANCELLED')fail('ASR_REQUEST_CANCELLED');if(record.value.expiresAt<=Date.now())fail('ASR_REQUEST_EXPIRED');}
function selectRecord(found,requestId){const record=found.find(item=>item.value.requestId===requestId);if(!record)fail('ASR_REQUEST_NOT_FOUND');if(record!==found.at(-1))fail('ASR_REQUEST_STALE');return record;}
function activeRecordSql(){return `EXISTS(SELECT 1 FROM yta_operations r WHERE r.id=? AND r.job_id=j.id AND r.provider='${provider}' AND r.state=? AND r.result_json=? AND json_extract(r.result_json,'$.expiresAt')>MAX(?,${sqlNow}) AND NOT EXISTS(SELECT 1 FROM yta_operations newer WHERE newer.job_id=j.id AND newer.provider='${provider}' AND json_extract(newer.result_json,'$.generation')>json_extract(r.result_json,'$.generation')))`;}
function activeRecordArgs(record){return [record.row.id,record.row.state,record.row.result_json,Date.now()];}
async function eligibility(db,runner,job){
 const kind=sourceKind(job);
 if(!kind||job.report_json!==null&&job.report_json!=='null')return {eligible:false,reason:'ASR_FRESH_SOURCE_REQUIRED',sourceKind:kind};
 const row=await db.prepare(`SELECT 1 AS ok FROM jobs j WHERE j.id=? AND ${ownerScope()} AND ${emptyReport()} AND NOT EXISTS(SELECT 1 FROM yta_sources s WHERE s.job_id=j.id) AND ${writerExclusion(runner)}`).bind(job.id).first();
 return {eligible:Boolean(row),reason:row?null:'ASR_EXISTING_WORK_PRESERVED',sourceKind:kind};
}
async function receiptMatches(db,job,record){
 if(record?.row.state!=='RESULT_STORED'||!record.value.receipt||!compatibleIdentity(job,record.value.snapshot))return false;
 const saved=await storedSource(db,job.id);let segments;try{segments=JSON.parse(saved?.segments_json);}catch{return false;}
 const audit=job.audit.localAsrReceipt;
 if(!saved||saved.provenance!==provenance||!Array.isArray(segments)||segments.length!==record.value.receipt.segmentCount||!exact(audit,['requestId','sourceBindingSha256','submittedBodySha256','normalizedSourceSha256','receiptSha256','provenance','sourceAccuracy','inputProcessingCoverage','summaryGenerated'])||audit.requestId!==record.value.requestId||audit.sourceBindingSha256!==record.value.sourceBindingSha256||audit.submittedBodySha256!==record.value.resultBodySha256||audit.normalizedSourceSha256!==record.value.receipt.normalizedSourceSha256||audit.receiptSha256!==await asrSha256(JSON.stringify(record.value.receipt))||audit.provenance!==provenance||audit.sourceAccuracy!=='UNVERIFIED'||audit.inputProcessingCoverage!=='NOT_INDEPENDENTLY_VERIFIED'||audit.summaryGenerated!==false)return false;
 try{return await asrNormalizedSourceDigest(saved.raw,segments)===record.value.receipt.normalizedSourceSha256&&await asrSha256(saved.raw)===record.value.receipt.rawSha256;}catch{return false;}
}
function contextOf(job,record){
 if(!record)return null;const snapshot=record.value.snapshot;
 return {kind:'ASR_RESULT_BRIDGE_CONTEXT_V1',jobId:job.id,requestId:record.value.requestId,jobSourceSha256:record.value.jobSourceSha256,sourceKind:snapshot.sourceType==='audio'?'OWNED_AUDIO':'URL_NO_CAPTIONS',declaredDurationMs:snapshot.declaredDurationSeconds*1000,revision:record.value.revision,expiresAt:record.value.expiresAt,sourceIdentity:snapshot.sourceType==='audio'?{kind:'OWNED_AUDIO',originalAudioSha256:snapshot.ownedAudioSha256}:{kind:'YOUTUBE_ACQUISITION',videoId:snapshot.videoId,canonicalUrl:snapshot.sourceUrl}};
}
async function status(db,runner,id,extra={}){
 const job=await ownedJob(db,id),found=await records(db,id),record=found.at(-1),eligible=await eligibility(db,runner,job),matched=record?await receiptMatches(db,job,record):false;
 const currentJobSourceSha256=await asrSha256(JSON.stringify(snapshotOf(job))),snapshotMatches=record?currentJobSourceSha256===record.value.jobSourceSha256:true;
 const state=record?record.row.state==='RESULT_STORED'?(matched?'RESULT_STORED':'SOURCE_REVIEW_REQUIRED'):record.row.state!=='CANCELLED'&&record.value.expiresAt<=Date.now()?'EXPIRED':!snapshotMatches&&record.row.state!=='CANCELLED'?'SOURCE_REVIEW_REQUIRED':record.row.state:'NO_REQUEST';
 const context=contextOf(job,record),hasReport=job.report_json!==null&&job.report_json!=='null';
 return {kind:'ASR_RESULT_BRIDGE_STATUS_V1',jobId:id,...eligible,sourceKind:context?.sourceKind??eligible.sourceKind,jobSourceSha256:!record||['CANCELLED','EXPIRED'].includes(state)?currentJobSourceSha256:record.value.jobSourceSha256,workerConnected:false,executionAvailable:false,transferAvailable:true,state,requestId:record?.value.requestId??null,revision:record?.value.revision??null,expiresAt:record?.value.expiresAt??null,sourceBindingSha256:record?.value.sourceBindingSha256??null,source:record?.value.source??null,receipt:matched?record.value.receipt:null,context,canRequest:eligible.eligible&&(!record||['CANCELLED','EXPIRED'].includes(state)),canBind:eligible.eligible&&['WAITING_FOR_WORKER','SOURCE_BOUND'].includes(state),canReceive:eligible.eligible&&state==='SOURCE_BOUND'||state==='RESULT_STORED'&&matched,canCancel:record&&['WAITING_FOR_WORKER','SOURCE_BOUND'].includes(record.row.state)||false,transcriptStored:matched,asrSummaryReady:matched&&!hasReport,sourceBinding:matched?'MATCHED_OWNER_SUBMITTED_SOURCE':record?.row.state==='RESULT_STORED'?'STALE_OR_UNAVAILABLE':'NOT_STORED',sourceAccuracy:'UNVERIFIED',summaryComplete:false,providerCalls:0,currentJobHasSavedReport:hasReport,...extra};
}

async function enqueue(db,runner,job,body){
 if(!exact(body,['requestId','jobSourceSha256','rightsConfirmed','confirmLocalOnly'])||!uuid.test(body.requestId||'')||!hash.test(body.jobSourceSha256||'')||body.rightsConfirmed!==true||body.confirmLocalOnly!==true)fail('ASR_REQUEST_INVALID');
 const requestId=body.requestId.toLowerCase(),canonical={requestId,jobSourceSha256:body.jobSourceSha256,rightsConfirmed:true,confirmLocalOnly:true},bodyHash=await asrSha256(JSON.stringify(canonical)),found=await records(db,job.id),prior=found.find(record=>record.value.requestId===requestId);
 if(prior){if(prior!==found.at(-1))fail('ASR_REQUEST_STALE');if(prior.value.requestBodySha256!==bodyHash)fail('ASR_REQUEST_CONFLICT');return status(db,runner,job.id,{replayed:true});}
 if(found.length>=ASR_BRIDGE_LIMITS.requestsPerJob)fail('ASR_REQUEST_LIMIT');
 const eligible=await eligibility(db,runner,job);if(!eligible.eligible)fail(eligible.reason);
 const snapshot=snapshotInput(snapshotOf(job)),jobHash=await asrSha256(JSON.stringify(snapshot));if(jobHash!==body.jobSourceSha256)fail('ASR_SOURCE_SNAPSHOT_CHANGED');
 const created=nowIso(),value={kind:'LOCAL_ASR_REQUEST_RECORD_V1',requestId,revision:1,generation:(found.at(-1)?.value.generation??0)+1,jobSourceSha256:jobHash,snapshot,expiresAt:Date.now()+ASR_BRIDGE_LIMITS.requestTtlMs,requestBodySha256:bodyHash,bindBodySha256:null,cancelBodySha256:null,resultBodySha256:null,source:null,sourceBindingSha256:null,receipt:null};
 const sql=`INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,j.id,'${provider}',0,'WAITING_FOR_WORKER',?,? FROM jobs j WHERE ${snapshotSql()} AND ${ownerScope()} AND ${emptyReport()} AND NOT EXISTS(SELECT 1 FROM yta_sources s WHERE s.job_id=j.id) AND ${writerExclusion(runner)} AND (SELECT COUNT(*) FROM yta_operations o WHERE o.job_id=j.id AND o.provider='${provider}')=? AND NOT EXISTS(SELECT 1 FROM yta_operations o WHERE o.job_id=j.id AND o.provider='${provider}' AND (o.state='RESULT_STORED' OR (o.state IN ('WAITING_FOR_WORKER','SOURCE_BOUND') AND json_extract(o.result_json,'$.expiresAt')>MAX(?,${sqlNow}))))`;
 let inserted;try{inserted=await db.prepare(sql).bind(idFor(job.id,requestId),created,JSON.stringify(value),...snapshotArgs(snapshot),found.length,Date.now()).run();}catch{fail('ASR_REQUEST_WRITE_UNCERTAIN');}
 const after=await records(db,job.id),saved=after.find(record=>record.value.requestId===requestId);
 if(!saved||saved!==after.at(-1)||saved.value.requestBodySha256!==bodyHash)fail('ASR_REQUEST_CONFLICT');
 return status(db,runner,job.id,{replayed:inserted.meta?.changes!==1});
}

function matchesSourceSnapshot(source,record){
 const snapshot=record.value.snapshot;
 if(source.jobId!==snapshot.jobId||source.requestId!==record.value.requestId||source.jobSourceSha256!==record.value.jobSourceSha256)fail('ASR_SOURCE_SNAPSHOT_CHANGED');
 if(snapshot.sourceType==='audio'){
  if(source.sourceIdentity.kind!=='OWNED_AUDIO'||source.originalAudio.sha256!==snapshot.ownedAudioSha256)fail('ASR_ORIGINAL_AUDIO_HASH_MISMATCH');
 }else if(source.sourceIdentity.kind!=='YOUTUBE_ACQUISITION'||source.sourceIdentity.videoId!==snapshot.videoId||source.sourceIdentity.canonicalUrl!==snapshot.sourceUrl)fail('ASR_SOURCE_IDENTITY_MISMATCH');
}
async function bindSource(db,runner,job,body){
 if(!exact(body,['requestId','revision','jobSourceSha256','source','confirmSourceBinding','confirmNoProviderCall'])||!uuid.test(body.requestId||'')||!positive(body.revision,1000000)||!hash.test(body.jobSourceSha256||'')||body.confirmSourceBinding!==true||body.confirmNoProviderCall!==true)fail('ASR_BIND_REQUEST_INVALID');
 const found=await records(db,job.id),record=selectRecord(found,body.requestId),source=sourceInput(body.source);liveRecord(record);matchesSourceSnapshot(source,record);
 if(body.jobSourceSha256!==record.value.jobSourceSha256)fail('ASR_SOURCE_SNAPSHOT_CHANGED');
 const canonical={requestId:body.requestId,revision:body.revision,jobSourceSha256:body.jobSourceSha256,source,confirmSourceBinding:true,confirmNoProviderCall:true},bodyHash=await asrSha256(JSON.stringify(canonical));
 if(record.value.bindBodySha256===bodyHash&&record.value.source){if(record.row.state==='RESULT_STORED'){if(!await receiptMatches(db,job,record))fail('ASR_STORED_SOURCE_CHANGED');}else if(await asrSha256(JSON.stringify(snapshotOf(job)))!==record.value.jobSourceSha256||!(await eligibility(db,runner,job)).eligible)fail('ASR_SOURCE_SNAPSHOT_CHANGED');return status(db,runner,job.id,{replayed:true});}
 if(record.row.state!=='WAITING_FOR_WORKER'||record.value.revision!==body.revision||record.value.source)fail('ASR_REQUEST_REVISION_CHANGED');
 if(await asrSha256(JSON.stringify(snapshotOf(job)))!==record.value.jobSourceSha256)fail('ASR_SOURCE_SNAPSHOT_CHANGED');
 const value={...record.value,revision:record.value.revision+1,source,sourceBindingSha256:await asrSourceBindingDigest(source),bindBodySha256:bodyHash};
 let updated;try{updated=await db.prepare(`UPDATE yta_operations SET state='SOURCE_BOUND',result_json=? WHERE id=? AND provider='${provider}' AND state='WAITING_FOR_WORKER' AND result_json=? AND EXISTS(SELECT 1 FROM jobs j WHERE ${snapshotSql()} AND ${ownerScope()} AND ${emptyReport()} AND NOT EXISTS(SELECT 1 FROM yta_sources s WHERE s.job_id=j.id) AND ${writerExclusion(runner)} AND ${activeRecordSql()})`).bind(JSON.stringify(value),record.row.id,record.row.result_json,...snapshotArgs(record.value.snapshot),...activeRecordArgs(record)).run();}catch{fail('ASR_BIND_WRITE_UNCERTAIN');}
 if(updated.meta?.changes!==1){const after=selectRecord(await records(db,job.id),body.requestId);if(after.value.bindBodySha256!==bodyHash||after.row.state!=='SOURCE_BOUND')fail('ASR_BIND_WRITE_UNCONFIRMED');}
 return status(db,runner,job.id,{replayed:updated.meta?.changes===0});
}

async function cancel(db,runner,job,body){
 if(!exact(body,['requestId','revision','confirmCancel'])||!uuid.test(body.requestId||'')||!positive(body.revision,1000000)||body.confirmCancel!==true)fail('ASR_CANCEL_INVALID');
 const found=await records(db,job.id),record=selectRecord(found,body.requestId),bodyHash=await asrSha256(JSON.stringify({requestId:body.requestId,revision:body.revision,confirmCancel:true}));
 if(record.row.state==='CANCELLED'&&record.value.cancelBodySha256===bodyHash)return status(db,runner,job.id,{replayed:true});
 if(!['WAITING_FOR_WORKER','SOURCE_BOUND'].includes(record.row.state)||record.value.revision!==body.revision)fail('ASR_REQUEST_REVISION_CHANGED');
 const value={...record.value,revision:record.value.revision+1,cancelBodySha256:bodyHash};
 let changed;try{changed=await db.prepare(`UPDATE yta_operations SET state='CANCELLED',result_json=? WHERE id=? AND provider='${provider}' AND state=? AND result_json=? AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=yta_operations.job_id AND ${ownerScope()}) AND NOT EXISTS(SELECT 1 FROM yta_operations n WHERE n.job_id=yta_operations.job_id AND n.provider='${provider}' AND json_extract(n.result_json,'$.generation')>?)`).bind(JSON.stringify(value),record.row.id,record.row.state,record.row.result_json,record.value.generation).run();}catch{fail('ASR_CANCEL_WRITE_UNCERTAIN');}
 if(changed.meta?.changes!==1){const after=selectRecord(await records(db,job.id),body.requestId);if(after.row.state!=='CANCELLED'||after.value.cancelBodySha256!==bodyHash)fail('ASR_CANCEL_WRITE_UNCONFIRMED');}
 return status(db,runner,job.id,{replayed:changed.meta?.changes===0});
}

function engineInput(engine){
 const label=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value);
 if(!exact(engine,['name','model','version','device','computeType'])||engine.name!=='faster-whisper'||!label(engine.model)||!(engine.version===null||label(engine.version))||engine.device!=='cpu'||!label(engine.computeType))fail('ASR_ENGINE_METADATA_INVALID');
 return {name:engine.name,model:engine.model,version:engine.version,device:engine.device,computeType:engine.computeType};
}
async function receive(db,runner,job,body,submittedBodySha256){
 if(!exact(body,['kind','jobId','requestId','revision','jobSourceSha256','sourceBindingSha256','originalAudioSha256','asrInputSha256','asrPcmSha256','transcript','engine','confirmOwnerSubmitted','confirmNoProviderCall'])||body.kind!=='OWNER_SUBMITTED_LOCAL_ASR_RESULT_V1'||body.jobId!==job.id||!uuid.test(body.requestId||'')||!positive(body.revision,1000000)||['jobSourceSha256','sourceBindingSha256','originalAudioSha256','asrInputSha256','asrPcmSha256'].some(key=>!hash.test(body[key]||''))||body.confirmOwnerSubmitted!==true||body.confirmNoProviderCall!==true)fail('ASR_RESULT_INVALID');
 const found=await records(db,job.id),record=selectRecord(found,body.requestId);liveRecord(record);
 if(record.value.revision!==body.revision||body.jobSourceSha256!==record.value.jobSourceSha256||body.sourceBindingSha256!==record.value.sourceBindingSha256||!record.value.source)fail('ASR_REQUEST_REVISION_CHANGED');
 const source=record.value.source;
 if(body.originalAudioSha256!==source.originalAudio.sha256||body.asrInputSha256!==source.asrInput.sha256||body.asrPcmSha256!==source.asrInput.pcmSha256)fail('ASR_AUDIO_HASH_MISMATCH');
 if(record.row.state==='RESULT_STORED'){
  if(record.value.resultBodySha256!==submittedBodySha256)fail('ASR_RESULT_CONFLICT');
  if(!await receiptMatches(db,job,record))fail('ASR_STORED_SOURCE_CHANGED');
  return status(db,runner,job.id,{persisted:true,replayed:true});
 }
 if(record.row.state!=='SOURCE_BOUND')fail('ASR_SOURCE_BINDING_REQUIRED');
 if(await asrSha256(JSON.stringify(snapshotOf(job)))!==record.value.jobSourceSha256)fail('ASR_SOURCE_SNAPSHOT_CHANGED');
 if(!exact(body.transcript,['raw','segments','rawSha256','segmentsSha256'])||!hash.test(body.transcript.rawSha256||'')||!hash.test(body.transcript.segmentsSha256||''))fail('ASR_TRANSCRIPT_INVALID');
 const input=transcriptInput(body.transcript.raw,body.transcript.segments),digests=await asrTranscriptDigests(input.raw,input.segments),engine=engineInput(body.engine);
 if(input.endMs>Math.round(source.asrInput.durationMs))fail('ASR_TIMELINE_OUTSIDE_INPUT');
 if(digests.rawSha256!==body.transcript.rawSha256||digests.segmentsSha256!==body.transcript.segmentsSha256)fail('ASR_TRANSCRIPT_HASH_MISMATCH');
 const normalizedSourceSha256=await asrNormalizedSourceDigest(input.raw,input.segments),receivedAt=nowIso(),durationEvidence={declaredDurationMs:record.value.snapshot.declaredDurationSeconds*1000,originalAudioDurationMs:source.originalAudio.durationMs,originalAudioStartTimeMs:source.originalAudio.startTimeMs,asrInputDurationMs:source.asrInput.durationMs,officialVideoDurationMs:source.sourceIdentity.kind==='YOUTUBE_ACQUISITION'?source.sourceIdentity.officialDurationMs:null,timeOrigin:source.asrInput.timeOrigin};
 const receipt={kind:'OWNER_SUBMITTED_LOCAL_ASR_RECEIPT_V1',jobId:job.id,requestId:record.value.requestId,revision:record.value.revision,generation:record.value.generation,submittedBodySha256,sourceBindingSha256:record.value.sourceBindingSha256,originalAudioSha256:source.originalAudio.sha256,asrInputSha256:source.asrInput.sha256,asrPcmSha256:source.asrInput.pcmSha256,...digests,normalizedSourceSha256,segmentCount:input.normalized.length,provenance,sourceAccuracy:'UNVERIFIED',identityVerification:'OWNER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED',durationEvidence,engine,receivedAt};
 const audit={...job.audit,...transcriptAudit(input.normalized,source.asrInput.durationMs/1000,false),...auditGaps(input.normalized,source.asrInput.durationMs/1000),durationEvidence,localAsrReceipt:{requestId:record.value.requestId,sourceBindingSha256:record.value.sourceBindingSha256,submittedBodySha256,normalizedSourceSha256,receiptSha256:await asrSha256(JSON.stringify(receipt)),provenance,sourceAccuracy:'UNVERIFIED',inputProcessingCoverage:'NOT_INDEPENDENTLY_VERIFIED',summaryGenerated:false},independentVerification:false};
 // Revision identifies the pinned source generation. Completion changes state
 // without changing that revision, so the identical result can reconcile a lost
 // acknowledgement. Different bytes still fail its immutable receipt hash.
 const value={...record.value,resultBodySha256:submittedBodySha256,receipt},auditJson=JSON.stringify(audit),segmentsJson=JSON.stringify(input.normalized);
 const guard=`${snapshotSql()} AND ${ownerScope()} AND ${emptyReport()} AND NOT EXISTS(SELECT 1 FROM yta_sources s WHERE s.job_id=j.id) AND ${writerExclusion(runner)} AND ${activeRecordSql()}`;
 const statements=[
  db.prepare(`INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) SELECT j.id,?,?,?,? FROM jobs j WHERE ${guard}`).bind(input.raw,segmentsJson,provenance,receivedAt,...snapshotArgs(record.value.snapshot),...activeRecordArgs(record)),
  db.prepare(`UPDATE jobs AS j SET status=?,audit_json=?,updated_at=? WHERE changes()=1 AND ${snapshotSql()} AND ${ownerScope()} AND ${emptyReport()} AND ${writerExclusion(runner)} AND ${activeRecordSql()}`).bind(audit.status,auditJson,receivedAt,...snapshotArgs(record.value.snapshot),...activeRecordArgs(record)),
  db.prepare(`UPDATE yta_operations SET state='RESULT_STORED',result_json=? WHERE changes()=1 AND id=? AND provider='${provider}' AND state='SOURCE_BOUND' AND result_json=? AND EXISTS(SELECT 1 FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=yta_operations.job_id AND ${ownerScope()} AND j.audit_json=? AND j.report_json IS ? AND s.raw=? AND s.segments_json=? AND s.provenance=?)`).bind(JSON.stringify(value),record.row.id,record.row.result_json,auditJson,record.value.snapshot.reportJson,input.raw,segmentsJson,provenance),
  // A zero-row CAS must cause an SQL error inside D1.batch. Throwing only in JS
  // after the batch would not roll back earlier statements.
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('ASR_RESULT_COMMIT_BLOCKED') END AS committed")
 ];
 try{await db.batch(statements);}catch{
  const current=await ownedJob(db,job.id),after=selectRecord(await records(db,job.id),body.requestId);
  if(after.row.state==='RESULT_STORED'&&after.value.resultBodySha256===submittedBodySha256&&await receiptMatches(db,current,after))return status(db,runner,job.id,{persisted:true,replayed:true});
  fail('ASR_RESULT_WRITE_UNCONFIRMED');
 }
 const current=await ownedJob(db,job.id),after=selectRecord(await records(db,job.id),body.requestId);
 if(after.row.state!=='RESULT_STORED'||after.value.resultBodySha256!==submittedBodySha256||!await receiptMatches(db,current,after))fail('ASR_RESULT_WRITE_UNCONFIRMED');
 return status(db,runner,job.id,{persisted:true,replayed:false});
}

// Reached only through the existing owner-authenticated API boundary. There is
// no token minting, worker authentication replacement, downloader or ASR/model
// dispatch here. The receiver can accept an existing local result explicitly.
export async function routeAsrResultBridge(request,env){
 const match=new URL(request.url).pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/(audio-request|audio-request-bind|audio-request-cancel|asr-result)$/i);
 if(!match)return null;
 const [,id,action]=match;
 if(request.method!=='POST'&&!(action==='audio-request'&&request.method==='GET'))return json({error:{code:'METHOD_NOT_ALLOWED'}},405);
 try{
  const {db,runner}=await database(env),job=await ownedJob(db,id);
  if(request.method==='GET')return json(await status(db,runner,id));
  const body=await bodyJson(request);
  if(action==='audio-request')return json(await enqueue(db,runner,job,body.value));
  if(action==='audio-request-bind')return json(await bindSource(db,runner,job,body.value));
  if(action==='audio-request-cancel')return json(await cancel(db,runner,job,body.value));
  return json(await receive(db,runner,job,body.value,body.sha256));
 }catch(error){
  const code=error instanceof ProviderError?error.code:'ASR_BRIDGE_INTERNAL_ERROR';
  return json({error:{code,message:code}},code==='NOT_FOUND'?404:['ASR_DATABASE_REQUIRED','ASR_SCHEMA_REQUIRED'].includes(code)?503:code==='ASR_BRIDGE_INTERNAL_ERROR'?500:409);
 }
}
