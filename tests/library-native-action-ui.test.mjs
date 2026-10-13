import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {detailRequestIsCurrent} from '../web/site/audio-runner.mjs';

const app=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8')
 .replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'')
 .replace(/\ninit\(\);\s*$/,'\nglobalThis.__loadLibrary=loadLibrary;globalThis.__switchView=switchView;globalThis.__state=state;');
const node=tag=>({tag,children:[],dataset:{},hidden:false,disabled:false,append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(key,value){this[key]=value;},scrollIntoView(){}});
const action=(card,label)=>card.children.find(child=>child.className==='library-actions')?.children.find(child=>child.textContent===label);
const collect=item=>[item.textContent||'',...(item.children||[]).flatMap(collect)].join(' ');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

function mount(initial){
 const elements=new Map([['#library-search',Object.assign(node('input'),{value:''})],['#library-list',node('div')],['#library-prev',node('button')],['#library-next',node('button')],['#library-page',node('span')],['#library-detail',node('div')],['#toast',node('div')],['#crumb',node('span')]]);
 let listed=initial,detail=initial[0],allow=false,detailGate=null;
 const calls=[],confirmations=[];
 const fetcher=async(path,options)=>{
  calls.push({path,method:options.method});
  let result;
  if(path.startsWith('/api/jobs?'))result={jobs:listed,hasMore:false};
  else if(path==='/api/jobs/job-a'){if(detailGate)await detailGate;result={job:detail};}
  else if(path==='/api/jobs/job-a/native-poll')result={job:detail,persisted:true};
  else if(path==='/api/jobs/job-a/source')result={source:{segments:[{id:1,startMs:0,text:'저장된 발언'}]}};
  else if(path==='/api/jobs/job-a/audio-progress')result={chunks:[],temporaryResultsCleaned:true};
  else throw Error('unexpected request '+path);
  return {ok:true,headers:{get:()=> 'application/json'},json:async()=>result};
 };
 const context={document:{createElement:node,querySelector:selector=>elements.get(selector),querySelectorAll:()=>[],hidden:false},window:{},location:{hash:''},URLSearchParams,fetch:fetcher,confirm:message=>{confirmations.push(message);return allow;},clearTimeout,setTimeout:()=>0,detailRequestIsCurrent,beginDetailAction:(target,id,current)=>{target.dataset.jobId=id;return current+1;},cleanedAudioComplete:()=>true};
 runInNewContext(app,context,{filename:'web/site/app.js'});context.__state.view='library';
 return {elements,calls,confirmations,load:context.__loadLibrary,navigate:context.__switchView,setListed:value=>{listed=value;},setDetail:value=>{detail=value;},pauseDetail:value=>{detailGate=value;},allow:()=>{allow=true;}};
}

test('Supadata pending action checks fresh job and requires explicit API request confirmation',async()=>{
 const pending={id:'job-a',source_type:'url',status:'NATIVE_PENDING',nativePollReady:true,audit:{providerJobId:'native-123'},duration_seconds:120,created_at:'2026-10-12T00:00:00Z'};
 const ui=mount([pending]);await ui.load();
 const card=ui.elements.get('#library-list').children[0],button=action(card,'Supadata 자막 처리 상태 조회 · API 요청');assert.ok(button);
 await button.onclick();assert.deepEqual(ui.calls.map(call=>call.method),['GET','GET']);assert.match(ui.confirmations[0],/Supadata API에 실제/);
 assert.equal(ui.calls.some(call=>call.method==='POST'),false);
 ui.allow();await button.onclick();
 assert.deepEqual(ui.calls.slice(-2).map(call=>[call.path,call.method]),[['/api/jobs/job-a','GET'],['/api/jobs/job-a/native-poll','POST']]);
 assert.equal(ui.calls.filter(call=>call.method==='POST').length,1);
});

test('stale pending action and refreshed nonpending jobs never poll Supadata',async()=>{
 const pending={id:'job-a',source_type:'url',status:'NATIVE_PENDING',nativePollReady:true,audit:{providerJobId:'native-123'},duration_seconds:120,created_at:'2026-10-12T00:00:00Z'};
 const ui=mount([pending]);await ui.load();const stale=action(ui.elements.get('#library-list').children[0],'Supadata 자막 처리 상태 조회 · API 요청');ui.allow();
 ui.setDetail({...pending,status:'NEED_UPLOAD',audit:{providerJobId:'native-123'}});await stale.onclick();assert.equal(ui.calls.some(call=>call.method==='POST'),false);assert.equal(ui.confirmations.length,0);
 for(const job of [
  {...pending,status:'NEED_UPLOAD',nativePollReady:true},
  {...pending,audit:{providerJobId:null},nativePollReady:false},
  {...pending,source_type:'audio',status:'TRANSCRIPT_UNVERIFIED',nativePollReady:true,audioTranscriptComplete:true}
 ]){
  ui.setListed([job]);await ui.load();const card=ui.elements.get('#library-list').children[0];
  assert.equal(action(card,'Supadata 자막 처리 상태 조회 · API 요청'),undefined);
  if(job.audioTranscriptComplete)assert.match(collect(card),/리포트 열기 → 원문·근거 보기/);
 }
 assert.equal(ui.calls.some(call=>call.method==='POST'),false);
});

test('leaving and returning during pending job GET cannot show confirmation or POST',async()=>{
 const pending={id:'job-a',source_type:'url',status:'NATIVE_PENDING',nativePollReady:true,audit:{providerJobId:'native-123'},duration_seconds:120,created_at:'2026-10-12T00:00:00Z'};
 const ui=mount([pending]);await ui.load();ui.allow();
 let release;ui.pauseDetail(new Promise(resolve=>{release=resolve;}));
 const click=action(ui.elements.get('#library-list').children[0],'Supadata 자막 처리 상태 조회 · API 요청').onclick();await tick();
 ui.navigate('analyze');ui.navigate('library');release();await click;await tick();
 assert.equal(ui.confirmations.length,0);assert.equal(ui.calls.some(call=>call.method==='POST'),false);
});

test('starting another detail action while native job GET waits cancels its POST',async()=>{
 const pending={id:'job-a',source_type:'url',status:'NATIVE_PENDING',nativePollReady:true,audit:{providerJobId:'native-123'},duration_seconds:120,created_at:'2026-10-12T00:00:00Z'};
 const ui=mount([pending]);await ui.load();ui.allow();
 let release;ui.pauseDetail(new Promise(resolve=>{release=resolve;}));
 const card=ui.elements.get('#library-list').children[0],native=action(card,'Supadata 자막 처리 상태 조회 · API 요청').onclick();await tick();
 const opened=action(card,'리포트 열기').onclick();release();await Promise.all([native,opened]);
 assert.equal(ui.confirmations.length,0);assert.equal(ui.calls.some(call=>call.method==='POST'),false);
});

test('completed audio report opens stored source with GET and no provider poll',async()=>{
 const audio={id:'job-a',source_type:'audio',status:'TRANSCRIPT_UNVERIFIED',nativePollReady:false,audioTranscriptComplete:true,audit:{audioProcessingCoverage:1},report:null,duration_seconds:5892,created_at:'2026-10-12T00:00:00Z'};
 const ui=mount([audio]);await ui.load();const card=ui.elements.get('#library-list').children[0];
 await action(card,'리포트 열기').onclick();await tick();
 const source=ui.elements.get('#library-detail').children.find(child=>child.className==='library-actions')?.children.find(child=>child.textContent==='원문·근거 보기');
 assert.ok(source);await source.onclick();
 assert.ok(ui.calls.some(call=>call.path==='/api/jobs/job-a/source'&&call.method==='GET'));
 assert.equal(ui.calls.some(call=>call.method==='POST'),false);
 assert.match(collect(ui.elements.get('#library-detail')),/저장된 발언/);
});
