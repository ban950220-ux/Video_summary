import {InputError} from './core.mjs';
import {ProviderError} from './adapters.mjs';
import {capacityIdentity,capacityIdentityForCredentialSnapshot} from './observed-capacity.mjs';
import {runOwnedGroqSummary} from './provider-keys.mjs';
import {COMPLETE_SYNTHESIS_CONTRACT,COMPLETE_SYNTHESIS_INPUT_LIMIT,COMPLETE_SYNTHESIS_OUTPUT_LIMIT,persistedSynthesisNode} from './groq-complete-synthesis.mjs';

const encoder=new TextEncoder();
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(typeof value==='string'?value:JSON.stringify(value))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
const fail=(code,message)=>{throw new ProviderError(code,message);};
const now=()=>new Date().toISOString();
const int=value=>Number.isSafeInteger(value)&&value>=0;
const MINUTE_CAP=7_000,DAY_CAP=195_000,SPACING_MS=61_000,PER_CALL=COMPLETE_SYNTHESIS_INPUT_LIMIT+COMPLETE_SYNTHESIS_OUTPUT_LIMIT;
const operationId=(id,hash,key)=>id+':groq-summary-complete:'+hash+':note:'+key;
const quotePrefix=(id,hash,start)=>id+':groq-summary-complete:'+hash+':quote:'+start+':';
const approvalId=quoteId=>quoteId.replace(':quote:',':approval:');
const sharedProvider="provider IN ('groq-summary','groq-summary-synthesis')";
const counted="state IN ('CLAIMED','DONE','FAILED_UNCERTAIN')";
const recoveryProofSql="NOT EXISTS(SELECT 1 FROM json_each(?) p WHERE NOT EXISTS(SELECT 1 FROM yta_operations r JOIN yta_operations f ON f.id=json_extract(p.value,'$.failedId') JOIN usage_events u ON u.id=json_extract(p.value,'$.usageId') JOIN yta_operations a ON a.id=json_extract(p.value,'$.approvalId') WHERE r.id=json_extract(p.value,'$.id') AND r.provider='groq-summary-synthesis-recovery' AND r.state='DONE' AND r.result_json=json_extract(p.value,'$.resultJson') AND f.provider='groq-summary-synthesis' AND f.state='FAILED_UNCERTAIN' AND f.result_json=json_extract(p.value,'$.failedJson') AND u.owner_id='owner' AND u.provider='groq' AND u.capability='LIVE_FREE_SYNTHESIS' AND u.unit='actual_total_tokens' AND u.provenance=json_extract(p.value,'$.usageProvenance') AND u.used_units=json_extract(p.value,'$.usageTokens') AND a.provider='groq-summary-synthesis-approval' AND a.state='STOPPED' AND a.result_json=json_extract(p.value,'$.approvalJson')))";

export async function synthesisApprovalStatus(env,id,sourceHash,completed){
 const rows=(await env.DB.prepare("SELECT id,state,result_json FROM yta_operations WHERE job_id=? AND provider='groq-summary-synthesis-approval' AND state='APPROVED' ORDER BY created_at DESC LIMIT 20").bind(id).all()).results||[];
 for(const row of rows){let scope;try{scope=JSON.parse(row.result_json);}catch{continue;}
  if(scope.contract===COMPLETE_SYNTHESIS_CONTRACT&&scope.sourceHash===sourceHash&&scope.windowStart<=completed&&completed<scope.windowStart+scope.maxCalls&&scope.expiresAt>Date.now())return {approvalId:row.id,quoteId:scope.quoteId,windowStart:scope.windowStart,maxCalls:scope.maxCalls,expiresAt:scope.expiresAt,completedInWindow:completed-scope.windowStart};
 }
 return null;
}

async function sharedLedger(env,excluded=[]){
 const rows=(await env.DB.prepare(`SELECT id,provider,units,state,created_at FROM yta_operations WHERE ${sharedProvider} AND ${counted} ORDER BY created_at DESC LIMIT 10001`).all()).results||[];
 if(rows.length>10000||rows.some(row=>!int(row.units)||row.units>DAY_CAP||!Number.isFinite(Date.parse(row.created_at))||Date.parse(row.created_at)>Date.now()+300000))fail('SYNTHESIS_LEDGER_REVIEW_REQUIRED','공유 Groq 사용 원장을 검토하세요.');
 const recent=rows.find(row=>!excluded.includes(row.id));
 if(recent?.state==='CLAIMED')fail('SYNTHESIS_SHARED_IN_FLIGHT','다른 Groq 요약 호출이 진행 중입니다.');
 if(recent?.state==='FAILED_UNCERTAIN')fail('SYNTHESIS_UNCERTAIN_CALL','미확정 Groq 호출을 먼저 검토하세요.');
 if(recent&&Date.parse(recent.created_at)>Date.now()-SPACING_MS)fail('SYNTHESIS_PACING_WAIT','Groq 호출 간격을 기다리세요.');
 const minute=rows.filter(row=>Date.parse(row.created_at)>Date.now()-60_000).reduce((sum,row)=>sum+row.units,0);
 const day=rows.filter(row=>Date.parse(row.created_at)>Date.now()-86_400_000).reduce((sum,row)=>sum+row.units,0);
 if(minute+PER_CALL>MINUTE_CAP||day+PER_CALL>DAY_CAP)fail('SYNTHESIS_LOCAL_LIMIT','공유 Groq 앱 사용 상한을 기다리세요.');
}

export async function synthesisAction({body,env,id,job,source,sourceHash,manifest,notes,progress,failures,recoveredFailureIds=[],recoveryProofs=[],claimedOutcomeUnsettled=false,ownedJob,sourceOf,completeSource,verifyGrounding}){
 if(env.ENABLE_COMPLETE_SYNTHESIS!=='true'||env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true')fail('SYNTHESIS_FEATURE_DISABLED','Groq Free 종합 실행은 비활성입니다.');
 if(progress.complete)fail('SYNTHESIS_ALREADY_COMPLETE','모든 종합 노드가 이미 저장됐습니다.');
 if(failures.some(item=>!item.dispositionReviewed))fail('SYNTHESIS_FAILURE_REVIEW_REQUIRED','원시 단계 실패 사용량을 별도로 검토하세요.');
 const start=progress.completed,remaining=notes.length-1-start,maxCalls=Math.min(remaining,Math.floor(DAY_CAP/PER_CALL));
 if(maxCalls<1)fail('SYNTHESIS_WINDOW_EMPTY','실행할 종합 노드가 없습니다.');
 const active=body.step==='execute'||body.step==='cancel'?await synthesisApprovalStatus(env,id,sourceHash,start):null;
 const windowStart=active?.windowStart??start,qId=active?.quoteId??(body.step==='quote'?quotePrefix(id,sourceHash,start)+crypto.randomUUID():body.quoteId),aId=active?.approvalId??approvalId(qId??''),opId=operationId(id,sourceHash,progress.next.key),keyIdentity=await capacityIdentity(env,'groq');
 const quote={contract:COMPLETE_SYNTHESIS_CONTRACT,jobId:id,sourceHash,manifestSha256:manifest.manifestSha256,firstNode:progress.next.key,firstRequestSha256:progress.next.requestSha256,windowStart:start,maxCalls,reservedUnits:maxCalls*PER_CALL,perCallUnits:PER_CALL,model:'openai/gpt-oss-120b',keyIdentity,accountBalance:'UNKNOWN',expiresAt:Date.now()+600_000};
 const qJson=JSON.stringify(quote);
 if(body.step==='quote'){
  if(body.sourceHash!==sourceHash||body.manifestSha256!==manifest.manifestSha256||body.confirmFreeOnly!==true||body.acknowledgeUnknownBalance!==true)throw new InputError('현재 원본·무료 조건·미확인 계정 잔여량을 확인하세요.');
  const existing=await env.DB.prepare("SELECT state,result_json FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-summary-synthesis-quote'").bind(qId,id).first();
  if(existing){if(existing.state!=='ISSUED')fail('SYNTHESIS_QUOTE_CHANGED','기존 견적 상태를 확인하세요.');return {quoteId:qId,quote:JSON.parse(existing.result_json),quoteSha256:await digest(existing.result_json),reused:true};}
  const inserted=await env.DB.prepare("INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,j.id,'groq-summary-synthesis-quote',0,'ISSUED',?,? FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.provider='deletion' AND d.state='DELETING')").bind(qId,now(),qJson,id,JSON.stringify(job.audit),source.raw,source.segments_json,id+':deleting').run();
  if(inserted.meta?.changes!==1)fail('SYNTHESIS_QUOTE_CHANGED','견적 저장 중 원본 또는 작업이 변경됐습니다.');
  return {quoteId:qId,quote,quoteSha256:await digest(qJson),reused:false};
 }
 const savedQuote=await env.DB.prepare("SELECT state,result_json FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-summary-synthesis-quote'").bind(qId,id).first();
 if(!savedQuote||savedQuote.state!=='ISSUED')fail('SYNTHESIS_QUOTE_REQUIRED','별도 종합 견적이 필요합니다.');
 let trusted;try{trusted=JSON.parse(savedQuote.result_json);}catch{fail('SYNTHESIS_QUOTE_CHANGED','저장된 종합 견적을 확인하세요.');}
 if(trusted.contract!==COMPLETE_SYNTHESIS_CONTRACT||trusted.jobId!==id||trusted.sourceHash!==sourceHash||trusted.manifestSha256!==manifest.manifestSha256||trusted.windowStart!==windowStart||start>=windowStart+trusted.maxCalls||(!active&&(trusted.firstNode!==progress.next.key||trusted.firstRequestSha256!==progress.next.requestSha256||trusted.maxCalls!==maxCalls||trusted.reservedUnits!==maxCalls*PER_CALL))||trusted.perCallUnits!==PER_CALL||trusted.model!=='openai/gpt-oss-120b'||trusted.keyIdentity!==keyIdentity||trusted.expiresAt<=Date.now())fail('SYNTHESIS_QUOTE_CHANGED','견적의 원본·키·기간이 변경됐습니다.');
 if(body.step==='approve'){
  if(body.quoteId!==qId||body.quoteSha256!==await digest(savedQuote.result_json)||body.reservedUnits!==trusted.reservedUnits||body.maxCalls!==trusted.maxCalls||body.confirmExactQuote!==true||body.freeTierConfirmed!==true||body.billingDisabled!==true||body.noPaidFallback!==true||body.noAutomaticRetry!==true)throw new InputError('종합 견적·무료 전용·상한을 별도로 승인하세요.');
  const approval={contract:COMPLETE_SYNTHESIS_CONTRACT,quoteId:qId,quoteSha256:await digest(savedQuote.result_json),jobId:id,sourceHash,manifestSha256:manifest.manifestSha256,windowStart:start,maxCalls,perCallUnits:PER_CALL,keyIdentity,approvedAt:Date.now(),expiresAt:Math.min(trusted.expiresAt,Date.now()+600_000)};
  const inserted=await env.DB.prepare("INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,j.id,'groq-summary-synthesis-approval',?,'APPROVED',?,? FROM jobs j JOIN yta_sources s ON s.job_id=j.id JOIN yta_operations q ON q.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND q.id=? AND q.provider='groq-summary-synthesis-quote' AND q.state='ISSUED' AND q.result_json=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.provider='deletion' AND d.state='DELETING')").bind(aId,trusted.reservedUnits,now(),JSON.stringify(approval),id,JSON.stringify(job.audit),source.raw,source.segments_json,qId,savedQuote.result_json,id+':deleting').run();
  if(inserted.meta?.changes!==1)fail('SYNTHESIS_APPROVAL_CHANGED','종합 승인 또는 원본이 변경됐습니다.');
  return {approved:true,approvalId:aId,windowStart:start,maxCalls,expiresAt:approval.expiresAt,accountBalance:'UNKNOWN'};
 }
 const savedApproval=await env.DB.prepare("SELECT state,result_json FROM yta_operations WHERE id=? AND job_id=? AND provider='groq-summary-synthesis-approval'").bind(aId,id).first();
 if(!savedApproval||savedApproval.state!=='APPROVED')fail('SYNTHESIS_APPROVAL_REQUIRED','별도 종합 승인이 필요합니다.');
 let approval;try{approval=JSON.parse(savedApproval.result_json);}catch{fail('SYNTHESIS_APPROVAL_CHANGED','저장된 종합 승인을 검토하세요.');}
 if(approval.contract!==COMPLETE_SYNTHESIS_CONTRACT||approval.quoteId!==qId||approval.quoteSha256!==await digest(savedQuote.result_json)||approval.sourceHash!==sourceHash||approval.manifestSha256!==manifest.manifestSha256||approval.windowStart!==windowStart||start>=windowStart+approval.maxCalls||approval.keyIdentity!==keyIdentity||approval.expiresAt<=Date.now())fail('SYNTHESIS_APPROVAL_CHANGED','종합 승인 범위·키·만료가 변경됐습니다.');
 if(body.step==='cancel'){
  if(body.approvalId!==aId||body.confirmCancel!==true)throw new InputError('취소할 종합 승인을 확인하세요.');
  const stopped=await env.DB.prepare("UPDATE yta_operations SET state='STOPPED' WHERE id=? AND job_id=? AND provider='groq-summary-synthesis-approval' AND state='APPROVED' AND result_json=?").bind(aId,id,savedApproval.result_json).run();
  if(stopped.meta?.changes!==1)fail('SYNTHESIS_APPROVAL_CHANGED','종합 승인 취소 상태가 변경됐습니다.');return claimedOutcomeUnsettled?{approvalStopped:true,claimedRequestOutcome:'UNKNOWN',providerCalls:'UNKNOWN',reviewRequired:true}:{cancelled:true,providerCalls:0};
 }
 if(body.step!=='execute'||body.approvalId!==aId||body.expectedNode!==progress.next.key||body.requestSha256!==progress.next.requestSha256||body.executeOnce!==true)throw new InputError('현재 다음 종합 노드만 한 번 실행하세요.');
 const excluded=[...failures.flatMap(item=>item.evidence.map(evidence=>evidence.operationId)),...recoveredFailureIds];
 await sharedLedger(env,excluded);
 const recentCutoff=new Date(Date.now()-SPACING_MS).toISOString(),minuteCutoff=new Date(Date.now()-60_000).toISOString(),dayCutoff=new Date(Date.now()-86_400_000).toISOString();
 const claim=await env.DB.prepare(`INSERT OR IGNORE INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) SELECT ?,j.id,'groq-summary-synthesis',?,'CLAIMED',?,? FROM jobs j JOIN yta_sources s ON s.job_id=j.id JOIN yta_operations a ON a.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND a.id=? AND a.provider='groq-summary-synthesis-approval' AND a.state='APPROVED' AND a.result_json=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.provider='deletion' AND d.state='DELETING') AND NOT EXISTS(SELECT 1 FROM yta_operations o WHERE ${sharedProvider.replaceAll('provider','o.provider')} AND o.state='CLAIMED') AND NOT EXISTS(SELECT 1 FROM yta_operations o WHERE ${sharedProvider.replaceAll('provider','o.provider')} AND o.state='FAILED_UNCERTAIN' AND o.id NOT IN (SELECT value FROM json_each(?))) AND ${recoveryProofSql} AND COALESCE((SELECT SUM(o.units) FROM yta_operations o WHERE ${sharedProvider.replaceAll('provider','o.provider')} AND o.${counted.replaceAll('state','state')} AND o.created_at>?),0)+?<=? AND COALESCE((SELECT SUM(o.units) FROM yta_operations o WHERE ${sharedProvider.replaceAll('provider','o.provider')} AND o.${counted.replaceAll('state','state')} AND o.created_at>?),0)+?<=? AND NOT EXISTS(SELECT 1 FROM yta_operations o WHERE ${sharedProvider.replaceAll('provider','o.provider')} AND o.state='DONE' AND o.created_at>?)`).bind(opId,PER_CALL,now(),JSON.stringify({key:progress.next.key,requestSha256:progress.next.requestSha256,approvalId:aId}),id,JSON.stringify(job.audit),source.raw,source.segments_json,aId,savedApproval.result_json,id+':deleting',JSON.stringify(excluded),JSON.stringify(recoveryProofs),minuteCutoff,PER_CALL,MINUTE_CAP,dayCutoff,PER_CALL,DAY_CAP,recentCutoff).run();
 if(claim.meta?.changes!==1)fail('SYNTHESIS_CLAIM_BLOCKED','동시 요청·미확정 호출·공유 상한 또는 간격을 확인하세요.');
 let dispatched=false,result=null,usageEventId=null,checkpointValidated=false;
 const guard=async()=>{
  const fresh=await ownedJob(env,id),current=await completeSource(env,fresh,sourceOf);
  if(current.transcriptHash!==sourceHash||JSON.stringify(fresh.audit)!==JSON.stringify(job.audit)||env.ENABLE_COMPLETE_SYNTHESIS!=='true'||env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true'||approval.expiresAt<=Date.now()||await capacityIdentity(env,'groq')!==keyIdentity)fail('SYNTHESIS_DISPATCH_CHANGED','원본·승인·키 또는 무료 조건이 변경됐습니다.');
  const credential=await env.DB.prepare("SELECT cipher_version,iv_b64,ciphertext_b64,updated_at FROM provider_credentials WHERE owner_id='owner' AND provider='groq'").first();
  if(await capacityIdentityForCredentialSnapshot(env,'groq',credential)!==keyIdentity)fail('SYNTHESIS_DISPATCH_CHANGED','승인한 키 세대가 변경됐습니다.');
  const row=await env.DB.prepare(`SELECT 1 AS ok FROM yta_operations a JOIN yta_operations o ON o.job_id=a.job_id JOIN jobs j ON j.id=a.job_id JOIN yta_sources s ON s.job_id=j.id WHERE a.id=? AND a.provider='groq-summary-synthesis-approval' AND a.state='APPROVED' AND a.result_json=? AND o.id=? AND o.provider='groq-summary-synthesis' AND o.state='CLAIMED' AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.provider='deletion' AND d.state='DELETING') AND NOT EXISTS(SELECT 1 FROM yta_operations x WHERE x.provider IN ('groq-summary','groq-summary-synthesis') AND x.state='CLAIMED' AND x.id!=?) AND ${recoveryProofSql} AND ((?=0 AND NOT EXISTS(SELECT 1 FROM provider_credentials c WHERE c.owner_id='owner' AND c.provider='groq')) OR (?=1 AND EXISTS(SELECT 1 FROM provider_credentials c WHERE c.owner_id='owner' AND c.provider='groq' AND c.cipher_version=? AND c.iv_b64=? AND c.ciphertext_b64=? AND c.updated_at=?)))`).bind(aId,savedApproval.result_json,opId,JSON.stringify(job.audit),source.raw,source.segments_json,id+':deleting',opId,JSON.stringify(recoveryProofs),credential?1:0,credential?1:0,credential?.cipher_version??null,credential?.iv_b64??null,credential?.ciphertext_b64??null,credential?.updated_at??null).first();
  if(!row||approval.expiresAt<=Date.now()||env.ENABLE_COMPLETE_SYNTHESIS!=='true'||env.ENABLE_LIVE_FREE!=='true'||env.ALLOW_PAID_API==='true')fail('SYNTHESIS_DISPATCH_CHANGED','최종 D1 승인·작업 범위가 변경됐습니다.');
 };
 try{
  result=await runOwnedGroqSummary({env:{...env,GROQ_FREE_PLAN_CONFIRMED:'true'},messages:progress.next.request.messages,maxCompletionTokens:COMPLETE_SYNTHESIS_OUTPUT_LIMIT,reviewTextLimit:1_000_000,beforeDispatch:guard,beforeFetch:async()=>{await guard();dispatched=true;}});
  if(result.inputTokens>progress.next.request.inputUpper||result.totalTokens>PER_CALL)fail('SYNTHESIS_USAGE_OVER_BOUND','제공자 사용량이 승인 범위를 넘었습니다.');
  const record=await persistedSynthesisNode({next:progress.next,response:result.text,sourceSegments:source.segments,verifyGrounding});
  checkpointValidated=true;
  const nextUsageEventId=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SYNTHESIS','actual_total_tokens',?,0,NULL,'PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN',?)").bind(nextUsageEventId,id,result.totalTokens,now()).run();
  usageEventId=nextUsageEventId;
  const saved={...record,usage:result.usage,usageEventId,approvalId:aId,requestScopeSha256:await digest(savedApproval.result_json)};
  const updated=await env.DB.prepare("UPDATE yta_operations SET state='DONE',result_json=?,created_at=? WHERE id=? AND job_id=? AND provider='groq-summary-synthesis' AND state='CLAIMED' AND EXISTS(SELECT 1 FROM jobs j JOIN yta_sources s ON s.job_id=j.id WHERE j.id=? AND j.owner_id='owner' AND j.audit_json=? AND (j.report_json IS NULL OR j.report_json='null') AND s.raw=? AND s.segments_json=? AND NOT EXISTS(SELECT 1 FROM yta_operations d WHERE d.id=? AND d.provider='deletion' AND d.state='DELETING'))").bind(JSON.stringify(saved),now(),opId,id,id,JSON.stringify(job.audit),source.raw,source.segments_json,id+':deleting').run();
  if(updated.meta?.changes!==1)fail('SYNTHESIS_SAVE_UNCERTAIN','종합 노드 저장 상태를 확인하세요.');
  return {saved:true,node:progress.next.key,completedNodes:start+1,remainingAccountTokens:'UNKNOWN',providerCalls:1};
 }catch(error){
  const usage=result?.usage??error.reviewResult?.usage;
  if(usage&&int(usage.totalTokens)&&!usageEventId){usageEventId=crypto.randomUUID();try{await env.DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SYNTHESIS','actual_total_tokens',?,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").bind(usageEventId,id,usage.totalTokens,now()).run();}catch{}}
  await env.DB.prepare("UPDATE yta_operations SET state=?,error_code=?,result_json=CASE WHEN EXISTS(SELECT 1 FROM jobs WHERE id=? AND owner_id='owner') AND NOT EXISTS(SELECT 1 FROM yta_operations WHERE id=? AND provider='deletion' AND state='DELETING') THEN ? ELSE NULL END,created_at=? WHERE id=? AND job_id=? AND state='CLAIMED'").bind(dispatched?'FAILED_UNCERTAIN':'BLOCKED',String(error.code||error.message||'SYNTHESIS_OUTCOME_UNKNOWN'),id,id+':deleting',JSON.stringify({key:progress.next.key,requestSha256:progress.next.requestSha256,partialText:(result?.text??error.reviewResult?.partialText??'').slice(0,1_000_000),usage:usage??null,usageEventId,dispatched,responseComplete:Boolean(result&&checkpointValidated),approvalId:aId,approvalResultSha256:await digest(savedApproval.result_json)}),now(),opId,id).run();
  await env.DB.prepare("UPDATE yta_operations SET state='STOPPED' WHERE id=? AND state='APPROVED'").bind(aId).run();
  throw error;
 }
}
