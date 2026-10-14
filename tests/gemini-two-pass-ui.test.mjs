import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
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
test('unused cancelled quote offers consented revision and reserved phase offers no-call release',async()=>{
 const node=tag=>({tag,children:[],dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-b';
 const quote={model:'gemini-3.1-flash-lite',inputTokensCounted:300,inputTokensPerCallCap:16684,outputTokensPerCallCap:8192,preTaxMicroUsd:100,costBufferMicroUsd:100,maxMicroUsd:200,expiresAt:Date.now()-1,quoteSha256:'a'.repeat(64)};
 let status={state:'CANCELLED',quote,calls:[]};const calls=[];
 const fetcher=async(path,options)=>{calls.push({path,method:options.method,body:options.body});if(path.endsWith('-quote'))status={state:'QUOTED',quote:{...quote,expiresAt:Date.now()+600000,quoteSha256:'b'.repeat(64)},calls:[]};if(path.endsWith('-recover'))status={state:'APPROVED',quote:status.quote,calls:[]};return {ok:true,headers:{get:()=> 'application/json'},json:async()=>status};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__show=showGeminiTwoPassChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent:()=>true,setTimeout,clearTimeout};runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__show({id:'job-b'},target,0);await tick();
 const host=target.children[0],renew=host.children.find(item=>item.tag==='button'&&item.textContent==='새 견적 발급'),consent=host.children.find(item=>item.tag==='label'&&item.textContent?.includes('Google'));assert.ok(renew);assert.ok(consent);await renew.onclick();assert.equal(calls.filter(item=>item.method==='POST').length,0);consent.children[0].checked=true;await renew.onclick();assert.equal(calls.filter(item=>item.path.endsWith('-quote')).length,1);
 status={state:'FIRST_PENDING',quote:status.quote,calls:[{phase:0,state:'RESERVED',responseStored:false,inputTokensCounted:300}]};await host.children.find(item=>item.tag==='button'&&item.textContent?.includes('조회')).onclick();await tick();const release=host.children.find(item=>item.tag==='button'&&item.textContent==='공급자 호출 전 예약 복구');assert.ok(release);await release.onclick();assert.equal(JSON.parse(calls.find(item=>item.path.endsWith('-recover')).body).confirmNoProviderCall,true);assert.equal(calls.filter(item=>item.path.endsWith('-run')).length,0);
});
