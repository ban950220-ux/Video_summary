import {validateAnalysis} from './report.mjs';
import {assertGroupCoverage} from './summary-plan.mjs';

// Offline candidate only. It never changes the failed operation or usage row.
// The caller must separately review the receipt and persisted usage evidence.
export const YEAR_RECOVERY_CONTRACT='abbreviated-year-source-preserving-v1';
const encoder=new TextEncoder();
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(typeof value==='string'?value:JSON.stringify(value))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
const fail=code=>{throw Error(code);};
const fields=['summary','chapters','claims','numbers','critical'];
const fullYears=[['2022년','22년'],['2023년','23년']];
const token=(value)=>new RegExp('(?<!\\d)'+value+'(?!\\d)','g');
// A two-digit "년" can describe elapsed time. This is deliberately a narrow
// spelling repair, so contextual ambiguity must go to human review.
// A short form is eligible only when the source itself anchors the century.
// Bare “22년” is also a duration, so it must remain for source-excerpt review.
const calendarContext=(text,year)=>[...text.matchAll(token(year))].every(match=>/2020년대(?:의|인)?\s*$/.test(text.slice(Math.max(0,match.index-24),match.index)));
const durationContext=(text,year)=>[...text.matchAll(token(year))].some(match=>{
 const before=text.slice(Math.max(0,match.index-28),match.index).split(/[.!?。！？,，;；]/).at(-1);
 const after=text.slice(match.index+year.length,match.index+year.length+18).split(/[.!?。！？,，;；]/)[0];
 return /(?:기간|동안|경력|근속|재직|소요|걸쳐|연차|연구|살아온|지난)\s*(?:은|는|이|가|을|를|에|의)?\s*$/.test(before)||/^\s*(?:간|동안|째|차|만에|만의|이?\s*넘|이?\s*지났|이?\s*흘렀|에 걸쳐|이었|이었다|을 보냈)/.test(after);
});

export async function abbreviatedYearRecoveryCandidate({stage,sourceHash,auditSha256,failedOperationId,failedResultJson,usageEvidence,approvalEvidence,segments,verifyGrounding}){
 if(!/^raw:(0|[1-9][0-9]*)$/.test(stage??'')||!/^[a-f0-9]{64}$/.test(sourceHash??'')||!/^[a-f0-9]{64}$/.test(auditSha256??'')||typeof failedOperationId!=='string'||!failedOperationId||typeof failedResultJson!=='string'||!Array.isArray(segments)||!segments.length||typeof verifyGrounding!=='function'||usageEvidence?.unit!=='actual_total_tokens')fail('YEAR_RECOVERY_SCOPE_INVALID');
 let approval;try{approval=JSON.parse(approvalEvidence.resultJson);}catch{fail('YEAR_RECOVERY_APPROVAL_INVALID');}
 const stageIndex=Number(stage.slice(4));
 if(!approval||approvalEvidence.state!=='STOPPED'||approvalEvidence.id!==approval.jobId+':groq-summary:approval:'+approval.sequence||failedOperationId!==approval.jobId+':groq-summary:'+sourceHash+':'+stage||approval.transcriptHash!==sourceHash||approval.model!=='openai/gpt-oss-120b'||!['FULL_VIDEO_SYNTHESIS','RAW_CHECKPOINTS_WITH_REVIEW_GAP'].includes(approval.outputKind)||approval.freeTierConfirmed!==true||approval.billingDisabled!==true||approval.maxInputTokensPerRequest!==4800||approval.maxCompletionTokensPerRequest!==1800||!Number.isSafeInteger(approval.windowStart)||!Number.isSafeInteger(approval.maxRequests)||stageIndex<approval.windowStart||stageIndex>=approval.windowStart+approval.maxRequests)fail('YEAR_RECOVERY_APPROVAL_INVALID');
 let saved,data;try{saved=JSON.parse(failedResultJson);data=JSON.parse(saved.reviewResult.partialText);}catch{fail('YEAR_RECOVERY_RESPONSE_INVALID');}
 const raw=saved.reviewResult.partialText,usage=saved.reviewResult.usage;
 if(!raw||raw.length>=12000||!Number.isSafeInteger(usage?.inputTokens)||usage.inputTokens<0||usage.inputTokens>4800||!Number.isSafeInteger(usage?.outputTokens)||usage.outputTokens<0||usage.outputTokens>1800||!Number.isSafeInteger(usage?.totalTokens)||usage.totalTokens<=0||usage.totalTokens>6600||usage.totalTokens<usage.inputTokens+usage.outputTokens||usage.totalTokens!==usageEvidence.totalTokens||!(usage.reasoningTokens===null||Number.isSafeInteger(usage.reasoningTokens)&&usage.reasoningTokens>=0&&usage.reasoningTokens<=usage.outputTokens))fail('YEAR_RECOVERY_USAGE_INVALID');
 if(!data||Array.isArray(data)||JSON.stringify(Object.keys(data).sort())!==JSON.stringify([...fields,'conclusion'].sort())||fields.some(field=>!Array.isArray(data[field])||data[field].some(item=>!item||Array.isArray(item)||JSON.stringify(Object.keys(item).sort())!=='["evidenceIds","text"]')))fail('YEAR_RECOVERY_RESPONSE_INVALID');
 const original=validateAnalysis(data,segments,'groq');assertGroupCoverage(original,[{ids:segments.map(item=>item.id)}]);
 try{verifyGrounding(original,segments);fail('YEAR_RECOVERY_NOT_NEEDED');}catch(error){if(error.message!=='UNSUPPORTED_NUMBER')throw error;}
 const derived=structuredClone(data),byId=new Map(segments.map(item=>[item.id,item])),changes=[];
 const transform=(text,ids,field,index)=>{
  let output=text;
  for(const [from,to] of fullYears){
   const matches=[...text.matchAll(token(from))];if(!matches.length)continue;
   const cited=ids.map(id=>byId.get(id)).filter(Boolean);
   // An already supported four-digit date must remain untouched. A different
   // cited segment with a matching short spelling cannot override that fact.
   if(cited.some(item=>token(from).test(item.text)))continue;
   const candidates=cited.filter(item=>token(to).test(item.text));
   if(candidates.length!==1)fail('YEAR_RECOVERY_SOURCE_AMBIGUOUS');
   if([...candidates[0].text.matchAll(token(to))].length!==1||!calendarContext(candidates[0].text,to)||durationContext(candidates[0].text,to))fail('YEAR_RECOVERY_SOURCE_AMBIGUOUS');
   for(const match of matches)changes.push({field,index,from,to,offset:match.index,evidenceIds:[...ids],source:{id:candidates[0].id,startMs:candidates[0].startMs,endMs:candidates[0].endMs,textSha256:null}});
   output=output.replaceAll(token(from),to);
  }
  return output;
 };
 for(const field of fields)for(let index=0;index<derived[field].length;index++)derived[field][index].text=transform(derived[field][index].text,derived[field][index].evidenceIds,field,index);
 derived.conclusion=transform(derived.conclusion,segments.map(item=>item.id),'conclusion',0);
 if(changes.length!==2||new Set(changes.map(item=>item.from)).size!==2)fail('YEAR_RECOVERY_CHANGE_SET_INVALID');
 for(const change of changes)change.source.textSha256=await hash(byId.get(change.source.id).text);
 const report=validateAnalysis(derived,segments,'groq');assertGroupCoverage(report,[{ids:segments.map(item=>item.id)}]);verifyGrounding(report,segments);
 const record={contract:YEAR_RECOVERY_CONTRACT,stage,sourceHash,auditSha256,approvalId:approvalEvidence.id,approvalResultSha256:await hash(approvalEvidence.resultJson),failedOperationId,failedResultSha256:await hash(failedResultJson),originalResponseSha256:await hash(raw),confirmedUsage:{unit:'actual_total_tokens',totalTokens:usage.totalTokens},transformations:changes,derivedResponseSha256:await hash(derived),derivedReport:report,providerCalls:0,originalFailurePreserved:true};
 return {...record,recordSha256:await hash(record)};
}
