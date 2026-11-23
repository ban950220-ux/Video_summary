// A read-only renderer. It never requests a provider, rewrites a saved report,
// interprets HTML, or upgrades structural evidence to a semantic review.
const FORMAT='approved-four-part-v1';
const MISSING='자료에서 확인되지 않음';
const UNKNOWN_TIME='시각 미확인';
const LEGACY_MISSING='기존 보고서에 구분 저장되지 않음';
const text=value=>typeof value==='string'?value:'';
const list=value=>Array.isArray(value)?value:[];
const ids=value=>list(value).filter(id=>Number.isSafeInteger(id)&&id>0);
let renderSequence=0;

function oldSections(report){
 return [['summary','핵심 요약'],['chapters','시간대별 요약'],['claims','주장과 근거'],['numbers','수치와 확인 항목'],['critical','비판적 분석']].map(([key,label])=>({
  key,label,items:list(report[key]).map(item=>typeof item==='string'?{text:item,evidenceIds:[]}:{text:text(item?.text),evidenceIds:ids(item?.evidenceIds)})
 }));
}

/**
 * Direct responses from older routes may not contain a source-bound view.
 * Keep their text readable, but never derive timestamps or causal categories.
 */
export function unboundApprovedSummaryView(job){
 const report=job?.report??{},payload=report.approvedSummary;
 const native=payload?.formatVersion===FORMAT;
 const outline=native?list(payload.outline).map(item=>({...item,timestampLabel:UNKNOWN_TIME})):list(report.chapters).map((item,index)=>({
  id:`legacy-${index+1}`,title:`기존 목차 ${index+1}`,oneLineSummary:LEGACY_MISSING,
  legacyText:typeof item==='string'?item:text(item?.text),evidenceIds:ids(item?.evidenceIds),timestampLabel:UNKNOWN_TIME
 }));
 const missing=()=>({status:'LEGACY_UNCLASSIFIED',text:LEGACY_MISSING,evidenceIds:[],sourceQuotes:[],chapterIds:outline.map(item=>item.id)});
 return {
  formatVersion:FORMAT,origin:native?'UNBOUND_STRUCTURED':'LEGACY_COMPATIBILITY',
  sourceStatus:report.sourceBinding==='STALE_SOURCE'?'STALE_SOURCE':'SOURCE_UNAVAILABLE',
  scope:{state:job?.status==='PARTIAL_TRANSCRIPT'||job?.audit?.status==='PARTIAL_TRANSCRIPT'?'PARTIAL_TRANSCRIPT':'STORED_TRANSCRIPT_ONLY',message:'저장된 전사 범위의 요약입니다. 전체 원음의 포함·정확성과 의미 품질은 별도 검토가 필요합니다.'},
  semanticReview:'NOT_PERFORMED',
  keyConclusion:native?payload.keyConclusion:{status:text(report.conclusion).trim()?'LEGACY_STORED':'LEGACY_UNCLASSIFIED',text:text(report.conclusion).trim()?report.conclusion:LEGACY_MISSING,evidenceIds:[],sourceQuotes:[]},
  outline,causalDetails:native?list(payload.causalDetails):[missing()],
  assumptions:native?list(payload.assumptions):[missing()],
  counterexamples:native?list(payload.counterexamples):[missing()],
  sources:[],legacySections:oldSections(report)
 };
}

function recordLabel(status,category,sourceAvailable){
 if(status==='SOURCE_STATED')return sourceAvailable?'전사 근거 연결 · 의미 검토 필요':'전사 근거 주장 · 현재 원문 연결 미확인';
 if(status==='LEGACY_STORED'||status==='LEGACY_UNVERIFIED')return '기존 보고서 내용 보존 · 항목별 근거 연결 미확인';
 if(status==='NOT_ESTABLISHED')return '인과관계 확인되지 않음';
 if(status==='NOT_FOUND')return MISSING;
 if(status==='LEGACY_UNCLASSIFIED'||status==='LEGACY_UNSPECIFIED')return LEGACY_MISSING;
 return category==='legacy'?'기존 보고서 내용':'의미·근거 상태 미확인';
}

/** View timestamps and sources must come from the owner's server projection. */
export function renderApprovedSummary({host,job,view=job?.approvedSummaryView,document:dom=globalThis.document}){
 if(!host||!dom?.createElement)throw new TypeError('SUMMARY_RENDER_TARGET_REQUIRED');
 const model=view?.formatVersion===FORMAT?view:unboundApprovedSummaryView(job);
 const prefix=`approved-summary-${++renderSequence}`;
 const element=(tag,value,className)=>{const node=dom.createElement(tag);if(value!==undefined)node.textContent=String(value);if(className)node.className=className;return node;};
 const attr=(node,key,value)=>node.setAttribute(key,String(value));
 const section=element('section',undefined,'approved-summary');
 attr(section,'aria-label','승인한 네 부분 요약 형식');
 attr(section,'data-format-version',FORMAT);
 const sourceStatus=text(model.sourceStatus)||'SOURCE_UNAVAILABLE';
 const sourceAvailable=['MATCHED','LEGACY_CURRENT_SOURCE'].includes(sourceStatus)&&model.origin!=='INVALID_STRUCTURED';
 const sourceMap=new Map((sourceAvailable?list(model.sources):[]).filter(item=>Number.isSafeInteger(item?.id)&&item.id>0).map(item=>[item.id,item]));
 const outline=list(model.outline),chapterMap=new Map(outline.map((item,index)=>[item.id,{item,target:`${prefix}-chapter-${index+1}`}])) ;
 const referenceList=(target,record)=>{
  const references=[...new Set(ids(record?.evidenceIds))];if(!references.length)return;
  const row=element('p',undefined,'tip');row.append(element('span','전사 근거: '));
  for(const id of references){
   if(sourceMap.has(id)){const link=element('a',`#${id}`);attr(link,'href',`#${prefix}-source-${id}`);row.append(link);}
   else row.append(element('span',`#${id} · 원문 연결 미확인`));
   row.append(element('span',' '));
  }
  target.append(row);
 };
 const chapterLinks=(target,record)=>{
  const keys=list(record?.chapterIds);if(!keys.length)return;
  const row=element('p',undefined,'tip');row.append(element('span','연결 목차: '));
  for(const key of keys){const chapter=chapterMap.get(key);if(chapter){const link=element('a',text(chapter.item.title)||'제목 미확인');attr(link,'href',`#${chapter.target}`);row.append(link,element('span',' '));}}
  target.append(row);
 };
 const notes=(target,records,category)=>{
  const entries=list(records);
  if(!entries.length){target.append(element('p',MISSING));return;}
  for(const record of entries){
   const note=element('article');
   chapterLinks(note,record);
   note.append(element('p',text(record?.text)||MISSING));
   note.append(element('p',record?.text===LEGACY_MISSING?LEGACY_MISSING:recordLabel(record?.status,category,sourceAvailable),'tip'));
   referenceList(note,record);target.append(note);
  }
 };

 // The first content section is always the conclusion, regardless of origin.
 section.append(element('h3','① 핵심 결론'));
 const conclusion=model.keyConclusion??{};
 section.append(element('p',text(conclusion.text)||MISSING));
 section.append(element('p',recordLabel(conclusion.status,undefined,sourceAvailable),'tip'));
 referenceList(section,conclusion);
 section.append(element('p','구조 검사와 실제 의미 품질 검토는 별개입니다. 이 화면은 의미 검토 완료나 외부 사실 확인을 뜻하지 않습니다.','tip'));
 const scopeMessage=text(model.scope?.message);
 if(scopeMessage)section.append(element('p',scopeMessage,'tip'));
 const scopeState=text(model.scope?.state);
 if(scopeState)section.append(element('p',`요약 범위: ${scopeState}`,'tip'));
 const changed=sourceStatus==='STALE_SOURCE'||sourceStatus==='SOURCE_CHANGED';
 const sourceMessage=changed?'원문이 변경되어 근거 시각을 다시 확인해야 합니다. 저장된 본문은 보존됩니다.':model.origin==='INVALID_STRUCTURED'?'저장된 형식이나 원문 연결을 확인하지 못했습니다. 검증된 새 형식 결과로 표시하지 않습니다.':sourceStatus==='LEGACY_CURRENT_SOURCE'?'기존 보고서에 원문 고정 해시가 없습니다. 표시 시각은 현재 저장된 전사 기준이며 보고서 작성 당시 원문과 같은지는 미확인입니다.':sourceStatus==='MATCHED'?'저장된 보고서와 전사 구간의 해시가 일치합니다. 인과관계·의미 품질 검토와는 별개입니다.':'현재 원문 연결을 확인하지 못했습니다. 시각과 근거의 의미 일치는 미확인입니다.';
 section.append(element('p',sourceMessage,'tip'));
 if(model.origin==='LEGACY_COMPATIBILITY')section.append(element('p','기존 보고서의 본문을 보존해 표시합니다. 제목·한 줄 요약·인과관계·가정·반례가 구분 저장되지 않은 부분은 새로 추론하지 않습니다.','tip'));

 section.append(element('h3','② 타임스탬프와 목차별 한 줄 요약'));
 if(!outline.length)section.append(element('p',MISSING));
 const contents=element('ol');
 for(const [index,chapter] of outline.entries()){
  const row=element('li'),target=chapterMap.get(chapter.id)?.target??`${prefix}-chapter-${index+1}`;
  attr(row,'id',target);
  const timestamp=sourceAvailable?text(chapter.timestampLabel)||UNKNOWN_TIME:UNKNOWN_TIME;
  row.append(element('h4',`${timestamp} · ${text(chapter.title)||'제목 미확인'}`));
  row.append(element('p',text(chapter.oneLineSummary)||LEGACY_MISSING));
  if(chapter.oneLineStatus==='LEGACY_TEXT_EXCERPT_NOT_NEW_SUMMARY')row.append(element('p','기존 본문 발췌 · 새 요약 아님','tip'));
  if(text(chapter.legacyText))row.append(element('p',chapter.legacyText));
  referenceList(row,chapter);contents.append(row);
 }
 section.append(contents);

 section.append(element('h3','③ 인과관계 상세 설명'));
 notes(section,model.causalDetails,'causal');
 section.append(element('h3','④ 가정·반례·출처'));
 section.append(element('h4','가정·전제'));notes(section,model.assumptions,'assumption');
 section.append(element('h4','반례·예외'));notes(section,model.counterexamples,'counterexample');
 section.append(element('h4','전사 출처와 근거'));
 if(!sourceMap.size)section.append(element('p','원문·근거 보기에서 저장된 전사를 확인하세요. 이 화면에서 검증된 근거 시각은 없습니다.'));
 const sources=element('ol');
 for(const [id,source] of sourceMap){
  const row=element('li');attr(row,'id',`${prefix}-source-${id}`);
  const timestamp=sourceAvailable?text(source.timestampLabel)||UNKNOWN_TIME:UNKNOWN_TIME;
  row.append(element('p',`원문 #${id} · ${timestamp}`));
  if(text(source.text))row.append(element('pre',source.text));
  sources.append(row);
 }
 section.append(sources,element('p','출처는 저장된 전사입니다. 외부 자료 검증이나 원음 정확성 확인은 수행한 것으로 표시하지 않습니다.','tip'));

 if(model.invalidStructuredPayload){
  const preserved=element('details');preserved.append(element('summary','연결 미확인 구조화 원본 보존'),element('p','형식 또는 원문 연결을 확인하지 못한 저장 본문입니다. 현재 전사에 다시 연결하거나 검증된 결과로 표시하지 않습니다.','tip'));
  let saved;try{saved=JSON.stringify(model.invalidStructuredPayload,null,2);}catch{saved='원본 형식을 표시하지 못했습니다. 저장된 보고서는 변경하지 않았습니다.';}
  preserved.append(element('pre',saved));section.append(preserved);
 }

 const legacy=list(model.legacySections);
 if(legacy.some(group=>list(group.items).length)){
  const appendix=element('details');appendix.append(element('summary','기존 보고서 항목 보존'));
  for(const group of legacy){
   if(!list(group.items).length)continue;
   appendix.append(element('h4',text(group.label)||text(group.key)||'기존 항목'));
   const entries=element('ul');for(const item of group.items){const row=element('li',typeof item==='string'?item:text(item?.text));referenceList(row,item);entries.append(row);}appendix.append(entries);
  }
  section.append(appendix);
 }
 host.append(section);
 return {element:section,model};
}
