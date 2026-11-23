import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,sign,createHash,randomUUID} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {handleSiteRequest} from '../../src/site-worker.mjs';
import {asrTranscriptDigests} from '../../src/asr-result-bridge.mjs';
import {syntheticApprovedSource,syntheticApprovedReport} from './approved-summary-synthetic.mjs';

// Local fixture only. All identities, credentials and provider responses are
// synthetic. Passing actual runtime file hashes into an owned-input job does
// not enable real providers; the fixture never opens a network connection.
const origin='https://asr-bridge.synthetic.invalid',team='https://asr-bridge-fixture.cloudflareaccess.com',audience='synthetic-asr-audience',owner='asr-owner@example.test';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=publicKey.export({format:'jwk'}),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const sha=value=>createHash('sha256').update(value).digest('hex');
export const SYNTHETIC_ASR_ORIGINAL_SHA=sha('invented original audio bytes');
export function createAsrOwnerFixture({providersEnabled=true,preserveDirectory=false,directory:requestedDirectory=null}={}){
 const directory=requestedDirectory??mkdtempSync(join(tmpdir(),'synthetic-asr-route-')),databasePath=join(directory,'local.sqlite');
 let db=new DatabaseSync(databasePath),beforeSql=null;
 for(const file of ['schema.sql','migrations/0002_live.sql','migrations/0003_observed_capacity.sql','migrations/0017_audio_submission_idempotency.sql'])db.exec(readFileSync(new URL('../../'+file,import.meta.url),'utf8'));
 const counts={nativeMock:0,summaryMock:0,unexpectedTransport:0},sessions=[];
 const DB={prepare(sql){const statement=args=>({sql,args,bind(...values){return statement(values);},async first(){beforeSql?.(sql,args,'first');return db.prepare(sql).get(...args)??null;},async all(){beforeSql?.(sql,args,'all');return {results:db.prepare(sql).all(...args)};},async run(){beforeSql?.(sql,args,'run');return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}});return statement([]);},async batch(statements){
  // This transaction is confined to the local SQLite implementation of the
  // D1-shaped fixture. No BEGIN statement is sent to any remote service.
  db.exec('BEGIN');try{const results=statements.map(item=>{beforeSql?.(item.sql,item.args,'batch');const statement=db.prepare(item.sql),result=statement.run(...item.args);return {success:true,meta:{changes:Number(result.changes)}};});db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}
 },withSession(constraint){sessions.push(constraint);assert.equal(constraint,'first-primary');return DB;}};
 const env={DB,ENABLE_LIVE_FREE:providersEnabled?'true':'false',ALLOW_PAID_API:'false',ACCESS_TEAM_DOMAIN:team,ACCESS_AUD:audience,ACCESS_OWNER_EMAIL:owner};
 if(providersEnabled){
  const key='SYNTHETIC_ONLY_ASR_ROUTE_ACCOUNT',now=Date.now();env.SUPADATA_API_KEY=key;env.GEMINI_API_KEY=key;
  for(const provider of ['supadata','gemini'])db.prepare('INSERT INTO yta_quota(provider,allowance,consumed,request_limit,request_count,expires_at,confirmed_at,billing_disabled) VALUES(?,250000,0,100,0,?,?,1)').run(provider,now+3600000,now);
  const remaining={requestsMinute:1000,tokensMinute:1000000000,requestsDay:1000};
  db.prepare('INSERT INTO yta_capacity(provider,model,source,observed_at,valid_until,reset_json,remaining_json,reserved_json,billing_disabled) VALUES(?,?,?,?,?,?,?,?,1)').run('gemini','gemini-2.5-flash','AI_STUDIO_LIVE:'+sha('gemini:'+key),now,now+600000,JSON.stringify(Object.fromEntries(Object.keys(remaining).map(key=>[key,now+3600000]))),JSON.stringify(remaining),JSON.stringify(Object.fromEntries(Object.keys(remaining).map(key=>[key,0]))));
 }
 const token=(email=owner)=>{const now=Math.floor(Date.now()/1000),head=encode({alg:'RS256',typ:'JWT',kid:'synthetic-asr-owner-key'}),body=encode({iss:team,aud:[audience],iat:now-10,exp:now+3600,email,sub:'synthetic-asr-owner'});return head+'.'+body+'.'+sign('RSA-SHA256',Buffer.from(head+'.'+body),privateKey).toString('base64url');};
 const fetcher=async url=>{assert.equal(url,team+'/cdn-cgi/access/certs');return Response.json({keys:[{...jwk,kid:'synthetic-asr-owner-key',alg:'RS256'}]});};
 const call=(path,{method='GET',body,email=owner,requestOrigin=origin,headers={}}={})=>handleSiteRequest(new Request(origin+path,{method,headers:{'Cf-Access-Jwt-Assertion':token(email),...(body===undefined?{}:{'content-type':'application/json'}),...(method==='GET'?{}:{Origin:requestOrigin}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{fetcher,nowMs:Date.now()});
 const source=id=>{const row=db.prepare('SELECT * FROM yta_sources WHERE job_id=?').get(id);return row?{...row,segments:JSON.parse(row.segments_json)}:null;};
 const provider=async(url,options={})=>{
  const parsed=new URL(String(url));
  if(providersEnabled&&parsed.hostname==='api.supadata.ai'&&parsed.pathname==='/v1/transcript'){counts.nativeMock++;return new Response(null,{status:206});}
  if(providersEnabled&&parsed.hostname==='generativelanguage.googleapis.com'){counts.summaryMock++;const body=JSON.parse(options.body);assert.match(body.contents[0].parts[0].text,/approvedSummary/);const row=db.prepare('SELECT * FROM yta_sources ORDER BY job_id LIMIT 1').get();assert.ok(row);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(syntheticApprovedReport({raw:row.raw,segments:JSON.parse(row.segments_json)}))}]}}]});}
  counts.unexpectedTransport++;throw new Error('UNEXPECTED_NETWORK_DISABLED_IN_FIXTURE');
 };
 return {env,call,provider,counts,sessions,directory,databasePath,get db(){return db;},set beforeSql(value){beforeSql=value;},source,job:id=>db.prepare('SELECT * FROM jobs WHERE id=?').get(id),reopen(){db.close();db=new DatabaseSync(databasePath);},close(){db.close();if(!preserveDirectory)rmSync(directory,{recursive:true,force:true});}};
}
export async function routeJson(response,expected=200){assert.equal(response.status,expected,await response.clone().text());return response.json();}
export async function createAsrJob(f,{sourceType='audio',originalAudioSha256=SYNTHETIC_ASR_ORIGINAL_SHA,durationSeconds=80,submissionId=randomUUID(),title='Synthetic ASR route'}={}){
 const body={sourceType,durationSeconds,title,submissionId,...(sourceType==='url'?{url:'https://youtu.be/synthetic01'}:{ownedAudioSha256:originalAudioSha256})};
 return (await routeJson(await f.call('/api/jobs',{method:'POST',body}),202)).job;
}
export async function requestAsr(f,jobId,requestId=randomUUID()){
 const status=await routeJson(await f.call('/api/jobs/'+jobId+'/audio-request'));
 const request=await routeJson(await f.call('/api/jobs/'+jobId+'/audio-request',{method:'POST',body:{requestId,jobSourceSha256:status.jobSourceSha256,rightsConfirmed:true,confirmLocalOnly:true}}));
 return request;
}
export async function syntheticAsrDelivery(f,jobId,request){
 const job=f.job(jobId),source=syntheticApprovedSource(),jobSourceSha256=request.jobSourceSha256??request.context.jobSourceSha256,requestId=request.requestId;
 const identity=job.source_type==='url'?{kind:'YOUTUBE_ACQUISITION',videoId:job.video_id,canonicalUrl:job.source_url,officialDurationMs:80000,metadataSha256:sha('synthetic metadata fixture')}:{kind:'OWNED_AUDIO',originalAudioSha256:JSON.parse(job.audit_json).ownedAudioSha256};
 const originalSha=identity.originalAudioSha256??SYNTHETIC_ASR_ORIGINAL_SHA;
 const media={kind:'OWNER_SUBMITTED_ASR_SOURCE_V1',jobId,requestId,jobSourceSha256,sourceIdentity:identity,originalAudio:{sha256:originalSha,bytes:12345,durationMs:80040,measurement:'FFPROBE',measurementSha256:sha('synthetic original probe'),startTimeMs:25},asrInput:{sha256:sha('synthetic normalized WAV'),bytes:2560044,durationMs:80000,measurement:'PCM_SAMPLE_COUNT',measurementSha256:sha('synthetic sample-count evidence'),sampleRate:16000,channels:1,sampleCount:1280000,format:'WAV_PCM_S16LE',pcmSha256:sha('synthetic normalized PCM'),timeOrigin:'NORMALIZED_AUDIO_FRAME_ZERO'}};
 const bound=await routeJson(await f.call('/api/jobs/'+jobId+'/audio-request-bind',{method:'POST',body:{requestId,revision:request.revision,jobSourceSha256,source:media,confirmSourceBinding:true,confirmNoProviderCall:true}}));
 const result={kind:'OWNER_SUBMITTED_LOCAL_ASR_RESULT_V1',jobId,requestId,revision:bound.revision,jobSourceSha256,sourceBindingSha256:bound.sourceBindingSha256,originalAudioSha256:originalSha,asrInputSha256:media.asrInput.sha256,asrPcmSha256:media.asrInput.pcmSha256,transcript:{raw:source.raw,segments:source.segments,...await asrTranscriptDigests(source.raw,source.segments)},engine:{name:'faster-whisper',model:'synthetic-small',version:null,device:'cpu',computeType:'int8'},confirmOwnerSubmitted:true,confirmNoProviderCall:true};
 return {source:media,result,bound};
}
