import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {jobRepository} from '../../src/v1/db/jobs.mjs';
import {routeV1} from '../../src/v1/router.mjs';
import {makeTranscript, SOURCES} from '../../src/v1/transcript.mjs';
import {compareFacts, planWindows} from '../../src/v1/verify/crosscheck.mjs';
import {verifySummary} from '../../src/v1/verify/facts.mjs';
import {d1, geminiBody, jsonResponse, memoryDb} from './fakes.mjs';

const BASE = 'https://site.test';
// Auto captions misheard 1053 as 103; the summary then wrote 1003.
const transcript = makeTranscript({source: SOURCES.SUPADATA_NATIVE, segments: [
  {startMs: 0, endMs: 5000, text: '평균 PBR은 약 0.25배입니다'},
  {startMs: 300_000, endMs: 306_000, text: '상장사는 2,521개사 중 103개사였습니다'},
  {startMs: 600_000, endMs: 604_000, text: '최고 세율은 49.5%입니다'}]});
const fact = (surface, value, unit, id, quote) => ({surface, value, unit, qualifier: 'EXACT', segmentIds: [id], quote});
const summary = {version: 'v1-summary-1',
  conclusion: {text: '결론', segmentIds: [1], facts: []},
  keyPoints: [
    {text: '평균 PBR은 약 0.25배', attribution: 'SPEAKER', segmentIds: [1],
      facts: [{...fact('약 0.25배', 0.25, 'TIMES', 1, '약 0.25배'), qualifier: 'APPROXIMATE'}]},
    {text: '2,521개사 중 1003개사', attribution: 'SPEAKER', segmentIds: [2],
      facts: [fact('2,521개사', 2521, 'COUNT', 2, '2,521개사'), fact('1003개사', 1003, 'COUNT', 2, '103개사')]},
    {text: '세율 49.5%', attribution: 'SPEAKER', segmentIds: [3], facts: [fact('49.5%', 49.5, 'PERCENT', 3, '49.5%')]}],
  chapters: [{startSegmentId: 1, title: 't', summary: 's', facts: []}]};
const heard = {0: '평균 PBR은 약 0.25배입니다', 285: '상장사는 2521개사 중 1053개사였습니다. 10곳 중 4곳입니다',
  585: '최고 세율은 49.5%입니다'};

test('windows cover each evidence segment with padding, mismatches first, within caps', () => {
  const verification = verifySummary(summary, transcript);
  assert.deepEqual(planWindows(verification, transcript), [{startSec: 0, endSec: 20}, {startSec: 285, endSec: 321},
    {startSec: 585, endSec: 619}]);
  const capped = planWindows(verification, transcript, {padSec: 15, mergeGapSec: 10, maxWindows: 1, maxTotalSec: 900,
    maxWindowSec: 240});
  assert.deepEqual(capped, [{startSec: 285, endSec: 321}]);
});

test('second listen confirms matching numbers and reports what it heard for the others', () => {
  const verification = verifySummary(summary, transcript);
  const clips = Object.entries(heard).map(([start, text]) => ({startSec: Number(start), endSec: Number(start) + 36,
    segments: [{startMs: Number(start) * 1000 + 15_000, endMs: Number(start) * 1000 + 20_000, text}]}));
  const result = compareFacts(verification, transcript, clips);
  assert.deepEqual(result.counts, {total: 4, confirmed: 3, differs: 1, notChecked: 0});
  assert.deepEqual(result.items.find(i => i.result === 'DIFFERS'), {surface: '1003개사', value: 1003, unit: 'COUNT',
    segmentIds: [2], result: 'DIFFERS', heardValues: ['2521개', '1053개', '10곳', '4곳'],
    heardText: '상장사는 2521개사 중 1053개사였습니다. 10곳 중 4곳입니다'});
  assert.equal(compareFacts(verification, transcript, []).counts.notChecked, 4);
});

test('cross-check API: runs per window, stores result, counts usage, guards re-entry and missing URL', async () => {
  const db = memoryDb();
  db.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));
  const env = {DB: d1(db), GEMINI_API_KEY: 'gm-key-123'};
  const jobs = jobRepository(env.DB);
  const job = await jobs.create({videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'});
  await jobs.saveTranscript(job.id, transcript);
  await jobs.saveSummary(job.id, summary);
  let calls = 0;
  const fetchFn = async (url, init) => {
    calls += 1;
    const start = parseInt(JSON.parse(init.body).contents[0].parts[0].videoMetadata.startOffset, 10);
    return jsonResponse(geminiBody({endOfVideo: false, segments: [{start: start + 15, end: start + 20,
      text: heard[start]}]}));
  };
  const post = id => new Request(`${BASE}/api/v1/jobs/${id}/crosscheck`, {method: 'POST', body: '{}',
    headers: {origin: BASE, 'content-type': 'application/json'}});
  assert.equal((await routeV1(post(job.id), env, null, {fetchFn, sleep: async () => {}})).status, 202);
  const detail = await (await routeV1(new Request(`${BASE}/api/v1/jobs/${job.id}`), env)).json();
  const cross = detail.summary.crossCheck;
  assert.equal(cross.status, 'DONE');
  assert.deepEqual(cross.counts, {total: 4, confirmed: 3, differs: 1, notChecked: 0});
  assert.equal(cross.sameEngineAsTranscript, false);
  assert.equal(calls, 3);
  const used = await (await routeV1(new Request(`${BASE}/api/v1/usage`), env)).json();
  assert.equal(used.usage.items.find(i => i.key === 'geminiVideoSeconds').used, 20 + 36 + 34);
  await jobs.saveSummary(job.id, {...detail.summary, crossCheck: {status: 'RUNNING'}});
  assert.equal((await (await routeV1(post(job.id), env, null, {fetchFn})).json()).started, false);
  const noUrl = await jobs.create({});
  await jobs.saveTranscript(noUrl.id, transcript);
  await jobs.saveSummary(noUrl.id, summary);
  await routeV1(post(noUrl.id), env, null, {fetchFn});
  assert.equal((await jobs.loadSummary(noUrl.id)).crossCheck.status, 'FAILED');
});

test('numbers as written in the summary count when heard as Korean number words', () => {
  const t = makeTranscript({source: SOURCES.SUPADATA_NATIVE, segments: [{startMs: 0, endMs: 5000,
    text: '상장사 10곳 중 4곳이 대상입니다'}]});
  const verification = {items: [{surface: '10곳 중 4곳', value: 40, unit: 'PERCENT', segmentIds: [1],
    status: 'VERIFIED'}]};
  const clips = [{startSec: 0, endSec: 20, segments: [{startMs: 1000, endMs: 4000, text: '상장사 열 곳 중 네 곳이 대상입니다'}]}];
  assert.equal(compareFacts(verification, t, clips).items[0].result, 'CONFIRMED');
});

test('JSON export keeps attribution, evidence sentences and per-number check results', async () => {
  const {exportJson, EXPORT_SCHEMA} = await import('../../src/v1/export-json.mjs');
  const verification = verifySummary(summary, transcript);
  const withCross = {...summary, crossCheck: {status: 'DONE', sameEngineAsTranscript: false,
    counts: {total: 4, confirmed: 3, differs: 1, notChecked: 0},
    items: [{value: 1003, segmentIds: [2], result: 'DIFFERS', heardValues: ['1,053개']}]},
  analysis: {status: 'DONE', items: [{type: 'CAUSE', text: '인과', attribution: 'INTERPRETATION', segmentIds: [3],
    facts: []}]}};
  const out = exportJson({job: {id: 'j', videoId: 'dQw4w9WgXcQ', url: 'u', title: '제목', createdAt: 't', options: {}},
    transcript, summary: withCross, verification});
  assert.equal(out.schema, EXPORT_SCHEMA);
  assert.equal(out.reviewState, 'AUTO_NOT_HUMAN_REVIEWED');
  assert.deepEqual(out.statements.map(s => `${s.kind}:${s.attribution}`), ['KEY_POINT:SPEAKER', 'KEY_POINT:SPEAKER',
    'KEY_POINT:SPEAKER', 'CAUSE:INTERPRETATION']);
  const wrong = out.statements[1].numbers.find(n => n.value === 1003);
  assert.deepEqual(wrong.verification, {status: 'MISMATCH', codes: ['VALUE_CHANGED']});
  assert.deepEqual(wrong.reListen, {result: 'DIFFERS', heardValues: ['1,053개']});
  assert.deepEqual(out.statements[1].evidence[0], {segmentId: 2, startSec: 300,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=300s', text: '상장사는 2,521개사 중 103개사였습니다',
    transcriptFlags: []});
  assert.equal(out.video.publishedAt, null);
  assert.equal(out.checks.reListen.differs, 1);
});
