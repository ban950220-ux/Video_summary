import {InputError,transcriptAudit} from './core.mjs';
import {ProviderError} from './adapters.mjs';
import {runNativeCaption,runNativePoll,runTranscriptSummary,runOwnedAudioTranscription} from './provider-keys.mjs';
import {normalizeSegments,auditGaps,validateAnalysis,reportPrompt,markdownReport} from './report.mjs';
import {scanMp3,mergeAudioSegments} from './audio.mjs';
import {partitionTranscript,partitionSynthesis,synthesisPrompt,summaryUnits,evidenceIds,assertGroupCoverage} from './summary-plan.mjs';
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
async function ownedJob(env,id){const row=await env.DB.prepare('SELECT * FROM jobs WHERE id=? AND owner_id=?').bind(id,'owner').first();if(!row)throw new ProviderError('NOT_FOUND','분석 기록 없음');return {...row,report:JSON.parse(row.report_json||'null'),audit:JSON.parse(row.audit_json||'null')};}
async function updateJob(env,id,status,report,audit){await env.DB.prepare('UPDATE jobs SET status=?,report_json=?,audit_json=?,updated_at=? WHERE id=? AND owner_id=?').bind(status,JSON.stringify(report),JSON.stringify(audit),new Date().toISOString(),id,'owner').run();}
async function grantEnv(env,provider){
 if(env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true')throw new ProviderError('LIVE_DISABLED','라이브 무료 호출을 아직 활성화하지 않았습니다.');
 const quota=await env.DB.prepare('SELECT * FROM yta_quota WHERE provider=?').bind(provider).first();
 if(!quota||quota.billing_disabled!==1||quota.expires_at<=Date.now())throw new ProviderError('QUOTA_UNVERIFIED','설정에서 결제 비활성·무료 잔여량을 먼저 확인하세요.');
 const credential=await env.DB.prepare('SELECT updated_at FROM provider_credentials WHERE owner_id=? AND provider=?').bind('owner',provider).first();
 if(credential&&Date.parse(credential.updated_at)>quota.confirmed_at)throw new ProviderError('KEY_CHANGED','키 변경 뒤 무료 계정 확인을 다시 해야 합니다.');
 return {...env,[provider.toUpperCase()+'_FREE_PLAN_CONFIRMED']:'true'};
}
async function execute(env,{id,job,provider,units},fn){
 const prior=await env.DB.prepare('SELECT * FROM yta_operations WHERE id=?').bind(id).first();
 if(prior?.state==='DONE')return JSON.parse(prior.result_json);
 if(prior&&!(prior.state==='BLOCKED'&&prior.error_code==='QUOTA_EXHAUSTED'))throw new ProviderError('OPERATION_REVIEW_REQUIRED','이미 요청했거나 결과가 불명확한 작업입니다. 사용량을 확인한 뒤 새 작업으로 진행하세요.');
 const active=await grantEnv(env,provider);
 // Atomic unique claim and atomic quota decrement: concurrent calls cannot overspend this app's grant.
 const claim=prior
  ?await env.DB.prepare('UPDATE yta_operations SET state=?,error_code=NULL WHERE id=? AND state=? AND error_code=?').bind('CLAIMED',id,'BLOCKED','QUOTA_EXHAUSTED').run()
  :await env.DB.prepare('INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').bind(id,job,provider,units,'CLAIMED',new Date().toISOString()).run();
 if(claim.meta?.changes!==1)throw new ProviderError('OPERATION_BUSY','중복 요청 차단');
 const reserve=await env.DB.prepare('UPDATE yta_quota SET consumed=consumed+?,request_count=request_count+1 WHERE provider=? AND consumed+?<=allowance AND request_count<request_limit AND expires_at>? AND billing_disabled=1').bind(units,provider,units,Date.now()).run();
 if(reserve.meta?.changes!==1){await env.DB.prepare('UPDATE yta_operations SET state=?,error_code=? WHERE id=?').bind('BLOCKED','QUOTA_EXHAUSTED',id).run();throw new ProviderError('QUOTA_EXHAUSTED','무료 사용량 또는 요청 횟수 한도에 도달했습니다.');}
 try{
  const result=await fn(active);
  // Conservative accounting: reserved upper bound stays consumed even on provider timeout or mismatch.
  await env.DB.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),job,'owner',provider,'LIVE_FREE',provider==='groq'?'audio_seconds':provider==='supadata'?'credits':'conservative_token_units',units,0,null,'APP_RESERVED_UPPER_BOUND',new Date().toISOString()).run();
  await env.DB.prepare('UPDATE yta_operations SET state=?,result_json=? WHERE id=?').bind('DONE',JSON.stringify(result),id).run();return result;
 }catch(error){
  await env.DB.prepare('UPDATE yta_operations SET state=?,error_code=? WHERE id=?').bind('FAILED_UNCERTAIN',String(error.code||'PROCESSING_FAILED'),id).run();
  if(['402','429','403'].includes(String(error.code)))await env.DB.prepare('UPDATE yta_quota SET expires_at=0 WHERE provider=?').bind(provider).run();
  throw error;
 }
}
async function storeTranscriptResult(env,job,segments,provenance,extra={}){
 const raw=segments.map(s=>s.text).join('\n'),clean=await saveSource(env,job.id,raw,segments,provenance);
 const audit={...transcriptAudit(clean,job.duration_seconds,false),...auditGaps(clean,job.duration_seconds),...extra};
 await updateJob(env,job.id,audit.status,null,audit);return {job:await ownedJob(env,job.id),source:{segments:clean,provenance},persisted:true};
}
async function storeAudioTranscriptOnce(env,job,merged){
 const raw=merged.segments.map(segment=>segment.text).join('\n'),clean=normalizeSegments(merged.segments);
 if(new TextEncoder().encode(raw+JSON.stringify(clean)).byteLength>1500000)throw new InputError('보관 원문 크기 제한');
 const audit={...transcriptAudit(clean,job.duration_seconds,false),...auditGaps(clean,job.duration_seconds),audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:merged.fileSha256,independentVerification:false};
 // Commit the final audit before making the source visible to summary requests.
 // A stale second finisher cannot reset a report created after the first insert.
 await env.DB.prepare("UPDATE jobs SET status=?,audit_json=?,updated_at=? WHERE id=? AND owner_id=? AND (report_json IS NULL OR report_json='null') AND (audit_json IS NULL OR json_extract(audit_json,'$.audioProcessingCoverage') IS NULL)").bind(audit.status,JSON.stringify(audit),new Date().toISOString(),job.id,'owner').run();
 await env.DB.prepare('INSERT OR IGNORE INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(job.id,raw,JSON.stringify(clean),'GROQ_OWNED_AUDIO',new Date().toISOString()).run();
 const source=await sourceOf(env,job.id),savedJob=await ownedJob(env,job.id);
 if(source?.provenance!=='GROQ_OWNED_AUDIO'||source.raw!==raw||JSON.stringify(source.segments)!==JSON.stringify(clean)||savedJob.audit?.audioFileSha256!==merged.fileSha256||savedJob.audit?.audioProcessingCoverage!==1)throw new ProviderError('TRANSCRIPT_PERSISTENCE_UNVERIFIED','저장된 전사 또는 완료 기록이 일치하지 않습니다.');
 return {job:savedJob,source:{segments:clean,provenance:'GROQ_OWNED_AUDIO'},persisted:true};
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
  return {index:row.chunk_index,start:row.start_sec,end:row.end_sec,segments:result.segments};
 });
 if(hashes.size!==1)throw new ProviderError('AUDIO_FILE_MISMATCH','음성 파일 지문이 일치하지 않습니다.');
 const merged=mergeAudioSegments(chunks);
 if(merged.missingChunks.length||!merged.segments.length||merged.rejectedSegments.some(item=>item.reason!=='OVERLAP_DUPLICATE'))throw new ProviderError('AUDIO_INCOMPLETE','누락되거나 범위를 벗어난 전사 조각이 있습니다.');
 return {...merged,fileSha256:[...hashes][0]};
}
async function boundedBytes(req,max){const reader=req.body?.getReader();if(!reader)throw new InputError('빈 음성');let size=0;const arrays=[];while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new InputError('음성 조각은 8MB 이하');}arrays.push(value);}const bytes=new Uint8Array(size);let at=0;for(const arr of arrays){bytes.set(arr,at);at+=arr.length;}return bytes;}
export async function routeLive(request,env){
 const url=new URL(request.url),path=url.pathname;
 if(!(request.method==='DELETE'&&/^\/api\/jobs\/[0-9a-f-]{36}$/i.test(path))&&!path.startsWith('/api/live/')&&!/\/(native|native-poll|summary|summary-plan|source|export|audio-plan|audio-progress|audio-chunk|audio-finish|audio-cleanup)$/.test(path))return null;
 try{
 if(request.method==='DELETE'&&/^\/api\/jobs\/[0-9a-f-]{36}$/i.test(path)){await ensureLiveSchema(env);const id=path.split('/').pop();await ownedJob(env,id);for(const table of ['yta_sources','yta_audio'])await env.DB.prepare('DELETE FROM '+table+' WHERE job_id=?').bind(id).run();await env.DB.prepare('UPDATE yta_operations SET result_json=NULL WHERE job_id=?').bind(id).run();await env.DB.prepare('DELETE FROM jobs WHERE id=? AND owner_id=?').bind(id,'owner').run();return json({deleted:true,id});}
  await ensureLiveSchema(env);
  if(path==='/api/live/quota'&&request.method==='GET')return json({grants:(await env.DB.prepare('SELECT * FROM yta_quota').bind().all()).results||[],liveEnabled:env.ENABLE_LIVE_FREE==='true',budgetUSD:0,provenance:'OWNER_ATTESTED_APP_GRANT_NOT_PROVIDER_VERIFIED'});
  if(path==='/api/live/quota'&&request.method==='DELETE'){const body=await readJson(request);if(!['supadata','gemini','groq'].includes(body.provider))throw new InputError('제공자 오류');await env.DB.prepare('UPDATE yta_quota SET expires_at=0 WHERE provider=?').bind(body.provider).run();return json({revoked:true});}
  if(path==='/api/live/quota'&&request.method==='PUT'){
   const body=await readJson(request),provider=body.provider;
   if(!['supadata','gemini','groq'].includes(provider)||body.billingDisabled!==true||body.freeOnly!==true)throw new InputError('무료 전용·결제 비활성 확인이 필요합니다.');
   const caps={supadata:100,groq:28800,gemini:250000};
   if(!Number.isFinite(body.allowance)||body.allowance<=0||body.allowance>caps[provider]||!Number.isInteger(body.requestLimit)||body.requestLimit<1||body.requestLimit>100)throw new InputError('무료 잔여량/요청 수를 확인하세요.');
   // Reconfirming never resets consumption within a grant's lifetime.
   const old=await env.DB.prepare('SELECT * FROM yta_quota WHERE provider=?').bind(provider).first();
   if(old&&old.expires_at>Date.now())throw new ProviderError('ACTIVE_GRANT_EXISTS','현재 할당이 유효합니다. 중복 설정으로 사용량을 초기화할 수 없습니다.');
   await env.DB.prepare('INSERT INTO yta_quota(provider,allowance,consumed,request_limit,request_count,expires_at,confirmed_at,billing_disabled) VALUES(?,?,0,?,0,?,?,1) ON CONFLICT(provider) DO UPDATE SET allowance=excluded.allowance,consumed=0,request_limit=excluded.request_limit,request_count=0,expires_at=excluded.expires_at,confirmed_at=excluded.confirmed_at,billing_disabled=1').bind(provider,body.allowance,body.requestLimit,Date.now()+3600000,Date.now()).run();
   return json({configured:true,provider,expiresInSeconds:3600,verification:'OWNER_ATTESTED_NOT_INDEPENDENTLY_VERIFIED'});
  }
  const match=path.match(/^\/api\/jobs\/([0-9a-f-]{36})\/(native|native-poll|summary|summary-plan|source|export|audio-plan|audio-progress|audio-chunk|audio-finish|audio-cleanup)$/i);if(!match)return json({error:{code:'NOT_FOUND'}},404);
  const id=match[1],action=match[2],job=await ownedJob(env,id);
  if(action==='source'&&request.method==='GET')return json({source:await sourceOf(env,id)});
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
   if(job.status!=='NATIVE_PENDING'||!job.audit?.providerJobId)throw new InputError('조회할 자막 대기 작업이 없습니다.');
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
  if(action==='summary'&&request.method==='POST'){
   const source=await sourceOf(env,id);if(!source?.segments.length)throw new InputError('전사 원문부터 확보하세요.');
   if(job.report?.kind==='GEMINI_EVIDENCE_LINKED')return json({job,persisted:true,cached:true});
   const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([source.segments,job.audit]))))).map(x=>x.toString(16).padStart(2,'0')).join('');
   const ask=async(key,prompt,allowed,stage)=>{
    const response=await execute(env,{id:id+':summary:'+fingerprint+':'+key,job:id,provider:'gemini',units:summaryUnits(prompt)},active=>runTranscriptSummary({env:{...active,SUMMARY_JSON:'true',SUMMARY_STAGE_OUTPUT_TOKENS:stage?'2048':'8192'},text:prompt}));
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
     }
     parts=next;
    }
    report=parts[0].report;
    assertGroupCoverage(report,groups.map(chunk=>({ids:chunk.map(s=>s.id)})));
   }
   await updateJob(env,id,job.status,report,{...job.audit,summaryProvider:'gemini',externalFactCheck:'NOT_PERFORMED'});return json({job:await ownedJob(env,id),persisted:true});
  }
  if(action==='audio-plan'&&request.method==='POST'){
   if((await sourceOf(env,id))?.provenance==='GROQ_OWNED_AUDIO')throw new InputError('완료된 전사입니다. 저장된 TXT를 확인하세요.');
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
  if(action==='audio-progress'&&request.method==='GET'){
   const rows=(await env.DB.prepare('SELECT chunk_index,start_sec,end_sec,state FROM yta_audio WHERE job_id=? ORDER BY chunk_index').bind(id).all()).results||[];
   return json({chunks:rows.map(c=>({index:c.chunk_index,start:c.start_sec,end:c.end_sec,state:c.state})),complete:rows.length>0&&rows.every(c=>c.state==='DONE'),temporaryResultsCleaned:rows.length===0&&job.audit?.audioProcessingCoverage===1});
  }
  if(action==='audio-chunk'&&request.method==='POST'){
   const index=Number(url.searchParams.get('index'));if(!Number.isInteger(index)||index<0)throw new InputError('조각 번호 오류');
   const chunk=await env.DB.prepare('SELECT * FROM yta_audio WHERE job_id=? AND chunk_index=?').bind(id,index).first();if(!chunk)throw new InputError('음성 조각 계획부터 저장하세요.');
   if(chunk.state==='DONE')return json({index,state:'DONE',cached:true});
   const bytes=await boundedBytes(request,8000000),name=url.searchParams.get('name')||'chunk.mp3';
   if(!/\.mp3$/i.test(name))throw new InputError('대용량 분할 전사는 MP3 입력을 사용하세요.');
   const duration=scanMp3(bytes).durationSeconds;if(Math.abs(duration-(chunk.end_sec-chunk.start_sec))>1)throw new InputError('음성 조각 길이와 계획이 다릅니다.');
   const result=await execute(env,{id:id+':audio:'+index,job:id,provider:'groq',units:Math.max(10,Math.ceil(duration))},active=>runOwnedAudioTranscription({env:active,bytes,name:'chunk.mp3',mime:'audio/mpeg',durationSeconds:duration}));
   if(!Array.isArray(result.segments)||!result.segments.length)throw new ProviderError('EMPTY_AUDIO_TRANSCRIPT','음성 조각 전사가 비었습니다. 전체 전사로 처리하지 않습니다.');
   await env.DB.prepare('UPDATE yta_audio SET state=?,result_json=? WHERE job_id=? AND chunk_index=?').bind('DONE',JSON.stringify({...result,fileSha256:JSON.parse(chunk.result_json).fileSha256}),id,index).run();return json({index,state:'DONE',segmentCount:result.segments.length});
  }
  if(action==='audio-finish'&&request.method==='POST'){
   const rows=(await env.DB.prepare('SELECT * FROM yta_audio WHERE job_id=? ORDER BY chunk_index').bind(id).all()).results||[];
   if(!rows.length){const source=await sourceOf(env,id);if(source?.provenance==='GROQ_OWNED_AUDIO'&&job.audit?.audioProcessingCoverage===1&&/^[a-f0-9]{64}$/.test(job.audit?.audioFileSha256||''))return json({job,source,persisted:true,cached:true});}
   const merged=completedAudio(rows,job.duration_seconds);
   const prior=await sourceOf(env,id);
   if(prior){
    if(prior.provenance!=='GROQ_OWNED_AUDIO'||prior.raw!==merged.segments.map(segment=>segment.text).join('\n')||JSON.stringify(prior.segments)!==JSON.stringify(normalizeSegments(merged.segments))||job.audit?.audioFileSha256!==merged.fileSha256||job.audit?.audioProcessingCoverage!==1)throw new ProviderError('TRANSCRIPT_PERSISTENCE_UNVERIFIED','기존 전사와 음성 계획이 일치하지 않습니다.');
    return json({job,source:prior,persisted:true,cached:true});
   }
   return json(await storeAudioTranscriptOnce(env,job,merged));
  }
  if(action==='audio-cleanup'&&request.method==='POST'){
   const body=await readJson(request);
   if(body.confirmTemporaryTranscriptCleanup!==true)throw new InputError('임시 조각 전사 정리를 별도로 확인하세요.');
   const rows=(await env.DB.prepare('SELECT * FROM yta_audio WHERE job_id=? ORDER BY chunk_index').bind(id).all()).results||[];
   if(!rows.length){const source=await sourceOf(env,id);if(job.audit?.audioProcessingCoverage===1&&/^[a-f0-9]{64}$/.test(job.audit?.audioFileSha256||'')&&source?.provenance==='GROQ_OWNED_AUDIO')return json({cleaned:false,alreadyCleaned:true,job});throw new ProviderError('AUDIO_INCOMPLETE','전체 전사 완료 기록이 없습니다.');}
   if(job.source_type!=='audio'||job.audit?.audioProcessing!=='ALL_PLANNED_CHUNKS_PROCESSED'||job.audit?.audioProcessingCoverage!==1)throw new ProviderError('AUDIO_INCOMPLETE','전체 전사 완료 기록이 없습니다.');
   const merged=completedAudio(rows,job.duration_seconds),expected=normalizeSegments(merged.segments);
   const source=await sourceOf(env,id);
   if(source?.provenance!=='GROQ_OWNED_AUDIO'||job.audit?.audioFileSha256!==merged.fileSha256||source.raw!==merged.segments.map(segment=>segment.text).join('\n')||JSON.stringify(source.segments)!==JSON.stringify(expected))throw new ProviderError('TRANSCRIPT_PERSISTENCE_UNVERIFIED','저장된 TXT와 전사 조각의 일치를 확인하지 못했습니다.');
   const operations=(await env.DB.prepare("SELECT id,state FROM yta_operations WHERE job_id=? AND provider='groq' AND id LIKE ?").bind(id,id+':audio:%').all()).results||[];
   const completedIds=new Set(operations.filter(operation=>operation.state==='DONE').map(operation=>operation.id));
   if(operations.length!==rows.length||completedIds.size!==rows.length||rows.some(row=>!completedIds.has(id+':audio:'+row.chunk_index)))throw new ProviderError('AUDIO_OPERATION_UNCERTAIN','음성 처리 기록이 완료 상태인지 확인할 수 없습니다.');
   await env.DB.prepare("UPDATE yta_operations SET result_json=NULL WHERE job_id=? AND provider='groq' AND state='DONE' AND id LIKE ?").bind(id,id+':audio:%').run();
   await env.DB.prepare('DELETE FROM yta_audio WHERE job_id=?').bind(id).run();
   return json({cleaned:true,job:await ownedJob(env,id),transcriptRetained:true});
  }
  return json({error:{code:'METHOD_NOT_ALLOWED'}},405);
 }catch(error){
  if(error instanceof InputError)return json({error:{code:error.code,message:error.message}},400);
  if(error instanceof ProviderError)return json({error:{code:error.code,message:error.message}},error.code==='NOT_FOUND'?404:409);
  return json({error:{code:'LIVE_INTERNAL_ERROR',message:'실제 처리 단계 오류. 원문과 사용량을 확인하고 자동 재시도하지 마세요.'}},500);
 }
}
