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
