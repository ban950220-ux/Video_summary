import {readRemoteState} from './read-remote-state.mjs';
import {approvedRemoteBaseline,assertRemoteState} from './remote-state-policy.mjs';
import {assertDeployedVersion,safeDeploymentReceipt} from './deployment-runtime.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const unverified=code=>Error(`Production deploy: DEPLOYED_UNVERIFIED: ${code}`);

// Only retry a failed GET transport after Wrangler has returned one deploy result.
// Never retry an HTTP response, invalid API data, a version mismatch, or a guard failure.
export async function verifyPostDeploy({token,ciMatchTag,deployed,baseline=approvedRemoteBaseline,read=readRemoteState,wait=pause}={}){
 let verified;
 for(let check=0;check<2;check++){
  for(let attempt=0;attempt<3;attempt++){
   try{verified=await read({token});break;}
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
 }
 try{return safeDeploymentReceipt(verified,deployed);}
 catch{throw unverified('POST_DEPLOY_RECEIPT_INVALID');}
}
