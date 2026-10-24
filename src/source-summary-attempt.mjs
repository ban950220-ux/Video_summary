import {ProviderError} from './adapters.mjs';
import {completeSource} from './groq-summary.mjs';
import {geminiSourceAssessment} from './gemini-source-assessment.mjs';
import {sha} from './gemini-two-pass-contract.mjs';

const provider='source-summary-attempt-v1';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash=/^[a-f0-9]{64}$/;
const encode=JSON.stringify;
const digest=value=>sha(encode(value));
const fail=code=>{throw new ProviderError(code,'Separate summary preparation stopped. Original evidence is unchanged.');};
const slot=id=>id+':source-summary-attempt:v1';
const operationColumns=['id','job_id','provider','units','state','created_at','error_code','result_json'];
const columnsMatch=columns=>columns.map(key=>`${key} IS ?`).join(' AND ');
const values=(row,columns)=>columns.map(key=>row[key]??null);
const consents=['confirmSeparateSummaryAttempt','confirmReuseStoredTranscript','acknowledgePriorCostAndUncertainty','acknowledgeDuplicateSummaryTokens','acknowledgeIndependentSnapshotRetention','confirmNoProviderCall'];
const ledgerSpecs=[['yta_operations','job_id=?','id'],['usage_events','job_id=?','id'],['yta_audio','job_id=?','chunk_index'],['yta_gemini_two_pass_jobs','job_id=?','job_id'],['yta_gemini_two_pass_calls','job_id=?','phase'],['yta_paid_summary_quotes','job_id=?','id'],['yta_paid_summary_approvals','job_id=?','id'],['yta_paid_summary_reservations','approval_id IN (SELECT id FROM yta_paid_summary_approvals WHERE job_id=?)','id'],['yta_paid_summary_receipts','job_id=?','reservation_id'],['yta_paid_first_trial','job_id=?','id'],['yta_free_batches','job_id=?','job_id'],['yta_free_batch_chunks','job_id=?','chunk_index']];

// Capture complete ordered row sets, and bind that very serialization in the INSERT.
async function snapshot(DB,table,where,args,order,guards,bindings){
 const rows=(await DB.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order}`).bind(...args).all()).results??[];
 if(!rows.length){guards.push(`NOT EXISTS(SELECT 1 FROM ${table} WHERE ${where})`);bindings.push(...args);return rows;}
 const columns=Object.keys(rows[0]);if(columns.some(key=>!/^\w+$/.test(key)))fail('SOURCE_ATTEMPT_SCHEMA_CHANGED');
 const query=`SELECT json_group_array(json_object(${columns.map(key=>`'${key}',x.${key}`).join(',')})) AS snapshot FROM (SELECT * FROM ${table} WHERE ${where} ORDER BY ${order}) x`;
 const encoded=(await DB.prepare(query).bind(...args).first()).snapshot;
 if(encode(JSON.parse(encoded))!==encode(rows))fail('SOURCE_ATTEMPT_EVIDENCE_CHANGED');
 guards.push(`(${query})=?`);bindings.push(...args,encoded);return rows;
}
function core(job,source){return {sourceType:job.source_type,durationSeconds:job.duration_seconds,auditJson:job.audit_json,sourceRaw:source.raw,segmentsJson:source.segments_json,provenance:source.provenance};}
const active=new Set(['CLAIMED','RESERVED','DISPATCHING','PENDING','FIRST_PENDING','REVIEW_PENDING','RECEIVED','RECEIPT_STORED','MODEL_LOOKUP','MODEL_READY','COUNT_SENT','COUNT_RECEIVED','QUOTE_SAVING','PROCESSING','UPLOADING','RUNNING']);

export async function reviewSourceSummaryAttempt(env,{id,job,sourceOf}){
 if(job.audit?.sourceSummaryOrigin)fail('SOURCE_ATTEMPT_NESTING_FORBIDDEN');
 if(job.report)fail('SOURCE_ATTEMPT_REPORT_ALREADY_EXISTS');
 const {source}=await completeSource(env,job,sourceOf),assessment=await geminiSourceAssessment(job,source),DB=env.DB,guards=[],bindings=[];
 const stored=(await snapshot(DB,'jobs',"id=? AND owner_id='owner'",[id],'id',guards,bindings))[0];
 const storedSource=(await snapshot(DB,'yta_sources','job_id=?',[id],'job_id',guards,bindings))[0];
 if(!stored||!storedSource||stored.audit_json!==encode(job.audit)||stored.source_type!=='audio'||stored.duration_seconds!==job.duration_seconds||storedSource.raw!==source.raw||storedSource.segments_json!==source.segments_json||storedSource.provenance!==source.provenance||stored.report_json&&stored.report_json!=='null')fail('SOURCE_ATTEMPT_SOURCE_CHANGED');
 const names=(await DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).results.map(row=>row.name);
 guards.push("(SELECT json_group_array(name) FROM (SELECT name FROM sqlite_master WHERE type='table' ORDER BY name))=?");bindings.push(encode(names));
 const ledgers={};
 for(const [table,where,order] of ledgerSpecs){
  if(!names.some(name=>name.toLowerCase()===table))continue;
  if(table==='yta_paid_summary_reservations'&&!names.some(name=>name.toLowerCase()==='yta_paid_summary_approvals'))fail('SOURCE_ATTEMPT_SCHEMA_CHANGED');
  ledgers[table]=await snapshot(DB,table,where,[id],order,guards,bindings);
 }
 if(ledgers.yta_operations?.some(row=>row.provider==='deletion'))fail('SOURCE_ATTEMPT_DELETED');
 for(const rows of Object.values(ledgers))if(rows.some(row=>active.has(row.state)||row.state==='APPROVED'&&Number(row.expires_at)>Date.now()))fail('SOURCE_ATTEMPT_ACTIVITY_PENDING');
 // Preserve uncertain history, but do not abandon an available complete response.
 if(ledgers.yta_paid_summary_receipts?.some(row=>row.response_complete===1)||ledgers.yta_gemini_two_pass_calls?.some(row=>row.response_complete===1))fail('SOURCE_ATTEMPT_RECEIPT_REVIEW_REQUIRED');
 const operations=ledgers.yta_operations??[],reservations=ledgers.yta_paid_summary_reservations??[],usage=ledgers.usage_events??[];
 const disclosure={operationStates:Object.fromEntries([...new Set(operations.map(row=>row.state))].sort().map(state=>[state,operations.filter(row=>row.state===state).length])),uncertainOperations:operations.filter(row=>row.state==='FAILED_UNCERTAIN'||row.state==='UNCERTAIN').length,paidReservations:reservations.map(row=>({state:row.state,outcome:row.outcome??null})),usageRows:usage.length,priorCost:'PRESERVED_NOT_ZEROED_INVOICE_UNKNOWN',remainingFreeQuota:'UNKNOWN',newSummaryMayDuplicatePriorTokenUse:true,oldRequestsWillNotBeRetried:true};
 const sourceSha256=await digest(core(stored,storedSource)),historySha256=await digest(ledgers),evidenceSha256=await digest([stored,storedSource,ledgers,names]);
 const existing=await DB.prepare('SELECT job_id,result_json FROM yta_operations WHERE id=?').bind(slot(id)).first();
 const review={kind:'SEPARATE_STORED_TRANSCRIPT_SUMMARY_V1',originalJobId:id,evidenceSha256,sourceSha256,historySha256,assessment,disclosure,providerCalls:0,countTokensCalls:0,generationAllowed:false,requiresExactChildServerScope:true,independentSnapshotRetention:true,existingChildId:existing?.job_id??null};
 return {review,stored,storedSource,guard:guards.join(' AND '),bindings};
}

async function replay(env,id,body){
 const row=await env.DB.prepare('SELECT * FROM yta_operations WHERE id=?').bind(slot(id)).first();if(!row)return null;
 let record;try{record=JSON.parse(row.result_json);}catch{fail('SOURCE_ATTEMPT_DELETED_OR_CHANGED');}
 if(!record||row.provider!==provider||row.state!=='CREATED'||row.units!==0||row.error_code!==null||row.job_id!==body.requestId||record.requestJson!==encode(body))fail('SOURCE_ATTEMPT_SLOT_USED');
 const child=await env.DB.prepare("SELECT * FROM jobs WHERE id=? AND owner_id='owner'").bind(row.job_id).first();
 const source=await env.DB.prepare('SELECT * FROM yta_sources WHERE job_id=?').bind(row.job_id).first();
 if(!child||!source)fail('SOURCE_ATTEMPT_DELETED_OR_CHANGED');
 await sourceAttemptBinding(env,{...child,audit:JSON.parse(child.audit_json)},source);
 return {created:true,replayed:true,childJobId:row.job_id,originalJobId:id,providerCalls:0,countTokensCalls:0,generationAllowed:false,requiresExactChildServerScope:true};
}

export async function handleSourceSummaryAttempt(request,env,context){
 if(request.method==='GET')return Response.json((await reviewSourceSummaryAttempt(env,context)).review,{headers:{'cache-control':'no-store'}});
 if(request.method!=='POST')fail('SOURCE_ATTEMPT_METHOD_INVALID');
 const body=await request.json(),allowed=['requestId','evidenceSha256',...consents];
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!allowed.includes(key))||!uuid.test(body.requestId)||!hash.test(body.evidenceSha256)||consents.some(key=>body[key]!==true))fail('SOURCE_ATTEMPT_CONSENT_REQUIRED');
 // Canonical body makes replay independent of JSON property order.
 const canonical={requestId:body.requestId,evidenceSha256:body.evidenceSha256,...Object.fromEntries(consents.map(key=>[key,true]))};
 const prior=await replay(env,context.id,canonical);if(prior)return Response.json(prior);
 const {review,stored,storedSource,guard,bindings}=await reviewSourceSummaryAttempt(env,context);
 if(review.evidenceSha256!==body.evidenceSha256)fail('SOURCE_ATTEMPT_EVIDENCE_CHANGED');
 const childId=body.requestId,createdAt=new Date().toISOString();
 const origin={kind:review.kind,originalJobId:context.id,attemptId:childId,sourceSha256:review.sourceSha256,historySha256:review.historySha256,evidenceSha256:review.evidenceSha256,createdAt,disclosure:review.disclosure,independentSnapshotRetention:true,transcriptionReused:true,transcriptionIndependentlyVerified:false};
 const auditJson=encode({...JSON.parse(stored.audit_json),sourceSummaryOrigin:origin});
 const child={...stored,id:childId,title:(stored.title??'Stored transcript')+' — separate summary',status:review.assessment.status,audit_json:auditJson,report_json:null,created_at:createdAt,updated_at:createdAt};
 const record={kind:provider,originalJobId:context.id,childJobId:childId,requestJson:encode(canonical),origin,snapshotSha256:await digest(core(child,storedSource)),generationAllowed:false,maximumFutureGenerationCalls:2};
 // A single permanent parent slot also prevents different request IDs from racing.
 // No copied audio rows, usage events or provider approvals are manufactured.
 const queries=[
  env.DB.prepare(`INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,?,?,0,'CREATED',?,? WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=?) AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE job_id=?)`).bind(slot(context.id),childId,provider,createdAt,encode(record),...bindings,childId,childId),
  env.DB.prepare("INSERT INTO jobs(id,owner_id,video_id,title,source_url,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) SELECT ?,'owner',?,?,?,?,?,?,?,?,NULL,? WHERE changes()=1").bind(childId,child.video_id??null,child.title,child.source_url??null,child.source_type,child.status,child.duration_seconds,createdAt,createdAt,auditJson),
  env.DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) SELECT ?,?,?,?,? WHERE changes()=1').bind(childId,storedSource.raw,storedSource.segments_json,storedSource.provenance,createdAt),
  env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('SOURCE_ATTEMPT_CONFLICT') END AS ok")
 ];
 try{await env.DB.batch(queries);}catch{const recovered=await replay(env,context.id,canonical);if(recovered)return Response.json(recovered);fail('SOURCE_ATTEMPT_WRITE_UNCONFIRMED');}
 return Response.json(await replay(env,context.id,canonical));
}

// The registry is owned by the child so deleting the original does not erase the
// explicitly retained copy. Child DELETE scrubs the registry and leaves its slot.
export async function sourceAttemptBinding(env,job,source){
 const rows=(await env.DB.prepare('SELECT * FROM yta_operations WHERE job_id=? AND provider=?').bind(job.id,provider).all()).results??[];
 if(!rows.length){if(job.audit?.sourceSummaryOrigin)fail('SOURCE_ATTEMPT_ORIGIN_CHANGED');return null;}
 if(rows.length!==1)fail('SOURCE_ATTEMPT_ORIGIN_CHANGED');
 const row=rows[0];let record;try{record=JSON.parse(row.result_json);}catch{fail('SOURCE_ATTEMPT_ORIGIN_CHANGED');}
 if(row.state!=='CREATED'||row.units!==0||row.error_code!==null||record?.kind!==provider||record.childJobId!==job.id||row.id!==slot(record.originalJobId)||record.origin?.attemptId!==job.id||encode(record.origin)!==encode(job.audit?.sourceSummaryOrigin)||await digest(core(job,source))!==record.snapshotSha256)fail('SOURCE_ATTEMPT_ORIGIN_CHANGED');
 const sql=`EXISTS(SELECT 1 FROM yta_operations WHERE ${columnsMatch(operationColumns)}) AND EXISTS(SELECT 1 FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND j.source_type=? AND j.duration_seconds=? AND j.audit_json=? AND s.raw=? AND s.segments_json=? AND s.provenance=?) AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE id=? AND provider='deletion')`;
 return {sql,bindings:[...values(row,operationColumns),job.id,job.source_type,job.duration_seconds,job.audit_json,source.raw,source.segments_json,source.provenance,job.id+':deleting'],origin:record.origin};
}
export function sourceAttemptPrepare(env,scope,sql){
 const binding=scope.attemptBinding;if(!binding)return env.DB.prepare(sql);
 const canonical=scope.quoteCanonical,extra=canonical?` AND EXISTS(SELECT 1 FROM yta_operations WHERE ${columnsMatch(operationColumns)})`:'';
 return {bind(...args){return env.DB.prepare(sql+' AND '+binding.sql+extra).bind(...args,...binding.bindings,...(canonical?values(canonical,operationColumns):[]));}};
}
export async function assertSourceAttempt(env,scope){
 if(!scope.attemptBinding)return;
 const row=await sourceAttemptPrepare(env,scope,'SELECT 1 AS ok WHERE 1=1').bind().first();if(!row)fail('SOURCE_ATTEMPT_ORIGIN_CHANGED');
}
export async function guardSourceAttemptRoute(env,job,action,method){
 if(method==='GET'&&(['source','export','summary-choice'].includes(action)||action.startsWith('gemini-two-pass')))return;
 // Read with the owned job, so ordinary routes retain their existing D1 query budget.
 // Registry evidence is independent of the audit field and cannot be hidden by removing it.
 if(typeof job.sourceAttemptRegistered!=='boolean')fail('SOURCE_ATTEMPT_SCOPE_REQUIRED');
 if(!job.sourceAttemptRegistered&&!job.audit?.sourceSummaryOrigin)return;
 if(action.startsWith('gemini-two-pass')||method==='GET'&&['source','export','summary-choice'].includes(action))return;
 fail('SOURCE_ATTEMPT_IMMUTABLE');
}
