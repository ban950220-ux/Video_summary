import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {ASR_BRIDGE_LIMITS,asrSha256,asrTranscriptDigests,asrNormalizedSourceDigest,routeAsrResultBridge} from '../src/asr-result-bridge.mjs';
import {createAsrOwnerFixture,createAsrJob,requestAsr,syntheticAsrDelivery,routeJson} from './fixtures/asr-owner-route-fixture.mjs';

// Every media identity and transcript in this file is invented. The fixture
// uses temporary SQLite and a synthetic owner key; no remote request or ASR
// inference is permitted, including when the provider feature is disabled.
const sha=value=>createHash('sha256').update(value).digest('hex');
let originalFetch,networkCalls=0;
before(()=>{originalFetch=globalThis.fetch;globalThis.fetch=async()=>{networkCalls++;throw Error('SYNTHETIC_TEST_NETWORK_DISABLED');};});
after(()=>{globalThis.fetch=originalFetch;assert.equal(networkCalls,0);});
const path=(jobId,action='audio-request')=>'/api/jobs/'+jobId+'/'+action;
const clone=value=>JSON.parse(JSON.stringify(value));
const rows=(f,table)=>f.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all();
const snapshot=f=>Object.fromEntries(['jobs','yta_sources','yta_operations','yta_audio','usage_events','yta_quota'].map(table=>[table,rows(f,table)]));
async function expected(response,status=409,code){const value=await routeJson(response,status);if(code)assert.equal(value.error.code,code);return value;}
async function fixture(){const f=createAsrOwnerFixture({providersEnabled:false});const job=await createAsrJob(f,{durationSeconds:123});return {f,job,id:job.id};}
async function boundFixture(){const value=await fixture(),request=await requestAsr(value.f,value.id),delivery=await syntheticAsrDelivery(value.f,value.id,request);return {...value,request,...delivery};}
const post=(f,id,action,body)=>f.call(path(id,action),{method:'POST',body});
async function store(context){return routeJson(await post(context.f,context.id,'asr-result',context.result));}
function record(f,id){const row=f.db.prepare("SELECT * FROM yta_operations WHERE job_id=? AND provider='local-asr-result-v1' ORDER BY created_at,id DESC LIMIT 1").get(id);return {...row,value:JSON.parse(row.result_json)};}
function changeRecord(f,id,mutate){const row=record(f,id),value=mutate(row.value,row)??row.value;f.db.prepare('UPDATE yta_operations SET result_json=?,state=? WHERE id=?').run(JSON.stringify(value),row.state,row.id);}
function beforeBatch(f,callback){const base=f.env.DB;let invoked=false;const wrapper={prepare:sql=>base.prepare(sql),withSession(constraint){assert.equal(constraint,'first-primary');return wrapper;},async batch(statements){if(!invoked){invoked=true;callback();}return base.batch(statements);}};f.env.DB=wrapper;return ()=>invoked;}
const cancelBody=context=>({requestId:context.request.requestId,revision:context.bound.revision,confirmCancel:true});

test('read-only status is truthful, uses the primary session, and creates no work',async()=>{
 const {f,id}=await fixture();try{const before=snapshot(f),value=await routeJson(await f.call(path(id)));
  assert.equal(value.state,'NO_REQUEST');assert.equal(value.eligible,true);assert.equal(value.sourceKind,'OWNED_AUDIO');assert.equal(value.workerConnected,false);assert.equal(value.executionAvailable,false);assert.equal(value.transferAvailable,true);assert.equal(value.providerCalls,0);assert.equal(value.summaryComplete,false);assert.equal(value.context,null);assert.equal(value.revision,null);assert.deepEqual(snapshot(f),before);assert.ok(f.sessions.length>0);assert.ok(f.sessions.every(item=>item==='first-primary'));
 }finally{f.close();}
});

test('same request is concurrent-idempotent and a different request cannot create a second active generation',async()=>{
 const {f,id}=await fixture();try{const initial=await routeJson(await f.call(path(id))),body={requestId:randomUUID(),jobSourceSha256:initial.jobSourceSha256,rightsConfirmed:true,confirmLocalOnly:true};
  const requests=await Promise.all([post(f,id,'audio-request',body),post(f,id,'audio-request',body)]),values=await Promise.all(requests.map(value=>routeJson(value)));
  assert.deepEqual(values.map(value=>value.replayed).sort(),[false,true]);assert.ok(values.every(value=>value.state==='WAITING_FOR_WORKER'));assert.equal(rows(f,'yta_operations').length,1);assert.equal(values[0].context.kind,'ASR_RESULT_BRIDGE_CONTEXT_V1');assert.equal(values[0].context.declaredDurationMs,123000);assert.equal(values[0].context.sourceIdentity.kind,'OWNED_AUDIO');
  await expected(await post(f,id,'audio-request',{...body,requestId:randomUUID()}),409,'ASR_REQUEST_CONFLICT');
  await expected(await post(f,id,'audio-request',{...body,jobSourceSha256:sha('other source')}),409,'ASR_REQUEST_CONFLICT');assert.equal(rows(f,'yta_operations').length,1);assert.equal(rows(f,'usage_events').length,0);
 }finally{f.close();}
});

test('request and bind require explicit bounded owner consent and exact input shapes',async()=>{
 const {f,id}=await fixture();try{const initial=await routeJson(await f.call(path(id))),body={requestId:randomUUID(),jobSourceSha256:initial.jobSourceSha256,rightsConfirmed:true,confirmLocalOnly:true};
  for(const invalid of [{...body,rightsConfirmed:false},{...body,confirmLocalOnly:false},{...body,extra:'synthetic'},{...body,requestId:'invalid'}])await expected(await post(f,id,'audio-request',invalid),409,'ASR_REQUEST_INVALID');
  assert.equal(rows(f,'yta_operations').length,0);const requested=await routeJson(await post(f,id,'audio-request',body)),delivery=await syntheticAsrDelivery(f,id,requested),before=snapshot(f);
  const bind={requestId:requested.requestId,revision:1,jobSourceSha256:requested.jobSourceSha256,source:delivery.source,confirmSourceBinding:true,confirmNoProviderCall:true};
  assert.equal((await routeJson(await post(f,id,'audio-request-bind',bind))).replayed,true);assert.deepEqual(snapshot(f),before);
  for(const invalid of [{...bind,confirmSourceBinding:false},{...bind,confirmNoProviderCall:false},{...bind,extra:1}])await expected(await post(f,id,'audio-request-bind',invalid),409,'ASR_BIND_REQUEST_INVALID');
 }finally{f.close();}
});

test('stored source preserves raw bytes, separates measurements and receipts, and reopens without inference',async()=>{
 const context=await boundFixture(),{f,id}=context;try{
  const segments=[{id:1,startMs:0,endMs:40000,text:'  Synthetic   first observation. '},{id:2,startMs:41000,endMs:79000,text:'Synthetic second observation.  '}],raw='Synthetic   first observation.\n\nSynthetic second observation.\n';
  context.result.transcript={raw,segments,...await asrTranscriptDigests(raw,segments)};
  const before=f.job(id),receipt=await store(context),saved=f.source(id),audit=JSON.parse(f.job(id).audit_json);
  assert.equal(receipt.state,'RESULT_STORED');assert.equal(receipt.transcriptStored,true);assert.equal(receipt.asrSummaryReady,true);assert.equal(receipt.summaryComplete,false);assert.equal(receipt.sourceAccuracy,'UNVERIFIED');assert.equal(receipt.sourceBinding,'MATCHED_OWNER_SUBMITTED_SOURCE');assert.equal(saved.raw,raw);assert.equal(saved.provenance,'OWNER_SUBMITTED_LOCAL_ASR');assert.equal(saved.segments[0].text,'Synthetic first observation.');
  assert.equal(receipt.receipt.rawSha256,sha(raw));assert.equal(receipt.receipt.segmentsSha256,sha(JSON.stringify(segments)));assert.equal(receipt.receipt.normalizedSourceSha256,await asrNormalizedSourceDigest(raw,segments));assert.notEqual(receipt.receipt.originalAudioSha256,receipt.receipt.asrInputSha256);assert.notEqual(receipt.receipt.asrInputSha256,receipt.receipt.asrPcmSha256);assert.equal(audit.localAsrReceipt.receiptSha256,sha(JSON.stringify(receipt.receipt)));
  assert.equal(receipt.receipt.durationEvidence.declaredDurationMs,123000);assert.equal(receipt.receipt.durationEvidence.originalAudioDurationMs,80040);assert.equal(receipt.receipt.durationEvidence.asrInputDurationMs,80000);assert.equal(receipt.receipt.durationEvidence.originalAudioStartTimeMs,25);assert.equal(receipt.receipt.durationEvidence.officialVideoDurationMs,null);assert.equal(receipt.receipt.durationEvidence.timeOrigin,'NORMALIZED_AUDIO_FRAME_ZERO');
  assert.equal(audit.independentVerification,false);assert.equal(audit.localAsrReceipt.inputProcessingCoverage,'NOT_INDEPENDENTLY_VERIFIED');assert.equal(audit.localAsrReceipt.summaryGenerated,false);assert.equal(audit.audioProcessingCoverage,undefined);assert.equal(f.job(id).duration_seconds,before.duration_seconds);assert.equal(f.job(id).source_type,before.source_type);assert.equal(f.job(id).report_json,before.report_json);assert.equal(rows(f,'yta_audio').length,0);assert.equal(rows(f,'usage_events').length,0);assert.equal(rows(f,'yta_quota').length,0);assert.ok(rows(f,'yta_operations').every(row=>row.provider==='local-asr-result-v1'&&row.state==='RESULT_STORED'&&row.units===0));
  const stored=snapshot(f);f.reopen();const reopened=await routeJson(await f.call(path(id)));assert.deepEqual(reopened.receipt,receipt.receipt);assert.equal(reopened.asrSummaryReady,true);assert.deepEqual(snapshot(f),stored);
  const replay=await store(context);assert.equal(replay.replayed,true);assert.deepEqual(snapshot(f),stored);
 }finally{f.close();}
});

test('receipt completeness never claims that the selected ASR input covers every spoken word',async()=>{
 const context=await boundFixture(),{f}=context;try{const value=await store(context);assert.equal(value.receipt.provenance,'OWNER_SUBMITTED_LOCAL_ASR');assert.equal(value.receipt.identityVerification,'OWNER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED');assert.equal(value.receipt.sourceAccuracy,'UNVERIFIED');assert.equal(value.providerCalls,0);assert.equal(value.receipt.audioProcessingCoverage,undefined);assert.equal(value.receipt.fullTranscriptVerified,undefined);assert.equal(value.receipt.providerSuccess,undefined);assert.equal(value.receipt.summaryComplete,undefined);}finally{f.close();}
});

test('integer transcript timestamps are required for compatibility with the approved summary format',async()=>{
 const context=await boundFixture(),{f,id}=context;try{const before=snapshot(f),invalid=clone(context.result);invalid.transcript.segments[0].endMs+=0.25;
  await expected(await post(f,id,'asr-result',invalid),409,'ASR_TRANSCRIPT_INVALID');assert.deepEqual(snapshot(f),before);
  await assert.rejects(asrTranscriptDigests(invalid.transcript.raw,invalid.transcript.segments),error=>error.code==='ASR_TRANSCRIPT_INVALID');
  const valid=await store(context);assert.equal(valid.transcriptStored,true);
 }finally{f.close();}
});

test('measured PCM duration retains fractional milliseconds separately from integer transcript timestamps',async()=>{
 const {f,id}=await fixture();try{const request=await requestAsr(f,id),wrapped={...f,call:(url,options)=>{if(url.endsWith('/audio-request-bind')){const input=options.body.source.asrInput;input.sampleCount=1280001;input.bytes=input.sampleCount*2+44;input.durationMs=input.sampleCount*1000/input.sampleRate;}return f.call(url,options);}};
  const delivery=await syntheticAsrDelivery(wrapped,id,request),value=await store({f,id,result:delivery.result});assert.equal(value.receipt.durationEvidence.asrInputDurationMs,80000.0625);assert.equal(f.job(id).duration_seconds,123);assert.ok(f.source(id).segments.every(segment=>Number.isSafeInteger(segment.startMs)&&Number.isSafeInteger(segment.endMs)));
 }finally{f.close();}
});

test('source binding checks original identity, PCM measurements, timeline origin and unknown metadata keys',async()=>{
 const context=await boundFixture(),{f,id}=context;try{const before=snapshot(f),body={requestId:context.request.requestId,revision:1,jobSourceSha256:context.request.jobSourceSha256,source:context.source,confirmSourceBinding:true,confirmNoProviderCall:true};
  const variants=[['ASR_ORIGINAL_AUDIO_HASH_MISMATCH',source=>{source.originalAudio.sha256=sha('unrelated original');source.sourceIdentity.originalAudioSha256=source.originalAudio.sha256;}],['ASR_SOURCE_SNAPSHOT_CHANGED',source=>{source.jobId=randomUUID();}],['ASR_SOURCE_SNAPSHOT_CHANGED',source=>{source.requestId=randomUUID();}],['ASR_INPUT_AUDIO_INVALID',source=>{source.asrInput.durationMs=79000;}],['ASR_INPUT_AUDIO_INVALID',source=>{source.asrInput.sampleRate=44100;}],['ASR_INPUT_AUDIO_INVALID',source=>{source.asrInput.bytes=1;}],['ASR_INPUT_AUDIO_INVALID',source=>{source.asrInput.timeOrigin='ORIGINAL_CONTAINER_START';}],['ASR_ORIGINAL_AUDIO_INVALID',source=>{source.originalAudio.verified=true;}],['ASR_INPUT_AUDIO_INVALID',source=>{source.asrInput.sourceAccuracy='VERIFIED';}]];
  for(const [code,mutate] of variants){const changed=clone(body);mutate(changed.source);await expected(await post(f,id,'audio-request-bind',changed),409,code);assert.deepEqual(snapshot(f),before);}
 }finally{f.close();}
});

test('result identity, transcript digests, explicit consent and unknown keys are checked before writing',async()=>{
 const context=await boundFixture(),{f,id}=context;try{const before=snapshot(f);
  const variants=[['ASR_RESULT_INVALID',value=>{value.confirmNoProviderCall=false;}],['ASR_RESULT_INVALID',value=>{value.confirmOwnerSubmitted=false;}],['ASR_RESULT_INVALID',value=>{value.providerSuccess=true;}],['ASR_RESULT_INVALID',value=>{value.jobId=randomUUID();}],['ASR_REQUEST_REVISION_CHANGED',value=>{value.revision++;}],['ASR_AUDIO_HASH_MISMATCH',value=>{value.originalAudioSha256=sha('wrong original');}],['ASR_AUDIO_HASH_MISMATCH',value=>{value.asrInputSha256=sha('wrong normalized WAV');}],['ASR_AUDIO_HASH_MISMATCH',value=>{value.asrPcmSha256=sha('wrong PCM');}],['ASR_TRANSCRIPT_HASH_MISMATCH',value=>{value.transcript.rawSha256=sha('wrong raw');}],['ASR_TRANSCRIPT_HASH_MISMATCH',value=>{value.transcript.segmentsSha256=sha('wrong segments');}],['ASR_TRANSCRIPT_CONTENT_MISMATCH',value=>{value.transcript.raw='A different synthetic statement.';}],['ASR_ENGINE_METADATA_INVALID',value=>{value.engine.name='paid-provider';}]];
  for(const [code,mutate] of variants){const changed=clone(context.result);mutate(changed);await expected(await post(f,id,'asr-result',changed),409,code);assert.deepEqual(snapshot(f),before);}
 }finally{f.close();}
});

test('last cue cannot redefine duration and an out-of-input cue is rejected',async()=>{
 const context=await boundFixture(),{f,id}=context;try{const changed=clone(context.result);changed.transcript.segments.at(-1).endMs=80002;Object.assign(changed.transcript,await asrTranscriptDigests(changed.transcript.raw,changed.transcript.segments));const before=snapshot(f);await expected(await post(f,id,'asr-result',changed),409,'ASR_TIMELINE_OUTSIDE_INPUT');assert.deepEqual(snapshot(f),before);
  context.result.transcript.segments.at(-1).endMs=79000;Object.assign(context.result.transcript,await asrTranscriptDigests(context.result.transcript.raw,context.result.transcript.segments));const stored=await store(context);assert.equal(stored.receipt.durationEvidence.asrInputDurationMs,80000);assert.equal(f.job(id).duration_seconds,123);
 }finally{f.close();}
});

for(const sampleCount of [32000,32009])test('integer cue end respects nearest-millisecond PCM boundary for '+sampleCount+' samples',async()=>{
 const {f,id}=await fixture();try{const request=await requestAsr(f,id),wrapped={...f,call:(url,options)=>{if(url.endsWith('/audio-request-bind')){const source=options.body.source;source.originalAudio.durationMs=2040;Object.assign(source.asrInput,{sampleCount,bytes:sampleCount*2+44,durationMs:sampleCount/16});}return f.call(url,options);}},delivery=await syntheticAsrDelivery(wrapped,id,request),end=Math.round(sampleCount/16),raw='Synthetic bounded source.';
  const invalid=[{id:1,startMs:0,endMs:end+1,text:raw}],valid=[{id:1,startMs:0,endMs:end,text:raw}];delivery.result.transcript={raw,segments:invalid,...await asrTranscriptDigests(raw,invalid)};await expected(await post(f,id,'asr-result',delivery.result),409,'ASR_TIMELINE_OUTSIDE_INPUT');assert.equal(f.source(id),null);
  delivery.result.transcript={raw,segments:valid,...await asrTranscriptDigests(raw,valid)};const stored=await store({f,id,result:delivery.result});assert.equal(stored.receipt.durationEvidence.asrInputDurationMs,sampleCount/16);assert.equal(f.source(id).segments[0].endMs,end);
 }finally{f.close();}
});

test('same stored result is immutable even when a different result is independently well-formed',async()=>{
 const context=await boundFixture(),{f,id}=context;try{await store(context);const before=snapshot(f),changed=clone(context.result);changed.engine.model='another-synthetic-model';await expected(await post(f,id,'asr-result',changed),409,'ASR_RESULT_CONFLICT');assert.deepEqual(snapshot(f),before);
  const differentEncoding=new Request('https://synthetic.invalid'+path(id,'asr-result'),{method:'POST',body:JSON.stringify(context.result,null,2)});await expected(await routeAsrResultBridge(differentEncoding,f.env),409,'ASR_RESULT_CONFLICT');assert.deepEqual(snapshot(f),before);
 }finally{f.close();}
});

test('concurrent identical result submissions create one immutable source and reconcile the other caller',async()=>{
 const context=await boundFixture(),{f}=context;try{const values=await Promise.all([store(context),store(context)]);assert.ok(values.every(value=>value.transcriptStored&&value.persisted));assert.deepEqual(values.map(value=>value.replayed).sort(),[false,true]);assert.deepEqual(values[0].receipt,values[1].receipt);assert.equal(rows(f,'yta_sources').length,1);assert.equal(rows(f,'yta_operations').length,1);assert.equal(rows(f,'usage_events').length,0);}finally{f.close();}
});

test('cancel preserves history, is idempotent, and fences late or older-generation results',async()=>{
 const context=await boundFixture(),{f,id}=context;try{
  await expected(await post(f,id,'audio-request-cancel',{...cancelBody(context),confirmCancel:false}),409,'ASR_CANCEL_INVALID');
  const cancelled=await routeJson(await post(f,id,'audio-request-cancel',cancelBody(context)));assert.equal(cancelled.state,'CANCELLED');assert.equal(cancelled.revision,3);assert.equal(cancelled.canRequest,true);const before=snapshot(f);
  assert.equal((await routeJson(await post(f,id,'audio-request-cancel',cancelBody(context)))).replayed,true);assert.deepEqual(snapshot(f),before);await expected(await post(f,id,'asr-result',context.result),409,'ASR_REQUEST_CANCELLED');
  const next=await requestAsr(f,id);assert.notEqual(next.requestId,context.request.requestId);assert.equal(next.revision,1);assert.equal(rows(f,'yta_operations').length,2);await expected(await post(f,id,'asr-result',context.result),409,'ASR_REQUEST_STALE');assert.equal(rows(f,'yta_sources').length,0);assert.equal(rows(f,'usage_events').length,0);
 }finally{f.close();}
});

test('expired source binding cannot accept a result and cannot silently reuse an old request ID',async()=>{
 const context=await boundFixture(),{f,id}=context;try{changeRecord(f,id,value=>{value.expiresAt=Date.now()-1000;});const before=snapshot(f);const value=await routeJson(await f.call(path(id)));assert.equal(value.state,'EXPIRED');assert.equal(value.canReceive,false);await expected(await post(f,id,'asr-result',context.result),409,'ASR_REQUEST_EXPIRED');assert.deepEqual(snapshot(f),before);const next=await requestAsr(f,id);assert.notEqual(next.requestId,context.request.requestId);assert.equal(rows(f,'yta_operations').length,2);}finally{f.close();}
});

for(const change of ['audit','report','duration','status','updatedAt','owner','deletion','source'])test('final source commit rejects a concurrent '+change+' change without overwriting it',async()=>{
 const context=await boundFixture(),{f,id}=context;try{
  const injected=beforeBatch(f,()=>{
   if(change==='audit')f.db.prepare('UPDATE jobs SET audit_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(f.job(id).audit_json),syntheticConcurrentUpdate:true}),id);
   if(change==='report')f.db.prepare('UPDATE jobs SET report_json=? WHERE id=?').run('{"kind":"SYNTHETIC_EXISTING_REPORT"}',id);
   if(change==='duration')f.db.prepare('UPDATE jobs SET duration_seconds=124 WHERE id=?').run(id);
   if(change==='status')f.db.prepare('UPDATE jobs SET status=? WHERE id=?').run('SYNTHETIC_CONCURRENT_STATUS',id);
   if(change==='updatedAt')f.db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run('2040-01-01T00:00:00.000Z',id);
   if(change==='owner')f.db.prepare('UPDATE jobs SET owner_id=? WHERE id=?').run('synthetic-other-owner',id);
   if(change==='deletion')f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run(id+':deleting',id,'deletion',0,'DELETING',new Date().toISOString());
   if(change==='source')f.db.prepare('INSERT INTO yta_sources VALUES(?,?,?,?,?)').run(id,'Synthetic preserved competing transcript','[]','SYNTHETIC_OTHER_SOURCE',new Date().toISOString());
  });
  await expected(await post(f,id,'asr-result',context.result),['owner','deletion'].includes(change)?404:409);assert.equal(injected(),true);assert.equal(record(f,id).state,'SOURCE_BOUND');assert.equal(rows(f,'yta_sources').length,change==='source'?1:0);if(change==='source')assert.equal(f.source(id).raw,'Synthetic preserved competing transcript');assert.equal(rows(f,'yta_audio').length,0);assert.equal(rows(f,'usage_events').length,0);
 }finally{f.close();}
});

for(const table of ['yta_sources','jobs','yta_operations'])test('SQL zero-row '+table+' step rolls back the complete source/audit/receipt transaction',async()=>{
 const context=await boundFixture(),{f,id}=context;try{const before=snapshot(f),event=table==='yta_sources'?'INSERT':'UPDATE',condition=table==='yta_operations'?" WHEN NEW.state='RESULT_STORED'":'';f.db.exec('CREATE TRIGGER synthetic_abort_step BEFORE '+event+' ON '+table+condition+' BEGIN SELECT RAISE(IGNORE); END;');
  await expected(await post(f,id,'asr-result',context.result),409,'ASR_RESULT_WRITE_UNCONFIRMED');assert.deepEqual(snapshot(f),before);assert.equal(f.source(id),null);
 }finally{f.close();}
});

test('an SQL error after the source write rolls back all three persisted records',async()=>{
 const context=await boundFixture(),{f,id}=context;try{const before=snapshot(f);f.db.exec("CREATE TRIGGER synthetic_sql_failure BEFORE UPDATE ON yta_operations WHEN NEW.state='RESULT_STORED' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");await expected(await post(f,id,'asr-result',context.result),409,'ASR_RESULT_WRITE_UNCONFIRMED');assert.deepEqual(snapshot(f),before);}finally{f.close();}
});

test('a successful commit with a lost acknowledgement reconciles by exact receipt and source hashes',async()=>{
 const context=await boundFixture(),{f}=context;try{const base=f.env.DB;let batches=0;const wrapper={prepare:sql=>base.prepare(sql),withSession(){return wrapper;},async batch(statements){batches++;await base.batch(statements);throw Error('SYNTHETIC_ACK_LOSS_AFTER_LOCAL_COMMIT');}};f.env.DB=wrapper;const value=await store(context);assert.equal(value.persisted,true);assert.equal(value.replayed,true);assert.equal(value.transcriptStored,true);assert.equal(batches,1);const before=snapshot(f);await store(context);assert.equal(batches,1);assert.deepEqual(snapshot(f),before);}finally{f.close();}
});

for(const phase of ['request','bind','cancel'])test(phase+' acknowledgement loss remains explicit and owner readback reconciles without new execution',async()=>{
 const template=await boundFixture(),media=clone(template.source);template.f.close();const {f,id}=await fixture();try{
  let request,body,action,prefix,expectedState,code;
  if(phase==='request'){const status=await routeJson(await f.call(path(id)));body={requestId:randomUUID(),jobSourceSha256:status.jobSourceSha256,rightsConfirmed:true,confirmLocalOnly:true};action='audio-request';prefix='INSERT OR IGNORE INTO yta_operations';expectedState='WAITING_FOR_WORKER';code='ASR_REQUEST_WRITE_UNCERTAIN';}
  else{
   request=await requestAsr(f,id);
   if(phase==='bind'){Object.assign(media,{jobId:id,requestId:request.requestId,jobSourceSha256:request.jobSourceSha256});body={requestId:request.requestId,revision:1,jobSourceSha256:request.jobSourceSha256,source:media,confirmSourceBinding:true,confirmNoProviderCall:true};action='audio-request-bind';prefix="UPDATE yta_operations SET state='SOURCE_BOUND'";expectedState='SOURCE_BOUND';code='ASR_BIND_WRITE_UNCERTAIN';}
   else{body={requestId:request.requestId,revision:1,confirmCancel:true};action='audio-request-cancel';prefix="UPDATE yta_operations SET state='CANCELLED'";expectedState='CANCELLED';code='ASR_CANCEL_WRITE_UNCERTAIN';}
  }
  const base=f.env.DB;let injected=false;const wrap=(statement,sql)=>({...statement,bind(...args){return wrap(statement.bind(...args),sql);},async run(){const value=await statement.run();if(!injected&&sql.startsWith(prefix)){injected=true;throw Error('SYNTHETIC_ACK_LOSS_AFTER_STATE_COMMIT');}return value;}}),DB={prepare:sql=>wrap(base.prepare(sql),sql),batch:statements=>base.batch(statements),withSession(){return DB;}};f.env.DB=DB;
  await expected(await post(f,id,action,body),409,code);assert.equal(injected,true);const state=await routeJson(await f.call(path(id)));assert.equal(state.state,expectedState);assert.equal(state.requestId,body.requestId);assert.equal(state.workerConnected,false);assert.equal(state.providerCalls,0);const before=snapshot(f);
  assert.equal((await routeJson(await post(f,id,action,body))).replayed,true);assert.deepEqual(snapshot(f),before);assert.equal(f.source(id),null);assert.equal(rows(f,'usage_events').length,0);assert.equal(rows(f,'yta_audio').length,0);
 }finally{f.close();}
});

for(const conflict of ['audio','provider','provider-uncertain','usage','runner','new-runner-schema'])test('an existing '+conflict+' writer or record excludes a new transcript writer',async()=>{
 const context=await boundFixture(),{f,id}=context;try{const stamp=new Date().toISOString();
  const inject=()=>{
   if(conflict==='audio')f.db.prepare('INSERT INTO yta_audio VALUES(?,?,?,?,?,?)').run(id,0,0,80,'PLANNED',null);
   if(conflict==='provider'||conflict==='provider-uncertain')f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run(id+':synthetic-prior',id,conflict==='provider'?'gemini':'supadata',1,conflict==='provider'?'DONE':'FAILED_UNCERTAIN',stamp);
   if(conflict==='usage')f.db.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,'owner','groq','SYNTHETIC','seconds',1,'SYNTHETIC',stamp);
   if(conflict==='runner'||conflict==='new-runner-schema'){f.db.exec('CREATE TABLE yta_local_runner_outbox(job_id TEXT NOT NULL)');if(conflict==='runner')f.db.prepare('INSERT INTO yta_local_runner_outbox VALUES(?)').run(id);}
  };
  if(conflict==='new-runner-schema')beforeBatch(f,inject);else inject();
  await expected(await post(f,id,'asr-result',context.result),409,'ASR_RESULT_WRITE_UNCONFIRMED');assert.equal(f.source(id),null);assert.equal(record(f,id).state,'SOURCE_BOUND');
 }finally{f.close();}
});

test('cancel arriving just before the source batch prevents late transcript persistence',async()=>{
 const context=await boundFixture(),{f,id}=context;try{beforeBatch(f,()=>changeRecord(f,id,(value,row)=>{row.state='CANCELLED';value.revision++;value.cancelBodySha256=sha('synthetic concurrent explicit cancellation');}));await expected(await post(f,id,'asr-result',context.result),409,'ASR_RESULT_WRITE_UNCONFIRMED');assert.equal(record(f,id).state,'CANCELLED');assert.equal(f.source(id),null);}finally{f.close();}
});

test('deletion scrubs local-ASR private metadata and rejects a late result without recreating the source',async()=>{
 const context=await boundFixture(),{f,id}=context;try{await store(context);await routeJson(await f.call('/api/jobs/'+id,{method:'DELETE'}));assert.equal(f.job(id),undefined);assert.equal(f.source(id),null);const before=snapshot(f);for(const row of rows(f,'yta_operations').filter(row=>row.provider==='local-asr-result-v1'))assert.equal(row.result_json,null);await expected(await post(f,id,'asr-result',context.result),404,'NOT_FOUND');await expected(await f.call(path(id)),404,'NOT_FOUND');assert.deepEqual(snapshot(f),before);}finally{f.close();}
});

for(const field of ['jobId','requestId','originalAudioSha256','sourceAccuracy','provenance','summaryComplete'])test('stored receipt '+field+' poisoning is rejected rather than projected as success',async()=>{
 const context=await boundFixture(),{f,id}=context;try{await store(context);changeRecord(f,id,value=>{value.receipt[field]=field==='summaryComplete'?true:field==='originalAudioSha256'?sha('forged original'):field==='jobId'||field==='requestId'?randomUUID():'SYNTHETIC_FORGED_VALUE';});const before=snapshot(f);const response=await expected(await f.call(path(id)),409,'ASR_RECEIPT_INVALID');assert.equal(JSON.stringify(response).includes('SYNTHETIC_FORGED_VALUE'),false);assert.deepEqual(snapshot(f),before);}finally{f.close();}
});

test('a well-shaped receipt mutation fails its audit hash and is withheld from the status projection',async()=>{
 const context=await boundFixture(),{f,id}=context;try{await store(context);changeRecord(f,id,value=>{value.receipt.engine.model='synthetic-tampered-model';});const value=await routeJson(await f.call(path(id)));assert.equal(value.state,'SOURCE_REVIEW_REQUIRED');assert.equal(value.receipt,null);assert.equal(value.transcriptStored,false);assert.equal(value.asrSummaryReady,false);await expected(await post(f,id,'asr-result',context.result),409,'ASR_STORED_SOURCE_CHANGED');}finally{f.close();}
});

for(const action of ['owner','deletion'])test('data-bearing receipt SELECT blocks a concurrent '+action+' scope change',async()=>{
 const context=await boundFixture(),{f,id}=context;try{await store(context);let injected=false;f.beforeSql=sql=>{if(injected||!sql.startsWith('SELECT o.* FROM yta_operations'))return;injected=true;if(action==='owner')f.db.prepare('UPDATE jobs SET owner_id=? WHERE id=?').run('synthetic-other-owner',id);else f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run(id+':deleting',id,'deletion',0,'DELETING',new Date().toISOString());};
  const response=await f.call(path(id)),body=await response.json();assert.ok([200,404].includes(response.status));assert.equal(injected,true);assert.equal(body.source??null,null);assert.equal(body.receipt??null,null);assert.equal(JSON.stringify(body).includes('OWNER_SUBMITTED_ASR_SOURCE_V1'),false);
 }finally{f.close();}
});

test('a changed source slot or audit cannot be treated as the originally stored transcript',async()=>{
 const context=await boundFixture(),{f,id}=context;try{await store(context);f.db.prepare('UPDATE yta_sources SET raw=? WHERE job_id=?').run('Synthetic changed source',id);const state=await routeJson(await f.call(path(id)));assert.equal(state.state,'SOURCE_REVIEW_REQUIRED');assert.equal(state.transcriptStored,false);assert.equal(state.receipt,null);await expected(await post(f,id,'asr-result',context.result),409,'ASR_STORED_SOURCE_CHANGED');}finally{f.close();}
});

test('UTF-8 transport and stored transcript limits count bytes and reject invalid encodings',async()=>{
 const {f,id}=await fixture();try{const before=snapshot(f);const raw='한'.repeat(Math.floor(ASR_BRIDGE_LIMITS.jsonBytes/3)+1),request=new Request('https://synthetic.invalid'+path(id),{method:'POST',body:raw});await expected(await routeAsrResultBridge(request,f.env),409,'ASR_JSON_TOO_LARGE');
  const invalid=new Request('https://synthetic.invalid'+path(id),{method:'POST',body:new Uint8Array([123,34,97,34,58,34,0xc3,0x28,34,125])});await expected(await routeAsrResultBridge(invalid,f.env),409,'ASR_JSON_INVALID');assert.deepEqual(snapshot(f),before);
  const text='한'.repeat(260000);await assert.rejects(asrTranscriptDigests(text,[{id:1,startMs:0,endMs:1,text}]),error=>error.code==='ASR_TRANSCRIPT_TOO_LARGE');
 }finally{f.close();}
});

test('request snapshot changes stop bind replay and expose an explicit review state',async()=>{
 const context=await boundFixture(),{f,id}=context;try{f.db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run('2041-01-01T00:00:00.000Z',id);const state=await routeJson(await f.call(path(id)));assert.equal(state.state,'SOURCE_REVIEW_REQUIRED');assert.equal(state.canBind,false);assert.equal(state.canReceive,false);const body={requestId:context.request.requestId,revision:1,jobSourceSha256:context.request.jobSourceSha256,source:context.source,confirmSourceBinding:true,confirmNoProviderCall:true};await expected(await post(f,id,'audio-request-bind',body),409,'ASR_SOURCE_SNAPSHOT_CHANGED');assert.equal(f.source(id),null);}finally{f.close();}
});

test('an explicitly cancelled generation retains its context while a new request pins the changed job snapshot',async()=>{
 const context=await boundFixture(),{f,id}=context;try{
  await routeJson(await post(f,id,'audio-request-cancel',cancelBody(context)));const oldRecord=record(f,id);
  f.db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run('2042-01-01T00:00:00.000Z',id);
  const state=await routeJson(await f.call(path(id)));assert.equal(state.canRequest,true);assert.notEqual(state.jobSourceSha256,context.request.jobSourceSha256);assert.equal(state.context.jobSourceSha256,context.request.jobSourceSha256);
  const next=await requestAsr(f,id);assert.equal(next.jobSourceSha256,state.jobSourceSha256);assert.notEqual(next.requestId,context.request.requestId);assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(oldRecord.id).result_json,oldRecord.result_json);assert.equal(f.source(id),null);
 }finally{f.close();}
});

test('hash helper and normalized source hashing stay separate from original segment receipt hashing',async()=>{
 const raw='Synthetic   text\n',segments=[{id:1,startMs:0,endMs:1000,text:' Synthetic   text '}],digests=await asrTranscriptDigests(raw,segments);assert.equal(await asrSha256(raw),sha(raw));assert.equal(digests.rawSha256,sha(raw));assert.equal(digests.segmentsSha256,sha(JSON.stringify(segments)));assert.notEqual(digests.segmentsSha256,sha(JSON.stringify([{...segments[0],text:'Synthetic text'}])));assert.equal(await asrNormalizedSourceDigest(raw,segments),sha(JSON.stringify({raw,segments:[{id:1,startMs:0,endMs:1000,text:'Synthetic text'}],provenance:'OWNER_SUBMITTED_LOCAL_ASR'})));
});

test('unsupported control characters are rejected without silently rewriting the source',async()=>{
 for(const character of ['\u0000','\u0007','\u000b','\u000c','\u001f','\u007f']){
  const text='Synthetic'+character+'text';await assert.rejects(asrTranscriptDigests(text,[{id:1,startMs:0,endMs:1000,text}]),error=>error.code==='ASR_TRANSCRIPT_INVALID');
 }
 const raw='Synthetic\ttext\r\n';assert.equal((await asrTranscriptDigests(raw,[{id:1,startMs:0,endMs:1000,text:'Synthetic text'}])).rawSha256,sha(raw));
});
