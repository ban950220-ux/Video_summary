import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';

// Invented video and analysis identifiers; no user records or provider calls.
const videoId='synthetic01';
const canonical=`https://www.youtube.com/watch?v=${videoId}`;
const job={id:'11111111-1111-1111-1111-111111111111',video_id:videoId,source_url:canonical,source_type:'audio',duration_seconds:600,status:'NEED_AUDIO_UPLOAD',report:null};

async function run({resume=false,wrongVideo=false,file=true,complete=false,alreadyComplete=false,lostCreate=false,deleted=false,confirmNew=true,storage=new Map()}={}){
  const calls=[];let chunkRuns=0,summaryRuns=0,createdUrlJob;
  const node=()=>({dataset:{},hidden:false,textContent:'',append(){},prepend(){},replaceChildren(){},setAttribute(){},classList:{add(){},remove(){},toggle(){}}});
  const elements=new Map();const field=(name,values)=>elements.set('#'+name,Object.assign(node(),values));
  field('run-button',{});field('analysis-progress',{});field('live-analysis',{checked:true});field('video-title',{value:'Owned recording'});field('duration-min',{value:'10'});
  field('audio-free-batch-run',{checked:false});field('audio-provider',{value:'groq'});field('audio-gemini-confirm',{checked:false});field('resume-job',{value:resume?job.id:''});
  field('audio-rights',{checked:true});field('audio-file',{files:file?[{name:'owned.mp3',size:100,arrayBuffer:async()=>new Uint8Array(100).buffer}]:[]});
  field('youtube-url',{value:'https://youtu.be/'+videoId});field('result-panel',{});field('result-content',{});field('toast',{});
  field('new-url-audio-job',{hidden:true});const newButton=elements.get('#new-url-audio-job');
  const fetcher=async(path,options)=>{
    const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body});
    if(path==='/api/jobs'&&lostCreate)throw Error('ACK_LOST');
    if(path==='/api/jobs'&&deleted)return {ok:false,headers:{get:()=> 'application/json'},json:async()=>({error:{code:'AUDIO_SUBMISSION_DELETED',message:'Deleted job'}})};
    let result;
    if(path==='/api/preflight')result={videoId};
    else if(path==='/api/jobs'&&body.sourceType==='url'){createdUrlJob={...job,id:body.submissionId,source_type:'url',title:body.title,duration_seconds:body.durationSeconds,status:'NEED_UPLOAD',audit:{status:'CAPTION_RESULT_UNAVAILABLE',nativeAcquisition:'NO_STORED_RESULT',automaticAudioAcquisition:'NOT_CONNECTED'}};result={job:createdUrlJob,persisted:true,reused:false};}
    else if(createdUrlJob&&path==='/api/jobs/'+createdUrlJob.id+'/source')result={source:null};
    else if(createdUrlJob&&path==='/api/jobs/'+createdUrlJob.id+'/native')result={job:{...createdUrlJob,status:'NEED_UPLOAD',audit:{status:'NO_CAPTIONS',nativeAcquisition:'NO_CAPTIONS',automaticAudioAcquisition:'NOT_CONNECTED'}},persisted:true};
    else if(path==='/api/jobs')result={job:alreadyComplete?{...job,audit:{audioProcessingCoverage:1}}:job,persisted:true};
    else if(path==='/api/jobs/'+job.id)result={job:{...job,video_id:wrongVideo?'otherid0001':videoId}};
    else if(path==='/api/jobs/'+job.id+'/audio-plan')result={planned:true};
    else if(path==='/api/jobs/'+job.id+'/audio-finish')result={job:{...job,status:'TRANSCRIPT_UNVERIFIED'},persisted:true};
    else if(path==='/api/jobs/'+job.id+'/native')result={job:{...job,status:'NEED_UPLOAD'}};
    else throw Error('Unexpected request '+path);
    return {ok:true,headers:{get:()=> 'application/json'},json:async()=>result};
  };
  const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__handleAnalyze=handleAnalyze;globalThis.__state=state;globalThis.__startNewUrlAudioSubmission=startNewUrlAudioSubmission;');
  const context={document:{querySelector:selector=>elements.get(selector),createElement:()=>node(),hidden:false},window:{sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}},location:{hash:''},crypto:webcrypto,fetch:fetcher,clearTimeout,setTimeout:()=>0,confirm:()=>confirmNew,
    planMp3:()=>({durationSeconds:600,chunks:[{index:0,start:0,end:600,byteStart:0,byteEnd:100}]}),prepareMp3Chunk:()=>({bytes:new Uint8Array(100)}),
    runAudioChunks:async()=>{chunkRuns++;return complete?{complete:true}:{complete:false,reason:'FIXTURE_STOP',index:0};},runSummaryStages:async()=>{summaryRuns++;return {complete:true};},
    detailRequestIsCurrent:()=>true,beginDetailAction:()=>0,audioProgressPlan:()=>({}),cleanedAudioComplete:()=>false,fmtRetryDate:()=>'',
  };
  runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.mode='url';await context.__handleAnalyze({preventDefault(){}});
  return {calls,chunkRuns,summaryRuns,newButton,startNew:()=>context.__startNewUrlAudioSubmission()};
}

test('URL plus owned MP3 creates one audio job with URL, then stages a single audio plan',async()=>{
  const result=await run();
  assert.deepEqual(result.calls.map(x=>x.path),['/api/preflight','/api/jobs','/api/jobs/'+job.id+'/audio-plan']);
  assert.equal(result.calls[1].body.sourceType,'audio');
  assert.equal(result.calls[1].body.url,'https://youtu.be/'+videoId);
  assert.equal(result.chunkRuns,1);
  assert.equal(result.summaryRuns,0);
});

test('resume reuses the same job and rejects a different video before audio planning',async()=>{
  const resumed=await run({resume:true});
  assert.deepEqual(resumed.calls.map(x=>x.path),['/api/preflight','/api/jobs/'+job.id,'/api/jobs/'+job.id+'/audio-plan']);
  const mismatch=await run({resume:true,wrongVideo:true});
  assert.deepEqual(mismatch.calls.map(x=>x.path),['/api/preflight','/api/jobs/'+job.id]);
  assert.equal(mismatch.chunkRuns,0);
});

test('lost creation acknowledgement reuses the same submission identifier on retry',async()=>{
  const storage=new Map();
  const first=await run({storage,lostCreate:true});
  const second=await run({storage});
  assert.equal(first.calls.at(-1).path,'/api/jobs');
  assert.equal(first.calls.at(-1).body.submissionId,second.calls.find(x=>x.path==='/api/jobs').body.submissionId);
  assert.match(first.calls.at(-1).body.ownedAudioSha256,/^[a-f0-9]{64}$/);
  assert.equal(second.calls.filter(x=>x.path==='/api/jobs').length,1);
});

test('deleted submission offers an explicit new request; declined restart keeps the old ID',async()=>{
  const storage=new Map();
  const declined=await run({storage,deleted:true,confirmNew:false});
  assert.equal(declined.newButton.hidden,false);
  const deletedId=declined.calls.find(x=>x.path==='/api/jobs').body.submissionId;
  assert.equal(declined.startNew(),false);
  const retry=await run({storage,deleted:true});
  assert.equal(retry.calls.find(x=>x.path==='/api/jobs').body.submissionId,deletedId);
  assert.equal(retry.newButton.hidden,false);
  assert.equal(retry.startNew(),true);
  assert.equal(storage.size,0);
  const fresh=await run({storage});
  assert.notEqual(fresh.calls.find(x=>x.path==='/api/jobs').body.submissionId,deletedId);
});

test('after URL-associated transcription completes, no legacy summary call starts automatically',async()=>{
  const result=await run({complete:true});
  assert.equal(result.calls.at(-1).path,'/api/jobs/'+job.id+'/audio-finish');
  assert.equal(result.calls.some(x=>x.path.endsWith('/summary-plan')||x.path.endsWith('/summary')),false);
  assert.equal(result.summaryRuns,0);
});

test('a completed replay reads the existing job and skips audio planning and provider work',async()=>{
  const result=await run({alreadyComplete:true});
  assert.deepEqual(result.calls.map(x=>x.path),['/api/preflight','/api/jobs']);
  assert.equal(result.chunkRuns,0);
  assert.equal(result.summaryRuns,0);
});

test('URL without owned MP3 keeps native caption path and never creates an audio plan',async()=>{
  const result=await run({file:false});
  const id=result.calls.find(call=>call.path==='/api/jobs').body.submissionId;
  assert.deepEqual(result.calls.map(x=>x.path),['/api/preflight','/api/jobs','/api/jobs/'+id+'/source','/api/jobs/'+id+'/native']);
  assert.equal(result.calls[1].body.sourceType,'url');
  assert.equal(result.chunkRuns,0);
});
