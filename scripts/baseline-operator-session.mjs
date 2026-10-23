import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {target,sha,createExpectedSchema,compareManagedSchema} from './schema-baseline-review.mjs';
import {readRegistrationSnapshot,registerManagedSchemaBaseline,inspectRegisteredBaseline,validateRegistrationRequest} from './schema-baseline-registration.mjs';
import {createBaselineCloudflareTransport} from './baseline-cloudflare-transport.mjs';
import {confirmBaselineAtTerminal,assertOperatorCapability} from './baseline-operator-confirmation.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const copy=x=>JSON.parse(JSON.stringify(x));
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const iso=ms=>new Date(ms).toISOString();
const evidenceKeys=['kind','windowId','capturedAt','expiresAt','controlsDigest','writerInventoryDigest','pauseEvidenceDigest','buildEvidenceDigest','commandEvidenceDigest','independentReviewDigest'];

function reviewedWindow(value,input,now){
 if(!value||!same(Object.keys(value).sort(),[...evidenceKeys].sort())||value.kind!=='REVIEWED_BASELINE_WINDOW_V1'||value.windowId!==input.approval.windowId||value.controlsDigest!==sha(JSON.stringify(input.controls)))fail('BASELINE_WINDOW_EVIDENCE_INVALID');
 for(const name of evidenceKeys.filter(k=>k.endsWith('Digest')))if(!hash(value[name]))fail('BASELINE_WINDOW_EVIDENCE_INVALID');
 const evidence=Object.fromEntries(evidenceKeys.filter(k=>k!=='controlsDigest').map(k=>[k,value[k]]));
 if(input.controls.operatorEvidenceDigest!==sha(JSON.stringify(evidence)))fail('BASELINE_WINDOW_EVIDENCE_UNBOUND');
 const at=Date.parse(value.capturedAt),end=Date.parse(value.expiresAt);
 if(!Number.isFinite(at)||!Number.isFinite(end)||at>now||now-at>300000||at<Date.parse(input.controls.capturedAt)||now>=end||end>Date.parse(input.approval.windowEndsAt)||end<Date.parse(input.approval.expiresAt))fail('BASELINE_WINDOW_EVIDENCE_STALE');
 return true;
}

// Public entry point: no raw SQL, DB binding, authorize callback, target override,
// token discovery or credential persistence is exposed. Merely importing this
// module performs no network request. No CLI is installed by this patch.
export function createBaselineOperatorSession({credential,fetcher=fetch,signal,now=Date.now}={}){
 const injectedTransport=fetcher!==fetch;
 const remote=createBaselineCloudflareTransport({credential,fetcher,signal}),sessionId=randomUUID();
 let phase='NEW',capture,approved,binding,capability,writeSent=false,closed=false;
 const statements=new WeakMap(),expected=createExpectedSchema(resolve(import.meta.dirname,'..'));
 const alive=()=>{if(closed||signal?.aborted)fail('BASELINE_SESSION_CLOSED');};
 const db={
  prepare(sql){
   const make=args=>{
    const statement=Object.freeze({bind(...values){return make(values);},async first(){return (await read(statement)).results[0]??null;},async all(){return read(statement);}});
    statements.set(statement,{sql,args});return statement;
   };return make([]);
  },
  async batch(batch){
   alive();if(phase!=='REGISTERING'||writeSent||batch.length!==5)fail('BASELINE_BATCH_NOT_AUTHORIZED');
   const payload=batch.map(s=>statements.get(s));if(payload.some(s=>!s))fail('BASELINE_STATEMENT_ORIGIN_INVALID');
   // These statements can only be made by the private registration binding.
   // The bound record is compared again to the exact operator-approved request.
   const record=validateRegistrationRequest(approved.input,{now:now()});
   if(payload[3].args[2]!==JSON.stringify(record)||payload[3].args[3]!==sha(JSON.stringify(record)))fail('BASELINE_BATCH_RECORD_CHANGED');
   await authorize({db,target,approvalDigest:record.approvalDigest});
   assertCurrent(); // last await cannot extend confirmation or window lifetime
   writeSent=true; // dispatch fence before I/O; never retry an uncertain request
   return remote.queries(payload);
  }
 };
 async function read(statement){
  alive();const value=statements.get(statement);
  if(!value||!/^SELECT\s/.test(value.sql)||value.sql.includes(';'))fail('BASELINE_READ_STATEMENT_INVALID');
  return (await remote.queries([value]))[0];
 }
 function assertCurrent(){
  alive();if(!approved||!binding||!capability)fail('BASELINE_OPERATOR_REQUIRED');
  assertOperatorCapability(capability,binding,{now:now()});
  reviewedWindow(approved.window,approved.input,now());
  validateRegistrationRequest(approved.input,{now:now()});
 }
 async function authorize(request){
  assertCurrent();
  if(request.db!==db||!same(request.target,target)||request.approvalDigest!==binding.approvalDigest)fail('BASELINE_SESSION_SCOPE_MISMATCH');
  await remote.identity();assertCurrent();
  const bookmark=await remote.bookmark(capture.timeTravel.capturedAt);assertCurrent();
  if(bookmark!==capture.timeTravel.bookmark)fail('BASELINE_RESTORE_POINT_CHANGED');
  return true;
 }
 async function captureEvidence(){
  alive();if(phase!=='NEW')fail('BASELINE_SESSION_ALREADY_STARTED');phase='CAPTURING';
  try{
   const startedAt=iso(now());await remote.identity();alive();
   const bookmark=await remote.bookmark(startedAt);alive();
   const dbSnapshot=await readRegistrationSnapshot(db);alive();
   if(dbSnapshot.historyTableCount!==0)fail('BASELINE_HISTORY_REVIEW_REQUIRED');
   const rows=JSON.parse(dbSnapshot.schemaJson);
   if(!compareManagedSchema(rows,expected).matches)fail('BASELINE_SCHEMA_MISMATCH');
   if(JSON.parse(dbSnapshot.statesJson).inflight!==0)fail('BASELINE_OPERATIONS_IN_FLIGHT');
   if(Date.parse(dbSnapshot.capturedAt)>now()+1||now()-Date.parse(dbSnapshot.capturedAt)>300000)fail('BASELINE_SNAPSHOT_STALE');
   capture=freeze({sessionId,dbSnapshot,observation:{...target,rows,startedAt,completedAt:iso(now()),digest:sha(JSON.stringify(dbSnapshot))},timeTravel:{databaseId:target.databaseId,bookmark,capturedAt:startedAt},schemaFingerprint:expected.fingerprint,catalogDigest:expected.catalogDigest});
   phase='CAPTURED';return copy(capture);
  }catch(error){phase='CAPTURE_FAILED';throw error;}
 }
 async function confirm(input,windowEvidence,terminal){
  alive();if(phase!=='CAPTURED')fail('BASELINE_CONFIRMATION_STATE_INVALID');phase='CONFIRMING';
  try{
   if(!injectedTransport&&((terminal?.input&&terminal.input!==process.stdin)||(terminal?.output&&terminal.output!==process.stderr)))fail('BASELINE_PRODUCTION_TERMINAL_REQUIRED');
   const immutable=freeze({input:copy(input),window:copy(windowEvidence)});
   if(!same(immutable.input.dbSnapshot,capture.dbSnapshot)||!same(immutable.input.observation,capture.observation)||!same(immutable.input.controls?.timeTravel,capture.timeTravel))fail('BASELINE_CAPTURE_BINDING_MISMATCH');
   const record=validateRegistrationRequest(immutable.input,{now:now()});reviewedWindow(immutable.window,immutable.input,now());
   binding=freeze({kind:'BASELINE_OPERATOR_CONFIRMATION_V1',sessionId,...target,action:'REGISTER_BASELINE_ONLY',approvalDigest:record.approvalDigest,inputDigest:sha(JSON.stringify(immutable.input)),windowEvidenceDigest:sha(JSON.stringify(immutable.window)),operatorEvidenceDigest:immutable.input.controls.operatorEvidenceDigest,snapshotDigest:capture.dbSnapshot.digest,restoreBookmarkDigest:record.restoreBookmarkDigest,schemaFingerprint:record.schemaFingerprint,catalogDigest:record.catalogDigest,windowStartsAt:record.windowStartsAt,windowEndsAt:record.windowEndsAt,expiresAt:record.expiresAt,expiresMs:Date.parse(immutable.input.approval.expiresAt)});
   capability=await confirmBaselineAtTerminal(binding,{...terminal,signal,now});approved=immutable;
   assertCurrent();phase='CONFIRMED';return capability;
  }catch(error){phase='CONFIRMATION_FAILED';throw error;}
 }
 async function register(grant){
  alive();if(phase!=='CONFIRMED'||grant!==capability)fail('BASELINE_SESSION_GRANT_INVALID');
  assertCurrent();phase='REGISTERING'; // competing calls cannot pass this fence
  try{
   const result=await registerManagedSchemaBaseline(db,approved.input,{assertAuthorized:authorize,now});
   phase='FINISHED';return {...result,operatorReceipt:{...binding,recordSha256:result.row.record_sha256},authentication:injectedTransport?'INJECTED_TRANSPORT_NOT_PRODUCTION_PROOF':'CLOUDFLARE_TARGET_ACCESS_CHECKED',authorization:injectedTransport?'INJECTED_TERMINAL_NOT_PRODUCTION_PROOF':'INTERACTIVE_LOCAL_OPERATOR',manualPauseEvidence:'OPERATOR_ATTESTED_NOT_API_PROVEN'};
  }catch(error){
   phase=writeSent?'WRITE_UNCONFIRMED':'STOPPED_BEFORE_DISPATCH';
   if(!writeSent){const reason=error.cause?.code??error.code;throw Object.assign(new Error('BASELINE_STOPPED_BEFORE_DISPATCH'),{code:'BASELINE_STOPPED_BEFORE_DISPATCH',reason:/^BASELINE_[A-Z_]+$/.test(reason??'')?reason:'BASELINE_GUARD_FAILED',writeSent:false});}
   throw error;
  }
 }
 async function inspect(){alive();await remote.identity();alive();return inspectRegisteredBaseline(db);}
 return Object.freeze({captureEvidence,confirm,register,inspect,status(){return {phase,writeSent,sessionId};},close(){closed=true;remote.close();capability=null;approved=null;}});
}
