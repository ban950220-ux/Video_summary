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
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGroqSummaryChoice=showGroqSummaryChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false,addEventListener(){},removeEventListener(){}},window:{},location:{hash:''},fetch:fetcher,clearTimeout,setTimeout:()=>0,setInterval:()=>0,clearInterval,runApprovedGroqSummary,detailRequestIsCurrent,groqSummaryProgress};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';
 context.__showGroqSummaryChoice(job,target,0);await target.children[0].onclick();
 const panel=target.children[2].children[0],finalize=panel.children.find(child=>child.tag==='button');
 assert.equal(finalize.textContent,'저장된 요약 최종 저장');await finalize.onclick();
 const writes=calls.filter(call=>call.method==='POST');
 assert.equal(writes.length,1);assert.equal(writes[0].body.finalizeOnly,true);assert.equal(writes[0].body.transcriptHash,scope.transcriptHash);
});

test('pilot UI keeps review, approval and one execution as separate actions',async()=>{
 const job={id:'job-a'},posts=[],preview={jobId:'job-a',oldOperationId:'old:raw:0',oldResponseSha256:'a'.repeat(64),firstFailedCheck:'SCHEMA',summaryType:'string',confirmedUsage:{inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220},oldRange:{firstId:1,lastId:9,startMs:0,endMs:9000},newRange:{firstId:1,lastId:6,startMs:0,endMs:6000},newTranscriptHash:'b'.repeat(64),model:'openai/gpt-oss-120b',newOneCallReservation:6600,newMaxInputTokens:4800,newMaxCompletionTokens:1800,evidenceHash:'c'.repeat(64),newOperationId:'new:raw:0',credentialGeneration:'opaque',reviewed:false,approved:false,attemptState:null,approvalExpiresAt:null};
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId=job.id;
 const fetcher=async(path,options)=>{if(options.method==='POST'){const body=JSON.parse(options.body);posts.push(body);if(body.step==='review')preview.reviewed=true;if(body.step==='approve'){preview.approved=true;preview.approvalExpiresAt=Date.now()+600000;}if(body.step==='execute')preview.attemptState='DONE';}return {ok:true,headers:{get:()=> 'application/json'},json:async()=>options.method==='POST'?{}:{...preview}};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGroqPilotChoice=showGroqPilotChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,clearTimeout,setTimeout:()=>0,setInterval:()=>0,clearInterval,detailRequestIsCurrent,fmtRetryDate:()=> 'soon'};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__showGroqPilotChoice(job,target,0);
 const tick=()=>new Promise(resolve=>setTimeout(resolve,0));await tick();const host=target.children[0];
 assert.equal(posts.length,0);assert.ok(host.children.some(item=>item.textContent?.includes('2220')));assert.ok(host.children.some(item=>item.textContent?.includes('6600')));
 await host.children.find(item=>item.tag==='button').onclick();assert.deepEqual(posts.map(item=>item.step),['review']);
 const form=host.children.find(item=>item.tag==='form');for(const row of form.children.filter(item=>item.tag==='label'))row.children[0].checked=true;
 await form.onsubmit({preventDefault(){}});assert.deepEqual(posts.map(item=>item.step),['review','approve']);
 await host.children.find(item=>item.tag==='button').onclick();assert.deepEqual(posts.map(item=>item.step),['review','approve','execute']);
});

test('pilot UI retains an uncertain send and never offers renewal of expired approval',async()=>{
 const app=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGroqPilotChoice=showGroqPilotChoice;globalThis.__state=state;');
 const seed=()=>({oldOperationId:'old',oldResponseSha256:'a'.repeat(64),firstFailedCheck:'SCHEMA',summaryType:'string',confirmedUsage:{inputTokens:1258,outputTokens:962,reasoningTokens:74,totalTokens:2220},oldRange:{firstId:1,lastId:9,startMs:0,endMs:9000},newRange:{firstId:1,lastId:6,startMs:0,endMs:6000},newTranscriptHash:'b'.repeat(64),model:'openai/gpt-oss-120b',newOneCallReservation:6600,newMaxInputTokens:4800,newMaxCompletionTokens:1800,evidenceHash:'c'.repeat(64),newOperationId:'new',credentialGeneration:'opaque',reviewed:true,approved:true,approvalExpiresAt:Date.now()+600000,attemptState:null});
 const mount=async(mode)=>{
  const p=seed(),calls=[],node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-a';
  if(mode==='expired'){p.approved=false;p.approvalRecordExists=true;p.approvalExpiresAt=Date.now()-1;}
  if(mode==='rotated'){p.reviewed=false;p.approved=false;p.reviewRecordExists=true;p.approvalRecordExists=true;}
  let failGet=false;
  const fetcher=async(_path,options)=>{if(options.method==='POST'){calls.push(JSON.parse(options.body).step);p.attemptState='CLAIMED';if(mode==='lost')throw Error('POST response lost');if(mode==='getlost')failGet=true;return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({})};}if(failGet)throw Error('GET response lost');return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({...p})};};
  const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,clearTimeout,setTimeout:()=>0,setInterval:()=>0,clearInterval,detailRequestIsCurrent,fmtRetryDate:()=> 'soon'};
  runInNewContext(app,context);context.__state.view='library';context.__showGroqPilotChoice({id:'job-a'},target,0);await new Promise(resolve=>setTimeout(resolve,0));return {target,calls};
 };
 for(const mode of ['lost','getlost']){
  const {target,calls}=await mount(mode),host=target.children[0],run=host.children.find(item=>item.tag==='button'&&item.textContent==='승인된 첫 구간 1회 실행');
  await run.onclick();assert.deepEqual(calls,['execute']);
  if(mode==='lost')assert.equal(host.children.some(item=>item.tag==='button'&&item.textContent==='승인된 첫 구간 1회 실행'),false);
  else assert.equal(run.disabled,true);
 }
 const expired=await mount('expired');assert.equal(expired.target.children[0].children.some(item=>item.tag==='form'),false);assert.equal(expired.target.children[0].children.some(item=>item.textContent?.includes('재승인은 생성할 수 없습니다')),true);assert.equal(expired.calls.length,0);
 const rotated=await mount('rotated');assert.equal(rotated.target.children[0].children.some(item=>item.textContent?.includes('기존 검토 기록과 현재 키 세대')),true);assert.equal(rotated.target.children[0].children.some(item=>item.textContent?.includes('이전 응답·사용량과 새 구간 검토 기록')),false);assert.equal(rotated.target.children[0].children.some(item=>item.tag==='form'),false);assert.equal(rotated.calls.length,0);
});
