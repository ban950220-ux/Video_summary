// Synthetic selected-file bytes and local fetch stubs. No real audio or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {mountAsrResultBridge} from '../web/site/asr-result-bridge.mjs';
import {renderApprovedSummary} from '../web/site/approved-summary-format.mjs';
import {beginDetailAction,detailRequestIsCurrent} from '../web/site/audio-runner.mjs';
import {projectApprovedSummary,validateApprovedSummary} from '../src/approved-summary-format.mjs';
import {syntheticApprovedSource,syntheticApprovedReport} from './fixtures/approved-summary-synthetic.mjs';

const id='11111111-1111-4111-8111-111111111111',otherId='44444444-4444-4444-8444-444444444444';
const bytes=new Uint8Array([1,2,3,4]),hash=createHash('sha256').update(bytes).digest('hex'),title='합성 원음';
const file=()=>({name:'synthetic-owned.wav',size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function until(check){for(let i=0;i<80;i++){if(check())return;await new Promise(setImmediate);}throw Error('SYNTHETIC_CHECKPOINT_NOT_REACHED');}
function node(tag='div'){return {tag,children:[],attrs:{},dataset:{},handlers:{},isConnected:true,hidden:false,disabled:false,textContent:'',classList:{toggle(){},add(){},remove(){}},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;this.textContent='';},setAttribute(key,value){this.attrs[key]=value;this[key]=value;},addEventListener(event,handler){this.handlers[event]=handler;},contains(value){return this===value||this.children.some(child=>child.contains?.(value));},scrollIntoView(){}};}
const all=root=>[root,...(root.children??[]).flatMap(all)],text=root=>all(root).map(item=>item.textContent??'').join('\n'),button=(root,label)=>all(root).find(item=>item.tag==='button'&&item.textContent===label);
const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__analyze=handleAnalyze;globalThis.__state=state;globalThis.__card=libraryCard;globalThis.__show=showReport;globalThis.__switch=switchView;globalThis.__bindLocal=initLocalAsrInputs;globalThis.__updateLocal=updateLocalAsrInput;');
function savedJob(){return {id,source_type:'audio',source_url:null,video_id:null,duration_seconds:120,title,status:'NEED_AUDIO_UPLOAD',audit:{ownedAudioSha256:hash},report:null};}
function mount({storage=new Map(),model={job:null},onCall,lostCreate=false,lostCreateWithoutSave=false,resume='',selected=file(),local=true,rights=true}={}){
 const elements=new Map(),calls=[];let audioRuns=0;
 const field=(id,values={})=>{const value=Object.assign(node(),values);elements.set('#'+id,value);return value;};
 for(const id of ['run-button','analysis-progress','result-panel','result-content','toast','new-url-audio-job','library-detail','crumb'])field(id);
 field('audio-free-batch-run',{checked:false});field('audio-provider',{value:'groq'});field('audio-gemini-confirm',{checked:false});field('resume-job',{value:resume});field('audio-file',{files:[selected]});field('audio-rights',{checked:true});field('live-analysis',{checked:!local});field('video-title',{value:title});field('duration-min',{value:'2'});field('local-asr-mode',{checked:local});field('local-asr-rights',{checked:rights});field('youtube-url',{value:''});
 const browserStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},dom={createElement:node,querySelector:selector=>elements.get(selector),querySelectorAll:()=>[],hidden:false};
 const response=data=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>data});
 const fetch=async(path,options)=>{
  const call={path,method:options.method,body:options.body?JSON.parse(options.body):undefined};calls.push(call);const custom=await onCall?.({call,model,elements,response,storage});if(custom!==undefined)return custom;
  if(path==='/api/preflight')return response({sourceType:'audio',videoId:null,durationSeconds:call.body.durationSeconds});
  if(path==='/api/jobs'&&call.method==='POST'){
   const reused=!!model.job;if(!lostCreateWithoutSave)model.job??={...savedJob(),id:call.body.submissionId??id,title:call.body.title,duration_seconds:call.body.durationSeconds,audit:{ownedAudioSha256:call.body.ownedAudioSha256??null}};
   if(lostCreate||lostCreateWithoutSave)throw Error('SYNTHETIC_ACK_LOSS');const job=model.job;return response({job:{id:job.id,source:'audio',url:job.source_url,videoId:job.video_id,durationSeconds:job.duration_seconds,title:job.title,status:job.status,audit:job.audit,report:job.report},persisted:true,reused});
  }
  if(path==='/api/jobs/'+id){if(!model.job)return {ok:false,headers:{get:()=> 'application/json'},json:async()=>({error:{code:'NOT_FOUND'}})};return response({job:model.job});}
  if(path==='/api/jobs/'+id+'/audio-request')return response({kind:'ASR_RESULT_BRIDGE_STATUS_V1',jobId:id,eligible:!model.job?.report,sourceKind:'OWNED_AUDIO',jobSourceSha256:'b'.repeat(64),workerConnected:false,executionAvailable:false,transferAvailable:true,state:'NO_REQUEST',requestId:null,revision:null,expiresAt:null,context:null,source:null,sourceBindingSha256:null,receipt:null,transcriptStored:false,sourceAccuracy:'UNVERIFIED',summaryComplete:false,providerCalls:0,canRequest:!model.job?.report,canBind:false,canReceive:false,canCancel:false,asrSummaryReady:false});
  if(path==='/api/jobs/'+id+'/audio-plan')return response({planned:true});
  throw Error('UNEXPECTED_SYNTHETIC_ROUTE '+path);
 };
 const context={document:dom,window:{sessionStorage:browserStorage},location:{hash:''},TextEncoder,crypto:{subtle:webcrypto.subtle,randomUUID:()=>id},fetch,setTimeout:()=>0,clearTimeout:()=>{},confirm:()=>true,renderApprovedSummary,beginDetailAction,detailRequestIsCurrent,
  mountAsrResultBridge:args=>mountAsrResultBridge({...args,document:dom,storage:browserStorage}),planMp3:()=>({durationSeconds:120,chunks:[{index:0,start:0,end:120,byteStart:0,byteEnd:4}]}),runAudioChunks:async()=>{audioRuns++;return {complete:false,reason:'SYNTHETIC_STOP'};}};
 runInNewContext(source,context,{filename:'synthetic-asr-record-app.js'});context.__state.mode='audio';
 return {context,elements,calls,storage,model,run:()=>context.__analyze({preventDefault(){}}),progress:()=>elements.get('#analysis-progress').textContent,content:()=>text(elements.get('#result-content')),audioRuns:()=>audioRuns};
}

test('explicit local-result mode hashes selected source, retains submission ID and creates only the analysis record',async()=>{
 let retained;const ui=mount({onCall:({call,storage})=>{if(call.path==='/api/jobs')retained=JSON.parse(storage.get('owned-local-asr-analysis-v1'));}});await ui.run();
 assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs','/api/jobs/'+id+'/audio-request']);const body=ui.calls.find(call=>call.path==='/api/jobs').body;assert.equal(body.sourceType,'audio');assert.equal(body.ownedAudioSha256,hash);assert.equal(body.submissionId,retained.id);assert.equal(retained.state,'SENT');assert.equal(body.url,undefined);assert.equal(body.transcript,undefined);
 assert.equal(ui.audioRuns(),0);assert.match(ui.progress(),/음성·공급자 요청은 보내지 않았습니다/);assert.match(ui.content(),/오디오 요청·외부 ASR 결과 연결/);
});

test('missing source-rights confirmation or unsupported/empty file prevents any API request',async()=>{
 for(const options of [{rights:false},{selected:{...file(),name:'synthetic.txt'}},{selected:{...file(),size:0}},{selected:{...file(),size:200000001}}]){const ui=mount(options);await ui.run();assert.equal(ui.calls.length,0);assert.equal(ui.audioRuns(),0);}
});

test('local-result mode cannot silently execute a selected existing free batch',async()=>{
 const ui=mount();ui.elements.get('#audio-free-batch-run').checked=true;await ui.run();assert.equal(ui.calls.length,0);assert.match(ui.progress(),/배치 선택을 해제/);
});

test('switching to local-result mode clears the now-hidden batch selection without changing stored approvals',async()=>{
 const ui=mount();ui.elements.get('#audio-free-batch-run').checked=true;ui.context.__updateLocal();assert.equal(ui.elements.get('#audio-free-batch-run').checked,false);assert.equal(ui.storage.size,0);await ui.run();assert.equal(ui.calls.filter(call=>call.path==='/api/jobs').length,1);assert.equal(ui.calls.some(call=>/approval|quota|audio-plan|audio-chunk|audio-finish|summary/.test(call.path)),false);
});

test('repeated clicks while preflight awaits create one record and no provider task',async()=>{
 const pause=deferred(),ui=mount({onCall:async({call})=>{if(call.path==='/api/preflight')await pause.promise;}});const first=ui.run();await until(()=>ui.calls.length===1);await ui.run();pause.resolve();await first;
 assert.equal(ui.calls.filter(call=>call.path==='/api/jobs').length,1);assert.equal(ui.calls.some(call=>/audio-plan|audio-chunk|audio-finish|summary|native/.test(call.path)),false);
});

test('filename, file, title, duration, resume, mode, rights and navigation changes invalidate the pending hash read',async()=>{
 const changes=[ui=>{ui.elements.get('#audio-file').files[0].name='changed-synthetic.wav';},ui=>{ui.elements.get('#audio-file').files=[file()];},ui=>{ui.elements.get('#video-title').value='다른 합성 제목';},ui=>{ui.elements.get('#duration-min').value='3';},ui=>{ui.elements.get('#resume-job').value=otherId;},ui=>{ui.elements.get('#local-asr-mode').checked=false;},ui=>{ui.elements.get('#local-asr-rights').checked=false;},ui=>{ui.context.__state.view='library';}];
 for(const change of changes){const pause=deferred(),selected=file();let reading=false;selected.arrayBuffer=async()=>{reading=true;await pause.promise;return bytes.slice().buffer;};const ui=mount({selected}),pending=ui.run();await until(()=>reading);change(ui);pause.resolve();await pending;assert.equal(ui.calls.length,0);assert.equal(ui.storage.size,0);}
});

test('input changes during preflight prevent the create POST',async()=>{
 const pause=deferred(),ui=mount({onCall:async({call})=>{if(call.path==='/api/preflight')await pause.promise;}});const pending=ui.run();await until(()=>ui.calls.length===1);ui.elements.get('#video-title').value='변경한 합성 입력';pause.resolve();await pending;assert.equal(ui.calls.length,1);assert.equal(ui.storage.size,0);
});

test('lost creation acknowledgement uses same-ID GET, and reopening never creates another analysis',async()=>{
 const storage=new Map(),model={job:null},first=mount({storage,model,lostCreate:true});await first.run();assert.deepEqual(first.calls.map(call=>call.path),['/api/preflight','/api/jobs','/api/jobs/'+id,'/api/jobs/'+id+'/audio-request']);assert.match(first.progress(),/같은 분석의 저장 기록을 조회/);
 const second=mount({storage,model});await second.run();assert.deepEqual(second.calls.map(call=>call.path),['/api/preflight','/api/jobs/'+id,'/api/jobs/'+id+'/audio-request']);assert.equal(JSON.parse(storage.get('owned-local-asr-analysis-v1')).id,id);
});

test('server uncertain-write response also uses the retained analysis ID for readback only',async()=>{
 const model={job:savedJob()},ui=mount({model,onCall:({call})=>{if(call.path==='/api/jobs')return {ok:false,headers:{get:()=> 'application/json'},json:async()=>({error:{code:'AUDIO_SUBMISSION_WRITE_UNCERTAIN'}})};}});await ui.run();assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs','/api/jobs/'+id,'/api/jobs/'+id+'/audio-request']);assert.equal(JSON.parse(ui.storage.get('owned-local-asr-analysis-v1')).id,id);assert.match(ui.progress(),/같은 분석의 저장 기록을 조회/);
});

test('unknown creation without a stored job blocks same-input resend and changed-input replacement',async()=>{
 const storage=new Map(),model={job:null},first=mount({storage,model,lostCreateWithoutSave:true});await first.run();const original=storage.get('owned-local-asr-analysis-v1');
 const second=mount({storage,model});await second.run();assert.equal(second.calls.some(call=>call.path==='/api/jobs'),false);assert.equal(storage.get('owned-local-asr-analysis-v1'),original);
 second.elements.get('#video-title').value='다른 합성 원음';await second.run();assert.equal(second.calls.some(call=>call.path==='/api/jobs'),false);assert.equal(storage.get('owned-local-asr-analysis-v1'),original);
});

test('resume verifies source type, original hash, URL absence, title, duration and ID before bridge access',async()=>{
 for(const bad of [{source_type:'url'},{audit:{ownedAudioSha256:'0'.repeat(64)}},{source_url:'https://www.youtube.com/watch?v=synthetic01'},{video_id:'synthetic01'},{title:'다른 제목'},{duration_seconds:180},{id:otherId}]){
  const ui=mount({resume:id,model:{job:{...savedJob(),...bad}}});await ui.run();assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs/'+id]);assert.match(ui.progress(),/일치하지 않습니다/);
 }
});

test('unavailable browser storage cannot create an untracked analysis',async()=>{
 const ui=mount();ui.context.window.sessionStorage.setItem=()=>{throw Error('SYNTHETIC_STORAGE_BLOCKED');};await ui.run();assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight']);
});

test('reused compact report is hydrated from owner GET and keeps source-derived chapter times',async()=>{
 const source=syntheticApprovedSource(),report=syntheticApprovedReport(source);report.kind='GEMINI_EVIDENCE_LINKED';report.approvedSummary=validateApprovedSummary(report.approvedSummary,source.segments);const model={job:projectApprovedSummary({...savedJob(),status:'TRANSCRIPT_UNVERIFIED',report},source)},ui=mount({model});await ui.run();
 assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs','/api/jobs/'+id,'/api/jobs/'+id+'/audio-request']);assert.match(ui.content(),/00:00:00 · 뚜껑과 열 유출의 조건/);assert.equal(ui.calls.some(call=>/summary|audio-plan|audio-chunk/.test(call.path)),false);
});

test('ordinary selected-MP3 provider mode retains its audio plan and is not replaced by the new mode',async()=>{
 const ui=mount({local:false,selected:{...file(),name:'synthetic-provider.mp3'}});await ui.run();assert.deepEqual(ui.calls.map(call=>call.path),['/api/preflight','/api/jobs','/api/jobs/'+id+'/audio-plan']);assert.equal(ui.audioRuns(),1);assert.equal(ui.calls.some(call=>call.path.includes('audio-request')),false);
});

test('library bridge entry uses fresh owner detail plus actual bridge GET without starting a request',async()=>{
 const model={job:savedJob()},ui=mount({model});ui.context.__state.view='library';const card=ui.context.__card(model.job);await button(card,'오디오 요청·외부 ASR 결과 연결').onclick();assert.deepEqual(ui.calls.map(call=>call.path),['/api/jobs/'+id,'/api/jobs/'+id+'/audio-request']);assert.match(text(ui.elements.get('#library-detail')),/등록된 오디오 요청 없음/);assert.equal(ui.calls.some(call=>call.method==='POST'),false);
});

test('late bridge status does not populate a different analysis and stale controls cannot write',async()=>{
 const pause=deferred(),model={job:savedJob()},ui=mount({model,onCall:async({call,response})=>{if(call.path.endsWith('/audio-request'))await pause.promise;if(call.path==='/api/jobs/'+otherId)return response({job:{id:otherId,source_type:'text',title:'다른 합성 분석',status:'TRANSCRIPT_UNVERIFIED',audit:{},report:null,duration_seconds:120}});}});ui.context.__state.view='library';
 const pending=button(ui.context.__card(model.job),'오디오 요청·외부 ASR 결과 연결').onclick();await until(()=>ui.calls.some(call=>call.path.endsWith('/audio-request')));await button(ui.context.__card({id:otherId,source_type:'text',duration_seconds:120,status:'TRANSCRIPT_UNVERIFIED'}),'리포트 열기').onclick();const before=text(ui.elements.get('#library-detail'));pause.resolve();await pending;
 assert.equal(text(ui.elements.get('#library-detail')),before);assert.equal(ui.elements.get('#library-detail').dataset.jobId,otherId);assert.equal(ui.calls.some(call=>call.method==='POST'),false);
});

test('editing local-mode input invalidates already mounted bridge actions before any request write',async()=>{
 for(const [selector,event,change] of [['#video-title','input',field=>{field.value='변경한 합성 제목';}],['#duration-min','input',field=>{field.value='3';}],['#resume-job','input',field=>{field.value=otherId;}],['#audio-file','change',field=>{field.files=[file()];}],['#local-asr-rights','change',field=>{field.checked=false;}]]){
  const ui=mount();ui.context.__bindLocal();await ui.run();const host=ui.elements.get('#result-content'),request=button(host,'오디오 요청 기록 만들기'),rights=all(host).find(item=>item.tag==='input'&&item.type==='checkbox');rights.checked=true;rights.onchange();assert.equal(request.disabled,false);const field=ui.elements.get(selector);change(field);field.handlers[event]();const count=ui.calls.length;await request.onclick();assert.equal(ui.calls.length,count);assert.match(ui.progress(),/입력 또는 확인 항목이 바뀌었습니다/);
 }
});
