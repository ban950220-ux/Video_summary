import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {runApprovedGroqSummary,detailRequestIsCurrent} from '../web/site/audio-runner.mjs';
import {groqSummaryProgress} from '../web/site/groq-summary-progress.mjs';

test('raw:8 correction UI replaces expired quotes and separates claimed, failed and saved attempts',async()=>{
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showGroqCorrectionChoice=showGroqCorrectionChoice;globalThis.__state=state;');
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}});
 const base={firstId:144,lastId:165,segmentCount:22,originalMismatchCount:4,originalUsageTotalTokens:2139,approvalState:null,attemptState:null,quote:null,quoteExpired:true};
 const mount=async preview=>{
  const target=node('div'),toast=node('div'),posts=[];target.dataset.jobId='job-a';let state={...base,...preview};
  const fetcher=async(_path,options)=>{if(options.method==='POST'){const body=JSON.parse(options.body);posts.push(body);if(body.step==='quote')state={...state,quoteExpired:false,quote:{quoteId:'new-quote',contract:{quoteSha256:'a'.repeat(64),model:'openai/gpt-oss-120b',firstId:144,lastId:165,inputTokensUpper:4600,outputTokensUpper:1800,reservedUnits:6400,expiresAt:Date.now()+600000}}};}return {ok:true,headers:{get:()=> 'application/json'},json:async()=>state};};
  const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null},window:{},location:{hash:''},fetch:fetcher,clearTimeout,setTimeout:()=>0,detailRequestIsCurrent,fmtRetryDate:()=> 'soon'};
  runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__showGroqCorrectionChoice({id:'job-a'},target,0);await new Promise(resolve=>setImmediate(resolve));
  return {host:target.children[0],posts};
 };
 const expired=await mount({});const requote=expired.host.children.find(item=>item.tag==='button'&&item.textContent.includes('새 견적'));assert.ok(requote);assert.equal(expired.host.children.some(item=>item.tag==='form'),false);await requote.onclick();assert.deepEqual(expired.posts.map(item=>item.step),['quote']);assert.ok(expired.host.children.some(item=>item.tag==='form'));
 const expiredApproval=await mount({approvalState:'APPROVED',quoteExpired:true});assert.equal(expiredApproval.host.children.some(item=>item.textContent?.includes('실행할 수 없습니다')),true);assert.equal(expiredApproval.host.children.some(item=>item.textContent?.includes('1회 실행')),false);
 for(const [attemptState,label] of [['CLAIMED','처리 중'],['FAILED_UNCERTAIN','기존 raw:8 실패와 별개'],['DONE','저장됐습니다'],['BLOCKED','전송 전에 차단']]){
  const view=await mount({attemptState,attemptErrorCode:attemptState==='FAILED_UNCERTAIN'?'429':null});assert.ok(view.host.children.some(item=>item.textContent?.includes(label)),attemptState);assert.equal(view.host.children.some(item=>item.textContent?.includes('1회 실행')),false);assert.equal(view.posts.length,0);
 }
});

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
 assert.match(host.children[0].textContent,/Groq Free 첫 구간 보고서 복구 · 전체 요약 아님/);
 assert.equal(form.children.at(-1).textContent,'Groq Free 첫 구간 저장 보고서만 복구');
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
test('paid choice issues server quote then records explicit caps without provider execution',async()=>{
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},replaceWith(){},setAttribute(key,value){this[key]=value;}}),target=node('div'),toast=node('div');target.dataset.jobId='job-a';
 const costEstimate={requestBytes:120000,inputByteMultiplier:2,inputOverheadBytes:8192,inputEstimateLowTokens:30000,inputEstimateHighTokens:60000,outputEstimateLowTokens:2048,outputEstimateHighTokens:8192,estimatedPreTaxLowMicroUsd:10572,estimatedPreTaxHighMicroUsd:27288};
 const choice={transcription:{complete:true,remainingChunks:0},summary:{complete:false,savedRawStages:0,rawStages:4,remainingRawStages:4},free:{model:'mock-free',inputTokensUpperPerCall:4800,outputTokensUpperPerCall:1800,eta:{reason:'관측치 없음'}},paid:{executionEnabled:false,quoteIssueReady:true,reason:'계정 사용 가능성 미검증',model:'gemini-3.1-flash-lite',priceVersion:'v1',inputTokensUpper:1048576,outputTokensUpper:65536,costEstimate,maxRetries:0,maxTaxBps:10000,maxMicroUsd:720896}};
 const issued={quoteId:'server-id',firstTrialAvailable:true,quote:{model:'gemini-3.1-flash-lite',priceVersion:'v1',sourceSha256:'a'.repeat(64),requestSha256:'b'.repeat(64),quoteSha256:'c'.repeat(64),credentialGeneration:'mock-generation',priceInputMicroUsdPerMillion:250000,priceOutputMicroUsdPerMillion:1500000,inputTokensUpper:1048576,outputTokensUpper:65536,requestBytes:120000,costEstimate,plannedCalls:1,maxRetries:0,maxTaxBps:10000,perCallMicroUsd:360448,maxCallMicroUsd:720896,maxMicroUsd:720896,maxCalls:1,expiresAt:Date.now()+600000}};
 const calls=[],fetcher=async(path,options)=>{calls.push({path,method:options.method,body:options.body&&JSON.parse(options.body)});const result=path.endsWith('/summary-choice')?choice:path.endsWith('/paid-summary-quote')?issued:path.endsWith('/paid-summary-status')?{approval:null,reservations:[]}:path.endsWith('/paid-summary-approve')?{id:'server-id',automaticExecution:false}:null;return {ok:true,headers:{get:()=> 'application/json'},json:async()=>result};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showSummaryChoice=showSummaryChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent,clearTimeout,setTimeout:()=>0};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';context.__showSummaryChoice({id:'job-a'},target,0);await new Promise(resolve=>setTimeout(resolve,0));
 const choiceHost=target.children[0],issue=choiceHost.children.find(item=>item.tag==='button'&&item.textContent?.includes('견적 발급'));assert.ok(issue);assert.ok(choiceHost.children.some(item=>item.textContent?.includes('비용 시나리오')));await issue.onclick();
 const paidHost=target.children[0],form=paidHost.children.find(item=>item.tag==='form');assert.ok(form);assert.ok(paidHost.children.some(item=>item.textContent?.includes('실제 세율 아님')));assert.ok(paidHost.children.some(item=>item.textContent?.includes('비검증 비용 시나리오')));assert.ok(paidHost.children.some(item=>item.textContent?.includes('FIRST_GENERATION_UNTESTED')));const boxes=form.children.filter(item=>item.tag==='label').flatMap(row=>row.children.filter(item=>item.tag==='input'&&item.type==='checkbox'));assert.equal(boxes.length,2);boxes[0].checked=true;await form.onsubmit({preventDefault(){}});assert.equal(calls.filter(call=>call.path.endsWith('/paid-summary-approve')).length,0);boxes[1].checked=true;
 await form.onsubmit({preventDefault(){}});
 assert.deepEqual(calls.filter(call=>call.method==='POST').map(call=>call.path),['/api/jobs/job-a/paid-summary-quote','/api/jobs/job-a/paid-summary-approve']);
 const approval=calls.find(call=>call.path.endsWith('/paid-summary-approve')).body;assert.equal(approval.quoteId,'server-id');assert.equal(approval.maxMicroUsd,720896);assert.equal(approval.maxCalls,1);assert.equal(approval.confirmNoAutomaticFallback,true);assert.equal(approval.trialKind,'FIRST_GENERATION_UNTESTED');assert.equal(approval.confirmExistingPrepayOnly,true);assert.equal(approval.confirmCurrentKeyProject,true);
 assert.equal(paidHost.children.some(item=>item.tag==='button'&&item.textContent?.includes('1회 실행')),false);
});

test('lost paid approval response reconciles read-only and reconnect restores only an eligible run control',async()=>{
 const node=tag=>({tag,children:[],hidden:false,dataset:{},disabled:false,append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},replaceWith(){},setAttribute(key,value){this[key]=value;}}),target=node('div'),toast=node('div');target.dataset.jobId='job-a';
 const choice={transcription:{complete:true},summary:{complete:false,savedRawStages:0,rawStages:1,remainingRawStages:1},free:{model:'free',inputTokensUpperPerCall:1,outputTokensUpperPerCall:1,eta:{reason:'UNKNOWN'}},paid:{executionEnabled:true,quoteIssueReady:true,reason:'승인 필요',model:'gemini-3.1-flash-lite',priceVersion:'v1',inputTokensUpper:100,outputTokensUpper:100,maxRetries:0,maxTaxBps:10000,maxMicroUsd:100}};
 const issued={quoteId:'quote-a',quote:{model:'gemini-3.1-flash-lite',priceVersion:'v1',priceInputMicroUsdPerMillion:250000,priceOutputMicroUsdPerMillion:1500000,inputTokensUpper:100,outputTokensUpper:100,plannedCalls:1,maxRetries:0,maxTaxBps:10000,maxCallMicroUsd:100,maxMicroUsd:100,maxCalls:1,expiresAt:Date.now()+600000}};
 let approval=null,reservations=[],posts=[];const fetcher=async(path,options)=>{if(options.method==='POST'){posts.push(path);assert.equal(options.headers['Content-Type'],'application/json');if(path.endsWith('paid-summary-approve')){approval={id:'quote-a',state:'APPROVED'};throw Error('approval response lost');}if(path.endsWith('paid-summary-cancel'))approval.state='CANCELLED';}const result=path.endsWith('summary-choice')?choice:path.endsWith('paid-summary-quote')?issued:path.endsWith('paid-summary-status')?{approval,reservations,executionReady:approval?.state==='APPROVED'&&reservations.length===0}:{};return {ok:true,headers:{get:()=> 'application/json'},json:async()=>result};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showSummaryChoice=showSummaryChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent,clearTimeout,setTimeout:()=>0};runInNewContext(source,context);context.__state.view='library';
 const job={id:'job-a'};context.__showSummaryChoice(job,target,0);await new Promise(resolve=>setTimeout(resolve,0));await target.children[0].children.find(item=>item.textContent?.includes('견적 발급')).onclick();
 const host=target.children[0],form=host.children.find(item=>item.tag==='form');for(const row of form.children.filter(item=>item.tag==='label'))for(const input of row.children.filter(item=>item.tag==='input'))if(input.type==='checkbox')input.checked=true;
 await form.onsubmit({preventDefault(){}});assert.equal(posts.length,2);assert.ok(host.children.some(item=>item.textContent?.includes('승인된 유료 전체 종합 요약 1회 실행')));
 target.replaceChildren();context.__showSummaryChoice(job,target,0);await new Promise(resolve=>setTimeout(resolve,0));let choiceHost=target.children[0];assert.ok(choiceHost.children.some(item=>item.textContent?.includes('승인된 유료 전체 종합 요약 1회 실행')));
 reservations=[{state:'UNCERTAIN'}];target.replaceChildren();context.__showSummaryChoice(job,target,0);await new Promise(resolve=>setTimeout(resolve,0));choiceHost=target.children[0];assert.equal(choiceHost.children.some(item=>item.textContent?.includes('승인된 유료 전체 종합 요약 1회 실행')),false);
 await choiceHost.children.find(item=>item.textContent?.includes('유료 승인 취소')).onclick();assert.ok(posts.at(-1).endsWith('paid-summary-cancel'));assert.equal(approval.state,'CANCELLED');assert.equal(posts.some(path=>path.endsWith('paid-summary-execute')),false);
});

test('library reopen renders paid full report with evidence and TXT export',async()=>{
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(key,value){this[key]=value;},scrollIntoView(){}}),target=node('div'),toast=node('div');
 const job={id:'job-a',title:'Paid report',created_at:new Date().toISOString(),duration_seconds:120,source_type:'url',status:'DONE',report:{kind:'GEMINI_PAID_FULL_EVIDENCE_LINKED',summary:[{text:'전체 요약',evidenceIds:[1]}],chapters:[{text:'첫 장',evidenceIds:[1]}],claims:[],numbers:[],critical:[],conclusion:'종합 결론',warning:'근거 검증 필요'}};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__libraryCard=libraryCard;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:selector==='#library-detail'?target:null,hidden:false},window:{},location:{hash:''},fetch:async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({job})}),detailRequestIsCurrent,beginDetailAction:(_target,id,current)=>{target.dataset.jobId=id;return current+1;}};
 runInNewContext(source,context);context.__state.view='library';const card=context.__libraryCard(job),open=card.children[1].children.find(item=>item.textContent==='리포트 열기');await open.onclick();
 const collect=item=>[item.textContent||'',...item.children.flatMap(collect)].join(' '),labels=collect(target);assert.match(labels,/전체 영상 단일 종합 요약/);assert.match(labels,/전체 요약/);assert.match(labels,/종합 결론/);
 const actions=target.children.find(item=>item.className==='library-actions');assert.ok(actions);const txt=actions.children.find(item=>item.textContent==='TXT 내보내기');assert.equal(txt.href,'/api/jobs/job-a/export?format=txt');assert.equal(actions.children.some(item=>item.textContent==='요약 부분 출력 검토'),false);
});

test('audio library labels the legacy free action separately from paid quote choice',()=>{
 const node=tag=>({tag,children:[],dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}});
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__libraryCard=libraryCard;');
 const context={document:{createElement:node,querySelector:()=>null},window:{},location:{hash:''}};runInNewContext(source,context);
 const card=context.__libraryCard({id:'job-a',title:'98 minute',source_type:'audio',status:'TRANSCRIPT_UNVERIFIED',created_at:new Date().toISOString(),duration_seconds:5892,report:null});
 const labels=card.children.flatMap(item=>item.children||[]).map(item=>item.textContent).filter(Boolean).join(' ');
 assert.match(labels,/기존 Gemini 무료 요약 생성/);assert.match(labels,/전체 요약 선택·유료 견적/);assert.equal(card.children.flatMap(item=>item.children||[]).some(item=>item.textContent==='요약 생성'),false);
});

test('paid choice offers no-call revalidation only for a complete stored receipt',async()=>{
 const node=tag=>({tag,children:[],dataset:{},hidden:false,append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}});
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showSummaryChoice=showSummaryChoice;globalThis.__state=state;');
 const choice={transcription:{complete:true},summary:{complete:false,savedRawStages:0,rawStages:1,remainingRawStages:1},free:{model:'free',inputTokensUpperPerCall:1,outputTokensUpperPerCall:1,eta:{reason:'UNKNOWN'}},paid:{executionEnabled:false,quoteIssueReady:true,reason:'별도 승인',model:'paid',priceVersion:'v1',inputTokensUpper:100,outputTokensUpper:100,maxRetries:0}};
 for(const hasReceipt of [false,true]){
  const target=node('div'),toast=node('div');target.dataset.jobId='job-a';const calls=[];
  const status={approval:{id:'approval-a',state:'APPROVED'},reservations:[{id:'reservation-a',state:'SETTLED',outcome:'REPORT_NOT_SAVED'}],executionReady:false,receipt:hasReceipt?{revalidationAvailable:true,response_bytes:1234,error_code:'PAID_REPORT_WINDOW_COVERAGE'}:null};
  const fetcher=async(path,options)=>{calls.push({path,method:options.method,body:options.body&&JSON.parse(options.body)});const result=path.endsWith('summary-choice')?choice:status;return {ok:true,headers:{get:()=> 'application/json'},json:async()=>result};};
  const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent,clearTimeout,setTimeout:()=>0};runInNewContext(source,context);context.__state.view='library';context.__showSummaryChoice({id:'job-a'},target,0);await new Promise(resolve=>setTimeout(resolve,0));
  const host=target.children[0],button=host.children.find(item=>item.textContent==='Gemini 유료 전체 응답 영수증 재검증 · 제공자 호출 없음');assert.equal(!!button,hasReceipt);
  if(hasReceipt)assert.match(host.children.find(item=>item.textContent?.includes('응답 영수증')).textContent,/Gemini 유료 전체 요약/);
  assert.equal(calls.some(call=>call.method==='POST'),false);
 }
});

test('paid receipt recovery stays available without a new quote and retains cost warning after click or lost response',async()=>{
 const node=tag=>({tag,children:[],dataset:{},hidden:false,append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(key,value){this[key]=value;}});
 const collect=item=>[item.textContent||'',...(item.children||[]).flatMap(collect)].join(' '),tick=()=>new Promise(resolve=>setTimeout(resolve,0));
 const reportJob={id:'job-a',status:'COMPLETE',report:{kind:'GEMINI_PAID_FULL_EVIDENCE_LINKED',summary:[],chapters:[],claims:[],numbers:[],critical:[],conclusion:'저장된 결론'}};
 for(const lost of [false,true]){
  const target=node('div'),toast=node('div'),calls=[];target.dataset.jobId='job-a';let saved=false;
  const choice={transcription:{complete:true},summary:{complete:false,savedRawStages:0,rawStages:1,remainingRawStages:1},free:{model:'free',inputTokensUpperPerCall:1,outputTokensUpperPerCall:1,eta:{reason:'UNKNOWN'}},paid:{executionEnabled:false,quoteIssueReady:false,reason:'Gemini 키 없음',model:'paid',priceVersion:'v1',inputTokensUpper:100,outputTokensUpper:100,maxRetries:0}};
  const fetcher=async(path,options)=>{calls.push({path,method:options.method});if(path.endsWith('/summary-choice'))return {ok:true,headers:{get:()=> 'application/json'},json:async()=>choice};if(path.endsWith('/paid-summary-revalidate')){saved=true;if(lost)throw Error('response lost');return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({job:reportJob,costReconciliation:'REVIEW_REQUIRED'})};}if(path.endsWith('/paid-summary-status'))return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({approval:{id:'approval-a',state:'APPROVED'},reservations:[{id:'reservation-a',state:'UNCERTAIN'}],receipt:saved?{revalidationAvailable:false}:{revalidationAvailable:true,response_bytes:1234},finalReportSaved:saved,costReconciliation:saved?'REVIEW_REQUIRED':null})};if(path==='/api/jobs/job-a')return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({job:reportJob})};throw Error('unexpected request '+path);};
  const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showSummaryChoice=showSummaryChoice;globalThis.__state=state;');
  const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent,clearTimeout,setTimeout:()=>0};runInNewContext(source,context);context.__state.view='library';context.__showSummaryChoice({id:'job-a'},target,0);await tick();
  assert.doesNotMatch(collect(target),/서버 유료 견적 발급/);const button=target.children[0].children.find(item=>item.textContent==='Gemini 유료 전체 응답 영수증 재검증 · 제공자 호출 없음');assert.ok(button);await button.onclick();await tick();
  assert.equal(saved,true);assert.match(collect(target),/비용 원장은 검토가 필요/);assert.match(collect(target),/저장된 결론/);assert.equal(calls.filter(call=>call.method==='POST').length,1);assert.equal(calls.some(call=>call.path.endsWith('/paid-summary-quote')),false);
 }
});

test('reopening a saved paid report reads the unsettled cost ledger',async()=>{
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(key,value){this[key]=value;},scrollIntoView(){}}),target=node('div'),toast=node('div');
 const job={id:'job-a',title:'Paid report',created_at:new Date().toISOString(),duration_seconds:120,source_type:'url',status:'COMPLETE',report:{kind:'GEMINI_PAID_FULL_EVIDENCE_LINKED',summary:[],chapters:[],claims:[],numbers:[],critical:[],conclusion:'저장된 결론'}};
 const calls=[],fetcher=async(path,options)=>{calls.push({path,method:options.method});const result=path.endsWith('/paid-summary-status')?{finalReportSaved:true,costReconciliation:'REVIEW_REQUIRED'}:{job};return {ok:true,headers:{get:()=> 'application/json'},json:async()=>result};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__libraryCard=libraryCard;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:selector==='#library-detail'?target:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent,beginDetailAction:(_target,id,current)=>{target.dataset.jobId=id;return current+1;}};runInNewContext(source,context);context.__state.view='library';const card=context.__libraryCard(job);await card.children[1].children.find(item=>item.textContent==='리포트 열기').onclick();await new Promise(resolve=>setTimeout(resolve,0));
 const collect=item=>[item.textContent||'',...(item.children||[]).flatMap(collect)].join(' ');assert.match(collect(target),/비용 원장은 검토가 필요/);assert.equal(calls.filter(call=>call.path.endsWith('/paid-summary-status')).length,1);assert.equal(calls.some(call=>call.method==='POST'),false);
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
