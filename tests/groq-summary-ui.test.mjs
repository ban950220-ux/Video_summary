import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {runApprovedGroqSummary,detailRequestIsCurrent} from '../web/site/audio-runner.mjs';
import {groqSummaryProgress} from '../web/site/groq-summary-progress.mjs';

test('UI offers saved-checkpoint finalization instead of an impossible zero-request approval',async()=>{
 const job={id:'job-a',source_type:'audio',duration_seconds:600,report:null},scope={approved:false,finalizationReady:true,jobId:'job-a',transcriptHash:'a'.repeat(64),completed:1};
 const calls=[];
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}});
 const target=node('div');target.dataset.jobId=job.id;const toast=node('div');
 const fetcher=async(path,options)=>{calls.push({path,method:options.method,body:options.body&&JSON.parse(options.body)});return {ok:true,headers:{get:()=> 'application/json'},json:async()=>options.method==='POST'?{persisted:false}:scope};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGroqSummaryChoice=showGroqSummaryChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false,addEventListener(){},removeEventListener(){}},window:{},location:{hash:''},fetch:fetcher,clearTimeout,setTimeout:()=>0,setInterval:()=>0,clearInterval,runApprovedGroqSummary,detailRequestIsCurrent,groqSummaryProgress};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';
 context.__showGroqSummaryChoice(job,target,0);await target.children[0].onclick();
 const panel=target.children[2].children[0],finalize=panel.children.find(child=>child.tag==='button');
 assert.equal(finalize.textContent,'저장된 요약 최종 저장');await finalize.onclick();
 const writes=calls.filter(call=>call.method==='POST');
 assert.equal(writes.length,1);assert.equal(writes[0].body.finalizeOnly,true);assert.equal(writes[0].body.transcriptHash,scope.transcriptHash);
});

test('pilot UI keeps review, approval and one execution as separate actions',async()=>{
 const job={id:'job-a'},posts=[],preview={jobId:'job-a',oldOperationId:'old:raw:0',oldResponseSha256:'a'.repeat(64),firstFailedCheck:'SCHEMA',summaryType:'string',confirmedUsage:{inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220},oldRange:{firstId:1,lastId:9,startMs:0,endMs:9000},newRange:{firstId:1,lastId:6,startMs:0,endMs:6000},newTranscriptHash:'b'.repeat(64),model:'openai/gpt-oss-120b',newOneCallReservation:6600,newMaxInputTokens:4800,newMaxCompletionTokens:1800,evidenceHash:'c'.repeat(64),newOperationId:'new:raw:0',credentialGeneration:'opaque',reviewed:false,approved:false,attemptState:null,approvalExpiresAt:Date.now()+600000};
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId=job.id;
 const fetcher=async(path,options)=>{if(options.method==='POST'){const body=JSON.parse(options.body);posts.push(body);if(body.step==='review')preview.reviewed=true;if(body.step==='approve')preview.approved=true;if(body.step==='execute')preview.attemptState='DONE';}return {ok:true,headers:{get:()=> 'application/json'},json:async()=>options.method==='POST'?{}:{...preview}};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGroqPilotChoice=showGroqPilotChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,clearTimeout,setTimeout:()=>0,detailRequestIsCurrent,fmtRetryDate:()=> 'soon'};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__showGroqPilotChoice(job,target,0);
 const tick=()=>new Promise(resolve=>setTimeout(resolve,0));await tick();const host=target.children[0];
 assert.equal(posts.length,0);assert.ok(host.children.some(item=>item.textContent?.includes('2220')));assert.ok(host.children.some(item=>item.textContent?.includes('6600')));
 await host.children.find(item=>item.tag==='button').onclick();assert.deepEqual(posts.map(item=>item.step),['review']);
 const form=host.children.find(item=>item.tag==='form');for(const row of form.children.filter(item=>item.tag==='label'))row.children[0].checked=true;
 await form.onsubmit({preventDefault(){}});assert.deepEqual(posts.map(item=>item.step),['review','approve']);
 await host.children.find(item=>item.tag==='button').onclick();assert.deepEqual(posts.map(item=>item.step),['review','approve','execute']);
});
