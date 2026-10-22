import {open,readFile,unlink,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const name='.runner-session.lock';
export async function withRunnerLock(workDir,run){
 const root=await realpath(workDir),path=join(root,name),nonce=randomUUID();let file;
 try{file=await open(path,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('RUNNER_PROCESS_LOCKED');throw error;}
 try{
  await file.writeFile(JSON.stringify({kind:'RUNNER_PROCESS_LOCK_V1',pid:process.pid,nonce}));await file.sync();await file.close();file=null;
  const assertHeld=async()=>{let row;try{row=JSON.parse(await readFile(path,'utf8'));}catch{fail('RUNNER_PROCESS_LOCK_CHANGED');}if(row.nonce!==nonce||row.pid!==process.pid)fail('RUNNER_PROCESS_LOCK_CHANGED');};
  return await run(assertHeld);
 }finally{
  if(file)await file.close();
  let row;try{row=JSON.parse(await readFile(path,'utf8'));}catch{}
  if(row?.nonce===nonce&&row.pid===process.pid)await unlink(path);
 }
}
// Explicit recovery only. Never steal an active/ambiguous lock by elapsed time.
// PID reuse, access denied or corrupt data fail closed. Checkpoints still govern
// any uncertain handoff after this lock is removed.
export async function recoverStoppedRunnerLock({workDir,expectedNonce,confirmProcessStopped=false}){
 if(confirmProcessStopped!==true)fail('RUNNER_LOCK_REVIEW_REQUIRED');
 const root=await realpath(workDir),path=join(root,name),gate=join(root,'.runner-lock-recovery');let file;
 try{file=await open(gate,'wx',0o600);}catch{fail('RUNNER_LOCK_REVIEW_REQUIRED');}
 try{
  const raw=await readFile(path,'utf8');let row;try{row=JSON.parse(raw);}catch{fail('RUNNER_LOCK_REVIEW_REQUIRED');}
  if(row.kind!=='RUNNER_PROCESS_LOCK_V1'||row.nonce!==expectedNonce||!Number.isSafeInteger(row.pid)||row.pid<1)fail('RUNNER_LOCK_REVIEW_REQUIRED');
  try{process.kill(row.pid,0);fail('RUNNER_PROCESS_STILL_ACTIVE');}catch(error){if(error.code!=='ESRCH')throw error;}
  if(await readFile(path,'utf8')!==raw)fail('RUNNER_PROCESS_LOCK_CHANGED');
  await unlink(path);return {recovered:true,retransmissionApproved:false};
 }finally{await file.close();await unlink(gate);}
}
