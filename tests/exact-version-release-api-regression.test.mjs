import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
// Optional path permits replaying these same probes against the preserved v2.
const reviewRoot=process.env.RELEASE_REVIEW_ROOT?pathToFileURL(process.env.RELEASE_REVIEW_ROOT.replaceAll('\\','/')+'/'):new URL('../',import.meta.url);
const {fixture,versionId}=await import(new URL('tests/exact-version-release-fixture.mjs',reviewRoot));
const {target,VERSION_LIST_PAGE_BUDGET=5}=await import(new URL('scripts/exact-version-release-proposal.mjs',reviewRoot));
const promotions=f=>f.calls.filter(r=>r.method==='POST'&&r.path.endsWith('/deployments'));
const listCalls=f=>f.calls.filter(r=>r.method==='GET'&&r.path.endsWith('/versions'));
const changeD1=(f,ids)=>{f.created.bindings=f.created.bindings.map(b=>b.name==='DB'?{name:'DB',type:'d1',...ids}:b);};

for(const [name,ids] of [
 ['canonical only',{database_id:target.databaseId}],
 ['matching canonical and legacy',{database_id:target.databaseId,id:target.databaseId}],
 ['legacy only',{id:target.databaseId}],
])test(`D1 ${name}: exact reviewed database accepted`,async()=>{
 const f=fixture();await f.adapter().create(f.args());changeD1(f,ids);
 assert.equal((await f.adapter().reconcile(f.args())).state,'VERSION_VERIFIED');
 assert.equal((await f.adapter().promote(f.args())).state,'PROMOTION_PENDING');assert.equal(promotions(f).length,1);
});

for(const [name,ids] of [
 ['canonical conflict with approved legacy',{database_id:'11111111-2222-4333-8444-555555555555',id:target.databaseId}],
 ['legacy conflict with approved canonical',{database_id:target.databaseId,id:'11111111-2222-4333-8444-555555555555'}],
 ['missing both',{}],['canonical null with legacy',{database_id:null,id:target.databaseId}],
 ['canonical empty with legacy',{database_id:'',id:target.databaseId}],
 ['canonical invalid with legacy',{database_id:'not-a-uuid',id:target.databaseId}],
 ['legacy null with canonical',{database_id:target.databaseId,id:null}],
 ['legacy number with canonical',{database_id:target.databaseId,id:1}],
 ['both valid but wrong',{database_id:'11111111-2222-4333-8444-555555555555',id:'11111111-2222-4333-8444-555555555555'}],
])test(`D1 ${name}: no verification or promotion`,async()=>{
 const f=fixture();await f.adapter().create(f.args());changeD1(f,ids);
 await assert.rejects(f.adapter().reconcile(f.args()));
 await assert.rejects(f.adapter().promote(f.args()),/PROMOTION_NOT_READY/);assert.equal(promotions(f).length,0);
});

const listRows=(f,count,matchIndices)=>Array.from({length:count},(_,i)=>matchIndices.includes(i)?{id:i===matchIndices[0]?versionId:`${(i+1).toString(16).padStart(8,'0')}-1111-4111-8111-000000000001`,annotations:f.created.annotations}:{id:`${(i+1).toString(16).padStart(8,'0')}-1111-4111-8111-000000000002`,annotations:{'workers/tag':'unrelated'}});
function paginate(f,all,transform=x=>x){
 const original=f.transport.request;
 f.transport.request=r=>{
  if(r.method!=='GET'||!r.path.endsWith('/versions'))return original(r);
  f.calls.push(r);const page=r.query.page,items=all.slice((page-1)*100,page*100);
  return transform({success:true,result:items,result_info:{page,per_page:100,count:items.length,total_count:all.length,total_pages:Math.max(1,Math.ceil(all.length/100))}},page);
 };
}
async function lostAck(){const f=fixture();f.failCreate=true;await assert.rejects(f.adapter().create(f.args()));return f;}
async function remainsUncertain(f){
 const writesBefore=f.calls.filter(r=>r.method==='POST').length;
 assert.equal((await f.adapter().reconcile(f.args())).state,'UNCERTAIN_NO_WRITE_RETRY');
 await assert.rejects(f.adapter().promote(f.args()),/PROMOTION_NOT_READY/);
 f.approval.approvalId=randomUUID();await assert.rejects(f.adapter().create(f.args()),/OPERATION_EXISTS/);
 assert.equal(f.calls.filter(r=>r.method==='POST').length,writesBefore);assert.equal(promotions(f).length,0);
}

test('pagination duplicate tag on page 2: no first-page uniqueness or promotion',async()=>{
 const f=await lostAck();paginate(f,listRows(f,101,[0,100]));await remainsUncertain(f);
 assert.deepEqual(listCalls(f).map(r=>r.query.page),[1,2]);
});

for(const match of [0,100,499])test(`complete pages with only matching index ${match}: read-only recovery`,async()=>{
 const f=await lostAck(),count=match===499?500:101;paginate(f,listRows(f,count,[match]));
 const writesBefore=f.calls.filter(r=>r.method==='POST').length;
 assert.equal((await f.adapter().reconcile(f.args())).state,'VERSION_VERIFIED');
 assert.equal(listCalls(f).length,Math.ceil(count/100));assert.equal(f.calls.filter(r=>r.method==='POST').length,writesBefore);
});

for(const [name,transform] of [
 ['metadata omitted',r=>{delete r.result_info;return r;}],
 ['totals omitted',r=>{delete r.result_info.total_count;return r;}],
 ['page count omitted',r=>{delete r.result_info.total_pages;return r;}],
 ['wrong page',r=>{r.result_info.page=0;return r;}],
 ['wrong page size',r=>{r.result_info.per_page=20;return r;}],
 ['noninteger total',r=>{r.result_info.total_count=101.5;return r;}],
 ['contradictory page total',r=>{r.result_info.total_pages=1;return r;}],
 ['truncated later page',(r,p)=>{if(p===2)r.result=[];return r;}],
 ['count mismatch',r=>{r.result_info.count++;return r;}],
 ['list changed between pages',(r,p)=>{if(p===2)r.result_info.total_count++;return r;}],
 ['invalid list identity',r=>{r.result[0].id='invalid';return r;}],
])test(`pagination ${name}: uncertainty and no automatic write`,async()=>{
 const f=await lostAck();paginate(f,listRows(f,101,[0]),transform);await remainsUncertain(f);assert.ok(listCalls(f).length<=VERSION_LIST_PAGE_BUDGET);
});

test('pagination repeated ID across pages fails closed',async()=>{
 const f=await lostAck(),all=listRows(f,101,[0]);all[100]={...all[1]};paginate(f,all);await remainsUncertain(f);assert.equal(listCalls(f).length,2);
});

test('pagination page budget exhaustion preserves uncertain operation',async()=>{
 const f=await lostAck();paginate(f,listRows(f,VERSION_LIST_PAGE_BUDGET*100+1,[0]));await remainsUncertain(f);assert.ok(listCalls(f).length<=VERSION_LIST_PAGE_BUDGET);
});

test('pagination later read failure cannot enable promotion or a fresh approval retry',async()=>{
 const f=await lostAck();paginate(f,listRows(f,101,[0]),(r,p)=>{if(p===2)throw Error('MOCK_READ_FAILED');return r;});
 const writesBefore=f.calls.filter(r=>r.method==='POST').length;
 await assert.rejects(f.adapter().reconcile(f.args()),/MOCK_READ_FAILED/);
 await assert.rejects(f.adapter().promote(f.args()),/PROMOTION_NOT_READY/);
 f.approval.approvalId=randomUUID();await assert.rejects(f.adapter().create(f.args()),/OPERATION_EXISTS/);
 assert.equal(f.calls.filter(r=>r.method==='POST').length,writesBefore);
});
