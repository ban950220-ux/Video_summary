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

test('checkpoint recovery UI requires explicit review and never starts a provider or summary stage',async()=>{
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}});
 const target=node('div'),toast=node('div');target.dataset.jobId='job-a';
 const preview={jobId:'job-a',responseSha256:'a'.repeat(64),contractHash:'b'.repeat(64),firstRange:{firstId:1,lastId:20},summaryCount:4,chapterCount:20,storedUtf16Length:1954,failedOperationId:'failed-raw0',confirmedUsage:{totalTokens:2169},evidenceHash:'c'.repeat(64),recovered:false};
 let recovered=false;const calls=[];
 const fetcher=async(path,options)=>{calls.push({path,method:options.method,body:options.body&&JSON.parse(options.body)});if(options.method==='POST'){recovered=true;return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({recovered:true,automaticContinuation:false})};}return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({...preview,recovered})};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGroqCheckpointRecoveryChoice=showGroqCheckpointRecoveryChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,clearTimeout,setTimeout:()=>0,clearInterval,detailRequestIsCurrent};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__showGroqCheckpointRecoveryChoice({id:'job-a'},target,0);
 await new Promise(resolve=>setTimeout(resolve,0));
 const host=target.children[0],form=host.children.find(item=>item.tag==='form');assert.ok(form);assert.equal(calls.length,1);
 await form.onsubmit({preventDefault(){}});assert.equal(calls.length,1);
 for(const row of form.children.filter(item=>item.tag==='label'))row.children[0].checked=true;
 await form.onsubmit({preventDefault(){}});
 assert.deepEqual(calls.map(call=>call.method),['GET','POST','GET']);
 assert.equal(calls[1].body.confirmNoProviderCall,true);assert.equal(calls[1].body.confirmNoAutomaticContinuation,true);
 assert.equal(host.children.some(item=>item.tag==='form'),false);
});

test('bundle UI labels the intermediate artifact and uses a separate export URL',async()=>{
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-a';
 const bundle={sourceCheckpointCount:90,bundleContractVersion:'raw-checkpoint-bundle-v1',bundleHash:'a'.repeat(64),report:{summary:[{text:'구간 요약',evidenceIds:[1]}],chapters:[{text:'구간 장',evidenceIds:[1]}],claims:[],numbers:[],critical:[],conclusion:'구간 결론',warning:'별도 모델 재병합 없음'}};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGroqBundleChoice=showGroqBundleChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>bundle}),detailRequestIsCurrent};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__showGroqBundleChoice({id:'job-a'},target,0);await new Promise(resolve=>setTimeout(resolve,0));
 const host=target.children[0];assert.match(host.children[0].textContent,/전체 종합 요약 미완료/);
 const links=host.children.at(-1).children;assert.deepEqual(links.map(item=>item.textContent),['구간별 묶음 TXT 내보내기','구간별 묶음 MD 내보내기']);
 assert.ok(links.every(item=>item.href===undefined||item.tag==='a'));
});
test('remaining summary choice shows unknown ETA and no paid execution control',async()=>{
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-a';
 const choice={transcription:{complete:true,remainingChunks:0},summary:{complete:false,savedRawStages:1,rawStages:4,remainingRawStages:3},free:{model:'mock-free',inputTokensUpperPerCall:4800,outputTokensUpperPerCall:1800,eta:{reason:'관측치 없음'}},paid:{executionEnabled:false,reason:'가격 미검증',model:null,priceVersion:null,inputTokensUpper:null,outputTokensUpper:null,maxRetries:null,maxTaxBps:null,maxMicroUsd:null}};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showSummaryChoice=showSummaryChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>choice}),detailRequestIsCurrent};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__showSummaryChoice({id:'job-a'},target,0);await new Promise(resolve=>setTimeout(resolve,0));
 const host=target.children[0],labels=host.children.map(item=>item.textContent||'').join(' ');
 assert.match(labels,/남은 전사 0조각/);assert.match(labels,/전체 영상의 단일 종합 요약/);assert.match(labels,/소요 시간 UNKNOWN/);assert.match(labels,/가격 버전 미검증/);
 assert.equal(host.children.some(item=>item.tag==='button'&&/유료/.test(item.textContent||'')),false);
});

test('lost checkpoint recovery POST and failed status GET leave only read-only reconciliation',async()=>{
 const node=tag=>({tag,children:[],hidden:false,dataset:{},disabled:false,append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div'),toast=node('div');target.dataset.jobId='job-a';
 const preview={responseSha256:'a'.repeat(64),contractHash:'b'.repeat(64),firstRange:{firstId:1,lastId:20},summaryCount:4,chapterCount:20,storedUtf16Length:1954,failedOperationId:'failed-raw0',confirmedUsage:{totalTokens:2169},evidenceHash:'c'.repeat(64)};
 let posts=0,gets=0,recovered=false;
 const fetcher=async(_path,options)=>{if(options.method==='POST'){posts++;recovered=true;throw Error('POST response lost');}gets++;if(gets===2)throw Error('status unavailable');return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({...preview,recovered})};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGroqCheckpointRecoveryChoice=showGroqCheckpointRecoveryChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,clearTimeout,setTimeout:()=>0,clearInterval,detailRequestIsCurrent};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__showGroqCheckpointRecoveryChoice({id:'job-a'},target,0);await new Promise(resolve=>setTimeout(resolve,0));
 const host=target.children[0],form=host.children.find(item=>item.tag==='form');for(const row of form.children.filter(item=>item.tag==='label'))row.children[0].checked=true;
 await form.onsubmit({preventDefault(){}});assert.equal(posts,1);assert.equal(form.children.at(-1).disabled,true);
 await form.onsubmit({preventDefault(){}});assert.equal(posts,1);
 const refresh=host.children.find(item=>item.tag==='button'&&item.textContent==='저장 상태 다시 확인');assert.ok(refresh);await refresh.onclick();
 assert.equal(posts,1);assert.equal(gets,3);assert.equal(host.children.some(item=>item.tag==='form'),false);
});
