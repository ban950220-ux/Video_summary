import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groqSummaryProgress,groqGapFailureText} from '../web/site/groq-summary-progress.mjs';

const now=100_000;
const approved={approval:{state:'APPROVED',expiresAt:200_000,windowStart:0,maxRequests:29,totalTokenUpperBound:191400},completedStages:0,plannedMaximumRequests:191,activeStage:null,finalReportSaved:false};
const view=(status,options={})=>groqSummaryProgress(status,{now,...options});

test('reviewed gap progress separates contiguous, saved, held and pending raw groups',()=>{
 const status={...approved,completedStages:9,rawProgress:{contiguousRawStages:8,completedRawStages:9,heldRawStages:1,pendingRawStages:11,rawStages:21,heldStage:'raw:8'},activeStage:{key:'raw:8:correction',state:'FAILED_UNCERTAIN',errorCode:'SUMMARY_RESPONSE_INVALID'}};
 const result=view(status);
 assert.match(result.detail,/연속 완료 raw 0–7/);assert.match(result.detail,/검증 저장 9\/21구간/);assert.match(result.detail,/보류 1구간 \(raw:8\)/);assert.match(result.detail,/미처리 11구간/);
 assert.match(result.headline,/전체 요약 미완료/);assert.equal(result.canExecute,false);
 const claimed=view({...status,activeStage:{key:'raw:9',state:'CLAIMED'}});
 assert.match(claimed.headline,/앱 서버 접수/);assert.match(claimed.detail,/보류 1구간/);assert.equal(claimed.canExecute,false);
 const failed=view({...status,activeStage:{key:'raw:9',state:'FAILED_UNCERTAIN',errorCode:'429'}});
 assert.match(failed.headline,/결과 불확실/);assert.match(failed.detail,/보류 1구간/);assert.equal(failed.canExecute,false);
});

test('saved raw:9 validation failure is shown from status after gap read fails',()=>{
 const text=groqGapFailureText({...approved,approval:{state:'STOPPED'},activeStage:{key:'raw:9',state:'FAILED_UNCERTAIN',errorCode:'SUMMARY_RESPONSE_INVALID'}});
 assert.match(text,/raw:9 저장된 실패/);assert.match(text,/SUMMARY_RESPONSE_INVALID/);assert.match(text,/자동 재전송은 없습니다/);
 assert.equal(groqGapFailureText({...approved,activeStage:{key:'raw:9',state:'CLAIMED'}}),null);
});

test('progress wording separates approval, transport, server claim, checkpoint and final report',()=>{
 assert.match(view(approved).headline,/승인 저장/);
 assert.match(view(approved).detail,/접수 기록은 확인되지/);
 assert.equal(view(approved).canExecute,true);
 assert.match(view(approved,{phase:'sending'}).detail,/접수 기록은 아직 확인되지/);
 assert.equal(view(approved,{phase:'sending'}).canExecute,false);
 const claimed={...approved,activeStage:{key:'raw:0',state:'CLAIMED'}};
 assert.match(view(claimed).headline,/앱 서버 접수 확인/);
 assert.match(view(claimed).detail,/제공자 수신은 확인되지/);
 assert.match(view(claimed,{phase:'unknown'}).headline,/결과 불명/);
 assert.equal(view(claimed,{phase:'unknown'}).canExecute,false);
 const saved={...approved,completedStages:1,lastSavedStage:{key:'raw:0',state:'DONE'}};
 assert.match(view(saved).headline,/중간 단계 저장/);
 assert.match(view(saved).detail,/최종 요약은 아직/);
 assert.match(view(saved,{phase:'responseLostSaved'}).headline,/새 중간 단계 저장 확인/);
 assert.equal(view({...saved,nextEligibleAt:161000}).canExecute,false);
 assert.match(view(saved,{phase:'waiting',waitUntil:161000}).headline,/이 탭에서 다음 단계 전송까지 61초/);
 assert.match(view({...saved,finalReportSaved:true}).headline,/최종 요약 저장 완료/);
});

test('unknown, expired, limited, uncertain and stopped states never imply another provider send',()=>{
 for(const [status,options,pattern] of [
  [approved,{phase:'unknown'},/재전송하지/],
  [approved,{phase:'approvalUnknown'},/모델 요청은 보내지/],
  [approved,{phase:'preflightFailed'},/모델 요청은 보내지/],
  [approved,{reason:'FOREGROUND_REQUIRED'},/자동 진행 중단/],
  [approved,{reason:'SUMMARY_LOCAL_LIMIT'},/무료 요약 한도/],
  [{...approved,approval:{...approved.approval,expiresAt:90000}},{},/승인 만료/],
  [{...approved,approval:{...approved.approval,expiresAt:90000}},{reason:'SUMMARY_APPROVAL_CHANGED'},/승인 만료/],
  [{...approved,activeStage:{state:'FAILED_UNCERTAIN'}},{},/결과 불확실/],
  [{...approved,activeStage:{state:'BLOCKED'}},{},/차단 기록/],
  [{...approved,approval:{...approved.approval,state:'STOPPED'}},{},/승인 중단/],
 ]){
  const result=view(status,options);
  assert.match(result.headline+' '+result.detail,pattern);
  assert.equal(result.canExecute,false);
 }
 assert.match(view(approved,{phase:'unknown'}).detail,/미실행을 확정할 수 없/);
});
