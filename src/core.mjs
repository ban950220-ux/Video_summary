// Pure core. No external services, tokens or payments. All costs are advisory estimates.
export class InputError extends Error {
  constructor(message, code='INVALID_INPUT') { super(message); this.name='InputError'; this.code=code; }
}

export const MAX_DURATION_SEC=7200;
export const DEFAULT_POLICY=Object.freeze({budgetUSD:0, paidCallsAllowed:false, freeOnly:true});

export function videoIdOf(input) {
  let url;
  try { url=new URL(input); } catch { throw new InputError('올바른 HTTPS YouTube 링크가 아닙니다.'); }
  if (url.protocol!=='https:') throw new InputError('HTTPS URL만 허용합니다.');
  const host=url.hostname.toLowerCase();
  if (url.username || url.password || url.port || !['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(host)) throw new InputError('허용된 YouTube 호스트가 아닙니다.');
  let id;
  if(host==='youtu.be') id=url.pathname.split('/')[1];
  else if(url.pathname==='/watch') id=url.searchParams.get('v');
  else if(url.pathname.startsWith('/shorts/') || url.pathname.startsWith('/live/')) id=url.pathname.split('/')[2];
  if(!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new InputError('유효하지 않은 YouTube 영상 ID입니다.');
  return id;
}

export function durationSec(value) {
  const duration=Number(value);
  if(!Number.isFinite(duration)||duration<=0||duration>MAX_DURATION_SEC) throw new InputError('길이는 1초 초과, 120분 이하여야 합니다.');
  return duration;
}

export function parseClock(value) {
  const m=String(value).trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/);
  if(!m) throw new InputError('타임코드 형식 오류: '+value,'INVALID_TIMESTAMP');
  const hrs=Number(m[1]||0),min=Number(m[2]),sec=Number(m[3]);
  if(min>59||sec>59) throw new InputError('타임코드 범위를 벗어났습니다.','INVALID_TIMESTAMP');
  return ((hrs*3600+min*60+sec)*1000)+Number(m[4].padEnd(3,'0'));
}

export function parseCaptions(raw, filename='captions.srt') {
  if(typeof raw!=='string'||raw.length>2_000_000) throw new InputError('전사 텍스트 크기를 확인하세요.');
  const txt=raw.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const lines=txt.split('\n');
  const cues=[];
  const time=/^\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s+-->\s+((?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3})/;
  for(let i=0;i<lines.length;i++){
    const m=lines[i].match(time);
    if(!m) continue;
    const startMs=parseClock(m[1]),endMs=parseClock(m[2]);
    if(startMs>=endMs) throw new InputError('자막 시작 시간이 종료 시간 이상입니다.','INVALID_CUE');
    const parts=[];
    for(i++;i<lines.length && lines[i].trim();i++){
      if(lines[i].trim().startsWith('NOTE ')) break;
      parts.push(lines[i].replace(/<[^>]*>/g,'').trim());
    }
    const text=parts.join(' ').trim();
    if(text) cues.push({startMs,endMs,text});
  }
  if(cues.length===0 && /\.(srt|vtt)$/i.test(filename)) throw new InputError('시각 정보가 포함된 유효한 자막이 없습니다.','NO_TIMED_CUES');
  if(cues.length===0){
    const stripped=txt.trim();
    if(!stripped) throw new InputError('빈 전사본입니다.');
    return {segments:[{startMs:null,endMs:null,text:stripped}],timed:false,origin:'USER_TXT'};
  }
  cues.sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs);
  return {segments:cues,timed:true,origin:'USER_CAPTION'};
}

export function transcriptAudit(segments, expectedDurationSec, independentlyVerified=false) {
  const d=durationSec(expectedDurationSec);
  const timed=segments.filter(x=>Number.isFinite(x.startMs)&&Number.isFinite(x.endMs));
  if(!timed.length) return {status:'TRANSCRIPT_UNVERIFIED',timelineRatio:null,spokenCoverageRatio:null,latestSec:null,confidence:'UNKNOWN',reason:'원문에 타임스탬프가 없습니다.'};
  const earliest=Math.min(...timed.map(x=>x.startMs)),latest=Math.max(...timed.map(x=>x.endMs));
  const valid=timed.every(x=>x.startMs>=0 && x.endMs>x.startMs && x.endMs<=d*1000+10_000);
  if(!valid) return {status:'PARTIAL_TRANSCRIPT',timelineRatio:Math.min(1,latest/(d*1000)),spokenCoverageRatio:null,latestSec:latest/1000,confidence:'LOW',reason:'원본 길이 초과 또는 잘못된 타임코드'};
  const ratio=Math.min(1,latest/(d*1000));
  const partial=ratio<.95 || earliest>Math.min(120_000,d*1000*.05);
  return {status:partial?'PARTIAL_TRANSCRIPT':(independentlyVerified?'FULL_TRANSCRIPT_VERIFIED':'TRANSCRIPT_UNVERIFIED'),timelineRatio:Number(ratio.toFixed(4)),spokenCoverageRatio:null,latestSec:latest/1000,confidence:partial?'LOW':independentlyVerified?'VERIFIED':'UNVERIFIED',reason:partial?'원본 대비 타임라인 시작/끝이 일부만 확보됨':independentlyVerified?'별도 범위 검증 완료':'타임라인 양끝은 있으나 누락 구간·정확성 독립 검증이 필요함'};
}

export function extractiveReport(transcript, maxBullets=8) {
  const strs=transcript.segments.map(x=>x.text.trim()).filter(Boolean);
  const selected=strs.slice(0,maxBullets);
  return {kind:'EXTRACTIVE_ONLY_NOT_AI',language:'ORIGINAL',summary:selected,translation: 'NOT_PERFORMED',warning:'원문 문장만 추출했습니다. AI 한국어 번역·의미 요약은 API 연결 전입니다.'};
}

export const PROVIDERS=Object.freeze([
  {id:'supadata',role:'CAPTION_URL',unit:'credits',period:'month',publishedFreeLimit:100, captionCredits:1, generatedCreditsPerMinute:2, canSupplyFullVerbatim:false, requiresKey:true},
  {id:'groq',role:'AUDIO_STT',unit:'audio_seconds',period:'day',publishedFreeLimit:28800, maxFreeFileBytes:25_000_000, paidUSDPerHour:.04, requiresKey:true},
  {id:'gemini',role:'VIDEO_ASSIST_OR_TEXT',unit:'multiple_limit_types',period:'mixed',publishedFreeLimit:null, requiresKey:true},
  {id:'assemblyai',role:'AUDIO_STT',unit:'audio_seconds',period:'credit_or_paid',publishedFreeLimit:null, paidUSDPerHour:.15, requiresKey:true}
]);

export function estimateSource({durationSeconds,sourceType='url',hasCaptions=null,hasOwnedAudio=false}) {
  const d=durationSec(durationSeconds),mins=d/60;
  const routes=[];
  if(sourceType==='url'){
    routes.push({provider:'supadata',capability:'URL_NATIVE_CAPTION_ONLY',available:'CONDITIONAL',creditsMin:1,creditsMax:1,notes:'mode=native 강제: 자막 없을 때도 206 응답은 1크레딧 청구됨. AI 자동 생성 비활성.'});
    routes.push({provider:'supadata',capability:'URL_GENERATED_ASR_OPTIONAL_DISABLED',available:'BLOCKED_BY_DEFAULT',creditsMin:2*Math.ceil(mins),creditsMax:2*Math.ceil(mins),notes:'mode=generate/auto는 무료 100크레딧 경로에서 비활성. 승인 및 잔여량 실측 후 별도 평가.'});
    routes.push({provider:'gemini',capability:'VIDEO_ASSIST',available:'CONDITIONAL',creditsMin:null,creditsMax:null,notes:'영상 이해는 FULL 전사와 다름'});
  }
  if(hasOwnedAudio||sourceType==='audio') routes.push({provider:'groq',capability:'AUDIO_STT',available:'CONDITIONAL',audioSeconds:d,paidCostUSD:Number((d/3600*.04).toFixed(4)),notes:'보유 음성/크기/포맷 검증이 선행돼야 함'});
  if(sourceType==='text') routes.push({provider:'local',capability:'TEXT_IMPORT',available:'YES',creditsMin:0,creditsMax:0});
  return routes;
}

// Offline admission estimate only. It never starts a provider request. A timed-out
// generation may still be billed, so reconcile it before considering a new attempt.
export function planSupadataUrlGeneration({durationSeconds,rightsConfirmed=false,publicAccessConfirmed=false,freePlanConfirmed=false,billingDisabledConfirmed=false,explicitGenerationApproval=false,freeCreditsRemaining=null,priorAttemptUncertain=false}) {
  const creditsReserved=2*Math.ceil(durationSec(durationSeconds)/60);
  const blockedReason=priorAttemptUncertain?'PRIOR_ATTEMPT_UNCERTAIN'
    :!rightsConfirmed?'RIGHTS_UNVERIFIED'
    :!publicAccessConfirmed?'PUBLIC_ACCESS_UNVERIFIED'
    :!explicitGenerationApproval?'GENERATION_APPROVAL_REQUIRED'
    :!freePlanConfirmed||!billingDisabledConfirmed?'FREE_BILLING_STATUS_UNVERIFIED'
    :!Number.isSafeInteger(freeCreditsRemaining)||freeCreditsRemaining<0?'FREE_CREDITS_UNVERIFIED'
    :creditsReserved>freeCreditsRemaining?'INSUFFICIENT_FREE_CREDITS':null;
  return {allowed:blockedReason===null,blockedReason,creditsReserved,creditBasis:'CONSERVATIVE_WHOLE_MINUTE_ESTIMATE_NOT_PROVIDER_CHARGE',requestMode:'generate',provider:'supadata'};
}

export function usableFreeUnits({limit,observedUsed=null,appUsed=0,reserved=0,otherUsageKnown=false}) {
  if(limit==null || !Number.isFinite(limit)) return {remaining:null,provenance:'UNKNOWN'};
  if(observedUsed!=null && Number.isFinite(observedUsed)) return {remaining:Math.max(0,limit-observedUsed-reserved),provenance:'EXACT_PROVIDER_SNAPSHOT',note:'조회 시점 이후 외부 소비는 반영되지 않을 수 있음'};
  if(!otherUsageKnown) return {remaining:null,provenance:'UNKNOWN',appEstimatedRemaining:Math.max(0,limit-appUsed-reserved)};
  return {remaining:Math.max(0,limit-appUsed-reserved),provenance:'ESTIMATED'};
}

export function budgetDecision({expectedUSD=0,policy=DEFAULT_POLICY,quota,requiredUnits=0}) {
  if(expectedUSD>0 && (!policy.paidCallsAllowed || expectedUSD>policy.budgetUSD)) return {allowed:false,reason:'BUDGET_BLOCKED'};
  if(requiredUnits>0){
    if(quota?.remaining===null || !quota) return {allowed:false,reason:'QUOTA_UNVERIFIED'};
    if(requiredUnits*1.2>quota.remaining) return {allowed:false,reason:'INSUFFICIENT_FREE_QUOTA'};
  }
  return {allowed:true,reason:'WITHIN_BUDGET'};
}

export function failoverDecision({errorCode,alternatives=[],rights='AUTHORIZED'}) {
  if(rights!=='AUTHORIZED') return {action:'BLOCK',reason:'RIGHTS_UNVERIFIED'};
  if(['401','403','RIGHTS','PRIVATE_VIDEO'].includes(String(errorCode))) return {action:'BLOCK',reason:'ACCESS_OR_RIGHTS'};
  if(['429','500','502','503','504','TIMEOUT','QUOTA'].includes(String(errorCode))) return alternatives.length?{action:'SWITCH_PROVIDER',provider:alternatives[0]}:{action:'WAIT_OR_UPLOAD'};
  if(['402','PAYMENT_REQUIRED'].includes(String(errorCode))) return {action:'BLOCK',reason:'PAYMENT_APPROVAL_REQUIRED'};
  return {action:'STOP',reason:'UNKNOWN_ERROR'};
}

export function remainingDaysForecast({history=[],currentUsed,limit}) {
  if(history.length<3||limit==null) return {estimatedDays:null,confidence:'LOW',reason:'최소 3일 관측 필요'};
  const last7=history.slice(-7),avg=last7.reduce((a,b)=>a+b,0)/last7.length;
  if(avg<=0) return {estimatedDays:null,confidence:'UNKNOWN',reason:'소비 없음'};
  return {estimatedDays:Math.max(0,(limit-currentUsed)/avg),confidence:history.length>=7?'MEDIUM':'LOW',dailyAverage:avg};
}
