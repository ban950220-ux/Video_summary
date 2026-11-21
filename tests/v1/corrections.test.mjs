import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {applyCorrections, reviewList} from '../../src/v1/corrections.mjs';
import {jobRepository} from '../../src/v1/db/jobs.mjs';
import {routeV1} from '../../src/v1/router.mjs';
import {makeTranscript, SOURCES} from '../../src/v1/transcript.mjs';
import {d1, geminiBody, jsonResponse, memoryDb} from './fakes.mjs';

const BASE = 'https://site.test';
const transcript = makeTranscript({source: SOURCES.SUPADATA_NATIVE, segments: [
  {startMs: 0, endMs: 5000, text: '첫 문장', flags: ['LOW_CONFIDENCE']},
  {startMs: 5000, endMs: 9000, text: '상장사는 2,521개사 중 103개사였습니다'},
  {startMs: 9000, endMs: 12_000, text: '마지막 문장'}]});
const summary = {version: 'v1-summary-1', conclusion: {text: '결론', segmentIds: [1], facts: []},
  keyPoints: [1, 2, 3].map(id => ({text: `요점 ${id}`, attribution: 'SPEAKER', segmentIds: [id], facts: []})),
  chapters: [{startSegmentId: 1, title: 't', summary: 's', facts: []}]};
const send = (method, path, body) => new Request(`${BASE}${path}`, {method, body: JSON.stringify(body ?? {}),
  headers: {origin: BASE, 'content-type': 'application/json'}});

test('review list gathers uncertain, mismatched and differently heard segments', () => {
  const list = reviewList(transcript, {items: [{status: 'MISMATCH', surface: '1003개사', segmentIds: [2]}]},
    {items: [{result: 'DIFFERS', surface: '1003개사', heardValues: ['1,053개'], segmentIds: [2]}]}, {3: '고친 문장'});
  assert.deepEqual(list.map(i => [i.segmentId, i.reasons]), [
    [1, ['전사 불확실(LOW_CONFIDENCE)']],
    [2, ['숫자 불일치: 1003개사', '다시 들은 값이 다름: 1003개사 → 1,053개']],
    [3, ['교정함']]]);
  assert.equal(list[2].corrected, '고친 문장');
});

test('corrections leave the original transcript untouched and feed a new corrected summary job', async () => {
  const db = memoryDb();
  db.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));
  const env = {DB: d1(db), GEMINI_API_KEY: 'gm-key-123'};
  const jobs = jobRepository(env.DB);
  const job = await jobs.create({videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: '제목'});
  await jobs.saveTranscript(job.id, transcript);
  await jobs.saveSummary(job.id, summary);
  const fixed = '상장사는 2,521개사 중 1,053개사였습니다';
  const put = body => routeV1(send('PUT', `/api/v1/jobs/${job.id}/corrections`, body), env);
  assert.equal((await put({segmentId: 99, text: 'x'})).status, 404);
  assert.deepEqual((await (await put({segmentId: 2, text: fixed})).json()).corrections, {2: fixed});
  assert.equal((await jobs.loadTranscript(job.id)).segments[1].text, '상장사는 2,521개사 중 103개사였습니다');
  const detail = await (await routeV1(new Request(`${BASE}/api/v1/jobs/${job.id}`), env)).json();
  assert.deepEqual(detail.review.map(i => i.segmentId), [1, 2]);
  assert.equal(detail.review[1].corrected, fixed);

  const prompts = [];
  const fetchFn = async (url, init) => {
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    return jsonResponse(geminiBody(summary));
  };
  const created = await (await routeV1(send('POST', `/api/v1/jobs/${job.id}/resummarize`), env, null, {fetchFn}))
    .json();
  assert.notEqual(created.job.id, job.id);
  assert.deepEqual(created.job.options, {correctedFrom: job.id, correctedSegments: 1});
  assert.match(prompts[0], /1,053개사/);
  const corrected = await jobs.loadTranscript(created.job.id);
  assert.deepEqual(corrected.segments[1].flags, ['CORRECTED']);
  assert.deepEqual(applyCorrections(transcript, {}).segments, transcript.segments);

  await put({segmentId: 2, text: ''});
  assert.deepEqual(await jobs.loadCorrections(job.id), {});
  assert.equal((await routeV1(send('POST', `/api/v1/jobs/${job.id}/resummarize`), env)).status, 400);
});
