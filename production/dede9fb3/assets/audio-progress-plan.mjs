// A read-only view of saved source-time coverage. The server owns dispatch decisions.
// Indicative Groq Whisper Large v3 Turbo rate checked on 2026-10-11.
// https://console.groq.com/docs/model/whisper-large-v3-turbo
export const GROQ_REFERENCE_USD_PER_HOUR=0.04;
export function fmtRetryDate(value,{locale='ko-KR',timeZone}={}){
 if(value==null)return '미확인';
 const date=new Date(value);
 if(!Number.isFinite(date.getTime()))return '미확인';
 return new Intl.DateTimeFormat(locale,{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short',...(timeZone?{timeZone}:{})}).format(date);
}
export function cleanedAudioComplete(progress,job){
 return progress?.temporaryResultsCleaned===true&&job?.audit?.audioProcessing==='ALL_PLANNED_CHUNKS_PROCESSED'&&job.audit.audioProcessingCoverage===1&&/^[a-f0-9]{64}$/.test(job.audit.audioFileSha256??'');
}
export function audioProgressPlan(progress,durationSeconds,now=Date.now()){
 const duration=durationSeconds;
 const chunks=Array.isArray(progress?.chunks)?progress.chunks:[];
 const indices=new Set(chunks.map(c=>c?.index));
 const expected=progress?.expectedChunkCount;
 const valid=Number.isFinite(duration)&&duration>0&&chunks.length>0&&indices.size===chunks.length&&chunks.every(c=>c&&Number.isInteger(c.index)&&c.index>=0&&c.index<chunks.length&&['DONE','PLANNED','PAUSED','UNCERTAIN','CLAIMED'].includes(c.state)&&Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.start>=0&&c.end>c.start&&c.end<=duration+0.001)&&(expected===undefined||Number.isInteger(expected)&&expected===chunks.length);
 if(!valid)return {valid:false,quoteAvailable:false,temporaryResultsCleaned:progress?.temporaryResultsCleaned===true};
 const ranges=chunks.filter(c=>c.state==='DONE'&&Number.isFinite(c.start)&&Number.isFinite(c.end))
  .map(c=>({start:Math.max(0,Math.min(duration,c.start)),end:Math.max(0,Math.min(duration,c.end))}))
  .filter(c=>c.end>c.start).sort((a,b)=>a.start-b.start);
 const merged=[];
 for(const range of ranges){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}
 const coveredSeconds=merged.reduce((sum,range)=>sum+range.end-range.start,0);
 let planEdge=0,planComplete=true;
 for(const c of [...chunks].sort((a,b)=>a.index-b.index)){if(c.start>planEdge+0.001)planComplete=false;planEdge=Math.max(planEdge,c.end);}
 if(planEdge<duration-0.001)planComplete=false;
 if(!planComplete)return {valid:false,planIncomplete:true,quoteAvailable:false,coveredSeconds,remainingSeconds:Math.max(0,duration-coveredSeconds),completedChunks:chunks.filter(c=>c.state==='DONE').length};
 const remaining=chunks.filter(c=>c.state!=='DONE').sort((a,b)=>a.index-b.index);
 const remainingRequestSeconds=remaining.reduce((sum,c)=>sum+(Number.isFinite(c.start)&&Number.isFinite(c.end)?Math.max(0,c.end-c.start):0),0);
 const billableGroqSeconds=remaining.reduce((sum,c)=>sum+Math.max(10,c.end-c.start),0);
 const next=remaining[0]??null;
 let nextKind='COMPLETE',nextAt=null;
 if(next){
  if(next.uncertainFailure&&!next.reviewedFreeRetryApproved)nextKind='REVIEW_REQUIRED';
  else if(next.reviewed429Required){
   nextKind='PROVIDER_RETRY';
   const groqRetry=next.reviewProvider==='groq';
   const providerAt=groqRetry?progress?.nextEligibleAt?.groq:null;
   const times=groqRetry?[next.resetAt,providerAt].filter(t=>Number.isFinite(t)&&t>now):[];
   nextAt=times.length?Math.max(...times):null;
  }else{
   // This phase has no verified-free Gemini status; ordinary and reviewed paths show only Groq timing.
   const providers=next.groqAllowed===false?[]:['groq'];
   const eligible=providers.map(p=>progress?.nextEligibleAt?.[p]).filter(t=>Number.isFinite(t)&&t>now);
   if(!providers.length)nextKind='NO_VERIFIED_FREE_PATH';
   else if(providers.every(p=>progress?.operationInFlight?.[p]===true)){nextKind='OPERATION_IN_FLIGHT';nextAt=eligible.length?Math.min(...eligible):null;}
   else if(eligible.length){nextKind=next.unknownCapacityProbeApproved?'UNKNOWN_PROBE_WAIT':'LOCAL_EARLIEST';nextAt=Math.min(...eligible);}
   else nextKind=next.unknownCapacityProbeApproved?'UNKNOWN_CAPACITY_PROBE':'CAPACITY_UNKNOWN';
  }
 }
 return {valid:true,quoteAvailable:remaining.length>0,coveredSeconds,remainingSeconds:Math.max(0,duration-coveredSeconds),remainingRequestSeconds,billableGroqSeconds,referenceGroqUsd:billableGroqSeconds/3600*GROQ_REFERENCE_USD_PER_HOUR,completedChunks:chunks.length-remaining.length,remainingChunks:remaining.length,totalChunks:chunks.length,nextIndex:next?.index??null,nextKind,nextAt,complete:progress?.complete===true&&remaining.length===0,temporaryResultsCleaned:false};
}
