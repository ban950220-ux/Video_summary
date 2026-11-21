import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {configFromEnv, ffmpegArgs, whisperToSegments, ytDlpArgs} from '../../scripts/v1-pc-runner.mjs';
import {routeV1} from '../../src/v1/router.mjs';
import {findGaps, markRepeats, markUnclear, uncertaintyReport, whisperFlags} from '../../src/v1/uncertainty.mjs';
import {d1, geminiBody, jsonResponse, memoryDb} from './fakes.mjs';

const BASE = 'https://site.test';
const post = (path, body) => new Request(`${BASE}${path}`, {method: 'POST', body: JSON.stringify(body ?? {}),
  headers: {origin: BASE, 'content-type': 'application/json'}});
const get = path => new Request(`${BASE}${path}`);
const summary = {conclusion: {text: '결론', segmentIds: [1], facts: []},
  keyPoints: [1, 2, 3].map(id => ({text: `요점 ${id}`, attribution: 'SPEAKER', segmentIds: [id], facts: []})),
  chapters: [{startSegmentId: 1, title: '시작', summary: '요약', facts: []}]};
const fetchFn = async url => (String(url).includes('generativelanguage') ? jsonResponse(geminiBody(summary))
  : jsonResponse({title: '제목'}));

function env() {
  const db = memoryDb();
  db.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));
  return {DB: d1(db), GEMINI_API_KEY: 'gm-key-123', V1_LIVE_PROVIDERS: 'true'};
}

test('Whisper confidence scores, repeats, unclear marks and gaps become uncertainty flags', () => {
  assert.deepEqual(whisperFlags({avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1.4}), []);
  assert.deepEqual(whisperFlags({avg_logprob: -1.3, no_speech_prob: 0.7, compression_ratio: 2.9}),
    ['REPETITIVE', 'LOW_CONFIDENCE', 'LIKELY_NO_SPEECH']);
  const repeated = markRepeats(['가', '감사합니다', '감사합니다', '감사합니다', '나'].map(text => ({text})));
  assert.deepEqual(repeated.map(s => s.flags.join()), ['', 'REPEAT', 'REPEAT', 'REPEAT', '']);
  assert.deepEqual(markUnclear([{text: '여기는 [불명확] 입니다'}])[0].flags, ['UNCLEAR_MARK']);
  assert.deepEqual(findGaps([{startMs: 0, endMs: 5000}, {startMs: 50_000, endMs: 52_000}]),
    [{fromMs: 5000, toMs: 50_000}]);
});

test('runner helpers: safe command arguments and chunk offsets', () => {
  const args = ytDlpArgs('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '/w');
  assert.deepEqual(args.slice(-2), ['--', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
  assert.ok(args.includes('--no-config') && args.includes('--no-cookies-from-browser'));
  assert.ok(ffmpegArgs('/w/source.m4a', '/w').includes('600'));
  const segments = whisperToSegments({segments: [{start: 1.5, end: 4, text: ' 안녕 ', avg_logprob: -1.4,
    no_speech_prob: 0, compression_ratio: 1}, {start: 5, end: 6, text: '  '}]}, 2);
  assert.deepEqual(segments, [{startMs: 1_201_500, endMs: 1_204_000, text: '안녕', flags: ['LOW_CONFIDENCE']}]);
  assert.throws(() => configFromEnv({V1_SITE: 'https://s.test'}), /clientId, clientSecret, groqKey/);
  assert.throws(() => configFromEnv({V1_SITE: 'http://s.test', CF_ACCESS_CLIENT_ID: 'a', CF_ACCESS_CLIENT_SECRET: 'b',
    GROQ_API_KEY: 'c'}), /https/);
});

test('PC job: rights confirmation, single claim, transcript upload with flags, then summary', async () => {
  const e = env();
  const url = 'https://youtu.be/dQw4w9WgXcQ';
  const earlier = await (await routeV1(post('/api/v1/jobs/upload', {filename: 'a.txt', text: '이전 요약', url}), e,
    null, {fetchFn})).json();
  await e.DB.prepare('DELETE FROM v1_jobs WHERE id != ?').bind(earlier.job.id).run();
  assert.equal((await routeV1(post('/api/v1/jobs', {url, transcriptMode: 'pc'}), e)).status, 400);
  const created = await (await routeV1(post('/api/v1/jobs', {url, transcriptMode: 'pc', rightsConfirmed: true}),
    e)).json();
  assert.equal(created.job.status, 'WAITING_PC');
  // An earlier finished job for the same video must not be reused for a PC request.
  const {results} = await e.DB.prepare('SELECT COUNT(*) AS n FROM v1_jobs').all();
  assert.equal(results[0].n, 2);
  const claimed = await (await routeV1(post('/api/v1/runner/next'), e)).json();
  assert.equal(claimed.job.id, created.job.id);
  assert.equal((await (await routeV1(post('/api/v1/runner/next'), e)).json()).job, null);
  const segments = [{startMs: 0, endMs: 4000, text: '첫 문장', flags: ['LOW_CONFIDENCE']},
    {startMs: 4000, endMs: 8000, text: '둘째'}, {startMs: 8000, endMs: 12_000, text: '셋째'}];
  const uploaded = await routeV1(post(`/api/v1/runner/jobs/${created.job.id}/transcript`, {segments, language: 'ko',
    durationSec: 12, engine: 'groq whisper-large-v3-turbo'}), e, null, {fetchFn});
  assert.equal(uploaded.status, 202);
  assert.equal((await uploaded.json()).uncertainSegments, 1);
  const detail = await (await routeV1(get(`/api/v1/jobs/${created.job.id}`), e)).json();
  assert.equal(detail.job.status, 'DONE');
  assert.equal(detail.transcript.source, 'pc-whisper');
  assert.deepEqual(detail.transcript.segments[0].flags, ['LOW_CONFIDENCE']);
  assert.equal(uncertaintyReport(detail.transcript).uncertainSegments, 1);
  assert.equal(detail.job.attempts.at(-1).engine, 'groq whisper-large-v3-turbo');
  const late = await routeV1(post(`/api/v1/runner/jobs/${created.job.id}/transcript`, {segments}), e);
  assert.equal(late.status, 404);
});

test('PC job failure is recorded; a silent runner loses its claim after the lease', async () => {
  const e = env();
  let clock = Date.parse('2026-11-21T10:00:00Z');
  const deps = {now: () => new Date(clock).toISOString()};
  const mk = async () => (await (await routeV1(post('/api/v1/jobs', {url: 'https://youtu.be/dQw4w9WgXcQ',
    transcriptMode: 'pc', rightsConfirmed: true, force: true}), e, null, deps)).json()).job;
  const first = await mk();
  await routeV1(post('/api/v1/runner/next'), e, null, deps);
  await routeV1(post(`/api/v1/runner/jobs/${first.id}/fail`, {code: 'PC_RUNNER_FAILED', detail: 'ffmpeg exit 1'}), e,
    null, deps);
  const failed = await (await routeV1(get(`/api/v1/jobs/${first.id}`), e, null, deps)).json();
  assert.equal(failed.job.status, 'FAILED');
  assert.equal(failed.job.attempts.at(-1).detail, 'ffmpeg exit 1');
  const second = await mk();
  assert.equal((await (await routeV1(post('/api/v1/runner/next'), e, null, deps)).json()).job.id, second.id);
  clock += 10 * 60_000;
  assert.equal((await (await routeV1(post('/api/v1/runner/next'), e, null, deps)).json()).job, null);
  clock += 25 * 60_000;
  assert.equal((await (await routeV1(post('/api/v1/runner/next'), e, null, deps)).json()).job.id, second.id);
});
