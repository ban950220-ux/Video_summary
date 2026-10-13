import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const pause=()=>new Promise(resolve=>setImmediate(resolve));
const reply=data=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>data});
function harness(){
 const node=tag=>({tag,children:[],hidden:false,dataset:{},disabled:false,append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div');target.dataset.jobId='job-a';
 let reviewed=false,posts=0;const scope=()=>({ready:true,featureEnabled:true,finalizationReady:false,rawStages:79,completedRawStages:79,completedSynthesisNodes:0,quoteEstimate:{calls:78},nextSynthesisStage:'note:0:0',sourceHash:'a'.repeat(64),manifestSha256:'b'.repeat(64),failedStages:[{stage:'raw:9',reviewed:true,failureDispositionReviewed:reviewed}]});
 const fetcher=async(path,options)=>{
  if(path.endsWith('?stage=raw%3A9'))return reply({stage:'raw:9',sourceHash:'a'.repeat(64),auditSha256:'c'.repeat(64),excerpts:[{id:19,startMs:0,endMs:1000,text:'원문'}],disposition:{auditSha256:'c'.repeat(64),recordSha256:'d'.repeat(64)},dispositionReviewed:reviewed});
  if(options.method==='POST'){posts++;assert.equal(JSON.parse(options.body).step,'review-failure-usage');reviewed=true;return reply({reviewed:true});}
  return reply(scope());
 };
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__show=showCompleteSynthesisReview;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:()=>node('div')},window:{},location:{hash:''},fetch:fetcher,confirm:()=>true,clearTimeout,setTimeout:()=>0,detailRequestIsCurrent:()=>true};runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';
 const all=()=>{const rows=[];const walk=item=>{rows.push(item);for(const child of item.children||[])walk(child);};walk(target);return rows;};
 return {target,show:()=>context.__show({id:'job-a'},target,0),all,posts:()=>posts};
}
test('ready raw content still presents missing failure usage review before quote',async()=>{
 const ui=harness();await ui.show();
 assert.ok(ui.all().some(item=>item.textContent==='원문·실패 증거 읽기'));
 assert.ok(!ui.all().some(item=>item.textContent==='별도 Groq Free 종합 견적 발급'));
 const open=ui.all().find(item=>item.textContent==='원문·실패 증거 읽기');await open.onclick();
 const review=ui.all().find(item=>item.textContent==='실패 사용량·미확정 결과 별도 검토');assert.ok(review);await review.onclick();await pause();
 assert.equal(ui.posts(),1);assert.ok(ui.all().some(item=>item.textContent==='별도 Groq Free 종합 견적 발급'));
});
