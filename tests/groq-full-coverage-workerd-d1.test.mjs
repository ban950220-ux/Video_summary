import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {routeApi} from '../src/worker.mjs';
import {promptAudit,partitionGroqTranscript} from '../src/groq-summary.mjs';
import {capacityIdentity} from '../src/observed-capacity.mjs';
import {planPersistedFullCoverage} from '../src/groq-full-coverage.mjs';
import {fullCoverageGlobalContext,fullCoverageGlobalProgress} from '../src/groq-full-coverage-global.mjs';
import {persistedSynthesisNode} from '../src/groq-complete-synthesis.mjs';
import {assertGrounding} from '../src/groq-summary.mjs';

const request=(path,method='GET',body)=>new Request('https://test.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
const statements=file=>readFileSync(new URL(file,import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n').split(';').map(sql=>sql.trim()).filter(Boolean);
const sha=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
const item=(text,ids)=>({text,evidenceIds:ids});
const report=group=>({summary:[item('요약 근거',[group[0].id,group.at(-1).id])],chapters:[item('구간 근거',[group[0].id,group.at(-1).id])],claims:[],numbers:[],critical:[],conclusion:'원문 근거 요약'});
const parsed=async(response,expected=200)=>{const text=await response.text();assert.equal(response.status,expected,text);return JSON.parse(text);};
const routed=async(request,env)=>{
 let count=0;const base=env.DB,bySql=new Map();
 const wrap=(stmt,sql)=>({bind(...args){assert.ok(args.length<=100,'D1 bind count');return wrap(stmt.bind(...args),sql);},async first(){count++;bySql.set(sql,(bySql.get(sql)||0)+1);return stmt.first();},async all(){count++;bySql.set(sql,(bySql.get(sql)||0)+1);return stmt.all();},async run(){count++;bySql.set(sql,(bySql.get(sql)||0)+1);return stmt.run();}});
 const response=await routeApi(request,{...env,DB:{prepare(sql){assert.ok(Buffer.byteLength(sql)<=100000,'D1 SQL length');return wrap(base.prepare(sql),sql);}}});
 assert.ok(count<=50,`D1 query budget exceeded: ${count} ${request.method} ${new URL(request.url).pathname} ${JSON.stringify([...bySql].map(([sql,n])=>[n,sql.slice(0,85)]).sort((a,b)=>b[0]-a[0]).slice(0,10))}`);
 return response;
};

test('full 1226 segment Workerd D1 flow stores fixture leaves, resumes, finalizes and exports TXT',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'full-coverage-local',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'full-coverage-local'}}]})),oldFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const lockMigration=readFileSync(new URL('../migrations/0016_full_coverage_write_lock.sql',import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n');
  for(const body of lockMigration.split('END;').filter(text=>text.trim()))await DB.prepare(body+'END;').run();
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',ENABLE_FULL_COVERAGE:'true',GROQ_API_KEY:'OFFLINE_TEST_ONLY_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')};
  const created=await parsed(await routed(request('/api/jobs','POST',{sourceType:'audio',durationSeconds:5892.864,title:'Fixture full source'}),env),202),id=created.job.id,path='/api/jobs/'+id,now=new Date(Date.now()-2*86_400_000).toISOString();
  const segments=Array.from({length:1226},(_,i)=>({id:i+1,startMs:Math.floor(i*5892864/1226),endMs:Math.floor((i+1)*5892864/1226),text:[`논점 ${i+1}: ${i+1}% 늘었다`,`반론 ${i+1}: ${i+1}명이 줄었다`,`불확실 ${i+1}: 자료가 부족하다`,`미확인 ${i+1}: 그럴 수 있다`][(i+1)%4].padEnd(36,'가')+' '+(i+1)}));
  const raw=segments.map(s=>s.text).join('\n'),audit={audioProcessing:'ALL_PLANNED_CHUNKS_PROCESSED',audioProcessingCoverage:1,audioFileSha256:'a'.repeat(64),audioSegmentOrigins:[],audioBoundaryAmbiguities:Array.from({length:47},(_,i)=>({segmentId:2+i*25,chunkIndex:i+1,startMs:0,endMs:1}))};
  await DB.prepare('UPDATE jobs SET audit_json=? WHERE id=?').bind(JSON.stringify(audit),id).run();
  await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(id,raw,JSON.stringify(segments),'GROQ_OWNED_AUDIO',now).run();
  const legacy=await parsed(await routed(request(path+'/groq-summary-plan'),env));
  assert.equal(legacy.rawStages,79);
  const groups=partitionGroqTranscript(segments,promptAudit({audit,duration_seconds:5892.864}));
  for(let i=0;i<8;i++)await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',6600,'DONE',?,?)").bind(id+':groq-summary:'+legacy.transcriptHash+':raw:'+i,id,now,JSON.stringify({hash:legacy.transcriptHash,key:'raw:'+i,report:report(groups[i])})).run();
  const failedId=id+':groq-summary:'+legacy.transcriptHash+':raw:8',failedText=JSON.stringify({...report(groups[8]),summary:[item('검증 실패 999명',[groups[8][0].id])]}),failedResult=JSON.stringify({reviewResult:{partialText:failedText,usage:{inputTokens:1152,outputTokens:987,reasoningTokens:50,totalTokens:2139}}});
  await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").bind(failedId,id,now,failedResult).run();
  await DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2139,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").bind(id+':old-usage',id,now).run();
  const correctionId=id+':groq-summary:correction:'+legacy.transcriptHash+':raw:8:attempt',correctionResult=JSON.stringify({reviewResult:{partialText:failedText,usage:{inputTokens:1130,outputTokens:1576,reasoningTokens:53,totalTokens:2706}}});
  await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary',6600,'FAILED_UNCERTAIN',?,'SUMMARY_RESPONSE_INVALID',?)").bind(correctionId,id,now,correctionResult).run();
  await DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',2706,0,NULL,'PROVIDER_REPORTED_CORRECTIVE_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").bind(id+':old-correction-usage',id,now).run();
  const unbound=await parsed(await routed(request(path+'/groq-full-coverage'),env));assert.equal(unbound.freeKeyBindingVerified,false);
  const denied=await routed(request(path+'/groq-full-coverage','POST',{step:'approve',planSha256:unbound.planSha256,maxRequests:1,confirmFreePlanAndBillingDisabled:true,acknowledgeAccountRemainingUnknown:true,acknowledgeNewCallForUncertainRaw8:true,noPaidFallback:true,noAutoRetry:true}),env);assert.equal(denied.status,409);
  const identity=await capacityIdentity(env,'groq'),unsigned={identity,organizationPlan:'Free',billingDisabled:true,confirmedAt:Date.now(),expiresAt:Date.now()+3_600_000},proof={...unsigned,recordSha256:await sha(JSON.stringify(unsigned))};env.GROQ_FREE_ORG_BINDING_JSON=JSON.stringify(proof);
  const initial=await parsed(await routed(request(path+'/groq-full-coverage'),env));
  assert.equal(initial.sourceSegments,1226);assert.equal(initial.reusedLegacy,8);assert.ok(initial.requiredNewRequests>0);assert.equal(initial.freeKeyBindingVerified,true);
  let calls=0;globalThis.fetch=async(url,options)=>{
   assert.equal(new URL(url).hostname,'api.groq.com');calls++;
   if(calls===1){
    const raw0=id+':groq-summary:'+legacy.transcriptHash+':raw:0';
    for(const statement of [
     DB.prepare("UPDATE yta_sources SET raw='changed' WHERE job_id=?").bind(id),
     DB.prepare("UPDATE jobs SET audit_json='{}' WHERE id=?").bind(id),
     DB.prepare("UPDATE yta_operations SET result_json='{}' WHERE id=?").bind(raw0),
     DB.prepare("UPDATE yta_operations SET state='STOPPED' WHERE job_id=? AND provider='groq-full-coverage-approval' AND state='APPROVED'").bind(id),
     DB.prepare('UPDATE usage_events SET used_units=used_units+1 WHERE id=?').bind(id+':old-usage'),
     DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',0,'BLOCKED',?,'{}')").bind(id+':forbidden-old-insert',id,now),
     DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SUMMARY','actual_total_tokens',1,0,'TEST',?)").bind(id+':forbidden-old-usage',id,now)
    ])await assert.rejects(statement.run(),/FULL_COVERAGE_.*_LOCKED/);
   }
   const message=JSON.parse(options.body).messages[1].content,parts=message.includes('Source [id,text]:\n')?JSON.parse(message.split('Source [id,text]:\n')[1]):null,nodes=parts?null:JSON.parse(message.split('\n').at(-1)),ids=parts?[parts[0][0],parts.at(-1)[0]]:[...new Set(nodes.flatMap(node=>node.evidenceAnchors))],value={summary:[item('fixture evidence',ids)],chapters:[item('fixture evidence',ids)],claims:[],numbers:[],critical:[],conclusion:'fixture conclusion'};
   return Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390}});
  };
  let status=initial;
  for(let i=0;i<initial.requiredNewRequests;i++){
   if(status.approvalState!=='APPROVED')await parsed(await routed(request(path+'/groq-full-coverage','POST',{step:'approve',planSha256:status.planSha256,maxRequests:Math.min(5,status.remainingNewRequests),confirmFreePlanAndBillingDisabled:true,acknowledgeAccountRemainingUnknown:true,acknowledgeNewCallForUncertainRaw8:true,noPaidFallback:true,noAutoRetry:true}),env));
   status=await parsed(await routed(request(path+'/groq-full-coverage'),env));
   let executeEnv=env,intercepted=false,interceptedSql=null;
   if(i===0){
    let checkedAtLastSql=false;
    const blockedEnv={...env,DB:{prepare(sql){if(sql.includes('SELECT 1 AS ok FROM yta_operations o WHERE o.id='))return {bind(){return {async first(){checkedAtLastSql=true;return null;}}}};return DB.prepare(sql);}}};
    const blocked=await parsed(await routed(request(path+'/groq-full-coverage','POST',{step:'execute',executeOnce:true,planSha256:status.planSha256,expectedStage:status.nextStage}),blockedEnv));
    assert.equal(checkedAtLastSql,true);assert.equal(blocked.state,'BLOCKED');assert.equal(calls,0);
    const held=await parsed(await routed(request(path+'/groq-full-coverage'),env));assert.equal(held.operationState,'BLOCKED');
    assert.equal((await routed(request(path+'/groq-full-coverage','POST',{step:'execute',executeOnce:true,planSha256:held.planSha256,expectedStage:held.nextStage}),env)).status,409);
    await parsed(await routed(request(path+'/groq-full-coverage','POST',{step:'approve',planSha256:held.planSha256,maxRequests:5,confirmFreePlanAndBillingDisabled:true,acknowledgeAccountRemainingUnknown:true,acknowledgeNewCallForUncertainRaw8:true,noPaidFallback:true,noAutoRetry:true}),env));
    const renewed=await parsed(await routed(request(path+'/groq-full-coverage'),env));
    const reopened=await parsed(await routed(request(path+'/groq-full-coverage','POST',{step:'reopen-blocked',planSha256:renewed.planSha256,expectedStage:renewed.nextStage,confirmNoProviderCall:true}),env));
    assert.equal(reopened.providerCalls,0);assert.equal(calls,0);
    assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider='groq-full-coverage-blocked-review' AND state='REVIEWED'").bind(id).first()).n,1);
    status=await parsed(await routed(request(path+'/groq-full-coverage'),env));assert.equal(status.stageState,'PENDING');
   }
   if(i===0){executeEnv={...env,DB:{prepare(sql){if(!intercepted&&sql.includes('INSERT OR IGNORE INTO usage_events'))return {bind(){return {async run(){intercepted=true;interceptedSql=sql;throw Error('FIXTURE_SETTLEMENT_WRITE_FAILURE');}}}};return DB.prepare(sql);}}};}
   const done=await parsed(await routed(request(path+'/groq-full-coverage','POST',{step:'execute',executeOnce:true,planSha256:status.planSha256,expectedStage:status.nextStage}),executeEnv));
   if(i===0){assert.equal(intercepted,true);assert.equal(done.state,'REVIEW_REQUIRED',JSON.stringify({done,interceptedSql}));assert.equal(done.reason,'RECEIPT_PERSISTENCE_UNKNOWN');const held=await parsed(await routed(request(path+'/groq-full-coverage'),env));assert.equal(held.operationState,'RECEIPT_STORED');assert.equal(calls,1);const repeated=await routed(request(path+'/groq-full-coverage','POST',{step:'execute',executeOnce:true,planSha256:held.planSha256,expectedStage:held.nextStage}),env);assert.equal(repeated.status,409);assert.equal(calls,1);const recovered=await parsed(await routed(request(path+'/groq-full-coverage','POST',{step:'recover-receipt',planSha256:held.planSha256,expectedStage:held.nextStage,responseSha256:held.recoveryResponseSha256}),env));assert.equal(recovered.providerCalls,0);}else assert.equal(done.state,'DONE',JSON.stringify(done));
   await DB.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-full-coverage' AND state='DONE'").bind(now,id).run();
   status=await parsed(await routed(request(path+'/groq-full-coverage'),env));
  }
  assert.equal(status.stageState,'READY_TO_FINALIZE');assert.equal(calls,initial.requiredNewRequests);
  const globalStatus=await parsed(await routed(request(path+'/groq-full-coverage-global'),env));
  assert.equal(globalStatus.sourceCoverageComplete,true);assert.equal(globalStatus.globalSynthesisComplete,false);assert.ok(globalStatus.requiredGlobalNodes>0);
  const globalQuote=await parsed(await routed(request(path+'/groq-full-coverage-global','POST',{step:'quote',sourceHash:globalStatus.sourceHash,manifestSha256:globalStatus.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),env));
  let globalApproval=await parsed(await routed(request(path+'/groq-full-coverage-global','POST',{step:'approve',sourceHash:globalStatus.sourceHash,manifestSha256:globalStatus.manifestSha256,quoteId:globalQuote.quoteId,quoteSha256:globalQuote.quoteSha256,reservedUnits:globalQuote.quote.reservedUnits,maxCalls:globalQuote.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}),env));
  const globalExecuted=await parsed(await routed(request(path+'/groq-full-coverage-global','POST',{step:'execute',sourceHash:globalStatus.sourceHash,manifestSha256:globalStatus.manifestSha256,approvalId:globalApproval.approvalId,expectedNode:globalStatus.nextNode,requestSha256:globalStatus.nextRequestSha256,executeOnce:true}),env));
  assert.equal(globalExecuted.saved,true);assert.equal((await parsed(await routed(request(path+'/groq-full-coverage-global'),env))).completedGlobalNodes,1);
  const jobRow=await DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first(),jobSnapshot={...jobRow,audit:JSON.parse(jobRow.audit_json),report:null},sourceOf=async(e,jid)=>{const row=await e.DB.prepare('SELECT * FROM yta_sources WHERE job_id=?').bind(jid).first();return {...row,segments:JSON.parse(row.segments_json)};};
  const {plan:fullPlan}=await planPersistedFullCoverage(env,jobSnapshot,sourceOf);
  assert.equal(fullPlan.planSha256,status.planSha256);
  const fullRows=(await DB.prepare("SELECT result_json FROM yta_operations WHERE job_id=? AND provider='groq-full-coverage' AND state='DONE'").bind(id).all()).results,sectionRows=new Map(fullRows.map(row=>{const saved=JSON.parse(row.result_json);return [saved.key,{...saved,state:'DONE'}];}));
  const globalContext=await fullCoverageGlobalContext({plan:fullPlan,records:sectionRows,segments,raw,boundarySegmentIds:audit.audioBoundaryAmbiguities.map(item=>item.segmentId)});
  const firstSaved=await DB.prepare("SELECT result_json FROM yta_operations WHERE job_id=? AND provider='groq-summary-synthesis' AND state='DONE'").bind(id).first(),firstNode=JSON.parse(firstSaved.result_json),savedGlobalNodes=new Map([[firstNode.key,firstNode]]);
  let globalProgress=await fullCoverageGlobalProgress({context:globalContext,savedNodes:savedGlobalNodes,segments}),fixtureGlobalNodes=0;
  // A pre-dispatch failure retains a review row and needs a fresh approval before reopening.
  const blockedId=id+':groq-summary-complete:'+globalContext.sourceHash+':note:'+globalProgress.next.key;
  const priorGlobalApproval=await DB.prepare('SELECT result_json FROM yta_operations WHERE id=?').bind(globalApproval.approvalId).first();
  const blockedRecord={key:globalProgress.next.key,requestSha256:globalProgress.next.requestSha256,partialText:'',usage:null,usageEventId:null,dispatched:false,responseComplete:false,approvalId:globalApproval.approvalId,approvalResultSha256:await sha(priorGlobalApproval.result_json)};
  const blockedJson=JSON.stringify(blockedRecord);
  await DB.prepare("UPDATE yta_operations SET state='STOPPED' WHERE id=? AND provider='groq-summary-synthesis-approval'").bind(globalApproval.approvalId).run();
  await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary-synthesis',6600,'BLOCKED',?,'PRE_DISPATCH_GUARD_FAILED',?)").bind(blockedId,id,now,blockedJson).run();
  const blockedStatus=await parsed(await routed(request(path+'/groq-full-coverage-global'),env));assert.equal(blockedStatus.unsettledState,'BLOCKED');
  const renewQuote=await parsed(await routed(request(path+'/groq-full-coverage-global','POST',{step:'quote',sourceHash:blockedStatus.sourceHash,manifestSha256:blockedStatus.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),env));
  globalApproval=await parsed(await routed(request(path+'/groq-full-coverage-global','POST',{step:'approve',sourceHash:blockedStatus.sourceHash,manifestSha256:blockedStatus.manifestSha256,quoteId:renewQuote.quoteId,quoteSha256:renewQuote.quoteSha256,reservedUnits:renewQuote.quote.reservedUnits,maxCalls:renewQuote.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}),env));
  const beforeReopenCalls=calls;
  const reopened=await parsed(await routed(request(path+'/groq-full-coverage-global','POST',{step:'reopen-blocked',sourceHash:blockedStatus.sourceHash,manifestSha256:blockedStatus.manifestSha256,approvalId:globalApproval.approvalId,failedOperationId:blockedId,failedResultSha256:await sha(blockedJson),confirmNoProviderCall:true}),env));
  assert.equal(reopened.reopened,true);assert.equal(calls,beforeReopenCalls);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM yta_operations WHERE job_id=? AND provider=?').bind(id,'groq-summary-synthesis-blocked-review').first()).n,1);
  // A complete response followed by a failed acknowledgement is recovered from D1 without dispatch.
   const uncertainNext=globalProgress.next,uncertainRefs=[...new Set(uncertainNext.children.flatMap(node=>[node.evidenceIds[0],node.evidenceIds.at(-1)]))],uncertainResponse=JSON.stringify({summary:[item('fixture evidence',uncertainRefs)],chapters:[item('fixture evidence',uncertainRefs)],claims:[],numbers:[],critical:[],conclusion:'fixture conclusion'});
  const uncertainApproval=await DB.prepare('SELECT result_json FROM yta_operations WHERE id=?').bind(globalApproval.approvalId).first();
  const uncertainId=id+':groq-summary-complete:'+globalContext.sourceHash+':note:'+uncertainNext.key,uncertainUsageId=id+':fixture-uncertain-usage',uncertainRecord={key:uncertainNext.key,requestSha256:uncertainNext.requestSha256,partialText:uncertainResponse,usage:{inputTokens:300,outputTokens:90,totalTokens:390},usageEventId:uncertainUsageId,dispatched:true,responseComplete:true,approvalId:globalApproval.approvalId,approvalResultSha256:await sha(uncertainApproval.result_json)};
  const uncertainJson=JSON.stringify(uncertainRecord);
  await DB.prepare("UPDATE yta_operations SET state='STOPPED' WHERE id=? AND provider='groq-summary-synthesis-approval'").bind(globalApproval.approvalId).run();
  await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,error_code,result_json) VALUES(?,?,'groq-summary-synthesis',6600,'FAILED_UNCERTAIN',?,'ACK_LOST',?)").bind(uncertainId,id,now,uncertainJson).run();
  await DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SYNTHESIS','actual_total_tokens',390,0,NULL,'PROVIDER_REPORTED_FAILED_OUTPUT_ACCOUNT_REMAINING_UNKNOWN',?)").bind(uncertainUsageId,id,now).run();
  const uncertainStatus=await parsed(await routed(request(path+'/groq-full-coverage-global'),env));
  assert.equal(uncertainStatus.unsettledState,'FAILED_UNCERTAIN');assert.equal(uncertainStatus.recoveryCandidate?.providerCalls,0);
  const beforeRecoveryCalls=calls;
  const recoveredNode=await parsed(await routed(request(path+'/groq-full-coverage-global','POST',{step:'recover-node',sourceHash:uncertainStatus.sourceHash,manifestSha256:uncertainStatus.manifestSha256,failedOperationId:uncertainStatus.recoveryCandidate.failedOperationId,responseSha256:uncertainStatus.recoveryCandidate.responseSha256,usageTotalTokens:uncertainStatus.recoveryCandidate.usageTotalTokens,confirmNoProviderCall:true,confirmOriginalFailurePreserved:true}),env));
  assert.equal(recoveredNode.recovered,true);assert.equal(calls,beforeRecoveryCalls);
  assert.deepEqual(await DB.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').bind(uncertainId).first(),{state:'FAILED_UNCERTAIN',result_json:uncertainJson});
  const recoveredSaved=await DB.prepare("SELECT result_json FROM yta_operations WHERE job_id=? AND provider='groq-summary-synthesis-recovery'").bind(id).first();
  savedGlobalNodes.set(uncertainNext.key,JSON.parse(recoveredSaved.result_json));
  globalProgress=await fullCoverageGlobalProgress({context:globalContext,savedNodes:savedGlobalNodes,segments});
  while(!globalProgress.complete){
    const next=globalProgress.next,refs=[...new Set(next.children.flatMap(node=>[node.evidenceIds[0],node.evidenceIds.at(-1)]))],response=JSON.stringify({summary:[item('fixture evidence',refs)],chapters:[item('fixture evidence',refs)],claims:[],numbers:[],critical:[],conclusion:'fixture conclusion'});
   const persisted=await persistedSynthesisNode({next,response,sourceSegments:segments,verifyGrounding:assertGrounding}),usageEventId=id+':fixture-global-usage:'+fixtureGlobalNodes,operationId=id+':groq-summary-complete:'+globalContext.sourceHash+':note:'+next.key,saved={...persisted,usage:{inputTokens:300,outputTokens:90,totalTokens:390},usageEventId,approvalId:globalApproval.approvalId};
   await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary-synthesis',6600,'DONE',?,?)").bind(operationId,id,now,JSON.stringify(saved)).run();
   await DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SYNTHESIS','actual_total_tokens',390,0,NULL,'PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN',?)").bind(usageEventId,id,now).run();
   savedGlobalNodes.set(next.key,saved);fixtureGlobalNodes++;
   globalProgress=await fullCoverageGlobalProgress({context:globalContext,savedNodes:savedGlobalNodes,segments});
  }
  assert.ok(fixtureGlobalNodes>0);assert.equal((await parsed(await routed(request(path+'/groq-full-coverage-global'),env))).globalSynthesisComplete,true);
  for(const target of ['new-receipt','legacy-checkpoint']){
   const changedId=target==='new-receipt'?id+':groq-full-coverage:'+status.planSha256+':held-leaf:8':id+':groq-summary:'+legacy.transcriptHash+':raw:0',original=await DB.prepare('SELECT result_json FROM yta_operations WHERE id=?').bind(changedId).first();let changed=false;
   const changedFinalEnv={...env,DB:{prepare(sql){if(sql.startsWith('UPDATE jobs SET report_json='))return {bind(...args){const stmt=DB.prepare(sql).bind(...args);return {async run(){await DB.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').bind('{}',changedId).run();changed=true;return stmt.run();}}}};return DB.prepare(sql);}}};
   const deniedFinal=await routed(request(path+'/groq-full-coverage-global','POST',{step:'finalize',sourceHash:globalStatus.sourceHash,manifestSha256:globalStatus.manifestSha256,confirmNoProviderCall:true}),changedFinalEnv);
   assert.equal(changed,true);assert.notEqual(deniedFinal.status,200);assert.ok([null,'null'].includes((await DB.prepare('SELECT report_json FROM jobs WHERE id=?').bind(id).first()).report_json));
   await DB.prepare('UPDATE yta_operations SET result_json=? WHERE id=?').bind(original.result_json,changedId).run();
  }
  for(const usageId of [id+':old-usage',id+':groq-full-coverage:'+status.planSha256+':held-leaf:8:usage']){
   const original=await DB.prepare('SELECT used_units FROM usage_events WHERE id=?').bind(usageId).first();let changed=false;
   const changedFinalEnv={...env,DB:{prepare(sql){if(sql.startsWith('UPDATE jobs SET report_json='))return {bind(...args){const stmt=DB.prepare(sql).bind(...args);return {async run(){await DB.prepare('UPDATE usage_events SET used_units=? WHERE id=?').bind(original.used_units+1,usageId).run();changed=true;return stmt.run();}}}};return DB.prepare(sql);}}};
   const deniedFinal=await routed(request(path+'/groq-full-coverage-global','POST',{step:'finalize',sourceHash:globalStatus.sourceHash,manifestSha256:globalStatus.manifestSha256,confirmNoProviderCall:true}),changedFinalEnv);
   assert.equal(changed,true);assert.notEqual(deniedFinal.status,200);assert.ok([null,'null'].includes((await DB.prepare('SELECT report_json FROM jobs WHERE id=?').bind(id).first()).report_json));
   await DB.prepare('UPDATE usage_events SET used_units=? WHERE id=?').bind(original.used_units,usageId).run();
  }
  const addedHistoricalId=id+':groq-summary:added-after-plan';let addedHistorical=false;
  const addedHistoricalEnv={...env,DB:{prepare(sql){if(sql.startsWith('UPDATE jobs SET report_json='))return {bind(...args){const stmt=DB.prepare(sql).bind(...args);return {async run(){await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,?,'groq-summary',0,'BLOCKED',?,'{}')").bind(addedHistoricalId,id,now).run();addedHistorical=true;return stmt.run();}}}};return DB.prepare(sql);}}};
  const addedHistoricalFinal=await routed(request(path+'/groq-full-coverage-global','POST',{step:'finalize',sourceHash:globalStatus.sourceHash,manifestSha256:globalStatus.manifestSha256,confirmNoProviderCall:true}),addedHistoricalEnv);
  assert.equal(addedHistorical,true);assert.notEqual(addedHistoricalFinal.status,200);
  assert.ok([null,'null'].includes((await DB.prepare('SELECT report_json FROM jobs WHERE id=?').bind(id).first()).report_json));
  await DB.prepare('DELETE FROM yta_operations WHERE id=?').bind(addedHistoricalId).run();
  const addedSynthesisUsage=id+':extra-synthesis-usage';let addedUsage=false;
  const addedUsageEnv={...env,DB:{prepare(sql){if(sql.startsWith('UPDATE jobs SET report_json='))return {bind(...args){const stmt=DB.prepare(sql).bind(...args);return {async run(){await DB.prepare("INSERT INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq','LIVE_FREE_SYNTHESIS','actual_total_tokens',1,0,NULL,'PROVIDER_REPORTED_ACCOUNT_REMAINING_UNKNOWN',?)").bind(addedSynthesisUsage,id,now).run();addedUsage=true;return stmt.run();}}}};return DB.prepare(sql);}}};
  const usageRace=await routed(request(path+'/groq-full-coverage-global','POST',{step:'finalize',sourceHash:globalStatus.sourceHash,manifestSha256:globalStatus.manifestSha256,confirmNoProviderCall:true}),addedUsageEnv);
  assert.equal(addedUsage,true);assert.notEqual(usageRace.status,200);assert.ok([null,'null'].includes((await DB.prepare('SELECT report_json FROM jobs WHERE id=?').bind(id).first()).report_json));
  await DB.prepare('DELETE FROM usage_events WHERE id=?').bind(addedSynthesisUsage).run();
  const finalized=await parsed(await routed(request(path+'/groq-full-coverage-global','POST',{step:'finalize',sourceHash:globalStatus.sourceHash,manifestSha256:globalStatus.manifestSha256,confirmNoProviderCall:true}),env));assert.equal(finalized.readBackVerified,true);assert.deepEqual(finalized.sourceCoverage,{segmentCount:1226,firstId:1,lastId:1226,missingSegmentIds:[]});
  const saved=await parsed(await routed(request(path),env));assert.equal(saved.job.report.compositionMode,'groq-full-coverage-global-v1');assert.equal(saved.job.report.globalSynthesisStatus,'MODEL_ROOT_VALIDATED_HUMAN_UNREVIEWED');
  const text=await(await routed(request(path+'/export?format=txt'),env)).text();assert.match(text,/Full source coverage audit/);assert.match(text,/1226/);assert.match(text,/The old operation remains uncertain/);
  assert.deepEqual(await DB.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').bind(failedId).first(),{state:'FAILED_UNCERTAIN',result_json:failedResult});
  assert.deepEqual(await DB.prepare('SELECT state,result_json FROM yta_operations WHERE id=?').bind(correctionId).first(),{state:'FAILED_UNCERTAIN',result_json:correctionResult});
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE job_id=? AND capability='LIVE_FREE_FULL_COVERAGE'").bind(id).first()).n,calls-1);
 }finally{globalThis.fetch=oldFetch;await mf.dispose();}
});

test('fresh imported transcript creates a separate idempotent job without old usage or transcription',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'fresh-transcript-local',modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:{DB:'fresh-transcript-local'}}]}));
 const oldFetch=globalThis.fetch;
 try{
  const DB=await mf.getD1Database('DB');for(const file of ['../schema.sql','../migrations/0002_live.sql'])for(const sql of statements(file))await DB.prepare(sql).run();
  const lockMigration=readFileSync(new URL('../migrations/0016_full_coverage_write_lock.sql',import.meta.url),'utf8').split('\n').filter(line=>!line.trim().startsWith('--')).join('\n');for(const body of lockMigration.split('END;').filter(text=>text.trim()))await DB.prepare(body+'END;').run();
  const env={DB,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',ENABLE_FULL_COVERAGE:'true',GROQ_API_KEY:'OFFLINE_TEST_ONLY_KEY',KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,7).toString('base64')};
  const originalId=crypto.randomUUID(),now=new Date().toISOString(),originalAudit=JSON.stringify({status:'TRANSCRIPT_UNVERIFIED'}),segments=Array.from({length:120},(_,i)=>({id:i+1,startMs:i*800,endMs:(i+1)*800,text:`원문 ${i+1}: 저장된 전사 구간의 사실과 근거입니다.`})),srt='fixture SRT from owner upload';
  await DB.prepare("INSERT INTO jobs(id,owner_id,title,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,'owner','Verified import','text','TRANSCRIPT_UNVERIFIED',97,?,?,?,?)").bind(originalId,now,now,JSON.stringify({kind:'EXTRACTIVE_ONLY_NOT_AI'}),originalAudit).run();
  await DB.prepare('INSERT INTO yta_sources(job_id,raw,segments_json,provenance,updated_at) VALUES(?,?,?,?,?)').bind(originalId,srt,JSON.stringify(segments),'SRT',now).run();
  const originalSnapshot=await DB.prepare('SELECT * FROM jobs WHERE id=?').bind(originalId).first(),sourceSha=await sha(srt),body={confirmSeparateNewJob:true,acknowledgeDuplicateSummaryTokens:true,confirmNoRetranscription:true,originalSourceSha256:sourceSha,expectedSegments:120};
  const first=await parsed(await routed(request('/api/jobs/'+originalId+'/groq-full-coverage-fresh','POST',body),env),201);
  const second=await parsed(await routed(request('/api/jobs/'+originalId+'/groq-full-coverage-fresh','POST',body),env),201);
  assert.equal(first.jobId,second.jobId);assert.equal(first.providerCalls,0);assert.equal(first.priorUsageCopied,false);assert.equal(first.transcriptionReused,true);
  assert.deepEqual(await DB.prepare('SELECT * FROM jobs WHERE id=?').bind(originalId).first(),originalSnapshot);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE job_id=?').bind(first.jobId).first()).n,0);
  const freshStatus=await parsed(await routed(request('/api/jobs/'+first.jobId+'/groq-full-coverage'),env));
  assert.equal(freshStatus.freshTranscriptJob,true);assert.equal(freshStatus.reusedLegacy,0);assert.equal(freshStatus.heldLegacy,null);assert.equal(freshStatus.sourceSegments,120);
  assert.equal((await routed(request('/api/jobs/'+first.jobId+'/groq-full-coverage','POST',{step:'approve',planSha256:freshStatus.planSha256,maxRequests:1,confirmFreePlanAndBillingDisabled:true,acknowledgeAccountRemainingUnknown:true,noPaidFallback:true,noAutoRetry:true}),env)).status,409);
  const identity=await capacityIdentity(env,'groq'),unsigned={identity,organizationPlan:'Free',billingDisabled:true,confirmedAt:Date.now(),expiresAt:Date.now()+3_600_000};env.GROQ_FREE_ORG_BINDING_JSON=JSON.stringify({...unsigned,recordSha256:await sha(JSON.stringify(unsigned))});
  const approved=await parsed(await routed(request('/api/jobs/'+first.jobId+'/groq-full-coverage','POST',{step:'approve',planSha256:freshStatus.planSha256,maxRequests:1,confirmFreePlanAndBillingDisabled:true,acknowledgeAccountRemainingUnknown:true,acknowledgeDuplicateSummaryTokens:true,noPaidFallback:true,noAutoRetry:true}),env));assert.equal(approved.approved,true);
  let calls=0;globalThis.fetch=async(url,options)=>{calls++;assert.equal(new URL(url).hostname,'api.groq.com');const content=JSON.parse(options.body).messages[1].content,entries=content.includes('Source [id,text]:\n')?JSON.parse(content.split('Source [id,text]:\n')[1]):null,nodes=entries?null:JSON.parse(content.split('\n').at(-1)),ids=entries?[entries[0][0],entries.at(-1)[0]]:[...new Set(nodes.flatMap(node=>node.evidenceAnchors))],response={summary:[item('fixture evidence',ids)],chapters:[item('fixture evidence',ids)],claims:[],numbers:[],critical:[],conclusion:'fixture conclusion'};return Response.json({model:'openai/gpt-oss-120b',choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}],usage:{prompt_tokens:300,completion_tokens:90,total_tokens:390}});};
  const ready=await parsed(await routed(request('/api/jobs/'+first.jobId+'/groq-full-coverage'),env));
  const executed=await parsed(await routed(request('/api/jobs/'+first.jobId+'/groq-full-coverage','POST',{step:'execute',executeOnce:true,planSha256:ready.planSha256,expectedStage:ready.nextStage}),env));
  assert.equal(executed.state,'DONE');assert.equal(calls,1);assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE job_id=?').bind(originalId).first()).n,0);
  const resumed=await parsed(await routed(request('/api/jobs/'+first.jobId+'/groq-full-coverage'),env));assert.equal(resumed.completedNewRequests,1);assert.equal(resumed.reusedLegacy,0);
  const freshPath='/api/jobs/'+first.jobId,oldTime=new Date(Date.now()-2*86_400_000).toISOString();
  await DB.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-full-coverage' AND state='DONE'").bind(oldTime,first.jobId).run();
  let cursor=await parsed(await routed(request(freshPath+'/groq-full-coverage'),env));
  while(cursor.stageState==='PENDING'){
   if(cursor.approvalState!=='APPROVED')await parsed(await routed(request(freshPath+'/groq-full-coverage','POST',{step:'approve',planSha256:cursor.planSha256,maxRequests:Math.min(5,cursor.remainingNewRequests),confirmFreePlanAndBillingDisabled:true,acknowledgeAccountRemainingUnknown:true,acknowledgeDuplicateSummaryTokens:true,noPaidFallback:true,noAutoRetry:true}),env));
   cursor=await parsed(await routed(request(freshPath+'/groq-full-coverage'),env));
   const one=await parsed(await routed(request(freshPath+'/groq-full-coverage','POST',{step:'execute',executeOnce:true,planSha256:cursor.planSha256,expectedStage:cursor.nextStage}),env));assert.equal(one.state,'DONE');
   await DB.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-full-coverage' AND state='DONE'").bind(oldTime,first.jobId).run();
   cursor=await parsed(await routed(request(freshPath+'/groq-full-coverage'),env));
  }
  assert.equal(cursor.stageState,'READY_TO_FINALIZE');
  let globalCursor=await parsed(await routed(request(freshPath+'/groq-full-coverage-global'),env));assert.equal(globalCursor.sourceCoverageComplete,true);
  while(!globalCursor.globalSynthesisComplete){
   if(!globalCursor.activeApproval){const quote=await parsed(await routed(request(freshPath+'/groq-full-coverage-global','POST',{step:'quote',sourceHash:globalCursor.sourceHash,manifestSha256:globalCursor.manifestSha256,confirmFreeOnly:true,acknowledgeUnknownBalance:true}),env));await parsed(await routed(request(freshPath+'/groq-full-coverage-global','POST',{step:'approve',sourceHash:globalCursor.sourceHash,manifestSha256:globalCursor.manifestSha256,quoteId:quote.quoteId,quoteSha256:quote.quoteSha256,reservedUnits:quote.quote.reservedUnits,maxCalls:quote.quote.maxCalls,confirmExactQuote:true,freeTierConfirmed:true,billingDisabled:true,noPaidFallback:true,noAutomaticRetry:true}),env));globalCursor=await parsed(await routed(request(freshPath+'/groq-full-coverage-global'),env));}
   if(globalCursor.completedGlobalNodes===0){
    const heldId='other-job:groq-full-coverage:unsettled-receipt',before=calls;
    await DB.prepare("INSERT INTO yta_operations(id,job_id,provider,units,state,created_at,result_json) VALUES(?,'other-job','groq-full-coverage',6500,'RECEIPT_STORED',?,'{}')").bind(heldId,new Date().toISOString()).run();
    const blocked=await routed(request(freshPath+'/groq-full-coverage-global','POST',{step:'execute',sourceHash:globalCursor.sourceHash,manifestSha256:globalCursor.manifestSha256,approvalId:globalCursor.activeApproval.approvalId,expectedNode:globalCursor.nextNode,requestSha256:globalCursor.nextRequestSha256,executeOnce:true}),env);
    assert.notEqual(blocked.status,200);assert.equal(calls,before);
    await DB.prepare('DELETE FROM yta_operations WHERE id=?').bind(heldId).run();
   }
   const one=await parsed(await routed(request(freshPath+'/groq-full-coverage-global','POST',{step:'execute',sourceHash:globalCursor.sourceHash,manifestSha256:globalCursor.manifestSha256,approvalId:globalCursor.activeApproval.approvalId,expectedNode:globalCursor.nextNode,requestSha256:globalCursor.nextRequestSha256,executeOnce:true}),env));assert.equal(one.saved,true);
   await DB.prepare("UPDATE yta_operations SET created_at=? WHERE job_id=? AND provider='groq-summary-synthesis' AND state='DONE'").bind(oldTime,first.jobId).run();
   globalCursor=await parsed(await routed(request(freshPath+'/groq-full-coverage-global'),env));
  }
  const finalized=await parsed(await routed(request(freshPath+'/groq-full-coverage-global','POST',{step:'finalize',sourceHash:globalCursor.sourceHash,manifestSha256:globalCursor.manifestSha256,confirmNoProviderCall:true}),env));assert.equal(finalized.readBackVerified,true);
  const savedFresh=await parsed(await routed(request(freshPath),env));assert.equal(savedFresh.job.report.compositionMode,'groq-full-coverage-global-v1');assert.equal(savedFresh.job.report.sectionReports.sourceMode,'FRESH_IMPORTED_TRANSCRIPT');
  const text=await(await routed(request(freshPath+'/export?format=txt'),env)).text();assert.match(text,/Full source coverage audit/);assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE job_id=?').bind(originalId).first()).n,0);
  const replay=await parsed(await routed(request('/api/jobs/'+originalId+'/groq-full-coverage-fresh','POST',body),env),201);assert.equal(replay.jobId,first.jobId);assert.equal(replay.alreadyCompleted,true);assert.equal(replay.providerCalls,0);
 }finally{globalThis.fetch=oldFetch;await mf.dispose();}
});
