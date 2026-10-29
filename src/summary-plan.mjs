import {InputError} from './core.mjs';
import {reportPrompt} from './report.mjs';
import {approvedSummaryPrompt,approvedSummaryEvidenceIds} from './approved-summary-format.mjs';

export const APPROVED_FORMAT_PROFILE='approved-four-part-v1';
export const LEGACY_FORMAT_PROFILE='legacy-six-field-v1';
export function summaryFormatOptions(value){
 if(value===undefined||value===null||value===LEGACY_FORMAT_PROFILE)return {};
 if(value!==APPROVED_FORMAT_PROFILE)throw new InputError('지원하지 않는 요약 형식입니다. 저장된 보고서는 변경하지 않습니다.');
 return {formatProfile:APPROVED_FORMAT_PROFILE};
}

// 4 conservative units per prompt character plus 16,384 output units.
// Leave room below the maximum 250,000-unit app grant for each request.
export const SUMMARY_PROMPT_LIMIT=50_000;
export const summaryUnits=prompt=>prompt.length*4+16_384;

export function partitionTranscript(segments,audit,options={}){
 const groups=[];let current=[];
 for(const segment of segments){
  const next=[...current,segment];
  if(reportPrompt(next,audit,options).length>SUMMARY_PROMPT_LIMIT){
   if(!current.length)throw new InputError('전사 한 구간이 요약 입력 한도를 초과합니다. 원문을 안전하게 나눈 뒤 다시 저장하세요.');
   groups.push(current);current=[segment];
   if(reportPrompt(current,audit,options).length>SUMMARY_PROMPT_LIMIT)throw new InputError('전사 한 구간이 요약 입력 한도를 초과합니다.');
  }else current=next;
 }
 if(current.length)groups.push(current);
 return groups;
}

export function synthesisPrompt(groups,audit,options={}){
 const format=options.formatProfile===APPROVED_FORMAT_PROFILE?'\n'+approvedSummaryPrompt()+'\n앞 단계 approvedSummary의 근거와 미확인 상태를 보존하여 전체 읽기 형식을 작성한다. 원문에 없던 인과관계나 반례를 새로 추론하지 않는다. 근거 ID와 인용은 입력 보고서에 보존된 원문 근거만 사용한다.':'';
 return '당신은 영상 분석가다. 다음은 앞 단계에서 전사 원문만으로 만든 시간 순서별 부분 보고서다. 부분 보고서를 전체 범위에 걸쳐 종합하라. 입력에 없는 사실을 만들지 말고 한국어 JSON만 출력하라. summary,chapters,claims,numbers,critical은 각각 {text:string,evidenceIds:number[]} 배열이며 conclusion은 문자열이다. evidenceIds는 아래 보고서에 있는 원본 전사 segment id만 사용한다. chapters에서 모든 입력 시간 구간을 빠뜨리지 말고 각각 근거를 연결한다. 부분 전사·미검증 구간은 숨기지 않는다. 외부 사실 검증을 했다고 주장하지 않는다. 출력 스키마 외 값을 넣지 않는다.'+format+'\n범위검증:'+JSON.stringify(audit)+'\n시간 순서별 부분 보고서:\n'+JSON.stringify(groups);
}

export function partitionSynthesis(groups,audit,options={}){
 const batches=[];let current=[];
 for(const group of groups){
  const next=[...current,group];
  if(synthesisPrompt(next,audit,options).length>SUMMARY_PROMPT_LIMIT){
   if(!current.length)throw new InputError('부분 보고서가 요약 입력 한도를 초과합니다.');
   batches.push(current);current=[group];
   if(synthesisPrompt(current,audit,options).length>SUMMARY_PROMPT_LIMIT)throw new InputError('부분 보고서가 요약 입력 한도를 초과합니다.');
  }else current=next;
 }
 if(current.length)batches.push(current);
 if(groups.length>1&&batches.length===groups.length)throw new InputError('부분 보고서를 안전하게 합칠 수 없습니다. 원문을 검토하세요.');
 return batches;
}

export function evidenceIds(report){
 return [...new Set([...['summary','chapters','claims','numbers','critical'].flatMap(key=>(report[key]||[]).flatMap(item=>item.evidenceIds||[])),...(report.approvedSummary?approvedSummaryEvidenceIds(report.approvedSummary):[])])];
}

// Keep the historical fingerprint byte-for-byte for legacy callers. A new
// format has a distinct namespace and binds the actual prompt contract too.
export async function summaryFingerprint(segments,audit,options={}){
 const data=options.formatProfile===APPROVED_FORMAT_PROFILE
  ?[segments,audit,APPROVED_FORMAT_PROFILE,reportPrompt([],audit,options),synthesisPrompt([],audit,options),SUMMARY_PROMPT_LIMIT]
  :[segments,audit];
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data))))).map(x=>x.toString(16).padStart(2,'0')).join('');
}

export function assertGroupCoverage(report,groups){
 const refs=new Set((report.chapters||[]).flatMap(item=>item.evidenceIds||[]));
 if(groups.some(group=>!group.ids.some(id=>refs.has(id))))throw new InputError('시간 구간 근거가 빠진 요약입니다. 전체 보고서로 저장하지 않습니다.');
}
