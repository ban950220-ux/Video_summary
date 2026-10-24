import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('new snapshot UI discloses historical cost, requires consent and reuses ID after lost ACK without quote',async()=>{
 const node=tag=>({tag,children:[],dataset:{},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=items;},setAttribute(){}}),target=node('div');target.dataset.jobId='original';
 const calls=[];let posts=0;
 const fetcher=async(path,options)=>{calls.push({path,method:options.method,body:options.body});if(options.method==='POST'&&posts++===0)throw Error('ACK_LOST');return {ok:true,headers:{get:()=> 'application/json'},json:async()=>options.method==='POST'?{childJobId:JSON.parse(options.body).requestId}:{evidenceSha256:'a'.repeat(64),assessment:{status:'TRANSCRIPT_UNVERIFIED'},disclosure:{uncertainOperations:7,paidReservations:[{state:'SETTLED',outcome:'REPORT_NOT_SAVED'}]}}};};
 const source=readFileSync(new URL('../web/site/app.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'\nglobalThis.__show=showSeparateSummaryPreparation;globalThis.__state=state;');
 const context={crypto,document:{createElement:node,querySelector:()=>null,hidden:false},window:{},location:{hash:''},fetch:fetcher,detailRequestIsCurrent:()=>true,setTimeout,clearTimeout};runInNewContext(source,context);context.__state.view='library';context.__show({id:'original'},target,0);
 const host=target.children[0];await host.children[0].onclick();const labels=host.children.filter(n=>n.tag==='label'),button=host.children.find(n=>n.tag==='button'&&n!==host.children[0]);assert.equal(labels.length,3);await button.onclick();assert.equal(posts,0);
 for(const label of labels)label.children[0].checked=true;
 await button.onclick();assert.equal(posts,1);assert.equal(button.disabled,false);await button.onclick();assert.equal(posts,2);
 const requests=calls.filter(c=>c.method==='POST');assert.deepEqual(JSON.parse(requests[0].body),JSON.parse(requests[1].body));assert.equal(JSON.parse(requests[0].body).confirmNoProviderCall,true);assert.ok(calls.every(c=>c.path.endsWith('/source-summary-attempt')));assert.ok(host.children.some(n=>n.textContent?.includes('REPORT_NOT_SAVED')));assert.ok(labels.some(n=>n.textContent?.includes('삭제해도')));
});
