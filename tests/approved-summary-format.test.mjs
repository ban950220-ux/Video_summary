import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {APPROVED_SUMMARY_FORMAT,APPROVED_SUMMARY_ABSENT,approvedSummaryDigest,approvedSummarySourceDigest,validateApprovedSummary,approvedSummaryView,projectApprovedSummary,approvedSummaryMarkdown,approvedSummaryEvidenceIds} from '../src/approved-summary-format.mjs';
import {validateAnalysis,markdownReport,reportPrompt} from '../src/report.mjs';
import {syntheticApprovedSource,syntheticApprovedPayload,syntheticApprovedReport,syntheticSemanticCounterexample} from './fixtures/approved-summary-synthetic.mjs';

const clone=value=>structuredClone(value);
function fixture(){
 const source=syntheticApprovedSource(),report=validateAnalysis(syntheticApprovedReport(source),source.segments,'gemini',{formatProfile:APPROVED_SUMMARY_FORMAT});
 return {source,report,job:{title:'합성 설명 검증',status:'PARTIAL_TRANSCRIPT',duration_seconds:160,source_type:'text',audit:{status:'PARTIAL_TRANSCRIPT',timelineRatio:0.5},report}};
}

test('synchronous source hashing agrees with SHA-256 across UTF-8 and block boundaries',()=>{
 for(const text of ['', 'abc', '한글 🧪\r\n',...'a'.repeat(130).split('').map((_,i)=>'한🙂x'.repeat(i))])assert.equal(approvedSummaryDigest(text),createHash('sha256').update(text).digest('hex'));
 const source=syntheticApprovedSource();assert.equal(approvedSummarySourceDigest(source.segments),createHash('sha256').update(JSON.stringify(source.segments.map(s=>[s.id,s.startMs,s.endMs,s.text]))).digest('hex'));
});

test('four-part output binds exact source and stays structurally checked, semantically unreviewed',()=>{
 const {source,report,job}=fixture(),before=JSON.stringify({source,report,job});
 const view=approvedSummaryView(job,source);
 assert.equal(view.origin,'APPROVED_STRUCTURED');assert.equal(view.sourceStatus,'MATCHED');assert.equal(view.semanticReview,'NOT_PERFORMED');
 assert.deepEqual(view.outline.map(c=>c.timestampLabel),['00:00:00','00:00:40']);
 assert.equal(view.causalDetails[1].status,'NOT_ESTABLISHED');assert.equal(view.counterexamples[1].status,'NOT_FOUND');
 assert.equal(view.counterexamples[1].text,APPROVED_SUMMARY_ABSENT);assert.equal(view.scope.state,'PARTIAL_TRANSCRIPT');
 assert.equal(JSON.stringify({source,report,job}),before);assert.equal(report.approvedSummary.structuralValidation,'REFERENCES_QUOTES_LINKS_ONLY');
});

test('legacy schema remains readable while an explicitly requested new format is mandatory',()=>{
 const source=syntheticApprovedSource(),old=syntheticApprovedReport(source);delete old.approvedSummary;
 assert.doesNotThrow(()=>validateAnalysis(old,source.segments));
 assert.throws(()=>validateAnalysis(old,source.segments,'gemini',{formatProfile:APPROVED_SUMMARY_FORMAT}),/APPROVED_SUMMARY_REQUIRED/);
 assert.ok(!reportPrompt(source.segments,{}).includes(APPROVED_SUMMARY_FORMAT));
 assert.match(reportPrompt(source.segments,{}, {formatProfile:APPROVED_SUMMARY_FORMAT}),/인과 설명 자체가 없으면/);
});

for(const [label,mutate,error] of [
 ['wrong version',p=>p.formatVersion='future-format',/SCHEMA_INVALID/],
 ['extra unsupported model timestamp',p=>p.outline[0].timestamp='00:00:00',/OUTLINE_INVALID/],
 ['duplicate chapter',p=>p.outline[1].id='c1',/OUTLINE_INVALID/],
 ['title newline',p=>p.outline[0].title='제목\n내용',/OUTLINE_INVALID/],
 ['summary newline',p=>p.outline[0].oneLineSummary='첫 줄\n둘째 줄',/OUTLINE_INVALID/],
 ['overlong one-line summary',p=>p.outline[0].oneLineSummary='가'.repeat(501),/OUTLINE_INVALID/],
 ['chronological inversion',p=>p.outline.reverse(),/OUTLINE_ORDER_INVALID/],
 ['unknown evidence',p=>p.outline[0].evidenceIds=[999],/EVIDENCE_INVALID/],
 ['duplicate evidence',p=>p.outline[0].evidenceIds=[1,1],/EVIDENCE_INVALID/],
 ['missing exact quote',p=>p.outline[0].sourceQuotes.pop(),/SOURCE_QUOTE_MISSING/],
 ['quote from a different segment',p=>p.outline[0].sourceQuotes[0].quote=p.outline[0].sourceQuotes[1].quote,/SOURCE_QUOTE_MISMATCH/],
 ['fabricated quote',p=>p.causalDetails[0].sourceQuotes[0].quote='실제로 하지 않은 말',/SOURCE_QUOTE_MISMATCH/],
 ['model semantic PASS metadata',p=>p.semanticReview='PASS',/SCHEMA_INVALID/],
 ['missing causal section',p=>p.causalDetails=[],/SECTION_MISSING/],
 ['unlinked assumptions',p=>p.assumptions.pop(),/CHAPTER_CONTEXT_MISSING/],
 ['orphan chapter reference',p=>p.counterexamples[0].chapterIds=['c999'],/CHAPTER_LINK_INVALID/],
 ['duplicate context link',p=>p.counterexamples[0].chapterIds=['c1','c1'],/CHAPTER_LINK_INVALID/],
 ['unknown status',p=>p.causalDetails[1].status='PROVEN_CAUSE',/STATUS_INVALID/],
 ['absent status with fabricated explanation',p=>p.causalDetails[1].text='방문객이 판매를 늘렸기 때문이다.',/ABSENCE_MISREPRESENTED/],
 ['absent status carrying references',p=>p.counterexamples[1].evidenceIds=[4],/ABSENCE_MISREPRESENTED/],
])test('rejects '+label,()=>{
 const source=syntheticApprovedSource(),payload=syntheticApprovedPayload(source);mutate(payload);
 assert.throws(()=>validateApprovedSummary(payload,source.segments),error);
});

test('unknown cause or mechanism never requires inventing a causal explanation',()=>{
 const source=syntheticApprovedSource(),payload=syntheticApprovedPayload(source);
 payload.causalDetails=[{chapterIds:['c1','c2'],status:'NOT_ESTABLISHED',text:APPROVED_SUMMARY_ABSENT,evidenceIds:[],sourceQuotes:[]}];
 assert.equal(validateApprovedSummary(payload,source.segments).causalDetails[0].status,'NOT_ESTABLISHED');
 // Whether this misses a stated explanation in source1 is a separate semantic review.
});

test('an exact quote plus valid IDs cannot certify semantic truth or negation preservation',()=>{
 const source=syntheticApprovedSource(),wrong=syntheticSemanticCounterexample(source);
 const structurallyValid=validateApprovedSummary(wrong,source.segments);
 assert.equal(structurallyValid.semanticReview,'NOT_PERFORMED');
 assert.equal(structurallyValid.structuralValidation,'REFERENCES_QUOTES_LINKS_ONLY');
 assert.match(source.segments[2].text,/원인이라는 결론은 내리지 않았다/);
 assert.match(structurallyValid.keyConclusion.text,/원인이라고 입증되었다/);
 // This deliberate contradiction must FAIL the independent semantic review.
});

test('timestamps come only from source and an untimed source remains readable',()=>{
 const source=syntheticApprovedSource();for(const s of source.segments){s.startMs=null;s.endMs=null;}
 const report=validateAnalysis(syntheticApprovedReport(source),source.segments,'gemini',{formatProfile:APPROVED_SUMMARY_FORMAT});
 const view=approvedSummaryView({report},source);assert.equal(view.origin,'APPROVED_STRUCTURED');
 assert.ok(view.outline.every(item=>item.timestampLabel==='시각 미확인'));
});

for(const [label,mutate] of [
 ['text',s=>s.segments[0].text+=' 수정'],
 ['time',s=>s.segments[0].endMs+=1],
 ['identifier',s=>s.segments[0].id=99],
])test('source '+label+' drift suppresses timestamps and retains stored structured text',()=>{
 const {job,source}=fixture(),stored=JSON.stringify(job.report);mutate(source);
 const view=approvedSummaryView(job,source);
 assert.equal(view.sourceStatus,'STALE_SOURCE');assert.equal(view.origin,'INVALID_STRUCTURED');
 assert.ok(view.outline.every(item=>item.timestampLabel.includes('미확인')));
 assert.deepEqual(view.invalidStructuredPayload,job.report.approvedSummary);
 assert.ok(approvedSummaryMarkdown(view).join('\n').includes(job.report.approvedSummary.causalDetails[0].text));
 assert.equal(JSON.stringify(job.report),stored);
});

test('unavailable source and explicit stale-source audit cannot become a matched projection',()=>{
 const {job,source}=fixture();
 assert.equal(approvedSummaryView(job,null).sourceStatus,'SOURCE_UNAVAILABLE');
 job.report.sourceBinding='STALE_SOURCE';
 const view=approvedSummaryView(job,source);assert.equal(view.sourceStatus,'STALE_SOURCE');
 assert.ok(view.outline.every(item=>item.timestampLabel.includes('원문 연결')));
});

test('stale timestamps never reappear as old evidence in the preserved report export',()=>{
 const {job,source}=fixture();source.segments[0].startMs=5000;
 const text=markdownReport(job,source),reportPart=text.split('## 원본 스크립트')[0];
 assert.ok(!reportPart.includes('00:00:05'));
 assert.match(reportPart,/source changed; timestamp unverified/);
 assert.match(text,/현재 보관된 전사입니다/);
 assert.ok(text.includes(job.report.approvedSummary.causalDetails[0].text));
});

test('stored payload tampering is displayed as unverified without mutating original bytes',()=>{
 const {job,source}=fixture();job.report.approvedSummary.semanticReview='PASS';
 const before=JSON.stringify(job),view=approvedSummaryView(job,source);
 assert.equal(view.origin,'INVALID_STRUCTURED');assert.equal(view.sourceStatus,'UNVERIFIED');assert.equal(view.semanticReview,'NOT_PERFORMED');assert.equal(JSON.stringify(job),before);
});

test('legacy content is preserved without converting ordinary claims into causal facts',()=>{
 const {job,source}=fixture();delete job.report.approvedSummary;
 job.report.claims=[{text:'단순한 관찰일 뿐이다.',evidenceIds:[3]}];job.report.critical=[{text:'분류되지 않은 기존 검토',evidenceIds:[4]}];
 const before=JSON.stringify(job),view=approvedSummaryView(job,source);
 assert.equal(view.origin,'LEGACY_COMPATIBILITY');assert.equal(view.sourceStatus,'LEGACY_CURRENT_SOURCE');
 assert.equal(view.causalDetails[0].text,'기존 보고서에 구분 저장되지 않음');
 assert.equal(view.outline[0].title,'기존 목차 1');assert.equal(view.outline[0].oneLineStatus,'LEGACY_TEXT_EXCERPT_NOT_NEW_SUMMARY');
 assert.ok(view.legacySections.find(x=>x.key==='claims').items.some(x=>x.text==='단순한 관찰일 뿐이다.'));
 assert.equal(JSON.stringify(job),before);
});

test('new format and legacy reports both export conclusion first without dropping original source or report sections',()=>{
 for(const legacy of [false,true]){
  const {job,source}=fixture();if(legacy)delete job.report.approvedSummary;
  const text=markdownReport(job,source),positions=['## ① 핵심 결론','## ② 타임스탬프와 목차별 한 줄 요약','## ③ 인과관계 상세 설명','## ④ 가정·반례·출처'].map(heading=>text.indexOf(heading));
  assert.ok(positions.every((position,i)=>position>=0&&(i===0||position>positions[i-1])));
  assert.ok(text.indexOf('## 기존 보고서 원문 보존')>positions[3]);
  for(const segment of source.segments)assert.ok(text.includes(segment.text));
  for(const key of ['summary','chapters','claims','critical'])for(const item of job.report[key])assert.ok(text.includes(item.text));
  assert.ok(text.includes(job.report.conclusion));assert.match(text,/부분 전사 범위/);
  if(legacy)assert.match(text,/기존 본문 발췌, 새 한 줄 요약 아님/);
 }
});

test('fresh JSON reopening preserves format, source binding and exact exported text',()=>{
 const {job,source}=fixture(),stored=JSON.stringify(job),first=markdownReport(job,source),reopened=JSON.parse(stored),projected=projectApprovedSummary(reopened,source);
 assert.equal(markdownReport(reopened,source),first);assert.equal(projected.approvedSummaryView.origin,'APPROVED_STRUCTURED');
 assert.equal(JSON.stringify(reopened),stored);assert.equal(projected.report,reopened.report);
 assert.deepEqual(approvedSummaryEvidenceIds(reopened.report.approvedSummary),[1,2,3,4]);
});

test('extractive output and missing AI report are not upgraded to generated summaries',()=>{
 assert.equal(approvedSummaryView({report:null}),null);
 assert.equal(approvedSummaryView({report:{kind:'EXTRACTIVE_ONLY_NOT_AI',summary:['합성 발췌']}}),null);
});
