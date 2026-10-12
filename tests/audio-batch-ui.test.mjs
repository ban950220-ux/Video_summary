import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';

test('unchecking batch while audio-plan awaits cannot start ordinary Groq or Gemini summary',{timeout:10000},async()=>{
 const calls=[];
 let resolvePlan;
 const planPending=new Promise(resolve=>{resolvePlan=resolve;});
 let signalPlan;
 const planStarted=new Promise(resolve=>{signalPlan=resolve;});
 const node=()=>({hidden:false,textContent:'',append(){},prepend(){},replaceChildren(){},setAttribute(){},classList:{add(){},remove(){},toggle(){}}});
 const elements=new Map();
 const field=(name,values)=>{const entry=Object.assign(node(),values);elements.set('#'+name,entry);return entry;};
 field('run-button',{});field('analysis-progress',{});field('live-analysis',{checked:true});field('video-title',{value:'Test'});field('duration-min',{value:'10'});
 const batch=field('audio-free-batch-run',{checked:true});const provider=field('audio-provider',{value:'groq'});const gemini=field('audio-gemini-confirm',{checked:false});
 field('resume-job',{value:'test-job'});field('audio-rights',{checked:true});field('audio-file',{files:[{name:'test.mp3',size:100,arrayBuffer:async()=>new Uint8Array(100).buffer}]});
 field('result-panel',{});field('result-content',{});field('toast',{});
 const job={id:'test-job',source_type:'audio',duration_seconds:600,status:'PARTIAL',report:null};
 const fileSha256=Buffer.from(await webcrypto.subtle.digest('SHA-256',new Uint8Array(100))).toString('hex');
 const scope={approved:true,jobId:job.id,fileSha256,model:'whisper-large-v3-turbo',state:'APPROVED',expiresAt:Date.now()+3600000,chunkIds:[0],maxRequests:1,maxAudioSeconds:600};
 let batchRuns=0,ordinaryRuns=0,summaryRuns=0;
 const fetcher=async(path,options)=>{
  calls.push({path,method:options.method});
  if(path==='/api/jobs/test-job/audio-plan'){signalPlan();await planPending;}
  let body;
  if(path==='/api/preflight')body={};
  else if(path==='/api/jobs/test-job')body={job};
  else if(path==='/api/jobs/test-job/audio-plan')body={};
  else if(path==='/api/jobs/test-job/audio-free-batch')body=scope;
  else throw Error('Unexpected UI request: '+path);
  return {ok:true,headers:{get:()=> 'application/json'},json:async()=>body};
 };
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__handleAnalyze=handleAnalyze;globalThis.__state=state;');
 const context={document:{querySelector:selector=>elements.get(selector),createElement:()=>node(),hidden:false},window:{},location:{hash:''},crypto:webcrypto,fetch:fetcher,clearTimeout,setTimeout:()=>0,confirm:()=>false,
  planMp3:()=>({durationSeconds:600,chunks:[{index:0,start:0,end:600,byteStart:0,byteEnd:100}]}),prepareMp3Chunk:()=>({bytes:new Uint8Array(100)}),
  runApprovedFreeBatch:async args=>{batchRuns++;assert.equal(args.jobId,job.id);return {complete:false,reason:'TEST_STOP',index:0};},
  runAudioChunks:async()=>{ordinaryRuns++;return {complete:true};},runSummaryStages:async()=>{summaryRuns++;return {complete:true};},
  detailRequestIsCurrent:()=>true,beginDetailAction:()=>0,audioProgressPlan:()=>({}),cleanedAudioComplete:()=>false,fmtRetryDate:()=>'',
 };
 runInNewContext(source,context,{filename:'web/site/app.js'});
 context.__state.mode='audio';
 const submitted=context.__handleAnalyze({preventDefault(){}});
 await Promise.race([planStarted,new Promise((_,reject)=>setTimeout(()=>reject(Error('audio-plan was not reached')),5000))]);
 assert.ok(calls.some(call=>call.path==='/api/jobs/test-job/audio-plan'));
 batch.checked=false;provider.value='auto';gemini.checked=true;
 resolvePlan();await submitted;
 assert.equal(batchRuns,1);assert.equal(ordinaryRuns,0);assert.equal(summaryRuns,0);
 assert.deepEqual(calls.map(call=>call.path),['/api/jobs/test-job/audio-free-batch','/api/preflight','/api/jobs/test-job','/api/jobs/test-job/audio-plan']);
});
