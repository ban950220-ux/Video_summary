import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {routeApi} from '../src/worker.mjs';
import {reportPrompt} from '../src/report.mjs';
import {APPROVED_FORMAT_PROFILE,LEGACY_FORMAT_PROFILE,summaryFormatOptions,summaryFingerprint,partitionTranscript,partitionSynthesis,synthesisPrompt,summaryUnits,evidenceIds,SUMMARY_PROMPT_LIMIT} from '../src/summary-plan.mjs';

// Entirely invented data and identities. There is no real video, account,
// credential, transcript, usage history, or provider receipt in this fixture.
const profile={formatProfile:APPROVED_FORMAT_PROFILE};
const absent='자료에서 확인되지 않음';
const sourceText='합성 자료에서는 관측값만 설명한다.';
const syntheticSegments=(count=4,padding=0)=>Array.from({length:count},(_,i)=>({id:i+1,startMs:i*1000,endMs:(i+1)*1000,text:sourceText+' 가'.repeat(padding)}));
const request=(path,method='GET',body)=>new Request('https://synthetic.invalid'+path,{method,headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function formatReport(groups){
 const sets=groups.map(group=>[group[0].id,...(group.length>1?[group.at(-1).id]:[])]);
 const cited=[...new Set(sets.flat())];
 const sourceQuotes=ids=>ids.map(id=>({id,quote:sourceText}));
 const legacy={summary:[{text:'합성 자료에서 관측값을 설명했다.',evidenceIds:[cited[0]]}],chapters:sets.map(ids=>({text:'관측값을 설명한 구간이다.',evidenceIds:ids})),claims:[],numbers:[],critical:[],conclusion:'관측값의 원인은 자료에서 확인되지 않음'};
 const outline=sets.map((ids,index)=>({id:'c'+(index+1),title:'관측 구간',oneLineSummary:'합성 자료에서 관측값을 설명했다.',evidenceIds:ids,sourceQuotes:sourceQuotes(ids)}));
 const missing=status=>[{chapterIds:outline.map(item=>item.id),status,text:absent,evidenceIds:[],sourceQuotes:[]}];
 return {...legacy,approvedSummary:{formatVersion:APPROVED_FORMAT_PROFILE,keyConclusion:{status:'SOURCE_STATED',text:'합성 자료에서 관측값을 설명했다.',evidenceIds:[cited[0]],sourceQuotes:sourceQuotes([cited[0]])},outline,causalDetails:missing('NOT_ESTABLISHED'),assumptions:missing('NOT_FOUND'),counterexamples:missing('NOT_FOUND')}};
}

function fixture({segments=syntheticSegments(),path=':memory:',partial=false}={}){
 let db=new DatabaseSync(path);
 for(const name of ['schema.sql','migrations/0002_live.sql','migrations/0003_observed_capacity.sql'])db.exec(readFileSync(new URL('../'+name,import.meta.url),'utf8'));
 const id='00000000-0000-4000-8000-000000000001',base='/api/jobs/'+id;
 const audit={status:partial?'PARTIAL_TRANSCRIPT':'TRANSCRIPT_UNVERIFIED',timelineRatio:partial?0.1:1,independentVerification:false};
 const original={kind:'EXTRACTIVE_ONLY_NOT_AI',summary:[sourceText],warning:'Synthetic extraction only.'};
 const now=Date.now(),stamp=new Date(now).toISOString();
 db.prepare('INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'owner','Synthetic format test','text',audit.status,partial?segments.length*10:segments.length,stamp,stamp,JSON.stringify(original),JSON.stringify(audit));
 db.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').run(id,segments.map(item=>item.text).join('\n'),JSON.stringify(segments),'SYNTHETIC_TEST_SOURCE',stamp);
 const key='SYNTHETIC_ONLY_NO_ACCOUNT';
 const remaining={requestsMinute:1000,tokensMinute:1000000000,requestsDay:1000};
 db.prepare('INSERT INTO yta_capacity(provider,model,source,observed_at,valid_until,reset_json,remaining_json,reserved_json,billing_disabled) VALUES(?,?,?,?,?,?,?,?,1)').run('gemini','gemini-2.5-flash','AI_STUDIO_LIVE:'+createHash('sha256').update('gemini:'+key).digest('hex'),now,now+600000,JSON.stringify(Object.fromEntries(Object.keys(remaining).map(name=>[name,now+3600000]))),JSON.stringify(remaining),JSON.stringify(Object.fromEntries(Object.keys(remaining).map(name=>[name,0]))));
 const DB={prepare(sql){const make=args=>({sql,args,bind(...values){return make(values);},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}});return make([]);},async batch(statements){db.exec('BEGIN');try{const results=statements.map(item=>({meta:{changes:Number(db.prepare(item.sql).run(...item.args).changes)}}));db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',GEMINI_API_KEY:key};
 return {get db(){return db;},env,id,base,segments,audit,original,sourceSnapshot:()=>db.prepare('SELECT raw,segments_json,provenance FROM yta_sources WHERE job_id=?').get(id),jobSnapshot:()=>db.prepare('SELECT report_json,audit_json,status FROM jobs WHERE id=?').get(id),grant(){const now=Date.now();db.prepare('INSERT INTO yta_quota(provider,allowance,consumed,request_limit,request_count,expires_at,confirmed_at,billing_disabled) VALUES(?,250000,0,100,0,?,?,1) ON CONFLICT(provider) DO UPDATE SET consumed=0,request_count=0,expires_at=excluded.expires_at,confirmed_at=excluded.confirmed_at').run('gemini',now+3600000,now);},reopen(){if(path===':memory:')throw Error('TEMP_FILE_REQUIRED');db.close();db=new DatabaseSync(path);},close(){db.close();}};
}

async function withFetch(mock,run){const original=globalThis.fetch;globalThis.fetch=mock;try{return await run();}finally{globalThis.fetch=original;}}
const response=report=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}]});
const noFetch=async()=>{throw Error('UNEXPECTED_SYNTHETIC_DISPATCH');};

test('format selection is explicit and legacy fingerprint bytes stay compatible',async()=>{
 const segments=syntheticSegments(),audit={status:'PARTIAL_TRANSCRIPT'};
 assert.deepEqual(summaryFormatOptions(undefined),{});assert.deepEqual(summaryFormatOptions(null),{});assert.deepEqual(summaryFormatOptions(LEGACY_FORMAT_PROFILE),{});
 assert.deepEqual(summaryFormatOptions(APPROVED_FORMAT_PROFILE),profile);
 for(const value of ['',true,{},'future-unknown'])assert.throws(()=>summaryFormatOptions(value));
 const legacy=await summaryFingerprint(segments,audit),current=await summaryFingerprint(segments,audit,profile);
 assert.equal(legacy,digest([segments,audit]));assert.notEqual(current,legacy);
 assert.notEqual(await summaryFingerprint(segments,{...audit,reason:'synthetic changed audit'},profile),current);
 assert.notEqual(await summaryFingerprint([{...segments[0],text:'다른 합성 자료'},...segments.slice(1)],audit,profile),current);
});

test('format prompts and partitions include the same contract without raising request limits',()=>{
 const segments=syntheticSegments(220,180),audit={status:'PARTIAL_TRANSCRIPT'};
 const groups=partitionTranscript(segments,audit,profile);
 assert.ok(groups.length>1);assert.deepEqual(groups.flat(),segments);assert.equal(SUMMARY_PROMPT_LIMIT,50000);
 for(const group of groups){const prompt=reportPrompt(group,audit,profile);assert.match(prompt,/approvedSummary/);assert.ok(prompt.length<=SUMMARY_PROMPT_LIMIT);assert.ok(summaryUnits(prompt)<=250000);}
 const parts=groups.map(group=>({ids:group.map(item=>item.id),report:formatReport([group])}));
 for(const batch of partitionSynthesis(parts,audit,profile)){const prompt=synthesisPrompt(batch,audit,profile);assert.match(prompt,/approvedSummary/);assert.match(prompt,/인과관계나 반례/);assert.ok(prompt.length<=SUMMARY_PROMPT_LIMIT);}
 assert.doesNotMatch(reportPrompt(segments.slice(0,1),audit),/approvedSummary/);
 assert.doesNotMatch(synthesisPrompt(parts.slice(0,1),audit),/앞 단계 approvedSummary/);
});

test('additional format evidence is retained without changing legacy reference collection',()=>{
 const report=formatReport([syntheticSegments()]);
 report.summary[0].evidenceIds=[1];report.chapters[0].evidenceIds=[1];
 assert.ok(evidenceIds(report).includes(4));
 delete report.approvedSummary;assert.deepEqual(evidenceIds(report),[1]);
});

test('readonly plan prices exactly the selected prompt and rejects unknown profiles without writes',async()=>{
 const f=fixture({segments:syntheticSegments(160,180)});try{await withFetch(noFetch,async()=>{
  const before=f.jobSnapshot(),source=f.sourceSnapshot();
  const selected=await routeApi(request(f.base+'/summary-plan?formatProfile='+APPROVED_FORMAT_PROFILE),f.env);assert.equal(selected.status,200);
  const plan=await selected.json(),groups=partitionTranscript(f.segments,f.audit,profile);
  assert.equal(plan.formatProfile,APPROVED_FORMAT_PROFILE);assert.equal(plan.stages,groups.length);assert.equal(plan.firstPassUnits,groups.reduce((sum,group)=>sum+summaryUnits(reportPrompt(group,f.audit,profile)),0));
  assert.equal((await routeApi(request(f.base+'/summary-plan?formatProfile=unknown'),f.env)).status,400);
  assert.equal((await(await routeApi(request(f.base+'/summary-plan'),f.env)).json()).formatProfile,LEGACY_FORMAT_PROFILE);
  assert.deepEqual(f.jobSnapshot(),before);assert.deepEqual(f.sourceSnapshot(),source);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_operations').get().n,0);
 });}finally{f.close();}
});

test('approved format uses one mocked generation, persists in local SQLite, and reopens after connection restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'approved-format-generation-')),f=fixture({path:join(dir,'synthetic.sqlite'),partial:true});let calls=0;
 try{await withFetch(async(_url,options)=>{calls++;const body=JSON.parse(options.body);assert.match(body.contents[0].parts[0].text,/approvedSummary/);assert.equal(body.generationConfig.maxOutputTokens,8192);return response(formatReport([f.segments]));},async()=>{
  f.grant();const source=f.sourceSnapshot();
  const created=await routeApi(request(f.base+'/summary','POST',profile),f.env);assert.equal(created.status,200,JSON.stringify(await created.clone().json()));
  const result=await created.json();assert.equal(result.job.report.approvedSummary.formatVersion,APPROVED_FORMAT_PROFILE);assert.equal(result.job.status,'PARTIAL_TRANSCRIPT');assert.ok(result.job.approvedSummaryView);
  assert.equal(calls,1);const stored=f.jobSnapshot();assert.deepEqual(f.sourceSnapshot(),source);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,1);
  assert.match(f.db.prepare('SELECT id FROM yta_operations').get().id,new RegExp(':summary:'+APPROVED_FORMAT_PROFILE+':'));
  f.reopen();const list=await routeApi(request('/api/jobs'),f.env);assert.equal(list.status,200);
  const listed=(await list.json()).jobs.find(item=>item.id===f.id);assert.ok(listed);assert.deepEqual(listed.summary,result.job.report.summary);
  const readback=await routeApi(request(f.base),f.env);assert.equal(readback.status,200);const reopened=await readback.json();
  assert.deepEqual(reopened.job.report,result.job.report);assert.ok(reopened.job.approvedSummaryView);assert.deepEqual(f.jobSnapshot(),stored);assert.deepEqual(f.sourceSnapshot(),source);
  const exported=await routeApi(request(f.base+'/export?format=txt'),f.env);assert.equal(exported.status,200);const text=await exported.text();
  assert.match(text,/핵심 결론/);assert.match(text,/인과관계/);assert.match(text,/자료에서 확인되지 않음/);assert.match(text,/원본 스크립트/);
  const markdown=await routeApi(request(f.base+'/export?format=md'),f.env);assert.equal(await markdown.text(),text);
  const repeat=await(await routeApi(request(f.base+'/summary','POST',profile),f.env)).json();assert.equal(repeat.cached,true);assert.equal(repeat.formatMismatch,false);assert.equal(calls,1);assert.deepEqual(f.jobSnapshot(),stored);
 });}finally{f.close();rmSync(dir,{recursive:true,force:true});}
});

test('owner detail projection cannot expose another owner source or report',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  const before=f.jobSnapshot(),source=f.sourceSnapshot();f.db.prepare('UPDATE jobs SET owner_id=? WHERE id=?').run('synthetic-other-owner',f.id);
  assert.equal((await routeApi(request(f.base),f.env)).status,404);
  assert.equal((await routeApi(request(f.base+'/export?format=txt'),f.env)).status,404);
  assert.equal((await(await routeApi(request('/api/jobs'),f.env)).json()).jobs.length,0);
  assert.deepEqual(f.jobSnapshot(),before);assert.deepEqual(f.sourceSnapshot(),source);
 });}finally{f.close();}
});

test('missing format payload is rejected without overwriting or automatically repeating generation',async()=>{
 const f=fixture();let calls=0;try{await withFetch(async()=>{calls++;const report=formatReport([f.segments]);delete report.approvedSummary;return response(report);},async()=>{
  f.grant();const before=f.jobSnapshot(),source=f.sourceSnapshot();
  for(let repeat=0;repeat<2;repeat++){const result=await routeApi(request(f.base+'/summary','POST',profile),f.env);assert.equal(result.status,409);assert.equal((await result.json()).error.code,'REPORT_VALIDATION_FAILED');}
  assert.equal(calls,1);assert.deepEqual(f.jobSnapshot(),before);assert.deepEqual(f.sourceSnapshot(),source);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,1);
  assert.equal(f.db.prepare('SELECT state FROM yta_operations').get().state,'DONE');
 });}finally{f.close();}
});

test('invalid source quote is rejected and preserves the raw synthetic response for review',async()=>{
 const f=fixture();let calls=0;try{await withFetch(async()=>{calls++;const report=formatReport([f.segments]);report.approvedSummary.keyConclusion.sourceQuotes[0].quote='자료에는 없는 합성 인용';return response(report);},async()=>{
  f.grant();const before=f.jobSnapshot();const result=await routeApi(request(f.base+'/summary','POST',profile),f.env);assert.equal((await result.json()).error.code,'REPORT_VALIDATION_FAILED');
  assert.equal(calls,1);assert.deepEqual(f.jobSnapshot(),before);assert.ok(f.db.prepare('SELECT result_json FROM yta_operations').get().result_json);
 });}finally{f.close();}
});

test('unknown format and nonobject bodies are rejected before quota or generation',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{for(const payload of [{formatProfile:'unknown'},[],null,1])assert.equal((await routeApi(request(f.base+'/summary','POST',payload),f.env)).status,400);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_operations').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_quota').get().n,0);});}finally{f.close();}
});

test('requesting the new format never relabels or regenerates a saved legacy report',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  const legacy=formatReport([f.segments]);delete legacy.approvedSummary;legacy.kind='GEMINI_EVIDENCE_LINKED';
  f.db.prepare('UPDATE jobs SET report_json=? WHERE id=?').run(JSON.stringify(legacy),f.id);const before=f.jobSnapshot();
  const response=await routeApi(request(f.base+'/summary','POST',profile),f.env);assert.equal(response.status,200);const saved=await response.json();
  assert.equal(saved.cached,true);assert.equal(saved.formatMismatch,true);assert.equal(saved.requestedFormatProfile,APPROVED_FORMAT_PROFILE);assert.equal(saved.storedFormatProfile,LEGACY_FORMAT_PROFILE);assert.deepEqual(saved.job.report,legacy);assert.deepEqual(f.jobSnapshot(),before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_operations').get().n,0);
 });}finally{f.close();}
});

for(const state of ['DONE','CLAIMED','FAILED_UNCERTAIN','BLOCKED'])test('new format cannot reuse a legacy '+state+' checkpoint or silently duplicate its work',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  const id=f.id+':summary:'+await summaryFingerprint(f.segments,f.audit)+':raw:0';
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(id,f.id,'gemini',123,state,new Date(Date.now()-60000).toISOString(),JSON.stringify({syntheticPreservationMarker:true}));
  const before=f.db.prepare('SELECT * FROM yta_operations').get(),job=f.jobSnapshot(),source=f.sourceSnapshot();
  const result=await routeApi(request(f.base+'/summary','POST',profile),f.env);assert.equal(result.status,409);assert.equal((await result.json()).error.code,'SUMMARY_FORMAT_CHANGE_REQUIRES_NEW_ATTEMPT');
  assert.deepEqual(f.db.prepare('SELECT * FROM yta_operations').get(),before);assert.deepEqual(f.jobSnapshot(),job);assert.deepEqual(f.sourceSnapshot(),source);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_quota').get().n,0);
 });}finally{f.close();}
});

test('legacy requests cannot start alongside an approved-format checkpoint',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run(f.id+':summary:'+APPROVED_FORMAT_PROFILE+':'+await summaryFingerprint(f.segments,f.audit,profile)+':raw:0',f.id,'gemini',123,'DONE',new Date(Date.now()-60000).toISOString());
  const result=await routeApi(request(f.base+'/summary','POST',{}),f.env);assert.equal((await result.json()).error.code,'SUMMARY_FORMAT_CHANGE_REQUIRES_NEW_ATTEMPT');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_operations').get().n,1);
 });}finally{f.close();}
});

test('changed source or contract cannot silently reuse an earlier approved-format fingerprint',async()=>{
 const f=fixture();try{await withFetch(noFetch,async()=>{
  f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at) VALUES(?,?,?,?,?,?)').run(f.id+':summary:'+APPROVED_FORMAT_PROFILE+':'+'a'.repeat(64)+':raw:0',f.id,'gemini',123,'DONE',new Date(Date.now()-60000).toISOString());
  const result=await routeApi(request(f.base+'/summary','POST',profile),f.env);assert.equal((await result.json()).error.code,'SUMMARY_FORMAT_CHANGE_REQUIRES_NEW_ATTEMPT');
 });}finally{f.close();}
});

test('a profile conflict appearing after preflight blocks dispatch and preserves both histories',async()=>{
 const f=fixture();let injected=false,calls=0;try{await withFetch(async()=>{calls++;throw Error('DISPATCH_MUST_BE_BLOCKED');},async()=>{
  f.grant();const DB=f.env.DB,legacyId=f.id+':summary:synthetic-older-contract:raw:0';
  f.env.DB={...DB,prepare(sql){if(!injected&&sql.startsWith('SELECT 1 AS ok FROM jobs j JOIN yta_sources')&&sql.includes('id NOT LIKE ?')){injected=true;f.db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,?,?,?,?,?)').run(legacyId,f.id,'gemini',123,'DONE',new Date(Date.now()-60000).toISOString(),'{"synthetic":true}');}return DB.prepare(sql);}};
  const before=f.jobSnapshot(),source=f.sourceSnapshot();const result=await routeApi(request(f.base+'/summary','POST',profile),f.env);
  assert.equal((await result.json()).error.code,'SUMMARY_INPUT_CHANGED');assert.equal(injected,true);assert.equal(calls,0);assert.deepEqual(f.jobSnapshot(),before);assert.deepEqual(f.sourceSnapshot(),source);
  assert.equal(f.db.prepare('SELECT result_json FROM yta_operations WHERE id=?').get(legacyId).result_json,'{"synthetic":true}');
  assert.equal(f.db.prepare("SELECT consumed FROM yta_quota WHERE provider='gemini'").get().consumed,0);
 });}finally{f.close();}
});

test('staged approved summaries retain full source bindings and completed stages across explicit resumptions',async()=>{
 const f=fixture({segments:syntheticSegments(240,190)});let calls=0;const observedCaps=[];
 try{await withFetch(async(_url,options)=>{
  calls++;const body=JSON.parse(options.body),prompt=body.contents[0].parts[0].text;observedCaps.push(body.generationConfig.maxOutputTokens);
  let groups;
  if(prompt.includes('전사 배열 [id,startMs,endMs,text]:\n'))groups=[JSON.parse(prompt.split('전사 배열 [id,startMs,endMs,text]:\n')[1]).map(([id,startMs,endMs,text])=>({id,startMs,endMs,text}))];
  else groups=JSON.parse(prompt.split('시간 순서별 부분 보고서:\n')[1]).map(item=>f.segments.filter(segment=>item.ids.includes(segment.id)));
  return response(formatReport(groups));
 },async()=>{
  const source=f.sourceSnapshot();const plan=await(await routeApi(request(f.base+'/summary-plan?formatProfile='+APPROVED_FORMAT_PROFILE),f.env)).json();assert.ok(plan.stages>1);
  const missingConsent=await routeApi(request(f.base+'/summary','POST',profile),f.env);assert.equal(missingConsent.status,400);assert.equal(calls,0);
  let final=null;
  for(let round=0;round<20;round++){
   f.grant();f.db.prepare("UPDATE yta_operations SET created_at=? WHERE state='DONE'").run(new Date(Date.now()-14000).toISOString());
   const result=await routeApi(request(f.base+'/summary','POST',{...profile,allowStaged:true}),f.env),body=await result.json();
   if(result.status===200){final=body;break;}
   assert.equal(result.status,202,JSON.stringify(body));assert.equal(body.formatProfile,APPROVED_FORMAT_PROFILE);
   const prior=calls;const early=await routeApi(request(f.base+'/summary','POST',{...profile,allowStaged:true}),f.env);assert.equal(early.status,409);assert.equal((await early.json()).error.code,'RATE_LIMIT_PENDING');assert.equal(calls,prior);
  }
  assert.ok(final);assert.equal(final.job.report.approvedSummary.formatVersion,APPROVED_FORMAT_PROFILE);assert.equal(calls,plan.stages+1);assert.ok(observedCaps.includes(2048));assert.equal(observedCaps.at(-1),8192);assert.deepEqual(f.sourceSnapshot(),source);
  const sourceRefs=evidenceIds(final.job.report);assert.ok(sourceRefs.includes(1));assert.ok(sourceRefs.includes(f.segments.at(-1).id));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM yta_operations').get().n,calls);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,calls);
  const repeated=await(await routeApi(request(f.base+'/summary','POST',{...profile,allowStaged:true}),f.env)).json();assert.equal(repeated.cached,true);assert.equal(calls,plan.stages+1);
 });}finally{f.close();}
});
