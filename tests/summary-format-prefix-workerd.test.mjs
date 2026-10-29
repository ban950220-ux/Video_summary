import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {APPROVED_FORMAT_PROFILE,summaryFingerprint} from '../src/summary-plan.mjs';

// Synthetic records only. No provider grant or external request is permitted.
const segments=[{id:1,startMs:0,endMs:1000,text:'Synthetic prefix regression.'}];
const audit={status:'TRANSCRIPT_UNVERIFIED'};
const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);

test('Workerd D1 compares long summary contract prefixes without LIKE limits',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'summary-prefix',modules:true,script:'export default {fetch(){return new Response("synthetic fixture")}}',d1Databases:{DB:'summary-prefix'}}]}));
 const originalFetch=globalThis.fetch;let calls=0;
 try{
  const DB=await mf.getD1Database('DB');
  for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/0003_observed_capacity.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false'};
  globalThis.fetch=async()=>{calls++;throw Error('No provider request is authorized in this fixture');};
  const scenarios=[
   {requested:'legacy',stored:'approved',code:'SUMMARY_FORMAT_CHANGE_REQUIRES_NEW_ATTEMPT'},
   {requested:'approved',stored:'legacy',code:'SUMMARY_FORMAT_CHANGE_REQUIRES_NEW_ATTEMPT'},
   {requested:'approved',stored:'different-approved',code:'SUMMARY_FORMAT_CHANGE_REQUIRES_NEW_ATTEMPT'},
   {requested:'approved',stored:'approved',code:'QUOTA_UNVERIFIED'},
   {requested:'legacy',stored:'legacy',code:'QUOTA_UNVERIFIED'},
   {requested:'approved',stored:'unrelated',code:'QUOTA_UNVERIFIED'},
  ];
  for(const scenario of scenarios){
   const id=crypto.randomUUID(),stamp=new Date().toISOString();
   const legacy=id+':summary:'+await summaryFingerprint(segments,audit)+':';
   const approved=id+':summary:'+APPROVED_FORMAT_PROFILE+':'+await summaryFingerprint(segments,audit,{formatProfile:APPROVED_FORMAT_PROFILE})+':';
   assert.ok(approved.length>50);
   const prefix=scenario.stored==='legacy'?legacy:scenario.stored==='approved'?approved:scenario.stored==='different-approved'?id+':summary:'+APPROVED_FORMAT_PROFILE+':'+'0'.repeat(64)+':':id+':unrelated:';
   await DB.prepare("INSERT INTO jobs(id,owner_id,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','text','TRANSCRIPT_UNVERIFIED',1,?,?,'null',?)").bind(id,stamp,stamp,JSON.stringify(audit)).run();
   await DB.prepare("INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,'SYNTHETIC_TEST_SOURCE',?)").bind(id,segments[0].text,JSON.stringify(segments),stamp).run();
   await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,error_code,created_at) VALUES(?,?,'gemini',0,'BLOCKED','QUOTA_EXHAUSTED',?)").bind(prefix+'single',id,stamp).run();
   const before=await DB.prepare('SELECT * FROM yta_operations WHERE job_id=?').bind(id).all();
   const response=await routeApi(new Request('https://synthetic.invalid/api/jobs/'+id+'/summary',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(scenario.requested==='approved'?{formatProfile:APPROVED_FORMAT_PROFILE}:{})}),env);
   const body=await response.json();
   assert.equal(response.status,409,JSON.stringify({scenario,body}));
   assert.equal(body.error.code,scenario.code,JSON.stringify({scenario,body}));
   assert.deepEqual((await DB.prepare('SELECT * FROM yta_operations WHERE job_id=?').bind(id).all()).results,before.results);
   assert.equal((await DB.prepare('SELECT report_json FROM jobs WHERE id=?').bind(id).first()).report_json,'null');
  }
  assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch;await mf.dispose();}
});
