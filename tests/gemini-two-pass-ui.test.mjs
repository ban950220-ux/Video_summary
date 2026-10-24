import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('PASS review needs explicit caveat acknowledgement before a no-provider save',async()=>{
 const node=tag=>({tag,children:[],dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-accept';
 const calls=[],quote={sourceSha256:'a'.repeat(64),quoteSha256:'b'.repeat(64),expiresAt:Date.now()-1};
 let status={state:'ISSUES',quote,sourceAssessmentSha256:'f'.repeat(64),auditSha256:'c'.repeat(64),reviewVerdict:'PASS',review:{verdict:'PASS',issues:[]},calls:[{phase:0,state:'SETTLED',responseSha256:'d'.repeat(64)},{phase:1,state:'SETTLED',responseSha256:'e'.repeat(64)}]};
 const fetcher=async(path,options)=>{calls.push({path,method:options.method,body:options.body});if(path.endsWith('-accept'))status={...status,state:'COMPLETE'};return {ok:true,headers:{get:()=> 'application/json'},json:async()=>status};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__show=showGeminiTwoPassChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent:()=>true,setTimeout,clearTimeout};runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__show({id:'job-accept'},target,0);await new Promise(resolve=>setTimeout(resolve,0));
 const host=target.children[0],button=host.children.find(item=>item.tag==='button'&&item.textContent==='Save source-based report with limitations');assert.ok(button);
 await button.onclick();assert.equal(calls.filter(item=>item.method==='POST').length,0);
 const checks=host.children.filter(item=>item.tag==='label'&&item.children?.[0]?.tag==='input'&&item.textContent?.startsWith('I ')||item.tag==='label'&&item.textContent?.startsWith('Accept this summary'));
 assert.equal(checks.length,3);for(const check of checks)check.children[0].checked=true;
 await button.onclick();assert.equal(calls.filter(item=>item.method==='POST').length,1);const submitted=JSON.parse(calls.find(item=>item.method==='POST').body);assert.equal(submitted.confirmNoProviderCall,true);assert.equal(submitted.sourceAssessmentSha256,'f'.repeat(64));assert.equal(submitted.reviewReceiptSha256,'e'.repeat(64));
});

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('saved partial Gemini report renders the summary, source limits and stale warning',()=>{
 const node=tag=>({tag,children:[],dataset:{},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div');
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__show=showReport;');
 const context={document:{createElement:node,querySelector:()=>null},window:{},location:{hash:''},setTimeout,clearTimeout};runInNewContext(source,context);
 context.__show({status:'SOURCE_REVIEW_REQUIRED',report:{kind:'GEMINI_TWO_PASS_EVIDENCE_LINKED',compositionMode:'gemini-two-pass-v1',summaryCompletion:'COMPLETE',sourceBinding:'STALE_SOURCE',sourceAssessment:{status:'PARTIAL_TRANSCRIPT',provenance:'GROQ_OWNED_AUDIO',durationSeconds:10,range:{firstStartMs:0,lastEndMs:2000}},summary:[{text:'Saved summary',evidenceIds:[1]}]}},target,true);
 const text=element=>[element.textContent??'',...(element.children??[]).map(text)].join(' '),rendered=text(target);
 assert.match(rendered,/Saved summary/);assert.match(rendered,/PARTIAL_TRANSCRIPT/);assert.match(rendered,/GROQ_OWNED_AUDIO/);assert.match(rendered,/0–2000 ms/);assert.match(rendered,/STALE_SOURCE/);assert.match(rendered,/다시 검토/);assert.doesNotMatch(rendered,/AI 요약 아님/);
});
test('a Groq recovery warning leaves the Gemini choice reachable without a provider POST',async()=>{
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-a';
 const choice={transcription:{complete:true},summary:{complete:false,savedRawStages:0,rawStages:79,remainingRawStages:79,recoveryReviewRequired:true},free:{model:'mock-free',inputTokensUpperPerCall:4800,outputTokensUpperPerCall:1800,eta:{reason:'UNKNOWN'}},paid:{executionEnabled:false,quoteIssueReady:false,reason:'별도 승인 필요',model:'gemini-3.1-flash-lite',priceVersion:'v1',maxRetries:0}};
 const calls=[],fetcher=async(path,options)=>{calls.push({path,method:options.method});const result=path.endsWith('/summary-choice')?choice:path.endsWith('/paid-summary-status')?{approval:null,reservations:[]}:{state:'NOT_STARTED',calls:[]};return {ok:true,headers:{get:()=> 'application/json'},json:async()=>result};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showSummaryChoice=showSummaryChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent:()=>true,setTimeout,clearTimeout};runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__showSummaryChoice({id:'job-a'},target,0);await tick();
 const host=target.children[0];assert.ok(host.children.some(item=>item.textContent?.includes('Groq 복구 기록의 근거')));const gemini=host.children.find(item=>item.tag==='button'&&item.textContent?.includes('Gemini 전체 전사 요약'));assert.ok(gemini);gemini.onclick();await tick();
 assert.ok(target.children[0].children.some(item=>item.textContent?.includes('Tier 1 유료')));assert.deepEqual(calls.map(item=>item.method),['GET','GET','GET']);
});
test('two-pass option describes paid project, asks for quote and approval before offering either generation',async()=>{
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-a';
 const calls=[],quote={model:'gemini-3.1-flash-lite',inputTokensCounted:50524,inputTokensPerCallCap:66908,outputTokensPerCallCap:8192,preTaxMicroUsd:58030,costBufferMicroUsd:58030,maxMicroUsd:116060,expiresAt:Date.now()+600000,quoteSha256:'a'.repeat(64)};
 let status={state:'NOT_STARTED',calls:[]};
 const fetcher=async(path,options)=>{calls.push({path,method:options.method,body:options.body});if(path.endsWith('-quote'))status={state:'QUOTED',calls:[],quote};return {ok:true,headers:{get:()=> 'application/json'},json:async()=>status};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGeminiTwoPassChoice=showGeminiTwoPassChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent:()=>true,setTimeout,clearTimeout};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__showGeminiTwoPassChoice({id:'job-a'},target,0);await tick();
 const host=target.children[0];assert.ok(host.children.some(item=>item.textContent?.includes('Tier 1 유료')));assert.equal(host.children.some(item=>item.tag==='button'&&item.textContent?.includes('실행')),false);
 const consent=host.children.find(item=>item.tag==='label'&&item.textContent?.includes('Google')),button=host.children.find(item=>item.tag==='button'&&item.textContent?.includes('견적 요청'));assert.ok(consent);await button.onclick();assert.deepEqual(calls.map(item=>item.method),['GET']);consent.children[0].checked=true;await button.onclick();await tick();
 assert.deepEqual(calls.map(item=>item.method),['GET','POST','GET']);assert.equal(JSON.parse(calls[1].body).confirmFullTranscriptSentToGoogleForTokenCount,true);assert.ok(host.children.some(item=>item.textContent?.includes('계산 기반 실행 승인 상한')));assert.ok(host.children.some(item=>item.textContent?.includes('금액 승인 저장')));assert.equal(calls.some(item=>item.path.endsWith('-run')),false);
});
test('unused quote UI separates archive approval, Google transcript consent and paid generation',async()=>{
 const node=tag=>({tag,children:[],dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-b';
 const quote={model:'gemini-3.1-flash-lite',inputTokensCounted:300,inputTokensPerCallCap:16684,outputTokensPerCallCap:8192,preTaxMicroUsd:100,costBufferMicroUsd:100,maxMicroUsd:200,expiresAt:Date.now()-1,quoteSha256:'a'.repeat(64)};
 let status={state:'CANCELLED',quote,calls:[]};const calls=[];
 const fetcher=async(path,options)=>{calls.push({path,method:options.method,body:options.body});if(path.endsWith('-quote'))status={state:'QUOTED',quote:{...quote,expiresAt:Date.now()+600000,quoteSha256:'b'.repeat(64)},calls:[]};if(path.endsWith('-recover'))status={state:'APPROVED',quote:status.quote,calls:[]};const result=path.endsWith('-renewal')?(options.method==='POST'?{renewalApprovalId:'renewal-1',expiresAt:Date.now()+300000}:{eligible:true,evidenceSha256:'c'.repeat(64)}):status;return {ok:true,headers:{get:()=> 'application/json'},json:async()=>result};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__show=showGeminiTwoPassChoice;globalThis.__state=state;');
 const context={crypto,document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent:()=>true,setTimeout,clearTimeout};runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__show({id:'job-b'},target,0);await tick();
 const host=target.children[0];await host.children.find(item=>item.textContent==='Review unused quote renewal').onclick();
 const approve=host.children.find(item=>item.textContent==='Approve unused quote renewal only');await approve.onclick();assert.equal(calls.filter(item=>item.method==='POST').length,0);
 host.children.find(item=>item.tag==='label'&&item.textContent.startsWith('Preserve')).children[0].checked=true;await approve.onclick();assert.equal(calls.filter(item=>item.method==='POST').length,1);assert.equal(calls.filter(item=>item.path.endsWith('-quote')).length,0);
 const renew=host.children.find(item=>item.textContent==='Request new quote with transcript consent');await renew.onclick();assert.equal(calls.filter(item=>item.method==='POST').length,1);
 host.children.find(item=>item.tag==='label'&&item.textContent.startsWith('Send the full')).children[0].checked=true;await renew.onclick();assert.equal(calls.filter(item=>item.path.endsWith('-quote')).length,1);assert.equal(JSON.parse(calls.find(item=>item.path.endsWith('-quote')).body).renewalApprovalId,'renewal-1');

 status={state:'FIRST_PENDING',quote:status.quote,calls:[{phase:0,state:'RESERVED',responseStored:false,inputTokensCounted:300}]};await host.children.find(item=>item.tag==='button'&&item.textContent?.includes('조회')).onclick();await tick();const release=host.children.find(item=>item.tag==='button'&&item.textContent==='공급자 호출 전 예약 복구');assert.ok(release);await release.onclick();assert.equal(JSON.parse(calls.find(item=>item.path.endsWith('-recover')).body).confirmNoProviderCall,true);assert.equal(calls.filter(item=>item.path.endsWith('-run')).length,0);
});
test('an uncertain quote response shows status-only recovery and never resends countTokens',async()=>{
 const node=tag=>({tag,children:[],dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-c';
 const calls=[];const fetcher=async(path,options)=>{calls.push({path,method:options.method,signal:options.signal});if(options.method==='POST')throw Error('simulated network timeout');return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({state:'NOT_STARTED',calls:[]})};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__show=showGeminiTwoPassChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent:()=>true,setTimeout,clearTimeout,AbortSignal:{timeout:ms=>({deadline:ms})}};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__show({id:'job-c'},target,0);await tick();
 const host=target.children[0],consent=host.children.find(item=>item.tag==='label'&&item.textContent?.includes('Google')),button=host.children.find(item=>item.tag==='button');consent.children[0].checked=true;await button.onclick();
 assert.equal(calls.filter(item=>item.method==='POST').length,1);assert.equal(calls.find(item=>item.method==='POST').signal.deadline,120000);
 assert.ok(host.children.some(item=>item.textContent?.includes('결과가 불확실')));
 assert.equal(host.children.some(item=>item.tag==='button'&&item.textContent?.includes('request')),false);
 await host.children.find(item=>item.textContent==='견적 상태 다시 조회').onclick();
 assert.equal(calls.filter(item=>item.method==='POST').length,1);
});
test('failed status read after uncertain quote still offers only a working read-only refresh',async()=>{
 const node=tag=>({tag,children:[],dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-d';
 const calls=[];let statusReads=0;
 const fetcher=async(path,options)=>{calls.push(options.method);if(options.method==='POST')throw Object.assign(Error('provider timeout'),{code:'TWO_PASS_COUNT_UNAVAILABLE'});statusReads++;if(statusReads===2)throw Error('status unavailable');return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({state:'NOT_STARTED',calls:[]})};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__show=showGeminiTwoPassChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent:()=>true,setTimeout,clearTimeout,AbortSignal:{timeout:ms=>({deadline:ms})}};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__show({id:'job-d'},target,0);await tick();
 const host=target.children[0],consent=host.children.find(item=>item.tag==='label'&&item.textContent?.includes('Google'));consent.children[0].checked=true;
 await host.children.find(item=>item.tag==='button').onclick();
 assert.ok(host.children.some(item=>item.textContent?.includes('견적 상태 조회 실패')));
 assert.equal(host.children.filter(item=>item.tag==='button').length,1);
 await host.children.find(item=>item.textContent==='견적 상태 다시 조회').onclick();
 assert.ok(host.children.some(item=>item.textContent?.includes('토큰 계수 실패')));
 assert.equal(host.children.filter(item=>item.tag==='button').length,1);
 assert.deepEqual(calls,['GET','POST','GET','GET']);
});
test('reopening a pending quote offers status refresh but never another quote POST',async()=>{
 const node=tag=>({tag,children:[],dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-e';
 const calls=[],fetcher=async(path,options)=>{calls.push(options.method);return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({state:'QUOTE_PENDING',quoteAttempt:{state:'COUNT_SENT'},quote:null,calls:[]})};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__show=showGeminiTwoPassChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent:()=>true,setTimeout,clearTimeout,AbortSignal:{timeout:ms=>({deadline:ms})}};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__show({id:'job-e'},target,0);await tick();
 const host=target.children[0];assert.ok(host.children.some(item=>item.textContent?.includes('COUNT_SENT')));
 assert.equal(host.children.filter(item=>item.tag==='button').length,1);
 await host.children.find(item=>item.textContent==='견적 상태 다시 조회').onclick();
 assert.deepEqual(calls,['GET','GET']);
});
