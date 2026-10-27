import test from 'node:test';
import assert from 'node:assert/strict';
import {captureFormat,projectReleaseObservation} from '../scripts/release-observation-projection.mjs';
import {target,validateObservation} from '../scripts/exact-version-release-proposal.mjs';

// All captures and evidence below are SYNTHETIC. No production collection occurred.
const NOW=Date.parse('2026-10-27T00:00:30.000Z');
const workerId='a'.repeat(32),deploymentId='11111111-2222-4333-8444-555555555555';
const stamp=n=>new Date(NOW+n).toISOString();
const pairs=[['DB','d1'],['ACCESS_AUD','plain_text'],['ACCESS_TEAM_DOMAIN','plain_text'],['ACCESS_OWNER_EMAIL','secret_text'],['KEY_ENCRYPTION_KEY_B64','secret_text'],['ENABLE_LIVE_FREE','plain_text'],['ALLOW_PAID_API','plain_text'],['SITE_DEPLOYED','plain_text'],['ENABLE_PAID_SUMMARY','plain_text'],['PAID_SUMMARY_EXECUTION_APPROVED','plain_text'],['PAID_FIRST_GENERATION_TRIAL_ENABLED','plain_text'],['PAID_FIRST_TRIAL_USD_COST_REVIEWED','plain_text'],['ENABLE_GEMINI_TWO_PASS','secret_text'],['GEMINI_TWO_PASS_ALLOWED_JOB_ID','secret_text'],['GEMINI_LEGACY_QUOTE_RECOVERY_JSON','plain_text'],['ASSETS','assets']];
function fixture(){
 const root=`/accounts/${target.accountId}/workers`;
 const capture=(path,result,query={})=>({request:{method:'GET',path,query},startedAt:stamp(-1000),completedAt:stamp(-500),response:{success:true,errors:[],messages:[],result}});
 const bindings=pairs.map(([name,type])=>({name,type,...(type==='d1'?{database_id:target.databaseId}:type==='plain_text'?{text:'SYNTHETIC_PRIVATE_PLAIN_VALUE'}:{})}));
 return {now:NOW,captures:{format:captureFormat,accountId:target.accountId,
  worker:capture(`${root}/workers/${target.workerName}`,{id:workerId,name:target.workerName,created_on:stamp(-100000),updated_on:stamp(-50000),logpush:false,
   observability:{enabled:true,head_sampling_rate:1,redact_query_string:false,logs:{enabled:true,head_sampling_rate:1,invocation_logs:true,persist:true},traces:{enabled:false,head_sampling_rate:1,persist:true}},
   references:{dispatch_namespace_outbounds:[],domains:[],durable_objects:[],queues:[],workers:[]},subdomain:{enabled:true,previews_enabled:false},tags:[],tail_consumers:[]}),
  deployments:capture(`${root}/scripts/${target.workerName}/deployments`,{deployments:[{id:deploymentId,created_on:stamp(-50000),source:'api',strategy:'percentage',versions:[{version_id:target.baselineVersionId,percentage:100}]}]},{page:1,per_page:1}),
  version:capture(`${root}/workers/${workerId}/versions/${target.baselineVersionId}`,{id:target.baselineVersionId,created_on:stamp(-100000),number:4,urls:[],bindings,compatibility_date:'2026-10-10',compatibility_flags:[],assets:{config:{run_worker_first:true}}}),
  omittedSecretTextBindings:pairs.filter(([,type])=>type==='secret_text').map(([name])=>name)},
  externalEvidence:{scope:{accountId:target.accountId,workerId,workerName:target.workerName,baselineVersionId:target.baselineVersionId,activeDeploymentId:deploymentId},apiCompatibility:'EXACT_VERSION_INHERIT_CONFIRMED',compatibilityEvidenceDigest:'1'.repeat(64),masterFalseWriteEvidenceDigest:'2'.repeat(64),nonSecretCaptureReviewEvidenceDigest:'3'.repeat(64),singleWriter:{confirmed:true,windowId:'44444444-2222-4333-8444-555555555555',startsAt:stamp(-10000),expiresAt:stamp(60000),evidenceDigest:'4'.repeat(64)}}};
}
const result=f=>f.captures.version.response.result;
const project=f=>projectReleaseObservation(f);

test('explicit supplied captures produce only an offline projection and retain unresolved gates',()=>{
 const f=fixture(),before=structuredClone(f),out=project(f);
 assert.equal(out.productionExecutionSupported,false);assert.equal(out.provenanceAuthenticated,false);assert.equal(out.permissionVerified,false);
 assert.equal(validateObservation(out.offlineObservation,NOW),true);
 assert.deepEqual(out.offlineObservation.worker,{id:workerId,name:target.workerName});
 assert.equal(out.offlineObservation.activeDeployment.id,deploymentId);
 assert.equal(out.offlineObservation.version.bindings.find(b=>b.name==='DB').id,target.databaseId);
 assert.deepEqual(out.offlineObservation.singleWriter,f.externalEvidence.singleWriter);
 assert.equal(out.offlineObservation.masterFalseWriteEvidenceDigest,f.externalEvidence.masterFalseWriteEvidenceDigest);
 assert.ok(out.unresolvedGates.includes('VALUE_FREE_VERSION_RESPONSE_BEHAVIOR_NOT_ESTABLISHED'));
 assert.ok(out.unresolvedGates.includes('ROUTES_ACCESS_AND_BUILD_SETTINGS_NOT_CAPTURED'));
 assert.doesNotMatch(JSON.stringify(out),/SYNTHETIC_PRIVATE_PLAIN_VALUE|"text":/);
 assert.deepEqual(f,before);
 out.offlineObservation.singleWriter.confirmed=false;
 assert.equal(f.externalEvidence.singleWriter.confirmed,true);
});

test('collection freshness uses earliest start; a late completion cannot refresh an older read',()=>{
 const f=fixture();f.captures.worker.startedAt=stamp(-5000);
 assert.equal(project(f).offlineObservation.observedAt,stamp(-5000));
 f.captures.worker.startedAt=stamp(-60001);f.externalEvidence.singleWriter.startsAt=stamp(-70000);
 assert.throws(()=>project(f),/RELEASE_CAPTURE_COLLECTION_STALE/);
});

for(const [label,info] of [
 ['zero counts with one returned deployment',{page:1,per_page:1,count:0,total_count:0,total_pages:0}],
 ['count and totals contradict the one-item page',{page:1,per_page:1,count:2,total_count:1,total_pages:2}],
 ['totals contradict fixed per_page one',{count:1,total_count:2,total_pages:3}],
 ['zero total_count without total_pages',{count:1,total_count:0}],
 ['zero total_pages without total_count',{count:1,total_pages:0}],
])test(`deployment pagination rejects ${label}`,()=>{
 const f=fixture();f.captures.deployments.response.result_info=info;
 assert.throws(()=>project(f),/^Error: RELEASE_CAPTURE_PAGINATION_UNSUPPORTED$/);
});

test('deployment pagination accepts consistent present fields without manufacturing absent ones',()=>{
 for(const info of [undefined,{}, {count:1},{total_count:1},{total_pages:1},{page:1,per_page:1,count:1,total_count:2,total_pages:2}]){
  const f=fixture();if(info!==undefined)f.captures.deployments.response.result_info=structuredClone(info);
  const before=structuredClone(f.captures.deployments.response);
  assert.equal(project(f).offlineObservation.activeDeployment.id,deploymentId);
  assert.deepEqual(f.captures.deployments.response,before);
 }
});

for(const [name,change,code] of [
 ['pre-window start with post-window completion',f=>{f.captures.worker.startedAt=stamp(-10001);},'COLLECTION_OUTSIDE_WRITER_WINDOW'],
 ['future completion',f=>{f.captures.version.completedAt=stamp(1);},'COLLECTION_STALE'],
 ['reversed capture interval',f=>{f.captures.version.completedAt=stamp(-2000);},'COLLECTION_STALE'],
 ['expired writer window',f=>{f.externalEvidence.singleWriter.expiresAt=stamp(0);},'WRITER_EVIDENCE_REQUIRED'],
 ['missing writer evidence',f=>{delete f.externalEvidence.singleWriter.evidenceDigest;},'WRITER_EVIDENCE_REQUIRED'],
 ['missing OFF evidence',f=>{delete f.externalEvidence.masterFalseWriteEvidenceDigest;},'EXTERNAL_EVIDENCE_REQUIRED'],
 ['unknown account',f=>{f.captures.accountId='f'.repeat(32);},'CAPTURE_FORMAT_OR_ACCOUNT_INVALID'],
 ['worker identity mismatch',f=>{f.captures.worker.response.result.id='b'.repeat(32);},'WORKER_IDENTITY_MISMATCH'],
 ['deployment ABA',f=>{f.captures.deployments.response.result.deployments[0].id='99999999-2222-4333-8444-555555555555';},'DEPLOYMENT_EVIDENCE_MISMATCH'],
 ['wrong baseline',f=>{result(f).id=deploymentId;},'VERSION_SETTINGS_UNSUPPORTED'],
 ['latest alias request',f=>{f.captures.version.request.path=f.captures.version.request.path.replace(target.baselineVersionId,'latest');},'REQUEST_TARGET_MISMATCH'],
 ['time-filtered deployment list',f=>{f.captures.deployments.request.query.since=stamp(-100000);},'REQUEST_TARGET_MISMATCH'],
 ['page two',f=>{f.captures.deployments.request.query.page=2;},'REQUEST_TARGET_MISMATCH'],
 ['split active traffic',f=>{f.captures.deployments.response.result.deployments[0].versions.push({version_id:deploymentId,percentage:1});},'BASELINE_NOT_ACTIVE'],
 ['missing compatibility flags',f=>{delete result(f).compatibility_flags;},'VERSION_SETTINGS_UNSUPPORTED'],
 ['null compatibility flags',f=>{result(f).compatibility_flags=null;},'VERSION_SETTINGS_UNSUPPORTED'],
 ['unknown runtime setting',f=>{result(f).new_runtime_setting={};},'VERSION_SETTINGS_UNSUPPORTED'],
 ['known but unreviewed placement',f=>{result(f).placement={mode:'smart'};},'VERSION_SETTINGS_UNSUPPORTED'],
 ['asset base path even slash',f=>{result(f).assets.config.base_path='/';},'ASSET_SETTINGS_UNSUPPORTED'],
 ['missing log setting',f=>{delete f.captures.worker.response.result.observability.logs.persist;},'SCHEMA_UNSUPPORTED'],
 ['unknown nested setting',f=>{f.captures.worker.response.result.observability.logs.new_setting=true;},'SCHEMA_UNSUPPORTED'],
 ['missing previews flag',f=>{delete f.captures.worker.response.result.subdomain.previews_enabled;},'WORKER_SETTINGS_INCOMPLETE'],
 ['unknown worker setting',f=>{f.captures.worker.response.result.previews_base_config={};},'WORKER_SETTINGS_INCOMPLETE'],
 ['unreviewed reference',f=>{f.captures.worker.response.result.references.domains.push({id:'x'});},'WORKER_REFERENCES_UNREVIEWED'],
 ['incomplete binding inventory',f=>{result(f).bindings.pop();},'EXISTING_OBSERVATION_GUARD_REJECTED'],
 ['missing plain value',f=>{delete result(f).bindings.find(b=>b.type==='plain_text').text;},'PLAIN_BINDING_VALUE_MISSING'],
 ['D1 legacy-only identifier',f=>{const b=result(f).bindings[0];b.id=b.database_id;delete b.database_id;},'D1_IDENTIFIER_INVALID'],
 ['D1 conflicting identifiers',f=>{result(f).bindings[0].id=deploymentId;},'D1_IDENTIFIER_INVALID'],
 ['unlisted secret text omission',f=>{f.captures.omittedSecretTextBindings.pop();},'SECRET_OMISSIONS_UNACCOUNTED'],
 ['claimed omission of plain value',f=>{f.captures.omittedSecretTextBindings.push('ACCESS_AUD');},'SECRET_OMISSIONS_UNACCOUNTED'],
])test(`${name}: fail closed`,()=>{const f=fixture();change(f);assert.throws(()=>project(f),new RegExp('^Error: RELEASE_CAPTURE_'+code+'$'));});

test('secret values and upload JWTs are refused even when masked, empty or null',()=>{
 for(const value of ['DO_NOT_ECHO_SECRET','***','',null]){
  const f=fixture();result(f).bindings.find(b=>b.type==='secret_text').text=value;
  assert.throws(()=>project(f),error=>error.message==='RELEASE_CAPTURE_SECRET_VALUE_INPUT'&&!error.message.includes('DO_NOT_ECHO'));
 }
 const f=fixture();result(f).assets.jwt='DO_NOT_ECHO_JWT';
 assert.throws(()=>project(f),/^Error: RELEASE_CAPTURE_SECRET_VALUE_INPUT$/);
});

test('unknown input and remote errors cannot leak private strings in thrown errors',()=>{
 for(const change of [
  f=>{f.captures.version.response.errors=[{code:1000,message:'DO_NOT_ECHO_PRIVATE'}];},
  f=>{f.captures.version.response.result.private_unknown='DO_NOT_ECHO_PRIVATE';},
  f=>{Object.defineProperty(f.captures.version.response,'result',{get(){throw Error('DO_NOT_ECHO_PRIVATE');},enumerable:true});},
 ]){const f=fixture();change(f);assert.throws(()=>project(f),error=>/^RELEASE_CAPTURE_[A-Z_]+$/.test(error.message)&&!error.stack.includes('DO_NOT_ECHO_PRIVATE'));}
});

test('settings digest is derived from captures and preserves optional field presence',()=>{
 const f=fixture(),one=project(f).offlineObservation.workerSettingsDigest;
 f.captures.worker.response.result.subdomain.url='https://example.workers.dev';
 const two=project(f).offlineObservation.workerSettingsDigest;assert.notEqual(one,two);
 f.captures.worker.response.result.observability.traces.propagation_policy=null;
 assert.notEqual(two,project(f).offlineObservation.workerSettingsDigest);
});

test('no network use and no authentication is implied by a correctly shaped evidence digest',()=>{
 const before=globalThis.fetch;globalThis.fetch=()=>{throw Error('NETWORK_MUST_NOT_RUN');};
 try{const f=fixture();f.externalEvidence.masterFalseWriteEvidenceDigest='f'.repeat(64);const out=project(f);assert.equal(out.provenanceAuthenticated,false);assert.equal(out.productionExecutionSupported,false);assert.ok(out.unresolvedGates.includes('EXTERNAL_EVIDENCE_CONTENT_NOT_VERIFIED'));}
 finally{globalThis.fetch=before;}
});
