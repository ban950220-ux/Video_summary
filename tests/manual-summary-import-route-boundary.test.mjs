import test from 'node:test';
import assert from 'node:assert/strict';
import {routeApi} from '../src/worker.mjs';
import {completeFromStoredReport} from '../src/local-runner-outbox.mjs';
import {createLoopbackAudioClient} from '../scripts/local-runner-audio-client.mjs';

// This tests the current in-process router, not a running site. No request is
// sent to the network, and even reading an env binding fails the fixture.
const jobId='11111111-1111-4111-8111-111111111111';
const importId='22222222-2222-4222-8222-222222222222';
const routes=[
 ['POST',`/api/jobs/${jobId}/summary-import`],
 ['POST',`/api/jobs/${jobId}/report-import`],
 ['POST',`/api/jobs/${jobId}/manual-report`],
 ['POST',`/api/jobs/${jobId}/imported-summary-preview`],
 ['GET',`/api/jobs/${jobId}/imported-summaries/${importId}.txt`],
];

for(const [method,path] of [
 ['POST',`/api/jobs/${jobId}/imported-summaries`],
 ['GET',`/api/jobs/${jobId}/imported-summaries`],
 ['GET',`/api/jobs/${jobId}/imported-summaries/${importId}`],
])test(`import boundary: ${method} ${path} requires explicitly prepared persistence`,async t=>{
 let networkCalls=0;
 t.mock.method(globalThis,'fetch',async()=>{networkCalls++;throw Error('OFFLINE_NETWORK_FORBIDDEN');});
 const response=await routeApi(new Request('https://example.invalid'+path,{method}),{});
 assert.equal(response.status,503);
 assert.equal((await response.json()).error.code,'MANUAL_IMPORT_PERSISTENCE_NOT_CONFIGURED');
 assert.equal(networkCalls,0);
});

for(const [method,path] of routes)test(`offline boundary: unsupported ${method} ${path} does not access DB or provider`,async t=>{
 let envReads=0,networkCalls=0;
 const env=new Proxy({}, {get(){envReads++;throw Error('OFFLINE_ENV_ACCESS_FORBIDDEN');}});
 t.mock.method(globalThis,'fetch',async()=>{networkCalls++;throw Error('OFFLINE_NETWORK_FORBIDDEN');});
 const request=new Request('https://example.invalid'+path,{
  method,
  ...(method==='POST'?{headers:{'content-type':'application/json'},body:JSON.stringify({text:'Synthetic imported summary only.'})}:{}),
 });
 const response=await routeApi(request,env);
 assert.equal(response.status,404);
 assert.deepEqual(await response.json(),{error:{code:'NOT_FOUND'}});
 assert.equal(envReads,0);
 assert.equal(networkCalls,0);
});

test('offline boundary: imported report cannot complete the unconnected runner ledger adapter',async()=>{
 await assert.rejects(
  completeFromStoredReport({provenance:'ASSISTANT_AUTHORED_IMPORTED_SUMMARY',report:'Synthetic summary only.'}),
  error=>error.code==='RUNNER_REPORT_VERIFIER_NOT_CONNECTED',
 );
});

test('offline boundary: a loopback client is not an authenticated production transport',()=>{
 let authCalls=0,networkCalls=0;
 assert.throws(()=>createLoopbackAudioClient({
  baseUrl:'https://example.invalid',
  authenticationHeaders:()=>{authCalls++;throw Error('AUTH_MUST_NOT_RUN');},
  fetchImpl:()=>{networkCalls++;throw Error('NETWORK_MUST_NOT_RUN');},
 }),error=>error.code==='RUNNER_LOCAL_TRANSPORT_REQUIRED');
 assert.equal(authCalls,0);
 assert.equal(networkCalls,0);
});
