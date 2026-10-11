// A read-only view of saved source-time coverage. The server owns dispatch decisions.
// Indicative Groq Whisper Large v3 Turbo rate checked on 2026-10-11.
// https://console.groq.com/docs/model/whisper-large-v3-turbo
export const GROQ_REFERENCE_USD_PER_HOUR=0.04;
export function cleanedAudioComplete(progress,job){
 return progress?.temporaryResultsCleaned===true&&job?.audit?.audioProcessing==='ALL_PLANNED_CHUNKS_PROCESSED'&&job.audit.audioProcessingCoverage===1&&/^[a-f0-9]{64}$/.test(job.audit.audioFileSha256??'');
}
export function audioProgressPlan(progress,durationSeconds,now=Date.now()){
 const duration=durationSeconds;
 const chunks=Array.isArray(progress?.chunks)?progress.chunks:[];
 const indices=new Set(chunks.map(c=>c?.index));
 const valid=Number.isFinite(duration)&&duration>0&&chunks.length>0&&indices.size===chunks.length&&chunks.every(c=>c&&Number.isInteger(c.index)&&c.index>=0&&['DONE','PLANNED','PAUSED','UNCERTAIN','CLAIMED'].includes(c.state)&&Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.start>=0&&c.end>c.start&&c.end<=duration+0.001);
 if(!valid)return {valid:false,quoteAvailable:false,temporaryResultsCleaned:progress?.temporaryResultsCleaned===true};
 const ranges=chunks.filter(c=>c.state==='DONE'&&Number.isFinite(c.start)&&Number.isFinite(c.end))
  .map(c=>({start:Math.max(0,Math.min(duration,c.start)),end:Math.max(0,Math.min(duration,c.end))}))
  .filter(c=>c.end>c.start).sort((a,b)=>a.start-b.start);
 const merged=[];
 for(const range of ranges){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}
 const coveredSeconds=merged.reduce((sum,range)=>sum+range.end-range.start,0);
 const remaining=chunks.filter(c=>c.state!=='DONE').sort((a,b)=>a.index-b.index);
 const remainingRequestSeconds=remaining.reduce((sum,c)=>sum+(Number.isFinite(c.start)&&Number.isFinite(c.end)?Math.max(0,c.end-c.start):0),0);
 const billableGroqSeconds=remaining.reduce((sum,c)=>sum+Math.max(10,c.end-c.start),0);
 const next=remaining[0]??null;
 let nextKind='COMPLETE',nextAt=null;
 if(next){
  if(next.uncertainFailure&&!next.reviewedFreeRetryApproved)nextKind='REVIEW_REQUIRED';
  else if(next.reviewed429Required){
   nextKind='PROVIDER_RETRY';
   const providerAt=progress?.nextEligibleAt?.[next.reviewProvider];
   const times=[next.resetAt,providerAt].filter(t=>Number.isFinite(t)&&t>now);
   nextAt=times.length?Math.max(...times):null;
  }else{
   // A reviewed uncertain operation can only resume through the explicit Groq recovery.
   const providers=next.reviewedFreeRetryApproved?['groq']:next.groqAllowed===false?['gemini']:['groq','gemini'];
   const eligible=providers.map(p=>progress?.nextEligibleAt?.[p]).filter(t=>Number.isFinite(t)&&t>now);
   if(providers.every(p=>progress?.operationInFlight?.[p]===true)){nextKind='OPERATION_IN_FLIGHT';nextAt=eligible.length?Math.min(...eligible):null;}
   else if(eligible.length){nextKind=next.unknownCapacityProbeApproved?'UNKNOWN_PROBE_WAIT':'LOCAL_EARLIEST';nextAt=Math.min(...eligible);}
   else nextKind=next.unknownCapacityProbeApproved?'UNKNOWN_CAPACITY_PROBE':'CAPACITY_UNKNOWN';
  }
 }
 return {valid:true,quoteAvailable:remaining.length>0,coveredSeconds,remainingSeconds:Math.max(0,duration-coveredSeconds),remainingRequestSeconds,billableGroqSeconds,referenceGroqUsd:billableGroqSeconds/3600*GROQ_REFERENCE_USD_PER_HOUR,completedChunks:chunks.length-remaining.length,remainingChunks:remaining.length,totalChunks:chunks.length,nextIndex:next?.index??null,nextKind,nextAt,complete:progress?.complete===true&&remaining.length===0,temporaryResultsCleaned:false};
}
