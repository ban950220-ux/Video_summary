import {ProviderError} from './adapters.mjs';
import {PAID_SUMMARY_SCHEMA} from './paid-summary-contract.mjs';
import {validateAnalysis} from './report.mjs';
import {assertGrounding} from './groq-summary.mjs';

const fail=code=>{const error=new ProviderError('TWO_PASS_WINDOW_INVALID','Transcript window evidence did not match the stored source.');error.safeValidationCode=code;throw error;};
export const WINDOW_MS=600_000;

export function windowManifest(source){
 const segments=source?.segments;
 if(!Array.isArray(segments)||!segments.length)fail('WINDOW_SOURCE_INVALID');
 let previousStart=-1,previousId=0,duration=0;
 for(const segment of segments){
  if(!Number.isSafeInteger(segment.id)||segment.id!==previousId+1||!Number.isSafeInteger(segment.startMs)||!Number.isSafeInteger(segment.endMs)||segment.startMs<0||segment.startMs<previousStart||segment.endMs<=segment.startMs||typeof segment.text!=='string'||!segment.text.trim())fail('WINDOW_SOURCE_INVALID');
  previousId=segment.id;previousStart=segment.startMs;duration=Math.max(duration,segment.endMs);
 }
 const windows=[];for(let startMs=0;startMs<duration;startMs+=WINDOW_MS){
  const endMs=Math.min(startMs+WINDOW_MS,duration),index=windows.length;
  // A segment's start timestamp owns it. Earlier segments crossing this
  // boundary are references only and cannot satisfy this window's coverage.
  const primaryIds=segments.filter(s=>s.startMs>=startMs&&s.startMs<endMs).map(s=>s.id);
  const boundaryIds=segments.filter(s=>s.startMs<startMs&&s.endMs>startMs).map(s=>s.id);
  windows.push({key:`w${index.toString().padStart(3,'0')}`,startMs,endMs,primaryIds,boundaryIds});
 }
 return windows;
}

export function windowedSummarySchema(source){
 const windows=windowManifest(source);
 return {...PAID_SUMMARY_SCHEMA,properties:{...PAID_SUMMARY_SCHEMA.properties,chapters:{type:'array',items:{type:'object',properties:{windowKey:{type:'string',enum:windows.map(w=>w.key)},kind:{type:'string',enum:['CONTENT','NON_SUBSTANTIVE','TRANSCRIPT_GAP','BOUNDARY_ONLY']},text:{type:'string'},evidenceIds:{type:'array',items:{type:'integer'}}},required:['windowKey','kind','text','evidenceIds'],additionalProperties:false}}}};
}

export function validateWindowedSummary(raw,source){
 let parsed;try{parsed=JSON.parse(raw);}catch{fail('WINDOW_OUTPUT_INVALID');}
 const windows=windowManifest(source),byKey=new Map(windows.map(w=>[w.key,w])),seen=new Set();
 if(!parsed||!Array.isArray(parsed.chapters))fail('WINDOW_OUTPUT_INVALID');
 for(const [index,chapter] of parsed.chapters.entries()){
  const window=byKey.get(chapter?.windowKey);
  if(!window||window.key!==windows[index]?.key||seen.has(window.key)||!['CONTENT','NON_SUBSTANTIVE','TRANSCRIPT_GAP','BOUNDARY_ONLY'].includes(chapter.kind)||typeof chapter.text!=='string'||!chapter.text.trim()||!Array.isArray(chapter.evidenceIds)||Object.keys(chapter).sort().join(',')!=='evidenceIds,kind,text,windowKey')fail('WINDOW_OUTPUT_INVALID');
  seen.add(window.key);
  if(chapter.kind==='TRANSCRIPT_GAP'){
   if(window.primaryIds.length||window.boundaryIds.length||chapter.evidenceIds.length)fail('WINDOW_EVIDENCE_OUT_OF_RANGE');
  }else if(chapter.kind==='BOUNDARY_ONLY'){
   if(window.primaryIds.length||!window.boundaryIds.length||!chapter.evidenceIds.length||chapter.evidenceIds.some(id=>!window.boundaryIds.includes(id)))fail('WINDOW_EVIDENCE_OUT_OF_RANGE');
  }else if(!chapter.evidenceIds.some(id=>window.primaryIds.includes(id))||chapter.evidenceIds.some(id=>!window.primaryIds.includes(id)&&!window.boundaryIds.includes(id)))fail('WINDOW_EVIDENCE_OUT_OF_RANGE');
  if(chapter.kind==='NON_SUBSTANTIVE'&&chapter.text.trim().length<10)fail('WINDOW_NON_SUBSTANTIVE_UNEXPLAINED');
 }
 if(seen.size!==windows.length)fail('WINDOW_COVERAGE_INCOMPLETE');
 const checked={...parsed,chapters:parsed.chapters.filter(c=>!['TRANSCRIPT_GAP','BOUNDARY_ONLY'].includes(c.kind)).map(({text,evidenceIds})=>({text,evidenceIds}))};
 let report;try{report=validateAnalysis(checked,source.segments,'gemini');assertGrounding(report,source.segments);}catch{fail('WINDOW_GROUNDING_INVALID');}
 return {...report,chapters:parsed.chapters,kind:'GEMINI_TWO_PASS_WINDOW_DRAFT',outputKind:'WINDOWED_DRAFT',synthesisComplete:false,evidenceValidation:'REFERENCES_WINDOWS_NUMBERS_QUOTES_ONLY',windowValidation:'TIMESTAMP_PRIMARY_IDS_AND_BOUNDARY_REFERENCES',semanticReview:'NOT_PERFORMED',sourceReview:'REQUIRED',audioAccuracy:'NOT_VERIFIED',externalFactCheck:'NOT_PERFORMED'};
}
