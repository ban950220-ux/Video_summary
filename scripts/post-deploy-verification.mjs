import {readRemoteState} from './read-remote-state.mjs';
import {assertRemoteState,legacyQuoteRecoveryBinding,legacyGroqRecoveryScopeBinding,protectedRemoteBaseline} from './remote-state-policy.mjs';
import {assertDeployedVersion,safeDeploymentReceipt} from './deployment-runtime.mjs';
import {assertCurrentStateReplacementPostPreservation} from './current-state-replacement.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const unverified=code=>Error(`Production deploy: DEPLOYED_UNVERIFIED: ${code}`);

// Only retry a failed GET transport after Wrangler has returned one deploy result.
// Never retry an HTTP response, invalid API data, a version mismatch, or a guard failure.
export async function verifyPostDeploy({token,ciMatchTag,deployed,before,baseline,env=process.env,read=readRemoteState,wait=pause}={}){
 const recoverySetting=before?.bindings?.find(item=>item.name===legacyQuoteRecoveryBinding)?.text;
 const groqScopePresent=before?.bindings?.some(item=>item.name===legacyGroqRecoveryScopeBinding);
 if(typeof recoverySetting!=='string'||!recoverySetting)throw unverified('PRE_DEPLOY_RECOVERY_SETTING_UNAVAILABLE');
 baseline??=protectedRemoteBaseline(env);
 let verified;
 for(let check=0;check<2;check++){
  for(let attempt=0;attempt<3;attempt++){
   try{verified=await read({token,target:baseline,env});break;}
   catch(error){
    if(error?.retryableReadTransport!==true)throw unverified('POST_DEPLOY_READ_FAILED');
    if(attempt===2)throw unverified('POST_DEPLOY_TRANSPORT_EXHAUSTED');
    try{await wait(500*(2**attempt));}
    catch{throw unverified('POST_DEPLOY_RETRY_WAIT_FAILED');}
   }
  }
  if(ciMatchTag&&verified.workerTag!==ciMatchTag)throw unverified('POST_DEPLOY_WORKER_TAG_MISMATCH');
  try{assertDeployedVersion(verified,deployed);}
  catch{throw unverified('POST_DEPLOY_VERSION_MISMATCH');}
  try{assertRemoteState(verified,{...baseline,activeVersionId:deployed.versionId},{postDeploy:true});}
  catch{throw unverified('POST_DEPLOY_BASELINE_MISMATCH');}
  if(verified.bindings.find(item=>item.name===legacyQuoteRecoveryBinding)?.text!==recoverySetting)throw unverified('RECOVERY_SETTING_CHANGED');
  if(verified.bindings.some(item=>item.name===legacyGroqRecoveryScopeBinding)!==groqScopePresent)throw unverified('GROQ_SCOPE_BINDING_CHANGED');
  if(baseline.replacement){
   try{assertCurrentStateReplacementPostPreservation(before,verified);}
   catch{throw unverified('POST_SETTINGS_OR_BINDINGS_CHANGED');}
  }
 }
 try{return safeDeploymentReceipt(verified,deployed);}
 catch{throw unverified('POST_DEPLOY_RECEIPT_INVALID');}
}
