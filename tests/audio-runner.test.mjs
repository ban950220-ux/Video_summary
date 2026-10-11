import test from 'node:test';
import assert from 'node:assert/strict';
import {runAudioChunks,runSummaryStages,runApprovedFreeBatch,detailRequestIsCurrent,beginDetailAction} from '../web/site/audio-runner.mjs';

test('approved Groq batch runs sequentially in foreground and stops before summary',async()=>{
 const planned=[{index:6},{index:7}],sent=[],waits=[];let clock=1000;
 const batch={jobId:'job-a',fileSha256:'a'.repeat(64),model:'whisper-large-v3-turbo',state:'APPROVED',expiresAt:200000,chunkIds:[6,7],maxRequests:2,maxAudioSeconds:600};
 const result=await runApprovedFreeBatch({jobId:'job-a',fileSha256:batch.fileSha256,approvedChunkIds:[6,7],chunks:planned,getBatch:async()=>batch,getProgress:async()=>({chunks:planned.map(c=>({...c,state:sent.includes(c.index)?'DONE':'PLANNED'})),operationInFlight:{groq:false},nextEligibleAt:{groq:null}}),sendChunk:async c=>{sent.push(c.index);return {state:'DONE'};},wait:async ms=>{waits.push(ms);clock+=ms;},now:()=>clock,foreground:()=>true});
 assert.deepEqual(sent,[6,7]);assert.deepEqual(waits,[61000]);assert.deepEqual(result,{complete:true,summaryStarted:false,reason:'BATCH_COMPLETE_BEFORE_SUMMARY'});
});
test('batch stops on first error, hidden tab, wrong job or changed approval',async()=>{
 const chunks=[{index:6},{index:7}],base={jobId:'job-a',fileSha256:'a'.repeat(64),model:'whisper-large-v3-turbo',state:'APPROVED',expiresAt:200000,chunkIds:[6,7],maxRequests:2,maxAudioSeconds:600};let sent=0;
 const args={jobId:base.jobId,fileSha256:base.fileSha256,approvedChunkIds:[6,7],chunks,getBatch:async()=>base,getProgress:async()=>({chunks:chunks.map(c=>({...c,state:'PLANNED'})),operationInFlight:{groq:false},nextEligibleAt:{groq:null}}),sendChunk:async()=>{sent++;return {code:'429'};},wait:async()=>{},now:()=>1000};
 assert.equal((await runApprovedFreeBatch(args)).reason,'429');assert.equal(sent,1);
 assert.equal((await runApprovedFreeBatch({...args,foreground:()=>false})).reason,'FOREGROUND_REQUIRED');assert.equal(sent,1);
 assert.equal((await runApprovedFreeBatch({...args,getBatch:async()=>({...base,jobId:'job-b'})})).reason,'FREE_BATCH_APPROVAL_CHANGED');assert.equal(sent,1);
});
test('batch stops when foreground is lost or approval changes after one saved chunk',async()=>{
 const chunks=[{index:6},{index:7}],scope={jobId:'job-a',fileSha256:'a'.repeat(64),model:'whisper-large-v3-turbo',state:'APPROVED',expiresAt:200000,chunkIds:[6,7],maxRequests:2,maxAudioSeconds:600};let visible=true,calls=0;
 const args={jobId:scope.jobId,fileSha256:scope.fileSha256,approvedChunkIds:[6,7],chunks,getBatch:async()=>scope,getProgress:async()=>({chunks:chunks.map(c=>({...c,state:c.index===6&&calls?'DONE':'PLANNED'})),operationInFlight:{groq:false},nextEligibleAt:{groq:null}}),sendChunk:async()=>{calls++;return {state:'DONE'};},wait:async()=>{visible=false;},now:()=>1000,foreground:()=>visible};
 assert.equal((await runApprovedFreeBatch(args)).reason,'FOREGROUND_REQUIRED');assert.equal(calls,1);
 visible=true;calls=0;let reads=0;
 const changed=await runApprovedFreeBatch({...args,getBatch:async()=>++reads===1?scope:{...scope,jobId:'job-b'},wait:async()=>{}});
 assert.equal(changed.reason,'FREE_BATCH_APPROVAL_CHANGED');assert.equal(calls,1);
});

const chunks=[0,1,2].map(index=>({index,start:index*300,end:(index+1)*300}));
function fixture(initialDone=0){let clock=1000000,done=initialDone,last=0;const sent=[],waits=[];const snapshot={provider:'gemini',model:'gemini-2.5-flash',valid_until:clock+60000,remaining:{requestsMinute:5,tokensMinute:100000,requestsDay:5},reserved:{requestsMinute:0,tokensMinute:0,requestsDay:0}};const grant={provider:'gemini',expires_at:clock+3600000,billing_disabled:1,request_count:0,request_limit:5,consumed:0,allowance:250000};return {
  sent,waits,snapshot,grant,now:()=>clock,
  getProgress:async()=>({chunks:chunks.map(c=>({index:c.index,state:c.index<done?'DONE':'PLANNED'})),complete:done===3,nextEligibleAt:{gemini:last?last+13000:null},operationInFlight:{gemini:false}}),
  getCapacity:async()=>({snapshots:[snapshot]}),getQuota:async()=>({grants:[grant]}),chooseProvider:()=> 'gemini',review429:async()=>null,
  wait:async ms=>{waits.push(ms);clock+=ms;},sendChunk:async c=>{sent.push({index:c.index,at:clock});done++;last=clock;grant.request_count++;grant.consumed+=18304;snapshot.reserved.requestsMinute++;snapshot.reserved.requestsDay++;snapshot.reserved.tokensMinute+=22880;return {state:'DONE'};}
 };}
test('foreground runner completes three chunks with server pacing and fresh shared capacity',async()=>{
 const f=fixture(),result=await runAudioChunks({chunks,...f});assert.equal(result.complete,true);assert.deepEqual(f.sent.map(row=>row.index),[0,1,2]);assert.deepEqual(f.sent.map(row=>row.at),[1000000,1013000,1026000]);assert.deepEqual(f.waits,[13000,13000]);
});
test('runner pauses before dispatch when summary has reserved shared Gemini tokens',async()=>{
 const f=fixture();f.snapshot.reserved.tokensMinute=90000;const result=await runAudioChunks({chunks,...f});assert.equal(result.complete,false);assert.equal(result.reason,'CAPACITY_OR_GRANT_REOBSERVATION_REQUIRED');assert.equal(f.sent.length,0);
});
test('runner pauses if observation expires before the next eligible request',async()=>{
 const f=fixture();f.snapshot.valid_until=1010000;const result=await runAudioChunks({chunks,...f});assert.equal(result.complete,false);assert.equal(result.index,1);assert.deepEqual(f.sent.map(row=>row.index),[0]);assert.equal(f.waits.length,0);
});
test('automatic mode skips a DONE chunk and selects the authorized alternate with valid capacity',async()=>{
 const f=fixture(1),result=await runAudioChunks({chunks,...f,chooseProvider:()=> 'auto',authorizedProviders:()=>['groq','gemini']});
 assert.equal(result.complete,true);assert.deepEqual(f.sent.map(row=>row.index),[1,2]);assert.deepEqual(f.waits,[13000]);
});
test('automatic mode pauses when neither authorized provider has known fresh capacity',async()=>{
 const f=fixture();f.snapshot.valid_until=999999;const result=await runAudioChunks({chunks,...f,chooseProvider:()=> 'auto',authorizedProviders:()=>['groq','gemini']});
 assert.equal(result.reason,'NO_AUTHORIZED_PROVIDER_WITH_VALID_CAPACITY');assert.equal(f.sent.length,0);
});
test('automatic mode switches from exhausted Groq to approved Gemini without replaying DONE work',async()=>{
 const f=fixture(1),groq={provider:'groq',model:'whisper-large-v3-turbo',valid_until:1060000,remaining:{requestsMinute:2,audioSecondsHour:2000,audioSecondsDay:2000},reserved:{requestsMinute:0,audioSecondsHour:0,audioSecondsDay:0}};
 const groqGrant={provider:'groq',expires_at:4600000,billing_disabled:1,request_count:0,request_limit:2,consumed:0,allowance:1000};
 const selected=[];let geminiCalled=false;
 const result=await runAudioChunks({chunks,...f,chooseProvider:()=> 'auto',authorizedProviders:()=>['groq','gemini'],
  getCapacity:async()=>({snapshots:[groq,f.snapshot]}),getQuota:async()=>({grants:[groqGrant,f.grant]}),
  getProgress:async()=>{const progress=await f.getProgress();if(!geminiCalled)progress.nextEligibleAt.gemini=null;return progress;},
  sendChunk:async(chunk,provider)=>{selected.push([chunk.index,provider]);if(provider==='groq')groq.valid_until=0;else geminiCalled=true;return f.sendChunk(chunk);}});
 assert.equal(result.complete,true);assert.deepEqual(selected,[[1,'groq'],[2,'gemini']]);
});
test('automatic mode never switches an unresolved sent attempt',async()=>{
 const f=fixture(),result=await runAudioChunks({chunks,...f,chooseProvider:()=> 'auto',getProgress:async()=>({chunks:[{index:0,state:'UNCERTAIN',uncertainFailure:true}],complete:false})});
 assert.equal(result.reason,'OPERATION_REVIEW_REQUIRED');assert.equal(f.sent.length,0);
});
test('reviewed uncertain chunk requires explicit Groq selection, never automatic fallback',async()=>{
 let sent=0;const groq={provider:'groq',model:'whisper-large-v3-turbo',valid_until:1060000,remaining:{requestsMinute:2,audioSecondsHour:2000,audioSecondsDay:2000},reserved:{requestsMinute:0,audioSecondsHour:0,audioSecondsDay:0}},grant={provider:'groq',expires_at:4600000,billing_disabled:1,request_count:0,request_limit:2,consumed:0,allowance:1000};
 const shared={chunks:[chunks[0]],getProgress:async()=>({chunks:[{index:0,state:sent?'DONE':'UNCERTAIN',reviewedFreeRetryApproved:true,groqAllowed:true}],complete:sent>0,nextEligibleAt:{groq:null},operationInFlight:{groq:false}}),getCapacity:async()=>({snapshots:[groq]}),getQuota:async()=>({grants:[grant]}),authorizedProviders:()=>['groq','gemini'],sendChunk:async()=>{sent++;return {state:'DONE'};},now:()=>1000000};
 assert.equal((await runAudioChunks({...shared,chooseProvider:()=> 'auto'})).reason,'OPERATION_REVIEW_REQUIRED');assert.equal(sent,0);
 assert.equal((await runAudioChunks({...shared,chooseProvider:()=> 'groq'})).complete,true);assert.equal(sent,1);
});
test('exact approved UNKNOWN Groq probe permits one foreground send without fabricated capacity',async()=>{
 let sent=0,options=null;const progress=async()=>({chunks:[{index:0,state:sent?'DONE':'UNCERTAIN',reviewedFreeRetryApproved:true,unknownCapacityProbeApproved:true,groqAllowed:true}],complete:sent>0,nextEligibleAt:{groq:null},operationInFlight:{groq:false}});
 const common={chunks:[chunks[0]],getProgress:progress,getCapacity:async()=>({snapshots:[]}),getQuota:async()=>({grants:[]}),authorizedProviders:()=>['groq'],now:()=>1000000,sendChunk:async(_chunk,provider,_review,settings)=>{assert.equal(provider,'groq');options=settings;sent++;return {state:'DONE'};}};
 assert.equal((await runAudioChunks({...common,chooseProvider:()=> 'auto'})).reason,'OPERATION_REVIEW_REQUIRED');assert.equal(sent,0);
 const result=await runAudioChunks({...common,chooseProvider:()=> 'groq'});assert.equal(result.complete,false);assert.equal(result.probeCompleted,true);assert.equal(result.reason,'UNKNOWN_GROQ_PROBE_COMPLETED_REVIEW');assert.equal(sent,1);assert.deepEqual(options,{unknownCapacityProbe:true});
});
test('successful UNKNOWN probe stops before the next chunk or summary stage',async()=>{
 let sent=0;const two=[{index:0,start:0,end:300},{index:1,start:300,end:600}];
 const progress=async()=>({chunks:[{index:0,state:sent?'DONE':'UNCERTAIN',reviewedFreeRetryApproved:true,unknownCapacityProbeApproved:true,groqAllowed:true},{index:1,state:'PLANNED',groqAllowed:true}],complete:false,nextEligibleAt:{groq:null},operationInFlight:{groq:false}});
 const result=await runAudioChunks({chunks:two,getProgress:progress,getCapacity:async()=>({snapshots:[]}),getQuota:async()=>({grants:[]}),chooseProvider:()=> 'groq',authorizedProviders:()=>['groq'],now:()=>1000000,sendChunk:async()=>{sent++;return {state:'DONE'};}});
 assert.equal(result.reason,'UNKNOWN_GROQ_PROBE_COMPLETED_REVIEW');assert.equal(result.complete,false);assert.equal(sent,1);
});
test('foreground changes during capacity lookup block probe and summary before dispatch',async()=>{
 let visible=true,sends=0;
 const progress=async()=>({chunks:[{index:0,state:'UNCERTAIN',reviewedFreeRetryApproved:true,unknownCapacityProbeApproved:true,groqAllowed:true}],complete:false,nextEligibleAt:{groq:null},operationInFlight:{groq:false}});
 const result=await runAudioChunks({chunks:[chunks[0]],getProgress:progress,getCapacity:async()=>{visible=false;return {snapshots:[]};},getQuota:async()=>({grants:[]}),chooseProvider:()=> 'groq',authorizedProviders:()=>['groq'],foreground:()=>visible,now:()=>1000000,sendChunk:async()=>{sends++;return {state:'DONE'};}});
 assert.equal(result.reason,'FOREGROUND_REQUIRED');assert.equal(sends,0);
 visible=true;const summary=await runSummaryStages({getProgress:async()=>({operationInFlight:{gemini:false},nextEligibleAt:{gemini:null}}),getCapacity:async()=>{visible=false;return {snapshots:[{provider:'gemini',model:'gemini-2.5-flash',valid_until:1060000,remaining:{requestsMinute:1,tokensMinute:50000,requestsDay:1},reserved:{requestsMinute:0,tokensMinute:0,requestsDay:0}}]};},getQuota:async()=>({grants:[{provider:'gemini',expires_at:1060000,billing_disabled:1,request_count:0,request_limit:1,consumed:0,allowance:50000}]}),foreground:()=>visible,now:()=>1000000,sendSummary:async()=>{sends++;return {pending:false,job:{report:{kind:'GEMINI_EVIDENCE_LINKED'}}};}});
 assert.equal(summary.reason,'FOREGROUND_REQUIRED');assert.equal(sends,0);
});
test('late job-A detail response or stale approval form cannot target job B',()=>{
 const base={expectedRequestId:4,currentRequestId:4,expectedJobId:'job-a',visibleJobId:'job-a',view:'library',hidden:false};
 assert.equal(detailRequestIsCurrent(base),true);
 assert.equal(detailRequestIsCurrent({...base,currentRequestId:5,visibleJobId:'job-b'}),false);
 assert.equal(detailRequestIsCurrent({...base,visibleJobId:'job-b'}),false);
 assert.equal(detailRequestIsCurrent({...base,view:'settings'}),false);
 assert.equal(detailRequestIsCurrent({...base,hidden:true}),false);
});
test('job B action invalidates job A progress response before replacing shared panel',async()=>{
 const panel={dataset:{jobId:'job-a'},hidden:false};let generation=beginDetailAction(panel,'job-a',0);
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const stale=pending.then(()=>detailRequestIsCurrent({expectedRequestId:1,currentRequestId:generation,expectedJobId:'job-a',visibleJobId:panel.dataset.jobId,view:'library',hidden:panel.hidden}));
 generation=beginDetailAction(panel,'job-b',generation);
 release();assert.equal(await stale,false);
 assert.equal(detailRequestIsCurrent({expectedRequestId:generation,currentRequestId:generation,expectedJobId:'job-b',visibleJobId:panel.dataset.jobId,view:'library',hidden:panel.hidden}),true);
});
test('three Gemini audio chunks flow into staged summary with shared safe cooldown',async()=>{
 const f=fixture();f.grant.request_limit=10;f.snapshot.remaining.requestsMinute=10;f.snapshot.remaining.requestsDay=10;
 const audio=await runAudioChunks({chunks,...f});assert.equal(audio.complete,true);
 let stage=0,lastAudioAt=f.sent.at(-1).at;const summaryCalls=[];
 const getProgress=async()=>({...await f.getProgress(),nextEligibleAt:{gemini:lastAudioAt+13000}});
 const summary=await runSummaryStages({getProgress,getCapacity:f.getCapacity,getQuota:f.getQuota,now:f.now,wait:f.wait,
  sendSummary:async()=>{summaryCalls.push(f.now());lastAudioAt=f.now();stage++;return stage===1?{pending:true,job:{report:null}}:{pending:false,job:{report:{kind:'GEMINI_EVIDENCE_LINKED'}}};}});
 assert.equal(summary.complete,true);assert.deepEqual(summaryCalls,[1039000,1052000]);assert.deepEqual(f.waits,[13000,13000,13000,13000]);
});
