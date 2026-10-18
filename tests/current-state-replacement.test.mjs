import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {approvedRemoteBaseline} from '../scripts/remote-state-policy.mjs';
import {assertRemoteDeploymentBaseline} from '../scripts/read-remote-state.mjs';
import {verifyPostDeploy} from '../scripts/post-deploy-verification.mjs';
import {assertCurrentStateReplacementPreflight,assertCurrentStateReplacementPostPreservation,assertReplacementConfig,assetManifestDigest,canonicalEvidence,currentStateReplacementApproval,remoteStateFingerprint} from '../scripts/current-state-replacement.mjs';

const pin={accountId:'fe9d7e2a164274b1ff6cef150a75cb0b',workerName:'holy-rice-b914',databaseId:'d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34',activeVersionId:'a1aa62cf-1ecb-4f51-9cd9-c8823f4e2167',priorVersionId:'283c647e-8618-4c9d-9c66-450deebee143',scriptEtag:'281ae5cbbe50917708f3c6a81616c89e23f5c416651a88495c7b013438857b6f',sourceCommit:'60272937664175cb2c124999cd780f8a5237d9ab'};
const head='b'.repeat(40),assetDigest='c'.repeat(64),hash=value=>createHash('sha256').update(value).digest('hex');
const updateRecord=JSON.stringify({kind:'APPROVED_SCOPE_UPDATE_REVIEW_V1',accountId:pin.accountId,workerName:pin.workerName,activeVersionId:pin.activeVersionId,scopeValueEquality:'UNVERIFIED',evidenceId:'approved-change-20261018',reviewedAt:new Date(Date.now()-5000).toISOString(),changeKind:'Updated secret: GROQ_LEGACY_RECOVERY_SCOPE_JSON',ownerDiagnosticEvidenceId:'owner-diagnostic-20261018'});
const ownerRecord=JSON.stringify({kind:'OWNER_SCOPE_DIAGNOSTIC_REVIEW_V1',accountId:pin.accountId,workerName:pin.workerName,activeVersionId:pin.activeVersionId,scopeValueEquality:'UNVERIFIED',evidenceId:'owner-diagnostic-20261018',reviewedAt:new Date(Date.now()-1000).toISOString(),ownerAccessVerified:true,scopeBindingStatus:'PRESENT'});
const state=()=>({workerName:pin.workerName,environment:'production',workerTag:'tag',activeVersions:[{id:pin.activeVersionId,percentage:100}],deploymentMessage:'Dashboard settings update',workersDev:true,previewUrls:false,routes:[],domains:[],compatibilityDate:'2026-10-10',compatibilityFlagsPresent:false,compatibilityFlags:undefined,observability:structuredClone(approvedRemoteBaseline.observability),optionalScriptFields:structuredClone(approvedRemoteBaseline.optionalScriptFields),scriptSettings:structuredClone(approvedRemoteBaseline.scriptSettings),bindings:[
 {name:'DB',type:'d1',id:pin.databaseId},{name:'ASSETS',type:'assets'},
 {name:'ACCESS_AUD',type:'plain_text',text:'test-audience-value'},{name:'ACCESS_TEAM_DOMAIN',type:'plain_text',text:'https://test.cloudflareaccess.com'},
 ...['ACCESS_OWNER_EMAIL','KEY_ENCRYPTION_KEY_B64','ENABLE_GEMINI_TWO_PASS','GEMINI_TWO_PASS_ALLOWED_JOB_ID','GROQ_LEGACY_RECOVERY_SCOPE_JSON'].map(name=>({name,type:'secret_text'})),
 ...Object.entries(approvedRemoteBaseline.runtimeFlags).map(([name,text])=>({name,type:'plain_text',text})),
 {name:'GEMINI_LEGACY_QUOTE_RECOVERY_JSON',type:'plain_text',text:'PRIVATE_SETTING'},
]});
const approval=(remote=state())=>({kind:'CURRENT_STATE_SOURCE_REPLACEMENT_V1',intent:'REPLACE_REVIEWED_ACTIVE_CODE_AND_ASSETS',...pin,reviewedCommitSha:head,remoteFingerprint:remoteStateFingerprint(remote),assetManifestDigest:assetDigest,ownerDiagnosticDigest:hash(ownerRecord),approvedScopeUpdateDigest:hash(updateRecord),scopeValueEquality:'UNVERIFIED',reviewedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()});
const env=value=>({GROQ_CURRENT_STATE_REPLACEMENT_JSON:JSON.stringify(value),GROQ_OWNER_DIAGNOSTIC_RECORD_JSON:ownerRecord,GROQ_APPROVED_SCOPE_UPDATE_RECORD_JSON:updateRecord,GROQ_TRUSTED_OWNER_DIAGNOSTIC_SHA256:hash(ownerRecord),GROQ_TRUSTED_SCOPE_UPDATE_SHA256:hash(updateRecord)});
const lineage=()=>({activeVersionId:pin.activeVersionId,priorVersionId:pin.priorVersionId,priorDeploymentSourceAnnotation:'EXPECTED',priorDeploymentSource:'WRANGLER',activeDeploymentSource:'DASHBOARD',scriptEtagMatchesPinned:true,scriptContentEqual:true,runtimeMetadataComplete:true,runtimeMetadataEqual:true,activeAssetsBindingCount:1,priorAssetsBindingCount:1,knownBindingAddition:false,assetSetIdentifier:'NOT_EXPOSED_BY_VERSION_GET'});
const check=(remote=state(),a=approval(remote),report=lineage(),options={head,buildSha:head,manifestDigest:assetDigest})=>assertCurrentStateReplacementPreflight(remote,currentStateReplacementApproval(env(a)),report,options);

test('replacement approval pins intent, target, commit, record review and 24-hour expiry',()=>{
 const a=approval();assert.equal(currentStateReplacementApproval(env(a)).activeVersionId,pin.activeVersionId);
 assert.throws(()=>currentStateReplacementApproval({}),/APPROVAL_UNAVAILABLE/);
 for(const changed of [{kind:'OTHER'},{intent:'IGNORE_SOURCE'},{activeVersionId:'other'},{databaseId:'other'},{reviewedCommitSha:'other'},{scopeValueEquality:'EQUAL'},{ownerDiagnosticDigest:'bad'},{extra:true}])assert.throws(()=>currentStateReplacementApproval(env({...a,...changed})));
 assert.throws(()=>currentStateReplacementApproval(env({...a,expiresAt:new Date(Date.now()-1000).toISOString()})),/APPROVAL_EXPIRED/);
 assert.throws(()=>currentStateReplacementApproval(env({...a,expiresAt:new Date(Date.now()+25*3600000).toISOString()})),/APPROVAL_EXPIRED/);
 assert.throws(()=>currentStateReplacementApproval({...env(a),GROQ_OWNER_DIAGNOSTIC_RECORD_JSON:undefined}),/SCOPE_REVIEW_RECORD_UNAVAILABLE/);
 assert.throws(()=>currentStateReplacementApproval({...env(a),GROQ_TRUSTED_OWNER_DIAGNOSTIC_SHA256:'d'.repeat(64)}),/SCOPE_REVIEW_RECORD_MISMATCH/);
 assert.throws(()=>currentStateReplacementApproval(env({...a,ownerDiagnosticDigest:'d'.repeat(64)})),/SCOPE_REVIEW_RECORD_MISMATCH/);
 assert.throws(()=>currentStateReplacementApproval({...env(a),GROQ_APPROVED_SCOPE_UPDATE_RECORD_JSON:'{}'}),/SCOPE_REVIEW_RECORD_MISMATCH/);
 const forged=JSON.stringify({...JSON.parse(ownerRecord),ownerAccessVerified:false});
 assert.throws(()=>currentStateReplacementApproval({...env({...a,ownerDiagnosticDigest:hash(forged)}),GROQ_OWNER_DIAGNOSTIC_RECORD_JSON:forged,GROQ_TRUSTED_OWNER_DIAGNOSTIC_SHA256:hash(forged)}),/SCOPE_REVIEW_RECORD_INVALID/);
});

test('canonical fingerprint distinguishes omission, undefined, null and empty values',()=>{
 const values=[{}, {x:undefined},{x:null},{x:''},{x:[]},{x:{}}];
 assert.equal(new Set(values.map(remoteStateFingerprint)).size,values.length);
 assert.deepEqual(canonicalEvidence({b:1,a:2}),canonicalEvidence({a:2,b:1}));
});

test('replacement uploads exactly the reviewed asset directory before owner auth and adds no production vars',()=>{
 const config=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8');
 assert.equal(assertReplacementConfig(config),true);
 for(const changed of [config.replace('directory = "./web/site"','directory = "./other"'),config.replace('run_worker_first = true','run_worker_first = false'),config.replace('[vars]','[vars]\nENABLE_PAID_SUMMARY = "false"')])assert.throws(()=>assertReplacementConfig(changed));
});

test('replacement accepts reviewed current state without claiming historical binding or asset equality',()=>{
 assert.equal(check(),true);
 for(const [key,value] of [['runtimeMetadataComplete',false],['scriptEtagMatchesPinned',false],['priorVersionId','other'],['priorDeploymentSourceAnnotation','OTHER'],['activeAssetsBindingCount',0]])assert.throws(()=>check(state(),approval(),{...lineage(),[key]:value}),/VERSION_EVIDENCE_MISMATCH/);
 for(const options of [{head:'a'.repeat(40),buildSha:head,manifestDigest:assetDigest},{head,buildSha:'a'.repeat(40),manifestDigest:assetDigest},{head,buildSha:head,manifestDigest:'e'.repeat(64)}])assert.throws(()=>check(state(),approval(),lineage(),options));
});

test('active version, metadata, bindings, D1, Access and paid flags drift all block',()=>{
 for(const mutate of [
  x=>{x.activeVersions[0].id='other';},x=>{x.activeVersions[0].percentage=99;},
  x=>{x.routes.push({pattern:'other'});},x=>{x.observability.enabled=false;},
  x=>{x.bindings.find(v=>v.name==='DB').id='other';},
  x=>{x.bindings.find(v=>v.name==='ACCESS_AUD').text='';},
  x=>{x.bindings.find(v=>v.name==='ALLOW_PAID_API').text='true';},
  x=>{x.bindings.find(v=>v.name==='GROQ_LEGACY_RECOVERY_SCOPE_JSON').type='plain_text';},
  x=>{x.bindings.find(v=>v.name==='GEMINI_LEGACY_QUOTE_RECOVERY_JSON').text='changed';},
 ]){const x=state();mutate(x);assert.throws(()=>check(x,approval()),/Remote deployment guard|REMOTE_FINGERPRINT_MISMATCH/);}
});

test('postcheck permits only new version, source annotation and ASSETS opaque identity',()=>{
 const before=state(),after=state();after.activeVersions=[{id:'44444444-4444-4444-8444-444444444444',percentage:100}];after.deploymentMessage=`source-commit:${head}`;after.bindings.find(x=>x.name==='ASSETS').asset_id='new-set';
 assert.equal(assertCurrentStateReplacementPostPreservation(before,after),true);
 after.bindings.find(x=>x.name==='GROQ_LEGACY_RECOVERY_SCOPE_JSON').revision='different';
 assert.throws(()=>assertCurrentStateReplacementPostPreservation(before,after),/POST_SETTINGS_OR_BINDINGS_CHANGED/);
});

test('real post-deploy path requires two checks, the new version and actual HEAD annotation',async()=>{
 const before=state(),a=approval(before),baseline=currentStateReplacementApproval(env(a));
 const deployed={versionId:'44444444-4444-4444-8444-444444444444',sourceCommit:head};
 const after=state();after.activeVersions=[{id:deployed.versionId,percentage:100}];after.deploymentMessage=`source-commit:${head}`;
 let reads=0;
 const options={token:'MOCK',ciMatchTag:'tag',deployed,before,baseline,read:async()=>{reads++;return structuredClone(after);}};
 assert.deepEqual(JSON.parse(await verifyPostDeploy(options)),{activeVersionId:deployed.versionId,sourceCommit:head});
 assert.equal(reads,2);
 reads=0;
 await assert.rejects(verifyPostDeploy({...options,read:async()=>{reads++;const x=structuredClone(after);if(reads===2)x.bindings.find(v=>v.name==='ACCESS_TEAM_DOMAIN').text='https://changed.cloudflareaccess.com';return x;}}),/DEPLOYED_UNVERIFIED: POST_SETTINGS_OR_BINDINGS_CHANGED/);
 assert.equal(reads,2);
 await assert.rejects(verifyPostDeploy({...options,read:async()=>({...after,deploymentMessage:'old-source'})}),/DEPLOYED_UNVERIFIED: POST_DEPLOY_VERSION_MISMATCH/);
});

test('complete asset manifest blocks added tracked drift, untracked assets and missing files',()=>{
 const root=mkdtempSync(join(tmpdir(),'replacement-assets-'));
 try{
  execFileSync('git',['init'],{cwd:root,stdio:'ignore'});mkdirSync(join(root,'web/site'),{recursive:true});writeFileSync(join(root,'web/site/index.html'),'one');
  execFileSync('git',['add','web/site/index.html'],{cwd:root});execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture'],{cwd:root,stdio:'ignore'});
  const first=assetManifestDigest(root);assert.match(first,/^[0-9a-f]{64}$/);
  writeFileSync(join(root,'web/site/extra.txt'),'extra');assert.throws(()=>assetManifestDigest(root),/ASSET_SET_UNTRACKED_OR_EMPTY/);
  rmSync(join(root,'web/site/extra.txt'));
  writeFileSync(join(root,'.gitignore'),'web/site/ignored.txt\n');execFileSync('git',['add','.gitignore'],{cwd:root});execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','ignore fixture'],{cwd:root,stdio:'ignore'});
  writeFileSync(join(root,'web/site/ignored.txt'),'ignored');assert.throws(()=>assetManifestDigest(root),/ASSET_SET_UNTRACKED_OR_EMPTY/);
  rmSync(join(root,'web/site/ignored.txt'));writeFileSync(join(root,'web/site/index.html'),'two');assert.throws(()=>assetManifestDigest(root),/WORKTREE_CHANGED/);
  rmSync(join(root,'web/site/index.html'));assert.throws(()=>assetManifestDigest(root));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('both preflight rounds are required; second-round drift and expiry block',async()=>{
 const original=state(),a=approval(original),e=env(a),baseline=currentStateReplacementApproval(e);let rounds=0,driftOnSecond=true,expireOnVersionRead=false;
 const fetcher=async(url)=>{
  const version=id=>({id,resources:{script:{etag:pin.scriptEtag},script_runtime:{compatibility_date:'2026-10-10',usage_model:'standard'},bindings:[{name:'ASSETS',type:'assets'}]}});
  let result;
  if(url.endsWith('/workers/services/'+pin.workerName)){rounds++;result={default_environment:{environment:'production',script:{tag:'tag'}}};}
  else if(url.endsWith('/environments/production'))result={script:{compatibility_date:'2026-10-10',observability:original.observability}};
  else if(url.endsWith('/bindings'))result=structuredClone(original.bindings);
  else if(url.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
  else if(url.includes('/routes?')||url.includes('/workers/domains/records?'))result=[];
  else if(url.endsWith('/script-settings'))result=original.scriptSettings;
  else if(url.endsWith('/deployments?per_page=100'))result={deployments:[{source:'dash',versions:[{version_id:pin.activeVersionId,percentage:100}],annotations:{'workers/message':'updated'}},{source:'wrangler',versions:[{version_id:pin.priorVersionId,percentage:100}],annotations:{'workers/message':`source-commit:${pin.sourceCommit}`}}]};
  else if(url.endsWith('/deployments'))result={deployments:[{versions:[{version_id:driftOnSecond&&rounds===2?'other':pin.activeVersionId,percentage:100}],annotations:{'workers/message':original.deploymentMessage}}]};
  else if(url.endsWith('/versions/'+pin.activeVersionId))result=version(pin.activeVersionId);
  else if(url.endsWith('/versions/'+pin.priorVersionId)){
   result=version(pin.priorVersionId);
   if(expireOnVersionRead)e.GROQ_CURRENT_STATE_REPLACEMENT_JSON=JSON.stringify({...a,expiresAt:new Date(Date.now()-1000).toISOString()});
  }
  else throw Error('unexpected request');
  return {ok:true,json:async()=>({success:true,result})};
 };
 const options={token:'MOCK',fetcher,baseline,env:e,head,buildSha:head,manifestDigest:assetDigest,ciMatchTag:'tag'};
 await assert.rejects(assertRemoteDeploymentBaseline(options),/ACTIVE_VERSION_MISMATCH/);
 assert.equal(rounds,2);
 rounds=0;driftOnSecond=false;
 assert.equal((await assertRemoteDeploymentBaseline(options)).activeVersions[0].id,pin.activeVersionId);
 assert.equal(rounds,2);
 rounds=0;expireOnVersionRead=true;
 await assert.rejects(assertRemoteDeploymentBaseline(options),/APPROVAL_EXPIRED/);
 assert.equal(rounds,1);
});

 test('replacement requires actual scope secret presence even with a matching approved fingerprint',()=>{
 const remote=state();
 remote.bindings=remote.bindings.filter(binding=>binding.name!=='GROQ_LEGACY_RECOVERY_SCOPE_JSON');
 assert.throws(()=>check(remote,approval(remote)),/SCOPE_BINDING_UNAVAILABLE/);
 });
