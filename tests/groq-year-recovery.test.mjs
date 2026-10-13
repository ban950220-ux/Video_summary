import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertGrounding} from '../src/groq-summary.mjs';
import {abbreviatedYearRecoveryCandidate} from '../src/groq-year-recovery.mjs';

const segments=[{id:172,startMs:760568,endMs:768000,text:'2020년대의 22년 금리 1.5%를 언급했습니다.'},{id:173,startMs:770928,endMs:778000,text:'2020년대의 23년 물가 2%대를 언급했습니다.'}];
const response={summary:[{text:'2022년 금리 1.5%',evidenceIds:[172]},{text:'2023년 물가 2%대',evidenceIds:[173]}],chapters:[{text:'금리와 물가를 언급했습니다.',evidenceIds:[172,173]}],claims:[],numbers:[],critical:[],conclusion:'확인 범위 내 발언만 정리했습니다.'};
const result=JSON.stringify({reviewResult:{partialText:JSON.stringify(response),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:60,totalTokens:2078}}});
const sourceHash='a'.repeat(64),approval={jobId:'job',transcriptHash:sourceHash,sequence:1,model:'openai/gpt-oss-120b',outputKind:'RAW_CHECKPOINTS_WITH_REVIEW_GAP',windowStart:9,maxRequests:1,maxInputTokensPerRequest:4800,maxCompletionTokensPerRequest:1800,freeTierConfirmed:true,billingDisabled:true};
const base={stage:'raw:9',sourceHash,auditSha256:'b'.repeat(64),failedOperationId:'job:groq-summary:'+sourceHash+':raw:9',failedResultJson:result,usageEvidence:{unit:'actual_total_tokens',totalTokens:2078},approvalEvidence:{id:'job:groq-summary:approval:1',state:'STOPPED',resultJson:JSON.stringify(approval)},segments,verifyGrounding:assertGrounding};

test('abbreviated year candidate preserves original response and only derives source spelling',async()=>{
 const candidate=await abbreviatedYearRecoveryCandidate(base);
 assert.equal(candidate.providerCalls,0);assert.equal(candidate.originalFailurePreserved,true);assert.equal(candidate.transformations.length,2);
 assert.deepEqual(candidate.transformations.map(item=>[item.from,item.to,item.source.id]),[['2022년','22년',172],['2023년','23년',173]]);
 assert.match(candidate.derivedReport.summary[0].text,/22년/);assert.match(candidate.derivedReport.summary[1].text,/23년/);
 assert.equal(base.failedResultJson,result);assert.equal(candidate.confirmedUsage.totalTokens,2078);
});

test('year candidate refuses century inference, wrong evidence and unsupported remaining numbers',async()=>{
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,segments:[{...segments[0],text:'2022년 금리 1.5%'},segments[1]]}),/YEAR_RECOVERY_CHANGE_SET_INVALID/);
 const ambiguous={...response,summary:[{...response.summary[0],evidenceIds:[172,173]},response.summary[1]]};
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,segments:[{...segments[0],text:'22년 금리 1.5%'},{...segments[1],text:'22년과 23년 물가 2%대'}],failedResultJson:JSON.stringify({reviewResult:{partialText:JSON.stringify(ambiguous),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:60,totalTokens:2078}}})}),/YEAR_RECOVERY_SOURCE_AMBIGUOUS/);
 const wrong={...response,summary:[{text:'2022년 금리 1.5%',evidenceIds:[173]},response.summary[1]]};
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,failedResultJson:JSON.stringify({reviewResult:{partialText:JSON.stringify(wrong),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:60,totalTokens:2078}}})}),/YEAR_RECOVERY_SOURCE_AMBIGUOUS/);
 const extra={...response,summary:[{text:'2022년 금리 1.5%와 999원',evidenceIds:[172]},response.summary[1]]};
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,failedResultJson:JSON.stringify({reviewResult:{partialText:JSON.stringify(extra),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:60,totalTokens:2078}}})}),/UNSUPPORTED_NUMBER/);
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,usageEvidence:{unit:'audio_seconds',totalTokens:2078}}),/YEAR_RECOVERY_SCOPE_INVALID/);
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,approvalEvidence:{...base.approvalEvidence,state:'APPROVED'}}),/YEAR_RECOVERY_APPROVAL_INVALID/);
});

test('supported full year is preserved even when another cited segment says a duration',async()=>{
 const mixedSegments=[
  {id:1,startMs:0,endMs:1000,text:'이 사업은 2022년에 시작됐다'},
  {id:2,startMs:1000,endMs:2000,text:'연구 기간은 22년이었다'},
  {id:3,startMs:2000,endMs:3000,text:'2020년대의 23년 물가를 논했다'}
 ];
 const mixed={...response,summary:[{text:'이 사업은 2022년에 시작됐다',evidenceIds:[1,2]},{text:'2023년 물가를 논했다',evidenceIds:[3]}],chapters:[{text:'사업과 물가',evidenceIds:[1,2,3]}]};
 const failedResultJson=JSON.stringify({reviewResult:{partialText:JSON.stringify(mixed),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:60,totalTokens:2078}}});
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,segments:mixedSegments,failedResultJson}),/YEAR_RECOVERY_CHANGE_SET_INVALID/);
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,segments:[{...mixedSegments[0],text:'사업을 시작했다'},...mixedSegments.slice(1)],failedResultJson}),/YEAR_RECOVERY_SOURCE_AMBIGUOUS/);
});

test('year repair rejects impossible or out-of-contract provider usage',async()=>{
 for(const usage of [
  {inputTokens:-1,outputTokens:1006,reasoningTokens:60,totalTokens:2078},
  {inputTokens:4801,outputTokens:1006,reasoningTokens:60,totalTokens:5807},
  {inputTokens:1072,outputTokens:1801,reasoningTokens:60,totalTokens:2873},
  {inputTokens:1072,outputTokens:1006,reasoningTokens:1007,totalTokens:2078}
 ]){
  const failedResultJson=JSON.stringify({reviewResult:{partialText:JSON.stringify(response),usage}});
  await assert.rejects(abbreviatedYearRecoveryCandidate({...base,failedResultJson,usageEvidence:{unit:'actual_total_tokens',totalTokens:usage.totalTokens}}),/YEAR_RECOVERY_USAGE_INVALID/);
 }
});

test('elapsed-year phrases are not repaired into calendar dates',async()=>{
 for(const sourceText of ['22년 동안 근무했다','22년 만에 돌아왔다','22년이 넘게 일했다','그는 22년을 근무했고 금리 1.5%를 언급했습니다.','22년을 살았다','22년에 걸친 이야기','22년 금리 1.5%']){
  await assert.rejects(abbreviatedYearRecoveryCandidate({...base,segments:[{...segments[0],text:sourceText},segments[1]]}),/YEAR_RECOVERY_SOURCE_AMBIGUOUS/);
 }
});
