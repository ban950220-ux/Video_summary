// An imported summary is a separate owner-confirmed attachment. This module
// never calls a provider or updates the parent analysis, source or accounting.
export const IMPORTED_SUMMARY_PROVENANCE='EXISTING_TRANSCRIPT_IMPORTED';
export const IMPORTED_SUMMARY_MAX_BYTES=1_000_000;
const OWNER='owner';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA=/^[0-9a-f]{64}$/;
const encoder=new TextEncoder();
const flags=Object.freeze({provenance:IMPORTED_SUMMARY_PROVENANCE,provenanceLabel:'기존 전사 기반 가져온 요약',providerExecution:'NOT_RUN_BY_APP',automaticSummaryCompleted:false,independentlyVerified:false});
const MAX_REQUEST_BYTES=1_400_000;
const metadataColumns='i.id,i.revision,i.source_sha256,i.source_provenance,i.artifact_sha256,i.artifact_bytes,i.created_at,i.basis_method';
const activeOwner="j.id=? AND j.owner_id=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.job_id=j.id AND d.provider='deletion' AND d.state='DELETING')";
const snapshotClause="j.video_id IS ? AND j.source_url IS ? AND j.source_type=? AND j.duration_seconds=? AND s.raw=? AND s.segments_json=? AND s.provenance=? AND s.updated_at=?";
class ImportError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
function fail(code,status){throw new ImportError('MANUAL_IMPORT_'+code,status);}
function response(value,status=200){return Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});}
async function sha256(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
function exactKeys(value,keys){return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
function pageInteger(params,name,fallback,min,max=Number.MAX_SAFE_INTEGER){
 const raw=params.get(name);if(raw===null)return fallback;
 if(!/^\d+$/.test(raw))fail('INVALID_PAGINATION');
 const value=Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)fail('INVALID_PAGINATION');return value;
}
async function readBody(request){
 const claimed=request.headers.get('content-length');
 if(claimed!==null&&(!/^\d+$/.test(claimed)||Number(claimed)>MAX_REQUEST_BYTES))fail('BODY_TOO_LARGE',413);
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))fail('JSON_REQUIRED',415);
 const reader=request.body?.getReader();if(!reader)fail('INVALID_REQUEST');
 const chunks=[];let length=0;
 while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>MAX_REQUEST_BYTES){await reader.cancel();fail('BODY_TOO_LARGE',413);}chunks.push(part.value);}
 const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
 let text,value;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(text);}catch{fail('INVALID_JSON');}
 // JSON.parse objects cannot execute getters; reject ambiguous duplicate-key
 // encodings as well as prototype keys. The browser sends canonical JSON.
 if(JSON.stringify(value)!==text||/"(?:__proto__|prototype|constructor)"\s*:/.test(text))fail('NONCANONICAL_JSON');
 return value;
}
async function ensureSchema(env){
 if(!env?.DB)fail('PERSISTENCE_NOT_CONFIGURED',503);
 const rows=(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('yta_summary_imports','yta_summary_import_requests','yta_sources','yta_operations')").bind().all()).results||[];
 if(rows.length!==4||typeof env.DB.batch!=='function')fail('SCHEMA_REQUIRED',503);
}
async function ownedJob(env,id){
 const row=await env.DB.prepare('SELECT j.* FROM jobs j WHERE '+activeOwner).bind(id,OWNER).first();
 if(!row)fail('NOT_FOUND',404);return row;
}
async function sourceSnapshot(env,job){
 const source=await env.DB.prepare('SELECT s.* FROM yta_sources s JOIN jobs j ON j.id=s.job_id WHERE '+activeOwner).bind(job.id,OWNER).first();
 if(!source)fail('SOURCE_REQUIRED',409);
 let segments;try{segments=JSON.parse(source.segments_json);}catch{fail('SOURCE_INVALID',409);}
 if(typeof source.raw!=='string'||!source.raw.trim()||typeof source.provenance!=='string'||!source.provenance||!Array.isArray(segments)||segments.length<1||segments.length>50000||!Number.isFinite(job.duration_seconds)||job.duration_seconds<=0||segments.some((s,index)=>!s||typeof s!=='object'||Array.isArray(s)||!Number.isSafeInteger(s.id)||s.id!==index+1||typeof s.text!=='string'||!s.text.trim()||!Number.isFinite(s.startMs)||!Number.isFinite(s.endMs)||s.startMs<0||s.endMs<s.startMs||s.endMs>Math.ceil(job.duration_seconds*1000)||index>0&&s.startMs<segments[index-1].startMs))fail('SOURCE_INVALID',409);
 const canonical=['MANUAL_SUMMARY_RUNTIME_SOURCE_V1',OWNER,job.id,job.video_id,job.source_url,job.source_type,job.duration_seconds,source.raw,source.segments_json,source.provenance,source.updated_at];
 return {job,source,segmentCount:segments.length,sourceSha256:await sha256(encoder.encode(JSON.stringify(canonical)))};
}
function snapshotArgs(snapshot){const {job:j,source:s}=snapshot;return [j.video_id,j.source_url,j.source_type,j.duration_seconds,s.raw,s.segments_json,s.provenance,s.updated_at];}
function metadata(row){return {id:row.id,revision:row.revision,sourceSha256:row.source_sha256,sourceProvenance:row.source_provenance,artifactSha256:row.artifact_sha256,artifactBytes:row.artifact_bytes,createdAt:row.created_at,basisMethod:row.basis_method,...flags};}
async function importRow(env,jobId,importId){
 const row=await env.DB.prepare('SELECT i.* FROM yta_summary_imports i JOIN jobs j ON j.id=i.job_id AND j.owner_id=i.owner_id WHERE '+activeOwner+' AND i.id=? AND i.owner_id=?').bind(jobId,OWNER,importId,OWNER).first();
 if(row){
  const bytes=typeof row.content_text==='string'?encoder.encode(row.content_text):null;
  if(!bytes||bytes.byteLength!==row.artifact_bytes||bytes.byteLength>IMPORTED_SUMMARY_MAX_BYTES||typeof row.artifact_sha256!=='string'||!SHA.test(row.artifact_sha256)||await sha256(bytes)!==row.artifact_sha256||typeof row.source_sha256!=='string'||!SHA.test(row.source_sha256)||row.provenance!==IMPORTED_SUMMARY_PROVENANCE||row.basis_method!=='OWNER_SOURCE_RECONCILIATION')fail('STORAGE_INTEGRITY',409);
 }
 return row;
}
async function requestRow(env,jobId,requestId){
 return env.DB.prepare('SELECT r.* FROM yta_summary_import_requests r JOIN jobs j ON j.id=r.job_id AND j.owner_id=r.owner_id WHERE '+activeOwner+' AND r.request_id=? AND r.owner_id=?').bind(jobId,OWNER,requestId,OWNER).first();
}
async function requestView(env,jobId,requestId,row){
 if(!row)return {state:'NOT_FOUND',requestId,...flags};
 if(row.state==='CANCELLED')return {state:'CANCELLED',requestId,...flags};
 const summary=await importRow(env,jobId,row.import_id);
 if(!summary)fail('STORAGE_INCONSISTENT',409);
 const digest=await sha256(encoder.encode(JSON.stringify(['MANUAL_SUMMARY_IMPORT_REQUEST_V1',summary.source_sha256,summary.artifact_sha256,summary.artifact_bytes,summary.provenance,summary.basis_method])));
 if(digest!==row.request_sha256)fail('STORAGE_INTEGRITY',409);
 return {state:'COMMITTED',requestId,summary:metadata(summary),...flags};
}
async function validatePayload(body){
 if(!exactKeys(body,['requestId','sourceSha256','artifactSha256','artifactBase64','provenance','basis'])||typeof body.requestId!=='string'||!UUID.test(body.requestId)||typeof body.sourceSha256!=='string'||!SHA.test(body.sourceSha256)||typeof body.artifactSha256!=='string'||!SHA.test(body.artifactSha256))fail('INVALID_REQUEST');
 if(body.provenance!==IMPORTED_SUMMARY_PROVENANCE)fail('PROVENANCE_MISMATCH',409);
 if(!exactKeys(body.basis,['method','sourceSha256','artifactSha256','ownerConfirmed'])||body.basis.method!=='OWNER_SOURCE_RECONCILIATION'||body.basis.ownerConfirmed!==true)fail('BASIS_REQUIRED',409);
 if(body.basis.sourceSha256!==body.sourceSha256||body.basis.artifactSha256!==body.artifactSha256)fail('BASIS_HASH_MISMATCH',409);
 const b64=body.artifactBase64;
 if(typeof b64==='string'&&b64.length>Math.ceil(IMPORTED_SUMMARY_MAX_BYTES/3)*4)fail('ARTIFACT_TOO_LARGE',413);
 if(typeof b64!=='string'||b64.length<4||b64.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64))fail('ARTIFACT_ENCODING');
 let binary;try{binary=atob(b64);}catch{fail('ARTIFACT_ENCODING');}
 if(btoa(binary)!==b64)fail('ARTIFACT_ENCODING');
 const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
 if(bytes.byteLength>IMPORTED_SUMMARY_MAX_BYTES)fail('ARTIFACT_TOO_LARGE',413);
 if(await sha256(bytes)!==body.artifactSha256)fail('ARTIFACT_HASH_MISMATCH',409);
 let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('ARTIFACT_UTF8');}
 if(!text.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))fail('ARTIFACT_TEXT');
 // The decoded text is always displayed through textContent, never as HTML.
 const requestSha256=await sha256(encoder.encode(JSON.stringify(['MANUAL_SUMMARY_IMPORT_REQUEST_V1',body.sourceSha256,body.artifactSha256,bytes.byteLength,body.provenance,body.basis.method])));
 return {body,text,bytes,requestSha256};
}
async function createImport(request,env,job){
 const parsed=await validatePayload(await readBody(request)),{body,requestSha256}=parsed;
 const existing=await requestRow(env,job.id,body.requestId);
 if(existing){
  if(existing.state==='CANCELLED')return response(await requestView(env,job.id,body.requestId,existing));
  if(existing.request_sha256!==requestSha256)fail('REQUEST_CONFLICT',409);
  return response({...await requestView(env,job.id,body.requestId,existing),reused:true});
 }
 const snapshot=await sourceSnapshot(env,job);
 if(snapshot.sourceSha256!==body.sourceSha256)fail('SOURCE_HASH_MISMATCH',409);
 const id=crypto.randomUUID(),at=new Date().toISOString();
 // Each SQL statement repeats owner, source and deletion guards. D1 batch is
 // atomic, so cancellation and competing submissions linearize with the save.
 const insert=env.DB.prepare(`INSERT INTO yta_summary_imports(id,owner_id,job_id,revision,source_sha256,source_provenance,artifact_sha256,artifact_bytes,content_text,provenance,basis_method,created_at)
 SELECT ?,?,j.id,(SELECT COALESCE(MAX(revision),0)+1 FROM yta_summary_imports WHERE owner_id=? AND job_id=j.id),?,?,?,?,?,?,?,?
 FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE ${activeOwner} AND ${snapshotClause}
 AND NOT EXISTS(SELECT 1 FROM yta_summary_import_requests WHERE owner_id=? AND job_id=j.id AND request_id=?)
 AND NOT EXISTS(SELECT 1 FROM yta_summary_imports WHERE owner_id=? AND job_id=j.id AND source_sha256=? AND artifact_sha256=?)
 AND COALESCE((SELECT MAX(revision) FROM yta_summary_imports WHERE owner_id=? AND job_id=j.id),0)<9007199254740991`)
 .bind(id,OWNER,OWNER,body.sourceSha256,snapshot.source.provenance,body.artifactSha256,parsed.bytes.byteLength,parsed.text,IMPORTED_SUMMARY_PROVENANCE,'OWNER_SOURCE_RECONCILIATION',at,job.id,OWNER,...snapshotArgs(snapshot),OWNER,body.requestId,OWNER,body.sourceSha256,body.artifactSha256,OWNER);
 const bindRequest=env.DB.prepare(`INSERT OR IGNORE INTO yta_summary_import_requests(owner_id,job_id,request_id,state,request_sha256,import_id,created_at)
 SELECT ?,j.id,?,'COMMITTED',?,i.id,? FROM jobs j JOIN yta_sources s ON s.job_id=j.id JOIN yta_summary_imports i ON i.job_id=j.id AND i.owner_id=j.owner_id
 WHERE ${activeOwner} AND ${snapshotClause} AND i.source_sha256=? AND i.artifact_sha256=?`)
 .bind(OWNER,body.requestId,requestSha256,at,job.id,OWNER,...snapshotArgs(snapshot),body.sourceSha256,body.artifactSha256);
 let results;
 try{results=await env.DB.batch([insert,bindRequest]);}catch{fail('WRITE_UNCERTAIN',503);}
 const saved=await requestRow(env,job.id,body.requestId);
 if(!saved)fail('STATE_CHANGED',409);
 if(saved.state==='CANCELLED')return response(await requestView(env,job.id,body.requestId,saved));
 if(saved.request_sha256!==requestSha256)fail('REQUEST_CONFLICT',409);
 return response({...await requestView(env,job.id,body.requestId,saved),reused:results[0]?.meta?.changes!==1},results[0]?.meta?.changes===1?201:200);
}
async function cancelRequest(request,env,job,requestId){
 const body=await readBody(request);if(!exactKeys(body,[]))fail('INVALID_REQUEST');
 try{await env.DB.prepare("INSERT OR IGNORE INTO yta_summary_import_requests(owner_id,job_id,request_id,state,created_at) SELECT ?,j.id,?,'CANCELLED',? FROM jobs j WHERE "+activeOwner).bind(OWNER,requestId,new Date().toISOString(),job.id,OWNER).run();}catch{fail('WRITE_UNCERTAIN',503);}
 const row=await requestRow(env,job.id,requestId);if(!row)fail('STATE_CHANGED',409);
 return response(await requestView(env,job.id,requestId,row));
}
export async function importedSummaryCounts(env,jobIds,schemaReady=false){
 const result=new Map();if(!jobIds.length||schemaReady!==true)return result;
 const rows=(await env.DB.prepare(`SELECT i.job_id,COUNT(*) AS n FROM yta_summary_imports i JOIN jobs j ON j.id=i.job_id AND j.owner_id=i.owner_id WHERE i.owner_id=? AND i.job_id IN (${jobIds.map(()=>'?').join(',')}) AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.job_id=j.id AND d.provider='deletion' AND d.state='DELETING') GROUP BY i.job_id`).bind(OWNER,...jobIds).all()).results||[];
 for(const row of rows)result.set(row.job_id,row.n);return result;
}
export async function routeManualSummaryImport(request,env){
 const url=new URL(request.url),path=url.pathname;
 const match=path.match(/^\/api\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(imported-summaries|imported-summary-requests)(?:\/([^/]+))?(?:\/(export|cancel))?$/i);
 if(!match)return null;
 const [,jobId,kind,item,action]=match;
 const sourceRoute=kind==='imported-summaries'&&item==='source'&&!action;
 const listRoute=kind==='imported-summaries'&&!item&&!action;
 const itemRoute=kind==='imported-summaries'&&UUID.test(item??'')&&(!action||action==='export');
 const requestRoute=kind==='imported-summary-requests'&&UUID.test(item??'')&&(!action||action==='cancel');
 if(!sourceRoute&&!listRoute&&!itemRoute&&!requestRoute)return null;
 const allowed=sourceRoute||itemRoute?'GET':listRoute?'GET, POST':action==='cancel'?'POST':'GET';
 if(!allowed.split(', ').includes(request.method))return response({error:{code:'METHOD_NOT_ALLOWED'}},405);
 try{
  await ensureSchema(env);const job=await ownedJob(env,jobId);
  if(sourceRoute){const snapshot=await sourceSnapshot(env,job);return response({sourceSha256:snapshot.sourceSha256,sourceProvenance:snapshot.source.provenance,segmentCount:snapshot.segmentCount,durationSeconds:job.duration_seconds,videoId:job.video_id,maxBytes:IMPORTED_SUMMARY_MAX_BYTES,...flags});}
  if(requestRoute){if(action==='cancel')return await cancelRequest(request,env,job,item);return response(await requestView(env,jobId,item,await requestRow(env,jobId,item)));}
  if(listRoute&&request.method==='POST')return await createImport(request,env,job);
  if(listRoute){
   const limit=pageInteger(url.searchParams,'limit',50,1,50),offset=pageInteger(url.searchParams,'offset',0,0),beforeRevision=pageInteger(url.searchParams,'beforeRevision',null,1);
   if(beforeRevision!==null&&offset!==0)fail('INVALID_PAGINATION');
   const rows=(await env.DB.prepare('SELECT '+metadataColumns+' FROM yta_summary_imports i JOIN jobs j ON j.id=i.job_id AND j.owner_id=i.owner_id WHERE '+activeOwner+' AND i.owner_id=?'+(beforeRevision===null?'':' AND i.revision<?')+' ORDER BY i.revision DESC LIMIT ? OFFSET ?').bind(jobId,OWNER,OWNER,...(beforeRevision===null?[]:[beforeRevision]),limit+1,offset).all()).results||[];
   const summaries=rows.slice(0,limit).map(metadata),hasMore=rows.length>limit;
   return response({summaries,limit,offset,hasMore,nextBeforeRevision:hasMore?summaries.at(-1).revision:null,...flags});
  }
  const row=await importRow(env,jobId,item);if(!row)fail('NOT_FOUND',404);
  if(action==='export')return new Response(encoder.encode(row.content_text),{headers:{'content-type':'text/plain; charset=utf-8','content-disposition':'attachment; filename="imported-summary.txt"','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  return response({summary:{...metadata(row),text:row.content_text},...flags});
 }catch(error){
  if(error instanceof ImportError)return response({error:{code:error.code,message:'가져온 요약의 요청·원문 연결·저장 상태를 확인하세요.'}},error.status);
  return response({error:{code:'MANUAL_IMPORT_INTERNAL_ERROR',message:'가져온 요약을 처리하지 못했습니다. 저장 상태를 조회하세요.'}},500);
 }
}
