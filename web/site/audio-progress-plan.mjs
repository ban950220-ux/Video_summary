// A read-only view of saved source-time coverage. The server owns dispatch decisions.
// Indicative Groq Whisper Large v3 Turbo rate checked on 2026-10-11.
// https://console.groq.com/docs/model/whisper-large-v3-turbo
export const GROQ_REFERENCE_USD_PER_HOUR=0.04;
export function audioProgressPlan(progress,durationSeconds,now=Date.now()){
 const duration=Number.isFinite(durationSeconds)&&durationSeconds>0?durationSeconds:0;
 const chunks=Array.isArray(progress?.chunks)?progress.chunks:[];
 const ranges=chunks.filter(c=>c.state==='DONE'&&Number.isFinite(c.start)&&Number.isFinite(c.end))
  .map(c=>({start:Math.max(0,Math.min(duration,c.start)),end:Math.max(0,Math.min(duration,c.end))}))
  .filter(c=>c.end>c.start).sort((a,b)=>a.start-b.start);
 const merged=[];
 for(const range of ranges){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}
 const coveredSeconds=merged.reduce((sum,range)=>sum+range.end-range.start,0);
 const remaining=chunks.filter(c=>c.state!=='DONE').sort((a,b)=>a.index-b.index);
 const remainingRequestSeconds=remaining.reduce((sum,c)=>sum+(Number.isFinite(c.start)&&Number.isFinite(c.end)?Math.max(0,c.end-c.start):0),0);
 const next=remaining[0]??null;
 let nextKind='COMPLETE',nextAt=null;
 if(next){
  if(next.uncertainFailure&&!next.reviewedFreeRetryApproved)nextKind='REVIEW_REQUIRED';
  else if(next.reviewed429Required){nextKind='PROVIDER_RETRY';nextAt=Number.isFinite(next.resetAt)?next.resetAt:null;}
  else if(next.unknownCapacityProbeApproved)nextKind='UNKNOWN_CAPACITY_PROBE';
  else{
   const providers=next.reviewedFreeRetryApproved||next.groqAllowed===true?['groq','gemini']:['gemini'];
   const eligible=providers.map(p=>progress?.nextEligibleAt?.[p]).filter(t=>Number.isFinite(t)&&t>now);
   if(eligible.length){nextKind='LOCAL_EARLIEST';nextAt=Math.min(...eligible);}
   else nextKind='CAPACITY_UNKNOWN';
  }
 }
 return {coveredSeconds,remainingSeconds:Math.max(0,duration-coveredSeconds),remainingRequestSeconds,referenceGroqUsd:remainingRequestSeconds/3600*GROQ_REFERENCE_USD_PER_HOUR,completedChunks:chunks.length-remaining.length,remainingChunks:remaining.length,totalChunks:chunks.length,nextIndex:next?.index??null,nextKind,nextAt,complete:progress?.complete===true&&remaining.length===0,temporaryResultsCleaned:progress?.temporaryResultsCleaned===true};
}
