import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.RELEASE_REVIEW_ROOT?pathToFileURL(process.env.RELEASE_REVIEW_ROOT.replaceAll('\\','/')+'/'):new URL('../',import.meta.url);
const {fixture}=await import(new URL('tests/exact-version-release-fixture.mjs',root));
const {offlineReleaseAdapter,operationKey}=await import(new URL('scripts/exact-version-release-proposal.mjs',root));
const rows=f=>{const dir=join(f.directory,operationKey(f.observation,f.package));return readdirSync(dir).filter(n=>n.endsWith('.json')).sort().map(n=>JSON.parse(readFileSync(join(dir,n),'utf8')));};
const writes=f=>f.calls.filter(r=>r.method==='POST').length;
async function promoted(){const f=fixture();await f.adapter().create(f.args());await f.adapter().reconcile(f.args());await f.adapter().promote(f.args());return f;}

for(const age of [0,59999,60000,60001,3600000,-1])test(`post-promotion observation age ${age}ms`,async()=>{
 const f=await promoted(),before=rows(f),writeCount=writes(f);const read=f.readObservation;
 const adapter=offlineReleaseAdapter({directory:f.directory,transport:f.transport,now:()=>f.clock,readObservation:async()=>{const o=await read();o.observedAt=new Date(f.clock-age).toISOString();return o;}});
 if(age>=0&&age<=60000){assert.equal((await adapter.reconcile(f.args())).state,'CONFIRMED');assert.equal(rows(f).at(-1).state,'CONFIRMED');}
 else{await assert.rejects(adapter.reconcile(f.args()));assert.deepEqual(rows(f),before);await assert.rejects(adapter.promote(f.args()),/PROMOTION_NOT_READY/);}
 assert.equal(writes(f),writeCount);
});

for(const value of [NaN,Infinity,-Infinity,'1792821600000',undefined,()=>0])test(`invalid post-await current time ${String(value)}`,async()=>{
 const f=await promoted(),before=rows(f),writeCount=writes(f);const read=f.readObservation;let afterRead=false;
 const adapter=offlineReleaseAdapter({directory:f.directory,transport:f.transport,now:()=>afterRead?value:f.clock,readObservation:async()=>{const o=await read();afterRead=true;return o;}});
 await assert.rejects(adapter.reconcile(f.args()),/CURRENT_TIME_INVALID/);assert.deepEqual(rows(f),before);assert.equal(writes(f),writeCount);
});

for(const observedAt of ['not-a-date','2026-99-99T00:00:00.000Z'])test(`invalid observation timestamp ${observedAt}`,async()=>{
 const f=await promoted(),before=rows(f),writeCount=writes(f);const read=f.readObservation;
 const adapter=offlineReleaseAdapter({directory:f.directory,transport:f.transport,now:()=>f.clock,readObservation:async()=>({...await read(),observedAt})});
 await assert.rejects(adapter.reconcile(f.args()));assert.deepEqual(rows(f),before);assert.equal(writes(f),writeCount);
});
