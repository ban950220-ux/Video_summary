import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(initial){
 const node=tag=>({tag,children:[],dataset:{},append(...x){this.children.push(...x);},prepend(...x){this.children.unshift(...x);},replaceChildren(...x){this.children=x;},setAttribute(k,v){(this.attrs??={})[k]=v;}});
 const target=node('div'),toast=node('div');target.dataset.jobId='fixture';
 const f={status:initial,post:deferred(),reads:[],calls:[],target};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.show=showGeminiTwoPassChoice;globalThis.stateForTest=state;');
 const context={detailRequestIsCurrent:()=>true,document:{createElement:node,querySelector:s=>s==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},setTimeout,clearTimeout,fetch:async(path,options)=>{f.calls.push({path,method:options.method});if(options.method==='POST')await f.post.promise;const status=options.method!=='POST'&&f.reads.length?await f.reads.shift().promise:f.status;return {ok:true,headers:{get:()=> 'application/json'},json:async()=>structuredClone(status)};}};
 runInNewContext(source,context);context.stateForTest.view='library';context.show({id:'fixture'},target,0);
 f.host=()=>target.children[0];f.find=text=>f.host().children.find(n=>n.tag==='button'&&n.textContent===text);
 f.text=()=>f.host().children.map(n=>n.textContent??'').join(' ');
 f.check=()=>{for(const n of f.host().children)if(n.tag==='label'&&n.children[0])n.children[0].checked=true;};
 return f;
}
const quote={model:'fixture',quoteSha256:'a'.repeat(64),expiresAt:Date.now()+600000,inputTokensCounted:300,inputTokensPerCallCap:1000,outputTokensPerCallCap:500,preTaxMicroUsd:100,costBufferMicroUsd:100,costBufferBps:10000,maxMicroUsd:200};

for(const spec of [
 {name:'quote',status:{state:'NOT_STARTED',calls:[]},button:'전체 전사 전송 동의 후 견적 요청 · 생성 없음'},
 {name:'approval',status:{state:'QUOTED',quote,calls:[]},button:'표시된 최대 금액 승인 저장 · 생성 없음'},
 {name:'review',status:{state:'FIRST_READY',next:'RUN_REVIEW',quote,calls:[{phase:0,state:'SETTLED',responseStored:true}]},button:'승인된 2차 원문 대조 실행'},
])test(`pending ${spec.name} shows progress and a stale status read cannot expose another POST`,async()=>{
 const f=fixture(spec.status);await tick();f.check();const button=f.find(spec.button);assert.ok(button);
 const running=button.onclick();await tick();
 assert.match(f.text(),/진행 중/);
 assert.ok(f.host().children.some(n=>n.attrs?.role==='status'));
 const refresh=f.find('저장 상태 다시 조회');assert.ok(refresh);await refresh.onclick();await tick();
 assert.equal(f.find(spec.button),undefined);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 // A detached old handler is also fenced while the request is pending.
 await button.onclick();assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 f.post.resolve();await running;
});

test('lost phase-1 ACK cannot be cleared by the already-settled phase-0 receipt',async()=>{
 const f=fixture({state:'FIRST_READY',next:'RUN_REVIEW',quote,calls:[{phase:0,state:'SETTLED',responseStored:true}]});await tick();
 const running=f.find('승인된 2차 원문 대조 실행').onclick();f.post.reject(Error('LOCAL_FIXTURE_ACK_LOSS'));await running;
 assert.equal(f.find('승인된 2차 원문 대조 실행'),undefined);assert.match(f.text(),/불확실/);
 await f.find('저장 상태 다시 조회').onclick();assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 assert.equal(f.find('승인된 2차 원문 대조 실행'),undefined);
});

test('approved status offers only the first explicit generation and never starts it automatically',async()=>{
 const f=fixture({state:'QUOTED',quote,calls:[]});await tick();f.check();
 const running=f.find('표시된 최대 금액 승인 저장 · 생성 없음').onclick();
 f.status={state:'APPROVED',quote,calls:[]};f.post.resolve();await running;
 assert.ok(f.find('승인된 1차 전체 요약 실행'));assert.equal(f.find('승인된 2차 원문 대조 실행'),undefined);
 assert.equal(f.calls.filter(c=>c.path.endsWith('-run')).length,0);
});

test('a stale failed status read cannot replace a newer completed report view',async()=>{
 const settledFirst={phase:0,state:'SETTLED',responseStored:true};
 const f=fixture({state:'FIRST_READY',next:'RUN_REVIEW',quote,calls:[settledFirst]});await tick();
 const running=f.find('승인된 2차 원문 대조 실행').onclick();await tick();
 const stale=deferred();f.reads.push(stale);
 const pendingRead=f.find('저장 상태 다시 조회').onclick();await tick();
 f.status={state:'COMPLETE',quote,calls:[settledFirst,{phase:1,state:'SETTLED',responseStored:true}]};
 f.post.resolve();await running;
 assert.ok(f.find('저장 보고서 열기'));
 stale.reject(Error('LOCAL_FIXTURE_STALE_STATUS_TIMEOUT'));await pendingRead;
 assert.ok(f.find('저장 보고서 열기'));
 assert.doesNotMatch(f.text(),/요청 결과 또는 저장 상태가 불확실/);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
