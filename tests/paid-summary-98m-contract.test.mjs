import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fullSummaryRequest,validatePaidFullReport,PAID_SUMMARY_SCHEMA} from '../src/paid-summary-contract.mjs';

// Synthetic timing and IDs exercise the full 98:12.864 scope without using the private transcript.
const duration=5_892_864,segments=Array.from({length:1226},(_,index)=>({id:index+1,startMs:Math.floor(index*duration/1226),endMs:Math.floor((index+1)*duration/1226),text:index===0?'첫 발언에서 42억원의 매출을 언급했다.':'시간 순서에 따라 주제와 판단 근거를 논의했다.'}));
const source={raw:segments.map(item=>item.text).join('\n'),segments},audit={durationSeconds:duration/1000,audioProcessingCoverage:1,independentVerification:false};
const chapterIds=Array.from({length:Math.ceil(duration/600000)},(_,window)=>segments.find(item=>item.startMs<Math.min(duration,(window+1)*600000)&&item.endMs>window*600000).id);
const report={summary:[{text:'전체 발언의 논의를 종합했다.',evidenceIds:[1,1226]}],chapters:chapterIds.map(id=>({text:'이 시간 구간의 발언을 정리했다.',evidenceIds:[id]})),claims:[],numbers:[{text:'매출 42억원 언급',evidenceIds:[1]}],critical:[],conclusion:'전사 범위 안에서만 요약했다.'};

test('98-minute prompt asks for exactly the JSON and 10-minute evidence coverage that validation enforces',()=>{
 const request=fullSummaryRequest(source,audit),prompt=request.body.contents[0].parts[0].text;
 assert.equal(request.body.generationConfig.responseMimeType,'application/json');assert.equal(request.body.generationConfig.responseJsonSchema,PAID_SUMMARY_SCHEMA);
 assert.match(prompt,/모든 10분 시간 창/);assert.match(prompt,/evidenceIds/);assert.match(prompt,/수치와 단위 및 직접 인용/);assert.match(prompt,/정확히 이 다섯 배열과 conclusion/);
 assert.equal((prompt.match(/\[1,0,/g)||[]).length,1);assert.ok(request.requestBytes<200000);assert.ok(request.estimatedInputUpper<1048576);
 const validated=validatePaidFullReport(JSON.stringify(report),source);assert.equal(validated.kind,'GEMINI_PAID_FULL_EVIDENCE_LINKED');assert.equal(validated.chapters.length,10);assert.equal(validated.outputKind,'FULL_VIDEO_SYNTHESIS');
 assert.throws(()=>validatePaidFullReport(JSON.stringify({...report,chapters:report.chapters.slice(0,-1)}),source),{safeValidationCode:'PAID_REPORT_WINDOW_COVERAGE'});
 assert.throws(()=>validatePaidFullReport(JSON.stringify({...report,numbers:[{text:'매출 43억원 언급',evidenceIds:[1]}]}),source),{safeValidationCode:'PAID_REPORT_NUMBER_UNSUPPORTED'});
 assert.throws(()=>validatePaidFullReport(JSON.stringify({...report,summary:[{text:'종합했다.',evidenceIds:[1227]}]}),source),{safeValidationCode:'PAID_REPORT_EVIDENCE_INVALID'});
 assert.throws(()=>validatePaidFullReport(JSON.stringify({...report,extra:'unapproved'}),source),{code:'PAID_RESPONSE_INVALID'});
 assert.throws(()=>validatePaidFullReport('not json',source),{code:'PAID_RESPONSE_INVALID'});
});
