// Invented content and in-memory HTTP responses only. No media, ASR, network or D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAsrResultBridgeController,mountAsrResultBridge,prepareAsrResultFile} from '../web/site/asr-result-bridge.mjs';
import {asrSha256,asrTranscriptDigests,asrNormalizedSourceDigest,asrSourceBindingDigest} from '../src/asr-result-bridge.mjs';
import {normalizeSegments} from '../src/report.mjs';
import {validateApprovedSummary,projectApprovedSummary} from '../src/approved-summary-format.mjs';
import {syntheticApprovedSource,syntheticApprovedReport} from './fixtures/approved-summary-synthetic.mjs';

const id='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',nextRequest='33333333-3333-4333-8333-333333333333',originalSha='a'.repeat(64),jobSha='b'.repeat(64),at=1_000_000;
const clone=value=>JSON.parse(JSON.stringify(value));
const fileFor=value=>{const bytes=new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value));return {name:'synthetic-asr-result.json',size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer};};
const storageFor=(map=new Map())=>({getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),map});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function tickUntil(check){for(let i=0;i<60;i++){if(check())return;await Promise.resolve();}throw Error('SYNTHETIC_CHECKPOINT_NOT_REACHED');}
function node(tag='div'){return {tag,children:[],dataset:{},attrs:{},isConnected:true,hidden:false,disabled:false,checked:false,textContent:'',append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(key,value){this.attrs[key]=value;},contains(other){return this===other||this.children.some(child=>child.contains?.(other));}};}
const all=root=>[root,...(root.children??[]).flatMap(all)],text=root=>all(root).map(item=>item.textContent??'').join('\n'),button=(root,label)=>all(root).find(item=>item.tag==='button'&&item.textContent===label);
async function fixture({url=false,intercept,summaryPending=false,planProfile='approved-four-part-v1',storage=storageFor(),isCurrent=()=>true}={}){
 const transcript=syntheticApprovedSource();transcript.raw=transcript.raw.replace('가상','가상  ');
 const source={kind:'OWNER_SUBMITTED_ASR_SOURCE_V1',jobId:id,requestId,jobSourceSha256:jobSha,sourceIdentity:url?{kind:'YOUTUBE_ACQUISITION',videoId:'synthetic01',canonicalUrl:'https://www.youtube.com/watch?v=synthetic01',officialDurationMs:80000,metadataSha256:'c'.repeat(64)}:{kind:'OWNED_AUDIO',originalAudioSha256:originalSha},originalAudio:{sha256:originalSha,bytes:4000,durationMs:80000,startTimeMs:0,measurement:'FFPROBE',measurementSha256:'d'.repeat(64)},asrInput:{sha256:'e'.repeat(64),pcmSha256:'f'.repeat(64),bytes:2560044,durationMs:80000,measurement:'PCM_SAMPLE_COUNT',measurementSha256:'1'.repeat(64),sampleRate:16000,channels:1,sampleCount:1280000,format:'WAV_PCM_S16LE',timeOrigin:'NORMALIZED_AUDIO_FRAME_ZERO'}};
 const envelope={source,result:{kind:'OWNER_SUBMITTED_LOCAL_ASR_RESULT_V1',jobId:id,requestId,revision:null,jobSourceSha256:jobSha,sourceBindingSha256:null,originalAudioSha256:originalSha,asrInputSha256:source.asrInput.sha256,asrPcmSha256:source.asrInput.pcmSha256,transcript:{raw:transcript.raw,segments:transcript.segments,...await asrTranscriptDigests(transcript.raw,transcript.segments)},engine:{name:'faster-whisper',model:'synthetic-model',version:'synthetic-version',device:'cpu',computeType:'int8'},confirmOwnerSubmitted:true,confirmNoProviderCall:true}};
 const model={state:'NO_REQUEST',requestId:null,revision:null,expiresAt:null,source:null,sourceBindingSha256:null,receipt:null,stored:null,eligible:true,job:{id,source_type:url?'url':'audio',source_url:url?'https://www.youtube.com/watch?v=synthetic01':null,video_id:url?'synthetic01':null,duration_seconds:120,title:'합성 전사 연결',created_at:'2026-01-01T00:00:00Z',status:url?'NEED_UPLOAD':'NEED_AUDIO_UPLOAD',audit:url?{status:'NO_CAPTIONS',nativeAcquisition:'NO_CAPTIONS'}:{ownedAudioSha256:originalSha},report:null}};
 const calls=[],reports=[],updates=[];
 const status=()=>({kind:'ASR_RESULT_BRIDGE_STATUS_V1',jobId:id,sourceKind:url?'URL_NO_CAPTIONS':'OWNED_AUDIO',eligible:model.eligible,jobSourceSha256:jobSha,workerConnected:false,executionAvailable:false,transferAvailable:true,providerCalls:0,state:model.state,requestId:model.requestId,revision:model.revision,expiresAt:model.expiresAt,source:model.source,sourceBindingSha256:model.sourceBindingSha256,receipt:model.receipt,context:model.requestId?{kind:'ASR_RESULT_BRIDGE_CONTEXT_V1',jobId:id,requestId:model.requestId,jobSourceSha256:jobSha,sourceKind:url?'URL_NO_CAPTIONS':'OWNED_AUDIO',declaredDurationMs:120000,revision:model.revision,expiresAt:model.expiresAt,sourceIdentity:url?{kind:'YOUTUBE_ACQUISITION',videoId:'synthetic01',canonicalUrl:'https://www.youtube.com/watch?v=synthetic01'}:{kind:'OWNED_AUDIO',originalAudioSha256:originalSha}}:null,canRequest:model.eligible&&['NO_REQUEST','CANCELLED','EXPIRED'].includes(model.state),canBind:['WAITING_FOR_WORKER','SOURCE_BOUND'].includes(model.state),canReceive:['SOURCE_BOUND','RESULT_STORED'].includes(model.state),canCancel:['WAITING_FOR_WORKER','SOURCE_BOUND'].includes(model.state),transcriptStored:model.state==='RESULT_STORED',asrSummaryReady:model.state==='RESULT_STORED'&&!model.job.report,sourceBinding:model.state==='RESULT_STORED'?'MATCHED_OWNER_SUBMITTED_SOURCE':'NOT_STORED',sourceAccuracy:'UNVERIFIED',summaryComplete:false,currentJobHasSavedReport:!!model.job.report});
 async function storeResult(result){
  const receipt={kind:'OWNER_SUBMITTED_LOCAL_ASR_RECEIPT_V1',jobId:id,requestId:model.requestId,revision:model.revision,generation:1,submittedBodySha256:await asrSha256(JSON.stringify(result)),sourceBindingSha256:model.sourceBindingSha256,originalAudioSha256:originalSha,asrInputSha256:source.asrInput.sha256,asrPcmSha256:source.asrInput.pcmSha256,...await asrTranscriptDigests(result.transcript.raw,result.transcript.segments),normalizedSourceSha256:await asrNormalizedSourceDigest(result.transcript.raw,result.transcript.segments),segmentCount:result.transcript.segments.length,provenance:'OWNER_SUBMITTED_LOCAL_ASR',sourceAccuracy:'UNVERIFIED',identityVerification:'OWNER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED',durationEvidence:{declaredDurationMs:120000,originalAudioDurationMs:80000,originalAudioStartTimeMs:0,asrInputDurationMs:80000,officialVideoDurationMs:url?80000:null,timeOrigin:'NORMALIZED_AUDIO_FRAME_ZERO'},engine:result.engine,receivedAt:'2026-01-01T00:00:00Z'};
  model.receipt=receipt;model.state='RESULT_STORED';model.eligible=false;model.stored={raw:result.transcript.raw,segments:normalizeSegments(result.transcript.segments),provenance:'OWNER_SUBMITTED_LOCAL_ASR'};
  model.job={...model.job,status:'TRANSCRIPT_UNVERIFIED',audit:{...model.job.audit,status:'TRANSCRIPT_UNVERIFIED',localAsrReceipt:{requestId:model.requestId,sourceBindingSha256:model.sourceBindingSha256,submittedBodySha256:receipt.submittedBodySha256,normalizedSourceSha256:receipt.normalizedSourceSha256,receiptSha256:await asrSha256(JSON.stringify(receipt)),provenance:'OWNER_SUBMITTED_LOCAL_ASR',sourceAccuracy:'UNVERIFIED',inputProcessingCoverage:'NOT_INDEPENDENTLY_VERIFIED',summaryGenerated:false}}};
 }
 const api=async(path,{method='GET',body}={})=>{
  const call={path,method,body:body===undefined?undefined:clone(body)};calls.push(call);const custom=await intercept?.({call,model,status,storeResult});if(custom!==undefined)return clone(custom);
  const suffix=path.slice(('/api/jobs/'+id).length);
  if(suffix==='/audio-request'&&method==='GET')return clone(status());
  if(suffix==='/audio-request'&&method==='POST'){assert.equal(body.rightsConfirmed,true);assert.equal(body.confirmLocalOnly,true);model.requestId=body.requestId;model.state='WAITING_FOR_WORKER';model.revision=1;model.expiresAt=at+3600000;return clone(status());}
  if(suffix==='/audio-request-bind'){assert.equal(body.revision,model.revision);model.source=clone(body.source);model.sourceBindingSha256=await asrSourceBindingDigest(body.source);model.revision=2;model.state='SOURCE_BOUND';return clone(status());}
  if(suffix==='/asr-result'){assert.equal(body.revision,model.revision);assert.equal(body.sourceBindingSha256,model.sourceBindingSha256);await storeResult(body);return {...clone(status()),persisted:true};}
  if(suffix==='/audio-request-cancel'){assert.equal(body.requestId,model.requestId);assert.equal(body.revision,model.revision);model.state='CANCELLED';model.revision++;return clone(status());}
  if(path==='/api/jobs/'+id)return {job:clone(model.job)};
  if(suffix==='/source')return {source:clone(model.stored)};
  if(suffix==='/summary-plan?formatProfile=approved-four-part-v1')return {stages:1,firstPassUnits:100,segmentCount:4,additionalSynthesisUnits:'UNKNOWN',...(planProfile===undefined?{}:{formatProfile:planProfile})};
  if(suffix==='/audio-progress')return {chunks:[],operationInFlight:{gemini:false},nextEligibleAt:{gemini:null}};
  if(path==='/api/live/capacity')return {snapshots:[{provider:'gemini',model:'gemini-2.5-flash',valid_until:at+600000,remaining:{requestsMinute:2,tokensMinute:100000,requestsDay:2},reserved:{requestsMinute:0,tokensMinute:0,requestsDay:0}}]};
  if(path==='/api/live/quota')return {grants:[{provider:'gemini',expires_at:at+600000,billing_disabled:1,request_count:0,request_limit:2,consumed:0,allowance:100000}]};
  if(suffix==='/summary'){
   if(summaryPending)return {job:clone(model.job),persisted:true,pending:true,formatProfile:'approved-four-part-v1',minimumWaitSeconds:13};
   const report=syntheticApprovedReport(model.stored);report.kind='GEMINI_EVIDENCE_LINKED';report.approvedSummary=validateApprovedSummary(report.approvedSummary,model.stored.segments);model.job=projectApprovedSummary({...model.job,report},model.stored);return {job:clone(model.job),persisted:true,formatProfile:'approved-four-part-v1'};
  }
  throw Error('UNEXPECTED_SYNTHETIC_ROUTE '+path);
 };
 let ids=0;const controller=createAsrResultBridgeController({jobId:id,api,isCurrent,onChange:state=>updates.push(state),onReport:(job,meta)=>reports.push({job,meta}),storage,randomUUID:()=>ids++?nextRequest:requestId,now:()=>at});
 const start=async()=>{await controller.load();await controller.request({rightsConfirmed:true});};
 const bind=async()=>{await start();await controller.prepare(fileFor(envelope));await controller.bind({ownerConfirmed:true});};
 const receive=async()=>{await bind();await controller.receive({ownerConfirmed:true});};
 return {api,status,model,envelope,calls,reports,updates,controller,start,bind,receive,storeResult,storage};
}

test('load is owner GET only; request is explicit, idempotent in UI and waits for an unconnected worker',async()=>{
 const f=await fixture();await f.controller.load();assert.deepEqual(f.calls.map(call=>call.method),['GET']);
 await f.controller.request();assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 await f.controller.request({rightsConfirmed:true});await f.controller.request({rightsConfirmed:true});
 assert.equal(f.calls.filter(call=>call.method==='POST').length,1);assert.equal(f.model.state,'WAITING_FOR_WORKER');assert.equal(f.controller.getState().status.workerConnected,false);assert.equal(f.controller.getState().status.summaryComplete,false);
 assert.ok([...f.storage.map.values()].every(value=>!value.includes(f.envelope.result.transcript.raw)));
});

test('token-free context download keeps only scope fields and does not invent URL metadata',async()=>{
 for(const url of [false,true]){const f=await fixture({url});await f.start();const context=f.controller.downloadContext();assert.equal(context.kind,'ASR_RESULT_BRIDGE_CONTEXT_V1');assert.equal(context.requestId,requestId);assert.equal(context.declaredDurationMs,120000);assert.doesNotMatch(JSON.stringify(context),/token|credential|transcript|raw|lease/i);if(url){assert.equal(context.sourceIdentity.videoId,'synthetic01');assert.equal(context.sourceIdentity.officialDurationMs,undefined);assert.equal(context.sourceIdentity.metadataSha256,undefined);}}
});

test('source bind and result receive preserve submitted text and only fill server revision/binding fields',async()=>{
 const f=await fixture();await f.receive();const sent=f.calls.find(call=>call.path.endsWith('/asr-result')).body;
 assert.deepEqual(sent,{...f.envelope.result,revision:2,sourceBindingSha256:f.model.sourceBindingSha256});assert.equal(f.model.stored.raw,f.envelope.result.transcript.raw);
 assert.equal(f.controller.getState().verifiedJob.id,id);assert.match(f.controller.getState().message,/요약을 자동으로 시작하지 않았습니다/);
 assert.equal(f.calls.some(call=>/summary|native|audio-plan|audio-chunk|audio-finish|runner/.test(call.path)),false);assert.equal(f.reports.at(-1).meta.transcriptOnly,true);
});

test('synthetic NO_CAPTIONS URL retains URL type and declared duration after stored ASR',async()=>{
 const f=await fixture({url:true});await f.receive();assert.equal(f.model.job.source_type,'url');assert.equal(f.model.job.duration_seconds,120);assert.equal(f.model.source.originalAudio.durationMs,80000);assert.equal(f.model.source.asrInput.durationMs,80000);assert.equal(f.controller.getState().status.sourceKind,'URL_NO_CAPTIONS');
});

test('bind and receive require separate owner confirmations and duplicate clicks cannot add writes',async()=>{
 const f=await fixture();await f.start();await f.controller.prepare(fileFor(f.envelope));await f.controller.bind();assert.equal(f.model.state,'WAITING_FOR_WORKER');await Promise.all([f.controller.bind({ownerConfirmed:true}),f.controller.bind({ownerConfirmed:true})]);
 await f.controller.receive();assert.equal(f.model.state,'SOURCE_BOUND');await Promise.all([f.controller.receive({ownerConfirmed:true}),f.controller.receive({ownerConfirmed:true})]);await f.controller.receive({ownerConfirmed:true});
 assert.equal(f.calls.filter(call=>call.path.endsWith('/audio-request-bind')&&call.method==='POST').length,1);assert.equal(f.calls.filter(call=>call.path.endsWith('/asr-result')&&call.method==='POST').length,1);
});

test('lost request acknowledgement reads back the same request without sending another POST',async()=>{
 let lost=false;const f=await fixture({intercept:({call,model})=>{if(!lost&&call.path.endsWith('/audio-request')&&call.method==='POST'){lost=true;model.requestId=call.body.requestId;model.state='WAITING_FOR_WORKER';model.revision=1;model.expiresAt=at+3600000;throw Error('SYNTHETIC_ACK_LOSS');}}});await f.start();await f.controller.request({rightsConfirmed:true});
 assert.equal(f.calls.filter(call=>call.method==='POST').length,1);assert.equal(f.controller.getState().status.requestId,requestId);assert.equal(f.model.state,'WAITING_FOR_WORKER');
});

test('unresolved creation cannot create a replacement, even after reopening the controller',async()=>{
 const storage=storageFor(),f=await fixture({storage,intercept:({call})=>{if(call.method==='POST')throw Error('SYNTHETIC_NO_ACK');}});await f.start();const prior=clone([...storage.map.values()]);
 const reopened=await fixture({storage});await reopened.start();assert.equal(reopened.calls.some(call=>call.method==='POST'),false);assert.deepEqual([...storage.map.values()],prior);
});

test('lost result acknowledgement is not resent; explicit stored-source verification recovers it',async()=>{
 let lost=false;const f=await fixture({intercept:async({call,storeResult})=>{if(!lost&&call.path.endsWith('/asr-result')){lost=true;await storeResult(call.body);throw Error('SYNTHETIC_ACK_LOSS');}}});await f.receive();assert.equal(f.model.state,'RESULT_STORED');await f.controller.checkSource();await f.controller.receive({ownerConfirmed:true});
 assert.equal(f.calls.filter(call=>call.path.endsWith('/asr-result')).length,1);assert.equal(f.controller.getState().verifiedJob.id,id);
});

test('cancel is exact request/revision and a later new request needs a new explicit ID',async()=>{
 const f=await fixture();await f.start();await f.controller.cancel();assert.equal(f.model.state,'WAITING_FOR_WORKER');await f.controller.cancel({confirmed:true});assert.equal(f.model.state,'CANCELLED');
 const cancelled=f.calls.find(call=>call.path.endsWith('/audio-request-cancel'));assert.deepEqual(cancelled.body,{requestId,revision:1,confirmCancel:true});await f.controller.request({rightsConfirmed:true});assert.equal(f.model.requestId,nextRequest);assert.equal(f.model.state,'WAITING_FOR_WORKER');
});

test('cancel cannot overwrite a concurrently stored result or claim cancellation succeeded',async()=>{
 const f=await fixture({intercept:async({call,model,storeResult})=>{if(call.path.endsWith('/audio-request-cancel')){await storeResult({...f.envelope.result,revision:model.revision,sourceBindingSha256:model.sourceBindingSha256});throw Error('SYNTHETIC_CANCEL_RACE');}}});await f.bind();await f.controller.cancel({confirmed:true});
 assert.equal(f.model.state,'RESULT_STORED');assert.equal(f.controller.getState().status.transcriptStored,true);assert.doesNotMatch(f.controller.getState().message,/취소 상태를 확인했습니다/);
});

test('expired, cancelled and changed-input scopes never receive a result',async()=>{
 for(const change of [model=>{model.state='EXPIRED';model.expiresAt=at-1;},model=>{model.state='CANCELLED';},model=>{model.eligible=false;}]){
  const f=await fixture();await f.bind();change(f.model);await f.controller.receive({ownerConfirmed:true});assert.equal(f.calls.some(call=>call.path.endsWith('/asr-result')),false);
 }
});

test('UTF-8 byte limits, malformed UTF-8 and JSON fields are enforced before any write',async()=>{
 const f=await fixture();await f.start();const scope={jobId:id,requestId,jobSourceSha256:jobSha,context:f.status().context};
 await assert.rejects(prepareAsrResultFile({name:'synthetic.json',size:2000001,arrayBuffer:async()=>new ArrayBuffer(0)},scope));
 await assert.rejects(prepareAsrResultFile({name:'synthetic.json',size:1,arrayBuffer:async()=>new Uint8Array([255]).buffer},scope));
 await assert.rejects(prepareAsrResultFile(fileFor({...f.envelope,credential:'SYNTHETIC_FORBIDDEN_EXTRA'}),scope));
 const large=clone(f.envelope);large.result.transcript.raw='가'.repeat(700000);await assert.rejects(prepareAsrResultFile(fileFor(large),scope));
 assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('wrong analysis/request/media/transcript hashes are rejected when choosing the external file',async()=>{
 const mutations=[value=>{value.result.jobId=nextRequest;},value=>{value.source.requestId=nextRequest;},value=>{value.result.originalAudioSha256='9'.repeat(64);},value=>{value.result.transcript.rawSha256='9'.repeat(64);},value=>{value.result.transcript.segmentsSha256='9'.repeat(64);},value=>{value.source.sourceIdentity.originalAudioSha256='9'.repeat(64);}];
 for(const mutate of mutations){const f=await fixture();await f.start();const bad=clone(f.envelope);mutate(bad);await f.controller.prepare(fileFor(bad));assert.equal(f.controller.getState().draft,null);assert.equal(f.calls.filter(call=>call.method==='POST').length,1);}
});

test('integer millisecond timelines reject null, fractional, reversed and out-of-input segments',async()=>{
 for(const mutate of [value=>{value[0].startMs=null;},value=>{value[0].endMs=19000.5;},value=>{value[0].endMs=-1;},value=>{value[3].endMs=90000;},value=>{value[1].startMs=-1;},value=>{value[0].id=2;}]){
  const f=await fixture();await f.start();const bad=clone(f.envelope);mutate(bad.result.transcript.segments);await f.controller.prepare(fileFor(bad));assert.equal(f.controller.getState().draft,null);
 }
});

test('precise PCM duration uses the same rounded integer EOF boundary as server acceptance',async()=>{
 for(const durationMs of [80000,79999.9375,80000.4375,80000.5]){
  const f=await fixture();await f.start();const value=clone(f.envelope);value.source.originalAudio.durationMs=durationMs;value.source.asrInput.durationMs=durationMs;value.source.asrInput.sampleCount=durationMs*16;value.source.asrInput.bytes=value.source.asrInput.sampleCount*2+44;
  value.result.transcript.segments.at(-1).endMs=Math.round(durationMs);Object.assign(value.result.transcript,await asrTranscriptDigests(value.result.transcript.raw,value.result.transcript.segments));await f.controller.prepare(fileFor(value));assert.notEqual(f.controller.getState().draft,null);
  value.result.transcript.segments.at(-1).endMs=Math.round(durationMs)+1;Object.assign(value.result.transcript,await asrTranscriptDigests(value.result.transcript.raw,value.result.transcript.segments));await f.controller.prepare(fileFor(value));assert.equal(f.controller.getState().draft,null);
 }
});

test('stale view or file change while preparing cannot enable binding or render private text',async()=>{
 let current=true;const f=await fixture({isCurrent:()=>current});await f.start();const slow=deferred(),file=fileFor(f.envelope);file.arrayBuffer=async()=>{await slow.promise;return new TextEncoder().encode(JSON.stringify(f.envelope)).buffer;};
 const pending=f.controller.prepare(file);await tickUntil(()=>f.controller.getState().phase==='PREPARING');current=false;const updates=f.updates.length;slow.resolve();await pending;assert.equal(f.updates.length,updates);assert.equal(f.controller.getState().draft,null);await f.controller.bind({ownerConfirmed:true});assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('leaving during bind readback stops the write before dispatch',async()=>{
 let current=true,hold=false;const pause=deferred(),f=await fixture({isCurrent:()=>current,intercept:async({call})=>{if(hold&&call.path.endsWith('/audio-request')&&call.method==='GET')await pause.promise;}});await f.start();await f.controller.prepare(fileFor(f.envelope));hold=true;const pending=f.controller.bind({ownerConfirmed:true});await tickUntil(()=>f.controller.getState().phase==='BINDING');current=false;pause.resolve();await pending;assert.equal(f.calls.some(call=>call.path.endsWith('/audio-request-bind')),false);
});

test('receipt identity/provenance/accuracy and complete receipt hash are required before source-confirmed UI',async()=>{
 const changes=[receipt=>{receipt.kind='SYNTHETIC_WRONG';},receipt=>{receipt.jobId=nextRequest;},receipt=>{receipt.requestId=nextRequest;},receipt=>{receipt.revision++;},receipt=>{receipt.provenance='PROVIDER_VERIFIED';},receipt=>{receipt.sourceAccuracy='VERIFIED';},receipt=>{receipt.identityVerification='WORKER_VERIFIED';},receipt=>{receipt.engine.model='changed-synthetic-model';}];
 for(const change of changes){const f=await fixture();await f.receive();change(f.model.receipt);await f.controller.checkSource();assert.equal(f.controller.getState().verifiedJob,null);await f.controller.planSummary();assert.equal(f.calls.some(call=>call.path.includes('/summary-plan')),false);}
});

test('changed saved source fails hash readback and cannot proceed to a summary plan',async()=>{
 const f=await fixture();await f.receive();f.model.stored.raw+=' 합성 변조';await f.controller.planSummary();assert.equal(f.controller.getState().summaryPlan,null);assert.equal(f.calls.some(call=>call.path.includes('/summary-plan')),false);
});

test('stored transcript needs an explicit plan and explicit one-stage execution to produce a source-bound four-part report',async()=>{
 const f=await fixture();await f.receive();assert.equal(f.calls.some(call=>call.path.includes('/summary')),false);await f.controller.planSummary();assert.ok(f.controller.getState().summaryPlan);await f.controller.executeSummary();assert.equal(f.calls.some(call=>call.path.endsWith('/summary')),false);
 await f.controller.executeSummary({confirmed:true});assert.equal(f.calls.filter(call=>call.path.endsWith('/summary')).length,1);assert.equal(f.reports.at(-1).job.approvedSummaryView.sourceStatus,'MATCHED');assert.match(f.controller.getState().message,/원음 정확성·의미 품질·외부 사실/);
});

test('pending summary never loops and requires a new explicit plan before the next stage',async()=>{
 const f=await fixture({summaryPending:true});await f.receive();await f.controller.planSummary();await f.controller.executeSummary({confirmed:true});assert.equal(f.calls.filter(call=>call.path.endsWith('/summary')).length,1);assert.equal(f.controller.getState().summaryPlan,null);await f.controller.executeSummary({confirmed:true});assert.equal(f.calls.filter(call=>call.path.endsWith('/summary')).length,1);
});

test('missing/mismatched approved plan and current capacity rejection prevent provider dispatch',async()=>{
 for(const profile of [null,'legacy']){const f=await fixture({planProfile:profile});await f.receive();await f.controller.planSummary();assert.equal(f.controller.getState().summaryPlan,null);assert.equal(f.calls.some(call=>call.path.endsWith('/summary')),false);}
 const f=await fixture({intercept:({call})=>call.path==='/api/live/quota'?{grants:[]}:undefined});await f.receive();await f.controller.planSummary();await f.controller.executeSummary({confirmed:true});assert.equal(f.calls.some(call=>call.path.endsWith('/summary')),false);
});

test('existing stored report reopens without new plan, quota or summary calls',async()=>{
 const f=await fixture();await f.receive();f.model.job.report={kind:'GEMINI_EVIDENCE_LINKED',summary:[],chapters:[],conclusion:'합성 이전 보고서'};f.calls.length=0;await f.controller.planSummary();assert.equal(f.calls.some(call=>/summary|capacity|quota/.test(call.path)),false);assert.equal(f.reports.at(-1).meta.existing,true);
});

test('mounted UI is functional, distinguishes declared/measured lengths and never interprets result text as HTML',async()=>{
 const f=await fixture(),host=node(),downloads=[],dom={createElement:node};Object.defineProperty(host,'innerHTML',{set(){throw Error('NO_HTML');}});
 const mounted=mountAsrResultBridge({host,jobId:id,api:f.api,document:dom,storage:f.storage,now:()=>at,download:value=>downloads.push(value)});await mounted.ready;
 const checks=all(host).filter(item=>item.tag==='input'&&item.type==='checkbox');checks[0].checked=true;checks[0].onchange();assert.equal(button(host,'오디오 요청 기록 만들기').disabled,false);await button(host,'오디오 요청 기록 만들기').onclick();
 assert.match(text(host),/워커 연결 대기/);button(host,'오디오 작업 요청 파일 받기').onclick();assert.equal(downloads.length,1);assert.equal(downloads[0].jobId,id);
 const actualRequest=mounted.controller.getState().status.requestId,document=clone(f.envelope);document.source.requestId=actualRequest;document.result.requestId=actualRequest;
 document.result.transcript.raw='<script>synthetic</script>';document.result.transcript.segments=[{id:1,startMs:0,endMs:1000,text:document.result.transcript.raw}];Object.assign(document.result.transcript,await asrTranscriptDigests(document.result.transcript.raw,document.result.transcript.segments));
 const input=all(host).find(item=>item.tag==='input'&&item.type==='file');input.files=[fileFor(document)];await input.onchange();
 assert.match(text(host),/120000 ms/);assert.match(text(host),/80000 ms/);assert.match(text(host),/소유자 제출 ffprobe/);assert.ok(text(host).includes('<script>synthetic</script>'));assert.equal(all(host).some(item=>item.tag==='script'),false);
 checks[2].checked=true;checks[2].onchange();await button(host,'음성 연결 확인·등록').onclick();checks[3].checked=true;checks[3].onchange();assert.equal(button(host,'외부 ASR 전사 수신').disabled,false);await button(host,'외부 ASR 전사 수신').onclick();assert.equal(mounted.controller.getState().status.transcriptStored,true);
});
