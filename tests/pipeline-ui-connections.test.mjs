// Offline UI contracts. All identifiers, transcript text and responses are invented.
// fetch is a VM-local stub; no provider, browser, D1 or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {runSummaryStages,detailRequestIsCurrent,beginDetailAction} from '../web/site/audio-runner.mjs';
import {renderApprovedSummary} from '../web/site/approved-summary-format.mjs';
import {projectApprovedSummary,validateApprovedSummary} from '../src/approved-summary-format.mjs';
import {syntheticApprovedSource,syntheticApprovedReport} from './fixtures/approved-summary-synthetic.mjs';

const videoId='synthetic01',jobId='aaaaaaaa-1111-4111-8111-111111111111';
const canonical='https://www.youtube.com/watch?v='+videoId;
const title='합성 URL 연결 검증',profile='approved-four-part-v1',storageKey='url-caption-submission-v1';
const initialJob=()=>({id:jobId,video_id:videoId,source_url:canonical,source_type:'url',duration_seconds:120,title,status:'NEED_UPLOAD',report:null,audit:{status:'CAPTION_RESULT_UNAVAILABLE',nativeAcquisition:'NO_STORED_RESULT',automaticAudioAcquisition:'NOT_CONNECTED'}});
function structuredResult(id=jobId){
 const source=syntheticApprovedSource(),report=syntheticApprovedReport(source);report.kind='GEMINI_EVIDENCE_LINKED';report.approvedSummary=validateApprovedSummary(report.approvedSummary,source.segments);
 return {job:projectApprovedSummary({...initialJob(),id,status:'TRANSCRIPT_UNVERIFIED',audit:{status:'TRANSCRIPT_UNVERIFIED'},report},source),persisted:true,formatProfile:profile};
}
function node(tag='div'){
 const item={tag,children:[],attrs:{},dataset:{},hidden:false,isConnected:true,disabled:false,textContent:'',classList:{toggle(){},add(){},remove(){}},
  append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;this.textContent='';},contains(child){return this===child||this.children.some(item=>typeof item?.contains==='function'&&item.contains(child));},setAttribute(key,value){this.attrs[key]=value;this[key]=value;},scrollIntoView(){}};
 Object.defineProperty(item,'innerHTML',{set(){throw Error('HTML_INTERPRETATION_FORBIDDEN');}});return item;
}
const all=item=>[item,...(item.children??[]).flatMap(all)];
const collect=item=>all(item).map(entry=>entry.textContent??'').join('\n');
const findButton=(item,label)=>all(item).find(entry=>entry.tag==='button'&&entry.textContent===label);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function until(check){for(let i=0;i<40;i++){if(check())return;await Promise.resolve();}throw Error('SYNTHETIC_ASYNC_CHECKPOINT_NOT_REACHED');}
const appSource=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__analyze=handleAnalyze;globalThis.__state=state;globalThis.__card=libraryCard;globalThis.__switch=switchView;globalThis.__show=showReport;');
function mount({job=initialJob(),source=null,resume='',storage=new Map(),live=true,firstPassUnits=100,confirm=true,route,summaryResult,summaryRunner=runSummaryStages}={}){
 const elements=new Map(),calls=[],confirmations=[],backend={job:structuredClone(job),source:structuredClone(source)};
 const field=(id,values={})=>{const value=Object.assign(node(),values);elements.set('#'+id,value);return value;};
 for(const id of ['run-button','analysis-progress','result-content','result-panel','toast','library-detail','crumb','library-list','library-count','next-page','previous-page'])field(id);
 field('live-analysis',{checked:live});field('video-title',{value:title});field('duration-min',{value:'2'});field('youtube-url',{value:'https://youtu.be/'+videoId});
 field('audio-free-batch-run',{checked:false});field('audio-provider',{value:'groq'});field('audio-gemini-confirm',{checked:false});field('resume-job',{value:resume});field('audio-file',{files:[]});field('audio-rights',{checked:false});field('new-url-audio-job',{hidden:true});
 field('library-query',{value:''});
 const response=data=>({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data});
 const capacity=()=>({snapshots:[{provider:'gemini',model:'gemini-2.5-flash',valid_until:Date.now()+1_000_000,remaining:{requestsMinute:20,tokensMinute:1_000_000,requestsDay:20},reserved:{requestsMinute:0,tokensMinute:0,requestsDay:0}}]});
 const quota=()=>({grants:[{provider:'gemini',expires_at:Date.now()+1_000_000,billing_disabled:1,request_count:0,request_limit:20,consumed:0,allowance:1_000_000}]});
 const context={document:{createElement:node,querySelector:selector=>elements.get(selector),querySelectorAll:()=>[],hidden:false},window:{sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}},location:{hash:''},crypto:{subtle:webcrypto.subtle,randomUUID:()=>jobId},setTimeout:()=>0,clearTimeout:()=>{},
  confirm:message=>{confirmations.push(message);return typeof confirm==='function'?confirm(message,context):confirm;},renderApprovedSummary,detailRequestIsCurrent,beginDetailAction,runSummaryStages:summaryRunner,
  runAudioChunks:async()=>{throw Error('UNEXPECTED_ASR');},runApprovedFreeBatch:async()=>{throw Error('UNEXPECTED_ASR_BATCH');},
  fetch:async(path,options)=>{
   const call={path,method:options.method,body:options.body?JSON.parse(options.body):undefined};calls.push(call);
   const intercepted=await route?.({call,backend,context,elements,calls,response});if(intercepted!==undefined)return intercepted;
   if(path==='/api/preflight')return response({videoId,sourceType:'url',durationSeconds:120});
   if(path.startsWith('/api/jobs?'))return response({jobs:[],hasMore:false});
   if(path==='/api/jobs'&&options.method==='POST'){
    backend.job={...initialJob(),id:call.body.submissionId,title:call.body.title,duration_seconds:call.body.durationSeconds};
    const saved=backend.job;return response({job:{id:saved.id,source:'url',videoId:saved.video_id,url:saved.source_url,durationSeconds:saved.duration_seconds,title:saved.title,status:saved.status,audit:saved.audit,report:saved.report},persisted:true,reused:false});
   }
   if(path==='/api/jobs/'+backend.job.id)return response({job:backend.job});
   if(path==='/api/jobs/'+backend.job.id+'/source')return response({source:backend.source});
   if(path==='/api/jobs/'+backend.job.id+'/native'){
    backend.job={...backend.job,status:'NEED_UPLOAD',audit:{status:'NO_CAPTIONS',nativeAcquisition:'NO_CAPTIONS',automaticAudioAcquisition:'NOT_CONNECTED'}};return response({job:backend.job,persisted:true});
   }
   if(path==='/api/jobs/'+backend.job.id+'/native-poll')return response({job:backend.job,persisted:true});
   if(path.startsWith('/api/jobs/'+backend.job.id+'/summary-plan'))return response({formatProfile:path.includes('?')?profile:'legacy',firstPassUnits,stages:1});
   if(path==='/api/jobs/'+backend.job.id+'/audio-progress')return response({chunks:[],operationInFlight:{gemini:false},nextEligibleAt:{gemini:null}});
   if(path==='/api/live/capacity')return response(capacity());
   if(path==='/api/live/quota')return response(quota());
   if(path==='/api/jobs/'+backend.job.id+'/summary')return response(summaryResult??structuredResult(backend.job.id));
   throw Error('UNEXPECTED_LOCAL_REQUEST: '+path);
  }};
 runInNewContext(appSource,context,{filename:'synthetic-pipeline-ui-app.js'});
 return {context,elements,calls,confirmations,backend,storage,run:()=>context.__analyze({preventDefault(){}}),progress:()=>elements.get('#analysis-progress').textContent,content:()=>collect(elements.get('#result-content'))};
}

test('URL submission identity is retained before creation and NO_CAPTIONS stops without ASR or summary',async()=>{
 let retained;
 const ui=mount({route:({call})=>{if(call.path==='/api/jobs')retained=JSON.parse(ui.storage.get(storageKey));}});
 await ui.run();const created=ui.calls.find(call=>call.path==='/api/jobs');
 assert.equal(retained.id,created.body.submissionId);assert.equal(retained.state,'CREATE_SENT');
 assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs','/api/jobs/'+jobId+'/source','/api/jobs/'+jobId+'/native']);
 assert.match(ui.progress(),/자동 음성 취득 워커는 연결되지 않아/);assert.match(ui.content(),/자동 음성 전사 완료 상태가 아닙니다/);
 assert.doesNotMatch(ui.progress(),/요약 저장 확인 완료/);
});

test('no-caption and pending library cards hide summary and audio-finish actions',()=>{
 for(const job of [{...initialJob(),audit:{status:'NO_CAPTIONS'}},{...initialJob(),status:'NATIVE_PENDING',nativePollReady:true,audit:{providerJobId:'synthetic-provider-job'}}]){
  const ui=mount({job});ui.context.__state.view='library';const card=ui.context.__card(job);
  assert.equal(findButton(card,'승인한 네 부분 형식으로 요약'),undefined);assert.equal(findButton(card,'기존 형식 요약 재개'),undefined);assert.equal(findButton(card,'전사 병합'),undefined);
  assert.ok(findButton(card,'리포트 열기'));
 }
});

test('neutral missing-result state never claims no previous caption request',()=>{
 const job={...initialJob(),nativeAcquisitionReady:true};const ui=mount({job});const card=ui.context.__card(job),text=collect(card);
 assert.match(text,/이전 요청 결과가 미확정일 수/);assert.doesNotMatch(text,/아직 요청하지|조회 시작/);assert.ok(findButton(card,'기존 자막 조회·요청 상태 확인'));
});

test('explicit URL resume reuses saved transcript and reaches strict four-part summary without native calls',async()=>{
 const job={...initialJob(),status:'TRANSCRIPT_UNVERIFIED',audit:{status:'TRANSCRIPT_UNVERIFIED',nativeAcquisition:'CAPTIONS_STORED'}};
 const ui=mount({job,source:syntheticApprovedSource(),resume:jobId});await ui.run();
 assert.equal(ui.calls.some(call=>call.path==='/api/jobs'||call.path.endsWith('/native')||call.path.endsWith('/native-poll')),false);
 assert.equal(ui.calls.filter(call=>call.path.endsWith('/summary')).length,1);
 assert.equal(ui.calls.find(call=>call.path.endsWith('/summary')).body.formatProfile,profile);
 assert.match(ui.progress(),/요약 저장과 현재 전사 연결을 확인했습니다/);assert.match(ui.content(),/① 핵심 결론/);
});

test('new URL with available captions verifies saved source before approved-format summary',async()=>{
 const ui=mount({route:({call,backend,response})=>{
  if(!call.path.endsWith('/native'))return;
  backend.source=syntheticApprovedSource();backend.job={...backend.job,status:'TRANSCRIPT_UNVERIFIED',audit:{status:'TRANSCRIPT_UNVERIFIED',nativeAcquisition:'CAPTIONS_STORED'}};
  return response({job:backend.job,persisted:true});
 }});await ui.run();
 const paths=ui.calls.map(call=>call.path),native=paths.indexOf('/api/jobs/'+jobId+'/native'),savedSource=paths.indexOf('/api/jobs/'+jobId+'/source',native+1),plan=paths.findIndex(path=>path.includes('/summary-plan'));
 assert.ok(native>=0&&savedSource>native&&plan>savedSource);assert.equal(paths.filter(path=>path.endsWith('/native')).length,1);assert.equal(paths.filter(path=>path.endsWith('/summary')).length,1);
 assert.equal(paths.some(path=>/audio-plan|audio-chunk|audio-finish/.test(path)),false);assert.match(ui.progress(),/요약 저장과 현재 전사 연결을 확인했습니다/);
});

test('URL resume with an existing report opens it through read-only lookups',async()=>{
 const saved=structuredResult(),ui=mount({job:saved.job,source:syntheticApprovedSource(),resume:jobId});await ui.run();
 assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs/'+jobId,'/api/jobs/'+jobId+'/source']);
 assert.match(ui.progress(),/기존 저장 보고서를 열었습니다/);assert.match(ui.content(),/① 핵심 결론/);
 assert.equal(ui.calls.some(call=>/summary-plan|capacity|quota|native|audio-plan|audio-chunk/.test(call.path)),false);
});

test('reused or report-bearing compact POST responses are hydrated by owned GET before rendering source-bound times',async()=>{
 for(const reused of [true,false]){
  const saved=structuredResult(),ui=mount({job:saved.job,source:syntheticApprovedSource(),route:({call,backend,response})=>{
   if(call.path!=='/api/jobs')return;
   const stored=backend.job;return response({job:{id:stored.id,source:'url',videoId:stored.video_id,url:stored.source_url,durationSeconds:stored.duration_seconds,title:stored.title,status:stored.status,audit:stored.audit,report:stored.report},persisted:true,reused});
  }});await ui.run();
  assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs','/api/jobs/'+jobId,'/api/jobs/'+jobId+'/source']);
  assert.match(ui.content(),/00:00:00 · 뚜껑과 열 유출의 조건/);assert.match(ui.progress(),/기존 저장 보고서를 열었습니다/);
  assert.equal(ui.calls.some(call=>/summary-plan|capacity|quota|native|audio-plan|audio-chunk/.test(call.path)),false);
 }
});

test('compact POST hydration must preserve exact input binding before any report is displayed',async()=>{
 const saved=structuredResult(),ui=mount({job:saved.job,source:syntheticApprovedSource(),route:({call,backend,response})=>{
  if(call.path==='/api/jobs'){const stored=backend.job;return response({job:{id:stored.id,source:'url',videoId:stored.video_id,url:stored.source_url,durationSeconds:stored.duration_seconds,title:stored.title,status:stored.status,audit:stored.audit,report:stored.report},persisted:true,reused:true});}
  if(call.path==='/api/jobs/'+jobId)return response({job:{...backend.job,title:'다른 합성 입력'}});
 }});await ui.run();
 assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs','/api/jobs/'+jobId]);assert.match(ui.progress(),/일치하지 않습니다/);assert.equal(ui.content(),'');
});

test('URL resume binds type, video, canonical URL, duration, title and requested ID before source or provider work',async()=>{
 for(const mutation of [{source_type:'audio'},{video_id:'synthetic02'},{source_url:'https://www.youtube.com/watch?v=synthetic02'},{duration_seconds:180},{title:'다른 합성 제목'},{id:'bbbbbbbb-2222-4222-8222-222222222222'}]){
  const ui=mount({resume:jobId,route:({call,response})=>call.path==='/api/jobs/'+jobId?response({job:{...initialJob(),...mutation}}):undefined});await ui.run();
  assert.equal(ui.calls.length,2);assert.match(ui.progress(),/일치하지 않습니다/);
 }
});

test('URL resume never polls a pending caption request or retries known NO_CAPTIONS',async()=>{
 for(const job of [{...initialJob(),status:'NATIVE_PENDING',audit:{nativeAcquisition:'PENDING'}},{...initialJob(),audit:{status:'NO_CAPTIONS',nativeAcquisition:'NO_CAPTIONS'}}]){
  const ui=mount({job,resume:jobId});await ui.run();
  assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs/'+jobId,'/api/jobs/'+jobId+'/source']);
  assert.equal(ui.calls.some(call=>call.path.endsWith('/native')||call.path.endsWith('/summary')),false);
 }
});

test('missing or malformed source readback cannot be treated as permission for a new native request',async()=>{
 for(const payload of [{},{source:undefined},{source:{segments:[]}},{source:{segments:[{id:1,text:''}]}}]){
  const ui=mount({resume:jobId,route:({call,response})=>call.path.endsWith('/source')?response(payload):undefined});await ui.run();
  assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs/'+jobId,'/api/jobs/'+jobId+'/source']);assert.match(ui.progress(),/저장 원문 조회 결과를 확인할 수 없습니다/);
 }
});

test('lost URL creation acknowledgement uses one same-ID readback and stops before provider work',async()=>{
 const ui=mount({route:({call})=>{if(call.path==='/api/jobs')throw Error('SYNTHETIC_ACK_LOSS');}});await ui.run();
 assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs','/api/jobs/'+jobId,'/api/jobs/'+jobId+'/source']);
 assert.equal(JSON.parse(ui.storage.get(storageKey)).id,jobId);assert.match(ui.progress(),/읽기 전용으로 확인했습니다/);
 assert.equal(ui.calls.filter(call=>call.path==='/api/jobs').length,1);
});

test('uncertain creation survives reopen and cannot silently create a replacement job',async()=>{
 const storage=new Map();const fail=({call})=>{if(call.path==='/api/jobs'||call.path==='/api/jobs/'+jobId)throw Error('SYNTHETIC_UNAVAILABLE');};
 const first=mount({storage,route:fail});await first.run();const kept=storage.get(storageKey);
 const second=mount({storage,route:fail});await second.run();
 assert.equal(second.calls.some(call=>call.path==='/api/jobs'),false);assert.equal(storage.get(storageKey),kept);assert.match(second.progress(),/새 작업이나 생성 요청을 자동 재전송하지 않았습니다/);
 second.elements.get('#video-title').value='입력이 바뀐 합성 사례';await second.run();
 assert.equal(second.calls.some(call=>call.path==='/api/jobs'),false);assert.equal(storage.get(storageKey),kept);assert.match(second.progress(),/이전 URL 생성 응답이 불명확/);
});

test('same saved URL token uses GET on repeated submit and keeps canonical URL variants bound',async()=>{
 const ui=mount({live:false});await ui.run();ui.elements.get('#youtube-url').value=canonical;await ui.run();
 assert.equal(ui.calls.filter(call=>call.path==='/api/jobs').length,1);assert.equal(ui.calls.filter(call=>call.path==='/api/jobs/'+jobId).length,1);
 assert.equal(JSON.parse(ui.storage.get(storageKey)).id,jobId);assert.match(ui.progress(),/AI 전사·요약을 실행하거나 완료로 판정하지 않았습니다/);
});

test('analyze double-click sends a single create and native request',async()=>{
 const pause=deferred();const ui=mount({route:async({call})=>{if(call.path==='/api/preflight')await pause.promise;}});
 const first=ui.run();await until(()=>ui.calls.length===1);await ui.run();pause.resolve();await first;
 assert.equal(ui.calls.filter(call=>call.path==='/api/preflight').length,1);assert.equal(ui.calls.filter(call=>call.path==='/api/jobs').length,1);assert.equal(ui.calls.filter(call=>call.path.endsWith('/native')).length,1);
});

test('changing URL input while preflight awaits cancels creation',async()=>{
 const pause=deferred();const ui=mount({route:async({call})=>{if(call.path==='/api/preflight')await pause.promise;}});
 const pending=ui.run();await until(()=>ui.calls.length===1);ui.elements.get('#youtube-url').value='https://youtu.be/synthetic02';pause.resolve();await pending;
 assert.equal(ui.calls.length,1);assert.equal(ui.storage.size,0);
});

test('unavailable session storage blocks URL creation before any job POST',async()=>{
 const ui=mount();ui.context.window.sessionStorage.setItem=()=>{throw Error('SYNTHETIC_STORAGE_BLOCKED');};await ui.run();
 assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight']);assert.match(ui.progress(),/요청 식별자를 보존할 수 없어/);
});

test('analyze navigation during summary-plan lookup stops before quota reads and provider POST',async()=>{
 const pause=deferred();const ui=mount({job:{...initialJob(),status:'TRANSCRIPT_UNVERIFIED'},source:syntheticApprovedSource(),resume:jobId,route:async({call})=>{if(call.path.includes('/summary-plan'))await pause.promise;}});
 const pending=ui.run();await until(()=>ui.calls.some(call=>call.path.includes('/summary-plan')));ui.context.__state.view='library';pause.resolve();await pending;
 assert.equal(ui.calls.some(call=>/summary$|capacity|quota/.test(call.path)),false);
});

test('URL input changes during summary-plan lookup prevent provider execution',async()=>{
 const pause=deferred();const ui=mount({job:{...initialJob(),status:'TRANSCRIPT_UNVERIFIED'},source:syntheticApprovedSource(),resume:jobId,route:async({call})=>{if(call.path.includes('/summary-plan'))await pause.promise;}});
 const pending=ui.run();await until(()=>ui.calls.some(call=>call.path.includes('/summary-plan')));ui.elements.get('#video-title').value='변경된 합성 입력';pause.resolve();await pending;
 assert.equal(ui.calls.some(call=>/summary$|capacity|quota/.test(call.path)),false);
});

test('library summary plan navigation race and repeated click send no late POST',async()=>{
 const pause=deferred(),job={...initialJob(),source_type:'text',status:'TRANSCRIPT_UNVERIFIED'};const ui=mount({job,route:async({call})=>{if(call.path.includes('/summary-plan'))await pause.promise;}});
 ui.context.__state.view='library';const card=ui.context.__card(job),button=findButton(card,'승인한 네 부분 형식으로 요약');
 const pending=button.onclick();await until(()=>ui.calls.length===1);await button.onclick();ui.context.__switch('analyze');pause.resolve();await pending;
 assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].method,'GET');
});

test('declining staged summary or changing view inside confirmation prevents execution',async()=>{
 for(const confirm of [false,(_message,context)=>{context.__switch('analyze');return true;}]){
  const job={...initialJob(),source_type:'text',status:'TRANSCRIPT_UNVERIFIED'},ui=mount({job,firstPassUnits:300000,confirm});ui.context.__state.view='library';
  await findButton(ui.context.__card(job),'승인한 네 부분 형식으로 요약').onclick();assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].method,'GET');
 }
});

test('analyze requires the exact approved plan profile before reading execution capacity or sending summary',async()=>{
 for(const formatProfile of [undefined,'legacy']){
  const ui=mount({job:{...initialJob(),status:'TRANSCRIPT_UNVERIFIED'},source:syntheticApprovedSource(),resume:jobId,route:({call,response})=>call.path.includes('/summary-plan')?response({firstPassUnits:100,stages:1,...(formatProfile?{formatProfile}:{})}):undefined});await ui.run();
  assert.match(ui.progress(),/요약 계획의 형식이 선택한 형식과 다릅니다/);assert.equal(ui.calls.some(call=>/summary$|capacity|quota/.test(call.path)),false);
 }
});

test('library approved action rejects missing or mismatched plan profile before POST',async()=>{
 for(const formatProfile of [undefined,'legacy']){
  const job={...initialJob(),source_type:'text',status:'TRANSCRIPT_UNVERIFIED'},ui=mount({job,route:({call,response})=>call.path.includes('/summary-plan')?response({firstPassUnits:100,stages:1,...(formatProfile?{formatProfile}:{})}):undefined});ui.context.__state.view='library';
  await findButton(ui.context.__card(job),'승인한 네 부분 형식으로 요약').onclick();assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].method,'GET');assert.match(ui.elements.get('#toast').textContent,/요약 계획의 형식이 선택한 형식과 다릅니다/);
 }
});

test('cached legacy mismatch is readable but never reported as new approved-format success',async()=>{
 const legacy={...initialJob(),source_type:'text',status:'TRANSCRIPT_UNVERIFIED',report:{kind:'GEMINI_EVIDENCE_LINKED',summary:[],chapters:[],conclusion:'보존된 합성 기존 결론'}};
 const result={job:legacy,persisted:true,cached:true,formatMismatch:true,requestedFormatProfile:profile,storedFormatProfile:'legacy'};
 const ui=mount({job:legacy,summaryResult:result});ui.context.__state.view='library';await findButton(ui.context.__card(legacy),'승인한 네 부분 형식으로 요약').onclick();
 const text=collect(ui.elements.get('#library-detail'));assert.match(text,/보존된 합성 기존 결론/);assert.match(text,/새로 생성하거나 기존 내용을 덮어쓰지 않았습니다/);assert.doesNotMatch(ui.elements.get('#toast').textContent,/요약 저장과 현재 전사 연결을 확인했습니다/);
});

test('analyze preserves cached legacy mismatch without announcing new-format completion',async()=>{
 const legacy={...initialJob(),status:'TRANSCRIPT_UNVERIFIED',report:{kind:'GEMINI_EVIDENCE_LINKED',summary:[],chapters:[],conclusion:'합성 이전 요약 보존'}};
 const ui=mount({job:{...initialJob(),status:'TRANSCRIPT_UNVERIFIED'},source:syntheticApprovedSource(),resume:jobId,summaryResult:{job:legacy,persisted:true,cached:true,formatMismatch:true,requestedFormatProfile:profile,storedFormatProfile:'legacy'}});await ui.run();
 assert.match(ui.content(),/합성 이전 요약 보존/);assert.match(ui.progress(),/새 형식 요약 완료로 판정하지 않았습니다/);assert.equal(ui.calls.filter(call=>call.path.endsWith('/summary')).length,1);
});

test('library rejects final success when persistence, profile or source binding is unverified',async()=>{
 for(const mutate of [result=>{result.persisted=false;},result=>{delete result.formatProfile;},result=>{result.job.approvedSummaryView.sourceStatus='STALE_SOURCE';},result=>{delete result.job.report.approvedSummary.sourceBinding;}]){
  const result=structuredResult();mutate(result);const job={...initialJob(),source_type:'text',status:'TRANSCRIPT_UNVERIFIED'},ui=mount({job,summaryResult:result});ui.context.__state.view='library';
  await findButton(ui.context.__card(job),'승인한 네 부분 형식으로 요약').onclick();assert.match(collect(ui.elements.get('#library-detail')),/새 형식 요약 완료로 판정하지 않습니다/);
 }
});

test('caption-state poll is explicit and describes no additional credit reservation',async()=>{
 const job={...initialJob(),status:'NATIVE_PENDING',nativePollReady:true,audit:{providerJobId:'synthetic-provider-job'}};
 const ui=mount({job});ui.context.__state.view='library';const card=ui.context.__card(job);assert.equal(ui.calls.length,0);
 await findButton(card,'Supadata 자막 처리 상태 조회 · API 요청').onclick();
 assert.match(ui.confirmations[0],/추가 크레딧을 예약하지 않습니다/);assert.doesNotMatch(ui.confirmations[0],/무료 할당 1회를 예약/);assert.deepEqual(ui.calls.map(call=>call.path),['/api/jobs/'+jobId,'/api/jobs/'+jobId+'/native-poll']);
});

test('library caption discovery rechecks owned detail and source and skips a saved transcript',async()=>{
 const job={...initialJob(),nativeAcquisitionReady:true},ui=mount({job,source:syntheticApprovedSource()});ui.context.__state.view='library';
 await findButton(ui.context.__card(job),'기존 자막 조회·요청 상태 확인').onclick();
 assert.deepEqual(ui.calls.map(call=>call.path),['/api/jobs/'+jobId,'/api/jobs/'+jobId+'/source']);assert.match(collect(ui.elements.get('#library-detail')),/기존 자막 요청을 다시 보내지 않았습니다/);
});

test('stored complete provider response is readable with explicit intermediate/unvalidated status',async()=>{
 const ui=mount({route:({call,response})=>call.path.endsWith('/summary-review')?response({reviewKind:'STORED_COMPLETE_RESPONSE',partialText:'합성 보존 응답',warning:'합성 검증 미확정',state:'DONE',reportValidation:'NOT_ASSERTED',providerCalls:0}):undefined});
 ui.context.__show(initialJob(),ui.elements.get('#result-content'),true);await findButton(ui.elements.get('#result-content'),'저장된 요약 응답 검토').onclick();
 assert.match(ui.content(),/중간 단계일 수 있으며 최종 보고서 검증·저장 완료를 뜻하지 않습니다/);assert.match(ui.content(),/합성 보존 응답/);assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].method,'GET');
});

for(const [action,label] of [['source','원문·근거 보기'],['summary-review','저장된 요약 응답 검토']]){
 test('delayed '+action+' text cannot append after another analysis, rerender, view change or detachment',async()=>{
  for(const invalidate of ['other-analysis','same-analysis-rerender','view-change','host-detached','button-detached']){
   const pause=deferred(),original={...initialJob(),source_type:'text'},other={...original,id:'bbbbbbbb-2222-4222-8222-222222222222',title:'다른 합성 분석'};
   const marker='지연된 이전 분석의 합성 비공개 텍스트';
   const ui=mount({job:original,route:async({call,response})=>{
    if(call.path==='/api/jobs/'+original.id+'/'+action){await pause.promise;return response(action==='source'?{source:{segments:[{id:1,startMs:0,text:marker}]}}:{reviewKind:'STORED_COMPLETE_RESPONSE',partialText:marker});}
    if(call.path==='/api/jobs/'+other.id)return response({job:other});
   }});ui.context.__state.view='library';
   await findButton(ui.context.__card(original),'리포트 열기').onclick();const target=ui.elements.get('#library-detail'),button=findButton(target,label),pending=button.onclick();
   await until(()=>ui.calls.some(call=>call.path==='/api/jobs/'+original.id+'/'+action));
   if(invalidate==='other-analysis')await findButton(ui.context.__card(other),'리포트 열기').onclick();
   else if(invalidate==='same-analysis-rerender')await findButton(ui.context.__card(original),'리포트 열기').onclick();
   else if(invalidate==='view-change')ui.context.__switch('analyze');
   else if(invalidate==='host-detached')target.isConnected=false;
   else button.isConnected=false;
   const before=collect(target);pause.resolve();await pending;
   assert.equal(collect(target),before);assert.equal(collect(target).includes(marker),false);
   if(invalidate==='other-analysis')assert.equal(target.dataset.jobId,other.id);
  }
 });
 test('stale or detached '+action+' button sends no GET and repeated active click sends only one',async()=>{
  for(const invalidate of ['replacement','host-detached','button-detached']){
   const ui=mount(),target=ui.elements.get('#result-content');ui.context.__show(initialJob(),target,true);const button=findButton(target,label);
   if(invalidate==='replacement')ui.context.__show(initialJob(),target,true);else if(invalidate==='host-detached')target.isConnected=false;else button.isConnected=false;
   await button.onclick();assert.equal(ui.calls.length,0);
  }
  const pause=deferred(),ui=mount({route:async({call,response})=>{if(call.path.endsWith('/'+action)){await pause.promise;return response(action==='source'?{source:null}:{partialText:'합성 읽기 응답'});}}}),target=ui.elements.get('#result-content');
  ui.context.__show(initialJob(),target,true);const button=findButton(target,label),pending=button.onclick();await until(()=>ui.calls.length===1);await button.onclick();pause.resolve();await pending;assert.equal(ui.calls.length,1);
 });
}

async function strictRun(result){
 let sends=0;const at=1000;
 const output=await runSummaryStages({completionContext:{formatProfile:profile,jobId},getProgress:async()=>({operationInFlight:{gemini:false},nextEligibleAt:{gemini:null}}),getCapacity:async()=>({snapshots:[{provider:'gemini',model:'gemini-2.5-flash',valid_until:100000,remaining:{requestsMinute:2,tokensMinute:100000,requestsDay:2},reserved:{requestsMinute:0,tokensMinute:0,requestsDay:0}}]}),getQuota:async()=>({grants:[{provider:'gemini',expires_at:100000,billing_disabled:1,request_count:0,request_limit:2,consumed:0,allowance:100000}]}),sendSummary:async()=>{sends++;return result;},now:()=>at,wait:async()=>{throw Error('UNEXPECTED_WAIT');}});
 return {output,sends};
}

test('strict runner accepts a saved source-matched report and matching cached profile without a new formatProfile field',async()=>{
 const fresh=structuredResult();assert.equal((await strictRun(fresh)).output.complete,true);
 const cached={...fresh,cached:true,requestedFormatProfile:profile,storedFormatProfile:profile};delete cached.formatProfile;
 assert.equal((await strictRun(cached)).output.complete,true);
});

test('strict runner rejects manual/status-only, wrong-job, unpersisted, unbound and stale completion claims',async()=>{
 const mutations=[result=>{result.job.report.kind='MANUAL_IMPORTED';},result=>{result.job.report=null;},result=>{result.job.id='bbbbbbbb-2222-4222-8222-222222222222';},result=>{result.persisted=false;},result=>{delete result.formatProfile;},result=>{delete result.job.approvedSummaryView;},result=>{result.job.approvedSummaryView.sourceStatus='STALE_SOURCE';},result=>{result.job.approvedSummaryView.origin='LEGACY_COMPATIBILITY';},result=>{result.job.approvedSummaryView.sources=[];},result=>{delete result.job.report.approvedSummary.sourceBinding;},result=>{result.job.report.approvedSummary.semanticReview='CLAIMED_COMPLETE';}];
 for(const mutate of mutations){const result=structuredResult();mutate(result);const {output,sends}=await strictRun(result);assert.equal(output.complete,false);assert.equal(output.reason,'SUMMARY_RESULT_UNVERIFIED');assert.equal(sends,1);}
});

test('strict runner preserves cached mismatch for display and refuses wrong-profile pending progression',async()=>{
 const mismatch={...structuredResult(),cached:true,formatMismatch:true},first=await strictRun(mismatch);assert.equal(first.output.complete,false);assert.equal(first.output.reason,'SUMMARY_FORMAT_MISMATCH');assert.equal(first.output.result,mismatch);assert.equal(first.sends,1);
 const pending={job:initialJob(),pending:true,persisted:true,formatProfile:'legacy'},second=await strictRun(pending);assert.equal(second.output.reason,'SUMMARY_PENDING_CONTEXT_UNVERIFIED');assert.equal(second.sends,1);
 const inconsistent={...structuredResult(),cached:true,requestedFormatProfile:profile,storedFormatProfile:'legacy'},third=await strictRun(inconsistent);assert.equal(third.output.reason,'SUMMARY_RESULT_UNVERIFIED');assert.equal(third.sends,1);
});
