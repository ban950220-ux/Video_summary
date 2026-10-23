import {readFile,open,rename,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {verifyRunnerFiles,readRunnerChunk} from './local-runner-session.mjs';
import {withRunnerLock} from './local-runner-lock.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
// Intentionally local-only until an independently reviewed real authentication
// adapter and production endpoint are supplied. No login or auth storage.
export function createLoopbackAudioClient({baseUrl,authenticationHeaders,binding,fetchImpl=fetch}){
 const base=new URL(baseUrl);
 if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||!base.port||base.pathname!=='/'||base.username||base.password||base.search||base.hash||typeof authenticationHeaders!=='function')fail('RUNNER_LOCAL_TRANSPORT_REQUIRED');
 const call=async(action,{index,body,resumeApprovalId}={})=>{
  const headers=new Headers(await authenticationHeaders());
  if(!headers.has('authorization'))fail('RUNNER_AUTH_REQUIRED');
  for(const [name,value] of Object.entries({'x-runner-id':binding.runnerId,'x-runner-lease-nonce':binding.leaseNonce,'x-runner-request-id':binding.requestId,'x-runner-manifest-sha256':binding.manifestSha256}))headers.set(name,value);
  if(resumeApprovalId)headers.set('x-runner-resume-approval-id',resumeApprovalId);
  const method=action==='progress'?'GET':'POST';
  if(body)headers.set('content-type',body instanceof Uint8Array?'application/octet-stream':'application/json');
  const response=await fetchImpl(new URL('runner/jobs/'+binding.jobId+'/'+action+(index===undefined?'':'?index='+index),base),{method,headers,redirect:'error',body:body instanceof Uint8Array?body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(130000)});
  const value=await response.json();if(!response.ok)fail(value?.error?.code||'RUNNER_HTTP_ERROR');return value;
 };
 return {plan:()=>call('plan',{body:{rightsConfirmed:true,linkUrlToAudio:true}}),progress:()=>call('progress'),approveResume:(index,approval)=>call('resume-blocked',{index,body:{approval}}),chunk:(index,bytes,resumeApprovalId)=>call('chunk',{index,body:bytes,resumeApprovalId}),finish:()=>call('finish',{body:{}})};
}
const name='runner-audio-progress.json';
async function store(root,state){
 const path=join(root,`.runner-audio-${randomUUID()}.tmp`),file=await open(path,'wx',0o600);
 try{await file.writeFile(JSON.stringify(state));await file.sync();}finally{await file.close();}
 await rename(path,join(root,name));
}
function receiptMatches(receipt,c,index){return receipt?.state==='TRANSCRIBED'&&receipt.index===index&&receipt.manifestSha256===c.manifestSha256&&receipt.chunkSha256===c.manifest.chunks[index].sha256&&receipt.summaryComplete===false;}
// Exactly one plan/chunk/finalize transition per user-controlled invocation.
// No unattended loop, retries, paid fallback or implicit summary execution.
export function advanceRunnerAudioSession(options){return withRunnerLock(options.workDir,assertHeld=>advanceLocked(options,assertHeld));}
// A separate explicit action: the ordinary restart never turns UNCERTAIN into READY.
// Approval data remains in memory; a lost approval ACK can repeat the same approval
// ID, while a lost chunk ACK must go through ordinary receipt reconciliation.
export function resumeBlockedRunnerAudioSession(options){return withRunnerLock(options.workDir,async assertHeld=>{
 const {workDir,client,approval,confirmExplicitResume=false,foreground=()=>false}=options;
 if(!confirmExplicitResume||!foreground())fail('RUNNER_EXPLICIT_RESUME_REQUIRED');
 const root=await realpath(workDir),c=await verifyRunnerFiles(root),raw=await readFile(join(root,name),'utf8'),state=JSON.parse(raw),index=approval?.chunkIndex;
 if(state.kind!=='LOCAL_RUNNER_AUDIO_PROGRESS_V1'||state.manifestSha256!==c.manifestSha256||!state.planned||state.finished||!Number.isSafeInteger(index)||!['READY','UNCERTAIN'].includes(state.chunks?.[index]))fail('RUNNER_AUDIO_CHECKPOINT_INVALID');
 if(approval.manifestSha256!==c.manifestSha256||approval.sourceSha256!==c.manifest.fileSha256||JSON.stringify(approval.chunkHashes)!==JSON.stringify(c.manifest.chunks.map(c=>c.sha256)))fail('RUNNER_NEW_CONSENT_REQUIRED');
 const p=await client.progress(),review=p.dispatches?.find(d=>d.chunk_index===index)?.resume;
 if(p.jobId!==c.manifest.jobId||p.manifestSha256!==c.manifestSha256||review?.state!=='EXPLICIT_NEW_APPROVAL_REQUIRED'||review.blockedAttemptId!==approval.blockedAttemptId||review.evidenceSha256!==approval.evidenceSha256)fail('RUNNER_ZERO_DISPATCH_NOT_PROVEN');
 const bytes=await readRunnerChunk(root,c,index);await assertHeld();
 if(await readFile(join(root,name),'utf8')!==raw||!foreground())fail('RUNNER_AUDIO_CHECKPOINT_CHANGED');
 const accepted=await client.approveResume(index,approval);if(accepted.state!=='BLOCKED_RESUME_APPROVED'||accepted.approvalId!==approval.approvalId)fail('RUNNER_RESUME_APPROVAL_INVALID');
 await assertHeld();if(await readFile(join(root,name),'utf8')!==raw||!foreground())fail('RUNNER_AUDIO_CHECKPOINT_CHANGED');
 state.chunks[index]='UNCERTAIN';await store(root,state);await assertHeld();
 if(JSON.stringify(JSON.parse(await readFile(join(root,name),'utf8')))!==JSON.stringify(state))fail('RUNNER_AUDIO_CHECKPOINT_CHANGED');
 const result=await client.chunk(index,bytes,approval.approvalId);if(!receiptMatches(result,c,index))fail('RUNNER_TRANSCRIPT_NOT_STORED');
 state.chunks[index]='TRANSCRIBED';await store(root,state);return result;
});}
async function advanceLocked({workDir,client,rightsConfirmed=false,linkUrlToAudioConfirmed=false,foreground=()=>false},assertHeld){
 if(!foreground())fail('RUNNER_FOREGROUND_REQUIRED');
 const root=await realpath(workDir),c=await verifyRunnerFiles(root);
 let state;try{state=JSON.parse(await readFile(join(root,name),'utf8'));}catch(error){if(error.code!=='ENOENT')fail('RUNNER_AUDIO_CHECKPOINT_INVALID');state={kind:'LOCAL_RUNNER_AUDIO_PROGRESS_V1',manifestSha256:c.manifestSha256,planned:false,chunks:c.manifest.chunks.map(()=> 'READY'),finished:false};}
 if(state.kind!=='LOCAL_RUNNER_AUDIO_PROGRESS_V1'||state.manifestSha256!==c.manifestSha256||typeof state.planned!=='boolean'||typeof state.finished!=='boolean'||!Array.isArray(state.chunks)||state.chunks.length!==c.manifest.chunks.length||state.chunks.some(s=>!['READY','UNCERTAIN','TRANSCRIBED'].includes(s))||Object.keys(state).sort().join(',')!=='chunks,finished,kind,manifestSha256,planned')fail('RUNNER_AUDIO_CHECKPOINT_INVALID');
 const progress=await client.progress();
 if(progress.jobId!==c.manifest.jobId||progress.manifestSha256!==c.manifestSha256)fail('RUNNER_SCOPE_CHANGED');
 if(!state.planned){
  if(rightsConfirmed!==true||linkUrlToAudioConfirmed!==true)fail('RUNNER_RIGHTS_CONFIRMATION_REQUIRED');
  if(!foreground())fail('RUNNER_FOREGROUND_REQUIRED');
  const plan=await client.plan();if(plan.planned!==true)fail('RUNNER_PLAN_UNVERIFIED');state.planned=true;await store(root,state);return {state:'PLANNED',summaryComplete:false};
 }
 for(const [index] of c.manifest.chunks.entries()){
  const receipt=progress.receipts?.find(r=>r.index===index);
  if(receipt){if(!receiptMatches(receipt,c,index))fail('RUNNER_RECEIPT_INVALID');state.chunks[index]='TRANSCRIBED';continue;}
  if(state.chunks[index]!=='READY')fail('RUNNER_DISPATCH_RECONCILIATION_REQUIRED');
  const bytes=await readRunnerChunk(root,c,index);if(!foreground())fail('RUNNER_FOREGROUND_REQUIRED');
  await assertHeld();const onDisk=JSON.parse(await readFile(join(root,name),'utf8'));if(onDisk.manifestSha256!==state.manifestSha256||onDisk.chunks[index]!=='READY')fail('RUNNER_AUDIO_CHECKPOINT_CHANGED');
  state.chunks[index]='UNCERTAIN';await store(root,state);await assertHeld();
  if(JSON.stringify(JSON.parse(await readFile(join(root,name),'utf8')))!==JSON.stringify(state))fail('RUNNER_AUDIO_CHECKPOINT_CHANGED');
  const result=await client.chunk(index,bytes);if(!receiptMatches(result,c,index))fail('RUNNER_TRANSCRIPT_NOT_STORED');
  state.chunks[index]='TRANSCRIBED';await store(root,state);return result;
 }
 if(!foreground())fail('RUNNER_FOREGROUND_REQUIRED');
 const result=await client.finish();
 if(result.state!=='TRANSCRIPT_STORED_SOURCE_UNVERIFIED'||result.persisted!==true||result.summaryComplete!==false)fail('RUNNER_TRANSCRIPT_NOT_STORED');
 state.finished=true;await store(root,state);return result;
}
