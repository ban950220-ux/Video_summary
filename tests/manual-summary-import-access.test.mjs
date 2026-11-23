import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync, sign, createHash} from 'node:crypto';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleSiteRequest} from '../src/site-worker.mjs';
import {createImportedSummaryController} from '../web/site/manual-summary-import.mjs';

// Every identity, transcript, summary, credential and ledger in this file is
// invented. The signing key exists in memory only; no authentication is bypassed.
const JOB='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const REQUEST='33333333-3333-4333-8333-333333333333';
const IMPORT='44444444-4444-4444-8444-444444444444';
const SITE='https://manual-import.example.invalid';
const DOMAIN='https://manual-import-fixture.cloudflareaccess.com';
const AUD='synthetic-import-audience';
const EMAIL='owner@example.invalid';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=publicKey.export({format:'jwk'});
const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function token(overrides={}){
 const now=Math.floor(Date.now()/1000);
 const header=encoded({alg:'RS256',kid:'synthetic-import-key'});
 const body=encoded({iss:DOMAIN,aud:[AUD],iat:now-5,exp:now+3600,email:EMAIL,sub:'synthetic-owner',...overrides});
 return header+'.'+body+'.'+sign('RSA-SHA256',Buffer.from(header+'.'+body),privateKey).toString('base64url');
}
const authEnv={ACCESS_TEAM_DOMAIN:DOMAIN,ACCESS_AUD:AUD,ACCESS_OWNER_EMAIL:EMAIL};
const authDependencies={fetcher:async url=>{
 assert.equal(url,DOMAIN+'/cdn-cgi/access/certs');
 return Response.json({keys:[{...jwk,kid:'synthetic-import-key',alg:'RS256'}]});
}};
function request(path,{method='GET',body,auth=token(),origin=SITE}={}){
 const headers={};
 if(auth!==null)headers['cf-access-jwt-assertion']=auth;
 if(method!=='GET'&&method!=='HEAD'&&origin!==null)headers.origin=origin;
 if(body!==undefined)headers['content-type']='application/json';
 return new Request(SITE+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}
const path=(job=JOB,suffix='')=>'/api/jobs/'+job+'/imported-summaries'+suffix;
const requestPath=(suffix='')=>'/api/jobs/'+JOB+'/imported-summary-requests/'+REQUEST+suffix;
function binding(db){
 return {
  prepare(sql){
   const prepared=args=>({sql,args,
    bind(...values){return prepared(values);},
    async first(){return db.prepare(sql).get(...args)||null;},
    async all(){return {success:true,results:db.prepare(sql).all(...args)};},
    async run(){return {success:true,meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}
   });
   return prepared([]);
  },
  async batch(statements){
   db.exec('BEGIN');
   try{
    const results=statements.map(({sql,args})=>({success:true,meta:{changes:Number(db.prepare(sql).run(...args).changes)}}));
    db.exec('COMMIT');return results;
   }catch(error){db.exec('ROLLBACK');throw error;}
  }
 };
}
function initialize(db){
 for(const file of ['../schema.sql','../migrations/0002_live.sql','../migrations/pending/0021_manual_summary_imports.sql'])db.exec(readFileSync(new URL(file,import.meta.url),'utf8'));
 const stamp='2000-01-01T00:00:00.000Z';
 for(const [id,owner] of [[JOB,'owner'],[OTHER,'other-synthetic-owner']]){
  db.prepare('INSERT INTO jobs(id,owner_id,video_id,title,source_url,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(id,owner,'synthetic01','Synthetic garden lesson','https://www.youtube.com/watch?v=synthetic01','text','TRANSCRIPT_UNVERIFIED',2,stamp,stamp,'null','{"status":"TRANSCRIPT_UNVERIFIED","fixture":true}');
  db.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)')
   .run(id,'Synthetic caption about watering a plant.',JSON.stringify([{id:1,startMs:0,endMs:2000,text:'Synthetic caption about watering a plant.'}]),'SYNTHETIC_TEST_TRANSCRIPT',stamp);
 }
 db.prepare('INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,?,?,?,?,?,?)')
  .run('synthetic-uncertain-operation',JOB,'groq',7,'FAILED_UNCERTAIN',stamp,'SYNTHETIC_FAILURE','{"syntheticReceipt":"preserve"}');
 db.prepare('INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run('synthetic-usage',JOB,'owner','groq','SYNTHETIC_TEST','tokens',7,0,null,'SYNTHETIC_TEST',stamp);
}
function preserved(db){
 return JSON.stringify(Object.fromEntries(['jobs','yta_sources','yta_operations','usage_events','provider_credentials','provider_credential_events'].map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()])));
}
function payload(source,bytes){
 const artifactSha256=createHash('sha256').update(bytes).digest('hex');
 return {requestId:REQUEST,sourceSha256:source.sourceSha256,artifactSha256,artifactBase64:bytes.toString('base64'),provenance:'EXISTING_TRANSCRIPT_IMPORTED',basis:{method:'OWNER_SOURCE_RECONCILIATION',sourceSha256:source.sourceSha256,artifactSha256,ownerConfirmed:true}};
}

test('every imported-summary route retains signed owner Access before any database access',async()=>{
 let databaseTouches=0;
 const DB=new Proxy({},{get(){databaseTouches++;throw Error('Authentication must run first');}});
 const routes=[
  [path(),'GET'],[path(JOB,'/source'),'GET'],[path(JOB,'/'+IMPORT),'GET'],
  [path(JOB,'/'+IMPORT+'/export'),'GET'],[requestPath(),'GET'],
  [path(),'POST'],[requestPath('/cancel'),'POST']
 ];
 for(const [route,method] of routes){
  for(const auth of [null,'invalid',token({email:'another-owner@example.invalid'}),token({aud:['wrong-audience']}),token({exp:1})]){
   const response=await handleSiteRequest(request(route,{method,auth,...(method==='POST'?{body:{}}:{})}),{...authEnv,DB},authDependencies);
   assert.equal(response.status,401);
   assert.equal(response.headers.get('cache-control'),'no-store');
  }
 }
 assert.equal(databaseTouches,0);
});

test('owner authentication does not permit missing or foreign-origin import/cancel writes',async()=>{
 let databaseTouches=0;
 const DB=new Proxy({},{get(){databaseTouches++;throw Error('CSRF must run first');}});
 for(const route of [path(),requestPath('/cancel')])for(const origin of [null,'https://foreign.example.invalid']){
  const response=await handleSiteRequest(request(route,{method:'POST',body:{},origin}),{...authEnv,DB},authDependencies);
  assert.equal(response.status,403);
  assert.equal((await response.json()).error.code,'CSRF_BLOCKED');
 }
 assert.equal(databaseTouches,0);
});

test('authenticated UI saves and reopens an imported summary after local DB restart with exact bytes and original records intact',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'manual-summary-access-'));
 const filename=join(folder,'local.sqlite');
 let db=new DatabaseSync(filename);
 const originalFetch=globalThis.fetch;
 let externalCalls=0;
 globalThis.fetch=async()=>{externalCalls++;throw Error('External requests forbidden in local fixture');};
 const call=(route,options)=>handleSiteRequest(request(route,options),{...authEnv,DB:binding(db),ALLOW_PAID_API:'false'},authDependencies);
 try{
  initialize(db);const before=preserved(db);
  const sourceResponse=await call(path(JOB,'/source'));assert.equal(sourceResponse.status,200);
  const source=await sourceResponse.json();assert.match(source.sourceSha256,/^[a-f0-9]{64}$/);
  const bytes=Buffer.from('\ufeff합성 정원 수업 요약\r\n이 문장은 테스트용입니다.\r\n<img src=x onerror=alert(1)>\r\n','utf8');
  const input=payload(source,bytes);
  const saveStatuses=[];
  const api=async(route,options)=>{
   const response=await call(route,options),data=await response.json();
   if(options?.method==='POST')saveStatuses.push(response.status);
   if(!response.ok)throw Object.assign(Error('Synthetic local request failed'),{code:data.error?.code});
   return data;
  };
  const controller=createImportedSummaryController({jobId:JOB,api,randomUUID:()=>REQUEST});
  await controller.load();
  await controller.prepare(new File([bytes],'synthetic-summary.txt',{type:'text/plain'}));
  await controller.save({ownerConfirmed:true});
  assert.equal(controller.getState().phase,'SAVED');
  assert.equal(controller.getState().detail.text,bytes.toString('utf8'));
  assert.deepEqual(saveStatuses,[201]);
  assert.equal(preserved(db),before);
  db.close();db=new DatabaseSync(filename);
  assert.equal(preserved(db),before);
  const reopened=createImportedSummaryController({jobId:JOB,api});
  await reopened.load();assert.equal(reopened.getState().summaries.length,1);
  await reopened.open(reopened.getState().summaries[0].id);
  assert.equal(reopened.getState().detail.text,bytes.toString('utf8'));
  const listResponse=await call(path());assert.equal(listResponse.status,200);
  const list=await listResponse.json();
  const summaries=list.importedSummaries??list.summaries??list.imports;
  assert.ok(Array.isArray(summaries));assert.equal(summaries.length,1);
  const saved=summaries[0];const savedId=saved.id??saved.importId;
  assert.match(savedId,/^[a-f0-9-]{36}$/);
  const libraryResponse=await call('/api/jobs');assert.equal(libraryResponse.status,200);
  const library=await libraryResponse.json();const listed=library.jobs.find(row=>row.id===JOB);
  assert.equal(listed.importedSummaryCount,1);
  assert.equal(listed.status,'TRANSCRIPT_UNVERIFIED');
  assert.deepEqual(listed.summary,[]);
  assert.equal(library.jobs.some(row=>row.id===OTHER),false);
  const parentResponse=await call('/api/jobs/'+JOB);assert.equal(parentResponse.status,200);
  assert.equal((await parentResponse.json()).job.report,null);
  const detailResponse=await call(path(JOB,'/'+savedId));assert.equal(detailResponse.status,200);
  const detail=await detailResponse.json();const summary=detail.importedSummary??detail.summary??detail;
  assert.equal(summary.provenance,'EXISTING_TRANSCRIPT_IMPORTED');
  assert.equal(summary.providerExecution,'NOT_RUN_BY_APP');
  assert.equal(summary.automaticSummaryCompleted,false);
  const exported=await call(path(JOB,'/'+savedId+'/export'));assert.equal(exported.status,200);
  assert.match(exported.headers.get('content-type'),/^text\/plain/);
  assert.equal(exported.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()),bytes);
  const recovered=await call(requestPath());assert.equal(recovered.status,200);
  assert.equal((await recovered.json()).state,'COMMITTED');
  const duplicate=await call(path(),{method:'POST',body:input});assert.equal(duplicate.status,200);
  const listAfter=await(await call(path())).json();
  assert.equal((listAfter.importedSummaries??listAfter.summaries??listAfter.imports).length,1);
  assert.equal(preserved(db),before);
  assert.equal(externalCalls,0);
  for(const route of [path(OTHER),path(OTHER,'/source'),path(OTHER,'/'+savedId),path(OTHER,'/'+savedId+'/export')])assert.equal((await call(route)).status,404);
  assert.equal((await call(path(OTHER),{method:'POST',body:input})).status,404);
  assert.equal(preserved(db),before);
 }finally{globalThis.fetch=originalFetch;db.close();rmSync(folder,{recursive:true,force:true});}
});
