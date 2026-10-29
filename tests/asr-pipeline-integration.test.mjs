import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {asrTranscriptDigests} from '../src/asr-result-bridge.mjs';
import {createAsrOwnerFixture,routeJson,createAsrJob,requestAsr,syntheticAsrDelivery} from './fixtures/asr-owner-route-fixture.mjs';

// Complete application route integration with invented transcripts and mocked
// native/summary providers. Actual attached ASR storage is a separate private
// runtime harness; no public recording or actual ASR text is embedded here.
const profile='approved-four-part-v1',path=id=>'/api/jobs/'+id;
async function using(run,options={}){const f=createAsrOwnerFixture(options),prior=globalThis.fetch;globalThis.fetch=f.provider;try{return await run(f);}finally{globalThis.fetch=prior;f.close();}}
const receive=(f,id,result)=>f.call(path(id)+'/asr-result',{method:'POST',body:result});

test('NO_CAPTIONS owner route connects request, synthetic ASR, approved summary, durable list and export',async()=>using(async f=>{
 const job=await createAsrJob(f,{sourceType:'url'}),id=job.id;
 const native=await routeJson(await f.call(path(id)+'/native',{method:'POST',body:{}}),202);assert.equal(native.job.audit.status,'NO_CAPTIONS');
 const baselineOps=f.db.prepare('SELECT * FROM yta_operations ORDER BY id').all(),baselineUsage=f.db.prepare('SELECT * FROM usage_events ORDER BY id').all();
 const before=await routeJson(await f.call(path(id)+'/audio-request'));assert.equal(before.workerConnected,false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_operations').get().n,baselineOps.length);
 const request=await requestAsr(f,id);assert.equal(request.state,'WAITING_FOR_WORKER');assert.equal(request.workerConnected,false);assert.equal(f.source(id),null);assert.equal(f.counts.summaryMock,0);
 const delivery=await syntheticAsrDelivery(f,id,request);assert.equal(delivery.bound.state,'SOURCE_BOUND');
 const saved=await routeJson(await receive(f,id,delivery.result));assert.equal(saved.state,'RESULT_STORED');assert.equal(saved.transcriptStored,true);assert.equal(saved.asrSummaryReady,true);assert.equal(f.job(id).source_type,'url');assert.equal(f.job(id).duration_seconds,80);
 const stored=f.source(id);assert.equal(stored.raw,delivery.result.transcript.raw);assert.equal(stored.provenance,'OWNER_SUBMITTED_LOCAL_ASR');
 assert.deepEqual(f.db.prepare("SELECT * FROM yta_operations WHERE provider!='local-asr-result-v1' ORDER BY id").all(),baselineOps);assert.deepEqual(f.db.prepare('SELECT * FROM usage_events ORDER BY id').all(),baselineUsage);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='local-asr-result-v1' AND (units!=0 OR state='DONE')").get().n,0);
 const sourceRead=await routeJson(await f.call(path(id)+'/source'));assert.equal(sourceRead.source.raw,stored.raw);
 const plan=await routeJson(await f.call(path(id)+'/summary-plan?formatProfile='+profile));assert.equal(plan.formatProfile,profile);
 const summary=await routeJson(await f.call(path(id)+'/summary',{method:'POST',body:{formatProfile:profile}}));assert.equal(summary.persisted,true);assert.equal(summary.job.approvedSummaryView.sourceStatus,'MATCHED');assert.equal(summary.job.report.approvedSummary.semanticReview,'NOT_PERFORMED');
 f.reopen();const listing=await routeJson(await f.call('/api/jobs'));assert.equal(listing.jobs.length,1);assert.deepEqual(listing.jobs[0].summary,summary.job.report.summary);
 const reopened=await routeJson(await f.call(path(id)));assert.deepEqual(reopened.job.report,summary.job.report);assert.equal(reopened.job.approvedSummaryView.sourceStatus,'MATCHED');assert.deepEqual(f.source(id),stored);
 const receipt=await routeJson(await f.call(path(id)+'/audio-request'));assert.equal(receipt.state,'RESULT_STORED');assert.equal(receipt.transcriptStored,true);
 const exported=await f.call(path(id)+'/export?format=md');assert.equal(exported.status,200);const text=await exported.text();for(const label of ['핵심 결론','목차','인과관계','가정','반례'])assert.ok(text.includes(label));
 assert.deepEqual(f.counts,{nativeMock:1,summaryMock:1,unexpectedTransport:0});assert.ok(f.sessions.length>0);assert.ok(f.sessions.every(value=>value==='first-primary'));
}));

test('owned audio result can be stored with providers disabled and no audio plan or provider receipt',async()=>using(async f=>{
 const job=await createAsrJob(f),request=await requestAsr(f,job.id),delivery=await syntheticAsrDelivery(f,job.id,request),saved=await routeJson(await receive(f,job.id,delivery.result));
 assert.equal(saved.transcriptStored,true);assert.equal(JSON.parse(f.job(job.id).report_json),null);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_audio').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider!='local-asr-result-v1'").get().n,0);assert.deepEqual(f.counts,{nativeMock:0,summaryMock:0,unexpectedTransport:0});
 f.reopen();const readback=await routeJson(await f.call(path(job.id)+'/source'));assert.equal(readback.source.raw,delivery.result.transcript.raw);assert.equal((await routeJson(await f.call('/api/jobs'))).jobs[0].id,job.id);
},{providersEnabled:false}));

test('discarded request and result acknowledgements resume the same operation without source overwrite',async()=>using(async f=>{
 const job=await createAsrJob(f),requestId=randomUUID(),initial=await routeJson(await f.call(path(job.id)+'/audio-request'));
 const body={requestId,jobSourceSha256:initial.jobSourceSha256,rightsConfirmed:true,confirmLocalOnly:true};assert.equal((await f.call(path(job.id)+'/audio-request',{method:'POST',body})).status,200);
 f.reopen();const replay=await routeJson(await f.call(path(job.id)+'/audio-request',{method:'POST',body}));assert.equal(replay.requestId,requestId);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM yta_operations WHERE provider='local-asr-result-v1'").get().n,1);
 const delivery=await syntheticAsrDelivery(f,job.id,replay);assert.equal((await receive(f,job.id,delivery.result)).status,200);const source=f.source(job.id),operations=f.db.prepare('SELECT * FROM yta_operations ORDER BY id').all();
 f.reopen();const status=await routeJson(await f.call(path(job.id)+'/audio-request'));assert.equal(status.transcriptStored,true);assert.equal(status.requestId,requestId);
 const duplicate=await routeJson(await receive(f,job.id,delivery.result));assert.equal(duplicate.transcriptStored,true);assert.deepEqual(f.source(job.id),source);assert.deepEqual(f.db.prepare('SELECT * FROM yta_operations ORDER BY id').all(),operations);assert.deepEqual(f.counts,{nativeMock:0,summaryMock:0,unexpectedTransport:0});
},{providersEnabled:false}));

test('another result, source or request cannot replace a stored transcript',async()=>using(async f=>{
 const job=await createAsrJob(f),request=await requestAsr(f,job.id),delivery=await syntheticAsrDelivery(f,job.id,request);await routeJson(await receive(f,job.id,delivery.result));const stored=f.source(job.id),jobBefore=f.job(job.id);
 const changed=structuredClone(delivery.result);changed.transcript.segments[0].text='Invented replacement';changed.transcript.raw=changed.transcript.segments.map(item=>item.text).join('\n');Object.assign(changed.transcript,await asrTranscriptDigests(changed.transcript.raw,changed.transcript.segments));
 assert.equal((await receive(f,job.id,changed)).status,409);
 assert.equal((await receive(f,job.id,{...delivery.result,requestId:randomUUID()})).status,409);
 assert.equal((await receive(f,job.id,{...delivery.result,originalAudioSha256:'e'.repeat(64)})).status,409);
 assert.deepEqual(f.source(job.id),stored);assert.deepEqual(f.job(job.id),jobBefore);
},{providersEnabled:false}));

test('cancellation rejects a late result without reviving the source or triggering ASR',async()=>using(async f=>{
 const job=await createAsrJob(f),request=await requestAsr(f,job.id),delivery=await syntheticAsrDelivery(f,job.id,request);
 assert.equal((await f.call(path(job.id)+'/audio-request-cancel',{method:'POST',body:{requestId:delivery.bound.requestId,revision:delivery.bound.revision}})).status,409);
 const cancelled=await routeJson(await f.call(path(job.id)+'/audio-request-cancel',{method:'POST',body:{requestId:delivery.bound.requestId,revision:delivery.bound.revision,confirmCancel:true}}));assert.equal(cancelled.state,'CANCELLED');
 assert.equal((await receive(f,job.id,delivery.result)).status,409);assert.equal(f.source(job.id),null);assert.equal(JSON.parse(f.job(job.id).report_json),null);assert.deepEqual(f.counts,{nativeMock:0,summaryMock:0,unexpectedTransport:0});
},{providersEnabled:false}));

test('existing owner JWT, same-origin write checks and current row owner guard all bridge routes',async()=>using(async f=>{
 const job=await createAsrJob(f),request=await requestAsr(f,job.id),delivery=await syntheticAsrDelivery(f,job.id,request),before=f.db.prepare('SELECT * FROM yta_operations ORDER BY id').all();
 assert.equal((await f.call(path(job.id)+'/audio-request',{email:'other@example.test'})).status,401);
 assert.equal((await f.call(path(job.id)+'/asr-result',{method:'POST',body:delivery.result,requestOrigin:'https://foreign.invalid'})).status,403);
 f.db.prepare('UPDATE jobs SET owner_id=? WHERE id=?').run('synthetic-other-owner',job.id);
 assert.equal((await f.call(path(job.id)+'/audio-request')).status,404);assert.equal((await receive(f,job.id,delivery.result)).status,404);assert.equal((await f.call(path(job.id)+'/source')).status,404);assert.equal((await routeJson(await f.call('/api/jobs'))).jobs.length,0);
 assert.equal(f.source(job.id),null);assert.deepEqual(f.db.prepare('SELECT * FROM yta_operations ORDER BY id').all(),before);
},{providersEnabled:false}));

test('fractional producer times require integer app normalization before four-part summary',async()=>using(async f=>{
 const job=await createAsrJob(f),request=await requestAsr(f,job.id),delivery=await syntheticAsrDelivery(f,job.id,request),result=structuredClone(delivery.result);
 result.transcript.segments[0].startMs=123.456;
 // Deliberately malformed sender input must reach the HTTP validator; the
 // production digest helper itself correctly refuses fractional timestamps.
 result.transcript.segmentsSha256=createHash('sha256').update(JSON.stringify(result.transcript.segments)).digest('hex');
 const rejected=await receive(f,job.id,result);assert.equal(rejected.status,409);assert.equal((await rejected.json()).error.code,'ASR_TRANSCRIPT_INVALID');assert.equal(f.source(job.id),null);
 result.transcript.segments[0].startMs=Math.round(result.transcript.segments[0].startMs);Object.assign(result.transcript,await asrTranscriptDigests(result.transcript.raw,result.transcript.segments));
 await routeJson(await receive(f,job.id,result));assert.equal(f.source(job.id).segments[0].startMs,123);
 const summary=await routeJson(await f.call(path(job.id)+'/summary',{method:'POST',body:{formatProfile:profile}}));assert.equal(summary.job.approvedSummaryView.sourceStatus,'MATCHED');assert.equal(summary.job.approvedSummaryView.origin,'APPROVED_STRUCTURED');assert.equal(summary.job.report.approvedSummary.semanticReview,'NOT_PERFORMED');assert.equal(f.counts.summaryMock,1);
}));
