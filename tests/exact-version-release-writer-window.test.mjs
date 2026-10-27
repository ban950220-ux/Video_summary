import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,NOW} from './exact-version-release-fixture.mjs';

const writes=f=>f.calls.filter(request=>request.method==='POST').length;
const beforeWindow=f=>new Date(Date.parse(f.observation.singleWriter.startsAt)-1).toISOString();

test('initial metadata captured before the writer window cannot authorize a write',async()=>{
 const f=fixture();f.observation.observedAt=new Date(NOW-30000).toISOString();
 await assert.rejects(f.adapter().create(f.args()),/OBSERVATION_BEFORE_WRITER_WINDOW/);
 assert.equal(writes(f),0);
});

test('a recent pre-window snapshot returned by the final reader cannot authorize creation',async()=>{
 const f=fixture();
 f.readObservation=async()=>({...structuredClone(f.observation),observedAt:beforeWindow(f)});
 await assert.rejects(f.adapter().create(f.args()),error=>error.message==='CREATE_STOPPED_RECONCILE_ONLY'&&error.cause?.message==='OBSERVATION_BEFORE_WRITER_WINDOW');
 assert.equal(writes(f),0);
});

test('a pre-window final observation cannot promote an already verified version',async()=>{
 const f=fixture();await f.adapter().create(f.args());await f.adapter().reconcile(f.args());
 const before=writes(f);
 f.readObservation=async()=>({...structuredClone(f.observation),observedAt:beforeWindow(f)});
 await assert.rejects(f.adapter().promote(f.args()),/OBSERVATION_BEFORE_WRITER_WINDOW/);
 assert.equal(writes(f),before);
 assert.equal(f.calls.some(request=>request.method==='POST'&&request.path.endsWith('/deployments')),false);
});

test('metadata captured exactly at the writer-window start remains eligible',async()=>{
 const f=fixture();f.observation.observedAt=f.observation.singleWriter.startsAt;
 assert.equal((await f.adapter().create(f.args())).state,'VERSION_CREATED');
 assert.equal(writes(f),2);
});

test('historical pre-window metadata permits read-only reconciliation but no promotion',async()=>{
 const f=fixture();await f.adapter().create(f.args());
 const before=writes(f);f.observation.observedAt=beforeWindow(f);
 assert.equal((await f.adapter().reconcile(f.args())).state,'VERSION_VERIFIED');
 await assert.rejects(f.adapter().promote(f.args()),/OBSERVATION_BEFORE_WRITER_WINDOW/);
 assert.equal(writes(f),before);
});

test('fresh read-only confirmation remains supported after the writer window and approval expire',async()=>{
 const f=fixture();await f.adapter().create(f.args());await f.adapter().reconcile(f.args());await f.adapter().promote(f.args());
 const before=writes(f);f.clock=NOW+3600000;
 assert.equal((await f.adapter().reconcile(f.args())).state,'CONFIRMED');
 await assert.rejects(f.adapter().promote(f.args()));
 assert.equal(writes(f),before);
});
