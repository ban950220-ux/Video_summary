import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {runApprovedGroqSummary,detailRequestIsCurrent} from '../web/site/audio-runner.mjs';
import {groqSummaryProgress} from '../web/site/groq-summary-progress.mjs';
import {fmtRetryDate} from '../web/site/audio-progress-plan.mjs';

const json=data=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>data});
const failure=(code,status=409)=>({ok:false,status,headers:{get:()=> 'application/json'},json:async()=>({error:{code,message:code}})});
const pause=()=>new Promise(resolve=>setImmediate(resolve));
const scope=(approved=true)=>({approved,jobId:'job-a',transcriptHash:'a'.repeat(64),model:'openai/gpt-oss-120b',state:'APPROVED',expiresAt:Date.now()+3600000,windowStart:0,totalRequests:3,maxRequests:3,maxInputTokensPerRequest:4800,maxCompletionTokensPerRequest:1800,totalTokenUpperBound:19800,credentialGeneration:'test-proof'});
const ledger=(approved=true)=>({jobId:'job-a',transcriptHash:'a'.repeat(64),approval:approved?{state:'APPROVED',expiresAt:Date.now()+3600000,windowStart:0,maxRequests:3,totalTokenUpperBound:19800}:null,completedStages:0,plannedMaximumRequests:3,activeStage:null,finalReportSaved:false,nextEligibleAt:null});
function harness(fetcher,{setTimeoutFn=()=>0}={}){
 const node=tag=>({tag,children:[],hidden:false,dataset:{},disabled:false,append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}});
 const target=node('div');target.dataset.jobId='job-a';const toast=node('div');
 const listeners=new Map(),intervals=new Map();let timerId=0;
 const document={createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false,addEventListener(name,fn){listeners.set(name,fn);},removeEventListener(name){listeners.delete(name);}};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGroqSummaryChoice=showGroqSummaryChoice;globalThis.__state=state;');
 const context={document,window:{},location:{hash:''},fetch:fetcher,clearTimeout,setTimeout:setTimeoutFn,setInterval:fn=>{intervals.set(++timerId,fn);return timerId;},clearInterval:id=>intervals.delete(id),runApprovedGroqSummary,detailRequestIsCurrent,groqSummaryProgress,fmtRetryDate};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';
 const job={id:'job-a',source_type:'audio',duration_seconds:600,report:null};
 context.__showGroqSummaryChoice(job,target,0);
 const heading=()=>target.children[1]?.children[0]?.textContent;
 const panel=()=>target.children[2]?.children[0];
 const button=text=>panel()?.children.find(item=>item.tag==='button'&&item.textContent===text);
 return {target,document,listeners,intervals,heading,panel,button,review:target.children[0],refresh:target.children[1].children[2]};
}

test('approval stores only approval, shows separate execution, and slow POST needs D1 claim evidence',async()=>{
 let approved=false,claimed=false,done=false,posts=0,approvalPosts=0,releasePost,postStarted;
 const approvedScope=scope(true),unapprovedScope={...approvedScope,approved:false};
 const postGate=new Promise(resolve=>releasePost=resolve),posted=new Promise(resolve=>postStarted=resolve);
 const calls=[];
 const ui=harness(async(path,options)=>{
  calls.push({path,method:options.method});
  if(path.endsWith('/groq-summary-status'))return json({...ledger(approved),activeStage:claimed?{key:'raw:0',state:'CLAIMED'}:null,completedStages:done?1:0,finalReportSaved:done});
  if(path.endsWith('/groq-summary-approval')&&options.method==='GET')return json(approved?approvedScope:unapprovedScope);
  if(path.endsWith('/groq-summary-approval')&&options.method==='POST'){approvalPosts++;approved=true;return json(approvedScope);}
  if(path.endsWith('/groq-summary')&&options.method==='POST'){posts++;postStarted();await postGate;done=true;return json({persisted:true,job:{id:'job-a',status:'DONE',report:{kind:'GROQ_EVIDENCE_LINKED',summary:[],chapters:[],claims:[],numbers:[],critical:[],conclusion:'완료'}}});}
  throw Error('unexpected path '+path);
 });
 await pause();
 assert.match(ui.heading(),/범위 검토|기록 확인/);
 await ui.review.onclick();
 const form=ui.panel().children.find(item=>item.tag==='form');
 for(const label of form.children.filter(item=>item.tag==='label'))label.children[0].checked=true;
 await form.onsubmit({preventDefault(){}});
 assert.equal(approvalPosts,1);assert.equal(posts,0);
 const run=ui.button('승인된 Groq Free 요약 실행');assert.ok(run,JSON.stringify(ui.panel()?.children.map(x=>({tag:x.tag,text:x.textContent,children:x.children?.length}))));assert.equal(run.disabled,false);
 const execution=run.onclick();
 assert.match(ui.heading(),/승인 상태 확인 중/);
 await posted;
 assert.equal(posts,1);assert.match(ui.heading(),/요청 전송 중/);
 await run.onclick();assert.equal(posts,1);
 claimed=true;for(const tick of [...ui.intervals.values()])await tick();await pause();
 assert.match(ui.heading(),/앱 서버 접수 확인/);
 releasePost();await execution;
 assert.equal(posts,1);assert.equal(approvalPosts,1);
 assert.equal(ui.intervals.size,0);
 assert.ok(calls.some(call=>call.path.endsWith('/groq-summary-status')));
});

test('hidden tab before dispatch stops locally; reopening only reads saved state',async()=>{
 let approvalRead,releaseApproval,posts=0,statusReads=0;
 const stableScope=scope();
 const gate=new Promise(resolve=>releaseApproval=resolve),reading=new Promise(resolve=>approvalRead=resolve);
 const ui=harness(async(path,options)=>{
  if(path.endsWith('/groq-summary-status')){statusReads++;return json(ledger());}
  if(path.endsWith('/groq-summary-approval')){if(statusReads>1){approvalRead();await gate;}return json(stableScope);}
  if(path.endsWith('/groq-summary')&&options.method==='POST'){posts++;throw Error('no provider');}
  throw Error('unexpected path');
 });
 await pause();await ui.review.onclick();
 const run=ui.button('승인된 Groq Free 요약 실행');assert.ok(run,JSON.stringify(ui.panel()?.children.map(x=>({tag:x.tag,text:x.textContent,children:x.children?.length}))));assert.equal(run.disabled,false);
 const executing=run.onclick();await reading;
 ui.document.hidden=true;ui.listeners.get('visibilitychange')();releaseApproval();await executing;
 assert.equal(posts,0);assert.match(ui.heading(),/자동 진행 중단/);
 ui.document.hidden=false;
 await ui.refresh.onclick();
 assert.equal(posts,0);assert.equal(run.disabled,false);
 assert.match(ui.heading(),/승인 저장 확인/);
 assert.equal(ui.review.disabled,false);
 await run.onclick();
 assert.equal(posts,1);
 const readsBefore=statusReads;
 const reentered=harness(async(path)=>path.endsWith('/groq-summary-status')?json({...ledger(),completedStages:1}):json(scope()));
 await pause();assert.match(reentered.heading(),/중간 단계 저장/);assert.equal(posts,1);assert.equal(statusReads,readsBefore);
});

test('lost approval response is resolved by ledger read without starting a model request',async()=>{
 let approved=false,approvalPosts=0,stagePosts=0;
 const valid=scope(true),proposal={...valid,approved:false};
 const ui=harness(async(path,options)=>{
  if(path.endsWith('/groq-summary-status'))return json(ledger(approved));
  if(path.endsWith('/groq-summary-approval')&&options.method==='GET')return json(approved?valid:proposal);
  if(path.endsWith('/groq-summary-approval')&&options.method==='POST'){approvalPosts++;approved=true;throw Error('approval response lost');}
  if(path.endsWith('/groq-summary')&&options.method==='POST'){stagePosts++;throw Error('unexpected model send');}
  throw Error('unexpected path');
 });
 await pause();await ui.review.onclick();
 const form=ui.panel().children.find(item=>item.tag==='form');
 for(const label of form.children.filter(item=>item.tag==='label'))label.children[0].checked=true;
 await form.onsubmit({preventDefault(){}});
 assert.equal(approvalPosts,1);assert.equal(stagePosts,0);
 assert.ok(ui.button('승인된 Groq Free 요약 실행'));
 assert.match(ui.heading(),/승인 저장/);
});

test('network loss after POST keeps outcome uncertain and blocks automatic or repeated sends',async()=>{
 let stagePosts=0;
 const stable=scope();
 const ui=harness(async(path,options)=>{
  if(path.endsWith('/groq-summary-status'))return json(ledger());
  if(path.endsWith('/groq-summary-approval'))return json(stable);
  if(path.endsWith('/groq-summary')&&options.method==='POST'){stagePosts++;throw Error('connection lost');}
  throw Error('unexpected path');
 });
 await pause();await ui.review.onclick();const run=ui.button('승인된 Groq Free 요약 실행');
 await run.onclick();
 assert.equal(stagePosts,1);assert.match(ui.heading(),/접수·결과 확인 중/);assert.equal(run.disabled,true);
 await pause();assert.equal(stagePosts,1);
});

test('lost POST response with a new D1 DONE row shows saved partial result without replay',async()=>{
 let stagePosts=0,completed=0;
 const stable=scope();
 const ui=harness(async(path,options)=>{
  if(path.endsWith('/groq-summary-status'))return json({...ledger(),completedStages:completed,lastSavedStage:completed?{key:'raw:0',state:'DONE'}:null});
  if(path.endsWith('/groq-summary-approval'))return json(stable);
  if(path.endsWith('/groq-summary')&&options.method==='POST'){stagePosts++;completed=1;throw Error('response lost after D1 save');}
  throw Error('unexpected path');
 });
 await pause();await ui.review.onclick();const run=ui.button('승인된 Groq Free 요약 실행');
 await run.onclick();
 assert.equal(stagePosts,1);assert.match(ui.heading(),/새 중간 단계 저장 확인/);assert.equal(run.disabled,true);
 await pause();assert.equal(stagePosts,1);
});

test('429 uncertainty and repeated 500 stay visible; expired approval cannot start',async()=>{
 for(const [code,stageState,expected] of [['429','FAILED_UNCERTAIN',/결과 불확실/],['LIVE_INTERNAL_ERROR',null,/요약 중단/]]){
  let stagePosts=0,failed=false;
  const stable=scope();
  const ui=harness(async(path,options)=>{
   if(path.endsWith('/groq-summary-status'))return json({...ledger(),activeStage:failed&&stageState?{key:'raw:0',state:stageState}:null});
   if(path.endsWith('/groq-summary-approval'))return json(stable);
   if(path.endsWith('/groq-summary')&&options.method==='POST'){stagePosts++;failed=true;return failure(code,code==='429'?409:500);}
   throw Error('unexpected path');
  });
  await pause();await ui.review.onclick();const run=ui.button('승인된 Groq Free 요약 실행');
  await run.onclick();assert.equal(stagePosts,1);assert.match(ui.heading(),expected);assert.equal(stagePosts,1);
 }
 const expired=scope();expired.expiresAt=Date.now()-1000;
 const ui=harness(async(path)=>path.endsWith('/groq-summary-status')?json({...ledger(),approval:{...ledger().approval,expiresAt:expired.expiresAt}}):json(expired));
 await pause();await ui.review.onclick();assert.equal(ui.button('승인된 Groq Free 요약 실행').disabled,true);assert.match(ui.heading(),/승인 만료/);
});

test('61-second local wait stops after tab hides and never sends another stage',async()=>{
 let stagePosts=0,waitCallback;
 const stable=scope();
 const ui=harness(async(path,options)=>{
  if(path.endsWith('/groq-summary-status'))return json({...ledger(),completedStages:stagePosts});
  if(path.endsWith('/groq-summary-approval'))return json(stable);
  if(path.endsWith('/groq-summary')&&options.method==='POST'){stagePosts++;return json({pending:true,stage:'raw:0'});}
  throw Error('unexpected path');
 },{setTimeoutFn:fn=>{waitCallback=fn;return 1;}});
 await pause();await ui.review.onclick();const run=ui.button('승인된 Groq Free 요약 실행');
 const execution=run.onclick();
 for(let i=0;i<10&&!waitCallback;i++)await pause();
 assert.equal(stagePosts,1);assert.match(ui.heading(),/이 탭에서 다음 단계 전송까지/);
 ui.document.hidden=true;ui.listeners.get('visibilitychange')();waitCallback();await execution;
 assert.equal(stagePosts,1);assert.match(ui.heading(),/자동 진행 중단/);
});

test('older status response cannot overwrite a newer D1 snapshot',async()=>{
 let resolveOld,reads=0;
 const old=new Promise(resolve=>resolveOld=resolve);
 const ui=harness(async(path)=>{
  if(path.endsWith('/groq-summary-status'))return ++reads===1?old:json({...ledger(),completedStages:2});
  if(path.endsWith('/groq-summary-approval'))return json(scope());
  throw Error('unexpected path');
 });
 await ui.refresh.onclick();
 assert.match(ui.heading(),/중간 단계 저장/);
 resolveOld(json(ledger(false)));await pause();
 assert.match(ui.heading(),/중간 단계 저장/);
});
