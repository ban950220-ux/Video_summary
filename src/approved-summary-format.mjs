// Four-part reading format. Pure local validation/projection; no I/O or model calls.
// A matching quotation proves a reference exists, not that its interpretation is true.
export const APPROVED_SUMMARY_FORMAT='approved-four-part-v1';
export const APPROVED_SUMMARY_ABSENT='자료에서 확인되지 않음';
export const APPROVED_SUMMARY_LEGACY_ABSENT='기존 보고서에 구분 저장되지 않음';
const encoder=new TextEncoder();
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=code=>{throw Object.assign(new Error('APPROVED_SUMMARY_'+code),{code:'APPROVED_SUMMARY_'+code});};
const fields=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>own(value,key));
const validText=(value,max=12000)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const line=(value,max)=>validText(value,max)&&!/[\r\n\u2028\u2029]/.test(value);
const unique=values=>Array.isArray(values)&&new Set(values).size===values.length;
const plain=value=>JSON.parse(JSON.stringify(value));
const payloadKeys=['formatVersion','keyConclusion','outline','causalDetails','assumptions','counterexamples'];
const metadataKeys=['sourceBinding','semanticReview','structuralValidation'];

// Synchronous SHA-256 keeps the browser and synchronous TXT exporter on one exact
// source identity. Tests compare this implementation against node:crypto vectors.
const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rotate=(n,bits)=>(n>>>bits)|(n<<(32-bits));
export function approvedSummaryDigest(text){
 const bytes=encoder.encode(text),padded=new Uint8Array(Math.ceil((bytes.length+9)/64)*64);
 padded.set(bytes);padded[bytes.length]=0x80;
 const data=new DataView(padded.buffer),bitLength=bytes.length*8;
 data.setUint32(padded.length-8,Math.floor(bitLength/0x100000000));data.setUint32(padded.length-4,bitLength>>>0);
 const h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]),w=new Uint32Array(64);
 for(let offset=0;offset<padded.length;offset+=64){
  for(let i=0;i<16;i++)w[i]=data.getUint32(offset+i*4);
  for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+w[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10)))>>>0;}
  let [a,b,c,d,e,f,g,z]=h;
  for(let i=0;i<64;i++){const t1=(z+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0,t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
  for(const [i,value] of [a,b,c,d,e,f,g,z].entries())h[i]=(h[i]+value)>>>0;
 }
 return Array.from(h,value=>value.toString(16).padStart(8,'0')).join('');
}

function sourceRows(segments){
 if(!Array.isArray(segments)||segments.length===0||segments.length>50000)fail('SOURCE_INVALID');
 const ids=new Set();let lastStart=-1;
 return segments.map(s=>{
  if(!record(s)||!Number.isSafeInteger(s.id)||s.id<1||ids.has(s.id)||!validText(s.text,1500000))fail('SOURCE_INVALID');
  ids.add(s.id);
  const start=s.startMs??null,end=s.endMs??null;
  if(start!==null&&(!Number.isSafeInteger(start)||start<0||start<lastStart))fail('SOURCE_TIMESTAMP_INVALID');
  if(end!==null&&(!Number.isSafeInteger(end)||end<0||(start!==null&&end<start)))fail('SOURCE_TIMESTAMP_INVALID');
  if(start!==null)lastStart=start;
  return [s.id,start,end,s.text];
 });
}
export function approvedSummarySourceDigest(segments){return approvedSummaryDigest(JSON.stringify(sourceRows(segments)));}

function references(value,source,absent=false){
 if(!unique(value.evidenceIds)||value.evidenceIds.length>5000||!Array.isArray(value.sourceQuotes)||value.sourceQuotes.length>5000)fail('EVIDENCE_INVALID');
 if(absent){if(value.text!==APPROVED_SUMMARY_ABSENT||value.evidenceIds.length||value.sourceQuotes.length)fail('ABSENCE_MISREPRESENTED');return;}
 if(!value.evidenceIds.length||value.evidenceIds.some(id=>!Number.isSafeInteger(id)||!source.has(id)))fail('EVIDENCE_INVALID');
 const quoted=new Set();
 for(const q of value.sourceQuotes){
  if(!fields(q,['id','quote'])||!value.evidenceIds.includes(q.id)||!validText(q.quote,1200)||!source.get(q.id).includes(q.quote)||quoted.has(q.id))fail('SOURCE_QUOTE_MISMATCH');
  quoted.add(q.id);
 }
 if(value.evidenceIds.some(id=>!quoted.has(id)))fail('SOURCE_QUOTE_MISSING');
}
function statement(value,source,{chapterIds=null,causal=false}={}){
 const keys=['status','text','evidenceIds','sourceQuotes',...(chapterIds?['chapterIds']:[])];
 if(!fields(value,keys)||!validText(value.text))fail('STATEMENT_INVALID');
 const absent=causal?'NOT_ESTABLISHED':'NOT_FOUND';
 if(!['SOURCE_STATED',absent].includes(value.status))fail('STATUS_INVALID');
 if(chapterIds&&(!unique(value.chapterIds)||!value.chapterIds.length||value.chapterIds.some(id=>!chapterIds.has(id))))fail('CHAPTER_LINK_INVALID');
 references(value,source,value.status===absent);
}

export function validateApprovedSummary(payload,segments){
 if(!fields(payload,payloadKeys)||payload.formatVersion!==APPROVED_SUMMARY_FORMAT)fail('SCHEMA_INVALID');
 if(encoder.encode(JSON.stringify(payload)).byteLength>750000)fail('PAYLOAD_TOO_LARGE');
 const rows=sourceRows(segments),source=new Map(rows.map(([id,,,text])=>[id,text])),byId=new Map(rows.map(row=>[row[0],row]));
 statement(payload.keyConclusion,source);
 if(!Array.isArray(payload.outline)||!payload.outline.length||payload.outline.length>200)fail('OUTLINE_INVALID');
 const chapters=new Set();let lastStart=-1;
 for(const chapter of payload.outline){
  if(!fields(chapter,['id','title','oneLineSummary','evidenceIds','sourceQuotes'])||typeof chapter.id!=='string'||!/^c[1-9][0-9]{0,3}$/.test(chapter.id)||chapters.has(chapter.id)||!line(chapter.title,120)||!line(chapter.oneLineSummary,500))fail('OUTLINE_INVALID');
  chapters.add(chapter.id);references(chapter,source);
  const starts=chapter.evidenceIds.map(id=>byId.get(id)[1]).filter(value=>value!==null);
  if(starts.length){const first=Math.min(...starts);if(first<lastStart)fail('OUTLINE_ORDER_INVALID');lastStart=first;}
 }
 for(const key of ['causalDetails','assumptions','counterexamples']){
  if(!Array.isArray(payload[key])||!payload[key].length||payload[key].length>600)fail('SECTION_MISSING');
  const covered=new Set();
  for(const item of payload[key]){statement(item,source,{chapterIds:chapters,causal:key==='causalDetails'});for(const id of item.chapterIds)covered.add(id);}
  if([...chapters].some(id=>!covered.has(id)))fail('CHAPTER_CONTEXT_MISSING');
 }
 return {...plain(payload),sourceBinding:{kind:'EXACT_TRANSCRIPT_SEGMENTS_V1',segmentsSha256:approvedSummaryDigest(JSON.stringify(rows))},structuralValidation:'REFERENCES_QUOTES_LINKS_ONLY',semanticReview:'NOT_PERFORMED'};
}
export function approvedSummaryEvidenceIds(payload){
 if(!record(payload))return [];
 return [...new Set([payload.keyConclusion,...(payload.outline??[]),...(payload.causalDetails??[]),...(payload.assumptions??[]),...(payload.counterexamples??[])].flatMap(item=>Array.isArray(item?.evidenceIds)?item.evidenceIds:[]))];
}
function responsePayload(stored){return Object.fromEntries(payloadKeys.map(key=>[key,stored[key]]));}

export function approvedSummaryPrompt(){
 return '\n승인한 한국어 네 부분 형식 '+APPROVED_SUMMARY_FORMAT+'. 기존 summary,chapters,claims,numbers,critical,conclusion을 유지하고 approvedSummary 객체도 반드시 출력하라. '+
 'approvedSummary에는 formatVersion,keyConclusion,outline,causalDetails,assumptions,counterexamples만 넣는다. formatVersion은 "'+APPROVED_SUMMARY_FORMAT+'". '+
 'keyConclusion={status,text,evidenceIds,sourceQuotes}이며 핵심 결론을 먼저 쓴다. outline은 {id,title,oneLineSummary,evidenceIds,sourceQuotes} 배열이고 id는 c1,c2 순서, 제목은 120자 이내, 한 줄 요약은 개행 없이 500자 이내다. 실제 전사 시간순으로 목차를 만들며 타임스탬프 숫자를 생성하지 마라. 시각은 앱이 근거 전사에서 계산한다. '+
 'causalDetails,assumptions,counterexamples는 각각 {chapterIds,status,text,evidenceIds,sourceQuotes} 배열이다. 각 목차를 세 배열 모두에서 연결하되 관련 자료가 없으면 명시적인 미확인 항목으로 연결한다. '+
 '근거가 있는 항목의 status는 SOURCE_STATED다. sourceQuotes는 evidenceIds의 각 번호에 대해 {id,quote} 하나씩이며 quote는 해당 전사에 실제 존재하는 짧은 연속 원문이다. 전사에 나온 주장이라는 뜻이며 외부 사실 확인이나 인과관계 입증을 뜻하지 않는다. '+
 '인과 설명은 원문이 실제로 주장한 원인·과정·결과·조건을 자세히 설명하되 연관성만 있는 자료를 원인으로 바꾸지 마라. 원문에서 설명하지 않은 기전은 미확인이라고 명시하고 만들어내지 마라. 원문에 인과 설명 자체가 없으면 causalDetails.status=NOT_ESTABLISHED로 둔다. '+
 '전제와 반례는 원문에서 확인한 것만 각각 assumptions/counterexamples에 넣고, 원문에 있는 반례를 생략하지 마라. 그 밖의 미확인 상태는 NOT_FOUND다. 미확인 항목은 text="'+APPROVED_SUMMARY_ABSENT+'", evidenceIds=[], sourceQuotes=[]로 쓴다. '+
 '부정·확률·조건·수치·단위·시점·화자 귀속을 보존하라. 인과관계나 반례를 채우려고 새 사실을 만들지 마라. 전체 원음이 아니라 제공된 저장 전사에 한정한다. 외부 출처 URL·검증 통과·semanticReview·sourceBinding·새 timestamp 필드를 생성하지 마라.\n';
}

export function approvedSummaryClock(ms){
 if(!Number.isSafeInteger(ms)||ms<0)return '시각 미확인';
 const seconds=Math.floor(ms/1000);return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(value=>String(value).padStart(2,'0')).join(':');
}
const originalItems=value=>Array.isArray(value)?value.map(item=>typeof item==='string'?{text:item,evidenceIds:[]}:{text:typeof item?.text==='string'?item.text:'',evidenceIds:Array.isArray(item?.evidenceIds)?item.evidenceIds.filter(Number.isSafeInteger):[]}):[];
function legacySections(report){
 const labels={summary:'기존 핵심 요약',chapters:'기존 시간대별 상세 요약',claims:'기존 주장과 근거',numbers:'기존 수치·검증 항목',critical:'기존 비판적 분석'};
 return [...Object.entries(labels).map(([key,label])=>({key,label,items:originalItems(report[key])})),{key:'conclusion',label:'기존 결론',items:typeof report.conclusion==='string'?[{text:report.conclusion,evidenceIds:[]}]:[]}];
}
function scopeView(job,source){
 const report=job.report??{},audit=job.audit??{},states=[job.status,audit.status,report.sourceAssessment?.status,report.mediaCoverage?.transcriptStatus];
 const partial=states.some(value=>typeof value==='string'&&/PARTIAL|INCOMPLETE/.test(value))||(Number.isFinite(audit.timelineRatio)&&audit.timelineRatio<0.98);
 return {state:partial?'PARTIAL_TRANSCRIPT':'STORED_TRANSCRIPT_ONLY',message:partial?'부분 전사 범위의 요약입니다. 확보되지 않은 구간이나 전체 영상의 결론을 대신하지 않습니다.':'저장된 전사에 한정한 요약입니다. 전체 원음 포함 여부·음성 정확성·외부 사실은 독립 검증되지 않았습니다.',provenance:typeof source?.provenance==='string'?source.provenance:'UNKNOWN'};
}
function evidenceTime(ids,byId,canTime){
 if(!canTime)return '시각 미확인 · 원문 연결 확인 필요';
 const starts=ids.map(id=>byId.get(id)?.startMs);
 if(!starts.length||starts.some(value=>!Number.isSafeInteger(value)||value<0))return '시각 미확인';
 return approvedSummaryClock(Math.min(...starts));
}
function contextMissing(chapters,causal=false,text=APPROVED_SUMMARY_LEGACY_ABSENT){return [{chapterIds:chapters.map(c=>c.id),status:causal?'NOT_ESTABLISHED':'NOT_FOUND',text,evidenceIds:[],sourceQuotes:[]}];}
function legacyView(report){
 const chapters=originalItems(report.chapters),outline=chapters.map((chapter,i)=>({id:'c'+(i+1),title:'기존 목차 '+(i+1),oneLineSummary:chapter.text.replace(/\s+/g,' ').trim().slice(0,500),evidenceIds:chapter.evidenceIds,sourceQuotes:[],legacyText:chapter.text,titleStatus:'LEGACY_DISPLAY_LABEL',oneLineStatus:'LEGACY_TEXT_EXCERPT_NOT_NEW_SUMMARY'}));
 const text=typeof report.conclusion==='string'&&report.conclusion.trim()?report.conclusion:originalItems(report.summary).map(item=>item.text).filter(Boolean).join('\n')||APPROVED_SUMMARY_LEGACY_ABSENT;
 return {keyConclusion:{status:'LEGACY_UNVERIFIED',text,evidenceIds:[],sourceQuotes:[]},outline,causalDetails:contextMissing(outline,true),assumptions:contextMissing(outline),counterexamples:contextMissing(outline)};
}
const aiKinds=new Set(['GEMINI_EVIDENCE_LINKED','GROQ_EVIDENCE_LINKED','GEMINI_PAID_FULL_EVIDENCE_LINKED','GEMINI_TWO_PASS_REVIEWED','GEMINI_TWO_PASS_EVIDENCE_LINKED']);
export function approvedSummaryView(job,source=null){
 const report=job?.report;if(!record(report)||(!aiKinds.has(report.kind)&&!report.approvedSummary))return null;
 let sourceValid=false,byId=new Map();
 try{sourceRows(source?.segments);sourceValid=true;byId=new Map(source.segments.map(s=>[s.id,s]));}catch{/* A readable stored report must survive unavailable source metadata. */}
 let origin='LEGACY_COMPATIBILITY',sourceStatus=sourceValid?'LEGACY_CURRENT_SOURCE':'SOURCE_UNAVAILABLE',details=legacyView(report),formatError=null;
 const stored=report.approvedSummary;
 if(stored!==undefined){
  origin='INVALID_STRUCTURED';
  try{
   if(!fields(stored,[...payloadKeys,...metadataKeys])||stored.semanticReview!=='NOT_PERFORMED'||stored.structuralValidation!=='REFERENCES_QUOTES_LINKS_ONLY'||!fields(stored.sourceBinding,['kind','segmentsSha256'])||stored.sourceBinding.kind!=='EXACT_TRANSCRIPT_SEGMENTS_V1'||!/^([a-f0-9]{64})$/.test(stored.sourceBinding.segmentsSha256))fail('STORED_FORMAT_INVALID');
   if(!sourceValid){sourceStatus='SOURCE_UNAVAILABLE';formatError='SOURCE_UNAVAILABLE';}
   else if(approvedSummarySourceDigest(source.segments)!==stored.sourceBinding.segmentsSha256){sourceStatus='STALE_SOURCE';formatError='SOURCE_CHANGED';}
   else{
    const checked=validateApprovedSummary(responsePayload(stored),source.segments);
    if(!same(checked,stored))fail('STORED_FORMAT_INVALID');
    origin='APPROVED_STRUCTURED';sourceStatus='MATCHED';details=responsePayload(stored);
   }
  }catch{formatError='STORED_FORMAT_INVALID';sourceStatus='UNVERIFIED';}
 }
 if(report.sourceBinding==='STALE_SOURCE'){sourceStatus='STALE_SOURCE';formatError??='SOURCE_CHANGED';}
 const canTime=sourceValid&&!['STALE_SOURCE','UNVERIFIED','SOURCE_UNAVAILABLE'].includes(sourceStatus);
 const outline=details.outline.map(item=>({...plain(item),timestampLabel:evidenceTime(item.evidenceIds,byId,canTime)}));
 const ids=origin==='APPROVED_STRUCTURED'?approvedSummaryEvidenceIds(stored):[...new Set(legacySections(report).flatMap(section=>section.items.flatMap(item=>item.evidenceIds)))];
 const sources=ids.filter(id=>byId.has(id)).map(id=>({id,timestampLabel:evidenceTime([id],byId,canTime),text:canTime?byId.get(id).text:'원문 연결이 바뀌었거나 확인되지 않아 현재 전사를 근거로 연결하지 않았습니다.',provenance:typeof source?.provenance==='string'?source.provenance:'UNKNOWN'}));
 return {formatVersion:APPROVED_SUMMARY_FORMAT,origin,sourceStatus,formatError,scope:scopeView(job,source),semanticReview:'NOT_PERFORMED',semanticReviewMessage:'형식·근거 인용 검사와 의미 품질 검토는 별개입니다. 실제 의미 품질은 독립 검토되지 않았습니다.',...details,outline,sources,legacySections:legacySections(report),legacyPreserved:true,structuredPayloadPreserved:stored!==undefined,invalidStructuredPayload:origin==='INVALID_STRUCTURED'?plain(stored):null};
}
export function projectApprovedSummary(job,source=null){return {...job,approvedSummaryView:approvedSummaryView(job,source)};}

const refs=item=>item?.evidenceIds?.length?' (전사 근거 '+item.evidenceIds.map(id=>'#'+id).join(', ')+')':'';
export function approvedSummaryMarkdown(view){
 if(!view)return [];
 const lines=['## ① 핵심 결론','',view.keyConclusion.text+refs(view.keyConclusion),'',view.scope.message,'',view.semanticReviewMessage,''];
 if(view.origin!=='APPROVED_STRUCTURED')lines.push('- 기존 보고서를 보존한 호환 표시입니다. 새 형식의 의미 검토나 재생성을 완료한 것이 아닙니다.','');
 if(view.formatError)lines.push('- 원문 연결/형식 확인 필요: '+view.formatError,'');
 lines.push('## ② 타임스탬프와 목차별 한 줄 요약','');
 for(const item of view.outline)lines.push(`- [${item.timestampLabel}] ${item.id} · ${item.title}: ${item.oneLineSummary}${refs(item)}${item.oneLineStatus?' · 기존 본문 발췌, 새 한 줄 요약 아님':''}`);
 if(!view.outline.length)lines.push(APPROVED_SUMMARY_LEGACY_ABSENT);
 lines.push('','## ③ 인과관계 상세 설명','');
 const add=items=>{for(const item of items)lines.push(`- ${item.chapterIds?.join(', ')||'전체'} · ${item.status==='SOURCE_STATED'?'전사에서 제시된 설명 · 의미 미검토':'미확인'}: ${item.text}${refs(item)}`);};
 add(view.causalDetails);lines.push('','## ④ 가정·반례·출처','','### 가정·전제','');add(view.assumptions);lines.push('','### 반례','');add(view.counterexamples);lines.push('','### 전사 출처','');
 for(const item of view.sources)lines.push(`- #${item.id} [${item.timestampLabel}] (${item.provenance}): ${item.text}`);
 if(!view.sources.length)lines.push('연결할 수 있는 전사 근거 없음');
 lines.push('','- 외부 사실 확인: 미수행','');
 if(view.invalidStructuredPayload)lines.push('### 연결 미확인 구조화 원본 보존','','현재 전사에 재연결하거나 검증된 결과로 표시하지 않은 저장 원본입니다.','',JSON.stringify(view.invalidStructuredPayload,null,2),'');
 return lines;
}
