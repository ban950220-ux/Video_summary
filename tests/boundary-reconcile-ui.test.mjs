import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {detailRequestIsCurrent} from '../web/site/audio-runner.mjs';

const job={id:'job-a',source_type:'audio',duration_seconds:5893,status:'FULL_TRANSCRIPT',report:null,audit:{audioProcessingCoverage:1}};
const preview={jobId:job.id,audioFileSha256:'a'.repeat(64),sourceSegmentCount:1226,currentMarkerIds:[2],revisedMarkerIds:[1,2],changed:true};
function harness(fetcher){
 const node=tag=>({tag,children:[],hidden:false,dataset:{},append(...items){for(const item of items){item.parent=this;this.children.push(item);}},prepend(...items){for(const item of items)item.parent=this;this.children.unshift(...items);},replaceChildren(...items){this.children=[];this.append(...items);},setAttribute(){},remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}});
 const target=node('div'),toast=node('div');target.dataset.jobId=job.id;
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showBoundaryReconcileChoice=showBoundaryReconcileChoice;globalThis.__state=state;');
 const context={document:{createElement:node,querySelector:selector=>selector==='#toast'?toast:null,hidden:false},window:{},location:{hash:''},fetch:fetcher,clearTimeout,setTimeout:()=>0,detailRequestIsCurrent};
 runInNewContext(source,context,{filename:'web/site/app.js'});context.__state.view='library';
 return {target,state:context.__state,show:context.__showBoundaryReconcileChoice};
}
const response=data=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>data});

test('boundary review UI confirms exact metadata only and reads the new plan without model calls',async()=>{
 const calls=[],fetcher=async(path,options)=>{
  calls.push({path,method:options.method,body:options.body&&JSON.parse(options.body)});
  if(path.endsWith('/groq-summary-plan'))return response({rawStages:50,totalRequests:99,transcriptHash:'b'.repeat(64)});
  if(options.method==='POST')return response({reconciled:true,job});
  if(path==='/api/jobs/'+job.id)return response({job});
  return response(calls.filter(call=>call.path.endsWith('/audio-boundary-reconcile')&&call.method==='GET').length===1?preview:{...preview,currentMarkerIds:[1,2],changed:false});
 };
 const {target,show}=harness(fetcher);show(job,target,0);
 const review=target.children[0];assert.equal(review.textContent,'전사 겹침 경계 표시 검토');await review.onclick();
 const panel=target.children[1],label=panel.children.find(child=>child.tag==='label'),save=panel.children.find(child=>child.textContent==='경계 표시만 저장');
 assert.equal(save.disabled,true);assert.equal(calls.length,1);label.children[0].checked=true;label.children[0].onchange();
 await Promise.all([save.onclick(),save.onclick()]);
 assert.deepEqual(calls.map(call=>[call.method,call.path.split('/').at(-1)]),[['GET','audio-boundary-reconcile'],['POST','audio-boundary-reconcile'],['GET',job.id],['GET','audio-boundary-reconcile'],['GET','groq-summary-plan']]);
 assert.deepEqual(calls[1].body,{jobId:job.id,audioFileSha256:preview.audioFileSha256,currentMarkerIds:[2],revisedMarkerIds:[1,2],confirmBoundaryMetadataReconcile:true});
 assert.match(target.children.map(child=>child.textContent||child.children?.map(item=>item.textContent).join(' ')).join(' '),/99요청/);
});

test('boundary review cancel and newer navigation cannot post stale preview',async()=>{
 const calls=[];let resolvePreview;const wait=new Promise(resolve=>resolvePreview=resolve);
 const fetcher=async(path,options)=>{calls.push({path,method:options.method});return response(await wait);};
 const {target,state,show}=harness(fetcher);show(job,target,0);
 const review=target.children[0],pending=review.onclick();state.view='usage';resolvePreview(preview);await pending;
 assert.equal(target.children.length,1);assert.equal(review.disabled,false);assert.deepEqual(calls.map(call=>call.method),['GET']);
 state.view='library';await review.onclick();
 const panel=target.children[1],cancel=panel.children.find(child=>child.textContent==='취소');cancel.onclick();
 assert.equal(target.children.length,1);assert.equal(review.disabled,false);assert.deepEqual(calls.map(call=>call.method),['GET','GET']);
});

test('cached cross-tab reconciliation reopens the current job before rendering',async()=>{
 const calls=[],fetcher=async(path,options)=>{
  calls.push({path,method:options.method});
  if(options.method==='POST')return response({reconciled:false,cached:true});
  if(path==='/api/jobs/'+job.id)return response({job});
  if(path.endsWith('/groq-summary-plan'))return response({rawStages:50,totalRequests:99,transcriptHash:'b'.repeat(64)});
  return response(calls.filter(call=>call.path.endsWith('/audio-boundary-reconcile')&&call.method==='GET').length===1?preview:{...preview,currentMarkerIds:[1,2],changed:false});
 };
 const {target,show}=harness(fetcher);show(job,target,0);await target.children[0].onclick();
 const panel=target.children[1],label=panel.children.find(child=>child.tag==='label'),save=panel.children.find(child=>child.textContent==='경계 표시만 저장');
 label.children[0].checked=true;label.children[0].onchange();await save.onclick();
 assert.deepEqual(calls.map(call=>[call.method,call.path.split('/').at(-1)]),[['GET','audio-boundary-reconcile'],['POST','audio-boundary-reconcile'],['GET',job.id],['GET','audio-boundary-reconcile'],['GET','groq-summary-plan']]);
 assert.match(target.children.map(child=>child.textContent||child.children?.map(item=>item.textContent).join(' ')).join(' '),/99요청/);
});
