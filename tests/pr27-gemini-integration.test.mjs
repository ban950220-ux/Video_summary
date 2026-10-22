import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {geminiSourceAssessment} from '../src/gemini-source-assessment.mjs';

const request=(path,body)=>new Request('https://test.invalid'+path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
const sql=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(s=>s.trim()).filter(Boolean);

test('PR27 native report and accepted Gemini source snapshot coexist across migration, GET, list and TXT',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'pr27-gemini-integration',modules:true,script:'export default {fetch(){return new Response("local fixture")}}',d1Databases:{DB:'pr27-gemini-local'}}]}));
 try{
  const DB=await mf.getD1Database('DB');
  for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0015_gemini_two_pass.sql'])for(const statement of sql(file))await DB.prepare(statement).run();
  const env={DB},stamp=new Date().toISOString(),ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
  const segments=[{id:1,startMs:0,endMs:2000,text:'Synthetic source only'}],raw=segments[0].text,segments_json=JSON.stringify(segments);
  const mediaCoverage={provenance:'SUPADATA_NATIVE',transcriptStatus:'PARTIAL_TRANSCRIPT',firstMs:0,lastMs:2000,expectedDurationMs:10000,timelineRatio:.2,gaps:[],audioAccuracy:'NOT_INDEPENDENTLY_VERIFIED',coverageMeaning:'STORED_TRANSCRIPT_SEGMENTS_ONLY'};
  const nativeAudit={status:'PARTIAL_TRANSCRIPT',timelineRatio:.2,providerCompleteness:'NOT_INDEPENDENTLY_VERIFIED',sourceScope:mediaCoverage};
  // Synthetic saved reports isolate the shared serializers; real acceptance and
  // global synthesis transitions are exercised by their Workerd fixture suites.
  const base={summary:[{text:'Synthetic summary only',evidenceIds:[1]}],chapters:[],claims:[],numbers:[],critical:[],conclusion:'Synthetic fixture, not a real model result',sourceCoverage:{segmentCount:1,missingSegmentIds:[]}};
  const nativeReport={...base,compositionMode:'groq-full-coverage-global-v1',mediaCoverage,reportSha256:'a'.repeat(64),sectionReports:{sourceMode:'FRESH_IMPORTED_TRANSCRIPT',appendix:[]}};
  const geminiAudit={status:'PARTIAL_TRANSCRIPT',timelineRatio:.2,audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'b'.repeat(64)};
  const sourceAssessment=await geminiSourceAssessment({source_type:'audio',duration_seconds:10,audit:geminiAudit,audit_json:JSON.stringify(geminiAudit)},{raw,segments,segments_json,provenance:'GROQ_OWNED_AUDIO'});
  const geminiReport={...base,kind:'GEMINI_TWO_PASS_EVIDENCE_LINKED',compositionMode:'gemini-two-pass-v1',summaryCompletion:'COMPLETE',outputKind:'STORED_TRANSCRIPT_SUMMARY',sourceAssessment,audioAccuracy:'NOT_VERIFIED',meaningReview:{status:'AUTO_CHECK_PASSED_HUMAN_UNREVIEWED'}};
  for(const [index,audit,report,sourceType,provenance] of [[0,nativeAudit,nativeReport,'url','SUPADATA_NATIVE'],[1,geminiAudit,geminiReport,'audio','GROQ_OWNED_AUDIO']]){
   await DB.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner',? ,?,'PARTIAL_TRANSCRIPT',10,?,?,?,?)").bind(ids[index],`integration-${index}`,sourceType,stamp,stamp,JSON.stringify(report),JSON.stringify(audit)).run();
   await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(ids[index],raw,segments_json,provenance,stamp).run();
  }
  const before=(await DB.prepare('SELECT id,report_json,audit_json FROM jobs ORDER BY id').all()).results;
  const audio={sourceType:'audio',url:'https://youtu.be/2hUkTmwYm3A',durationSeconds:10,submissionId:'33333333-3333-4333-8333-333333333333',ownedAudioSha256:'c'.repeat(64)};
  const missingMigration=await routeApi(request('/api/jobs',audio),env);assert.equal(missingMigration.status,409,'0017 is required for URL-owned-audio creation');assert.equal((await missingMigration.json()).error.code,'LIVE_SCHEMA_REQUIRED');
  for(const statement of sql('../migrations/0017_audio_submission_idempotency.sql'))await DB.prepare(statement).run();
  assert.deepEqual((await DB.prepare('SELECT id,report_json,audit_json FROM jobs ORDER BY id').all()).results,before);
  const native=(await(await routeApi(request('/api/jobs/'+ids[0]),env)).json()).job;
  const gemini=(await(await routeApi(request('/api/jobs/'+ids[1]),env)).json()).job;
  assert.deepEqual(native.report,nativeReport);assert.equal(native.report.sourceAssessment,undefined);
  assert.equal(gemini.status,'PARTIAL_TRANSCRIPT');assert.equal(gemini.report.sourceBinding,'CURRENT');assert.equal(gemini.report.summaryCompletion,'COMPLETE');assert.equal(gemini.report.mediaCoverage,undefined);
  const listed=await(await routeApi(request('/api/jobs'),env)).json();
  assert.equal(listed.jobs.find(j=>j.id===ids[0]).nativeTranscriptSummaryReady,true);assert.equal(listed.jobs.find(j=>j.id===ids[0]).audit,undefined);
  assert.equal(listed.jobs.find(j=>j.id===ids[1]).sourceStatus,'PARTIAL_TRANSCRIPT');
  const nativeTxt=await(await routeApi(request('/api/jobs/'+ids[0]+'/export?format=txt'),env)).text();
  assert.match(nativeTxt,/SUPADATA_NATIVE/);assert.match(nativeTxt,/PARTIAL_TRANSCRIPT/);assert.match(nativeTxt,/NOT independently verified/);
  const geminiTxt=await(await routeApi(request('/api/jobs/'+ids[1]+'/export?format=txt'),env)).text();
  assert.match(geminiTxt,/GROQ_OWNED_AUDIO/);assert.match(geminiTxt,/PARTIAL_TRANSCRIPT/);assert.match(geminiTxt,/STORED_TRANSCRIPT_SUMMARY/);assert.doesNotMatch(geminiTxt,/SOURCE_BASED_FULL_SUMMARY/);
  await DB.prepare("UPDATE yta_sources SET provenance='GEMINI_OWNED_AUDIO' WHERE job_id=?").bind(ids[1]).run();
  assert.equal((await(await routeApi(request('/api/jobs/'+ids[1]),env)).json()).job.report.sourceBinding,'STALE_SOURCE');
  assert.deepEqual((await(await routeApi(request('/api/jobs/'+ids[0]),env)).json()).job.report,nativeReport);
  for(const invalid of ['{broken','{}','[null]']){
   await DB.prepare('UPDATE yta_sources SET segments_json=? WHERE job_id=?').bind(invalid,ids[1]).run();
   const invalidGet=await routeApi(request('/api/jobs/'+ids[1]),env);assert.equal(invalidGet.status,200);assert.equal((await invalidGet.json()).job.report.sourceBinding,'STALE_SOURCE');
   for(const suffix of ['/gemini-two-pass-status','/export?format=txt']){const invalidRead=await routeApi(request('/api/jobs/'+ids[1]+suffix),env);assert.equal(invalidRead.status,409);assert.equal((await invalidRead.json()).error.code,'SOURCE_STORAGE_INVALID');}
   assert.equal((await DB.prepare('SELECT report_json FROM jobs WHERE id=?').bind(ids[1]).first()).report_json,JSON.stringify(geminiReport));
  }
  await DB.prepare('UPDATE yta_sources SET segments_json=? WHERE job_id=?').bind(segments_json,ids[1]).run();
  assert.equal((await routeApi(request('/api/jobs',{sourceType:'audio',url:audio.url,durationSeconds:10}),env)).status,400);
  const created=await Promise.all([routeApi(request('/api/jobs',audio),env),routeApi(request('/api/jobs',audio),env)]);
  const bodies=await Promise.all(created.map(r=>r.json()));assert.ok(created.every(r=>r.status===202),JSON.stringify(bodies));assert.equal(bodies[0].job.id,bodies[1].job.id);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM jobs WHERE submission_hash IS NOT NULL').first()).n,1);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM usage_events').first()).n,0);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM yta_operations').first()).n,0);
 }finally{await mf.dispose();}
});

test('native caption summary action works from list metadata without exposing the full audit',()=>{
 const node=tag=>({tag,children:[],dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}});
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__card=libraryCard;');
 const context={document:{createElement:node,querySelector:()=>null,hidden:false},window:{},location:{hash:''},setTimeout,clearTimeout};runInNewContext(source,context);
 const job={id:'fixture',title:'Native fixture',source_type:'url',status:'PARTIAL_TRANSCRIPT',duration_seconds:10,summary:[],nativeTranscriptSummaryReady:true};
 const texts=element=>[element.textContent??'',...(element.children??[]).flatMap(child=>typeof child==='object'?texts(child):[])];
 assert.ok(texts(context.__card(job)).some(text=>text.includes('전사로 별도 전체 AI 요약 작업')));
 assert.ok(!texts(context.__card({...job,nativeTranscriptSummaryReady:false})).some(text=>text.includes('전사로 별도 전체 AI 요약 작업')));
});
