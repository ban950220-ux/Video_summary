import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('two-pass option describes paid project, asks for quote and approval before offering either generation',async()=>{
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-a';
 const calls=[],quote={model:'gemini-3.1-flash-lite',inputTokensCounted:50524,inputTokensPerCallCap:66908,outputTokensPerCallCap:8192,maxMicroUsd:116500,expiresAt:Date.now()+600000,quoteSha256:'a'.repeat(64)};
 let status={state:'NOT_STARTED',calls:[]};
 const fetcher=async(path,options)=>{calls.push({path,method:options.method});if(path.endsWith('-quote'))status={state:'QUOTED',calls:[],quote};return {ok:true,headers:{get:()=> 'application/json'},json:async()=>status};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGeminiTwoPassChoice=showGeminiTwoPassChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent:()=>true,setTimeout,clearTimeout};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__showGeminiTwoPassChoice({id:'job-a'},target,0);await tick();
 const host=target.children[0];assert.ok(host.children.some(item=>item.textContent?.includes('Tier 1 유료')));assert.equal(host.children.some(item=>item.tag==='button'&&item.textContent?.includes('실행')),false);
 const button=host.children.find(item=>item.tag==='button'&&item.textContent?.includes('상한 견적'));await button.onclick();await tick();
 assert.deepEqual(calls.map(item=>item.method),['GET','POST','GET']);assert.ok(host.children.some(item=>item.textContent?.includes('최대 승인액')));assert.ok(host.children.some(item=>item.textContent?.includes('금액 승인 저장')));assert.equal(calls.some(item=>item.path.endsWith('-run')),false);
});
