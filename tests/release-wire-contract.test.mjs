import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspect} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fixture,files,versionId} from './exact-version-release-fixture.mjs';
import {target,packageCandidate} from '../scripts/exact-version-release-proposal.mjs';
import {releaseWireCompiler,reviewedModuleDigest} from '../scripts/release-wire-contract.mjs';

// Local frozen build output only. Do not download missing fixtures or use a
// synthetic worker module in place of the independently reviewed real bundle.
const bundleRoot=resolve(process.env.REVIEWED_RELEASE_BUNDLE_DIR??fileURLToPath(new URL('./fixtures/release-reviewed-6c3f309/',import.meta.url)));
const payload=JSON.parse(readFileSync(join(bundleRoot,'MODULE_PAYLOAD.json'),'utf8'));
const candidate=()=>packageCandidate({files,...payload});
const base=`/accounts/${target.accountId}/workers`;
const tag='release-11111111-2222-4333-8444-555555555555';
const syntheticToken='SYNTHETIC_ASSET_TOKEN_NOT_A_CREDENTIAL';
const noNetwork=()=>{throw Error('TEST_NETWORK_FORBIDDEN');};
globalThis.fetch=noNetwork;

function setup(){
 const f=fixture();f.package=candidate();f.approval.moduleDigest=f.package.moduleDigest;
 const compiler=releaseWireCompiler({candidate:f.package,workerReference:f.observation.worker.id,baselineBindings:f.observation.version.bindings});
 const descriptors={
  session:{method:'POST',path:`${base}/scripts/${target.workerName}/assets-upload-session`,body:{manifest:f.package.assets.apiManifest}},
  upload:{method:'POST',path:`${base}/assets/upload`,query:{base64:true},headers:{Authorization:`Bearer ${syntheticToken}`},multipart:Object.fromEntries(f.package.assets.rows.map(r=>[r.apiHash,r.bytes.toString('base64')]))},
  create:{method:'POST',path:`${base}/workers/${f.observation.worker.id}/versions`,query:{deploy:false},body:{annotations:{'workers/message':`source-commit:${target.candidateCommit}`,'workers/tag':tag},bindings:f.observation.version.bindings.map(b=>b.type==='assets'?{name:b.name,type:'assets'}:{name:b.name,type:'inherit',version_id:target.baselineVersionId}),compatibility_date:'2026-10-10',compatibility_flags:[],assets:{config:{run_worker_first:true},jwt:syntheticToken},...structuredClone(payload)}},
  promote:{method:'POST',path:`${base}/scripts/${target.workerName}/deployments`,query:{force:false},body:{strategy:'percentage',versions:[{version_id:versionId,percentage:100}],annotations:{'workers/message':tag}}},
 };
 return {f,compiler,descriptors};
}

test('actual reviewed bundle and all eight frozen asset bytes are pinned',()=>{
 const p=candidate();assert.equal(p.moduleDigest,reviewedModuleDigest);assert.equal(p.assets.rows.length,8);
 assert.equal(Buffer.from(p.modules[0].content_base64,'base64').length,897758);
 assert.deepEqual(p.assets.apiManifest,JSON.parse(readFileSync(join(bundleRoot,'ASSET_MANIFEST.json'),'utf8')));
 for(const row of p.assets.rows)assert.deepEqual(row.bytes,readFileSync(join(bundleRoot,'source',row.path)));
});

test('session and version requests use official JSON shapes with deploy=false',async()=>{
 const {compiler,descriptors}=setup();
 for(const name of ['session','create']){
  const prepared=compiler.compile(descriptors[name]);const request=prepared.takeForReviewedTransport();
  assert.equal(request.method,'POST');assert.equal(request.redirect,'error');assert.equal(request.headers.get('authorization'),null);
  assert.equal(request.headers.get('content-type'),'application/json');assert.deepEqual(await request.json(),descriptors[name].body);
  assert.equal(new URL(request.url).origin,'https://api.cloudflare.com');
  assert.equal(new URL(request.url).search,name==='create'?'?deploy=false':'');
  assert.equal(prepared.toJSON().productionExecutionSupported,false);
 }
});

test('multipart preserves reviewed asset bytes and browser MIME types',async()=>{
 const {compiler,descriptors,f}=setup();const request=compiler.compile(descriptors.upload).takeForReviewedTransport();
 assert.equal(new URL(request.url).search,'?base64=true');assert.equal(request.headers.get('authorization'),`Bearer ${syntheticToken}`);
 assert.match(request.headers.get('content-type'),/^multipart\/form-data; boundary=/);
 const form=await request.formData();assert.equal([...form].length,8);
 // Cloudflare serves the per-part Content-Type. These explicit expectations
 // protect the real HTML/module/CSS consumers, including this Worker's nosniff.
 const expectedTypes={
  'web/site/app.js':'text/javascript; charset=utf-8',
  'web/site/audio-progress-plan.mjs':'text/javascript; charset=utf-8',
  'web/site/audio-runner.mjs':'text/javascript; charset=utf-8',
  'web/site/audio.mjs':'text/javascript; charset=utf-8',
  'web/site/context-review.mjs':'text/javascript; charset=utf-8',
  'web/site/groq-summary-progress.mjs':'text/javascript; charset=utf-8',
  'web/site/index.html':'text/html; charset=utf-8',
  'web/site/style.css':'text/css; charset=utf-8',
 };
 assert.deepEqual(f.package.assets.rows.map(row=>row.path).sort(),Object.keys(expectedTypes).sort());
 for(const row of f.package.assets.rows){const file=form.get(row.apiHash);assert.equal(file.name,row.apiHash);assert.equal(file.type,expectedTypes[row.path],row.path);assert.equal(await file.text(),row.bytes.toString('base64'));}
});

test('promotion is separate, exact one-version 100 percent, force=false',async()=>{
 const {compiler,descriptors}=setup();assert.throws(()=>compiler.compile(descriptors.promote),/REJECTED/);
 const request=compiler.compile(descriptors.promote,{verifiedCreatedVersionId:versionId}).takeForReviewedTransport();
 assert.equal(new URL(request.url).search,'?force=false');assert.deepEqual(await request.json(),descriptors.promote.body);
});

test('prepared requests hide body/token and can be consumed only once',()=>{
 const {compiler,descriptors}=setup();
 for(const name of ['upload','create']){
  const prepared=compiler.compile(descriptors[name]);
  for(const shown of [JSON.stringify(prepared),inspect(prepared),inspect(prepared,{showHidden:true})]){
   assert.ok(!shown.includes(syntheticToken));assert.ok(!shown.includes('content_base64'));assert.ok(!shown.includes('Bearer '));
  }
  prepared.takeForReviewedTransport();assert.throws(()=>prepared.takeForReviewedTransport(),/REJECTED/);
 }
});

test('compiler snapshots reviewed bytes and prepared request snapshots descriptor',async()=>{
 const {compiler,descriptors,f}=setup();const original=structuredClone(descriptors.create.body);
 const prepared=compiler.compile(descriptors.create);descriptors.create.body.assets.jwt='CHANGED';descriptors.create.body.modules[0].content_base64='CHANGED';
 f.package.assets.rows[0].bytes.fill(0);f.package.modules[0].content_base64='CHANGED';
 assert.deepEqual(await prepared.takeForReviewedTransport().json(),original);
 const next={...descriptors.create,body:original};assert.doesNotThrow(()=>compiler.compile(next));
});

test('displayed audit query cannot diverge from the immutable prepared wire request',()=>{
 const {compiler,descriptors}=setup();
 const prepared=compiler.compile(descriptors.create);const audit=prepared.toJSON();
 assert.throws(()=>{audit.query.deploy='true';},TypeError);
 assert.throws(()=>{audit.query.extra='SYNTHETIC_MARKER';},TypeError);
 assert.equal(prepared.toJSON().query.deploy,'false');
 assert.equal(new URL(prepared.takeForReviewedTransport().url).search,'?deploy=false');
 assert.ok(!inspect(prepared).includes('SYNTHETIC_MARKER'));
});

const mutations=[
 ['force true','promote',d=>d.query.force=true],
 ['force omitted','promote',d=>delete d.query.force],
 ['deploy true','create',d=>d.query.deploy=true],
 ['deploy omitted','create',d=>delete d.query.deploy],
 ['latest inheritance','create',d=>d.body.bindings[0].version_id='latest'],
 ['another baseline','create',d=>d.body.bindings[0].version_id=versionId],
 ['old_name binding rename','create',d=>d.body.bindings[0].old_name='OTHER'],
 ['secret override','create',d=>d.body.bindings[0]={name:'DB',type:'secret_text',text:'SYNTHETIC_SECRET'}],
 ['unreviewed binding','create',d=>d.body.bindings.push({name:'NEW',type:'inherit',version_id:target.baselineVersionId})],
 ['runtime change','create',d=>d.body.compatibility_flags=['nodejs_compat']],
 ['asset behavior change','create',d=>d.body.assets.config.run_worker_first=false],
 ['module change','create',d=>d.body.modules[0].content_base64=Buffer.from('other').toString('base64')],
 ['manifest size','session',d=>Object.values(d.body.manifest)[0].size++],
 ['manifest omission','session',d=>delete d.body.manifest[Object.keys(d.body.manifest)[0]]],
 ['asset bytes','upload',d=>d.multipart[Object.keys(d.multipart)[0]]='AAAA'],
 ['unknown asset hash','upload',d=>d.multipart['f'.repeat(32)]='AAAA'],
 ['empty bucket','upload',d=>d.multipart={}],
 ['extra authorization','create',d=>d.headers={Authorization:'Bearer SYNTHETIC'}],
 ['cookie header','upload',d=>d.headers.Cookie='SYNTHETIC'],
 ['newline token','upload',d=>d.headers.Authorization+='\nFORBIDDEN'],
 ['wrong account','create',d=>d.path=d.path.replace(target.accountId,'0'.repeat(32))],
 ['arbitrary origin','upload',d=>d.path='https://example.invalid/upload'],
 ['additional traffic version','promote',d=>d.body.versions.push({version_id:target.baselineVersionId,percentage:0})],
 ['partial traffic','promote',d=>d.body.versions[0].percentage=99],
 ['read operation','create',d=>d.method='GET'],
];
for(const [name,which,mutate] of mutations)test(`reject ${name}`,()=>{
 const {compiler,descriptors}=setup();const changed=structuredClone(descriptors[which]);mutate(changed);
 assert.throws(()=>compiler.compile(changed,{verifiedCreatedVersionId:versionId}),/RELEASE_WIRE_CONTRACT_REJECTED/);
});

test('compiler rejects synthetic bundle, wrong asset bytes and unknown binding set',()=>{
 const f=fixture();const args={candidate:f.package,workerReference:f.observation.worker.id,baselineBindings:f.observation.version.bindings};
 assert.throws(()=>releaseWireCompiler(args),/REJECTED/);args.candidate=candidate();args.candidate.assets.rows[0].bytes[0]^=1;
 assert.throws(()=>releaseWireCompiler(args),/MANIFEST_MISMATCH/);args.candidate=candidate();args.baselineBindings.push({name:'UNKNOWN',type:'secret_text'});
 assert.throws(()=>releaseWireCompiler(args),/REJECTED/);
});

test('Worker name is supported syntactically without claiming remote identity proof',()=>{
 const {f,descriptors}=setup();
 const compiler=releaseWireCompiler({candidate:f.package,workerReference:target.workerName,baselineBindings:f.observation.version.bindings});
 const descriptor=structuredClone(descriptors.create);descriptor.path=`${base}/workers/${target.workerName}/versions`;
 assert.doesNotThrow(()=>compiler.compile(descriptor));
 for(const ref of ['other-worker','../holy-rice-b914',{},123,null])assert.throws(()=>releaseWireCompiler({candidate:f.package,workerReference:ref,baselineBindings:f.observation.version.bindings}),/REJECTED/);
});

function wireFixture(){
 const {f,compiler}=setup();const raw=f.transport.request,prepared=[];
 f.buckets=[f.package.assets.rows.map(r=>r.apiHash)];
 f.transport.request=async descriptor=>{
  if(descriptor.method==='POST'){
   const item=compiler.compile(descriptor,{verifiedCreatedVersionId:versionId});const request=item.takeForReviewedTransport();
   const url=new URL(request.url);assert.equal(url.pathname,'/client/v4'+descriptor.path);
   if(descriptor.multipart){const form=await request.formData();for(const [hash,bytes] of Object.entries(descriptor.multipart))assert.equal(await form.get(hash).text(),bytes);}
   else assert.deepEqual(await request.json(),descriptor.body);
   prepared.push(item.toJSON());
  }
  return raw(descriptor);
 };
 return {f,prepared};
}

test('v4 durable mock flow consumes real candidate wire requests through separate promotion',async()=>{
 const {f,prepared}=wireFixture();const adapter=f.adapter();
 assert.equal((await adapter.create(f.args())).state,'VERSION_CREATED');assert.equal(f.active,null);
 assert.equal((await adapter.reconcile(f.args())).state,'VERSION_VERIFIED');
 assert.equal((await adapter.promote(f.args())).state,'PROMOTION_PENDING');
 assert.equal((await adapter.reconcile(f.args())).state,'CONFIRMED');
 assert.deepEqual(prepared.map(x=>x.phase),['ASSET_SESSION','ASSET_UPLOAD','VERSION_CREATE','TRAFFIC_PROMOTION']);
 assert.ok(prepared.every(x=>x.productionExecutionSupported===false&&x.moduleDigest===reviewedModuleDigest));
 // No source, JWT or authorization header is published to the durable journal.
 const readTree=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?readTree(join(dir,e.name)):[readFileSync(join(dir,e.name),'utf8')]);
 const journal=readTree(f.directory).join('\n');assert.ok(!journal.includes('MOCK_FINAL_COMPLETION_TOKEN'));assert.ok(!journal.includes('content_base64'));assert.ok(!journal.includes('Bearer '));
});

test('wire integration keeps ACK loss uncertain across restart/new approval without write retry',async()=>{
 const {f,prepared}=wireFixture();f.failCreate=true;
 await assert.rejects(f.adapter().create(f.args()),/CREATE_STOPPED_RECONCILE_ONLY/);
 assert.equal(prepared.filter(x=>x.phase==='VERSION_CREATE').length,1);
 f.approval.approvalId=randomUUID();await assert.rejects(f.adapter().create(f.args()),/OPERATION_EXISTS_RECONCILE_ONLY/);
 assert.equal(prepared.length,3);assert.equal(f.active,null);
 assert.equal((await f.adapter().reconcile(f.args())).state,'VERSION_VERIFIED');assert.equal(prepared.length,3);
});
