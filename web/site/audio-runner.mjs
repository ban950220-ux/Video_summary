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
export function detailRequestIsCurrent({expectedRequestId,currentRequestId,expectedJobId,visibleJobId,view,hidden}){
 return expectedRequestId===currentRequestId&&expectedJobId===visibleJobId&&view==='library'&&hidden===false;
}
export function beginDetailAction(target,jobId,currentRequestId){
 target.dataset.jobId=jobId;
 return currentRequestId+1;
}
export async function runApprovedFreeBatch({jobId,fileSha256,approvedChunkIds,chunks,getBatch,getProgress,sendChunk,wait,foreground=()=>true,now=Date.now,onUpdate=()=>{}}){
 const expected=approvedChunkIds;
 if(!Array.isArray(expected)||!expected.length||expected.some((index,i)=>!Number.isInteger(index)||i&&index<=expected[i-1]||!chunks.some(c=>c.index===index)))return {complete:false,reason:'FREE_BATCH_SCOPE_INVALID'};
 for(const index of expected){
  if(!foreground())return {complete:false,reason:'FOREGROUND_REQUIRED',index};
  const [batch,progress]=await Promise.all([getBatch(),getProgress()]);
  if(batch?.jobId!==jobId||batch.fileSha256!==fileSha256||batch.model!=='whisper-large-v3-turbo'||batch.state!=='APPROVED'||batch.expiresAt<=now()||JSON.stringify(batch.chunkIds)!==JSON.stringify(expected)||batch.maxRequests!==expected.length||!Number.isSafeInteger(batch.maxAudioSeconds))return {complete:false,reason:'FREE_BATCH_APPROVAL_CHANGED',index};
  const saved=progress.chunks?.find(row=>row.index===index);
  if(saved?.state==='DONE')continue;
  if(!['PLANNED','PAUSED'].includes(saved?.state)||saved.uncertainFailure||saved.reviewed429Required)return {complete:false,reason:'FREE_BATCH_CHUNK_REVIEW_REQUIRED',index};
  if(progress.operationInFlight?.groq)return {complete:false,reason:'OPERATION_IN_FLIGHT',index};
  if(Number.isFinite(progress.nextEligibleAt?.groq)&&progress.nextEligibleAt.groq>now())return {complete:false,reason:'GROQ_COOLDOWN_PENDING',index,nextEligibleAt:progress.nextEligibleAt.groq};
  if(!foreground())return {complete:false,reason:'FOREGROUND_REQUIRED',index};
  onUpdate({index,sending:true});
  let result;try{result=await sendChunk(chunks.find(c=>c.index===index));}catch(error){return {complete:false,reason:error?.code||'DISPATCH_OUTCOME_UNKNOWN_REVIEW_REQUIRED',index};}
  if(result?.state!=='DONE')return {complete:false,reason:result?.code||'AUDIO_RESULT_UNVERIFIED',index};
  onUpdate({index,done:true});
  if(index!==expected.at(-1)){try{await wait(61_000);}catch{return {complete:false,reason:'FOREGROUND_REQUIRED',index};}}
 }
 return {complete:true,summaryStarted:false,reason:'BATCH_COMPLETE_BEFORE_SUMMARY'};
}
export async function runApprovedGroqSummary({jobId,scope,getApproval,sendStage,wait,foreground=()=>true,now=Date.now,onUpdate=()=>{}}){
 if(scope?.jobId!==jobId||scope.model!=='openai/gpt-oss-120b'||scope.state!=='APPROVED'||!Number.isSafeInteger(scope.maxRequests)||scope.maxRequests<1)return {complete:false,reason:'SUMMARY_APPROVAL_INVALID'};
 for(let stage=0;stage<=scope.maxRequests;stage++){
  if(!foreground())return {complete:false,reason:'FOREGROUND_REQUIRED'};
  const fresh=await getApproval();
  if(fresh?.approved===false&&fresh.jobId===jobId&&fresh.transcriptHash===scope.transcriptHash&&fresh.windowStart===scope.windowStart+scope.maxRequests)return {complete:false,reason:'SUMMARY_WINDOW_COMPLETE',completed:fresh.windowStart,totalRequests:fresh.totalRequests};
  if(fresh?.jobId!==jobId||fresh.transcriptHash!==scope.transcriptHash||fresh.model!==scope.model||fresh.state!=='APPROVED'||fresh.windowStart!==scope.windowStart||fresh.totalRequests!==scope.totalRequests||fresh.maxRequests!==scope.maxRequests||fresh.maxInputTokensPerRequest!==scope.maxInputTokensPerRequest||fresh.maxCompletionTokensPerRequest!==scope.maxCompletionTokensPerRequest||fresh.totalTokenUpperBound!==scope.totalTokenUpperBound||fresh.credentialGeneration!==scope.credentialGeneration||fresh.expiresAt!==scope.expiresAt||fresh.expiresAt<=now())return {complete:false,reason:'SUMMARY_APPROVAL_CHANGED'};
  if(!foreground())return {complete:false,reason:'FOREGROUND_REQUIRED'};
  let result;try{result=await sendStage();}catch(error){return {complete:false,reason:error?.code||'SUMMARY_OUTCOME_UNKNOWN_REVIEW_REQUIRED'};}
  if(!result?.pending)return result?.windowComplete?{complete:false,reason:'SUMMARY_WINDOW_COMPLETE',completed:result.completed,totalRequests:result.totalRequests}:result?.job?.report?.kind==='GROQ_EVIDENCE_LINKED'?{complete:true,result}:{complete:false,reason:'SUMMARY_RESULT_UNVERIFIED'};
  onUpdate({stage:result.stage});
  if(stage===scope.maxRequests)return {complete:false,reason:'SUMMARY_STAGE_LIMIT_REACHED'};
  try{await wait(61_000);}catch{return {complete:false,reason:'FOREGROUND_REQUIRED'};}
 }
 return {complete:false,reason:'SUMMARY_STAGE_LIMIT_REACHED'};
}
export async function runAudioChunks({chunks,getProgress,getCapacity,getQuota,chooseProvider,authorizedProviders=()=>['groq','gemini'],sendChunk,review429,wait,now=Date.now,foreground=()=>true,onUpdate=()=>{}}){
 for(const chunk of chunks){
  for(;;){
   const progress=await getProgress(),saved=progress.chunks.find(row=>row.index===chunk.index);
   if(!saved)return {complete:false,reason:'PLAN_MISSING',index:chunk.index};
   if(saved.state==='DONE')break;
   const requested=chooseProvider(chunk,saved),authorized=authorizedProviders(chunk,saved);
   if((saved.uncertainFailure||saved.state==='UNCERTAIN')&&!(saved.reviewedFreeRetryApproved&&requested==='groq'))return {complete:false,reason:'OPERATION_REVIEW_REQUIRED',index:chunk.index};
   const candidates=(requested==='auto'?['groq','gemini']:[requested]).filter(provider=>['groq','gemini'].includes(provider)&&authorized.includes(provider)&&(provider!=='groq'||saved.groqAllowed!==false));
   if(!candidates.length)return {complete:false,reason:'NO_AUTHORIZED_PROVIDER',index:chunk.index};
   const [capacity,quota]=await Promise.all([getCapacity(),getQuota()]);const at=now();
   const ready=candidates.filter(provider=>saved.unknownCapacityProbeApproved&&requested==='groq'&&provider==='groq'||capacityReady(provider,chunk.end-chunk.start,capacity.snapshots,quota.grants,at));
   if(!ready.length)return {complete:false,reason:requested==='auto'?'NO_AUTHORIZED_PROVIDER_WITH_VALID_CAPACITY':'CAPACITY_OR_GRANT_REOBSERVATION_REQUIRED',index:chunk.index};
   const idle=ready.filter(provider=>!progress.operationInFlight?.[provider]);
   if(!idle.length)return {complete:false,reason:'OPERATION_IN_FLIGHT',index:chunk.index};
   const provider=idle.find(provider=>!Number.isFinite(progress.nextEligibleAt?.[provider])||progress.nextEligibleAt[provider]<=at)||idle.sort((a,b)=>progress.nextEligibleAt[a]-progress.nextEligibleAt[b])[0];
   const eligible=progress.nextEligibleAt?.[provider];
   if(Number.isFinite(eligible)&&eligible>at){
    const expiry=capacity.snapshots.find(row=>row.provider===provider)?.valid_until;
    if(eligible>=expiry||eligible-at>13000)return {complete:false,reason:saved.unknownCapacityProbeApproved?'WAIT_FOR_GROQ_EARLIEST_APP_RETRY':'WAIT_FOR_PROVIDER_AND_REOBSERVE',index:chunk.index,nextEligibleAt:eligible};
    onUpdate({index:chunk.index,provider,waitingUntil:eligible});await wait(eligible-at);continue;
   }
   let reviewedId=null;
   if(saved.reviewed429Required){reviewedId=await review429(chunk,saved,provider);if(reviewedId!==saved.reviewOperationId)return {complete:false,reason:'PROVIDER_429_REVIEW_REQUIRED',index:chunk.index};}
   if(!foreground())return {complete:false,reason:'FOREGROUND_REQUIRED',index:chunk.index};
   onUpdate({index:chunk.index,provider,sending:true,coveragePercent:progress.coveragePercent});
   try{const result=await sendChunk(chunk,provider,reviewedId,{unknownCapacityProbe:saved.unknownCapacityProbeApproved===true});if(result?.state!=='DONE')return {complete:false,reason:result?.code||'AUDIO_RESULT_UNVERIFIED',index:chunk.index};if(saved.unknownCapacityProbeApproved)return {complete:false,reason:'UNKNOWN_GROQ_PROBE_COMPLETED_REVIEW',index:chunk.index,probeCompleted:true};}
   catch(error){return {complete:false,reason:error?.code||'DISPATCH_OUTCOME_UNKNOWN_REVIEW_REQUIRED',index:chunk.index};}
   onUpdate({index:chunk.index,provider,done:true});break;
  }
 }
 const progress=await getProgress();return {complete:progress.complete===true,reason:progress.complete?'COMPLETE':'COVERAGE_UNVERIFIED'};
}
export async function runSummaryStages({getProgress,getCapacity,getQuota,sendSummary,wait,now=Date.now,foreground=()=>true,onUpdate=()=>{}}){
 for(let stage=0;stage<160;stage++){
  const [progress,capacity,quota]=await Promise.all([getProgress(),getCapacity(),getQuota()]);const at=now();
  if(!capacityReady('gemini',0,capacity.snapshots,quota.grants,at))return {complete:false,reason:'GEMINI_SUMMARY_CAPACITY_REOBSERVATION_REQUIRED'};
  if(progress.operationInFlight?.gemini)return {complete:false,reason:'GEMINI_OPERATION_IN_FLIGHT_REVIEW_REQUIRED'};
  const eligible=progress.nextEligibleAt?.gemini;
  if(Number.isFinite(eligible)&&eligible>at){
   const expiry=capacity.snapshots.find(row=>row.provider==='gemini')?.valid_until;
   if(eligible>=expiry||eligible-at>13000)return {complete:false,reason:'GEMINI_SUMMARY_WAIT_AND_REOBSERVE',nextEligibleAt:eligible};
   onUpdate({stage,waitingUntil:eligible});await wait(eligible-at);stage--;continue;
  }
  if(!foreground())return {complete:false,reason:'FOREGROUND_REQUIRED'};
  let result;try{result=await sendSummary();}catch(error){
   if(error?.code==='RATE_LIMIT_PENDING'){const refreshed=await getProgress();if(Number.isFinite(refreshed.nextEligibleAt?.gemini)&&refreshed.nextEligibleAt.gemini>now()){stage--;continue;}return {complete:false,reason:'GEMINI_SUMMARY_RATE_LIMIT_REVIEW_REQUIRED'};}
   return {complete:false,reason:error?.code||'SUMMARY_OUTCOME_UNKNOWN_REVIEW_REQUIRED'};
  }
  if(!result?.pending)return result?.job?.report?.kind==='GEMINI_EVIDENCE_LINKED'?{complete:true,result}:{complete:false,reason:'SUMMARY_RESULT_UNVERIFIED'};
  onUpdate({stage,stageComplete:true});
 }
 return {complete:false,reason:'SUMMARY_STAGE_LIMIT_REACHED'};
}
