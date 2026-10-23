import {windowManifest} from './two-pass-windows.mjs';
import {transcriptAudit} from './core.mjs';
import {sha} from './gemini-two-pass-contract.mjs';

// This is a snapshot of stored evidence, never an attestation of audio accuracy.
export async function geminiSourceAssessment(job,source){
 const audit=job.audit&&typeof job.audit==='object'&&!Array.isArray(job.audit)?job.audit:null;
 const segments=Array.isArray(source?.segments)?source.segments:[];
 let measured={status:'TRANSCRIPT_UNVERIFIED',timelineRatio:null};
 const valid=segments.length>0&&Number.isFinite(job.duration_seconds)&&job.duration_seconds>0&&segments.every(s=>Number.isFinite(s?.startMs)&&Number.isFinite(s?.endMs)&&s.startMs>=0&&s.endMs>s.startMs);
 if(valid){try{measured=transcriptAudit(segments,job.duration_seconds,false);}catch{}}
 let transcriptGapWindows=[];
 if(valid&&job.duration_seconds<=7200&&segments.every(s=>s.endMs<=7202000)){try{transcriptGapWindows=windowManifest(source).filter(w=>!w.primaryIds.length&&!w.boundaryIds.length).map(({key,startMs,endMs})=>({key,startMs,endMs,interpretation:'NO_STORED_TRANSCRIPT_AUDIO_CONTENT_UNKNOWN'}));}catch{}}
 const declaredStatus=typeof audit?.status==='string'?audit.status:null;
 const status=declaredStatus==='PARTIAL_TRANSCRIPT'||measured.status==='PARTIAL_TRANSCRIPT'||transcriptGapWindows.length>0?'PARTIAL_TRANSCRIPT':'TRANSCRIPT_UNVERIFIED';
 const badRatio=audit?.timelineRatio!=null&&(!Number.isFinite(audit.timelineRatio)||audit.timelineRatio<0||audit.timelineRatio>1||audit.timelineRatio!==measured.timelineRatio);
 const auditConsistency=badRatio?'INCONSISTENT_SOURCE_AUDIT':!declaredStatus?'MISSING_SOURCE_AUDIT':!['PARTIAL_TRANSCRIPT','TRANSCRIPT_UNVERIFIED','FULL_TRANSCRIPT_VERIFIED'].includes(declaredStatus)||declaredStatus==='FULL_TRANSCRIPT_VERIFIED'&&(measured.status==='PARTIAL_TRANSCRIPT'||transcriptGapWindows.length>0)?'INCONSISTENT_SOURCE_AUDIT':'STORED_AUDIT_NOT_INDEPENDENTLY_VERIFIED';
 const snapshot={sourceType:job.source_type??null,durationSeconds:job.duration_seconds??null,auditJson:job.audit_json??JSON.stringify(job.audit??null),raw:source?.raw??null,segmentsJson:source?.segments_json??JSON.stringify(segments),provenance:source?.provenance??null};
 return {snapshotSha256:await sha(JSON.stringify(snapshot)),status,declaredStatus,auditConsistency,auditSnapshot:audit,sourceType:snapshot.sourceType,provenance:snapshot.provenance,durationSeconds:snapshot.durationSeconds,transcriptGapWindows,range:{firstStartMs:valid?Math.min(...segments.map(s=>s.startMs)):null,lastEndMs:valid?Math.max(...segments.map(s=>s.endMs)):null,timelineRatio:measured.timelineRatio,segmentCount:segments.length},fullSourceCoverage:'NOT_VERIFIED',audioAccuracy:'NOT_VERIFIED',timestampAccuracy:'NOT_VERIFIED',independentVerification:false};
}

export async function projectGeminiReport(env,job,providedSource){
 if(job.report?.compositionMode!=='gemini-two-pass-v1')return job;
 let source=providedSource;
 if(source===undefined){
  const row=await env.DB.prepare('SELECT * FROM yta_sources WHERE job_id=?').bind(job.id).first();
  let segments=[];try{segments=JSON.parse(row?.segments_json||'[]');}catch{}
  source=row?{...row,segments}:null;
 }
 const current=await geminiSourceAssessment(job,source),accepted=job.report.sourceAssessment;
 const sourceBinding=accepted?.snapshotSha256===current.snapshotSha256?'CURRENT':'STALE_SOURCE';
 const report={...job.report,outputKind:'STORED_TRANSCRIPT_SUMMARY',summaryCompletion:'COMPLETE',sourceBinding,currentSourceAssessment:current};
 return {...job,status:sourceBinding==='CURRENT'?accepted.status:'SOURCE_REVIEW_REQUIRED',summaryCompletion:'COMPLETE',sourceStatus:current.status,report,report_json:JSON.stringify(report)};
}
