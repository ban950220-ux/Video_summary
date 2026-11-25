// Result reads within the Workers Free CPU budget: stored JSON passed through, checks precomputed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {CHECKS_VERSION} from '../../src/v1/checks.mjs';
import {jobRepository} from '../../src/v1/db/jobs.mjs';
import {refreshChecks} from '../../src/v1/detail.mjs';
import {routeV1} from '../../src/v1/router.mjs';
import {makeTranscript, SOURCES} from '../../src/v1/transcript.mjs';
import {verifySummary} from '../../src/v1/verify/facts.mjs';
import {d1, memoryDb} from './fakes.mjs';

const BASE = 'https://site.test';
const get = path => routeV1(new Request(`${BASE}${path}`), env.env, null, {});
let env;

async function seed() {
  const db = d1(memoryDb());
  env = {env: {DB: db}};
  const jobs = jobRepository(db);
  const job = await jobs.create({videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: '제목'});
  const transcript = makeTranscript({source: SOURCES.UPLOAD, segments: [
    {startMs: 0, endMs: 1000, text: '매출 비중은 약 20%입니다.'},
    {startMs: 1000, endMs: 2000, text: '두 번째 문장', flags: ['LOW_CONFIDENCE']},
    {startMs: 2000, endMs: 3000, text: '영업이익은 103억 원입니다.'},
    {startMs: 3000, endMs: 4000, text: '마지막'}]});
  await jobs.saveTranscript(job.id, transcript);
  const fact = (surface, value, unit, id, quote) => ({surface, value, unit, qualifier: 'UNQUALIFIED', kind: null,
    subject: null, segmentIds: [id], quote});
  const summary = {version: 'v1-summary-1', language: 'ko',
    conclusion: {text: '결론', segmentIds: [1], facts: []},
    keyPoints: [
      {text: '매출 비중 20%', attribution: 'SPEAKER', segmentIds: [1], facts: [fact('20%', 20, 'PERCENT', 1, '약 20%')]},
      {text: '영업이익 1003억 원', attribution: 'SPEAKER', segmentIds: [3],
        facts: [fact('1003억 원', 1003e8, 'KRW', 3, '103억 원')]},
      {text: '셋째', attribution: 'INTERPRETATION', segmentIds: [4], facts: []}],
    chapters: [{startSegmentId: 1, title: '장', summary: '설명', facts: [], startMs: 0, endMs: 4000}]};
  await jobs.saveSummary(job.id, summary);
  await jobs.update(job.id, {status: 'DONE'});
  return {jobs, job, transcript, summary, db};
}

test('result read: same shape as before, verification from stored checks, review from stored segments', async () => {
  const {jobs, job, transcript, summary} = await seed();
  const first = await (await get(`/api/v1/jobs/${job.id}`)).json();
  // No checks yet (summary saved before checks existed): computed once on read and stored.
  const checks = await jobs.loadChecks(job.id);
  assert.equal(checks.version, CHECKS_VERSION);
  assert.deepEqual(first.verification, verifySummary(summary, transcript));
  // Only cited and uncertain segments by default; every segment on request.
  assert.equal(first.transcript.partial, true);
  assert.deepEqual(first.transcript.counts, {segments: 4, uncertain: 1});
  assert.deepEqual(first.transcript.segments.map(s => s.id), [1, 2, 3, 4]);
  const full = await (await get(`/api/v1/jobs/${job.id}?transcript=full`)).json();
  assert.equal(full.transcript.partial, false);
  assert.deepEqual(full.transcript.segments, transcript.segments);
  assert.deepEqual(first.transcript.coverage, transcript.coverage);
  assert.equal(first.transcript.source, SOURCES.UPLOAD);
  assert.deepEqual(first.summary, summary);
  assert.deepEqual(first.review.map(r => [r.segmentId, r.reasons]), [
    [2, ['전사 불확실(LOW_CONFIDENCE)']], [3, ['숫자 불일치: 1003억 원']]]);
  // Only segments the review and the JSON export cite are kept in the checks, not the whole transcript.
  assert.deepEqual(checks.segments.map(s => s.id), [1, 2, 3, 4]);
  assert.deepEqual(checks.counts, {segments: 4, uncertain: 1});
});

test('a correction outside the stored segments still shows in the review', async () => {
  const {jobs, job} = await seed();
  await refreshChecks(jobs, job.id);
  await jobs.saveCorrection(job.id, 4, '고친 문장');
  const detail = await (await get(`/api/v1/jobs/${job.id}`)).json();
  const item = detail.review.find(r => r.segmentId === 4);
  assert.deepEqual(item, {segmentId: 4, startMs: 3000, text: '마지막', corrected: '고친 문장', reasons: ['교정함']});
});

test('stale analysis items are dropped; exports use the stored checks', async () => {
  const {jobs, job} = await seed();
  const checks = await refreshChecks(jobs, job.id);
  const extra = {path: 'analysis[0]', surface: '9%', status: 'MISMATCH', codes: ['VALUE_CHANGED'], segmentIds: [1]};
  await jobs.saveChecks(job.id, {...checks, verification: {...checks.verification,
    items: [...checks.verification.items, extra]}});
  const detail = await (await get(`/api/v1/jobs/${job.id}`)).json();
  assert.equal(detail.verification.counts.total, checks.verification.counts.total);
  assert.ok(!detail.verification.items.some(i => i.path === 'analysis[0]'));
  const md = await (await get(`/api/v1/jobs/${job.id}/export`)).text();
  assert.match(md, /영업이익 1003억 원 \(근거 #3\) ⚠ 숫자 확인 필요/);
  const out = await (await get(`/api/v1/jobs/${job.id}/export?format=json`)).json();
  // Same as an export built from the whole transcript (apart from the export time).
  const {exportJson} = await import('../../src/v1/export-json.mjs');
  const full = exportJson({job: await jobs.get(job.id), transcript: await jobs.loadTranscript(job.id),
    summary: await jobs.loadSummary(job.id), verification: detail.verification, corrections: {}});
  assert.deepEqual({...out, exportedAt: null}, JSON.parse(JSON.stringify({...full, exportedAt: null})));
  assert.equal(out.transcript.segments, 4);
  assert.equal(out.transcript.uncertainSegments, 1);
});

test('schema setup: one lookup when tables exist, shared by parallel loads, creates when missing', async () => {
  const {ensureV1Schema, V1_OBJECTS} = await import('../../src/v1/db/schema.mjs');
  const raw = memoryDb();
  const base = d1(raw);
  const seen = [];
  const db = {prepare: sql => { seen.push(sql.trim().split(/\s+/).slice(0, 2).join(' ')); return base.prepare(sql); }};
  await Promise.all([ensureV1Schema(db), ensureV1Schema(db), ensureV1Schema(db)]);
  assert.equal(seen.filter(s => s === 'SELECT name').length, 1);
  assert.equal(seen.filter(s => s.startsWith('CREATE')).length, V1_OBJECTS.length);
  const other = [];
  const again = {prepare: sql => { other.push(sql); return base.prepare(sql); }};
  await ensureV1Schema(again);
  assert.equal(other.length, 1);
});

test('a result read with stored checks is one D1 query (each query costs Worker CPU)', async () => {
  const {jobs, job, db} = await seed();
  await refreshChecks(jobs, job.id);
  await get(`/api/v1/jobs/${job.id}`); // schema lookup happens once per instance
  const queries = [];
  env.env.DB = {prepare: sql => { queries.push(sql); return db.prepare(sql); }};
  const res = await get(`/api/v1/jobs/${job.id}`);
  assert.equal(res.status, 200);
  assert.equal(queries.length, 2); // a new binding object counts as a new instance: schema lookup + read
  queries.length = 0;
  await get(`/api/v1/jobs/${job.id}`);
  assert.equal(queries.length, 1);
});
