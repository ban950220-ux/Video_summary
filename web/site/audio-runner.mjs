// Foreground-only, resumable audio dispatch. The server remains the authority for reservations.
const models={gemini:'gemini-2.5-flash',groq:'whisper-large-v3-turbo'};
function needed(provider,seconds){const units=provider==='gemini'?Math.ceil(seconds*32)+8704:Math.max(10,Math.ceil(seconds));return provider==='gemini'?{requestsMinute:1,tokensMinute:Math.ceil(units*1.25),requestsDay:1}:{requestsMinute:1,audioSecondsHour:Math.ceil(units*1.25)+60,audioSecondsDay:Math.ceil(units*1.25)+60};}
export function capacityReady(provider,seconds,snapshots,grants,at){
 const snapshot=snapshots.find(row=>row.provider===provider&&row.model===models[provider]);
 const grant=grants.find(row=>row.provider===provider);
 if(!snapshot||!grant||snapshot.valid_until<=at||grant.expires_at<=at||grant.billing_disabled!==1||grant.request_count>=grant.request_limit)return false;
 const units=provider==='gemini'?Math.ceil(seconds*32)+8704:Math.max(10,Math.ceil(seconds));
 if(grant.consumed+units>grant.allowance)return false;
 return Object.entries(needed(provider,seconds)).every(([key,value])=>Number.isSafeInteger(snapshot.remaining?.[key])&&Number.isSafeInteger(snapshot.reserved?.[key])&&snapshot.remaining[key]-snapshot.reserved[key]>=value);
}
export async function runAudioChunks({chunks,getProgress,getCapacity,getQuota,chooseProvider,sendChunk,review429,wait,now=Date.now,onUpdate=()=>{}}){
 for(const chunk of chunks){
  for(;;){
   const progress=await getProgress(),saved=progress.chunks.find(row=>row.index===chunk.index);
   if(!saved)return {complete:false,reason:'PLAN_MISSING',index:chunk.index};
   if(saved.state==='DONE')break;
   if(saved.uncertainFailure||saved.state==='UNCERTAIN')return {complete:false,reason:'OPERATION_REVIEW_REQUIRED',index:chunk.index};
   const provider=chooseProvider(chunk,saved);
   if(!['gemini','groq'].includes(provider))return {complete:false,reason:'PROVIDER_NOT_AUTHORIZED',index:chunk.index};
   const [capacity,quota]=await Promise.all([getCapacity(),getQuota()]);const at=now();
   if(!capacityReady(provider,chunk.end-chunk.start,capacity.snapshots,quota.grants,at))return {complete:false,reason:'CAPACITY_OR_GRANT_REOBSERVATION_REQUIRED',index:chunk.index};
   if(progress.operationInFlight?.[provider])return {complete:false,reason:'OPERATION_IN_FLIGHT',index:chunk.index};
   const eligible=progress.nextEligibleAt?.[provider];
   if(Number.isFinite(eligible)&&eligible>at){
    const expiry=capacity.snapshots.find(row=>row.provider===provider)?.valid_until;
    if(eligible>=expiry||eligible-at>13000)return {complete:false,reason:'WAIT_FOR_PROVIDER_AND_REOBSERVE',index:chunk.index,nextEligibleAt:eligible};
    onUpdate({index:chunk.index,provider,waitingUntil:eligible});await wait(eligible-at);continue;
   }
   let reviewedId=null;
   if(saved.reviewed429Required){reviewedId=await review429(chunk,saved,provider);if(reviewedId!==saved.reviewOperationId)return {complete:false,reason:'PROVIDER_429_REVIEW_REQUIRED',index:chunk.index};}
   onUpdate({index:chunk.index,provider,sending:true,coveragePercent:progress.coveragePercent});
   try{const result=await sendChunk(chunk,provider,reviewedId);if(result?.state!=='DONE')return {complete:false,reason:result?.code||'AUDIO_RESULT_UNVERIFIED',index:chunk.index};}
   catch(error){return {complete:false,reason:error?.code||'DISPATCH_OUTCOME_UNKNOWN_REVIEW_REQUIRED',index:chunk.index};}
   onUpdate({index:chunk.index,provider,done:true});break;
  }
 }
 const progress=await getProgress();return {complete:progress.complete===true,reason:progress.complete?'COMPLETE':'COVERAGE_UNVERIFIED'};
}
