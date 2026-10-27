import {mkdtempSync,appendFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {target,packageCandidate,observationDigest,offlineReleaseAdapter} from '../scripts/exact-version-release-proposal.mjs';
// Preserve the reviewed candidate across checkouts and shallow CI clones.
// Never substitute current HEAD assets for this historical contract.
const bundleRoot=new URL('./fixtures/release-reviewed-6c3f309/',import.meta.url);
const assetManifest=JSON.parse(readFileSync(new URL('ASSET_MANIFEST.json',bundleRoot),'utf8'));
const paths=Object.keys(assetManifest).sort().map(path=>'web/site'+path);
export const files=paths.map(path=>({path,bytes:readFileSync(new URL('source/'+path,bundleRoot))}));
export const NOW=Date.parse('2026-10-24T06:00:00.000Z');
export const versionId='11111111-2222-4333-8444-555555555555';
export const deploymentId='99999999-2222-4333-8444-555555555555';
export function fixture(directory=mkdtempSync(join(tmpdir(),'release-proposal-'))){
 const bindings=[['DB','d1'],['ACCESS_AUD','plain_text'],['ACCESS_TEAM_DOMAIN','plain_text'],['ACCESS_OWNER_EMAIL','secret_text'],['KEY_ENCRYPTION_KEY_B64','secret_text'],['ENABLE_LIVE_FREE','plain_text'],['ALLOW_PAID_API','plain_text'],['SITE_DEPLOYED','plain_text'],['ENABLE_PAID_SUMMARY','plain_text'],['PAID_SUMMARY_EXECUTION_APPROVED','plain_text'],['PAID_FIRST_GENERATION_TRIAL_ENABLED','plain_text'],['PAID_FIRST_TRIAL_USD_COST_REVIEWED','plain_text'],['ENABLE_GEMINI_TWO_PASS','secret_text'],['GEMINI_TWO_PASS_ALLOWED_JOB_ID','secret_text'],['GEMINI_LEGACY_QUOTE_RECOVERY_JSON','plain_text'],['ASSETS','assets']].map(([name,type])=>name==='DB'?{name,type,id:target.databaseId}:{name,type});
 const pkg=packageCandidate({files,modules:[{name:'worker.js',content_type:'application/javascript+module',content_base64:Buffer.from('// SYNTHETIC FIXTURE, NOT THE PRODUCTION BUNDLE\nexport default {};').toString('base64')}],main_module:'worker.js'});
 const observation={accountId:target.accountId,worker:{id:'a'.repeat(32),name:target.workerName},apiCompatibility:'EXACT_VERSION_INHERIT_CONFIRMED',compatibilityEvidenceDigest:'1'.repeat(64),observedAt:new Date(NOW).toISOString(),activeDeployment:{id:'00000000-2222-4333-8444-555555555555',versions:[{version_id:target.baselineVersionId,percentage:100}]},version:{id:target.baselineVersionId,bindings,compatibility_date:'2026-10-10',compatibility_flags:[],assets:{config:{run_worker_first:true}},unsupportedFields:[]},workerSettingsDigest:'2'.repeat(64),masterFalseWriteEvidenceDigest:'3'.repeat(64),singleWriter:{confirmed:true,windowId:'44444444-2222-4333-8444-555555555555',startsAt:new Date(NOW-1000).toISOString(),expiresAt:new Date(NOW+900000).toISOString(),evidenceDigest:'4'.repeat(64)}};
 const approval={approvalId:randomUUID(),reviewedAt:new Date(NOW).toISOString(),expiresAt:new Date(NOW+600000).toISOString(),ownerEvidenceDigest:'5'.repeat(64),independentReviewDigest:'6'.repeat(64),observationDigest:observationDigest(observation),moduleDigest:pkg.moduleDigest,assetDigest:target.assetDigest,intent:'REPLACE_REVIEWED_CODE_AND_ASSETS_KEEP_BASELINE_BINDINGS',maxVersionCreates:1,maxPromotions:1,automaticRetries:0};
 const f={directory,observation,approval,package:pkg,clock:NOW,calls:[],created:null,active:null,failCreate:false,failPromote:false,emptyList:false,duplicateList:false,buckets:null,beforeRequest:null,beforeRead:null};
 f.transport={mode:'OFFLINE_FIXTURE_ONLY',async request(r){
  f.calls.push(r);if(f.beforeRequest)await f.beforeRequest(r);
  if(r.method==='POST'&&r.path.endsWith('/assets-upload-session'))return {success:true,result:{jwt:'MOCK_UPLOAD_OR_COMPLETION_TOKEN',buckets:f.buckets??[]}};
  if(r.method==='POST'&&r.path.endsWith('/assets/upload'))return {success:true,result:{jwt:'MOCK_FINAL_COMPLETION_TOKEN'}};
  if(r.method==='POST'&&r.path.endsWith('/versions')){f.created={...structuredClone(r.body),id:versionId,bindings:structuredClone(observation.version.bindings)};if(f.failCreate)throw Error('MOCK_LOST_ACK');return {success:true,result:{id:versionId,annotations:r.body.annotations}};}
  if(r.method==='GET'&&r.path.endsWith('/versions')){const found=f.emptyList?[]:f.duplicateList?[f.created,{...f.created,id:deploymentId}]:f.created?[f.created]:[];return {success:true,result:found,result_info:{page:1,per_page:100,count:found.length,total_count:found.length,total_pages:1}};}
  if(r.method==='GET'&&r.path.endsWith('/versions/'+versionId))return {success:true,result:f.created};
  if(r.method==='POST'&&r.path.endsWith('/deployments')){f.active={...r.body,id:deploymentId};if(f.failPromote)throw Error('MOCK_LOST_ACK');return {success:true,result:f.active};}
  if(r.method==='GET'&&r.path.endsWith('/deployments'))return {success:true,result:{deployments:f.active?[f.active]:[]}};
  throw Error('UNEXPECTED_FIXTURE_REQUEST');
 }};
 f.readObservation=async()=>{if(f.beforeRead)await f.beforeRead();const o=structuredClone(f.observation);o.observedAt=new Date(f.clock).toISOString();if(f.active)o.activeDeployment={id:f.active.id,versions:f.active.versions};return o;};
 f.adapter=()=>offlineReleaseAdapter({directory,transport:f.transport,readObservation:f.readObservation,now:()=>f.clock});
 f.args=()=>({observation:f.observation,approval:f.approval,package:f.package});return f;
}

// Real separate Node processes, mock remote calls only. No shell/network.
if(process.argv[2]==='child'){
 const f=fixture(process.argv[3]),mode=process.argv[4];
 f.beforeRequest=async r=>{
  if(r.method==='POST'&&r.path.endsWith('/versions')){
   appendFileSync(join(f.directory,'mock-version-writes.log'),'one\n');
   if(mode==='hold'){process.send('write-started');await new Promise(resolve=>process.once('message',resolve));throw Error('MOCK_ACK_LOSS');}
   if(mode==='crash')process.exit(0);
  }
 };
 try{await f.adapter().create(f.args());process.send({state:'CREATED'});}catch(e){process.send({state:e.message});}
}
