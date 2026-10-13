import {InputError,transcriptAudit} from './core.mjs';
import {ProviderError} from './adapters.mjs';
import {runNativeCaption,runNativePoll,runTranscriptSummary,runOwnedAudioTranscription,runOwnedGeminiAudio} from './provider-keys.mjs';
import {normalizeSegments,auditGaps,validateAnalysis,reportPrompt,markdownReport} from './report.mjs';
import {scanMp3,prepareMp3Chunk,mergeAudioSegments,boundaryMarkersFromRetained} from './audio.mjs';
import {recordCapacity,reserveObservedCapacity,capacityBounds,persistWait,ensureCapacitySchema,capacityIdentityMatches,capacityIdentity} from './observed-capacity.mjs';
import {partitionTranscript,partitionSynthesis,synthesisPrompt,summaryUnits,evidenceIds,assertGroupCoverage} from './summary-plan.mjs';
import {groqD1Budget} from './groq-d1-budget.mjs';
import {handleGroqSummaryAction,prepareGroqSettlementsForDeletion,persistGroqSettlementsForDeletion,completeSource,validatedRecoveredFirstCheckpoint,partitionGroqTranscript,promptAudit,GROQ_SUMMARY_INPUT_BOUND,GROQ_SUMMARY_COMPLETION_CAP,GROQ_SUMMARY_MODEL} from './groq-summary.mjs';
import {handlePaidSummaryAction} from './paid-summary.mjs';
import {handleGeminiTwoPassAction} from './gemini-two-pass.mjs';
import {PAID_SUMMARY_CATALOG,paidExecutionEnabled,fullSummaryRequest,paidRequestCostPreview} from './paid-summary-contract.mjs';
const liveTables=['yta_sources','yta_quota','yta_operations','yta_audio'];
export async function ensureLiveSchema(env){
 if(!env.DB)throw new ProviderError('DB_REQUIRED','D1 연결 필요');
 const rows=(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('yta_sources','yta_quota','yta_operations','yta_audio')").bind().all()).results||[];
 if(liveTables.some(name=>!rows.some(row=>row.name===name)))throw new ProviderError('LIVE_SCHEMA_REQUIRED','라이브 저장 테이블을 별도 승인 후 준비해야 합니다.');
}
const json=(x,status=200)=>Response.json(x,{status,headers:{'cache-control':'no-store'}});
async function readJson(req){const text=await req.text();if(text.length>900000)throw new InputError('본문 90만자 제한');try{return JSON.parse(text);}catch{throw new InputError('JSON 오류');}}
export async function saveSource(env,id,raw,segments,provenance){await ensureLiveSchema(env);const normalized=normalizeSegments(segments);if(new TextEncoder().encode(raw+JSON.stringify(normalized)).byteLength>1500000)throw new InputError('보관 원문 크기 제한');await env.DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET raw=excluded.raw,segments_json=excluded.segments_json,provenance=excluded.provenance,updated_at=excluded.updated_at').bind(id,raw,JSON.stringify(normalized),provenance,new Date().toISOString()).run();return normalized;}
async function sourceOf(env,id){const row=await env.DB.prepare('SELECT * FROM yta_sources WHERE job_id=?').bind(id).first();return row?{...row,segments:JSON.parse(row.segments_json)}:null;}
function boundaryAuditView(audit){
 const markers=(Array.isArray(audit?.audioBoundaryAmbiguities)?audit.audioBoundaryAmbiguities:[]).filter(item=>Number.isSafeInteger(item?.segmentId)&&Number.isSafeInteger(item?.chunkIndex)&&Number.isFinite(item?.startMs)&&Number.isFinite(item?.endMs));
 return {audioBoundaryReview:audit?.audioBoundaryReview??null,audioBoundaryAmbiguityCount:markers.length,audioBoundaryAmbiguities:markers.slice(0,64).map(({segmentId,chunkIndex,startMs,endMs})=>({segmentId,chunkIndex,startMs,endMs})),audioBoundaryAmbiguitiesOmitted:Math.max(0,markers.length-64)};
}
async function ownedJob(env,id){const row=await env.DB.prepare("SELECT * FROM jobs WHERE id=? AND owner_id=? AND NOT EXISTS (SELECT 1 FROM yta_operations WHERE id=? AND provider='deletion' AND state='DELETING')").bind(id,'owner',id+':deleting').first();if(!row)throw new ProviderError('NOT_FOUND','분석 기록 없음');return {...row,report:JSON.parse(row.report_json||'null'),audit:JSON.parse(row.audit_json||'null')};}
async function updateJob(env,id,status,report,audit){await env.DB.prepare('UPDATE jobs SET status=?,report_json=?,audit_json=?,updated_at=? WHERE id=? AND owner_id=?').bind(status,JSON.stringify(report),JSON.stringify(audit),new Date().toISOString(),id,'owner').run();}
async function grantEnv(env,provider){
 if(env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true')throw new ProviderError('LIVE_DISABLED','라이브 무료 호출을 아직 활성화하지 않았습니다.');
 const quota=await env.DB.prepare('SELECT * FROM yta_quota WHERE provider=?').bind(provider).first();
 if(!quota||quota.billing_disabled!==1||quota.expires_at<=Date.now())throw new ProviderError('QUOTA_UNVERIFIED','설정에서 결제 비활성·무료 잔여량을 먼저 확인하세요.');
 const credential=await env.DB.prepare('SELECT updated_at FROM provider_credentials WHERE owner_id=? AND provider=?').bind('owner',provider).first();
 if(credential&&Date.parse(credential.updated_at)>quota.confirmed_at)throw new ProviderError('KEY_CHANGED','키 변경 뒤 무료 계정 확인을 다시 해야 합니다.');
 return {...env,[provider.toUpperCase()+'_FREE_PLAN_CONFIRMED']:'true',quotaExpiresAt:quota.expires_at,quotaConfirmedAt:quota.confirmed_at};
}
const GEMINI_SPACING_MS=13_000; // Conservatively space starts from the previous settled request.
const GEMINI_STALE_CLAIM_MS=300_000;
const GROQ_HOURLY_WINDOW_MS=3_600_000;
const GROQ_APP_HOURLY_CAP_SECONDS=6_500; // Below the observed 7,200-second provider limit; app-only reservations.
const GROQ_APP_DAILY_CAP_SECONDS=26_000; // App-only cap below the published daily Free limit; not a provider balance.
const groqPermit="NOT EXISTS (SELECT 1 FROM yta_operations WHERE provider='groq' AND state='CLAIMED') AND NOT EXISTS (SELECT 1 FROM yta_operations WHERE provider='groq' AND state='FAILED_UNCERTAIN' AND error_code='429' AND created_at>?) AND COALESCE((SELECT SUM(units) FROM yta_operations WHERE provider='groq' AND (state='CLAIMED' OR (state IN ('DONE','FAILED_UNCERTAIN') AND created_at>?))),0)+?<=?";
const groqProbePermit=groqPermit+" AND COALESCE((SELECT SUM(units) FROM yta_operations WHERE provider='groq' AND (state='CLAIMED' OR (state IN ('DONE','FAILED_UNCERTAIN') AND created_at>?))),0)+?<=? AND NOT EXISTS (SELECT 1 FROM yta_operations WHERE provider='groq' AND state IN ('DONE','FAILED_UNCERTAIN') AND created_at>?)";
async function execute(env,{id,job,provider,units},fn,onNewCall){
 const prior=await env.DB.prepare('SELECT * FROM yta_operations WHERE id=?').bind(id).first();
 if(prior?.state==='DONE')return JSON.parse(prior.result_json);
 if(prior&&!(prior.state==='BLOCKED'&&['QUOTA_EXHAUSTED','PRE_DISPATCH_BLOCKED','CAPACITY_WAIT'].includes(prior.error_code)))throw new ProviderError('OPERATION_REVIEW_REQUIRED','이미 요청했거나 결과가 불명확한 작업입니다. 사용량을 확인한 뒤 새 작업으로 진행하세요.');
 const active=await grantEnv(env,provider);
 // Atomic unique claim and atomic quota decrement: concurrent calls cannot overspend this app's grant.
 const now=new Date().toISOString(),cutoff=new Date(Date.now()-GEMINI_SPACING_MS).toISOString();
 const groqCutoff=new Date(Date.now()-GROQ_HOURLY_WINDOW_MS).toISOString();
 // CLAIMED remains blocking regardless of age: key resolution and network dispatch can be delayed.
 // Settled operations use created_at as their last state-transition timestamp for conservative pacing.
 const recent="SELECT state,created_at FROM yta_operations WHERE provider='gemini' AND (state='CLAIMED' OR (state IN ('DONE','FAILED_UNCERTAIN') AND created_at>?)) ORDER BY CASE WHEN state='CLAIMED' THEN 0 ELSE 1 END LIMIT 1";
 const claim=prior
  ?provider==='gemini'
   ?await env.DB.prepare(`UPDATE yta_operations SET state=?,error_code=NULL,created_at=? WHERE id=? AND state=? AND error_code IN ('QUOTA_EXHAUSTED','PRE_DISPATCH_BLOCKED','CAPACITY_WAIT') AND NOT EXISTS (${recent})`).bind('CLAIMED',now,id,'BLOCKED',cutoff).run()
   :provider==='groq'
    ?await env.DB.prepare(`UPDATE yta_operations SET state=?,error_code=NULL,created_at=? WHERE id=? AND state=? AND error_code IN ('QUOTA_EXHAUSTED','PRE_DISPATCH_BLOCKED','CAPACITY_WAIT') AND ${groqPermit}`).bind('CLAIMED',now,id,'BLOCKED',groqCutoff,groqCutoff,units,GROQ_APP_HOURLY_CAP_SECONDS).run()
   :await env.DB.prepare('UPDATE yta_operations SET state=?,error_code=NULL WHERE id=? AND state=? AND error_code=?').bind('CLAIMED',id,'BLOCKED','QUOTA_EXHAUSTED').run()
  :provider==='gemini'
   ?await env.DB.prepare(`INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (${recent})`).bind(id,job,provider,units,'CLAIMED',now,cutoff).run()
   :provider==='groq'
    ?await env.DB.prepare(`INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at) SELECT ?,?,?,?,?,? WHERE ${groqPermit}`).bind(id,job,provider,units,'CLAIMED',now,groqCutoff,groqCutoff,units,GROQ_APP_HOURLY_CAP_SECONDS).run()
   :await env.DB.prepare('INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').bind(id,job,provider,units,'CLAIMED',now).run();
 if(claim.meta?.changes!==1){
  if(provider==='groq'){
   const inFlight=await env.DB.prepare("SELECT created_at FROM yta_operations WHERE provider='groq' AND state='CLAIMED' LIMIT 1").bind().first();
   if(inFlight)throw new ProviderError(Date.now()-Date.parse(inFlight.created_at)>300000?'OPERATION_REVIEW_REQUIRED':'OPERATION_IN_FLIGHT','이전 Groq 호출의 완료 상태를 먼저 확인하세요.');
   const recent429=await env.DB.prepare("SELECT 1 FROM yta_operations WHERE provider='groq' AND state='FAILED_UNCERTAIN' AND error_code='429' AND created_at>? LIMIT 1").bind(groqCutoff).first();
   if(recent429)throw new ProviderError('GROQ_COOLDOWN_PENDING','Groq 429 이후 최소 1시간 대기 중입니다. 공식 요청 로그와 무료 한도를 다시 확인하세요.');
   const spent=await env.DB.prepare("SELECT COALESCE(SUM(units),0) AS units FROM yta_operations WHERE provider='groq' AND (state='CLAIMED' OR (state IN ('DONE','FAILED_UNCERTAIN') AND created_at>?))").bind(groqCutoff).first();
   if(Number(spent?.units||0)+units>GROQ_APP_HOURLY_CAP_SECONDS)throw new ProviderError('GROQ_HOURLY_APP_LIMIT','앱이 기록한 최근 1시간 음성 예약 상한에 도달했습니다. 제공자 계정의 실제 잔여량은 별도로 확인하세요.');
  }
  const blocking=provider==='gemini'?await env.DB.prepare(recent).bind(cutoff).first():null;
  if(blocking?.state==='CLAIMED'){
   if(!Number.isFinite(Date.parse(blocking.created_at))||Date.now()-Date.parse(blocking.created_at)>GEMINI_STALE_CLAIM_MS)throw new ProviderError('OPERATION_REVIEW_REQUIRED','이전 요약 호출의 완료 여부가 불명확합니다. 사용량과 작업 기록을 확인한 뒤 진행하세요.');
   throw new ProviderError('OPERATION_IN_FLIGHT','다른 요약 호출이 아직 진행 중입니다. 완료 상태를 확인한 뒤 다시 진행하세요.');
  }
  if(blocking)throw new ProviderError('RATE_LIMIT_PENDING','무료 요약 호출 간격을 지키기 위해 잠시 대기 중입니다. 약 13초 뒤 이력에서 요약 생성을 다시 누르세요.');
  throw new ProviderError('OPERATION_BUSY','중복 요청 차단');
 }
 const reserve=await env.DB.prepare('UPDATE yta_quota SET consumed=consumed+?,request_count=request_count+1 WHERE provider=? AND consumed+?<=allowance AND request_count<request_limit AND expires_at>? AND billing_disabled=1').bind(units,provider,units,Date.now()).run();
 if(reserve.meta?.changes!==1){await env.DB.prepare('UPDATE yta_operations SET state=?,error_code=? WHERE id=?').bind('BLOCKED','QUOTA_EXHAUSTED',id).run();throw new ProviderError('QUOTA_EXHAUSTED','무료 사용량 또는 요청 횟수 한도에 도달했습니다.');}
 let capacity;
 if(provider==='groq'||provider==='gemini'){
  try{capacity=await reserveObservedCapacity(env,{provider,operationId:id,jobId:job,bounds:capacityBounds(provider,units)});}catch(error){await releaseUndispatchedGrant(env,id,provider,units,'CAPACITY_WAIT',active);throw error;}
 }
 onNewCall?.();
 try{
  const result=await fn({...active,capacityValidUntil:capacity?.validUntil,capacityVersion:capacity?.version});
  // Conservative accounting: reserved upper bound stays consumed even on provider timeout or mismatch.
  await env.DB.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),job,'owner',provider,'LIVE_FREE',provider==='groq'?'audio_seconds':provider==='supadata'?'credits':'conservative_token_units',units,0,null,'APP_RESERVED_UPPER_BOUND',new Date().toISOString()).run();
  await env.DB.prepare('UPDATE yta_operations SET state=?,result_json=?,created_at=? WHERE id=?').bind('DONE',JSON.stringify(result),new Date().toISOString(),id).run();return result;
 }catch(error){
  if(error.preDispatchBlocked&&error.code==='CAPACITY_WAIT')await persistWait(env,{operationId:id,jobId:job,provider,reason:'OBSERVATION_EXPIRED_BEFORE_DISPATCH',resetAt:null});
  if(error.preDispatchBlocked)await releaseUndispatchedGrant(env,id,provider,units,'PRE_DISPATCH_BLOCKED',active);
  else await env.DB.prepare('UPDATE yta_operations SET state=?,error_code=?,created_at=?,result_json=? WHERE id=?').bind('FAILED_UNCERTAIN',String(error.code||'PROCESSING_FAILED'),new Date().toISOString(),error.reviewResult?JSON.stringify(error.reviewResult):null,id).run();
  if(['402','429','403'].includes(String(error.code)))await env.DB.prepare('UPDATE yta_quota SET expires_at=0 WHERE provider=?').bind(provider).run();
  throw error;
 }
}
async function releaseUndispatchedGrant(env,id,provider,units,reason,active){
 const marked=await env.DB.prepare("UPDATE yta_operations SET state='BLOCKED',error_code=?,created_at=? WHERE id=? AND state='CLAIMED'").bind(reason,new Date().toISOString(),id).run();
 if(marked.meta?.changes===1)await env.DB.prepare('UPDATE yta_quota SET consumed=consumed-?,request_count=request_count-1 WHERE provider=? AND confirmed_at=? AND expires_at IN (?,0) AND consumed>=? AND request_count>0').bind(units,provider,active.quotaConfirmedAt,active.quotaExpiresAt,units).run();
}
async function assertCapacityBeforeDispatch(env,active,provider){
 await assertCurrentGrant(env,active,provider);
 const row=await env.DB.prepare('SELECT valid_until,version,source FROM yta_capacity WHERE provider=?').bind(provider).first();
 if(!row||row.version!==active.capacityVersion||row.valid_until!==active.capacityValidUntil||!await capacityIdentityMatches(env,provider,row.source)){const error=new ProviderError('CAPACITY_WAIT','현재 키의 공급자 계정 사용량 관측이 바뀌었습니다. 다시 확인하세요.');error.preDispatchBlocked=true;throw error;}
 assertCapacityAtFetch(active);
}
async function assertCurrentGrant(env,active,provider){
 const row=await env.DB.prepare('SELECT expires_at,confirmed_at,billing_disabled FROM yta_quota WHERE provider=?').bind(provider).first();
 if(!row||row.billing_disabled!==1||row.confirmed_at!==active.quotaConfirmedAt||row.expires_at!==active.quotaExpiresAt||row.expires_at<=Date.now()){const error=new ProviderError('QUOTA_UNVERIFIED','호출 직전 무료 허가가 변경되거나 만료됐습니다.');error.preDispatchBlocked=true;throw error;}
}
async function assertGeminiBeforeFetch(env,active){
 try{await assertCapacityBeforeDispatch(env,active,'gemini');}catch(error){error.preDispatchBlocked=true;throw error;}
}
function assertCapacityAtFetch(active){if(!Number.isFinite(active.quotaExpiresAt)||active.quotaExpiresAt<=Date.now()||!Number.isFinite(active.capacityValidUntil)||active.capacityValidUntil<=Date.now()){const error=new ProviderError('CAPACITY_WAIT','공급자 관측치가 실제 전송 직전에 만료됐습니다.');error.preDispatchBlocked=true;throw error;}}
async function assertGroqBeforeDispatch(env,id,active){
 try{
  const {quotaExpiresAt}=await grantEnv(env,'groq');
  const own=await env.DB.prepare("SELECT state FROM yta_operations WHERE id=? AND provider='groq'").bind(id).first();
  if(own?.state!=='CLAIMED')throw new ProviderError('OPERATION_REVIEW_REQUIRED','음성 호출 예약 상태를 확인할 수 없습니다.');
  const cutoff=new Date(Date.now()-GROQ_HOURLY_WINDOW_MS).toISOString();
  const recent429=await env.DB.prepare("SELECT 1 FROM yta_operations WHERE provider='groq' AND state='FAILED_UNCERTAIN' AND error_code='429' AND created_at>? LIMIT 1").bind(cutoff).first();
  if(recent429)throw new ProviderError('GROQ_COOLDOWN_PENDING','Groq 429 이후 최소 1시간 대기 중입니다.');
  const other=await env.DB.prepare("SELECT 1 FROM yta_operations WHERE provider='groq' AND state='CLAIMED' AND id<>? LIMIT 1").bind(id).first();
  if(other)throw new ProviderError('OPERATION_IN_FLIGHT','다른 음성 호출이 진행 중입니다.');
  if(!Number.isFinite(quotaExpiresAt)||quotaExpiresAt<=Date.now())throw new ProviderError('QUOTA_UNVERIFIED','호출 직전 무료 허가가 만료됐습니다.');
  await assertCapacityBeforeDispatch(env,active,'groq');
 }catch(error){error.preDispatchBlocked=true;throw error;}
}
async function storeTranscriptResult(env,job,segments,provenance,extra={}){
 const raw=segments.map(s=>s.text).join('\n'),clean=await saveSource(env,job.id,raw,segments,provenance);
 const audit={...transcriptAudit(clean,job.duration_seconds,false),...auditGaps(clean,job.duration_seconds),...extra};
 await updateJob(env,job.id,audit.status,null,audit);return {job:await ownedJob(env,job.id),source:{segments:clean,provenance},persisted:true};
}
async function storeAudioTranscriptOnce(env,job,merged){
 const raw=merged.segments.map(segment=>segment.text).join('\n'),clean=normalizeSegments(merged.segments);
 if(new TextEncoder().encode(raw+JSON.stringify(clean)).byteLength>1500000)throw new InputError('보관 원문 크기 제한');
 const audit={...transcriptAudit(clean,job.duration_seconds,false),...auditGaps(clean,job.duration_seconds),audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:merged.fileSha256,audioProviders:merged.providers,audioChunks:merged.chunkProvenance,audioSegmentOrigins:merged.segments.map((segment,index)=>({segmentId:index+1,chunkIndex:segment.chunk,startMs:segment.startMs,endMs:segment.endMs})),audioBoundaryReview:merged.boundaryAmbiguities.length?'NONIDENTICAL_OVERLAP_TEXT_RETAINED_UNVERIFIED':'NO_NONIDENTICAL_OVERLAP_TEXT',audioBoundaryAmbiguities:merged.boundaryAmbiguities,independentVerification:false};
 // Commit the final audit before making the source visible to summary requests.
 // A stale second finisher cannot reset a report created after the first insert.
 await env.DB.prepare("UPDATE jobs SET status=?,audit_json=?,updated_at=? WHERE id=? AND owner_id=? AND (report_json IS NULL OR report_json='null') AND (audit_json IS NULL OR json_extract(audit_json,'$.audioProcessingCoverage') IS NULL)").bind(audit.status,JSON.stringify(audit),new Date().toISOString(),job.id,'owner').run();
 await env.DB.prepare('INSERT OR IGNORE INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(job.id,raw,JSON.stringify(clean),audioProvenance(merged.providers),new Date().toISOString()).run();
 const source=await sourceOf(env,job.id),savedJob=await ownedJob(env,job.id);
 if(source?.provenance!==audioProvenance(merged.providers)||source.raw!==raw||JSON.stringify(source.segments)!==JSON.stringify(clean)||savedJob.audit?.audioFileSha256!==merged.fileSha256||savedJob.audit?.audioProcessingCoverage!==1)throw new ProviderError('TRANSCRIPT_PERSISTENCE_UNVERIFIED','저장된 전사 또는 완료 기록이 일치하지 않습니다.');
 return {job:savedJob,source:{segments:clean,provenance:audioProvenance(merged.providers)},persisted:true};
}
function completedAudio(rows,duration){
 if(!rows.length||rows.some((row,index)=>row.chunk_index!==index||row.state!=='DONE'))throw new ProviderError('AUDIO_INCOMPLETE','누락된 음성 조각이 있습니다.');
 let edge=0;
 for(const row of rows){
  if(!Number.isFinite(row.start_sec)||!Number.isFinite(row.end_sec)||row.start_sec<Math.max(0,edge-5)||row.start_sec>edge+.1||row.end_sec<=row.start_sec||row.end_sec>duration+2)throw new ProviderError('AUDIO_COVERAGE_INVALID','음성 조각 시간 범위를 확인할 수 없습니다.');
  edge=row.end_sec;
 }
 if(Math.abs(edge-duration)>2)throw new ProviderError('AUDIO_COVERAGE_INVALID','전체 음성 범위가 확인되지 않았습니다.');
 const hashes=new Set();
 const chunks=rows.map(row=>{
  const result=JSON.parse(row.result_json||'{}');
  if(!Array.isArray(result.segments)||!/^[a-f0-9]{64}$/.test(result.fileSha256||''))throw new ProviderError('AUDIO_INCOMPLETE','조각 전사 또는 파일 지문이 없습니다.');
  hashes.add(result.fileSha256);
  if(!['groq','gemini'].includes(result.provider||'groq'))throw new ProviderError('AUDIO_PROVIDER_INVALID','조각 전사 제공자를 확인할 수 없습니다.');
  return {index:row.chunk_index,start:row.start_sec,end:row.end_sec,segments:result.segments,provider:result.provider||'groq',model:result.model||null,operationId:result.operationId||null};
 });
 if(hashes.size!==1)throw new ProviderError('AUDIO_FILE_MISMATCH','음성 파일 지문이 일치하지 않습니다.');
 const merged=mergeAudioSegments(chunks);
 if(merged.missingChunks.length||!merged.segments.length||merged.rejectedSegments.some(item=>item.reason!=='OVERLAP_DUPLICATE'))throw new ProviderError('AUDIO_INCOMPLETE','누락되거나 범위를 벗어난 전사 조각이 있습니다.');
 return {...merged,fileSha256:[...hashes][0],providers:[...new Set(chunks.map(chunk=>chunk.provider))].sort(),chunkProvenance:chunks.map(({index,start,end,provider,model,operationId})=>({index,start,end,provider,model,operationId}))};
}
function audioAttempts(operations,jobId,index,provider='groq'){
 const base=jobId+':audio:'+index;
 return operations.filter(operation=>operation.provider===provider).map(operation=>{
  if(provider==='groq'&&operation.id===base)return {operation,attempt:0};
  if(provider==='groq'&&operation.id===base+':reviewed404:1')return {operation,attempt:1000};
  if(provider==='groq'&&operation.id===base+':freebatch:1')return {operation,attempt:2000};
  const prefix=provider==='groq'?base+':reviewed429:':base+':gemini:';
  const suffix=operation.id?.startsWith(prefix)?operation.id.slice(prefix.length):'';
  if(provider==='gemini'){
   const match=/^([0-9]+)(?::reviewed429:([1-9][0-9]*))?$/.exec(suffix);
   return match?{operation,attempt:Number(match[1])*100+Number(match[2]||0)}:null;
  }
  return /^[1-9][0-9]*$/.test(suffix)?{operation,attempt:Number(suffix)}:null;
 }).filter(Boolean).sort((a,b)=>a.attempt-b.attempt).map(item=>item.operation);
}
const audioProvenance=providers=>providers.length===1&&providers[0]==='groq'?'GROQ_OWNED_AUDIO':providers.length===1&&providers[0]==='gemini'?'GEMINI_OWNED_AUDIO':'MIXED_OWNED_AUDIO';
async function boundedBytes(req,max){const reader=req.body?.getReader();if(!reader)throw new InputError('빈 음성');let size=0;const arrays=[];while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new InputError('음성 조각은 8MB 이하');}arrays.push(value);}const bytes=new Uint8Array(size);let at=0;for(const arr of arrays){bytes.set(arr,at);at+=arr.length;}return bytes;}
async function recoveryEvidence(env,id,index){
 const chunk=await env.DB.prepare('SELECT state,result_json FROM yta_audio WHERE job_id=? AND chunk_index=?').bind(id,index).first();
 if(!chunk||chunk.state!=='UNCERTAIN')throw new ProviderError('RECOVERY_NOT_ELIGIBLE','검토할 미확정 음성 조각이 없습니다.');
 const fileSha256=JSON.parse(chunk.result_json||'{}').fileSha256;
 if(!/^[a-f0-9]{64}$/.test(fileSha256||''))throw new ProviderError('AUDIO_FILE_MISMATCH','원본 파일 지문을 확인할 수 없습니다.');
 const base=id+':audio:'+index;
 const rows=(await env.DB.prepare("SELECT id,provider,state,error_code,created_at FROM yta_operations WHERE job_id=? AND provider IN ('groq','gemini') AND id LIKE ? ORDER BY created_at DESC").bind(id,base+'%').all()).results||[];
 const retryOperationId=base+':reviewed404:1',retry=rows.find(row=>row.id===retryOperationId);
 if(retry&&!(retry.state==='BLOCKED'&&['QUOTA_EXHAUSTED','PRE_DISPATCH_BLOCKED','CAPACITY_WAIT','PROBE_PRE_DISPATCH_BLOCKED'].includes(retry.error_code)))throw new ProviderError('RECOVERY_NOT_ELIGIBLE','재개 시도가 이미 전송됐거나 결과가 불명확합니다.');
 const attempts=[...audioAttempts(rows,id,index,'groq'),...audioAttempts(rows,id,index,'gemini')].filter(row=>row.id!==retryOperationId).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
 const latest=attempts[0],groq=attempts.find(row=>row.provider==='groq'&&row.state==='FAILED_UNCERTAIN'&&row.error_code==='429');
 if(attempts.length!==2||latest?.id!==base+':gemini:0'||latest.provider!=='gemini'||latest.state!=='FAILED_UNCERTAIN'||latest.error_code!=='404'||groq?.id!==base||attempts.some(row=>row.state==='CLAIMED'||row.state==='DONE'))throw new ProviderError('RECOVERY_NOT_ELIGIBLE','Groq 429 뒤 Gemini 404인 미확정 조각만 수동 검토할 수 있습니다.');
 return {jobId:id,index,fileSha256,geminiOperationId:latest.id,groq429OperationId:groq.id,retryOperationId};
}
async function ensureFreeRecoverySchema(env){
 const row=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='yta_free_recovery'").bind().first();
 if(!row)throw new ProviderError('RECOVERY_SCHEMA_REQUIRED','검토형 무료 재개 테이블이 필요합니다.');
}
async function ensureFreeProbeSchema(env){
 const row=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='yta_free_probe'").bind().first();
 if(!row)throw new ProviderError('PROBE_SCHEMA_REQUIRED','무료 탐침 승인 테이블이 필요합니다.');
}
async function validateGroqProbeLedger(env){
 const invalid=()=>{const error=new ProviderError('PROBE_LEDGER_REVIEW_REQUIRED','Groq 앱 사용 이력에 잘못된 값이 있어 무료 탐침을 중단했습니다. 이력을 먼저 검토하세요.');error.preDispatchBlocked=true;throw error;};
 const rows=(await env.DB.prepare("SELECT id,units,state,created_at,error_code FROM yta_operations WHERE provider='groq' LIMIT 10001").bind().all()).results||[];
 if(rows.length>10000)invalid();
 for(const row of rows){
  const parsed=Date.parse(row.created_at);
  if(typeof row.id!=='string'||!row.id||!Number.isSafeInteger(row.units)||row.units<=0||row.units>GROQ_APP_DAILY_CAP_SECONDS||!['CLAIMED','DONE','FAILED_UNCERTAIN','BLOCKED'].includes(row.state)||typeof row.created_at!=='string'||!Number.isFinite(parsed)||new Date(parsed).toISOString()!==row.created_at||parsed>Date.now()+300000||!(row.error_code===null||typeof row.error_code==='string'))invalid();
 }
}
async function assertProbeReady(env,{jobId,index,operationId,keyIdentity,expiresAt}){
 const blocked=()=>{const error=new ProviderError('PROBE_REVIEW_REQUIRED','1회 무료 탐침 승인 또는 현재 키 상태가 바뀌었습니다.');error.preDispatchBlocked=true;throw error;};
 if(env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true'||expiresAt<=Date.now())blocked();
 const probe=await env.DB.prepare('SELECT state,key_identity,expires_at FROM yta_free_probe WHERE job_id=? AND chunk_index=?').bind(jobId,index).first();
 const recovery=await env.DB.prepare('SELECT state,retry_operation_id FROM yta_free_recovery WHERE job_id=? AND chunk_index=?').bind(jobId,index).first();
 const chunk=await env.DB.prepare('SELECT state FROM yta_audio WHERE job_id=? AND chunk_index=?').bind(jobId,index).first();
 const own=await env.DB.prepare('SELECT state FROM yta_operations WHERE id=?').bind(operationId).first();
 if(probe?.state!=='CLAIMED'||probe.key_identity!==keyIdentity||probe.expires_at!==expiresAt||recovery?.state!=='CLAIMED'||recovery.retry_operation_id!==operationId||chunk?.state!=='CLAIMED'||own?.state!=='CLAIMED'||await capacityIdentity(env,'groq')!==keyIdentity)blocked();
 await validateGroqProbeLedger(env);
 const cutoff=new Date(Date.now()-GROQ_HOURLY_WINDOW_MS).toISOString();
 const other=await env.DB.prepare("SELECT 1 FROM yta_operations WHERE provider='groq' AND state='CLAIMED' AND id<>? LIMIT 1").bind(operationId).first();
 const cooldown=await env.DB.prepare("SELECT 1 FROM yta_operations WHERE provider='groq' AND state='FAILED_UNCERTAIN' AND error_code='429' AND created_at>? LIMIT 1").bind(cutoff).first();
 const used=await env.DB.prepare("SELECT COALESCE(SUM(units),0) AS units FROM yta_operations WHERE provider='groq' AND (state='CLAIMED' OR (state IN ('DONE','FAILED_UNCERTAIN') AND created_at>?))").bind(cutoff).first();
 const daily=await env.DB.prepare("SELECT COALESCE(SUM(units),0) AS units FROM yta_operations WHERE provider='groq' AND (state='CLAIMED' OR (state IN ('DONE','FAILED_UNCERTAIN') AND created_at>?))").bind(new Date(Date.now()-86_400_000).toISOString()).first();
 const minute=await env.DB.prepare("SELECT 1 FROM yta_operations WHERE provider='groq' AND state IN ('DONE','FAILED_UNCERTAIN') AND created_at>? AND id<>? LIMIT 1").bind(new Date(Date.now()-60_000).toISOString(),operationId).first();
 if(other||cooldown||minute||Number(used?.units||0)>GROQ_APP_HOURLY_CAP_SECONDS||Number(daily?.units||0)>GROQ_APP_DAILY_CAP_SECONDS)blocked();
 const finalAuthorization=await env.DB.prepare("SELECT 1 AS ok FROM yta_free_probe p JOIN yta_free_recovery r ON r.job_id=p.job_id AND r.chunk_index=p.chunk_index JOIN yta_audio a ON a.job_id=p.job_id AND a.chunk_index=p.chunk_index JOIN yta_operations o ON o.id=p.retry_operation_id WHERE p.job_id=? AND p.chunk_index=? AND p.state='CLAIMED' AND r.state='CLAIMED' AND a.state='CLAIMED' AND o.state='CLAIMED' AND p.retry_operation_id=? AND p.key_identity=? AND p.expires_at=?").bind(jobId,index,operationId,keyIdentity,expiresAt).first();
 if(!finalAuthorization)blocked();
 // No await after this check before the adapter starts its fetch. D1 reads may outlive the approval.
 if(Date.now()>=expiresAt||env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true')blocked();
}
async function executeGroqProbe(env,{jobId,index,operationId,units,probe,bytes}){
 const now=new Date().toISOString(),cutoff=new Date(Date.now()-GROQ_HOURLY_WINDOW_MS).toISOString(),dailyCutoff=new Date(Date.now()-86_400_000).toISOString(),minuteCutoff=new Date(Date.now()-60_000).toISOString();
 await validateGroqProbeLedger(env);
 const prior=await env.DB.prepare('SELECT state,error_code FROM yta_operations WHERE id=?').bind(operationId).first();
 if(prior&&!(prior.state==='BLOCKED'&&['QUOTA_EXHAUSTED','PRE_DISPATCH_BLOCKED','CAPACITY_WAIT','PROBE_PRE_DISPATCH_BLOCKED'].includes(prior.error_code)))throw new ProviderError('OPERATION_REVIEW_REQUIRED','이 탐침의 이전 요청 결과를 검토하세요.');
 const claim=prior?await env.DB.prepare(`UPDATE yta_operations SET state='CLAIMED',error_code=NULL,created_at=? WHERE id=? AND state='BLOCKED' AND ${groqProbePermit}`).bind(now,operationId,cutoff,cutoff,units,GROQ_APP_HOURLY_CAP_SECONDS,dailyCutoff,units,GROQ_APP_DAILY_CAP_SECONDS,minuteCutoff).run():await env.DB.prepare(`INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at) SELECT ?,?,'groq',?,'CLAIMED',? WHERE ${groqProbePermit}`).bind(operationId,jobId,units,now,cutoff,cutoff,units,GROQ_APP_HOURLY_CAP_SECONDS,dailyCutoff,units,GROQ_APP_DAILY_CAP_SECONDS,minuteCutoff).run();
 if(claim.meta?.changes!==1)throw new ProviderError('PROBE_LOCAL_LIMIT','진행 중 요청, 429 대기 또는 앱 시간당 사용 상한으로 탐침을 전송할 수 없습니다.');
 const active={...env,GROQ_FREE_PLAN_CONFIRMED:'true'};
 try{
  await assertProbeReady(env,{jobId,index,operationId,keyIdentity:probe.key_identity,expiresAt:probe.expires_at});
  const result=await runOwnedAudioTranscription({env:active,bytes,name:'chunk.mp3',mime:'audio/mpeg',durationSeconds:units,beforeDispatch:()=>assertProbeReady(env,{jobId,index,operationId,keyIdentity:probe.key_identity,expiresAt:probe.expires_at}),beforeFetch:()=>assertProbeReady(env,{jobId,index,operationId,keyIdentity:probe.key_identity,expiresAt:probe.expires_at})});
  await env.DB.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),jobId,'owner','groq','LIVE_FREE_PROBE','audio_seconds',units,0,null,'APP_RESERVED_ACCOUNT_CAPACITY_UNKNOWN',new Date().toISOString()).run();
  await env.DB.prepare('UPDATE yta_operations SET state=?,result_json=?,created_at=? WHERE id=?').bind('DONE',JSON.stringify(result),new Date().toISOString(),operationId).run();
  return result;
 }catch(error){
  const blocked=error.preDispatchBlocked===true;
  await env.DB.prepare('UPDATE yta_operations SET state=?,error_code=?,created_at=?,result_json=? WHERE id=? AND state=?').bind(blocked?'BLOCKED':'FAILED_UNCERTAIN',blocked?'PROBE_PRE_DISPATCH_BLOCKED':String(error.code||'PROCESSING_FAILED'),new Date().toISOString(),blocked?null:JSON.stringify({safeRateLimit:error.safeRateLimit??null,reviewResult:error.reviewResult??null}),operationId,'CLAIMED').run();
  error.probeSafeMetadata=error.safeRateLimit??null;
  throw error;
 }
}
async function ensureFreeBatchSchema(env){
 const rows=(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('yta_free_batches','yta_free_batch_chunks')").bind().all()).results||[];
 if(rows.length!==2||typeof env.DB.batch!=='function')throw new ProviderError('FREE_BATCH_SCHEMA_REQUIRED','제한형 무료 배치 테이블과 원자적 저장이 필요합니다.');
}
function validFreeBatchExpiry(batch,now=Date.now()){
 const approvedAt=Date.parse(batch?.approved_at);
 return Number.isSafeInteger(batch?.expires_at)&&Number.isSafeInteger(approvedAt)&&approvedAt<=now&&batch.expires_at>now&&batch.expires_at>approvedAt&&batch.expires_at<=approvedAt+3_600_000;
}
function assertUsableFreeBatchTranscript(result,duration){
 const segments=result?.segments;
 if(result?.provider!=='groq'||result.model!=='whisper-large-v3-turbo'||typeof result.text!=='string'||!result.text.trim()||!Array.isArray(segments)||!segments.length||segments.length>1000||segments.some((part,i)=>!part||typeof part.text!=='string'||!part.text.trim()||part.text.length>2000||typeof part.start!=='number'||typeof part.end!=='number'||!Number.isFinite(part.start)||!Number.isFinite(part.end)||part.start<0||part.end<=part.start||part.end>duration+1||(i>0&&(part.start<segments[i-1].start||part.end<segments[i-1].end))))throw new ProviderError('AUDIO_RESPONSE_INVALID','Groq 전사 구간과 원문 형식이 유효하지 않습니다. 요청 이력을 검토하세요.');
}
async function freeBatchPlan(env,job){
 if(job.source_type!=='audio'||!Number.isFinite(job.duration_seconds)||job.duration_seconds<=0)throw new ProviderError('FREE_BATCH_PLAN_INVALID','보유 음성 계획을 확인하세요.');
 const rows=(await env.DB.prepare('SELECT chunk_index,start_sec,end_sec,state,result_json FROM yta_audio WHERE job_id=? ORDER BY chunk_index').bind(job.id).all()).results||[];
 if(!rows.length||rows.length>160)throw new ProviderError('FREE_BATCH_PLAN_INVALID','전체 조각 계획을 확인하세요.');
 let edge=0,fileSha256=null;
 for(let i=0;i<rows.length;i++){
  const row=rows[i];let stored;try{stored=JSON.parse(row.result_json);}catch{throw new ProviderError('FREE_BATCH_PLAN_INVALID','조각의 원본 파일 기록을 확인하세요.');}
  if(row.chunk_index!==i||!['DONE','PLANNED'].includes(row.state)||!Number.isFinite(row.start_sec)||!Number.isFinite(row.end_sec)||row.start_sec<Math.max(0,edge-5)||row.start_sec>edge+.01||row.end_sec<=row.start_sec||(i>0&&row.end_sec<=edge)||row.end_sec-row.start_sec>601||row.end_sec>job.duration_seconds+2||!(/^[a-f0-9]{64}$/.test(stored?.fileSha256??''))||(fileSha256&&stored.fileSha256!==fileSha256))throw new ProviderError('FREE_BATCH_PLAN_INVALID','전체 조각·파일 지문·완료 상태가 일치하지 않습니다.');
  fileSha256=stored.fileSha256;edge=Math.max(edge,row.end_sec);
 }
 if(Math.abs(edge-job.duration_seconds)>2)throw new ProviderError('FREE_BATCH_PLAN_INVALID','전체 음성 시간축을 확인하세요.');
 const planned=rows.filter(row=>row.state==='PLANNED');
 if(!planned.length)throw new ProviderError('FREE_BATCH_NOT_NEEDED','남은 계획 조각이 없습니다.');
 for(const row of planned){const operationBase=job.id+':audio:'+row.chunk_index,prior=await env.DB.prepare('SELECT 1 FROM yta_operations WHERE job_id=? AND (id=? OR id LIKE ?) LIMIT 1').bind(job.id,operationBase,operationBase+':%').first();if(prior)throw new ProviderError('FREE_BATCH_PLAN_INVALID','남은 조각의 기존 요청을 먼저 검토하세요.');}
 const chunkIds=planned.map(row=>row.chunk_index),units=planned.map(row=>Math.max(10,Math.ceil(row.end_sec-row.start_sec)));
 const maxAudioSeconds=units.reduce((sum,value)=>sum+value,0);
 if(maxAudioSeconds>GROQ_APP_DAILY_CAP_SECONDS)throw new ProviderError('FREE_BATCH_PLAN_INVALID','요청 총량이 앱 일일 상한을 넘습니다.');
 return {jobId:job.id,fileSha256,model:'whisper-large-v3-turbo',chunkIds,maxRequests:chunkIds.length,maxAudioSeconds,units,accountRemaining:'UNKNOWN',automaticDispatch:false,summaryIncluded:false};
}
async function assertFreeBatchReady(env,{jobId,index,operationId,keyIdentity,expiresAt,units,chunkIdsJson}){
 const blocked=()=>{const error=new ProviderError('FREE_BATCH_REVIEW_REQUIRED','배치 승인·키·조각 또는 만료 상태가 바뀌었습니다.');error.preDispatchBlocked=true;throw error;};
 if(env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true'||!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now())blocked();
 const batch=await env.DB.prepare('SELECT * FROM yta_free_batches WHERE job_id=?').bind(jobId).first();
 const row=await env.DB.prepare('SELECT state,units,operation_id FROM yta_free_batch_chunks WHERE job_id=? AND chunk_index=?').bind(jobId,index).first();
 const audio=await env.DB.prepare('SELECT state,result_json FROM yta_audio WHERE job_id=? AND chunk_index=?').bind(jobId,index).first();
 const op=await env.DB.prepare('SELECT state,provider,units FROM yta_operations WHERE id=? AND job_id=?').bind(operationId,jobId).first();
 let stored;try{stored=JSON.parse(audio?.result_json);}catch{blocked();}
 let ids;try{ids=JSON.parse(batch?.chunk_ids_json);}catch{blocked();}
 const scopeRows=(await env.DB.prepare('SELECT chunk_index,units,state FROM yta_free_batch_chunks WHERE job_id=? ORDER BY chunk_index').bind(jobId).all()).results||[];
 if(batch?.owner_id!=='owner'||batch.state!=='APPROVED'||!validFreeBatchExpiry(batch)||batch.model!=='whisper-large-v3-turbo'||batch.free_tier_confirmed!==1||batch.billing_disabled!==1||batch.key_identity!==keyIdentity||batch.expires_at!==expiresAt||batch.chunk_ids_json!==chunkIdsJson||!Array.isArray(ids)||JSON.stringify(ids)!==JSON.stringify(scopeRows.map(item=>item.chunk_index))||scopeRows.some(item=>!Number.isSafeInteger(item.units)||item.units<10||item.units>601||!['APPROVED','CLAIMED','DONE'].includes(item.state))||scopeRows.length!==batch.max_requests||scopeRows.reduce((sum,item)=>sum+item.units,0)!==batch.max_audio_seconds||!ids.includes(index)||row?.state!=='CLAIMED'||row.units!==units||row.operation_id!==operationId||audio?.state!=='CLAIMED'||stored?.fileSha256!==batch.file_sha256||op?.state!=='CLAIMED'||op.provider!=='groq'||op.units!==units||await capacityIdentity(env,'groq')!==keyIdentity)blocked();
 await validateGroqProbeLedger(env);
 const cutoff=new Date(Date.now()-GROQ_HOURLY_WINDOW_MS).toISOString();
 const other=await env.DB.prepare("SELECT 1 FROM yta_operations WHERE provider='groq' AND state='CLAIMED' AND id<>? LIMIT 1").bind(operationId).first();
 const cooldown=await env.DB.prepare("SELECT 1 FROM yta_operations WHERE provider='groq' AND state='FAILED_UNCERTAIN' AND error_code='429' AND created_at>? LIMIT 1").bind(cutoff).first();
 const used=await env.DB.prepare("SELECT COALESCE(SUM(units),0) AS units FROM yta_operations WHERE provider='groq' AND (state='CLAIMED' OR (state IN ('DONE','FAILED_UNCERTAIN') AND created_at>?))").bind(cutoff).first();
 const daily=await env.DB.prepare("SELECT COALESCE(SUM(units),0) AS units FROM yta_operations WHERE provider='groq' AND (state='CLAIMED' OR (state IN ('DONE','FAILED_UNCERTAIN') AND created_at>?))").bind(new Date(Date.now()-86_400_000).toISOString()).first();
 if(other||cooldown||Number(used?.units||0)>GROQ_APP_HOURLY_CAP_SECONDS||Number(daily?.units||0)>GROQ_APP_DAILY_CAP_SECONDS)blocked();
 let final;try{final=await env.DB.prepare("SELECT 1 AS ok FROM yta_free_batches b JOIN yta_free_batch_chunks c ON c.job_id=b.job_id JOIN yta_audio a ON a.job_id=c.job_id AND a.chunk_index=c.chunk_index JOIN yta_operations o ON o.id=c.operation_id AND o.job_id=b.job_id WHERE b.job_id=? AND b.owner_id='owner' AND b.state='APPROVED' AND b.model='whisper-large-v3-turbo' AND b.free_tier_confirmed=1 AND b.billing_disabled=1 AND typeof(b.expires_at)='integer' AND b.approved_at=? AND b.expires_at>? AND b.max_requests=(SELECT COUNT(*) FROM yta_free_batch_chunks WHERE job_id=b.job_id) AND b.max_audio_seconds=(SELECT COALESCE(SUM(units),0) FROM yta_free_batch_chunks WHERE job_id=b.job_id) AND b.file_sha256=json_extract(a.result_json,'$.fileSha256') AND b.chunk_ids_json=? AND b.key_identity=? AND b.expires_at=? AND c.chunk_index=? AND c.state='CLAIMED' AND c.units=? AND c.operation_id=? AND a.state='CLAIMED' AND o.state='CLAIMED'").bind(jobId,batch.approved_at,Date.now(),chunkIdsJson,keyIdentity,expiresAt,index,units,operationId).first();}catch{blocked();}
 if(!final||Date.now()>=expiresAt||env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true')blocked();
}
async function executeFreeBatchChunk(env,{jobId,index,operationId,units,batch,bytes,duration}){
 await validateGroqProbeLedger(env);
 const now=new Date().toISOString(),cutoff=new Date(Date.now()-GROQ_HOURLY_WINDOW_MS).toISOString(),dailyCutoff=new Date(Date.now()-86_400_000).toISOString(),minuteCutoff=new Date(Date.now()-60_000).toISOString();
 const prior=await env.DB.prepare('SELECT state,error_code FROM yta_operations WHERE id=?').bind(operationId).first();
 if(prior&&!(prior.state==='BLOCKED'&&prior.error_code==='FREE_BATCH_PRE_DISPATCH_BLOCKED'))throw new ProviderError('OPERATION_REVIEW_REQUIRED','기존 전송 기록을 검토하세요.');
 const claim=prior?await env.DB.prepare(`UPDATE yta_operations SET state='CLAIMED',error_code=NULL,created_at=? WHERE id=? AND state='BLOCKED' AND error_code='FREE_BATCH_PRE_DISPATCH_BLOCKED' AND ${groqProbePermit}`).bind(now,operationId,cutoff,cutoff,units,GROQ_APP_HOURLY_CAP_SECONDS,dailyCutoff,units,GROQ_APP_DAILY_CAP_SECONDS,minuteCutoff).run():await env.DB.prepare(`INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at) SELECT ?,?,'groq',?,'CLAIMED',? WHERE ${groqProbePermit}`).bind(operationId,jobId,units,now,cutoff,cutoff,units,GROQ_APP_HOURLY_CAP_SECONDS,dailyCutoff,units,GROQ_APP_DAILY_CAP_SECONDS,minuteCutoff).run();
 if(claim.meta?.changes!==1)throw new ProviderError('FREE_BATCH_LOCAL_LIMIT','진행 중 요청, 429 대기 또는 앱 사용 상한을 확인하세요.');
 const active={...env,GROQ_FREE_PLAN_CONFIRMED:'true'};
 try{
  const guard=()=>assertFreeBatchReady(env,{jobId,index,operationId,keyIdentity:batch.key_identity,expiresAt:batch.expires_at,units,chunkIdsJson:batch.chunk_ids_json});
  await guard();
  const result=await runOwnedAudioTranscription({env:active,bytes,name:'chunk.mp3',mime:'audio/mpeg',durationSeconds:duration,beforeDispatch:guard,beforeFetch:guard});
  assertUsableFreeBatchTranscript(result,duration);
  await env.DB.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),jobId,'owner','groq','LIVE_FREE_BATCH','audio_seconds',units,0,null,'APP_RESERVED_ACCOUNT_CAPACITY_UNKNOWN',new Date().toISOString()).run();
  await env.DB.prepare("UPDATE yta_operations SET state='DONE',result_json=?,created_at=? WHERE id=? AND state='CLAIMED'").bind(JSON.stringify(result),new Date().toISOString(),operationId).run();
  return result;
 }catch(error){
  const blocked=error.preDispatchBlocked===true;
  await env.DB.prepare("UPDATE yta_operations SET state=?,error_code=?,created_at=? WHERE id=? AND state='CLAIMED'").bind(blocked?'BLOCKED':'FAILED_UNCERTAIN',blocked?'FREE_BATCH_PRE_DISPATCH_BLOCKED':String(error.code||'PROCESSING_FAILED'),new Date().toISOString(),operationId).run();
  throw error;
 }
}
export async function routeLive(request,env){
 const url=new URL(request.url),path=url.pathname;
 if(!(request.method==='DELETE'&&/^\/api\/jobs\/[0-9a-f-]{36}$/i.test(path))&&!path.startsWith('/api/live/')&&!/\/(native|native-poll|summary|summary-plan|summary-review|summary-choice|paid-summary-quote|paid-summary-approve|paid-summary-status|paid-summary-cancel|paid-summary-revalidate|paid-summary-execute|gemini-two-pass-status|gemini-two-pass-quote|gemini-two-pass-approve|gemini-two-pass-run|gemini-two-pass-recover|gemini-two-pass-cancel|groq-summary|groq-summary-plan|groq-summary-approval|groq-summary-status|groq-summary-failure-diagnostic|groq-summary-stage-diagnostic|groq-summary-correction|groq-summary-pilot|groq-summary-checkpoint-recovery|groq-summary-bundle|groq-summary-gap|groq-summary-gap-bundle|groq-summary-complete|source|export|audio-plan|audio-consent|audio-progress|audio-review|audio-recovery|audio-free-probe|audio-free-batch|audio-chunk|audio-finish|audio-boundary-reconcile|audio-cleanup)$/.test(path))return null;
 if(request.method==='POST'&&/\/(groq-summary|groq-summary-gap|groq-summary-complete|groq-summary-correction)$/.test(path)&&env.DB){const budget=groqD1Budget(env.DB);env={...env,DB:budget.DB,GROQ_D1_BUDGET:budget};}
 try{
 if(request.method==='DELETE'&&/^\/api\/jobs\/[0-9a-f-]{36}$/i.test(path)){await ensureLiveSchema(env);const id=path.split('/').pop(),owner=await env.DB.prepare('SELECT 1 AS ok FROM jobs WHERE id=? AND owner_id=?').bind(id,'owner').first();if(!owner)throw new ProviderError('NOT_FOUND','분석 기록 없음');
  const job=await ownedJob(env,id);let settlements;try{settlements=await prepareGroqSettlementsForDeletion(env,id,job,sourceOf);}catch{settlements={source:null,candidates:[]};}
  // Durable tombstone is written before any private content is cleared. Late provider responses must observe it in their own UPDATE statement.
  await env.DB.prepare("INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at) SELECT ?,?,'deletion',0,'DELETING',? WHERE EXISTS (SELECT 1 FROM jobs WHERE id=? AND owner_id=?)").bind(id+':deleting',id,new Date().toISOString(),id,'owner').run();
  const marker=await env.DB.prepare('SELECT provider,state FROM yta_operations WHERE id=? AND job_id=?').bind(id+':deleting',id).first();if(marker?.provider!=='deletion'||marker.state!=='DELETING')throw new ProviderError('DELETE_MARKER_INVALID','삭제 상태를 검토하세요.');
  const receiptTable=await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='yta_paid_summary_receipts'").bind().first();
  if(receiptTable)await env.DB.prepare("UPDATE yta_paid_summary_receipts SET response_json=NULL,response_sha256=NULL,response_complete=0,state='SOURCE_DELETED',error_code='PAID_SOURCE_DELETED',updated_at=? WHERE job_id=? AND owner_id='owner'").bind(new Date().toISOString(),id).run();
  try{await persistGroqSettlementsForDeletion(env,id,job,settlements);}catch{} // A failed accounting seal must not retain private source content.
  for(const table of ['yta_sources','yta_audio'])await env.DB.prepare('DELETE FROM '+table+' WHERE job_id=?').bind(id).run();for(const table of ['yta_gemini_two_pass_calls','yta_gemini_two_pass_jobs','yta_wait','yta_free_recovery','yta_free_probe','yta_free_batch_chunks','yta_free_batches']){const exists=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first();if(exists)await env.DB.prepare('DELETE FROM '+table+' WHERE job_id=?').bind(id).run();}await env.DB.prepare("UPDATE yta_operations SET result_json=NULL WHERE job_id=? AND provider!='groq-summary-settlement'").bind(id).run();await env.DB.prepare('DELETE FROM jobs WHERE id=? AND owner_id=?').bind(id,'owner').run();return json({deleted:true,id});}
  await ensureLiveSchema(env);
  if(path==='/api/live/capacity'&&request.method==='PUT')return json(await recordCapacity(env,await readJson(request)));
  if(path==='/api/live/capacity'&&request.method==='GET'){await ensureCapacitySchema(env);const snapshots=(await env.DB.prepare('SELECT provider,model,source,observed_at,valid_until,reset_json,remaining_json,reserved_json FROM yta_capacity').bind().all()).results||[];return json({snapshots:await Promise.all(snapshots.map(async row=>({...row,source:row.source.split(':')[0],valid_until:await capacityIdentityMatches(env,row.provider,row.source)?row.valid_until:0,reset:JSON.parse(row.reset_json),remaining:JSON.parse(row.remaining_json),reserved:JSON.parse(row.reserved_json),reset_json:undefined,remaining_json:undefined,reserved_json:undefined})))});}
  if(path==='/api/live/quota'&&request.method==='GET')return json({grants:(await env.DB.prepare('SELECT * FROM yta_quota').bind().all()).results||[],liveEnabled:env.ENABLE_LIVE_FREE==='true',budgetUSD:0,provenance:'OWNER_ATTESTED_APP_GRANT_NOT_PROVIDER_VERIFIED'});
  if(path==='/api/live/quota'&&request.method==='DELETE'){const body=await readJson(request);if(!['supadata','gemini','groq'].includes(body.provider))throw new InputError('제공자 오류');await env.DB.prepare('UPDATE yta_quota SET expires_at=0 WHERE provider=?').bind(body.provider).run();return json({revoked:true});}
  if(path==='/api/live/quota'&&request.method==='PUT'){
   const body=await readJson(request),provider=body.provider;
   if(!['supadata','gemini','groq'].includes(provider)||body.billingDisabled!==true||body.freeOnly!==true)throw new InputError('무료 전용·결제 비활성 확인이 필요합니다.');
   const caps={supadata:100,groq:28800,gemini:250000};
   if(!Number.isFinite(body.allowance)||body.allowance<=0||body.allowance>caps[provider]||!Number.isInteger(body.requestLimit)||body.requestLimit<1||body.requestLimit>100)throw new InputError('무료 잔여량/요청 수를 확인하세요.');
   // Conditional database writes prevent concurrent renewals from erasing a new reservation.
   const now=Date.now(),renewed=await env.DB.prepare('UPDATE yta_quota SET allowance=?,consumed=0,request_limit=?,request_count=0,expires_at=?,confirmed_at=?,billing_disabled=1 WHERE provider=? AND expires_at<=?').bind(body.allowance,body.requestLimit,now+3600000,now,provider,now).run();
   if(renewed.meta?.changes!==1){const inserted=await env.DB.prepare('INSERT OR IGNORE INTO yta_quota(provider,allowance,consumed,request_limit,request_count,expires_at,confirmed_at,billing_disabled) VALUES(?,?,0,?,0,?,?,1)').bind(provider,body.allowance,body.requestLimit,now+3600000,now).run();if(inserted.meta?.changes!==1)throw new ProviderError('ACTIVE_GRANT_EXISTS','현재 할당이 유효합니다. 중복 설정으로 사용량을 초기화할 수 없습니다.');}
   return json({configured:true,provider,expiresInSeconds:3600,verification:'OWNER_ATTESTED_NOT_INDEPENDENTLY_VERIFIED'});
  }
  const match=path.match(/^\/api\/jobs\/([0-9a-f-]{36})\/(native|native-poll|summary|summary-plan|summary-review|summary-choice|paid-summary-quote|paid-summary-approve|paid-summary-status|paid-summary-cancel|paid-summary-revalidate|paid-summary-execute|gemini-two-pass-status|gemini-two-pass-quote|gemini-two-pass-approve|gemini-two-pass-run|gemini-two-pass-recover|gemini-two-pass-cancel|groq-summary|groq-summary-plan|groq-summary-approval|groq-summary-status|groq-summary-failure-diagnostic|groq-summary-stage-diagnostic|groq-summary-correction|groq-summary-pilot|groq-summary-checkpoint-recovery|groq-summary-bundle|groq-summary-gap|groq-summary-gap-bundle|groq-summary-complete|source|export|audio-plan|audio-consent|audio-progress|audio-review|audio-recovery|audio-free-probe|audio-free-batch|audio-chunk|audio-finish|audio-boundary-reconcile|audio-cleanup)$/i);if(!match)return json({error:{code:'NOT_FOUND'}},404);
  const id=match[1],action=match[2],job=await ownedJob(env,id);
  if(action.startsWith('groq-summary'))return await handleGroqSummaryAction(request,env,{id,action,job,sourceOf,ownedJob});
  if(action.startsWith('paid-summary'))return await handlePaidSummaryAction(request,env,{id,action,job,sourceOf,ownedJob});
  if(action.startsWith('gemini-two-pass'))return await handleGeminiTwoPassAction(request,env,{id,action,job,sourceOf,ownedJob});
  if(action==='summary-choice'&&request.method==='GET'){
   const source=await sourceOf(env,id),complete=job.audit?.audioProcessingCoverage===1&&Array.isArray(source?.segments)&&source.segments.length>0;
   const groups=complete?partitionGroqTranscript(source.segments,promptAudit(job)):[];
   const sourceScope=complete?await completeSource(env,job,sourceOf):null,transcriptHash=sourceScope?.transcriptHash??null,stagePrefix=id+':groq-summary:'+transcriptHash+':';
   const rows=complete?(await env.DB.prepare("SELECT id,state FROM yta_operations WHERE job_id=? AND provider='groq-summary' AND substr(id,1,length(?))=?").bind(id,stagePrefix,stagePrefix).all()).results||[]:[];
   const recovered=complete&&await validatedRecoveredFirstCheckpoint(env,{id,job,source,transcriptHash,legacyTranscriptHash:sourceScope.legacyTranscriptHash});
   const savedRaw=groups.filter((_,index)=>rows.some(row=>row.id===stagePrefix+'raw:'+index&&row.state==='DONE')||(index===0&&recovered)).length;
   const paid=PAID_SUMMARY_CATALOG,paidTables=(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('yta_paid_summary_quotes','yta_paid_summary_approvals','yta_paid_summary_reservations')").all()).results||[],paidKey=await env.DB.prepare("SELECT 1 AS ok FROM provider_credentials WHERE owner_id='owner' AND provider='gemini'").first();
   let paidRequest=null,paidEstimate=null;
   if(complete)try{paidRequest=fullSummaryRequest(sourceScope.source,promptAudit(job));paidEstimate=paidRequestCostPreview(paidRequest);}catch{paidRequest=null;}
   return json({jobId:id,transcription:{complete,remainingChunks:complete?0:'UNKNOWN',repeatRequired:false},summary:{complete:!!job.report,rawStages:groups.length,savedRawStages:savedRaw,remainingRawStages:groups.length-savedRaw,requestedOutput:'FULL_VIDEO_SYNTHESIS',intermediateOutput:'RAW_CHECKPOINT_BUNDLE'},free:{model:GROQ_SUMMARY_MODEL,inputTokensUpperPerCall:GROQ_SUMMARY_INPUT_BOUND,outputTokensUpperPerCall:GROQ_SUMMARY_COMPLETION_CAP,accountRemaining:'UNKNOWN',eta:{status:'UNKNOWN',reason:'검증된 남은 계정 용량과 실제 단계별 대기 시간이 없습니다.'},automaticPaidFallback:false},paid:{executionEnabled:paidExecutionEnabled(env),quoteIssueReady:paidTables.length===3&&!!paidKey&&!!paidRequest&&!job.report,quoteStatus:'CATALOG_CANDIDATE',reason:'공식 가격표 기반 코드 후보입니다. 이 계정의 모델 사용 가능성과 잔액은 미검증입니다.',model:paid.model,priceVersion:paid.priceVersion,priceSource:paid.priceSource,inputTokensUpper:paidRequest?.inputChargeCeiling??null,outputTokensUpper:paidRequest?.outputChargeCeiling??null,requestBytes:paidRequest?.requestBytes??null,costEstimate:paidEstimate,maxRetries:0,maxTaxBps:10000,taxAllowanceKind:'APP_BUDGET_BUFFER_NOT_ACTUAL_TAX_RATE',maxMicroUsd:paidEstimate?.reservationWithBufferMicroUsd??null,eta:{status:'UNKNOWN',reason:'계정 모델 사용 가능성과 실제 처리 시간 관측치가 없습니다.'},automaticFreeFallback:false}});
  }
  if(action==='source'&&request.method==='GET')return json({source:await sourceOf(env,id),...boundaryAuditView(job.audit)});
  if(action==='export'&&request.method==='GET'){
   const source=await sourceOf(env,id),text=markdownReport(job,source);return new Response(text,{headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','content-disposition':'attachment; filename="analysis-'+id+(url.searchParams.get('format')==='txt'?'.txt':'.md')+'"'}});
  }
  if(action==='native'&&request.method==='POST'){
   if(!job.source_url)throw new InputError('URL 입력 작업만 자막 조회 가능');
   const response=await execute(env,{id:id+':native',job:id,provider:'supadata',units:1},active=>runNativeCaption({env:active,url:job.source_url}));
   if(response.status!=='TRANSCRIPT_AVAILABLE'||!response.segments.length){await updateJob(env,id,response.status==='PENDING'?'NATIVE_PENDING':'NEED_UPLOAD',null,{status:response.status,reason:'기존 자막을 확보하지 못했습니다. 사용자가 보유한 음성/스크립트를 사용하세요.',providerJobId:response.jobId||null});return json({job:await ownedJob(env,id),persisted:true},202);}
   return json(await storeTranscriptResult(env,job,response.segments,'SUPADATA_NATIVE', {providerCompleteness:'NOT_INDEPENDENTLY_VERIFIED'}));
  }
  if(action==='native-poll'&&request.method==='POST'){
   if(job.source_type!=='url'||job.status!=='NATIVE_PENDING'||typeof job.audit?.providerJobId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(job.audit.providerJobId))throw new InputError('조회할 Supadata 자막 대기 작업이 없습니다.');
   const active=await grantEnv(env,'supadata');
   const reserve=await env.DB.prepare('UPDATE yta_quota SET consumed=consumed+1,request_count=request_count+1 WHERE provider=? AND consumed+1<=allowance AND request_count<request_limit AND expires_at>?').bind('supadata',Date.now()).run();
   if(reserve.meta?.changes!==1)throw new ProviderError('QUOTA_EXHAUSTED','조회용 무료 할당 부족');
   const result=await runNativePoll({env:active,jobId:job.audit.providerJobId});
   if(result.status==='TRANSCRIPT_AVAILABLE')return json(await storeTranscriptResult(env,job,result.segments,'SUPADATA_NATIVE'));
   if(result.status==='NO_CAPTIONS')await updateJob(env,id,'NEED_UPLOAD',null,{...job.audit,status:'NO_CAPTIONS'});
   return json({job:await ownedJob(env,id),persisted:true},202);
  }
  if(action==='summary-plan'&&request.method==='GET'){
   const source=await sourceOf(env,id);if(!source?.segments.length)throw new InputError('전사 원문부터 확보하세요.');
   const groups=partitionTranscript(source.segments,job.audit);
   return json({stages:groups.length,firstPassUnits:groups.reduce((sum,group)=>sum+summaryUnits(reportPrompt(group,job.audit)),0),additionalSynthesisUnits:'UNKNOWN_UNTIL_STAGE_OUTPUT',segmentCount:source.segments.length,completeSourceRequired:true});
  }
  if(action==='summary-review'&&request.method==='GET'){
   const operations=(await env.DB.prepare("SELECT id,error_code,result_json FROM yta_operations WHERE job_id=? AND provider='gemini' AND state='FAILED_UNCERTAIN' AND id LIKE ? ORDER BY created_at DESC").bind(id,id+':summary:%').all()).results||[];
   const reviewed=operations.find(row=>{try{return typeof JSON.parse(row.result_json)?.partialText==='string';}catch{return false;}});
   if(!reviewed)throw new ProviderError('SUMMARY_REVIEW_NOT_FOUND','보존된 요약 부분 출력이 없습니다.');
   return json({operationId:reviewed.id,errorCode:reviewed.error_code,...JSON.parse(reviewed.result_json),state:'FAILED_UNCERTAIN'});
  }
  if(action==='summary'&&request.method==='POST'){
   const source=await sourceOf(env,id);if(!source?.segments.length)throw new InputError('전사 원문부터 확보하세요.');
   if(job.report?.kind==='GEMINI_EVIDENCE_LINKED')return json({job,persisted:true,cached:true});
   const auditJson=JSON.stringify(job.audit),summarySourceChanged=()=>{const error=new ProviderError('SUMMARY_INPUT_CHANGED','요약 원본·경계 검토 정보 또는 무료 허가가 변경됐습니다. 새로 검토하세요.');error.preDispatchBlocked=true;throw error;};
   const assertSummarySource=async(operationId,requireClaimed,active)=>{
    const admission=requireClaimed?" AND EXISTS (SELECT 1 FROM yta_quota q JOIN yta_capacity c ON c.provider=q.provider WHERE q.provider='gemini' AND q.billing_disabled=1 AND q.confirmed_at=? AND q.expires_at=? AND q.expires_at>? AND c.model='gemini-2.5-flash' AND c.billing_disabled=1 AND c.version=? AND c.valid_until=? AND c.valid_until>? AND c.source=? AND NOT EXISTS (SELECT 1 FROM provider_credentials p WHERE p.owner_id='owner' AND p.provider='gemini' AND (COALESCE(p.updated_at=strftime('%Y-%m-%dT%H:%M:%fZ',p.updated_at),0)=0 OR p.updated_at>strftime('%Y-%m-%dT%H:%M:%fZ',q.confirmed_at/1000.0,'unixepoch'))))":"";
    const admissionArgs=requireClaimed?[active.quotaConfirmedAt,active.quotaExpiresAt,Date.now(),active.capacityVersion,active.capacityValidUntil,Date.now(),'AI_STUDIO_LIVE:'+await capacityIdentity(env,'gemini')]:[];
    const row=await env.DB.prepare("SELECT 1 AS ok FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND j.audit_json=? AND j.report_json=? AND s.raw=? AND s.segments_json=? AND NOT EXISTS (SELECT 1 FROM yta_operations d WHERE d.id=? AND d.provider='deletion' AND d.state='DELETING') AND EXISTS (SELECT 1 FROM yta_operations o WHERE o.id=? AND o.job_id=j.id AND o.provider='gemini' AND o.state=?)"+admission).bind(id,auditJson,job.report_json,source.raw,source.segments_json,id+':deleting',operationId,requireClaimed?'CLAIMED':'DONE',...admissionArgs).first();
    if(!row)summarySourceChanged();
   };
   const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([source.segments,job.audit]))))).map(x=>x.toString(16).padStart(2,'0')).join('');
   let newCall=false;
   const pending=()=>json({job,persisted:true,pending:true,reason:'NEXT_STAGE_REQUIRES_SEPARATE_REQUEST',minimumWaitSeconds:13},202);
   const ask=async(key,prompt,allowed,stage)=>{
    const operationId=id+':summary:'+fingerprint+':'+key;
    const beforeSummaryFetch=async active=>{try{await assertGeminiBeforeFetch(env,active);await assertSummarySource(operationId,true,active);}catch(error){error.preDispatchBlocked=true;throw error;}};
    const response=await execute(env,{id:operationId,job:id,provider:'gemini',units:summaryUnits(prompt)},active=>runTranscriptSummary({env:{...active,SUMMARY_JSON:'true',SUMMARY_STAGE_OUTPUT_TOKENS:stage?'2048':'8192'},text:prompt,beforeDispatch:()=>beforeSummaryFetch(active),beforeFetch:()=>beforeSummaryFetch(active)}),()=>{newCall=true;});
    await assertSummarySource(operationId,false);
    let result;try{if(response.text.length>12000&&stage)throw Error('STAGE_TOO_LONG');result=validateAnalysis(JSON.parse(response.text),allowed);}catch{throw new ProviderError('REPORT_VALIDATION_FAILED','요약 근거 형식 검증 실패. 원문은 보관됐으며 자동 재호출하지 않습니다.');}
    return result;
   };
   const groups=partitionTranscript(source.segments,job.audit);
   const firstPassUnits=groups.reduce((sum,group)=>sum+summaryUnits(reportPrompt(group,job.audit)),0);
   if(firstPassUnits>250000){const body=await readJson(request);if(body.allowStaged!==true)throw new InputError('요약에 여러 차례 무료 할당 갱신이 필요합니다. 단계별 비용 상한을 확인하고 명시적으로 계속하세요.');}
   let report;
   if(groups.length===1)report=await ask('single',reportPrompt(groups[0],job.audit),groups[0],false);
   else{
    let parts=[];
    for(let i=0;i<groups.length;i++){
     const chunk=groups[i],partial=await ask('raw:'+i,reportPrompt(chunk,job.audit),chunk,true);
     parts.push({ids:evidenceIds(partial),startMs:chunk[0].startMs,endMs:chunk.at(-1).endMs,report:partial});
     if(newCall)return pending();
    }
    for(let level=0;parts.length>1;level++){
     if(level>12)throw new InputError('요약 단계가 너무 깊습니다.');
     const batches=partitionSynthesis(parts,job.audit),next=[];
     for(let i=0;i<batches.length;i++){
      const batch=batches[i],prompt=synthesisPrompt(batch,job.audit);
      const allowed=[...new Set(batch.flatMap(part=>part.ids))].map(id=>({id}));
      const merged=await ask('merge:'+level+':'+i,prompt,allowed,batches.length>1);
      assertGroupCoverage(merged,batch);
      next.push({ids:evidenceIds(merged),startMs:batch[0].startMs,endMs:batch.at(-1).endMs,report:merged});
      if(newCall&&!(batches.length===1&&parts.length===batch.length))return pending();
     }
     parts=next;
    }
    report=parts[0].report;
    assertGroupCoverage(report,groups.map(chunk=>({ids:chunk.map(s=>s.id)})));
   }
   const updated=await env.DB.prepare("UPDATE jobs SET status=?,report_json=?,audit_json=?,updated_at=? WHERE id=? AND owner_id='owner' AND audit_json=? AND report_json=? AND EXISTS (SELECT 1 FROM yta_sources WHERE job_id=? AND raw=? AND segments_json=?) AND NOT EXISTS (SELECT 1 FROM yta_operations WHERE id=? AND provider='deletion' AND state='DELETING')").bind(job.status,JSON.stringify(report),JSON.stringify({...job.audit,summaryProvider:'gemini',externalFactCheck:'NOT_PERFORMED'}),new Date().toISOString(),id,auditJson,job.report_json,id,source.raw,source.segments_json,id+':deleting').run();
   if(updated.meta?.changes!==1)summarySourceChanged();
   return json({job:await ownedJob(env,id),persisted:true});
  }
  if(action==='audio-plan'&&request.method==='POST'){
   if(['GROQ_OWNED_AUDIO','GEMINI_OWNED_AUDIO','MIXED_OWNED_AUDIO'].includes((await sourceOf(env,id))?.provenance))throw new InputError('완료된 전사입니다. 저장된 TXT를 확인하세요.');
   const body=await readJson(request);if(body.rightsConfirmed!==true)throw new InputError('적법하게 보유한 파일 업로드 확인 필요');
   if(typeof body.fileSha256!=='string'||!/^[a-f0-9]{64}$/.test(body.fileSha256))throw new InputError('전체 음성 파일 SHA-256이 필요합니다.');
   const chunks=body.chunks;if(!Array.isArray(chunks)||!chunks.length||chunks.length>160)throw new InputError('음성 조각 계획 오류');let edge=0;
   for(let i=0;i<chunks.length;i++){const c=chunks[i];if(c.index!==i||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.end<=c.start||c.end-c.start>601||c.start>edge+.1||c.start<Math.max(0,edge-5)||c.end>job.duration_seconds+2)throw new InputError('음성 시간축 불연속/범위 오류');edge=c.end;}
   if(Math.abs(edge-job.duration_seconds)>2)throw new InputError('전체 음성 범위를 포함하는 계획이어야 합니다.');
   const exists=await env.DB.prepare('SELECT COUNT(*) AS n FROM yta_audio WHERE job_id=?').bind(id).first();
   if(exists.n>0){const prior=(await env.DB.prepare('SELECT * FROM yta_audio WHERE job_id=? ORDER BY chunk_index').bind(id).all()).results; if(prior.length!==chunks.length||prior.some((c,i)=>Math.abs(c.start_sec-chunks[i].start)>.01||Math.abs(c.end_sec-chunks[i].end)>.01||JSON.parse(c.result_json||'{}').fileSha256!==body.fileSha256))throw new InputError('기존 음성 파일 또는 계획과 다릅니다.');return json({planned:true,reused:true});}
   for(const c of chunks)await env.DB.prepare('INSERT INTO yta_audio(job_id,chunk_index,start_sec,end_sec,state,result_json) VALUES(?,?,?,?,?,?)').bind(id,c.index,c.start,c.end,'PLANNED',JSON.stringify({fileSha256:body.fileSha256})).run();
   return json({planned:true,chunks:chunks.length,uploadSeconds:chunks.reduce((sum,c)=>sum+c.end-c.start,0)});
  }
  if(action==='audio-consent'&&request.method==='POST'){
   const body=await readJson(request);if(body.provider!=='gemini'||body.consent!==true||!/^[a-f0-9]{64}$/.test(body.fileSha256||''))throw new InputError('Gemini 음성 전송 동의와 원본 파일 지문이 필요합니다.');
   const rows=(await env.DB.prepare('SELECT result_json,state FROM yta_audio WHERE job_id=?').bind(id).all()).results||[];
   if(!rows.length||rows.some(row=>JSON.parse(row.result_json||'{}').fileSha256!==body.fileSha256||!['PLANNED','PAUSED','DONE'].includes(row.state)))throw new ProviderError('AUDIO_FILE_MISMATCH','이 작업의 원본 파일 지문과 동의 대상을 확인하세요.');
   await env.DB.prepare("UPDATE yta_audio SET result_json=json_set(result_json,'$.geminiConsent',1,'$.geminiConsentAt',?) WHERE job_id=? AND state IN ('PLANNED','PAUSED')").bind(new Date().toISOString(),id).run();
   return json({recorded:true,provider:'gemini',fileSha256:body.fileSha256});
  }
  if(action==='audio-recovery'&&request.method==='GET'){
   const index=Number(url.searchParams.get('index'));if(!Number.isInteger(index)||index<0)throw new InputError('검토할 조각 번호 오류');
   await ensureFreeRecoverySchema(env);
   const evidence=await recoveryEvidence(env,id,index);
   const approval=await env.DB.prepare('SELECT state FROM yta_free_recovery WHERE job_id=? AND chunk_index=?').bind(id,index).first();
   return json({...evidence,approvalState:approval?.state??null,possiblePriorGeminiUsage:true,duplicateTranscriptionRisk:true,freeGroqCapacityRequiresFreshVerification:true});
  }
  if(action==='audio-recovery'&&request.method==='POST'){
   const body=await readJson(request),index=body?.index;
   if(!Number.isInteger(index)||index<0||body?.acknowledgePossibleGeminiUsage!==true||body?.acknowledgeDuplicateTranscriptionRisk!==true||body?.chooseGroqFree!==true)throw new InputError('이전 Gemini 사용 가능성과 중복 전사 위험을 인정하고 Groq 무료 재개를 직접 선택하세요.');
   await ensureFreeRecoverySchema(env);
   const evidence=await recoveryEvidence(env,id,index);
   if(body.fileSha256!==evidence.fileSha256||body.geminiOperationId!==evidence.geminiOperationId||body.groq429OperationId!==evidence.groq429OperationId)throw new ProviderError('RECOVERY_EVIDENCE_CHANGED','원본 파일 또는 실패 작업이 검토한 대상과 다릅니다.');
   const inserted=await env.DB.prepare('INSERT OR IGNORE INTO yta_free_recovery(job_id,chunk_index,file_sha256,gemini_operation_id,groq_429_operation_id,retry_operation_id,state,approved_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,index,evidence.fileSha256,evidence.geminiOperationId,evidence.groq429OperationId,evidence.retryOperationId,'APPROVED',new Date().toISOString()).run();
   if(inserted.meta?.changes!==1)throw new ProviderError('RECOVERY_ALREADY_RECORDED','기존 재개 승인은 초기화하거나 재사용할 수 없습니다.');
   return json({approved:true,index,retryOperationId:evidence.retryOperationId,provider:'groq',automaticDispatch:false,possiblePriorGeminiUsage:true});
  }
  if(action==='audio-free-probe'&&request.method==='GET'){
   const index=Number(url.searchParams.get('index'));if(!Number.isInteger(index)||index<0)throw new InputError('탐침 조각 번호 오류');
   await ensureFreeProbeSchema(env);
   const row=await env.DB.prepare('SELECT state,expires_at,response_meta_json FROM yta_free_probe WHERE job_id=? AND chunk_index=?').bind(id,index).first();
   return json({state:row?.state??null,expiresAt:row?.expires_at??null,safeRateLimit:row?.response_meta_json?JSON.parse(row.response_meta_json):null,accountCapacity:'UNKNOWN',fullQuotaRestored:false});
  }
  if(action==='audio-free-probe'&&request.method==='POST'){
   const body=await readJson(request),index=body?.index;
   if(!Number.isInteger(index)||index<0||body.provider!=='groq'||body.model!=='whisper-large-v3-turbo'||body.freeTierConfirmed!==true||body.billingDisabled!==true||body.unknownCapacityAcknowledged!==true||body.acknowledgePossibleGeminiUsage!==true||body.acknowledgeDuplicateTranscriptionRisk!==true||body.oneRequestOnly!==true)throw new InputError('Groq Free, 잔여량 UNKNOWN, 기존 사용·중복 위험 및 한 번의 요청을 명시적으로 확인하세요.');
   if(env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true')throw new ProviderError('LIVE_DISABLED','무료 계정 탐침이 활성화되지 않았습니다.');
   await ensureFreeRecoverySchema(env);await ensureFreeProbeSchema(env);
   const evidence=await recoveryEvidence(env,id,index),recovery=await env.DB.prepare('SELECT state,retry_operation_id FROM yta_free_recovery WHERE job_id=? AND chunk_index=?').bind(id,index).first();
   if(recovery?.state!=='APPROVED'||recovery.retry_operation_id!==evidence.retryOperationId||body.fileSha256!==evidence.fileSha256||body.geminiOperationId!==evidence.geminiOperationId||body.groq429OperationId!==evidence.groq429OperationId)throw new ProviderError('RECOVERY_EVIDENCE_CHANGED','원본 파일·실패 작업·재개 승인이 검토한 대상과 다릅니다.');
   const chunk=await env.DB.prepare('SELECT start_sec,end_sec FROM yta_audio WHERE job_id=? AND chunk_index=?').bind(id,index).first();
   if(!chunk||chunk.end_sec-chunk.start_sec>600||chunk.end_sec-chunk.start_sec<=0)throw new ProviderError('PROBE_SIZE_LIMIT','탐침 조각은 10분 이하만 허용합니다.');
   const identity=await capacityIdentity(env,'groq'),now=Date.now();
   const inserted=await env.DB.prepare('INSERT OR IGNORE INTO yta_free_probe(job_id,chunk_index,file_sha256,retry_operation_id,key_identity,state,approved_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,index,evidence.fileSha256,evidence.retryOperationId,identity,'APPROVED',new Date(now).toISOString(),now+3600000).run();
   if(inserted.meta?.changes!==1)throw new ProviderError('PROBE_ALREADY_RECORDED','탐침 승인은 다시 발급하거나 초기화할 수 없습니다.');
   return json({approved:true,index,provider:'groq',model:'whisper-large-v3-turbo',accountCapacity:'UNKNOWN',fullQuotaRestored:false,oneRequestOnly:true,expiresAt:now+3600000,automaticDispatch:false});
  }
  if(action==='audio-free-batch'&&request.method==='GET'){
   await ensureFreeBatchSchema(env);
   const existing=await env.DB.prepare('SELECT job_id,file_sha256,model,chunk_ids_json,max_requests,max_audio_seconds,state,expires_at,stop_reason,retry_after_at FROM yta_free_batches WHERE job_id=? AND owner_id=?').bind(id,'owner').first();
   if(existing){let chunkIds;try{chunkIds=JSON.parse(existing.chunk_ids_json);if(!Array.isArray(chunkIds))throw Error();}catch{throw new ProviderError('FREE_BATCH_LEDGER_INVALID','저장된 배치 범위를 검토하세요.');}
    return json({approved:true,jobId:id,fileSha256:existing.file_sha256,model:existing.model,chunkIds,maxRequests:existing.max_requests,maxAudioSeconds:existing.max_audio_seconds,state:existing.state,expiresAt:existing.expires_at,stopReason:existing.stop_reason,retryAfterAt:existing.retry_after_at,accountRemaining:'UNKNOWN',summaryIncluded:false});}
   return json({approved:false,...await freeBatchPlan(env,job),expiresInSeconds:3600});
  }
  if(action==='audio-free-batch'&&request.method==='POST'){
   await ensureFreeBatchSchema(env);
   const body=await readJson(request),plan=await freeBatchPlan(env,job);
   if(env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true'||body?.provider!=='groq'||body.model!==plan.model||body.jobId!==id||body.fileSha256!==plan.fileSha256||JSON.stringify(body.chunkIds)!==JSON.stringify(plan.chunkIds)||body.maxRequests!==plan.maxRequests||body.maxAudioSeconds!==plan.maxAudioSeconds||body.freeTierConfirmed!==true||body.billingDisabled!==true||body.unknownCapacityAcknowledged!==true||body.oneBatchOnly!==true||body.noPaidFallback!==true||body.stopOnFirstError!==true||body.stopBeforeSummary!==true)throw new InputError('정확한 원본·조각·Groq Free 배치 상한과 중단 조건을 확인하세요.');
   const keyIdentity=await capacityIdentity(env,'groq'),now=Date.now(),expiresAt=now+3600000;
   const statements=[env.DB.prepare('INSERT INTO yta_free_batches(job_id,owner_id,file_sha256,key_identity,model,chunk_ids_json,max_requests,max_audio_seconds,free_tier_confirmed,billing_disabled,state,approved_at,expires_at) VALUES(?,?,?,?,?,?,?,?,1,1,?,?,?)').bind(id,'owner',plan.fileSha256,keyIdentity,plan.model,JSON.stringify(plan.chunkIds),plan.maxRequests,plan.maxAudioSeconds,'APPROVED',new Date(now).toISOString(),expiresAt),...plan.chunkIds.map((index,i)=>env.DB.prepare('INSERT INTO yta_free_batch_chunks(job_id,chunk_index,units,state,operation_id) VALUES(?,?,?,?,?)').bind(id,index,plan.units[i],'APPROVED',id+':audio:'+index+':freebatch:1'))];
   try{await env.DB.batch(statements);}catch{throw new ProviderError('FREE_BATCH_ALREADY_RECORDED','배치 승인은 자동 갱신하거나 덮어쓸 수 없습니다.');}
   return json({approved:true,jobId:id,fileSha256:plan.fileSha256,model:plan.model,chunkIds:plan.chunkIds,maxRequests:plan.maxRequests,maxAudioSeconds:plan.maxAudioSeconds,state:'APPROVED',expiresAt,accountRemaining:'UNKNOWN',automaticDispatch:false,summaryIncluded:false});
  }
  if(action==='audio-free-batch'&&request.method==='DELETE'){
   await ensureFreeBatchSchema(env);
   const stopped=await env.DB.prepare("UPDATE yta_free_batches SET state='CANCELLED' WHERE job_id=? AND owner_id=? AND state='APPROVED'").bind(id,'owner').run();
   return json({cancelled:stopped.meta?.changes===1,accountRemaining:'UNKNOWN'});
  }
  if(action==='audio-progress'&&request.method==='GET'){
   const rows=(await env.DB.prepare('SELECT chunk_index,start_sec,end_sec,state FROM yta_audio WHERE job_id=? ORDER BY chunk_index').bind(id).all()).results||[];
   const waits=(await env.DB.prepare('SELECT operation_id,reason,reset_at FROM yta_wait WHERE job_id=?').bind(id).all()).results||[];
   const operations=(await env.DB.prepare("SELECT id,provider,state,error_code,created_at FROM yta_operations WHERE job_id=? AND provider IN ('groq','gemini') AND id LIKE ?").bind(id,id+':audio:%').all()).results||[];
   const recoveryTable=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='yta_free_recovery'").bind().first();
   const recoveries=recoveryTable?(await env.DB.prepare('SELECT chunk_index,gemini_operation_id,retry_operation_id,state FROM yta_free_recovery WHERE job_id=?').bind(id).all()).results||[]:[];
   const probeTable=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='yta_free_probe'").bind().first();
   const probes=probeTable?(await env.DB.prepare('SELECT chunk_index,retry_operation_id,state,expires_at FROM yta_free_probe WHERE job_id=?').bind(id).all()).results||[]:[];
   const chunks=rows.map(c=>{const geminiAttempts=audioAttempts(operations,id,c.chunk_index,'gemini'),groqAttempts=audioAttempts(operations,id,c.chunk_index),review=recoveries.find(row=>row.chunk_index===c.chunk_index&&row.state==='APPROVED'),latest=[...geminiAttempts,...groqAttempts].filter(row=>row.id!==review?.retry_operation_id||row.state!=='BLOCKED').sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)).at(-1),reviewed429Required=c.state!=='DONE'&&latest?.state==='FAILED_UNCERTAIN'&&latest.error_code==='429',approval=review?.gemini_operation_id===latest?.id?review:null,reviewedFreeRetryApproved=c.state==='UNCERTAIN'&&Boolean(approval),unknownCapacityProbeApproved=reviewedFreeRetryApproved&&probes.some(row=>row.chunk_index===c.chunk_index&&row.retry_operation_id===review.retry_operation_id&&row.state==='APPROVED'&&row.expires_at>Date.now());const wait=waits.find(item=>item.operation_id===latest?.id);const groqAllowed=reviewedFreeRetryApproved||!geminiAttempts.some(operation=>operation.state!=='BLOCKED'||!['QUOTA_EXHAUSTED','PRE_DISPATCH_BLOCKED','CAPACITY_WAIT'].includes(operation.error_code));return {index:c.chunk_index,start:c.start_sec,end:c.end_sec,state:c.state,groqAllowed,reviewedFreeRetryApproved,unknownCapacityProbeApproved,reviewed429Required,reviewOperationId:reviewed429Required?latest.id:null,reviewProvider:reviewed429Required?latest.provider:null,uncertainFailure:!reviewedFreeRetryApproved&&(c.state==='UNCERTAIN'||(c.state!=='DONE'&&latest?.state==='FAILED_UNCERTAIN'&&latest.error_code!=='429')),waitReason:wait?.reason??null,resetAt:wait?.reset_at??null};});
   const intervals=chunks.filter(c=>c.state==='DONE').map(c=>({start:c.start,end:c.end}));let covered=0,edge=0;
   for(const range of intervals){covered+=Math.max(0,range.end-Math.max(edge,range.start));edge=Math.max(edge,range.end);}
   let contiguous=0,prefixComplete=true;for(const c of chunks){if(c.state!=='DONE')prefixComplete=false;else if(prefixComplete)contiguous=c.end;}
   const nextEligibleAt={gemini:null,groq:null},operationInFlight={gemini:false,groq:false};
   for(const provider of ['gemini','groq']){const inFlight=await env.DB.prepare("SELECT 1 FROM yta_operations WHERE provider=? AND state='CLAIMED' LIMIT 1").bind(provider).first();operationInFlight[provider]=Boolean(inFlight);const settled=await env.DB.prepare(provider==='gemini'?"SELECT created_at FROM yta_operations WHERE provider='gemini' AND state IN ('DONE','FAILED_UNCERTAIN') ORDER BY created_at DESC LIMIT 1":"SELECT created_at FROM yta_operations WHERE provider='groq' AND state='FAILED_UNCERTAIN' AND error_code='429' ORDER BY created_at DESC LIMIT 1").bind().first();if(settled)nextEligibleAt[provider]=Date.parse(settled.created_at)+(provider==='gemini'?GEMINI_SPACING_MS:GROQ_HOURLY_WINDOW_MS);}
   return json({chunks,complete:rows.length>0&&rows.every(c=>c.state==='DONE'),temporaryResultsCleaned:rows.length===0&&job.audit?.audioProcessingCoverage===1,confirmedAudioSeconds:Math.min(job.duration_seconds,covered),confirmedThroughSeconds:contiguous,coveragePercent:job.duration_seconds>0?Math.round(1000*Math.min(job.duration_seconds,covered)/job.duration_seconds)/10:0,nextEligibleAt,operationInFlight});
  }
  if(action==='audio-review'&&request.method==='GET'){
   const index=Number(url.searchParams.get('index'));if(!Number.isInteger(index)||index<0)throw new InputError('검토할 조각 번호 오류');
   const operations=(await env.DB.prepare("SELECT id,provider,state,error_code,result_json FROM yta_operations WHERE job_id=? AND id LIKE ? AND state='FAILED_UNCERTAIN' ORDER BY created_at DESC").bind(id,id+':audio:'+index+'%').all()).results||[];
   const exact=[...audioAttempts(operations,id,index,'groq'),...audioAttempts(operations,id,index,'gemini')];
   const reviewed=exact.find(row=>{try{return typeof JSON.parse(row.result_json)?.partialText==='string';}catch{return false;}});
   if(!reviewed)throw new ProviderError('AUDIO_REVIEW_NOT_FOUND','보존된 부분 출력이 없습니다.');
   return json({index,operationId:reviewed.id,provider:reviewed.provider,errorCode:reviewed.error_code,...JSON.parse(reviewed.result_json),state:'FAILED_UNCERTAIN'});
  }
  if(action==='audio-chunk'&&request.method==='POST'){
   const index=Number(url.searchParams.get('index')),provider=url.searchParams.get('provider')||'groq';if(!Number.isInteger(index)||index<0||!['groq','gemini'].includes(provider))throw new InputError('조각 번호 또는 전사 제공자 오류');
   const chunk=await env.DB.prepare('SELECT * FROM yta_audio WHERE job_id=? AND chunk_index=?').bind(id,index).first();if(!chunk)throw new InputError('음성 조각 계획부터 저장하세요.');
   if(chunk.state==='DONE')return json({index,state:'DONE',cached:true});
   const useProbe=request.headers.get('x-groq-free-unknown-probe')==='true';
   const useBatch=request.headers.get('x-groq-free-batch')==='true';
   if(useBatch){await ensureFreeBatchSchema(env);if(provider!=='groq'||useProbe||!['PLANNED','PAUSED'].includes(chunk.state))throw new ProviderError('FREE_BATCH_REVIEW_REQUIRED','배치는 승인된 미처리 Groq 조각에만 허용됩니다.');}
   let recovery=null;
   if(chunk.state==='UNCERTAIN'){
    if(provider!=='groq')throw new ProviderError('OPERATION_REVIEW_REQUIRED','미확정 Gemini 시도는 자동 재시도할 수 없습니다.');
    await ensureFreeRecoverySchema(env);
    let evidence;try{evidence=await recoveryEvidence(env,id,index);}catch{throw new ProviderError('OPERATION_REVIEW_REQUIRED','이 조각의 이전 호출 상태를 먼저 확인하세요.');}
    recovery=await env.DB.prepare('SELECT * FROM yta_free_recovery WHERE job_id=? AND chunk_index=? AND state=?').bind(id,index,'APPROVED').first();
    if(!recovery||recovery.file_sha256!==evidence.fileSha256||recovery.gemini_operation_id!==evidence.geminiOperationId||recovery.groq_429_operation_id!==evidence.groq429OperationId||recovery.retry_operation_id!==evidence.retryOperationId)throw new ProviderError('OPERATION_REVIEW_REQUIRED','이 조각의 정확한 실패 이력에 대한 소유자 승인이 필요합니다.');
   }
   if(useProbe&&!recovery)throw new ProviderError('PROBE_REVIEW_REQUIRED','무료 탐침은 승인된 미확정 조각에만 허용됩니다.');
   if(useBatch&&recovery)throw new ProviderError('FREE_BATCH_REVIEW_REQUIRED','미확정 복구는 제한형 신규 조각 배치에 포함되지 않습니다.');
   let probe=null;
   if(useProbe){await ensureFreeProbeSchema(env);probe=await env.DB.prepare("SELECT * FROM yta_free_probe WHERE job_id=? AND chunk_index=? AND state='APPROVED'").bind(id,index).first();if(!probe||probe.retry_operation_id!==recovery.retry_operation_id||probe.file_sha256!==recovery.file_sha256||probe.expires_at<=Date.now()||env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true'||await capacityIdentity(env,'groq')!==probe.key_identity)throw new ProviderError('PROBE_REVIEW_REQUIRED','현재 Groq Free 키의 유효한 1회 탐침 승인이 필요합니다.');}
   if(provider==='gemini'&&JSON.parse(chunk.result_json||'{}').geminiConsent!==1)throw new ProviderError('AUDIO_GEMINI_CONSENT_REQUIRED','이 작업과 원본 MP3에 대한 Gemini 음성 전송 동의를 저장하세요.');
   if(!['PLANNED','PAUSED'].includes(chunk.state)&&!recovery)throw new ProviderError('OPERATION_REVIEW_REQUIRED','이 조각의 이전 호출 상태를 먼저 확인하세요.');
   const bytes=await boundedBytes(request,8000000),name=url.searchParams.get('name')||'chunk.mp3';
   if(!/\.mp3$/i.test(name))throw new InputError('대용량 분할 전사는 MP3 입력을 사용하세요.');
   const duration=scanMp3(bytes).durationSeconds,plannedDuration=chunk.end_sec-chunk.start_sec;
   let metadata;try{metadata=prepareMp3Chunk(bytes);}catch(error){throw new InputError('MP3 조각 메타데이터를 검증할 수 없습니다: '+error.message);}
   if(metadata.metadataCorrected)throw new InputError('MP3 전체 파일 길이 메타데이터가 조각에 남아 있습니다.');
   if(Math.abs(plannedDuration-duration)>.005)throw new InputError('음성 조각 길이와 계획이 다릅니다.');
   const base=id+':audio:'+index,operations=(await env.DB.prepare("SELECT id,provider,state,error_code,created_at FROM yta_operations WHERE job_id=? AND provider IN ('groq','gemini') AND (id=? OR id LIKE ?)").bind(id,base,base+':%').all()).results||[];
   const groqAttempts=audioAttempts(operations,id,index,'groq'),geminiAttempts=audioAttempts(operations,id,index,'gemini');
   const latest=[...geminiAttempts,...groqAttempts].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)).at(-1);
   if(latest?.state==='CLAIMED')throw new ProviderError('OPERATION_IN_FLIGHT','이 조각의 호출이 진행 중입니다.');
   if(latest?.state==='FAILED_UNCERTAIN'){
    if(latest.error_code!=='429'&&!recovery)throw new ProviderError('OPERATION_REVIEW_REQUIRED','이전 음성 호출 결과가 불명확합니다. 제공자 사용량을 확인하세요.');
    if(!recovery&&(request.headers.get('x-provider-log-429-no-output-confirmed')!=='true'||request.headers.get('x-provider-log-429-operation-id')!==latest.id))throw new ProviderError('PROVIDER_429_REVIEW_REQUIRED','현재 실패 작업의 공식 제공자 요청 로그에서 429 거절과 출력 없음을 확인한 뒤에만 재개하세요.');
   }
   if(provider==='groq'&&!recovery&&geminiAttempts.some(operation=>operation.state!=='BLOCKED'||!['QUOTA_EXHAUSTED','PRE_DISPATCH_BLOCKED','CAPACITY_WAIT'].includes(operation.error_code)))throw new ProviderError('AUDIO_PROVIDER_SWITCH_REVIEW','전송 여부가 불명확한 Gemini 시도가 있어 Groq로 전환할 수 없습니다.');
   if(useBatch&&operations.some(operation=>operation.id!==base+':freebatch:1'||operation.state!=='BLOCKED'||operation.error_code!=='FREE_BATCH_PRE_DISPATCH_BLOCKED'))throw new ProviderError('FREE_BATCH_REVIEW_REQUIRED','이 조각에 전송 가능성이 있는 이전 호출이 있습니다. 배치로 재시도하지 않습니다.');
   const attempts=provider==='groq'?groqAttempts:geminiAttempts;
   if(attempts.length>=10)throw new ProviderError('RECOVERY_LIMIT_REACHED','이 조각의 재개 횟수가 한도에 도달했습니다.');
   const operationId=useBatch?base+':freebatch:1':recovery?recovery.retry_operation_id:latest?.state==='FAILED_UNCERTAIN'&&latest.error_code==='429'&&latest.provider===provider?
    provider==='groq'?base+':reviewed429:'+groqAttempts.length:base+':gemini:0:reviewed429:'+geminiAttempts.length:
    attempts.at(-1)?.state==='BLOCKED'?attempts.at(-1).id:provider==='groq'?base:base+':gemini:0';
   if(recovery){const approved=await env.DB.prepare("UPDATE yta_free_recovery SET state='CLAIMED' WHERE job_id=? AND chunk_index=? AND state='APPROVED' AND gemini_operation_id=?").bind(id,index,recovery.gemini_operation_id).run();if(approved.meta?.changes!==1)throw new ProviderError('OPERATION_IN_FLIGHT','이 재개 승인은 이미 사용 중입니다.');}
   if(probe){const approved=await env.DB.prepare("UPDATE yta_free_probe SET state='CLAIMED' WHERE job_id=? AND chunk_index=? AND state='APPROVED' AND expires_at>?").bind(id,index,Date.now()).run();if(approved.meta?.changes!==1){await env.DB.prepare("UPDATE yta_free_recovery SET state='APPROVED' WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(id,index).run();throw new ProviderError('PROBE_REVIEW_REQUIRED','탐침 승인이 이미 사용됐거나 만료됐습니다.');}}
   let batch=null;
   if(useBatch){
    batch=await env.DB.prepare('SELECT * FROM yta_free_batches WHERE job_id=? AND owner_id=?').bind(id,'owner').first();
    const approval=await env.DB.prepare('SELECT units,state,operation_id FROM yta_free_batch_chunks WHERE job_id=? AND chunk_index=?').bind(id,index).first();
    const fileSha=JSON.parse(chunk.result_json||'{}').fileSha256;
    if(!batch||batch.state!=='APPROVED'||batch.model!=='whisper-large-v3-turbo'||batch.file_sha256!==fileSha||!validFreeBatchExpiry(batch)||batch.free_tier_confirmed!==1||batch.billing_disabled!==1||approval?.state!=='APPROVED'||approval.operation_id!==operationId||approval.units!==Math.max(10,Math.ceil(plannedDuration))||await capacityIdentity(env,'groq')!==batch.key_identity)throw new ProviderError('FREE_BATCH_REVIEW_REQUIRED','정확한 원본·키·조각의 유효한 Groq Free 배치 승인이 필요합니다.');
    const claimed=await env.DB.prepare("UPDATE yta_free_batch_chunks SET state='CLAIMED' WHERE job_id=? AND chunk_index=? AND state='APPROVED' AND EXISTS (SELECT 1 FROM yta_free_batches b WHERE b.job_id=? AND b.owner_id='owner' AND b.state='APPROVED' AND b.expires_at>?) AND NOT EXISTS (SELECT 1 FROM yta_free_batch_chunks c WHERE c.job_id=? AND c.state='CLAIMED') AND NOT EXISTS (SELECT 1 FROM yta_free_batch_chunks c WHERE c.job_id=? AND c.chunk_index<? AND c.state<>'DONE')").bind(id,index,id,Date.now(),id,id,index).run();
    if(claimed.meta?.changes!==1)throw new ProviderError('FREE_BATCH_REVIEW_REQUIRED','승인 순서·진행 중 요청 또는 만료 상태를 확인하세요.');
   }
   const locked=await env.DB.prepare(recovery?"UPDATE yta_audio SET state='CLAIMED' WHERE job_id=? AND chunk_index=? AND state='UNCERTAIN'":"UPDATE yta_audio SET state='CLAIMED' WHERE job_id=? AND chunk_index=? AND state IN ('PLANNED','PAUSED')").bind(id,index).run();
   if(locked.meta?.changes!==1&&recovery){await env.DB.prepare("UPDATE yta_free_recovery SET state='APPROVED' WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(id,index).run();if(probe)await env.DB.prepare("UPDATE yta_free_probe SET state='APPROVED' WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(id,index).run();}
   if(locked.meta?.changes!==1){if(batch)await env.DB.prepare("UPDATE yta_free_batch_chunks SET state='APPROVED' WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(id,index).run();throw new ProviderError('OPERATION_IN_FLIGHT','같은 음성 조각이 이미 처리 중입니다.');}
   try{
    const units=provider==='groq'?Math.max(10,Math.ceil(plannedDuration)):Math.ceil(duration*32)+8704;
    const result=probe?await executeGroqProbe(env,{jobId:id,index,operationId,units,probe,bytes}):batch?await executeFreeBatchChunk(env,{jobId:id,index,operationId,units,batch,bytes,duration}):await execute(env,{id:operationId,job:id,provider,units},active=>provider==='groq'?
     runOwnedAudioTranscription({env:active,bytes,name:'chunk.mp3',mime:'audio/mpeg',durationSeconds:duration,beforeDispatch:()=>assertGroqBeforeDispatch(env,operationId,active),beforeFetch:()=>assertCapacityAtFetch(active)}):
     runOwnedGeminiAudio({env:active,bytes,durationSeconds:duration,beforeDispatch:()=>assertGeminiBeforeFetch(env,active),beforeFetch:()=>assertGeminiBeforeFetch(env,active)}));
    if(!Array.isArray(result.segments)||!result.segments.length)throw new ProviderError('EMPTY_AUDIO_TRANSCRIPT','음성 조각 전사가 비었습니다. 전체 전사로 처리하지 않습니다.');
    const updated=await env.DB.prepare("UPDATE yta_audio SET state='DONE',result_json=? WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(JSON.stringify({...result,operationId,fileSha256:JSON.parse(chunk.result_json).fileSha256}),id,index).run();
    if(updated.meta?.changes!==1)throw new ProviderError('AUDIO_RESULT_RACE','음성 조각 결과가 다른 요청과 충돌했습니다.');
    if(recovery)await env.DB.prepare("UPDATE yta_free_recovery SET state='USED' WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(id,index).run();
    if(probe)await env.DB.prepare("UPDATE yta_free_probe SET state='USED',response_meta_json=? WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(JSON.stringify(result.safeRateLimit??null),id,index).run();
    if(batch){await env.DB.prepare("UPDATE yta_free_batch_chunks SET state='DONE' WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(id,index).run();await env.DB.prepare("UPDATE yta_free_batches SET state='COMPLETE' WHERE job_id=? AND state='APPROVED' AND NOT EXISTS (SELECT 1 FROM yta_free_batch_chunks WHERE job_id=? AND state<>'DONE')").bind(id,id).run();}
    return json({index,state:'DONE',provider,segmentCount:result.segments.length});
   }catch(error){
    const op=await env.DB.prepare('SELECT state,error_code FROM yta_operations WHERE id=?').bind(operationId).first();
    const safe=!op||op.state==='BLOCKED'||(op?.state==='FAILED_UNCERTAIN'&&op.error_code==='429');
    if(recovery)await env.DB.prepare("UPDATE yta_free_recovery SET state=? WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(!op||op.state==='BLOCKED'?'APPROVED':'USED',id,index).run();
    if(probe)await env.DB.prepare("UPDATE yta_free_probe SET state=?,response_meta_json=? WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(!op||op.state==='BLOCKED'?'APPROVED':'USED',error.probeSafeMetadata?JSON.stringify(error.probeSafeMetadata):null,id,index).run();
    if(batch){const unsent=!op||op.state==='BLOCKED';await env.DB.prepare("UPDATE yta_free_batch_chunks SET state=? WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(unsent?'APPROVED':'STOPPED',id,index).run();if(!unsent){const retrySeconds=error.code==='429'?Math.max(3600,Number.isSafeInteger(error.safeRateLimit?.retryAfterSeconds)?error.safeRateLimit.retryAfterSeconds:0):null;await env.DB.prepare("UPDATE yta_free_batches SET state='STOPPED',stop_reason=?,retry_after_at=? WHERE job_id=? AND state='APPROVED'").bind(error.code==='429'?'429':'UNCERTAIN',retrySeconds===null?null:Date.now()+retrySeconds*1000,id).run();}}
    await env.DB.prepare("UPDATE yta_audio SET state=? WHERE job_id=? AND chunk_index=? AND state='CLAIMED'").bind(recovery?'UNCERTAIN':safe?'PAUSED':'UNCERTAIN',id,index).run();
    throw error;
   }

  }
  if(action==='audio-finish'&&request.method==='POST'){
   const rows=(await env.DB.prepare('SELECT * FROM yta_audio WHERE job_id=? ORDER BY chunk_index').bind(id).all()).results||[];
   if(!rows.length){const source=await sourceOf(env,id);if(['GROQ_OWNED_AUDIO','GEMINI_OWNED_AUDIO','MIXED_OWNED_AUDIO'].includes(source?.provenance)&&job.audit?.audioProcessingCoverage===1&&/^[a-f0-9]{64}$/.test(job.audit?.audioFileSha256||''))return json({job,source,persisted:true,cached:true});}
   const merged=completedAudio(rows,job.duration_seconds);
   const prior=await sourceOf(env,id);
   if(prior){
    const current=await ownedJob(env,id);
    if(prior.provenance!==audioProvenance(merged.providers)||prior.raw!==merged.segments.map(segment=>segment.text).join('\n')||JSON.stringify(prior.segments)!==JSON.stringify(normalizeSegments(merged.segments))||current.audit?.audioFileSha256!==merged.fileSha256||current.audit?.audioProcessingCoverage!==1)throw new ProviderError('TRANSCRIPT_PERSISTENCE_UNVERIFIED','기존 전사와 음성 계획이 일치하지 않습니다.');
    return json({job:current,source:prior,persisted:true,cached:true});
   }
   return json(await storeAudioTranscriptOnce(env,job,merged));
  }
  if(action==='audio-boundary-reconcile'&&['GET','POST'].includes(request.method)){
   const source=await sourceOf(env,id),audit=job.audit,chunks=audit?.audioChunks,origins=audit?.audioSegmentOrigins;
   if(job.source_type!=='audio'||audit?.audioProcessing!=='ALL_PLANNED_CHUNKS_PROCESSED'||audit.audioProcessingCoverage!==1||!/^[a-f0-9]{64}$/.test(audit.audioFileSha256||'')||!['GROQ_OWNED_AUDIO','GEMINI_OWNED_AUDIO','MIXED_OWNED_AUDIO'].includes(source?.provenance)||!Array.isArray(chunks)||chunks.length<2||!Array.isArray(origins)||origins.length!==source.segments?.length||source.raw!==source.segments.map(part=>part.text).join('\n'))throw new ProviderError('BOUNDARY_RECONCILE_SOURCE_INVALID','저장된 음성 원본·출처를 검증할 수 없습니다.');
   if(chunks.some((chunk,index)=>chunk.index!==index||!Number.isFinite(chunk.start)||!Number.isFinite(chunk.end)||chunk.start<0||chunk.end<=chunk.start||chunk.end-chunk.start>601||(!index&&chunk.start>.1)||(index&&chunk.start<Math.max(0,chunks[index-1].end-5))||(index&&chunk.start>chunks[index-1].end+.1)||chunk.end>job.duration_seconds+2)||Math.abs(chunks.at(-1).end-job.duration_seconds)>2)throw new ProviderError('BOUNDARY_RECONCILE_SOURCE_INVALID','저장된 음성 조각 시간축을 검증할 수 없습니다.');
   const retained=source.segments.map((part,index)=>{
    const origin=origins[index];
    if(part.id!==index+1||origin?.segmentId!==part.id||!Number.isSafeInteger(origin.chunkIndex)||origin.chunkIndex<0||origin.chunkIndex>=chunks.length||!Number.isSafeInteger(part.startMs)||!Number.isSafeInteger(part.endMs)||part.startMs!==origin.startMs||part.endMs!==origin.endMs||typeof part.text!=='string'||!part.text.trim()||part.startMs<0||part.endMs<=part.startMs||part.startMs<chunks[origin.chunkIndex].start*1000-101||part.endMs>chunks[origin.chunkIndex].end*1000+2001)throw new ProviderError('BOUNDARY_RECONCILE_SOURCE_INVALID','저장된 구간과 조각 출처가 일치하지 않습니다.');
    return {startMs:part.startMs,endMs:part.endMs,text:part.text,chunk:origin.chunkIndex};
   });
   const revised=boundaryMarkersFromRetained(chunks,retained),current=audit.audioBoundaryAmbiguities;
   if(!Array.isArray(current)||current.some(marker=>!revised.some(next=>JSON.stringify(next)===JSON.stringify(marker))))throw new ProviderError('BOUNDARY_RECONCILE_SOURCE_INVALID','기존 경계 검토 표시를 보존할 수 없습니다.');
   const changed=JSON.stringify(current)!==JSON.stringify(revised)||audit.audioBoundaryReview!==(revised.length?'NONIDENTICAL_OVERLAP_TEXT_RETAINED_UNVERIFIED':'NO_NONIDENTICAL_OVERLAP_TEXT');
   const preview={jobId:id,audioFileSha256:audit.audioFileSha256,sourceSegmentCount:source.segments.length,currentMarkerIds:current.map(item=>item.segmentId),revisedMarkerIds:revised.map(item=>item.segmentId),changed};
   if(request.method==='GET')return json(preview);
   const body=await readJson(request);
   if(body?.confirmBoundaryMetadataReconcile!==true||body.jobId!==id||body.audioFileSha256!==audit.audioFileSha256||JSON.stringify(body.currentMarkerIds)!==JSON.stringify(preview.currentMarkerIds)||JSON.stringify(body.revisedMarkerIds)!==JSON.stringify(preview.revisedMarkerIds))throw new InputError('검토한 경계 표시·파일 지문을 확인하세요.');
   if(!changed)return json({...preview,reconciled:false,cached:true});
   if(job.report)throw new ProviderError('BOUNDARY_RECONCILE_REPORT_EXISTS','기존 요약이 있어 경계 표시를 변경할 수 없습니다.');
   const revisedAudit={...audit,audioBoundaryReview:revised.length?'NONIDENTICAL_OVERLAP_TEXT_RETAINED_UNVERIFIED':'NO_NONIDENTICAL_OVERLAP_TEXT',audioBoundaryAmbiguities:revised};
   const summaryPrefix=id+':summary:';
   const updated=await env.DB.prepare("UPDATE jobs SET audit_json=?,updated_at=? WHERE id=? AND owner_id='owner' AND audit_json=? AND (report_json IS NULL OR report_json='null') AND EXISTS (SELECT 1 FROM yta_sources WHERE job_id=? AND raw=? AND segments_json=? AND provenance=?) AND NOT EXISTS (SELECT 1 FROM yta_operations WHERE job_id=? AND (provider='groq-summary' OR (provider='gemini' AND substr(id,1,length(?))=?) OR (provider IN ('groq','gemini') AND state='CLAIMED') OR (provider='deletion' AND state='DELETING')))").bind(JSON.stringify(revisedAudit),new Date().toISOString(),id,JSON.stringify(audit),id,source.raw,source.segments_json,source.provenance,id,summaryPrefix,summaryPrefix).run();
   if(updated.meta?.changes!==1)throw new ProviderError('BOUNDARY_RECONCILE_CONFLICT','요약 승인·원본·경계 기록이 변경됐습니다. 새로 검토하세요.');
   return json({...preview,reconciled:true,job:await ownedJob(env,id)});
  }
  if(action==='audio-cleanup'&&request.method==='POST'){
   const body=await readJson(request);
   if(body.confirmTemporaryTranscriptCleanup!==true)throw new InputError('임시 조각 전사 정리를 별도로 확인하세요.');
   const rows=(await env.DB.prepare('SELECT * FROM yta_audio WHERE job_id=? ORDER BY chunk_index').bind(id).all()).results||[];
   if(!rows.length){const source=await sourceOf(env,id);if(job.audit?.audioProcessingCoverage===1&&/^[a-f0-9]{64}$/.test(job.audit?.audioFileSha256||'')&&['GROQ_OWNED_AUDIO','GEMINI_OWNED_AUDIO','MIXED_OWNED_AUDIO'].includes(source?.provenance))return json({cleaned:false,alreadyCleaned:true,job});throw new ProviderError('AUDIO_INCOMPLETE','전체 전사 완료 기록이 없습니다.');}
   if(job.source_type!=='audio'||job.audit?.audioProcessing!=='ALL_PLANNED_CHUNKS_PROCESSED'||job.audit?.audioProcessingCoverage!==1)throw new ProviderError('AUDIO_INCOMPLETE','전체 전사 완료 기록이 없습니다.');
   const merged=completedAudio(rows,job.duration_seconds),expected=normalizeSegments(merged.segments);
   const source=await sourceOf(env,id);
   if(source?.provenance!==audioProvenance(merged.providers)||JSON.stringify(job.audit?.audioProviders??['groq'])!==JSON.stringify(merged.providers)||job.audit?.audioFileSha256!==merged.fileSha256||source.raw!==merged.segments.map(segment=>segment.text).join('\n')||JSON.stringify(source.segments)!==JSON.stringify(expected))throw new ProviderError('TRANSCRIPT_PERSISTENCE_UNVERIFIED','저장된 TXT와 전사 조각의 일치를 확인하지 못했습니다.');
   const operations=(await env.DB.prepare("SELECT id,provider,state,error_code FROM yta_operations WHERE job_id=? AND provider IN ('groq','gemini') AND id LIKE ?").bind(id,id+':audio:%').all()).results||[];
   let accounted=0;
   for(const row of rows){const attempts=[...audioAttempts(operations,id,row.chunk_index,'groq'),...audioAttempts(operations,id,row.chunk_index,'gemini')];accounted+=attempts.length;if(attempts.filter(operation=>operation.state==='DONE').length!==1||attempts.some(operation=>operation.state!=='DONE'&&!(operation.state==='FAILED_UNCERTAIN'&&operation.error_code==='429')&&!(operation.state==='BLOCKED'&&['QUOTA_EXHAUSTED','PRE_DISPATCH_BLOCKED','CAPACITY_WAIT'].includes(operation.error_code))))throw new ProviderError('AUDIO_OPERATION_UNCERTAIN','음성 처리 기록이 완료 상태인지 확인할 수 없습니다.');}
   if(accounted!==operations.length)throw new ProviderError('AUDIO_OPERATION_UNCERTAIN','알 수 없는 음성 처리 기록이 있습니다.');
   await env.DB.prepare("UPDATE yta_operations SET result_json=NULL WHERE job_id=? AND provider IN ('groq','gemini') AND state='DONE' AND id LIKE ?").bind(id,id+':audio:%').run();
   await env.DB.prepare('DELETE FROM yta_audio WHERE job_id=?').bind(id).run();
   return json({cleaned:true,job:await ownedJob(env,id),transcriptRetained:true});
  }
  return json({error:{code:'METHOD_NOT_ALLOWED'}},405);
 }catch(error){
  if(error instanceof InputError)return json({error:{code:error.code,message:error.message}},400);
  if(error instanceof ProviderError)return json({error:{code:error.code,message:error.message}},error.code==='NOT_FOUND'?404:409);
  if(/^SUMMARY_REVIEW_(SOURCE|PARTITION|OPERATIONS|APPROVAL|CHECKPOINT|CREDENTIAL)_INTERNAL$/.test(error?.safeReviewCode??''))return json({error:{code:error.safeReviewCode,message:error.message}},500);
  return json({error:{code:'LIVE_INTERNAL_ERROR',message:'실제 처리 단계 오류. 원문과 사용량을 확인하고 자동 재시도하지 마세요.'}},500);
 }
}
