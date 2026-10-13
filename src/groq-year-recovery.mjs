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

export async function abbreviatedYearRecoveryCandidate({stage,sourceHash,auditSha256,failedOperationId,failedResultJson,usageEvidence,segments,verifyGrounding}){
 if(!/^raw:(0|[1-9][0-9]*)$/.test(stage??'')||!/^[a-f0-9]{64}$/.test(sourceHash??'')||!/^[a-f0-9]{64}$/.test(auditSha256??'')||typeof failedOperationId!=='string'||!failedOperationId||typeof failedResultJson!=='string'||!Array.isArray(segments)||!segments.length||typeof verifyGrounding!=='function'||usageEvidence?.unit!=='actual_total_tokens')fail('YEAR_RECOVERY_SCOPE_INVALID');
 let saved,data;try{saved=JSON.parse(failedResultJson);data=JSON.parse(saved.reviewResult.partialText);}catch{fail('YEAR_RECOVERY_RESPONSE_INVALID');}
 const raw=saved.reviewResult.partialText,usage=saved.reviewResult.usage;
 if(!raw||raw.length>=12000||!Number.isSafeInteger(usage?.inputTokens)||!Number.isSafeInteger(usage?.outputTokens)||!Number.isSafeInteger(usage?.totalTokens)||usage.totalTokens<=0||usage.totalTokens<usage.inputTokens+usage.outputTokens||usage.totalTokens!==usageEvidence.totalTokens||!(usage.reasoningTokens===null||Number.isSafeInteger(usage.reasoningTokens)&&usage.reasoningTokens>=0&&usage.reasoningTokens<=usage.outputTokens))fail('YEAR_RECOVERY_USAGE_INVALID');
 if(!data||Array.isArray(data)||JSON.stringify(Object.keys(data).sort())!==JSON.stringify([...fields,'conclusion'].sort())||fields.some(field=>!Array.isArray(data[field])||data[field].some(item=>!item||Array.isArray(item)||JSON.stringify(Object.keys(item).sort())!=='["evidenceIds","text"]')))fail('YEAR_RECOVERY_RESPONSE_INVALID');
 const original=validateAnalysis(data,segments,'groq');assertGroupCoverage(original,[{ids:segments.map(item=>item.id)}]);
 try{verifyGrounding(original,segments);fail('YEAR_RECOVERY_NOT_NEEDED');}catch(error){if(error.message!=='UNSUPPORTED_NUMBER')throw error;}
 const derived=structuredClone(data),byId=new Map(segments.map(item=>[item.id,item])),changes=[];
 const transform=(text,ids,field,index)=>{
  let output=text;
  for(const [from,to] of fullYears){
   const matches=[...text.matchAll(token(from))];if(!matches.length)continue;
   const candidates=ids.map(id=>byId.get(id)).filter(Boolean).filter(item=>token(to).test(item.text)&&!token(from).test(item.text));
   if(candidates.length!==1)fail('YEAR_RECOVERY_SOURCE_AMBIGUOUS');
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
 const record={contract:YEAR_RECOVERY_CONTRACT,stage,sourceHash,auditSha256,failedOperationId,failedResultSha256:await hash(failedResultJson),originalResponseSha256:await hash(raw),confirmedUsage:{unit:'actual_total_tokens',totalTokens:usage.totalTokens},transformations:changes,derivedResponseSha256:await hash(derived),derivedReport:report,providerCalls:0,originalFailurePreserved:true};
 return {...record,recordSha256:await hash(record)};
}
