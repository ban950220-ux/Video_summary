import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const node=tag=>({tag,children:[],dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}});
const collect=item=>[item.textContent||'',...(item.children||[]).map(collect)].join(' ');
function mount(fetcher){
 const target=node('div'),toast=node('div');target.dataset.jobId='job-a';
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__choice=showSummaryChoice;globalThis.__review=showCompleteSynthesisReview;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:()=>toast,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent:()=>true,setTimeout:()=>0,clearTimeout};
 runInNewContext(source,context);context.__state.view='library';return {context,target};
}
const response=(data,ok=true)=>({ok,headers:{get:()=> 'application/json'},json:async()=>data});
test('the outer quote choice displays legacy uncertainty and disables issuance before any POST',async()=>{
 const calls=[];
 const choice={geminiQuote:{blocked:true,state:'QUOTE_UNCERTAIN_LEGACY'},transcription:{complete:true},summary:{complete:false,savedRawStages:0,rawStages:79,remainingRawStages:79,recoveryReviewRequired:true},free:{model:'mock',eta:{reason:'UNKNOWN'}},paid:{quoteIssueReady:true,executionEnabled:false}};
 const {context,target}=mount(async(path,options)=>{calls.push(options.method);return response(path.endsWith('/summary-choice')?choice:{approval:null,reservations:[]});});
 context.__choice({id:'job-a'},target,0);await tick();
 const host=target.children[0];assert.match(collect(host),/QUOTE_UNCERTAIN_LEGACY/);
 const blocked=host.children.find(item=>item.tag==='button'&&item.textContent.includes('견적 발급 차단'));assert.equal(blocked.disabled,true);
 assert.equal(host.children.some(item=>item.tag==='button'&&item.textContent.includes('견적')&&item.textContent.includes('발급')&&!item.disabled),false);assert.ok(calls.every(method=>method==='GET'));
});
test('stale Groq recovery does not prevent read-only stored transcript review or claim completion',async()=>{
 const calls=[],segments=[{id:1,startMs:0,endMs:1000,text:'원문 부정: 완료가 아니다.'},{id:2,startMs:1000,endMs:2000,text:'2023년 12%는 불확실하다.'}];
 const {context,target}=mount(async(path,options)=>{calls.push({path,method:options.method});return path.endsWith('/groq-summary-complete')?response({error:{code:'SUMMARY_RECOVERY_SCOPE_CHANGED',message:'stale recovery'}},false):response({source:{raw:segments.map(item=>item.text).join('\n'),segments}});});
 await context.__review({id:'job-a'},target,0);
 const text=collect(target);assert.match(text,/SUMMARY_RECOVERY_SCOPE_CHANGED/);assert.match(text,/완료되지 않았습니다/);for(const item of segments)assert.ok(text.includes(item.text));
 assert.equal(target.children.some(item=>item.tag==='button'||item.tag==='input'),false);assert.deepEqual(calls.map(item=>item.method),['GET','GET']);assert.ok(calls[1].path.endsWith('/source'));
});

test('stale recovery exposes an explicit diagnostic GET without approval, reset or provider POST',async()=>{
 const calls=[],diagnostic={kind:'GROQ_RECOVERY_SCOPE_DIAGNOSTIC_V1',providerCalls:0,writes:0,executionAllowed:false,sourceStatus:'STORED_SOURCE_VALID',storedRecoveryCounts:[{state:'DONE',count:1}],omittedRecords:0,records:[{stage:'raw:0',verification:'BLOCKED',reason:'SUMMARY_RECOVERY_SCOPE_CHANGED',comparison:{sameSerializedRecord:false,sameCanonicalRecord:false,fieldMatches:{auditSha256:false,report:true}}}],credentialProjectBinding:'NOT_STORED_CANNOT_VERIFY'};
 const {context,target}=mount(async(path,options)=>{calls.push({path,method:options.method});if(path.endsWith('/groq-summary-complete'))return response({error:{code:'SUMMARY_RECOVERY_SCOPE_CHANGED',message:'stale recovery'}},false);if(path.endsWith('/groq-summary-recovery-diagnostic'))return response(diagnostic);return response({source:{segments:[{id:1,startMs:0,endMs:1000,text:'saved source'}]}});});
 await context.__review({id:'job-a'},target,0);const control=target.children.find(item=>item.tag==='div'&&item.children.some(child=>child.textContent==='복구 스코프 무호출 진단'));assert.ok(control);await control.children.find(item=>item.tag==='button').onclick();assert.match(collect(target),/auditSha256/);assert.match(collect(target),/복구·재호출·완료 처리는 하지 않았습니다/);assert.ok(calls.every(item=>item.method==='GET'));assert.equal(calls.filter(item=>item.path.endsWith('/groq-summary-recovery-diagnostic')).length,1);
});
