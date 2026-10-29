import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {routeApi} from '../src/worker.mjs';
import {transcriptAudit} from '../src/core.mjs';
import {auditGaps} from '../src/report.mjs';
import {syntheticApprovedSource,syntheticApprovedReport} from './fixtures/approved-summary-synthetic.mjs';

// Invented identities, captions and provider responses only. Every fetch is
// replaced locally; this file cannot verify provider, audio or production quality.
const submissionId='00000000-0000-4000-8000-00000000000a';
const base='/api/jobs/'+submissionId;
const payload={sourceType:'url',url:'https://youtu.be/synthetic01',durationSeconds:90,title:'Synthetic caption submission',submissionId};
const profile={formatProfile:'approved-four-part-v1'};
const request=(path,method='GET',body)=>new Request('https://synthetic.invalid'+path,{method,headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const noFetch=async()=>{throw Error('UNEXPECTED_SYNTHETIC_NETWORK_DISPATCH');};
async function withFetch(mock,run){const original=globalThis.fetch;globalThis.fetch=mock;try{return await run();}finally{globalThis.fetch=original;}}
async function result(response){return {status:response.status,body:await response.json()};}

function fixture({submissionColumn=true}={}){
 const db=new DatabaseSync(':memory:');
 for(const path of ['schema.sql','migrations/0002_live.sql','migrations/0003_observed_capacity.sql',...(submissionColumn?['migrations/0017_audio_submission_idempotency.sql']:[])])db.exec(readFileSync(new URL('../'+path,import.meta.url),'utf8'));
 const DB={prepare(sql){const make=args=>({sql,args,bind(...values){return make(values);},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}});return make([]);},async batch(statements){db.exec('BEGIN');try{const values=statements.map(statement=>({meta:{changes:Number(db.prepare(statement.sql).run(...statement.args).changes)}}));db.exec('COMMIT');return values;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const key='SYNTHETIC_LOCAL_ONLY_NO_ACCOUNT';
 const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GEMINI_API_KEY:key,SUPADATA_API_KEY:key};
 const call=(path,method='GET',body,override=env)=>routeApi(request(path,method,body),override);
 const create=(body=payload,override=env)=>call('/api/jobs','POST',body,override);
 const snapshot=()=>Object.fromEntries(['jobs','yta_sources','yta_operations','usage_events','yta_audio','yta_quota'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()]));
 function grant(provider){const now=Date.now();db.prepare('INSERT INTO yta_quota(provider,allowance,request_limit,expires_at,confirmed_at,billing_disabled) VALUES(?,?,?,?,?,1)').run(provider,provider==='gemini'?250000:10,10,now+3600000,now);if(provider==='gemini'){
  const remaining={requestsMinute:100,tokensMinute:1000000,requestsDay:100};
  db.prepare('INSERT INTO yta_capacity(provider,model,source,observed_at,valid_until,reset_json,remaining_json,reserved_json,billing_disabled) VALUES(?,?,?,?,?,?,?,?,1)').run('gemini','gemini-2.5-flash','AI_STUDIO_LIVE:'+createHash('sha256').update('gemini:'+key).digest('hex'),now,now+600000,JSON.stringify(Object.fromEntries(Object.keys(remaining).map(name=>[name,now+3600000]))),JSON.stringify(remaining),JSON.stringify(Object.fromEntries(Object.keys(remaining).map(name=>[name,0]))));
 }}
 async function storedCaption(reportValue=null){await create();const source=syntheticApprovedSource(),audit={...transcriptAudit(source.segments,90,false),...auditGaps(source.segments,90),providerCompleteness:'NOT_INDEPENDENTLY_VERIFIED',nativeAcquisition:'CAPTIONS_STORED',automaticAudioAcquisition:'NOT_CONNECTED'};db.prepare('UPDATE jobs SET status=?,audit_json=?,report_json=? WHERE id=?').run(audit.status,JSON.stringify(audit),reportValue,submissionId);db.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').run(submissionId,source.raw,JSON.stringify(source.segments),'SUPADATA_NATIVE',new Date().toISOString());return {source,audit};}
 return {db,DB,env,call,create,snapshot,grant,storedCaption,close:()=>db.close()};
}

test('URL-only legacy callers keep separate jobs and expose no-stored-caption-result without starting work',async()=>{
 const f=fixture({submissionColumn:false});try{await withFetch(noFetch,async()=>{
  const {submissionId:ignored,...legacy}=payload;
  const a=await result(await f.create(legacy)),b=await result(await f.create(legacy));
  assert.equal(a.status,202);assert.equal(b.status,202);assert.notEqual(a.body.job.id,b.body.job.id);
  assert.equal(a.body.job.status,'NEED_UPLOAD');assert.equal(a.body.job.audit.status,'CAPTION_RESULT_UNAVAILABLE');assert.equal(a.body.job.audit.nativeAcquisition,'NO_STORED_RESULT');assert.equal(a.body.job.audit.automaticAudioAcquisition,'NOT_CONNECTED');assert.equal(a.body.job.report,null);
  const history=(await result(await f.call('/api/jobs'))).body.jobs;assert.equal(history.length,2);assert.ok(history.every(job=>job.nativeAcquisitionReady===true));
  for(const table of ['yta_operations','usage_events','yta_audio'])assert.equal(f.db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
 });}finally{f.close();}
});

test('identified URL submissions are atomic, canonical and preserve saved work on replay',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  const replies=await Promise.all([f.create(),f.create({...payload,url:'https://www.youtube.com/watch?v=synthetic01&t=10',submissionId:submissionId.toUpperCase()})]);
  const values=await Promise.all(replies.map(result));assert.ok(values.every(value=>value.status===202));assert.deepEqual(values.map(value=>value.body.reused).sort(),[false,true]);assert.ok(values.every(value=>value.body.job.id===submissionId));
  const source=syntheticApprovedSource(),report={kind:'GEMINI_EVIDENCE_LINKED',summary:[{text:'Synthetic saved result',evidenceIds:[1]}]};
  f.db.prepare('UPDATE jobs SET status=?,report_json=?,audit_json=? WHERE id=?').run('TRANSCRIPT_UNVERIFIED',JSON.stringify(report),JSON.stringify({status:'TRANSCRIPT_UNVERIFIED',syntheticPreservation:true}),submissionId);
  f.db.prepare('INSERT INTO yta_sources VALUES(?,?,?,?,?)').run(submissionId,source.raw,JSON.stringify(source.segments),'SYNTHETIC',new Date().toISOString());
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(submissionId+':synthetic-prior',submissionId,'synthetic',0,'DONE',new Date().toISOString(),'{"synthetic":true}');
  const before=f.snapshot(),replay=await result(await f.create());assert.equal(replay.status,202);assert.equal(replay.body.reused,true);assert.deepEqual(replay.body.job.report,report);assert.deepEqual(f.snapshot(),before);
 });}finally{f.close();}
});

test('identified URL changes reject exact input mismatch and keep the saved request',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  await f.create();const before=f.snapshot();
  for(const change of [{url:'https://youtu.be/synthetic02'},{durationSeconds:91},{title:'Another synthetic title'}]){const response=await result(await f.create({...payload,...change}));assert.equal(response.status,409);assert.equal(response.body.error.code,'URL_SUBMISSION_MISMATCH');assert.deepEqual(f.snapshot(),before);}
  f.db.prepare('UPDATE jobs SET source_type=? WHERE id=?').run('text',submissionId);const changed=f.snapshot();assert.equal((await result(await f.create())).body.error.code,'URL_SUBMISSION_MISMATCH');assert.deepEqual(f.snapshot(),changed);
 });}finally{f.close();}
});

test('wrong-owner URL collision reveals no saved content and creates no replacement',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  await f.create();f.db.prepare('UPDATE jobs SET owner_id=?,title=? WHERE id=?').run('synthetic-other-owner','SYNTHETIC_OTHER_OWNER_CONTENT',submissionId);const before=f.snapshot();
  const response=await result(await f.create());assert.equal(response.status,409);assert.equal(response.body.error.code,'URL_SUBMISSION_UNAVAILABLE');assert.equal(JSON.stringify(response.body).includes('SYNTHETIC_OTHER_OWNER_CONTENT'),false);assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.call(base)).status,404);assert.equal((await result(await f.call('/api/jobs'))).body.jobs.length,0);
 });}finally{f.close();}
});

test('URL identity validation and existing schema gate stop before creating work',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  for(const change of [{submissionId:null},{submissionId:'invalid'},{submissionId:1},{ownedAudioSha256:'a'.repeat(64)}])assert.equal((await f.create({...payload,...change})).status,400);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  const noDb=await result(await f.create(payload,{ENABLE_LIVE_FREE:'false'}));assert.equal(noDb.status,503);assert.equal(noDb.body.error.code,'PERSISTENCE_NOT_CONFIGURED');
 });}finally{f.close();}
 const missing=fixture({submissionColumn:false});try{await withFetch(noFetch,async()=>{const response=await result(await missing.create());assert.equal(response.status,409);assert.equal(response.body.error.code,'LIVE_SCHEMA_REQUIRED');assert.equal(missing.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);});}finally{missing.close();}
});

test('deleted URL submission cannot recreate its job or start another acquisition',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  await f.create();assert.equal((await f.call(base,'DELETE')).status,200);const before=f.snapshot();
  const replay=await result(await f.create());assert.equal(replay.status,409);assert.equal(replay.body.error.code,'URL_SUBMISSION_DELETED');assert.deepEqual(f.snapshot(),before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
 });}finally{f.close();}
});

for(const orphan of ['operation','source','audio','usage'])test('orphaned '+orphan+' evidence blocks a fresh URL job in the same identity slot',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  const stamp=new Date().toISOString();
  if(orphan==='operation')f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run('synthetic-uncertain',submissionId,'synthetic',1,'FAILED_UNCERTAIN',stamp);
  if(orphan==='source')f.db.prepare('INSERT INTO yta_sources VALUES(?,?,?,?,?)').run(submissionId,'Synthetic retained caption','[]','SYNTHETIC',stamp);
  if(orphan==='audio')f.db.prepare('INSERT INTO yta_audio VALUES(?,?,?,?,?,?)').run(submissionId,0,0,10,'DONE','{"synthetic":true}');
  if(orphan==='usage')f.db.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?)').run('synthetic-retained-usage',submissionId,'owner','synthetic','SYNTHETIC','synthetic',1,'SYNTHETIC',stamp);
  const before=f.snapshot(),response=await result(await f.create());assert.equal(response.status,409);assert.equal(response.body.error.code,'URL_SUBMISSION_UNAVAILABLE');assert.deepEqual(f.snapshot(),before);
 });}finally{f.close();}
});

for(const mode of ['before-write','lost-acknowledgement','unknown-write-metadata'])test('URL '+mode+' fails closed and preserves the stable request identity',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  let injected=false;const DB={...f.DB,prepare(sql){const statement=f.DB.prepare(sql);if(!sql.startsWith('INSERT OR IGNORE INTO jobs'))return statement;return {bind(...args){const bound=statement.bind(...args);return {...bound,async run(){if(injected)return bound.run();injected=true;if(mode==='before-write')throw Error('Synthetic interruption before local commit');const committed=await bound.run();if(mode==='lost-acknowledgement')throw Error('Synthetic lost local acknowledgement');return {...committed,meta:{}};}};}};}};
  const response=await result(await f.create(payload,{...f.env,DB}));assert.equal(response.status,409);assert.equal(response.body.error.code,'URL_SUBMISSION_WRITE_UNCERTAIN');assert.equal(injected,true);
  const readback=await result(await f.call(base));assert.equal(readback.status,mode==='before-write'?404:200);
  const recovered=await result(await f.create());assert.equal(recovered.status,202);assert.equal(recovered.body.job.id,submissionId);assert.equal(recovered.body.reused,mode!=='before-write');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_operations').get().n,0);
 });}finally{f.close();}
});

test('explicit no-caption outcome stops with unchanged backend status and creates no ASR work',async()=>{
 const f=fixture();let calls=0;try{await withFetch(async url=>{calls++;assert.equal(new URL(url).searchParams.get('mode'),'native');return new Response(null,{status:206});},async()=>{
  await f.create();f.grant('supadata');const outcome=await result(await f.call(base+'/native','POST',{}));assert.equal(outcome.status,202);assert.equal(outcome.body.job.status,'NEED_UPLOAD');assert.equal(outcome.body.job.audit.status,'NO_CAPTIONS');assert.equal(outcome.body.job.audit.nativeAcquisition,'NO_CAPTIONS');assert.equal(outcome.body.job.audit.automaticAudioAcquisition,'NOT_CONNECTED');assert.match(outcome.body.job.audit.reason,/ASR 작업을 만들지 않았/);
  const quota=f.db.prepare('SELECT * FROM yta_quota').get();assert.equal(quota.consumed,1);assert.equal(quota.request_count,1);
  assert.equal((await f.call(base+'/native','POST',{})).status,202);assert.equal(calls,1);assert.deepEqual(f.db.prepare('SELECT * FROM yta_quota').get(),quota);
  const listed=(await result(await f.call('/api/jobs'))).body.jobs[0];assert.equal(listed.nativeAcquisitionReady,false);assert.equal(listed.nativePollReady,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_audio').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_sources').get().n,0);assert.deepEqual(f.db.prepare('SELECT DISTINCT provider FROM yta_operations').all().map(row=>row.provider),['supadata']);
 });}finally{f.close();}
});

test('pending native state is explicit and status polling does not create another reservation',async()=>{
 const f=fixture();let calls=0;try{await withFetch(async url=>{calls++;return new URL(url).pathname.endsWith('/synthetic-pending')?Response.json({status:'active'}):Response.json({jobId:'synthetic-pending'});},async()=>{
  await f.create();f.grant('supadata');const response=await result(await f.call(base+'/native','POST',{}));assert.equal(response.status,202);assert.equal(response.body.job.status,'NATIVE_PENDING');assert.equal(response.body.job.audit.nativeAcquisition,'PENDING');assert.equal(response.body.job.audit.automaticAudioAcquisition,'NOT_CONNECTED');
  const listed=(await result(await f.call('/api/jobs'))).body.jobs[0];assert.equal(listed.nativeAcquisitionReady,false);assert.equal(listed.nativePollReady,true);
  const before=f.snapshot();assert.equal((await f.call(base+'/native-poll','POST',{})).status,202);assert.equal(calls,2);assert.deepEqual(f.snapshot(),before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_audio').get().n,0);
 });}finally{f.close();}
});

for(const reportValue of [null,'null'])test('stored caption summary accepts '+(reportValue===null?'SQL NULL':'JSON null')+' without changing source or report guards',async()=>{
 const f=fixture();let calls=0;try{const {source,audit}=await f.storedCaption(reportValue);f.grant('gemini');const originalSource=f.snapshot().yta_sources;
  await withFetch(async(_url,options)=>{calls++;assert.match(JSON.parse(options.body).contents[0].parts[0].text,/approvedSummary/);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(syntheticApprovedReport(source))}]}}]});},async()=>{
   const response=await result(await f.call(base+'/summary','POST',profile));assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.job.report.approvedSummary.formatVersion,profile.formatProfile);assert.equal(response.body.job.status,audit.status);assert.equal(response.body.job.report.approvedSummary.semanticReview,'NOT_PERFORMED');assert.deepEqual(f.snapshot().yta_sources,originalSource);
   const stored=f.snapshot(),repeat=await result(await f.call(base+'/summary','POST',profile));assert.equal(repeat.body.cached,true);assert.equal(calls,1);assert.deepEqual(f.snapshot(),stored);
  });
 }finally{f.close();}
});

test('null-safe summary comparison still blocks a report race before any generation',async()=>{
 const f=fixture();try{await f.storedCaption(null);f.grant('gemini');let injected=false;
  const concurrent=JSON.stringify({kind:'SYNTHETIC_CONCURRENT_REPORT',summary:[]});
  const DB={...f.DB,prepare(sql){const statement=f.DB.prepare(sql);if(!sql.startsWith('SELECT 1 AS ok FROM jobs j JOIN yta_sources'))return statement;return {bind(...args){const bound=statement.bind(...args);return {...bound,async first(){if(!injected){injected=true;f.db.prepare('UPDATE jobs SET report_json=? WHERE id=?').run(concurrent,submissionId);}return bound.first();}};}};}};
  await withFetch(noFetch,async()=>{const response=await result(await f.call(base+'/summary','POST',profile,{...f.env,DB}));assert.equal(response.status,409);assert.equal(response.body.error.code,'SUMMARY_INPUT_CHANGED');assert.equal(injected,true);assert.equal(f.db.prepare('SELECT report_json FROM jobs').get().report_json,concurrent);assert.equal(f.db.prepare('SELECT consumed FROM yta_quota').get().consumed,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,0);});
 }finally{f.close();}
});

test('complete invalid summary remains reviewable without changing DONE receipt or retrying the provider',async()=>{
 const f=fixture();let calls=0;try{await f.storedCaption(null);f.grant('gemini');const text=JSON.stringify({summary:'Synthetic invalid structure'});
  await withFetch(async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]});},async()=>{
   assert.equal((await result(await f.call(base+'/summary','POST',profile))).body.error.code,'REPORT_VALIDATION_FAILED');
   const before=f.snapshot();for(let i=0;i<2;i++){const reviewed=await result(await f.call(base+'/summary-review'));assert.equal(reviewed.status,200);assert.equal(reviewed.body.state,'DONE');assert.equal(reviewed.body.reviewKind,'STORED_COMPLETE_RESPONSE');assert.equal(reviewed.body.partialText,text);assert.equal(reviewed.body.reportValidation,'NOT_ASSERTED');assert.equal(reviewed.body.currentJobHasSavedReport,false);assert.equal(Object.hasOwn(reviewed.body,'reportSaved'),false);assert.equal(reviewed.body.providerCalls,0);}
   assert.deepEqual(f.snapshot(),before);assert.equal((await result(await f.call(base+'/summary','POST',profile))).body.error.code,'REPORT_VALIDATION_FAILED');assert.equal(calls,1);assert.deepEqual(f.snapshot(),before);
   f.db.prepare('UPDATE jobs SET owner_id=? WHERE id=?').run('synthetic-other-owner',submissionId);assert.equal((await f.call(base+'/summary-review')).status,404);
  });
 }finally{f.close();}
});

test('partial summary review retains existing fields and makes no receipt or usage mutation',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  await f.storedCaption(null);f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)').run(submissionId+':summary:synthetic:single',submissionId,'gemini',1,'FAILED_UNCERTAIN',new Date().toISOString(),'SUMMARY_FINISH_UNVERIFIED',JSON.stringify({partialText:'Synthetic partial response',finishReason:'MAX_TOKENS'}));
  const before=f.snapshot(),response=await result(await f.call(base+'/summary-review'));assert.equal(response.status,200);assert.equal(response.body.partialText,'Synthetic partial response');assert.equal(response.body.finishReason,'MAX_TOKENS');assert.equal(response.body.state,'FAILED_UNCERTAIN');assert.equal(response.body.reviewKind,'PARTIAL_PROVIDER_RESPONSE');assert.equal(response.body.providerCalls,0);assert.deepEqual(f.snapshot(),before);
 });}finally{f.close();}
});

test('partial summary review ignores poisoned stored identity and completion metadata',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  await f.storedCaption(null);const id=submissionId+':summary:synthetic:partial';
  const stored={partialText:'Synthetic preserved partial text',provider:'synthetic-forged-paid-provider',finishReason:'MAX_TOKENS',operationId:'synthetic-forged-operation',errorCode:'FORGED_SUCCESS',state:'DONE',responseComplete:true,reportValidation:'PASS',reportSaved:true,currentJobHasSavedReport:true,providerCalls:999,reviewKind:'FORGED_FINAL_REPORT',receipt:{state:'SUCCESS'},approval:{approved:true},externalFactCheck:'VERIFIED'};
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)').run(id,submissionId,'gemini',1,'FAILED_UNCERTAIN',new Date().toISOString(),'SUMMARY_FINISH_UNVERIFIED',JSON.stringify(stored));
  const before=f.snapshot(),response=await result(await f.call(base+'/summary-review'));assert.equal(response.status,200);
  assert.deepEqual(response.body,{operationId:id,errorCode:'SUMMARY_FINISH_UNVERIFIED',provider:'gemini',partialText:stored.partialText,finishReason:'MAX_TOKENS',state:'FAILED_UNCERTAIN',reviewKind:'PARTIAL_PROVIDER_RESPONSE',responseComplete:false,reportValidation:'NOT_ASSERTED',providerCalls:0});assert.deepEqual(f.snapshot(),before);
  f.db.prepare('UPDATE jobs SET owner_id=? WHERE id=?').run('synthetic-other-owner',submissionId);const wrongOwner=f.snapshot();const denied=await result(await f.call(base+'/summary-review'));assert.equal(denied.status,404);assert.equal(JSON.stringify(denied.body).includes(stored.partialText),false);assert.deepEqual(f.snapshot(),wrongOwner);
  f.db.prepare('UPDATE jobs SET owner_id=? WHERE id=?').run('owner',submissionId);f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run(submissionId+':deleting',submissionId,'deletion',0,'DELETING',new Date().toISOString());const deleted=f.snapshot(),afterDelete=await result(await f.call(base+'/summary-review'));assert.equal(afterDelete.status,404);assert.equal(JSON.stringify(afterDelete.body).includes(stored.partialText),false);assert.deepEqual(f.snapshot(),deleted);
 });}finally{f.close();}
});

test('complete response review identifies the current report without claiming response-to-report lineage',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  await f.storedCaption(JSON.stringify({kind:'GEMINI_EVIDENCE_LINKED',summary:[{text:'A separately stored synthetic report',evidenceIds:[1]}]}));
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)').run(submissionId+':summary:synthetic:complete',submissionId,'gemini',1,'DONE',new Date().toISOString(),null,JSON.stringify({text:'An unrelated synthetic intermediate response',operationId:'forged',state:'FAILED_UNCERTAIN',reportSaved:true,currentJobHasSavedReport:false,receipt:{state:'SUCCESS'},responseComplete:false,reportValidation:'PASS'}));
  const before=f.snapshot(),response=await result(await f.call(base+'/summary-review'));assert.equal(response.status,200);assert.equal(response.body.currentJobHasSavedReport,true);assert.equal(Object.hasOwn(response.body,'reportSaved'),false);assert.equal(Object.hasOwn(response.body,'receipt'),false);assert.equal(response.body.operationId,submissionId+':summary:synthetic:complete');assert.equal(response.body.state,'DONE');assert.equal(response.body.responseComplete,true);assert.equal(response.body.reportValidation,'NOT_ASSERTED');assert.deepEqual(f.snapshot(),before);
 });}finally{f.close();}
});

for(const state of ['FAILED_UNCERTAIN','DONE'])for(const mutation of ['owner','deletion'])test('summary review '+state+' read rejects a concurrent '+mutation+' change in the data query',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  await f.storedCaption(null);const text='Synthetic race-protected private output',stored=state==='DONE'?{text}:{partialText:text,finishReason:'MAX_TOKENS'};
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(submissionId+':summary:synthetic:race',submissionId,'gemini',1,state,new Date().toISOString(),JSON.stringify(stored));
  let injected=false,afterMutation;
  function inject(){if(injected)return;injected=true;if(mutation==='owner')f.db.prepare('UPDATE jobs SET owner_id=? WHERE id=?').run('synthetic-other-owner',submissionId);else f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run(submissionId+':deleting',submissionId,'deletion',0,'DELETING',new Date().toISOString());afterMutation=f.snapshot();}
  const DB={...f.DB,prepare(sql){const statement=f.DB.prepare(sql);if(!sql.startsWith('SELECT id,error_code,result_json FROM yta_operations')||!sql.includes("state='"+state+"'"))return statement;return {bind(...args){const bound=statement.bind(...args);return {...bound,async all(){inject();return bound.all();},async first(){inject();return bound.first();}};}};}};
  const response=await result(await f.call(base+'/summary-review','GET',undefined,{...f.env,DB}));assert.equal(injected,true);assert.notEqual(response.status,200);assert.equal(JSON.stringify(response.body).includes(text),false);assert.deepEqual(f.snapshot(),afterMutation);
 });}finally{f.close();}
});

test('uncertain native request readback stays neutral and preserves its reservation without retrying',async()=>{
 const f=fixture();let calls=0;try{await withFetch(async()=>{calls++;throw Error('Synthetic uncertain native response');},async()=>{
  await f.create();f.grant('supadata');const beforeJob=f.snapshot().jobs;
  const failed=await result(await f.call(base+'/native','POST',{}));assert.equal(failed.status,500);assert.equal(failed.body.error.code,'LIVE_INTERNAL_ERROR');assert.equal(calls,1);
  const preserved=f.snapshot();assert.deepEqual(preserved.jobs,beforeJob);assert.equal(preserved.yta_operations[0].state,'FAILED_UNCERTAIN');assert.equal(preserved.yta_quota[0].consumed,1);assert.equal(preserved.yta_quota[0].request_count,1);assert.equal(preserved.yta_sources.length,0);assert.equal(preserved.yta_audio.length,0);
  for(const response of [await result(await f.call(base)),await result(await f.create())]){assert.equal(response.body.job.audit.status,'CAPTION_RESULT_UNAVAILABLE');assert.equal(response.body.job.audit.nativeAcquisition,'NO_STORED_RESULT');assert.match(response.body.job.audit.reason,/이전 요청 상태/);assert.doesNotMatch(response.body.job.audit.reason,/아직 요청하지|요청 전/);}
  // This is a discovery/review hint only. It never authorizes dispatch over the
  // durable uncertain operation retained by /native.
  assert.equal((await result(await f.call('/api/jobs'))).body.jobs[0].nativeAcquisitionReady,true);
  const repeated=await result(await f.call(base+'/native','POST',{}));assert.equal(repeated.status,409);assert.equal(repeated.body.error.code,'OPERATION_REVIEW_REQUIRED');assert.equal(calls,1);assert.deepEqual(f.snapshot(),preserved);
 });}finally{f.close();}
});
