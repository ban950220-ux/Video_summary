// Read-only current-state evidence. Never log API responses or credential values.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readRemoteState} from './read-remote-state.mjs';
import {readWorkerVersionLineage} from './worker-version-lineage-diagnostic.mjs';
import {approvedRemoteBaseline,assertRemoteState} from './remote-state-policy.mjs';
import {safeRemoteBaselineReport} from './remote-baseline-preflight.mjs';
import {assetManifestDigest,remoteStateFingerprint} from './current-state-replacement.mjs';

const target={
 accountId:'fe9d7e2a164274b1ff6cef150a75cb0b',workerName:'holy-rice-b914',
 databaseId:'d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34',
 activeVersionId:'a1aa62cf-1ecb-4f51-9cd9-c8823f4e2167',
 priorVersionId:'283c647e-8618-4c9d-9c66-450deebee143',
 scriptEtag:'281ae5cbbe50917708f3c6a81616c89e23f5c416651a88495c7b013438857b6f',
 sourceCommit:'60272937664175cb2c124999cd780f8a5237d9ab',
};
const expected={...approvedRemoteBaseline,...target};
const mismatch=error=>/^Remote deployment guard: ([A-Z_]+)$/.exec(error?.message)?.[1]??'UNCLASSIFIED_MISMATCH';

export async function runCurrentStateReadonlyDiagnostic({env=process.env,fetcher=fetch,write=console.log,root=resolve(import.meta.dirname,'..')}={}){
 if(!env.CLOUDFLARE_API_TOKEN){write('CURRENT_STATE_READONLY_DIAGNOSTIC_FAILED: TOKEN_UNAVAILABLE');return false;}
 try{
  const manifest=assetManifestDigest(root);
  const remote=await readRemoteState({token:env.CLOUDFLARE_API_TOKEN,fetcher,target});
  const lineage=await readWorkerVersionLineage({token:env.CLOUDFLARE_API_TOKEN,fetcher,baseline:target});
  const {activeVersionId,priorVersionId,...safeLineage}=lineage;
  const safe=safeRemoteBaselineReport(remote);
  let policyMismatch=null;
  try{assertRemoteState(remote,expected,{postDeploy:true});}catch(error){policyMismatch=mismatch(error);}
  write(JSON.stringify({kind:'CURRENT_STATE_READONLY_DIAGNOSTIC_V1',readOnly:true,
   target:{activeVersionMatched:remote.activeVersions.length===1&&remote.activeVersions[0].id===target.activeVersionId&&remote.activeVersions[0].percentage===100,
    databaseMatched:remote.bindings.some(item=>item.name==='DB'&&item.type==='d1'&&item.id===target.databaseId),
    recoveryScopeBindingPresent:remote.bindings.some(item=>item.name==='GROQ_LEGACY_RECOVERY_SCOPE_JSON'&&item.type==='secret_text'),
    buildTagMatched:env.WRANGLER_CI_MATCH_TAG?remote.workerTag===env.WRANGLER_CI_MATCH_TAG:'NOT_SUPPLIED'},
   policyMismatch,remoteFingerprint:remoteStateFingerprint(remote),assetManifestDigest:manifest,
   bindings:safe.bindings,exposure:safe.exposure,metadata:safe.metadata,scriptSettings:safe.scriptSettings,
   lineage:safeLineage,scopeValueEquality:'UNVERIFIED'}));
  return true;
 }catch{write('CURRENT_STATE_READONLY_DIAGNOSTIC_FAILED: READ_OR_RESPONSE_INVALID');return false;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==2){console.log('CURRENT_STATE_READONLY_DIAGNOSTIC_FAILED: ARGUMENTS_NOT_ALLOWED');process.exitCode=1;}
 else if(!await runCurrentStateReadonlyDiagnostic())process.exitCode=1;
}
