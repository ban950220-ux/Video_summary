// Invented text and local DOM fixtures only. No real video, user record or API.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {renderApprovedSummary,unboundApprovedSummaryView} from '../web/site/approved-summary-format.mjs';
import {detailRequestIsCurrent} from '../web/site/audio-runner.mjs';
import {projectApprovedSummary,validateApprovedSummary} from '../src/approved-summary-format.mjs';
import {syntheticApprovedSource,syntheticApprovedReport} from './fixtures/approved-summary-synthetic.mjs';

function node(tag){
 const item={tag,children:[],attrs:{},dataset:{},hidden:false,isConnected:true,
  append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},
  replaceChildren(...items){this.children=items;},setAttribute(key,value){this.attrs[key]=value;this[key]=value;},scrollIntoView(){}};
 Object.defineProperty(item,'innerHTML',{set(){throw Error('HTML_INTERPRETATION_FORBIDDEN');}});
 return item;
}
const dom={createElement:node};
const all=item=>[item,...(item.children??[]).flatMap(all)];
const collect=item=>all(item).map(entry=>entry.textContent??'').join('\n');
const headings=item=>all(item).filter(entry=>entry.tag==='h3').map(entry=>entry.textContent);
const missing=(chapterIds=['c1'],status='NOT_FOUND')=>({chapterIds,status,text:'자료에서 확인되지 않음',evidenceIds:[],sourceQuotes:[]});
function fixture(){
 const conclusion={status:'SOURCE_STATED',text:'합성 장치의 팬 작동과 냉각 조건을 구분해야 한다.',evidenceIds:[1],sourceQuotes:[{id:1,quote:'팬이 작동한다'}]};
 return {formatVersion:'approved-four-part-v1',origin:'APPROVED_STRUCTURED',sourceStatus:'MATCHED',
  semanticReview:'NOT_PERFORMED',scope:{state:'STORED_TRANSCRIPT_ONLY',message:'저장된 합성 전사만 다룹니다.'},
  keyConclusion:conclusion,
  outline:[{id:'c1',title:'합성 냉각 조건',oneLineSummary:'조건에 따른 팬의 작동을 정리한다.',evidenceIds:[1],timestampLabel:'00:00:12',sourceQuotes:[{id:1,quote:'팬이 작동한다'}]}],
  causalDetails:[{chapterIds:['c1'],status:'SOURCE_STATED',text:'합성 온도 신호가 제어기를 켜고 그 신호로 팬이 작동한다는 설명이다.',evidenceIds:[1],sourceQuotes:[{id:1,quote:'팬이 작동한다'}]}],
  assumptions:[missing()],counterexamples:[missing()],
  sources:[{id:1,timestampLabel:'00:00:12',text:'합성 온도 신호로 팬이 작동한다.'}],
  legacySections:[{key:'summary',label:'핵심 요약',items:[{text:'합성 기존 요약 본문',evidenceIds:[1]}]}]};
}
function render(view,job={}){const host=node('div'),before=JSON.stringify({view,job});renderApprovedSummary({host,job,view,document:dom});assert.equal(JSON.stringify({view,job}),before);return host;}

test('conclusion precedes timestamped titled one-line outline and the two explanation sections',()=>{
 const host=render(fixture());
 assert.deepEqual(headings(host),['① 핵심 결론','② 타임스탬프와 목차별 한 줄 요약','③ 인과관계 상세 설명','④ 가정·반례·출처']);
 const output=collect(host);
 assert.ok(output.indexOf('합성 장치의 팬 작동')<output.indexOf('② 타임스탬프'));
 assert.match(output,/00:00:12 · 합성 냉각 조건/);
 assert.match(output,/조건에 따른 팬의 작동을 정리한다/);
 assert.match(output,/제어기를 켜고 그 신호로 팬이 작동/);
 assert.match(output,/가정·전제/);assert.match(output,/반례·예외/);
 assert.match(output,/구조 검사와 실제 의미 품질 검토는 별개/);
});

test('chapter and transcript references resolve to locally generated anchors only',()=>{
 const host=render(fixture()),nodes=all(host),targets=new Set(nodes.map(item=>item.attrs.id).filter(Boolean)),links=nodes.filter(item=>item.tag==='a');
 assert.ok(links.length>=4);
 for(const link of links){assert.match(link.attrs.href,/^#approved-summary-\d+-(?:chapter|source)-\d+$/);assert.ok(targets.has(link.attrs.href.slice(1)));}
});

test('missing causality, assumptions and counterexamples remain explicit without synthetic claims',()=>{
 const view=fixture();view.causalDetails=[missing(['c1'],'NOT_ESTABLISHED')];
 const output=collect(render(view));
 assert.match(output,/인과관계 확인되지 않음/);assert.ok(output.split('자료에서 확인되지 않음').length>=4);
 assert.doesNotMatch(output,/제어기를 켜고 그 신호로/);
});

test('stale source hides supplied timestamps and cannot link current text as old evidence',()=>{
 const view=fixture();view.sourceStatus='STALE_SOURCE';view.sources[0].text='CHANGED_CURRENT_TEXT';
 const host=render(view),output=collect(host);
 assert.match(output,/원문이 변경되어/);assert.match(output,/시각 미확인/);
 assert.doesNotMatch(output,/00:00:12|CHANGED_CURRENT_TEXT/);
 assert.equal(all(host).filter(item=>item.tag==='a'&&item.attrs.href.includes('-source-')).length,0);
 assert.match(output,/합성 장치의 팬 작동/);
});

test('an invalid structured projection cannot advertise a source timestamp',()=>{
 const view=fixture();view.origin='INVALID_STRUCTURED';
 const output=collect(render(view));assert.doesNotMatch(output,/00:00:12/);assert.match(output,/시각 미확인/);
});

test('partial transcript scope and meaning-unreviewed limits remain visible',()=>{
 const view=fixture();view.scope={state:'PARTIAL_TRANSCRIPT',message:'합성 전사의 일부만 보관되어 전체 영상 결론을 뜻하지 않습니다.'};
 const output=collect(render(view));assert.match(output,/PARTIAL_TRANSCRIPT/);assert.match(output,/전체 영상 결론을 뜻하지 않습니다/);assert.match(output,/의미 검토 완료나 외부 사실 확인을 뜻하지 않습니다/);
});

test('old reports retain all text but do not relabel old critical items as proven assumptions',()=>{
 const job={status:'PARTIAL_TRANSCRIPT',report:{kind:'GROQ_EVIDENCE_LINKED',conclusion:'기존 결론 그대로',summary:[{text:'기존 요약 그대로',evidenceIds:[1]}],chapters:[{text:'기존 상세 장\n원문 줄바꿈',evidenceIds:[1]}],claims:[{text:'기존 주장 그대로',evidenceIds:[1]}],numbers:[{text:'합성 수치 그대로',evidenceIds:[1]}],critical:[{text:'구분되지 않은 기존 비판',evidenceIds:[1]}]}};
 const before=JSON.stringify(job),view=unboundApprovedSummaryView(job),output=collect(render(undefined,job));
 assert.equal(view.origin,'LEGACY_COMPATIBILITY');assert.equal(view.assumptions[0].status,'LEGACY_UNCLASSIFIED');assert.equal(view.counterexamples[0].status,'LEGACY_UNCLASSIFIED');
 for(const text of ['기존 결론 그대로','기존 요약 그대로','기존 상세 장\n원문 줄바꿈','기존 주장 그대로','합성 수치 그대로','구분되지 않은 기존 비판'])assert.ok(output.includes(text));
 assert.match(output,/기존 보고서에 구분 저장되지 않음/);assert.match(output,/시각 미확인/);assert.equal(JSON.stringify(job),before);
});

test('direct new-format responses without a source projection do not invent verified timestamps',()=>{
 const source=fixture(),job={report:{approvedSummary:structuredClone(source),summary:[],chapters:[]}};
 const host=render(undefined,job),output=collect(host);
 assert.match(output,/합성 냉각 조건/);assert.match(output,/시각 미확인/);assert.doesNotMatch(output,/00:00:12/);
 assert.match(output,/전사 근거 주장 · 현재 원문 연결 미확인/);assert.doesNotMatch(output,/전사 근거 연결 · 의미 검토 필요/);
 assert.equal(all(host).filter(item=>item.tag==='a'&&item.attrs.href.includes('-source-')).length,0);
});

test('titles, detail bodies and source text are literal text with no markup execution',()=>{
 const view=fixture(),payload='<img src=x onerror="synthetic()">';view.keyConclusion.text=payload;view.outline[0].title=payload;view.causalDetails[0].text=payload;view.sources[0].text=payload;
 const host=render(view);assert.ok(collect(host).includes(payload));assert.equal(all(host).some(item=>['img','script','iframe'].includes(item.tag)),false);
});

test('rendering and reopening are deterministic except local anchor identities and never invoke fetch',()=>{
 const old=globalThis.fetch;let fetches=0;globalThis.fetch=()=>{fetches++;throw Error('NO_NETWORK');};
 try{const view=fixture(),first=render(view),second=render(JSON.parse(JSON.stringify(view)));assert.equal(collect(first),collect(second));assert.notEqual(all(first).find(item=>item.attrs.id)?.attrs.id,all(second).find(item=>item.attrs.id)?.attrs.id);assert.equal(fetches,0);}finally{globalThis.fetch=old;}
});

test('invalid structured payload remains readable as unverified literal saved data',()=>{
 const view=fixture();view.origin='INVALID_STRUCTURED';view.sourceStatus='UNVERIFIED';view.invalidStructuredPayload={formatVersion:'unrecognized',text:'<script>syntheticSavedText()</script>'};
 const host=render(view),output=collect(host);assert.match(output,/연결 미확인 구조화 원본 보존/);assert.ok(output.includes('<script>syntheticSavedText()</script>'));assert.match(output,/검증된 결과로 표시하지 않습니다/);assert.equal(all(host).some(item=>item.tag==='script'),false);
});

test('source-bound saved JSON reopens with derived times and rejects later timestamp drift',()=>{
 const source=syntheticApprovedSource(),report=syntheticApprovedReport(source);report.kind='GEMINI_EVIDENCE_LINKED';report.approvedSummary=validateApprovedSummary(report.approvedSummary,source.segments);
 const stored=JSON.stringify({status:'PARTIAL_TRANSCRIPT',report,audit:{status:'PARTIAL_TRANSCRIPT'}}),job=JSON.parse(stored);
 const projected=projectApprovedSummary(job,source),host=render(projected.approvedSummaryView,job),output=collect(host);
 assert.equal(projected.approvedSummaryView.sourceStatus,'MATCHED');assert.match(output,/00:00:00 · 뚜껑과 열 유출의 조건/);assert.match(output,/00:00:40 · 동반 변화와 인과관계의 구분/);assert.match(output,/PARTIAL_TRANSCRIPT/);
 const changed=structuredClone(source);changed.segments[0].startMs=5000;
 const stale=projectApprovedSummary(JSON.parse(stored),changed),reopened=collect(render(stale.approvedSummaryView,stale));
 assert.equal(stale.approvedSummaryView.sourceStatus,'STALE_SOURCE');assert.doesNotMatch(reopened,/00:00:05 ·/);assert.match(reopened,/연결 미확인 구조화 원본 보존/);assert.equal(JSON.stringify(job),stored);
});

function mountApp({job,firstPassUnits=100,confirm=true,formatMismatch=false}={}){
 const target=node('div'),toast=node('div'),calls=[];
 const app=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__show=showReport;globalThis.__card=libraryCard;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#library-detail'?target:selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},renderApprovedSummary,detailRequestIsCurrent,
  beginDetailAction:(element,id,current)=>{element.dataset.jobId=id;return current+1;},setTimeout:()=>0,clearTimeout:()=>{},confirm:()=>confirm,
  fetch:async(path,options)=>{calls.push({path,method:options.method,body:options.body?JSON.parse(options.body):undefined});const result=path.includes('/summary-plan')?{firstPassUnits,stages:1,formatProfile:path.includes('?formatProfile=approved-four-part-v1')?'approved-four-part-v1':'legacy'}:{job,persisted:true,formatMismatch};return {ok:true,headers:{get:()=> 'application/json'},json:async()=>result};}};
 runInNewContext(app,context);context.__state.view='library';return {context,target,calls};
}

test('real app report integration preserves export/import entry and the conclusion-first view on reopen',async()=>{
 const job={id:'synthetic-view-job',title:'합성 보고서',created_at:'2026-01-01T00:00:00Z',duration_seconds:60,source_type:'text',status:'PARTIAL_TRANSCRIPT',report:{kind:'GEMINI_EVIDENCE_LINKED',summary:[{text:'합성 기존 요약 본문',evidenceIds:[1]}],chapters:[],conclusion:'합성 결론',warning:'합성 검수 필요'},approvedSummaryView:fixture()};
 const ui=mountApp({job}),card=ui.context.__card(job),button=all(card).find(item=>item.tag==='button'&&item.textContent==='리포트 열기');await button.onclick();
 assert.deepEqual(headings(ui.target).slice(0,4),['① 핵심 결론','② 타임스탬프와 목차별 한 줄 요약','③ 인과관계 상세 설명','④ 가정·반례·출처']);
 assert.ok(all(ui.target).some(item=>item.tag==='a'&&item.attrs.href==='/api/jobs/synthetic-view-job/export?format=txt'));
 assert.ok(all(ui.target).some(item=>item.tag==='button'&&item.textContent==='가져온 요약 저장·보기'));
 assert.deepEqual(ui.calls.map(item=>item.method),['GET']);
});

test('new library format action sends matching plan and execution profiles without changing legacy resume',async()=>{
 const job={id:'synthetic-format-job',source_type:'audio',created_at:'2026-01-01T00:00:00Z',duration_seconds:60,status:'TRANSCRIBED',report:null};
 const ui=mountApp({job}),card=ui.context.__card(job),buttons=all(card).filter(item=>item.tag==='button');
 await buttons.find(item=>item.textContent==='승인한 네 부분 형식으로 요약').onclick();
 assert.equal(ui.calls[0].path,'/api/jobs/synthetic-format-job/summary-plan?formatProfile=approved-four-part-v1');
 assert.equal(ui.calls[1].path,'/api/jobs/synthetic-format-job/summary');assert.equal(ui.calls[1].body.formatProfile,'approved-four-part-v1');
 await buttons.find(item=>item.textContent==='기존 Gemini 무료 요약 생성').onclick();
 assert.equal(ui.calls[2].path,'/api/jobs/synthetic-format-job/summary-plan');assert.equal(ui.calls[3].body.formatProfile,undefined);
});

test('declining staged new-format work sends no POST and accepting keeps the format binding',async()=>{
 const job={id:'synthetic-staged-job',source_type:'text',created_at:'2026-01-01T00:00:00Z',duration_seconds:60,status:'TRANSCRIBED',report:null};
 for(const allowed of [false,true]){const ui=mountApp({job,firstPassUnits:250001,confirm:allowed}),card=ui.context.__card(job),button=all(card).find(item=>item.textContent==='승인한 네 부분 형식으로 요약');await button.onclick();assert.equal(ui.calls.filter(item=>item.method==='POST').length,allowed?1:0);if(allowed)assert.deepEqual(ui.calls[1].body,{formatProfile:'approved-four-part-v1',allowStaged:true});}
});

test('cached legacy response is disclosed instead of claiming new-format generation',async()=>{
 const job={id:'synthetic-cached-job',source_type:'text',created_at:'2026-01-01T00:00:00Z',duration_seconds:60,status:'TRANSCRIBED',report:{kind:'GEMINI_EVIDENCE_LINKED',summary:[],chapters:[],conclusion:'기존 합성 결론'}};
 const ui=mountApp({job,formatMismatch:true}),card=ui.context.__card(job),button=all(card).find(item=>item.textContent==='승인한 네 부분 형식으로 요약');await button.onclick();
 assert.match(collect(ui.target),/기존 저장 보고서를 보존해 열었습니다/);assert.match(collect(ui.target),/새로 생성하거나 기존 내용을 덮어쓰지 않았습니다/);assert.match(collect(ui.target),/기존 합성 결론/);
});

test('new-analysis plan and staged execution select one identical approved profile',()=>{
 const app=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8');
 assert.match(app,/const summaryPlan=await api\('\/api\/jobs\/'\+id\+'\/summary-plan\?formatProfile=approved-four-part-v1'\)/);
 assert.match(app,/sendSummary:\(\)=>api\('\/api\/jobs\/'\+id\+'\/summary',\{method:'POST',body:\{allowStaged:staged,formatProfile:'approved-four-part-v1'\}\}\)/);
});
