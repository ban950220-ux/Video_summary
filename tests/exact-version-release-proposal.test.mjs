import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {readdirSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,files,NOW,versionId} from './exact-version-release-fixture.mjs';
import {target,hash,operationKey,reviewedAssets,offlineReleaseAdapter} from '../scripts/exact-version-release-proposal.mjs';

const writes=f=>f.calls.filter(r=>r.method==='POST');
const rows=f=>{const dir=join(f.directory,operationKey(f.observation,f.package));return readdirSync(dir).filter(n=>n.endsWith('.json')).sort().map(n=>JSON.parse(readFileSync(join(dir,n),'utf8')));};
const child=(f,mode)=>fork(fileURLToPath(new URL('./exact-version-release-fixture.mjs',import.meta.url)),['child',f.directory,mode],{stdio:['ignore','pipe','pipe','ipc']});

test('exact Git LF assets: reviewed SHA256 and API hash format are distinct',()=>{
 const p=reviewedAssets(files);assert.equal(p.assetDigest,target.assetDigest);assert.equal(p.rows.length,8);
 for(const r of p.rows){assert.match(r.apiHash,/^[a-f0-9]{32}$/);assert.equal(p.apiManifest['/'+r.path.slice(9)].size,r.bytes.length);assert.equal(r.sha256,hash(r.bytes));}
 const changed=files.map(f=>({...f,bytes:Buffer.from(f.bytes)}));changed[0].bytes[0]^=1;assert.throws(()=>reviewedAssets(changed),/MANIFEST_MISMATCH/);
 assert.throws(()=>reviewedAssets(files.slice(1)),/MANIFEST_MISMATCH/);
});

test('create, inspect, promote, inspect are distinct; exact inherit; no tokens in durable journal',async()=>{
 const f=fixture(),adapter=f.adapter();const created=await adapter.create(f.args());assert.equal(created.state,'VERSION_CREATED');
 assert.equal(f.calls.some(r=>r.path.endsWith('/deployments')),false);
 const request=f.calls.find(r=>r.method==='POST'&&r.path.endsWith('/versions'));
 assert.equal(request.query.deploy,false);
 for(const b of request.body.bindings)if(b.type!=='assets')assert.deepEqual(b,{name:b.name,type:'inherit',version_id:target.baselineVersionId});
 await assert.rejects(adapter.promote(f.args()),/PROMOTION_NOT_READY/);
 assert.equal((await adapter.reconcile(f.args())).state,'VERSION_VERIFIED');
 assert.equal((await adapter.promote(f.args())).state,'PROMOTION_PENDING');
 assert.equal(f.calls.find(r=>r.method==='POST'&&r.path.endsWith('/deployments')).query.force,false);
 assert.equal((await adapter.reconcile(f.args())).state,'CONFIRMED');
 assert.equal(writes(f).length,3);assert.equal(rows(f).at(-1).state,'CONFIRMED');
 assert.doesNotMatch(JSON.stringify(rows(f)),/MOCK_.*TOKEN|content_base64|ACCESS_OWNER_EMAIL/);
 await assert.rejects(f.adapter().create({...f.args(),approval:{...f.approval,approvalId:randomUUID()}}),/OPERATION_EXISTS/);
});

for(const [label,change]of [
 ['missing owner approval',f=>{f.approval=null;}],['empty owner evidence',f=>{f.approval.ownerEvidenceDigest='';}],
 ['unknown Worker',f=>{f.observation.worker.id='';}],['API unverified',f=>{f.observation.apiCompatibility='UNVERIFIED';}],
 ['unknown binding',f=>{f.observation.version.bindings.push({name:'OTHER',type:'secret_text'});}],
 ['missing binding',f=>{f.observation.version.bindings.pop();}],['binding arbitrary values',f=>{f.observation.version.bindings[1].text='DO_NOT_STORE';}],
 ['wrong D1',f=>{f.observation.version.bindings[0].id=randomUUID();}],['missing metadata',f=>{delete f.observation.workerSettingsDigest;}],
 ['writer unconfirmed',f=>{f.observation.singleWriter.confirmed=false;}],['expired approval',f=>{f.approval.expiresAt=new Date(NOW).toISOString();}],
 ['changed artifact approval',f=>{f.approval.moduleDigest='f'.repeat(64);}],['latest baseline',f=>{f.observation.version.id='latest';}],
 ['unexpected runtime settings',f=>{f.observation.version.unsupportedFields=['placement'];}],['automatic retry',f=>{f.approval.automaticRetries=1;}],
 ['source injection in approval',f=>{f.approval.authorization='DO_NOT_STORE';}],
])test(`${label}: zero mock writes`,async()=>{const f=fixture();change(f);await assert.rejects(f.adapter().create(f.args()));assert.equal(writes(f).length,0);});

test('final observation after await: expiry, Worker setting drift, deployment ABA all stop writes',async()=>{
 for(const mode of ['expiry','settings','ABA']){
  const f=fixture();f.beforeRead=()=>{if(mode==='expiry')f.clock+=900001;else if(mode==='settings')f.observation.workerSettingsDigest='f'.repeat(64);else f.observation.activeDeployment.id=randomUUID();};
  await assert.rejects(f.adapter().create(f.args()),/CREATE_STOPPED/);assert.equal(writes(f).length,0);
  assert.equal(rows(f).at(-1).state,'UNCERTAIN_NO_WRITE_RETRY');
 }
});

test('upload buckets use only approved hashes/bytes and final completion token',async()=>{
 const f=fixture();f.buckets=[[f.package.assets.rows[0].apiHash],[f.package.assets.rows[1].apiHash]];
 await f.adapter().create(f.args());const uploads=f.calls.filter(r=>r.path.endsWith('/assets/upload'));
 assert.equal(uploads.length,2);for(let i=0;i<2;i++)assert.equal(Object.values(uploads[i].multipart)[0],f.package.assets.rows[i].bytes.toString('base64'));
 assert.equal(f.created.assets.jwt,'MOCK_FINAL_COMPLETION_TOKEN');
});
test('unknown/repeated bucket fails closed before version creation',async()=>{
 for(const mode of ['unknown','repeated']){const f=fixture();f.buckets=mode==='unknown'?[['bad']]:[[f.package.assets.rows[0].apiHash],[f.package.assets.rows[0].apiHash]];await assert.rejects(f.adapter().create(f.args()));assert.equal(f.created,null);}
});
test('missing completion token is never treated as asset upload success',async()=>{
 const f=fixture();f.buckets=[[f.package.assets.rows[0].apiHash]];const original=f.transport.request;f.transport.request=r=>r.path.endsWith('/assets/upload')?{success:true,result:{}}:original(r);
 await assert.rejects(f.adapter().create(f.args()));assert.equal(f.created,null);
});
test('pre-write asset failure cannot adopt an unrelated version',async()=>{
 const f=fixture();f.beforeRequest=r=>{if(r.path.endsWith('/assets-upload-session'))throw Error('lost');};
 await assert.rejects(f.adapter().create(f.args()));assert.equal((await f.adapter().reconcile(f.args())).state,'UNCERTAIN_NO_WRITE_RETRY');assert.equal(f.calls.filter(r=>r.method==='GET').length,0);
});

test('version ACK loss: restart/new approval cannot rewrite, GET can recover exact candidate',async()=>{
 const f=fixture();f.failCreate=true;await assert.rejects(f.adapter().create(f.args()));
 f.approval.approvalId=randomUUID();await assert.rejects(f.adapter().create(f.args()),/OPERATION_EXISTS/);
 const before=writes(f).length;assert.equal((await f.adapter().reconcile(f.args())).state,'VERSION_VERIFIED');assert.equal(writes(f).length,before);
});
test('empty or ambiguous version list never authorizes retry',async()=>{
 for(const mode of ['emptyList','duplicateList']){const f=fixture();f.failCreate=true;await assert.rejects(f.adapter().create(f.args()));f[mode]=true;assert.equal((await f.adapter().reconcile(f.args())).state,'UNCERTAIN_NO_WRITE_RETRY');await assert.rejects(f.adapter().create(f.args()),/OPERATION_EXISTS/);}
});
for(const change of ['modules','bindings','assets'])test(`created ${change} mismatch cannot promote`,async()=>{
 const f=fixture();await f.adapter().create(f.args());
 if(change==='modules')f.created.modules[0].content_base64=Buffer.from('changed').toString('base64');
 else if(change==='bindings')f.created.bindings.pop();else f.created.assets.config.run_worker_first=false;
 await assert.rejects(f.adapter().reconcile(f.args()));await assert.rejects(f.adapter().promote(f.args()),/PROMOTION_NOT_READY/);
});
test('promotion ACK loss: no second write, exact GET confirms',async()=>{
 const f=fixture();await f.adapter().create(f.args());await f.adapter().reconcile(f.args());f.failPromote=true;
 await assert.rejects(f.adapter().promote(f.args()),/PROMOTION_STOPPED/);
 f.approval.approvalId=randomUUID();await assert.rejects(f.adapter().promote(f.args()),/PROMOTION_NOT_READY/);
 const count=writes(f).length;assert.equal((await f.adapter().reconcile(f.args())).state,'CONFIRMED');assert.equal(writes(f).length,count);
});
test('unconfirmed/moved traffic never becomes success or an automatic rollback',async()=>{
 const f=fixture();await f.adapter().create(f.args());await f.adapter().reconcile(f.args());await f.adapter().promote(f.args());f.active.versions[0].version_id=randomUUID();
 const count=writes(f).length;assert.equal((await f.adapter().reconcile(f.args())).state,'UNCERTAIN_NO_WRITE_RETRY');assert.equal(writes(f).length,count);
});
test('post-promotion settings drift is not success',async()=>{
 const f=fixture();await f.adapter().create(f.args());await f.adapter().reconcile(f.args());await f.adapter().promote(f.args());
 f.beforeRead=()=>{f.observation.workerSettingsDigest='a'.repeat(64);};await assert.rejects(f.adapter().reconcile(f.args()),/POST_PROMOTION_DRIFT/);assert.notEqual(rows(f).at(-1).state,'CONFIRMED');
});
test('two real processes and fresh process/new approval: only one mock version write',async()=>{
 const f=fixture(),first=child(f,'hold');assert.equal((await once(first,'message'))[0],'write-started');
 const second=child(f,'normal');assert.equal((await once(second,'message'))[0].state,'LOCAL_WRITER_LOCKED');await once(second,'exit');
 const firstDone=once(first,'message');first.send('continue');assert.equal((await firstDone)[0].state,'CREATE_STOPPED_RECONCILE_ONLY');await once(first,'exit');
 const restarted=child(f,'normal');assert.equal((await once(restarted,'message'))[0].state,'OPERATION_EXISTS_RECONCILE_ONLY');await once(restarted,'exit');
 assert.equal(readFileSync(join(f.directory,'mock-version-writes.log'),'utf8'),'one\n');
});
test('crash retains local lock; no stale timeout permits retransmission',async()=>{
 const f=fixture(),crashed=child(f,'crash');await once(crashed,'exit');
 assert.equal(existsSync(join(f.directory,operationKey(f.observation,f.package),'writer.lock')),true);
 const second=child(f,'normal');assert.equal((await once(second,'message'))[0].state,'LOCAL_WRITER_LOCKED');await once(second,'exit');
 assert.equal(readFileSync(join(f.directory,'mock-version-writes.log'),'utf8'),'one\n');
});
test('partial unpublished temp file is ignored; journal corruption fails closed',async()=>{
 const f=fixture();await f.adapter().create(f.args());const dir=join(f.directory,operationKey(f.observation,f.package));
 writeFileSync(join(dir,'interrupted.tmp'),'{bad');await f.adapter().reconcile(f.args());
 writeFileSync(join(dir,'000000.json'),'{bad');await assert.rejects(f.adapter().create(f.args()));
});
test('expiry after final observation await and journal persistence: no write',async()=>{
 const f=fixture();let checks=0;
 const adapter=offlineReleaseAdapter({directory:f.directory,transport:f.transport,readObservation:f.readObservation,now:()=>++checks<=4?NOW:NOW+900001});
 await assert.rejects(adapter.create(f.args()),/CREATE_STOPPED/);assert.equal(writes(f).length,0);assert.ok(checks>=5);
});
test('post-create module tampering does not open a second operation or promote',async()=>{
 const f=fixture();await f.adapter().create(f.args());const count=writes(f).length;
 f.package.modules[0].content_base64=Buffer.from('changed').toString('base64');
 await assert.rejects(f.adapter().create(f.args()),/PACKAGE_CHANGED/);await assert.rejects(f.adapter().promote(f.args()),/PACKAGE_CHANGED/);assert.equal(writes(f).length,count);
});
test('GET binding values never become durable journal data',async()=>{
 const f=fixture();await f.adapter().create(f.args());
 f.created.bindings=f.created.bindings.map(b=>b.type==='secret_text'||b.type==='plain_text'?{...b,text:'FAKE_PRIVATE_VALUE_DO_NOT_PERSIST'}:b);
 await f.adapter().reconcile(f.args());assert.doesNotMatch(JSON.stringify(rows(f)),/FAKE_PRIVATE_VALUE/);
});
test('read-only reconciliation remains possible after approval expires; writes do not',async()=>{
 const f=fixture();await f.adapter().create(f.args());await f.adapter().reconcile(f.args());f.failPromote=true;await assert.rejects(f.adapter().promote(f.args()));
 f.clock+=3600000;assert.equal((await f.adapter().reconcile(f.args())).state,'CONFIRMED');
 await assert.rejects(f.adapter().promote(f.args()));assert.equal(writes(f).length,3);
});
test('unexpected returned runtime configuration cannot be silently promoted',async()=>{
 const f=fixture();await f.adapter().create(f.args());f.created.limits={cpu_ms:500};
 await assert.rejects(f.adapter().reconcile(f.args()),/RUNTIME_FIELDS_UNREVIEWED/);await assert.rejects(f.adapter().promote(f.args()),/PROMOTION_NOT_READY/);
});
