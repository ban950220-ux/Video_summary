import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertGrounding} from '../src/groq-summary.mjs';
import {abbreviatedYearRecoveryCandidate} from '../src/groq-year-recovery.mjs';

const segments=[{id:172,startMs:760568,endMs:768000,text:'22년 금리 1.5%를 언급했습니다.'},{id:173,startMs:770928,endMs:778000,text:'23년 물가 2%대를 언급했습니다.'}];
const response={summary:[{text:'2022년 금리 1.5%',evidenceIds:[172]},{text:'2023년 물가 2%대',evidenceIds:[173]}],chapters:[{text:'금리와 물가를 언급했습니다.',evidenceIds:[172,173]}],claims:[],numbers:[],critical:[],conclusion:'확인 범위 내 발언만 정리했습니다.'};
const result=JSON.stringify({reviewResult:{partialText:JSON.stringify(response),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:60,totalTokens:2078}}});
const base={stage:'raw:9',sourceHash:'a'.repeat(64),auditSha256:'b'.repeat(64),failedOperationId:'job:groq-summary:hash:raw:9',failedResultJson:result,usageEvidence:{unit:'actual_total_tokens',totalTokens:2078},segments,verifyGrounding:assertGrounding};

test('abbreviated year candidate preserves original response and only derives source spelling',async()=>{
 const candidate=await abbreviatedYearRecoveryCandidate(base);
 assert.equal(candidate.providerCalls,0);assert.equal(candidate.originalFailurePreserved,true);assert.equal(candidate.transformations.length,2);
 assert.deepEqual(candidate.transformations.map(item=>[item.from,item.to,item.source.id]),[['2022년','22년',172],['2023년','23년',173]]);
 assert.match(candidate.derivedReport.summary[0].text,/22년/);assert.match(candidate.derivedReport.summary[1].text,/23년/);
 assert.equal(base.failedResultJson,result);assert.equal(candidate.confirmedUsage.totalTokens,2078);
});

test('year candidate refuses century inference, wrong evidence and unsupported remaining numbers',async()=>{
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,segments:[{...segments[0],text:'2022년 금리 1.5%'},segments[1]]}),/YEAR_RECOVERY_SOURCE_AMBIGUOUS/);
 const ambiguous={...response,summary:[{...response.summary[0],evidenceIds:[172,173]},response.summary[1]]};
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,segments:[{...segments[0],text:'22년 금리 1.5%'},{...segments[1],text:'22년과 23년 물가 2%대'}],failedResultJson:JSON.stringify({reviewResult:{partialText:JSON.stringify(ambiguous),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:60,totalTokens:2078}}})}),/YEAR_RECOVERY_SOURCE_AMBIGUOUS/);
 const wrong={...response,summary:[{text:'2022년 금리 1.5%',evidenceIds:[173]},response.summary[1]]};
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,failedResultJson:JSON.stringify({reviewResult:{partialText:JSON.stringify(wrong),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:60,totalTokens:2078}}})}),/YEAR_RECOVERY_SOURCE_AMBIGUOUS/);
 const extra={...response,summary:[{text:'2022년 금리 1.5%와 999원',evidenceIds:[172]},response.summary[1]]};
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,failedResultJson:JSON.stringify({reviewResult:{partialText:JSON.stringify(extra),usage:{inputTokens:1072,outputTokens:1006,reasoningTokens:60,totalTokens:2078}}})}),/UNSUPPORTED_NUMBER/);
 await assert.rejects(abbreviatedYearRecoveryCandidate({...base,usageEvidence:{unit:'audio_seconds',totalTokens:2078}}),/YEAR_RECOVERY_SCOPE_INVALID/);
});
