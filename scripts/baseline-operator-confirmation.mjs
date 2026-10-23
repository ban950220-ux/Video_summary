// Human confirmation is a process-local capability, never a boolean/JSON grant.
// This authenticates an action by the trusted local terminal operator. It is not
// a Cloudflare user identity assertion or automatic proof of a writer pause.
import {randomBytes,createHash} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
const grants=new WeakMap();
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};

export async function confirmBaselineAtTerminal(binding,{input=process.stdin,output=process.stderr,signal,now=Date.now}={}){
 if(!input?.isTTY||!output?.isTTY||input.destroyed||output.destroyed)fail('BASELINE_INTERACTIVE_OPERATOR_REQUIRED');
 if(!binding||!Number.isSafeInteger(binding.expiresMs)||binding.expiresMs<=now()||binding.expiresMs-now()>300000)fail('BASELINE_CONFIRMATION_EXPIRED');
 const raw=JSON.stringify(binding),digest=hash(raw),nonce=randomBytes(12).toString('hex');
 // Binding is built from enumerated target IDs, times, hashes and fixed text by
 // the session; callers cannot supply terminal strings from HTTP responses.
 const challenge=`REGISTER BASELINE ${digest} ${nonce}`;
 output.write('Register one schema baseline only. No migration, restore, deployment or provider call.\n');
 output.write('Confirm the reviewed writer/dispatch pause remains enforced throughout this window.\n');
 output.write('Evidence hashes bind your reviewed records; they do not prove those manual facts.\n');
 output.write(JSON.stringify(binding,null,2)+'\n');
 const rl=createInterface({input,output,terminal:false});
 const timeout=AbortSignal.timeout(Math.max(1,binding.expiresMs-now()));
 const combined=signal?AbortSignal.any([signal,timeout]):timeout;
 let answer;try{answer=await rl.question(`Type exactly: ${challenge}\n`,{signal:combined});}catch{fail('BASELINE_CONFIRMATION_CANCELLED');}finally{rl.close();}
 if(answer!==challenge)fail('BASELINE_CONFIRMATION_DENIED');
 if(now()>=binding.expiresMs||combined.aborted)fail('BASELINE_CONFIRMATION_EXPIRED');
 const capability=Object.freeze({kind:'BASELINE_OPERATOR_CAPABILITY_V1'});
 grants.set(capability,{raw,expiresMs:binding.expiresMs});return capability;
}

export function assertOperatorCapability(capability,binding,{now=Date.now()}={}){
 const grant=grants.get(capability);
 if(!grant||grant.raw!==JSON.stringify(binding))fail('BASELINE_OPERATOR_CAPABILITY_INVALID');
 if(now>=grant.expiresMs)fail('BASELINE_CONFIRMATION_EXPIRED');
 return true;
}
