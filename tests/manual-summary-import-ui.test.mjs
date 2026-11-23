import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {MANUAL_SUMMARY_MAX_BYTES,MANUAL_SUMMARY_LABEL,prepareManualSummaryFile,createImportedSummaryController,mountImportedSummaries} from '../web/site/manual-summary-import.mjs';

// All content, identifiers, source records and responses in this file are synthetic.
const sourceHash='a'.repeat(64),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const text='\ufeffSynthetic chapter one.\r\n합성 사례의 두 번째 문장.\r\n';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const fileOf=value=>{const bytes=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);return {name:'synthetic-summary.txt',size:bytes.byteLength,arrayBuffer:async()=>bytes.slice().buffer};};
const source={sourceSha256:sourceHash,sourceProvenance:'SYNTHETIC_TRANSCRIPT',segmentCount:3,durationSeconds:12,videoId:null,maxBytes:MANUAL_SUMMARY_MAX_BYTES,provenance:'EXISTING_TRANSCRIPT_IMPORTED',provenanceLabel:MANUAL_SUMMARY_LABEL,providerExecution:'NOT_RUN_BY_APP',automaticSummaryCompleted:false};
const metadata=(body=text,extra={})=>({id:crypto.randomUUID(),revision:1,sourceSha256:sourceHash,sourceProvenance:source.sourceProvenance,artifactSha256:hash(Buffer.from(body)),artifactBytes:Buffer.byteLength(body),createdAt:'2030-01-01T00:00:00.000Z',provenance:'EXISTING_TRANSCRIPT_IMPORTED',provenanceLabel:MANUAL_SUMMARY_LABEL,providerExecution:'NOT_RUN_BY_APP',automaticSummaryCompleted:false,basisMethod:'OWNER_SOURCE_RECONCILIATION',independentlyVerified:false,...extra});

function fixture({jobId=crypto.randomUUID(),hook,visible=()=>true}={}){
 const calls=[],records=new Map(),requests=new Map(),changes=[];let sequence=0;
 const base='/api/jobs/'+jobId;
 const serve=async(path,options={})=>{
  const method=options.method??'GET',body=options.body;
  if(path===base+'/imported-summaries/source')return {...source};
  if(path===base+'/imported-summaries'&&method==='GET')return {summaries:[...records.values()].map(({text,...row})=>row).sort((a,b)=>b.revision-a.revision),hasMore:false,nextBeforeRevision:null};
  if(path===base+'/imported-summaries'&&method==='POST'){
   const cancelled=requests.get(body.requestId);if(cancelled?.state==='CANCELLED')return cancelled;
   const content=Buffer.from(body.artifactBase64,'base64').toString('utf8'),existing=[...records.values()].find(row=>row.artifactSha256===body.artifactSha256&&row.sourceSha256===body.sourceSha256);
   const row=existing??{...metadata(content,{revision:++sequence}),text:content};records.set(row.id,row);
   const {text:ignored,...summary}=row,result={state:'COMMITTED',requestId:body.requestId,summary,reused:!!existing};requests.set(body.requestId,result);return result;
  }
  const requestMatch=path.match(/\/imported-summary-requests\/([^/]+)(\/cancel)?$/);
  if(requestMatch){const requestId=requestMatch[1];if(method==='POST'&&requestMatch[2]){if(!requests.has(requestId))requests.set(requestId,{state:'CANCELLED',requestId});return requests.get(requestId);}return requests.get(requestId)??{state:'NOT_FOUND',requestId};}
  const detailMatch=path.match(/\/imported-summaries\/([^/]+)$/);if(detailMatch&&records.has(detailMatch[1]))return {summary:records.get(detailMatch[1])};
  throw Error('Unexpected synthetic route');
 };
 const api=async(path,options={})=>{calls.push({path,method:options.method??'GET',body:options.body});return hook?hook({path,options,serve,records,requests}):serve(path,options);};
 const controller=createImportedSummaryController({jobId,api,isCurrent:visible,onChange:value=>changes.push(value)});
 return {jobId,base,api,serve,controller,calls,records,requests,changes,posts:()=>calls.filter(call=>call.method==='POST'&&call.path===base+'/imported-summaries')};
}
async function ready(f,content=text){await f.controller.load();await f.controller.prepare(fileOf(content));}

test('TXT preparation preserves UTF-8 bytes, BOM, CRLF and hash exactly',async()=>{
 const prepared=await prepareManualSummaryFile(fileOf(text));assert.equal(prepared.text,text);assert.equal(prepared.artifactSha256,hash(Buffer.from(text)));assert.equal(prepared.artifactBytes,Buffer.byteLength(text));assert.deepEqual(Buffer.from(prepared.artifactBase64,'base64'),Buffer.from(text));
});
test('UTF-8 limit counts bytes and permits exactly one million bytes',async()=>{
 const content='가'.repeat(333333)+'x';assert.equal(Buffer.byteLength(content),MANUAL_SUMMARY_MAX_BYTES);assert.equal((await prepareManualSummaryFile(fileOf(content))).artifactBytes,MANUAL_SUMMARY_MAX_BYTES);
 let read=0;const tooLarge=fileOf(content+'x');tooLarge.arrayBuffer=async()=>{read++;return new ArrayBuffer(0);};await assert.rejects(()=>prepareManualSummaryFile(tooLarge),{code:'MANUAL_IMPORT_BYTE_LIMIT'});assert.equal(read,0);
});
for(const [label,bytes] of [['malformed',[0xc0,0xaf]],['truncated',[0xe3,0x81]],['surrogate',[0xed,0xa0,0x80]]])test('rejects '+label+' UTF-8 without replacement characters',async()=>{await assert.rejects(()=>prepareManualSummaryFile(fileOf(bytes)),{code:'MANUAL_IMPORT_UTF8'});});
for(const content of ['', ' \r\n\t', '\ufeff', 'synthetic\u0000text'])test('rejects empty or control-only/disallowed TXT '+JSON.stringify(content),async()=>{await assert.rejects(()=>prepareManualSummaryFile(fileOf(content)));});
test('rejects a misleading byte size or file extension',async()=>{
 const file=fileOf(text);file.size--;await assert.rejects(()=>prepareManualSummaryFile(file),{code:'MANUAL_IMPORT_BYTE_LIMIT'});
 const other=fileOf(text);other.name='synthetic-summary.html';await assert.rejects(()=>prepareManualSummaryFile(other),{code:'MANUAL_IMPORT_FILE_TYPE'});
});
test('save requires explicit source reconciliation and uses fixed non-provider provenance',async()=>{
 const f=fixture();await ready(f);await f.controller.save();assert.equal(f.posts().length,0);await f.controller.save({ownerConfirmed:true});assert.equal(f.posts().length,1);
 const body=f.posts()[0].body;assert.deepEqual(Object.keys(body).sort(),['artifactBase64','artifactSha256','basis','provenance','requestId','sourceSha256'].sort());assert.equal(body.provenance,'EXISTING_TRANSCRIPT_IMPORTED');assert.deepEqual(body.basis,{method:'OWNER_SOURCE_RECONCILIATION',sourceSha256:sourceHash,artifactSha256:hash(Buffer.from(text)),ownerConfirmed:true});assert.equal(f.controller.getState().detail.text,text);assert.equal(f.controller.getState().summary.automaticSummaryCompleted,false);
});
test('rapid save clicks share a single dispatched request and completed repeat never sends another',async()=>{
 const gate=deferred();const f=fixture({hook:async({path,options,serve})=>{if(options.method==='POST'&&path.endsWith('/imported-summaries'))await gate.promise;return serve(path,options);}});await ready(f);
 const first=f.controller.save({ownerConfirmed:true}),second=f.controller.save({ownerConfirmed:true});assert.equal(first,second);assert.equal(f.posts().length,1);gate.resolve();await Promise.all([first,second]);await f.controller.save({ownerConfirmed:true});assert.equal(f.posts().length,1);assert.equal(f.records.size,1);assert.equal(f.controller.getState().phase,'SAVED');
});
test('commit with lost response is recovered by GET without a second POST',async()=>{
 const f=fixture({hook:async({path,options,serve})=>{const response=await serve(path,options);if(options.method==='POST'&&path.endsWith('/imported-summaries'))throw Error('Synthetic lost response');return response;}});await ready(f);await f.controller.save({ownerConfirmed:true});assert.equal(f.posts().length,1);assert.equal(f.records.size,1);assert.equal(f.controller.getState().phase,'SAVED');assert.ok(f.calls.some(call=>call.method==='GET'&&call.path.includes('/imported-summary-requests/')));
});
test('missing ledger after uncertain submission stays blocked until cancellation is confirmed',async()=>{
 let fail=true;const f=fixture({hook:async({path,options,serve})=>{if(fail&&options.method==='POST'&&path.endsWith('/imported-summaries'))throw Error('Synthetic interrupted save');return serve(path,options);}});await ready(f);await f.controller.save({ownerConfirmed:true});assert.equal(f.controller.getState().phase,'UNKNOWN');await f.controller.save({ownerConfirmed:true});await f.controller.prepare(fileOf('Synthetic replacement'));assert.equal(f.posts().length,1);assert.equal(f.records.size,0);
 await f.controller.cancel();assert.equal(f.controller.getState().phase,'CANCELLED');fail=false;await f.controller.prepare(fileOf(text));await f.controller.save({ownerConfirmed:true});assert.equal(f.posts().length,2);assert.equal(f.records.size,1);
});
test('unknown request identifier survives controller recreation without storing file content',async()=>{
 let denyReads=true;const f=fixture({hook:async({path,options,serve})=>{if(options.method==='POST'&&path.endsWith('/imported-summaries')){await serve(path,options);throw Error('Synthetic lost response');}if(denyReads&&path.includes('/imported-summary-requests/'))throw Error('Synthetic offline read');return serve(path,options);}});await ready(f);await f.controller.save({ownerConfirmed:true});assert.equal(f.controller.getState().phase,'UNKNOWN');
 const reopened=createImportedSummaryController({jobId:f.jobId,api:f.api});denyReads=false;await reopened.load();assert.equal(reopened.getState().phase,'SAVED');assert.equal(reopened.getState().detail.text,text);assert.equal(f.posts().length,1);
});
test('cancelling file preparation prevents a late async file read from enabling save',async()=>{
 const f=fixture();await f.controller.load();const gate=deferred(),file=fileOf(text),bytes=await file.arrayBuffer();file.arrayBuffer=()=>gate.promise;const prepare=f.controller.prepare(file);await f.controller.cancel();gate.resolve(bytes);await prepare;await f.controller.save({ownerConfirmed:true});assert.equal(f.controller.getState().phase,'CANCELLED');assert.equal(f.posts().length,0);assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
});
test('cancellation winning the write race remains cancelled after late save rejection',async()=>{
 const gate=deferred();const f=fixture({hook:async({path,options,serve})=>{if(options.method==='POST'&&path.endsWith('/imported-summaries')){await gate.promise;throw Error('Synthetic cancellation rejected save');}return serve(path,options);}});await ready(f);const save=f.controller.save({ownerConfirmed:true});await f.controller.cancel();assert.equal(f.controller.getState().phase,'CANCELLED');gate.resolve();await save;assert.equal(f.controller.getState().phase,'CANCELLED');assert.equal(f.records.size,0);assert.equal(f.posts().length,1);
});
test('a commit winning cancellation is displayed as saved without deleting the summary',async()=>{
 const gate=deferred();const f=fixture({hook:async({path,options,serve})=>{const result=await serve(path,options);if(options.method==='POST'&&path.endsWith('/imported-summaries'))await gate.promise;return result;}});await ready(f);const save=f.controller.save({ownerConfirmed:true});await Promise.resolve();await f.controller.cancel();assert.equal(f.controller.getState().phase,'SAVED');assert.equal(f.records.size,1);gate.resolve();await save;assert.equal(f.controller.getState().phase,'SAVED');assert.ok(f.calls.every(call=>call.method!=='DELETE'));
});
test('late cancellation failure cannot downgrade an already confirmed saved result',async()=>{
 const saveGate=deferred(),cancelGate=deferred();const f=fixture({hook:async({path,options,serve})=>{if(path.endsWith('/cancel')){await cancelGate.promise;throw Error('Synthetic late cancellation response loss');}if(options.method==='POST'&&path.endsWith('/imported-summaries'))await saveGate.promise;return serve(path,options);}});await ready(f);const saving=f.controller.save({ownerConfirmed:true}),cancelling=f.controller.cancel();saveGate.resolve();await saving;assert.equal(f.controller.getState().phase,'SAVED');cancelGate.resolve();await cancelling;assert.equal(f.controller.getState().phase,'SAVED');assert.equal(f.records.size,1);
});
test('repeated cancellation clicks send one cancellation request',async()=>{
 const cancelGate=deferred();const f=fixture({hook:async({path,options,serve})=>{if(options.method==='POST'&&path.endsWith('/imported-summaries'))throw Error('Synthetic interrupted save');if(path.endsWith('/cancel'))await cancelGate.promise;return serve(path,options);}});await ready(f);await f.controller.save({ownerConfirmed:true});const one=f.controller.cancel(),two=f.controller.cancel();assert.equal(one,two);assert.equal(f.calls.filter(call=>call.path.endsWith('/cancel')).length,1);cancelGate.resolve();await one;assert.equal(f.controller.getState().phase,'CANCELLED');
});
test('late file read after navigation causes no UI update or save',async()=>{
 let visible=true;const f=fixture({visible:()=>visible});await f.controller.load();const gate=deferred(),file=fileOf(text),bytes=await file.arrayBuffer();file.arrayBuffer=()=>gate.promise;const prepared=f.controller.prepare(file);visible=false;const changes=f.changes.length;gate.resolve(bytes);await prepared;await f.controller.save({ownerConfirmed:true});assert.equal(f.posts().length,0);assert.equal(f.changes.length,changes);
});
test('in-flight save may finish after navigation but cannot paint the next analysis',async()=>{
 let visible=true;const gate=deferred();const f=fixture({visible:()=>visible,hook:async({path,options,serve})=>{if(options.method==='POST'&&path.endsWith('/imported-summaries'))await gate.promise;return serve(path,options);}});await ready(f);const saving=f.controller.save({ownerConfirmed:true});visible=false;const count=f.changes.length;gate.resolve();await saving;assert.equal(f.records.size,1);assert.equal(f.changes.length,count);
});
test('a reopened view can reconcile after the previous view receives its late commit',async()=>{
 const gate=deferred();const f=fixture({hook:async({path,options,serve})=>{if(options.method==='POST'&&path.endsWith('/imported-summaries'))await gate.promise;return serve(path,options);}});await ready(f);const saving=f.controller.save({ownerConfirmed:true}),reopened=createImportedSummaryController({jobId:f.jobId,api:f.api});await reopened.load();assert.equal(reopened.getState().phase,'UNKNOWN');gate.resolve();await saving;await reopened.reconcile();assert.equal(reopened.getState().phase,'SAVED');assert.equal(reopened.getState().detail.text,text);assert.equal(f.posts().length,1);
});
test('a stale controller result cannot erase or locally cancel a newer controller request',async()=>{
 const firstGate=deferred(),secondGate=deferred();let posts=0;
 const f=fixture({hook:async({path,options,serve})=>{if(options.method==='POST'&&path.endsWith('/imported-summaries')){if(++posts===1)await firstGate.promise;else await secondGate.promise;}return serve(path,options);}});
 await ready(f);const firstSaving=f.controller.save({ownerConfirmed:true});
 const reopened=createImportedSummaryController({jobId:f.jobId,api:f.api});await reopened.load();assert.equal(reopened.getState().phase,'UNKNOWN');await reopened.cancel();assert.equal(reopened.getState().phase,'CANCELLED');
 await reopened.prepare(fileOf('Synthetic newer summary'));const secondSaving=reopened.save({ownerConfirmed:true});assert.equal(f.posts().length,2);const secondRequestId=f.posts()[1].body.requestId;
 firstGate.resolve();await firstSaving;assert.equal(f.controller.getState().phase,'CANCELLED');
 await reopened.cancel();assert.equal(reopened.getState().phase,'CANCELLED');assert.ok(f.calls.some(call=>call.method==='POST'&&call.path.endsWith('/'+secondRequestId+'/cancel')));
 secondGate.resolve();await secondSaving;assert.equal(f.records.size,0);assert.equal(reopened.getState().phase,'CANCELLED');
});
test('out-of-order detail GET cannot replace the more recently selected summary',async()=>{
 const gate=deferred(),first=metadata('Synthetic first'),second=metadata('Synthetic second',{revision:2});const f=fixture({hook:async({path,options,serve})=>{if(path.endsWith('/'+first.id))await gate.promise;return serve(path,options);}});f.records.set(first.id,{...first,text:'Synthetic first'});f.records.set(second.id,{...second,text:'Synthetic second'});await f.controller.load();const stale=f.controller.open(first.id);await f.controller.open(second.id);gate.resolve();await stale;assert.equal(f.controller.getState().detail.id,second.id);
});
test('failed list query is represented as unknown, never as an empty saved list',async()=>{
 const f=fixture({hook:({path,options,serve})=>{if(path.endsWith('/imported-summaries')&&!options.method)throw Error('Synthetic list unavailable');return serve(path,options);}});await f.controller.load();assert.equal(f.controller.getState().summaries,null);assert.match(f.controller.getState().listError,/확인하지 못했습니다/);
});
test('a missing source cannot enable a write even when a TXT is prepared',async()=>{
 const f=fixture({hook:({path,options,serve})=>{if(path.endsWith('/source'))throw Object.assign(Error('Synthetic unavailable'),{code:'MANUAL_IMPORT_SOURCE_REQUIRED'});return serve(path,options);}});await ready(f);await f.controller.save({ownerConfirmed:true});assert.equal(f.posts().length,0);assert.equal(f.controller.getState().source,null);
});
test('older imported summaries are reachable through stable revision-cursor GET pagination',async()=>{
 const current=metadata('Synthetic recent',{revision:51}),older=metadata('Synthetic older',{revision:1});const f=fixture({hook:({path,options,serve})=>{
  if(path.endsWith('/imported-summaries')&&!options.method)return {summaries:[current],hasMore:true,limit:50,nextBeforeRevision:51};
  if(path.endsWith('/imported-summaries?limit=50&beforeRevision=51'))return {summaries:[older],hasMore:false,limit:50,nextBeforeRevision:null};
  return serve(path,options);
 }});await f.controller.load();await f.controller.nextPage();assert.equal(f.controller.getState().summaries[0].id,older.id);assert.equal(f.controller.getState().listPage,2);await f.controller.previousPage();assert.equal(f.controller.getState().summaries[0].id,current.id);assert.equal(f.controller.getState().listPage,1);assert.equal(f.calls.some(call=>call.method!=='GET'),false);
});
test('a repeated or invalid older-page cursor is blocked rather than looping the same summaries',async()=>{
 const row=metadata('Synthetic page',{revision:101});const f=fixture({hook:({path,options,serve})=>{
  if(path.endsWith('/imported-summaries'))return {summaries:[row],hasMore:true,nextBeforeRevision:101};
  if(path.includes('beforeRevision='))return {summaries:[row],hasMore:true,nextBeforeRevision:101};return serve(path,options);
 }});await f.controller.load();await f.controller.nextPage();assert.equal(f.controller.getState().summaries,null);assert.ok(f.controller.getState().listError);assert.equal(f.controller.getState().listPage,1);
});
test('detail with altered bytes or forged provider-complete provenance is not displayed',async()=>{
 const f=fixture();const row=metadata('Synthetic saved text');f.records.set(row.id,{...row,text:'Synthetic altered text'});await f.controller.load();await f.controller.open(row.id);assert.equal(f.controller.getState().detail,null);assert.ok(f.controller.getState().detailError);
 f.records.set(row.id,{...row,text:'Synthetic saved text',automaticSummaryCompleted:true});await f.controller.open(row.id);assert.equal(f.controller.getState().detail,null);assert.ok(f.controller.getState().detailError);
});
for(const key of ['sourceSha256','artifactSha256'])test('a committed reply must match the submitted '+key+' scope',async()=>{
 const f=fixture({hook:async({path,options,serve})=>{const response=await serve(path,options);if(response.state==='COMMITTED')return {...response,summary:{...response.summary,[key]:'b'.repeat(64)}};return response;}});await ready(f);await f.controller.save({ownerConfirmed:true});assert.equal(f.controller.getState().phase,'UNKNOWN');assert.equal(f.controller.getState().summary,null);assert.equal(f.changes.some(change=>change.phase==='SAVED'),false);assert.equal(f.posts().length,1);
});
test('a detail response for a different imported summary ID is never displayed',async()=>{
 const f=fixture({hook:async({path,options,serve})=>{const response=await serve(path,options);if(response.summary?.text)return {summary:{...response.summary,id:crypto.randomUUID()}};return response;}});const row=metadata(text);f.records.set(row.id,{...row,text});await f.controller.load();await f.controller.open(row.id);assert.equal(f.controller.getState().detail,null);assert.ok(f.controller.getState().detailError);
});

function domNode(tag){
 const node={tag,children:[],dataset:{},attrs:{},isConnected:true,hidden:false,disabled:false,checked:false,value:'',append(...children){this.children.push(...children);},prepend(...children){this.children.unshift(...children);},replaceChildren(...children){this.children=children;},setAttribute(key,value){this.attrs[key]=String(value);},scrollIntoView(){}};
 Object.defineProperty(node,'innerHTML',{set(){throw Error('Unsafe HTML rendering');}});return node;
}
const all=node=>[node,...(node.children||[]).flatMap(all)];
const findText=(node,value)=>all(node).find(item=>item.textContent===value);
test('DOM shows imported provenance, renders markup as text and exports via authenticated GET',async()=>{
 const f=fixture(),host=domNode('section'),mounted=mountImportedSummaries({host,jobId:f.jobId,api:f.api,document:{createElement:domNode}});await mounted.ready;
 const file=all(host).find(node=>node.type==='file'),check=all(host).find(node=>node.type==='checkbox'),save=findText(host,'가져온 요약 저장');assert.equal(save.disabled,true);const markup='<img src=x onerror="syntheticOnly()">\r\n합성 텍스트';file.files=[fileOf(markup)];await file.onchange();assert.equal(save.disabled,true);check.checked=true;check.onchange();assert.equal(save.disabled,false);await save.onclick();
 assert.ok(findText(host,MANUAL_SUMMARY_LABEL));assert.ok(all(host).some(node=>node.tag==='pre'&&node.textContent===markup));assert.equal(all(host).some(node=>node.tag==='img'),false);const link=findText(host,'가져온 요약 TXT 내보내기');assert.ok(link.attrs.href.startsWith(f.base+'/imported-summaries/'));assert.ok(link.attrs.href.endsWith('/export'));assert.equal(link.attrs.download,'imported-summary.txt');assert.equal(link.attrs.href.includes('Synthetic'),false);assert.equal(f.posts().length,1);
});
test('the app offers the independent import entry for jobs with and without an AI report',async()=>{
 const app=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__showReport=showReport;globalThis.__card=libraryCard;globalThis.__state=state;');
 const mounted=[],ctx={document:{createElement:domNode,querySelector:()=>null,querySelectorAll:()=>[]},window:{},location:{hash:''},detailRequestIsCurrent:()=>true,mountImportedSummaries:args=>{mounted.push(args);return {ready:Promise.resolve()};},setTimeout,clearTimeout};runInNewContext(app,ctx);ctx.__state.view='library';
 for(const report of [null,{summary:['Synthetic extractive report']}]){const id=crypto.randomUUID(),container=domNode('section');container.dataset.jobId=id;ctx.__showReport({id,status:'TRANSCRIPT_UNVERIFIED',report,source_type:'text'},container,true);const button=findText(container,'가져온 요약 저장·보기');assert.ok(button);await button.onclick();assert.equal(mounted.at(-1).jobId,id);assert.equal(report?.summary?.[0]??null,report?'Synthetic extractive report':null);}
 const card=ctx.__card({id:crypto.randomUUID(),status:'TRANSCRIPT_UNVERIFIED',source_type:'text',created_at:'2030-01-01T00:00:00.000Z',duration_seconds:12,importedSummaryCount:2});assert.ok(all(card).some(node=>node.textContent?.includes('기존 전사 기반 가져온 요약 2개')));
});
