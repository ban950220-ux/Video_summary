import test from 'node:test';
import assert from 'node:assert/strict';
import {videoIdOf,InputError,parseCaptions,transcriptAudit,extractiveReport,estimateSource,planSupadataUrlGeneration,usableFreeUnits,budgetDecision,failoverDecision,remainingDaysForecast,parseClock} from '../src/core.mjs';
const url='https://www.youtube.com/watch?v=2hUkTmwYm3A';
const srt=(end='00:02:00,000')=>`1\n00:00:00,000 --> 00:00:02,000\n첫 문장입니다.\n\n2\n00:01:50,000 --> ${end}\n마지막 문장입니다.\n`;
test('strict youtube URL validation',()=>{
  assert.equal(videoIdOf(url),'2hUkTmwYm3A');
  assert.equal(videoIdOf('https://youtu.be/2hUkTmwYm3A'),'2hUkTmwYm3A');
  assert.equal(videoIdOf('https://youtube.com/shorts/2hUkTmwYm3A'),'2hUkTmwYm3A');
  for(const bad of ['http://youtube.com/watch?v=2hUkTmwYm3A','https://youtube.com.evil.com/watch?v=2hUkTmwYm3A','https://localhost/watch?v=2hUkTmwYm3A','file:///etc/passwd','https://youtube.com/watch?v=abc'])assert.throws(()=>videoIdOf(bad),InputError);
});
test('parse SRT, VTT and TXT',()=>{
  assert.equal(parseCaptions(srt(),'a.srt').segments.length,2);
  assert.equal(parseCaptions('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello','a.vtt').segments[0].text,'Hello');
  assert.equal(parseCaptions('Hello world','a.txt').timed,false);
  assert.throws(()=>parseCaptions('Hello world','a.srt'),InputError);
  assert.equal(parseClock('01:02:03.123'),3723123);
});
test('30 minutes out of 98 minutes stays PARTIAL',()=>{
  const t=[{startMs:0,endMs:30*60*1000,text:'partial'}];
  const a=transcriptAudit(t,98*60);
  assert.equal(a.status,'PARTIAL_TRANSCRIPT');
  assert.ok(a.timelineRatio>.3&&a.timelineRatio<.31);
});
test('even apparently complete transcript is not independently verified',()=>{
  const x=parseCaptions(srt(),'a.srt');
  assert.equal(transcriptAudit(x.segments,120).status,'TRANSCRIPT_UNVERIFIED');
  assert.equal(transcriptAudit(x.segments,120,true).status,'FULL_TRANSCRIPT_VERIFIED');
  assert.equal(transcriptAudit(parseCaptions('arbitrary plain text','transcript.txt').segments,120).status,'TRANSCRIPT_UNVERIFIED');
});
test('extractive demo does not invent Korean translation',()=>{
  const x=extractiveReport(parseCaptions('Hello world','a.txt'));
  assert.equal(x.kind,'EXTRACTIVE_ONLY_NOT_AI');
  assert.equal(x.translation,'NOT_PERFORMED');
  assert.deepEqual(x.summary,['Hello world']);
});
test('URL source uses native-only 1 credit and blocks 240-credit auto ASR',()=>{
  const q=estimateSource({durationSeconds:7200,sourceType:'url'});
  assert.equal(q[0].creditsMax,1);
  assert.equal(q[1].creditsMax,240);
  assert.equal(q[1].available,'BLOCKED_BY_DEFAULT');
  assert.ok(q.find(p=>p.provider==='gemini'));
});
test('URL generation preflight reserves full minutes and blocks a 98-minute video on Free',()=>{
  const durationSeconds=5892.888;
  assert.equal(estimateSource({durationSeconds,sourceType:'url'})[1].creditsMax,198);
  const approved={durationSeconds,rightsConfirmed:true,publicAccessConfirmed:true,freePlanConfirmed:true,billingDisabledConfirmed:true,explicitGenerationApproval:true,freeCreditsRemaining:100};
  assert.deepEqual([planSupadataUrlGeneration(approved).creditsReserved,planSupadataUrlGeneration(approved).blockedReason],[198,'INSUFFICIENT_FREE_CREDITS']);
  assert.equal(planSupadataUrlGeneration({...approved,freeCreditsRemaining:null}).blockedReason,'FREE_CREDITS_UNVERIFIED');
  assert.equal(planSupadataUrlGeneration({...approved,freeCreditsRemaining:198,priorAttemptUncertain:true}).blockedReason,'PRIOR_ATTEMPT_UNCERTAIN');
  assert.equal(planSupadataUrlGeneration({...approved,durationSeconds:60,freeCreditsRemaining:2}).allowed,true);
  assert.equal(planSupadataUrlGeneration({...approved,durationSeconds:60,freeCreditsRemaining:2,explicitGenerationApproval:false}).blockedReason,'GENERATION_APPROVAL_REQUIRED');
});
test('app ledger never shown as provider exact remaining',()=>{
  const u=usableFreeUnits({limit:100,appUsed:50});
  assert.equal(u.provenance,'UNKNOWN');
  assert.equal(u.remaining,null);
  assert.equal(u.appEstimatedRemaining,50);
});
test('default $0 paid blocked, conservative unknown quota blocked',()=>{
  assert.equal(budgetDecision({expectedUSD:0.01}).reason,'BUDGET_BLOCKED');
  assert.equal(budgetDecision({expectedUSD:0,quota:{remaining:null},requiredUnits:1}).reason,'QUOTA_UNVERIFIED');
  assert.equal(budgetDecision({expectedUSD:0,quota:{remaining:100},requiredUnits:90}).reason,'INSUFFICIENT_FREE_QUOTA');
  assert.equal(budgetDecision({expectedUSD:0,quota:{remaining:100},requiredUnits:50}).allowed,true);
});
test('403 rights blocked, 429 switches provider',()=>{
  assert.equal(failoverDecision({errorCode:403,alternatives:['backup']}).action,'BLOCK');
  assert.equal(failoverDecision({errorCode:429,alternatives:['backup']}).provider,'backup');
  assert.equal(failoverDecision({errorCode:429,alternatives:['backup'],rights:'UNKNOWN'}).action,'BLOCK');
});
test('forecast requires history',()=>{
  assert.equal(remainingDaysForecast({history:[100,110],currentUsed:150,limit:1000}).confidence,'LOW');
  assert.ok(remainingDaysForecast({history:[100,100,100],currentUsed:200,limit:1000}).estimatedDays===8);
});
