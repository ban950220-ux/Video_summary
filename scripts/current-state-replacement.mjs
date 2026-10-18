// Single-use, reviewed current-state replacement proposal. This does not
// establish equality with the historical asset set or secret values.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,readdirSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';
import {approvedRemoteBaseline,assertRemoteState,legacyGroqRecoveryScopeBinding} from './remote-state-policy.mjs';

const pinned={
 accountId:'fe9d7e2a164274b1ff6cef150a75cb0b',workerName:'holy-rice-b914',
 databaseId:'d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34',
 activeVersionId:'a1aa62cf-1ecb-4f51-9cd9-c8823f4e2167',
 priorVersionId:'283c647e-8618-4c9d-9c66-450deebee143',
 scriptEtag:'281ae5cbbe50917708f3c6a81616c89e23f5c416651a88495c7b013438857b6f',
 sourceCommit:'60272937664175cb2c124999cd780f8a5237d9ab',
};
const sha=/^[0-9a-f]{40}$/i,hash=/^[0-9a-f]{64}$/i;
const fail=code=>{throw Error(`Current-state replacement: ${code}`);};
const digest=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// Tags preserve missing/undefined, null, empty object and empty array as
// distinct values. The digest is never a substitute for secret-value proof.
export function canonicalEvidence(value){
 if(value===undefined)return ['undefined'];
 if(value===null)return ['null'];
 if(Array.isArray(value))return ['array',value.map(canonicalEvidence)];
 if(plain(value))return ['object',Object.keys(value).sort().map(key=>[key,canonicalEvidence(value[key])])];
 if(typeof value==='string'||typeof value==='boolean')return [typeof value,value];
 if(typeof value==='number'&&Number.isFinite(value))return ['number',value];
 fail('NON_CANONICAL_VALUE');
}
export const remoteStateFingerprint=remote=>digest(JSON.stringify(canonicalEvidence(remote)));
const preservedState=remote=>{
 const {activeVersions,deploymentMessage,bindings,...rest}=remote;
 return {...rest,bindings:bindings.map(binding=>binding.name==='ASSETS'?{name:'ASSETS',type:'assets'}:binding)};
};
export const preservedStateFingerprint=remote=>remoteStateFingerprint(preservedState(remote));

export function assertReplacementConfig(config){
 if(typeof config!=='string')fail('ASSET_CONFIG_INVALID');
 const sections=[...config.matchAll(/^\[assets\]\s*$/gm)];
 if(sections.length!==1)fail('ASSET_CONFIG_INVALID');
 const body=config.slice(sections[0].index+sections[0][0].length).split(/^\[/m)[0];
 const lines=body.split(/\r?\n/).map(line=>line.replace(/#.*$/,'').trim()).filter(Boolean);
 const rows=lines.map(line=>{const match=/^([a-z_]+)\s*=\s*(.+)$/.exec(line);if(!match)fail('ASSET_CONFIG_INVALID');return [match[1],match[2].trim()];});
 if(rows.length!==3||JSON.stringify(Object.fromEntries(rows))!==JSON.stringify({directory:'"./web/site"',binding:'"ASSETS"',run_worker_first:'true'}))fail('ASSET_CONFIG_INVALID');
 const vars=config.split(/^\[vars\]\s*$/m);
 if(vars.length!==2)fail('PRODUCTION_VARS_INVALID');
 const varsBody=vars[1].split(/^\[/m)[0];
 const names=varsBody.split(/\r?\n/).map(line=>line.replace(/#.*$/,'').trim()).filter(Boolean).map(line=>{const match=/^([A-Z][A-Z0-9_]*)\s*=\s*.+$/.exec(line);if(!match)fail('PRODUCTION_VARS_INVALID');return match[1];}).sort();
 if(JSON.stringify(names)!==JSON.stringify(['ALLOW_PAID_API','ENABLE_LIVE_FREE','SITE_DEPLOYED']))fail('PRODUCTION_VARS_INVALID');
 return true;
}

export function assetManifestDigest(root){
 const tracked=execFileSync('git',['ls-files','-z','--cached','--','web/site'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).sort();
 const others=execFileSync('git',['ls-files','-z','--others','--','web/site'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
 if(!tracked.length||others.length)fail('ASSET_SET_UNTRACKED_OR_EMPTY');
 try{execFileSync('git',['diff','--quiet','HEAD','--'],{cwd:root,stdio:'ignore'});}catch{fail('WORKTREE_CHANGED');}
 const found=[];
 function visit(path){
  for(const entry of readdirSync(path,{withFileTypes:true})){
   const absolute=join(path,entry.name),stat=lstatSync(absolute);
   if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))fail('ASSET_TYPE_INVALID');
   if(stat.isDirectory())visit(absolute);
   else found.push(relative(root,absolute).split(sep).join('/'));
  }
 }
 visit(resolve(root,'web/site'));
 found.sort();
 if(JSON.stringify(found)!==JSON.stringify(tracked))fail('ASSET_SET_UNTRACKED_OR_MISSING');
 const entries=tracked.map(path=>[path,digest(readFileSync(resolve(root,path)))]);
 return digest(JSON.stringify(['COMPLETE_ASSET_MANIFEST_V1',entries]));
}

const fields=['kind','intent','accountId','workerName','databaseId','activeVersionId','priorVersionId','scriptEtag','sourceCommit','reviewedCommitSha','remoteFingerprint','assetManifestDigest','ownerDiagnosticDigest','approvedScopeUpdateDigest','scopeValueEquality','reviewedAt','expiresAt'];
function trustedScopeRecord(env,recordKey,trustedHashKey,approvalHash,kind,now){
 const raw=env[recordKey],trusted=env[trustedHashKey];
 if(typeof raw!=='string'||!raw||!hash.test(trusted??''))fail('SCOPE_REVIEW_RECORD_UNAVAILABLE');
 if(digest(raw)!==trusted.toLowerCase()||digest(raw)!==approvalHash.toLowerCase())fail('SCOPE_REVIEW_RECORD_MISMATCH');
 let record;try{record=JSON.parse(raw);}catch{fail('SCOPE_REVIEW_RECORD_INVALID');}
 if(!plain(record)||record.kind!==kind||record.accountId!==pinned.accountId||record.workerName!==pinned.workerName||record.activeVersionId!==pinned.activeVersionId||record.scopeValueEquality!=='UNVERIFIED'||typeof record.evidenceId!=='string'||record.evidenceId.length<12)fail('SCOPE_REVIEW_RECORD_INVALID');
 const time=Date.parse(record.reviewedAt);
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.reviewedAt)||!Number.isFinite(time)||time>now)fail('SCOPE_REVIEW_RECORD_INVALID');
 if(kind==='OWNER_SCOPE_DIAGNOSTIC_REVIEW_V1'&&(record.ownerAccessVerified!==true||record.scopeBindingStatus!=='PRESENT'))fail('SCOPE_REVIEW_RECORD_INVALID');
 if(kind==='APPROVED_SCOPE_UPDATE_REVIEW_V1'&&record.changeKind!=='Updated secret: GROQ_LEGACY_RECOVERY_SCOPE_JSON')fail('SCOPE_REVIEW_RECORD_INVALID');
 return record;
}
export function currentStateReplacementApproval(env=process.env,now=Date.now()){
 let approval;try{approval=JSON.parse(env.GROQ_CURRENT_STATE_REPLACEMENT_JSON);}catch{fail('APPROVAL_UNAVAILABLE');}
 if(!plain(approval)||JSON.stringify(Object.keys(approval).sort())!==JSON.stringify([...fields].sort()))fail('APPROVAL_INVALID');
 if(approval.kind!=='CURRENT_STATE_SOURCE_REPLACEMENT_V1'||approval.intent!=='REPLACE_REVIEWED_ACTIVE_CODE_AND_ASSETS'||approval.scopeValueEquality!=='UNVERIFIED')fail('APPROVAL_INVALID');
 for(const [key,value] of Object.entries(pinned))if(approval[key]!==value)fail('PINNED_TARGET_MISMATCH');
 if(!sha.test(approval.reviewedCommitSha)||!['remoteFingerprint','assetManifestDigest','ownerDiagnosticDigest','approvedScopeUpdateDigest'].every(key=>hash.test(approval[key])))fail('APPROVAL_INVALID');
 const start=Date.parse(approval.reviewedAt),end=Date.parse(approval.expiresAt);
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(approval.reviewedAt)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(approval.expiresAt)||!Number.isFinite(start)||!Number.isFinite(end)||start>now||end<=now||end-start>24*60*60*1000)fail('APPROVAL_EXPIRED');
 const owner=trustedScopeRecord(env,'GROQ_OWNER_DIAGNOSTIC_RECORD_JSON','GROQ_TRUSTED_OWNER_DIAGNOSTIC_SHA256',approval.ownerDiagnosticDigest,'OWNER_SCOPE_DIAGNOSTIC_REVIEW_V1',now);
 const update=trustedScopeRecord(env,'GROQ_APPROVED_SCOPE_UPDATE_RECORD_JSON','GROQ_TRUSTED_SCOPE_UPDATE_SHA256',approval.approvedScopeUpdateDigest,'APPROVED_SCOPE_UPDATE_REVIEW_V1',now);
 if(owner.evidenceId!==update.ownerDiagnosticEvidenceId||owner.reviewedAt<update.reviewedAt)fail('SCOPE_REVIEW_RECORD_MISMATCH');
 return {...approvedRemoteBaseline,...pinned,replacement:approval};
}

export function assertCurrentStateReplacementPreflight(remote,baseline,lineage,{head,buildSha,manifestDigest}={}){
 const approval=baseline?.replacement;
 if(!approval||head!==approval.reviewedCommitSha||buildSha!==head)fail('COMMIT_MISMATCH');
 if(manifestDigest!==approval.assetManifestDigest)fail('ASSET_MANIFEST_MISMATCH');
 // Reuse every existing current-settings/D1/Access/paid-flag guard, but do
 // not make a historical source-annotation claim about the active version.
 assertRemoteState(remote,baseline,{postDeploy:true});
 if(!remote.bindings.some(binding=>binding.name===legacyGroqRecoveryScopeBinding&&binding.type==='secret_text'))fail('SCOPE_BINDING_UNAVAILABLE');
 if(remoteStateFingerprint(remote)!==approval.remoteFingerprint)fail('REMOTE_FINGERPRINT_MISMATCH');
 if(!lineage||lineage.activeVersionId!==pinned.activeVersionId||lineage.priorVersionId!==pinned.priorVersionId||lineage.priorDeploymentSourceAnnotation!=='EXPECTED'||lineage.priorDeploymentSource!=='WRANGLER'||lineage.activeDeploymentSource!=='DASHBOARD'||lineage.scriptEtagMatchesPinned!==true||lineage.scriptContentEqual!==true||lineage.runtimeMetadataComplete!==true||lineage.runtimeMetadataEqual!==true||lineage.activeAssetsBindingCount!==1||lineage.priorAssetsBindingCount!==1)fail('VERSION_EVIDENCE_MISMATCH');
 return true;
}

export function assertCurrentStateReplacementPostPreservation(before,after){
 if(preservedStateFingerprint(before)!==preservedStateFingerprint(after))fail('POST_SETTINGS_OR_BINDINGS_CHANGED');
 return true;
}
