import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {PassThrough} from 'node:stream';
import {createExpectedSchema,trustedBuffers,sha,target} from '../../scripts/schema-baseline-review.mjs';
import {createBaselineOperatorSession} from '../../scripts/baseline-operator-session.mjs';
const repo=resolve(import.meta.dirname,'../..');
export const expected=createExpectedSchema(repo),source=trustedBuffers(repo);
export const fixtureCredential='SYNTHETIC_EPHEMERAL_TOKEN_NEVER_REAL';
export const fixtureBookmark='00000001-00000002-00004e2f-0a83ea2fceebc654de0640c422be4653';
export function localDatabase(){
 const db=new DatabaseSync(':memory:');db.exec(source.base.toString());for(const file of source.files.filter(f=>f.name<'0016'))db.exec(file.bytes.toString());
 db.exec("INSERT INTO jobs(id,owner_id,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES('j','owner','text','TRANSCRIPT_UNVERIFIED',98,'t','t','REPORT_FIXTURE','AUDIT_FIXTURE'); INSERT INTO yta_sources VALUES('j','SOURCE_FIXTURE','[]','FIXTURE','t'); INSERT INTO usage_events(id,owner_id,provider,capability,unit,used_units,provenance,captured_at) VALUES('u','owner','groq','summary','tokens',2169,'FIXTURE','t')");
 for(let i=0;i<7;i++)db.prepare("INSERT INTO yta_operations VALUES(?,'j','groq-summary',6600,'FAILED_UNCERTAIN','t','UNKNOWN','RECEIPT_FIXTURE')").run('old-'+i);
 return db;
}
export const retained=db=>sha(JSON.stringify(['jobs','yta_sources','yta_operations','usage_events'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all())));
export function fixture(hooks={}){
 const db=localDatabase(),calls=[],writes=[];let clockOffset=0;
 const now=()=>Date.now()+clockOffset;
 const fetcher=async(url,options)=>{
  const u=new URL(url);calls.push({path:u.pathname,query:u.search,method:options.method});
  if(u.origin!=='https://api.cloudflare.com'||!u.pathname.startsWith(`/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}`))throw Error('WRONG_ENDPOINT');
  if(options.headers.Authorization!==`Bearer ${fixtureCredential}`||options.redirect!=='error'||options.credentials!=='omit')throw Error('WRONG_AUTH_TRANSPORT');
  const response=(result,status=200)=>new Response(JSON.stringify({success:status===200,result}),{status,headers:{'content-type':'application/json'}});
  if(hooks.fetch){const override=await hooks.fetch({u,options,calls,db,writes,advance:ms=>{clockOffset+=ms;},response});if(override)return override;}
  if(u.pathname.endsWith('/time_travel/bookmark'))return response({bookmark:fixtureBookmark});
  if(options.method==='GET')return response({uuid:target.databaseId,name:'youtube-ai-analyzer-private-db'});
  const body=JSON.parse(options.body);if(!Array.isArray(body.batch))throw Error('REST_BATCH_REQUIRED');
  const writing=body.batch.some(s=>!/^SELECT\s/.test(s.sql));
  if(writing){writes.push(body);await hooks.beforeWrite?.({db,body});}
  if(hooks.rejectReadsAfterWrite&&writes.length&&!writing)throw Error(fixtureCredential+' private HTTP error');
  db.exec('BEGIN IMMEDIATE');
  try{
   const results=body.batch.map(s=>({success:true,results:db.prepare(s.sql).all(...s.params)}));
   if(writing&&hooks.precommit)throw Error('PRECOMMIT_FIXTURE');
   db.exec('COMMIT');if(writing&&hooks.ackLoss)throw Error(fixtureCredential+' ACK_LOSS_FIXTURE');return response(results);
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 };
 const session=createBaselineOperatorSession({credential:fixtureCredential,fetcher,now,signal:hooks.signal});
 return {session,db,calls,writes,now,advance(ms){clockOffset+=ms;},close(){session.close();db.close();}};
}
export async function reviewedInput(f,capture){
 while(f.now()<Date.parse(capture.dbSnapshot.capturedAt))await new Promise(r=>setTimeout(r,1));
 const at=new Date(f.now()).toISOString(),end=new Date(f.now()+120000).toISOString();
 const review={...target,kind:'EXISTING_MANAGED_SCHEMA_ADOPTION_REVIEW_V1',historyClaim:'UNKNOWN_NO_HISTORICAL_APPLIED_ROWS',schemaFingerprint:expected.fingerprint,observationDigest:capture.observation.digest,catalogDigest:expected.catalogDigest,reviewedAt:at};
 const controls={...target,schemaFingerprint:expected.fingerprint,writersQuiesced:true,relevantDispatchPaused:true,productionBuildsDisabled:true,previewBuildsDisabled:true,runningOrQueuedBuildCount:0,unsettledRelevantOperationCount:0,capturedAt:at,timeTravel:capture.timeTravel,commandsAndProtectedEvidenceReviewed:true,scope:'BASELINE_RECORD_ONLY_NO_MIGRATION_EXECUTION'};
 const approval={kind:'SCHEMA_BASELINE_REGISTRATION_APPROVAL_V1',requestId:'11111111-1111-4111-8111-111111111111',...target,action:'REGISTER_BASELINE_ONLY',approvedAt:at,expiresAt:end,windowId:'22222222-2222-4222-8222-222222222222',windowStartsAt:at,windowEndsAt:end,observationDigest:capture.observation.digest,snapshotDigest:capture.dbSnapshot.digest,schemaFingerprint:expected.fingerprint,catalogDigest:expected.catalogDigest,controlsDigest:sha(JSON.stringify(controls)),restoreBookmarkDigest:sha(controls.timeTravel.bookmark)};
 const input={observation:capture.observation,review,controls,dbSnapshot:capture.dbSnapshot,approval};
 const window={kind:'REVIEWED_BASELINE_WINDOW_V1',windowId:approval.windowId,capturedAt:at,expiresAt:end,controlsDigest:approval.controlsDigest,writerInventoryDigest:sha('FIXTURE_WRITERS'),pauseEvidenceDigest:sha('FIXTURE_PAUSE'),buildEvidenceDigest:sha('FIXTURE_BUILDS'),commandEvidenceDigest:sha('FIXTURE_COMMANDS'),independentReviewDigest:sha('FIXTURE_REVIEW')};
 const evidenceKeys=['kind','windowId','capturedAt','expiresAt','writerInventoryDigest','pauseEvidenceDigest','buildEvidenceDigest','commandEvidenceDigest','independentReviewDigest'];
 controls.operatorEvidenceDigest=sha(JSON.stringify(Object.fromEntries(evidenceKeys.map(k=>[k,window[k]]))));
 approval.controlsDigest=window.controlsDigest=sha(JSON.stringify(controls));
 return {input,window};
}
export function terminal({wrong=false,tty=true,beforeReply}={}){
 const input=new PassThrough(),output=new PassThrough();input.isTTY=output.isTTY=tty;let text='',answered=false;
 output.on('data',chunk=>{text+=chunk.toString();const match=text.match(/Type exactly: (REGISTER BASELINE [a-f0-9]{64} [a-f0-9]{24})\n/);if(match&&!answered){answered=true;setImmediate(()=>{beforeReply?.();input.write((wrong?'DENY':match[1])+'\n');});}});
 return {input,output,text:()=>text};
}
export async function ready(f,terminalOptions){
 const capture=await f.session.captureEvidence(),bundle=await reviewedInput(f,capture),tty=terminal(terminalOptions),grant=await f.session.confirm(bundle.input,bundle.window,tty);
 return {...bundle,tty,grant,capture};
}
