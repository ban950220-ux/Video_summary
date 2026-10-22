import {ProviderError} from './adapters.mjs';
import {assertFullSource} from './groq-full-coverage.mjs';
import {transcriptAudit} from './core.mjs';
import {auditGaps} from './report.mjs';

const fail=code=>{throw new ProviderError(code,code);};
const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// Creates a distinct, idempotent text job. It copies only the already stored
// transcript; all old provider operations and usage stay on the original job.
export async function handleFreshFullCoverage(request,env,{id,job,sourceOf}){
 if(request.method!=='POST')return Response.json({error:{code:'METHOD_NOT_ALLOWED'}},{status:405});
 let body;try{body=await request.json();}catch{fail('FRESH_BAD_JSON');}
 if(body?.confirmSeparateNewJob!==true||body.acknowledgeDuplicateSummaryTokens!==true||body.confirmNoRetranscription!==true||!(['text','url'].includes(job.source_type))||!['TRANSCRIPT_UNVERIFIED','PARTIAL_TRANSCRIPT'].includes(job.audit?.status))fail('FRESH_EXPLICIT_TRANSCRIPT_REQUIRED');
 const original=await sourceOf(env,id),segments=original?.segments;
 const native=job.source_type==='url'&&original?.provenance==='SUPADATA_NATIVE';
 if(job.source_type==='url'&&!native||job.source_type==='text'&&job.audit?.status!=='TRANSCRIPT_UNVERIFIED')fail('FRESH_SOURCE_PROVENANCE_INVALID');
 if(!Array.isArray(segments)||!segments.length||segments.some((item,i)=>item?.id!==i+1||typeof item.text!=='string'||!item.text.trim()||!Number.isSafeInteger(item.startMs)||!Number.isSafeInteger(item.endMs)||item.endMs<=item.startMs||(i&&item.startMs<segments[i-1].startMs))||segments[0].startMs<0||segments.at(-1).endMs>job.duration_seconds*1000+2000||(!native&&(segments[0].startMs>10_000||segments.at(-1).endMs<job.duration_seconds*1000-10_000)))fail('FRESH_TRANSCRIPT_INCOMPLETE');
 if(native){const timed=transcriptAudit(segments,job.duration_seconds,false),gaps=auditGaps(segments,job.duration_seconds).gaps;if(timed.status!==job.audit.status||timed.timelineRatio!==job.audit.timelineRatio||!same(gaps,job.audit.gaps))fail('FRESH_NATIVE_COVERAGE_CHANGED');}
 const raw=segments.map(item=>item.text).join('\n');assertFullSource(segments,raw);
 const originalRawSha256=await sha(original.raw),sourceHash=await sha(JSON.stringify({raw,segments}));
 if(body.originalSourceSha256!==originalRawSha256||body.expectedSegments!==segments.length)fail('FRESH_SOURCE_CHANGED');
 const seed=await sha(JSON.stringify({originalJobId:id,originalRawSha256,sourceHash})),newId=`${seed.slice(0,8)}-${seed.slice(8,12)}-4${seed.slice(13,16)}-a${seed.slice(17,20)}-${seed.slice(20,32)}`;
 const sourceScope={provenance:native?'SUPADATA_NATIVE':original.provenance,transcriptStatus:job.audit.status,firstMs:segments[0].startMs,lastMs:segments.at(-1).endMs,expectedDurationMs:Math.round(job.duration_seconds*1000),timelineRatio:job.audit.timelineRatio??null,gaps:Array.isArray(job.audit.gaps)?job.audit.gaps:[],audioAccuracy:'NOT_INDEPENDENTLY_VERIFIED',coverageMeaning:'STORED_TRANSCRIPT_SEGMENTS_ONLY'};
 const audit={status:job.audit.status,sourceScope,fullCoverageFresh:{contract:'FRESH_IMPORTED_TRANSCRIPT_V1',jobId:newId,originalJobId:id,originalRawSha256,sourceHash,segmentCount:segments.length,transcriptionReused:true,priorSummaryUsageCopied:false,duplicateSummaryTokenUseAcknowledged:true,audioAccuracy:'NOT_INDEPENDENTLY_VERIFIED',sourceScope}};
 const now=new Date().toISOString(),auditJson=JSON.stringify(audit);
 await env.DB.prepare("INSERT OR IGNORE INTO jobs(id,owner_id,video_id,title,source_url,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) SELECT ?,'owner',video_id,? ,source_url,'text',?,duration_seconds,?,?,NULL,? FROM jobs WHERE id=? AND owner_id='owner' AND audit_json=?").bind(newId,`New full summary: ${job.title??'Imported transcript'}`.slice(0,160),job.audit.status,now,now,auditJson,id,JSON.stringify(job.audit)).run();
 const saved=await env.DB.prepare("SELECT source_type,report_json,audit_json FROM jobs WHERE id=? AND owner_id='owner'").bind(newId).first();
 let savedAudit,savedReport;try{savedAudit=JSON.parse(saved?.audit_json??'null');savedReport=JSON.parse(saved?.report_json??'null');}catch{fail('FRESH_JOB_WRITE_UNCERTAIN');}
 const completed=savedReport?.compositionMode==='groq-full-coverage-global-v1'&&savedReport?.coverageManifest?.sourceHash===sourceHash;
 if(saved?.source_type!=='text'||(!completed&&saved.report_json!==null)||(!completed&&saved.audit_json!==auditJson)||(completed&&!same(savedAudit,{...audit,summaryProvider:'groq',externalFactCheck:'NOT_PERFORMED'})))fail('FRESH_JOB_WRITE_UNCERTAIN');
 await env.DB.prepare("INSERT OR IGNORE INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) SELECT ? ,?,?,'FRESH_IMPORTED_TRANSCRIPT',? FROM jobs j JOIN yta_sources s ON s.job_id=? WHERE j.id=? AND j.owner_id='owner' AND j.audit_json=? AND s.raw=? AND s.segments_json=?").bind(newId,raw,JSON.stringify(segments),now,id,newId,auditJson,original.raw,original.segments_json).run();
 const source=await env.DB.prepare('SELECT raw,segments_json,provenance FROM yta_sources WHERE job_id=?').bind(newId).first();
 if(source?.raw!==raw||!same(JSON.parse(source.segments_json),segments)||source.provenance!=='FRESH_IMPORTED_TRANSCRIPT')fail('FRESH_SOURCE_WRITE_UNCERTAIN');
 return Response.json({jobId:newId,originalJobId:id,persisted:true,alreadyCompleted:completed,sourceSegments:segments.length,sourceHash,sourceScope,providerCalls:0,priorUsageCopied:false,newSummaryCallsRequireSeparateApproval:!completed,duplicateSummaryTokensPossible:true,transcriptionReused:true,transcriptAccuracy:'UNVERIFIED'},{status:201,headers:{'cache-control':'no-store'}});
}
