import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {handleV1Site} from '../../src/v1/entry.mjs';
import {jobRepository} from '../../src/v1/db/jobs.mjs';
import {createD1Usage} from '../../src/v1/db/usage.mjs';
import {runSummaryJob} from '../../src/v1/pipeline.mjs';
import {routeV1} from '../../src/v1/router.mjs';
import {d1, geminiBody, jsonResponse, memoryDb} from './fakes.mjs';

const BASE = 'https://site.test';
const ID = 'dQw4w9WgXcQ';
const root = new URL('../../', import.meta.url);

function environment({legacy = true, live = true} = {}) {
  const db = memoryDb();
  if (legacy) {
    db.exec(readFileSync(new URL('schema.sql', root), 'utf8'));
    db.exec(readFileSync(new URL('migrations/0002_live.sql', root), 'utf8'));
  }
  return {db, env: {DB: d1(db), ENABLE_LIVE_FREE: live ? 'true' : 'false', SUPADATA_API_KEY: 'sd-key-123',
    GEMINI_API_KEY: 'gm-key-123'}};
}

const summaryFor = ids => ({
  conclusion: {text: '결론', segmentIds: [ids[0]], facts: []},
  keyPoints: ids.slice(0, 3).map(id => ({text: `요점 ${id}`, attribution: 'SPEAKER', segmentIds: [id], facts: []})),
  chapters: [{startSegmentId: ids[0], title: '시작', summary: '요약', facts: []}],
});

// Routes provider URLs to canned answers and counts calls per provider.
function providers({captions = 3, failMap = null} = {}) {
  const count = {supadata: 0, gemini: 0, oembed: 0};
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.supadata.ai/')) {
      count.supadata += 1;
      return jsonResponse({lang: 'ko', content: Array.from({length: captions}, (_, i) => ({offset: i * 1000,
        duration: 1000, text: `자막 ${i + 1}`}))});
    }
    if (u.includes('/oembed')) {
      count.oembed += 1;
      return jsonResponse({title: '테스트 영상'});
    }
    if (u.includes('generativelanguage.googleapis.com')) {
      count.gemini += 1;
      const prompt = JSON.parse(init.body).contents[0].parts[0].text;
      const range = prompt.match(/구간 #(\d+)~#(\d+)/);
      if (range) {
        if (failMap && Number(range[1]) === failMap.fromId && failMap.remaining-- > 0) return jsonResponse({}, 403);
        const from = Number(range[1]);
        return jsonResponse(geminiBody({points: [{text: '점', attribution: 'SPEAKER', segmentIds: [from], facts: []}],
          chapters: [{startSegmentId: from, title: `부분 ${from}`, summary: '요약', facts: []}]}));
      }
      const starts = [...prompt.matchAll(/\(#(\d+)~#\d+\)/g)].map(m => Number(m[1]));
      const ids = starts.length >= 3 ? starts : [1, 2, 3];
      return jsonResponse(geminiBody(summaryFor(ids)));
    }
    throw new Error(`unexpected ${u}`);
  };
  return {fetchFn, count};
}

const post = (path, body) => new Request(`${BASE}${path}`, {method: 'POST', body: JSON.stringify(body),
  headers: {origin: BASE, 'content-type': 'application/json'}});

test('URL submit -> captions -> summary saved -> reopen, list, export, delete', async () => {
  const {db, env} = environment();
  const {fetchFn, count} = providers();
  const deps = {fetchFn, sleep: async () => {}};
  const created = await routeV1(post('/api/v1/jobs', {url: `https://youtu.be/${ID}`}), env, null, deps);
  assert.equal(created.status, 202);
  const {job, runner} = await created.json();
  assert.equal(runner, 'inline');
  const detail = await (await routeV1(new Request(`${BASE}/api/v1/jobs/${job.id}`), env, null, deps)).json();
  assert.equal(detail.job.status, 'DONE');
  assert.equal(detail.job.title, '테스트 영상');
  assert.equal(detail.job.transcriptSource, 'supadata-native');
  assert.equal(detail.transcript.segments.length, 3);
  assert.equal(detail.summary.version, 'v1-summary-1');
  assert.equal(detail.summary.generation.mode, 'single');
  assert.deepEqual(count, {supadata: 1, gemini: 1, oembed: 1});

  const list = await (await routeV1(new Request(`${BASE}/api/v1/jobs?q=테스트`), env, null, deps)).json();
  assert.deepEqual(list.jobs.map(j => j.id), [job.id]);
  const md = await (await routeV1(new Request(`${BASE}/api/v1/jobs/${job.id}/export`), env, null, deps)).text();
  assert.match(md, /^# 테스트 영상/);
  assert.match(md, /전사 출처: YouTube 기존 자막/);
  assert.match(md, /\[화자\] 요점 1/);
  const txt = await routeV1(new Request(`${BASE}/api/v1/jobs/${job.id}/export?format=txt`), env, null, deps);
  assert.match(txt.headers.get('content-type'), /^text\/plain/);

  const usage = await (await routeV1(new Request(`${BASE}/api/v1/usage`), env, null, deps)).json();
  assert.deepEqual(usage.keys, {supadata: true, gemini: true, groq: false});
  assert.equal(usage.usage.items.find(i => i.key === 'supadataCalls').used, 1);

  const again = await (await routeV1(post('/api/v1/jobs', {url: `https://www.youtube.com/watch?v=${ID}`}), env, null,
    deps)).json();
  assert.equal(again.reused, true);
  assert.equal(count.supadata, 1);

  const del = await routeV1(new Request(`${BASE}/api/v1/jobs/${job.id}`, {method: 'DELETE',
    headers: {origin: BASE}}), env, null, deps);
  assert.equal(del.status, 200);
  assert.equal((await routeV1(new Request(`${BASE}/api/v1/jobs/${job.id}`), env, null, deps)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM v1_transcripts').get().n, 0);
});

test('v0.7 tables are untouched; v1 tables are added', async () => {
  const {db, env} = environment();
  const before = db.prepare("SELECT name, sql FROM sqlite_master WHERE instr(name, 'v1_') = 0 ORDER BY name").all();
  const {fetchFn} = providers();
  await routeV1(post('/api/v1/jobs', {url: `https://youtu.be/${ID}`}), env, null, {fetchFn});
  const after = db.prepare("SELECT name, sql FROM sqlite_master WHERE instr(name, 'v1_') = 0 ORDER BY name").all();
  assert.deepEqual(after, before);
  const v1 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'v1_%' ORDER BY name").all();
  assert.deepEqual(v1.map(r => r.name), ['v1_jobs', 'v1_summaries', 'v1_transcripts', 'v1_usage']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
});

test('upload path summarizes without any transcript provider call', async () => {
  const {env} = environment();
  const {fetchFn, count} = providers();
  const srt = '1\n00:00:00,000 --> 00:00:02,000\n하나\n\n2\n00:00:02,000 --> 00:00:04,000\n둘\n\n'
    + '3\n00:00:04,000 --> 00:00:06,000\n셋\n';
  const res = await routeV1(post('/api/v1/jobs/upload', {filename: 'a.srt', text: srt, title: '업로드'}), env, null,
    {fetchFn});
  const {job} = await res.json();
  const detail = await (await routeV1(new Request(`${BASE}/api/v1/jobs/${job.id}`), env, null, {})).json();
  assert.equal(detail.job.status, 'DONE');
  assert.equal(detail.job.transcriptSource, 'upload');
  assert.deepEqual(count, {supadata: 0, gemini: 1, oembed: 0});
});

test('no transcript anywhere -> job FAILED with reasons recorded', async () => {
  const {env} = environment({live: false});
  const res = await routeV1(post('/api/v1/jobs', {url: `https://youtu.be/${ID}`}), env, null, {});
  const {job} = await res.json();
  const detail = await (await routeV1(new Request(`${BASE}/api/v1/jobs/${job.id}`), env, null, {})).json();
  assert.equal(detail.job.status, 'FAILED');
  assert.equal(detail.job.errorCode, 'TRANSCRIPT_UNAVAILABLE');
  assert.deepEqual(detail.job.attempts.map(a => a.step), ['legacy', 'providers', 'failure']);
  assert.equal(detail.job.attempts.at(-1).code, 'TRANSCRIPT_UNAVAILABLE');
});

// A durable step store: finished steps are cached by name, like the Workflow engine on replay.
function durableStep(cache, ran) {
  return {do: async (name, options, fn) => {
    if (cache.has(name)) return cache.get(name);
    ran.push(name);
    const value = await (fn ?? options)();
    cache.set(name, value);
    return value;
  }};
}

test('a long job resumes after a failed step without redoing finished steps', async () => {
  const {env} = environment();
  const jobs = jobRepository(env.DB);
  const job = await jobs.create({videoId: ID, url: `https://www.youtube.com/watch?v=${ID}`});
  const {fetchFn, count} = providers({captions: 1440, failMap: {fromId: 361, remaining: 1}});
  const longCaptions = async (url, init) => {
    const res = await fetchFn(url, init);
    if (!String(url).startsWith('https://api.supadata.ai/')) return res;
    const body = await res.json();
    body.content = body.content.map((c, i) => ({...c, offset: i * 5000, duration: 5000,
      text: `${c.text} 이 문장은 길이를 늘리기 위한 설명입니다.`}));
    return jsonResponse(body);
  };
  const cache = new Map();
  const ran = [];
  const first = await runSummaryJob({jobId: job.id, env, step: durableStep(cache, ran),
    deps: {fetchFn: longCaptions, sleep: async () => {}}});
  assert.equal(first.status, 'FAILED');
  assert.deepEqual(ran, ['acquire', 'plan', 'map-1', 'map-2', 'map-3']);
  const geminiAfterFirst = count.gemini;

  ran.length = 0;
  const second = await runSummaryJob({jobId: job.id, env, step: durableStep(cache, ran),
    deps: {fetchFn: longCaptions, sleep: async () => {}}});
  assert.equal(second.status, 'DONE');
  assert.deepEqual(ran, ['map-3', 'map-4', 'map-5', 'map-6', 'map-7', 'map-8', 'reduce', 'save']);
  assert.equal(count.supadata, 1);
  assert.equal(count.gemini - geminiAfterFirst, 7);
  const summary = await jobs.loadSummary(job.id);
  assert.equal(summary.generation.mode, 'map-reduce');
  assert.equal(summary.generation.chunkCount, 8);
});

test('D1 usage caps are atomic per key and refund partial reservations', async () => {
  const {env} = environment();
  const usage = createD1Usage(env.DB, {geminiCalls: 2, geminiVideoSeconds: 1000}, {now: () => '2026-11-21T10:00:00Z'});
  await usage.consume({geminiCalls: 1, geminiVideoSeconds: 900});
  await assert.rejects(usage.consume({geminiCalls: 1, geminiVideoSeconds: 900}), {code: 'DAILY_LIMIT_REACHED'});
  const snap = await usage.snapshot();
  assert.deepEqual(snap.items, [{key: 'geminiCalls', used: 1, limit: 2}, {key: 'geminiVideoSeconds', used: 900,
    limit: 1000}]);
  const nextDay = createD1Usage(env.DB, {geminiCalls: 2, geminiVideoSeconds: 1000},
    {now: () => '2026-11-22T00:00:01Z'});
  await nextDay.consume({geminiCalls: 2});
  await assert.rejects(nextDay.consume({nope: 1}), {code: 'INTERNAL'});
});

test('v1 API sits behind Cloudflare Access and the same-origin check', async () => {
  const {env} = environment();
  const unauth = await handleV1Site(new Request(`${BASE}/api/v1/health`), {...env,
    ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud-123456789012',
    ACCESS_OWNER_EMAIL: 'o@x.io'});
  assert.equal(unauth.status, 401);
  const crossSite = await routeV1(new Request(`${BASE}/api/v1/jobs`, {method: 'POST', body: '{}',
    headers: {origin: 'https://evil.test'}}), env);
  assert.equal((await crossSite.json()).error.code, 'FORBIDDEN_ORIGIN');
  assert.equal((await routeV1(new Request(`${BASE}/api/v1/jobs`), {})).status, 503);
});

test('transcriptMode gemini creates a new job and never calls Supadata', async () => {
  const {env} = environment();
  const {fetchFn, count} = providers();
  const gem = async (url, init) => {
    if (String(url).includes('generativelanguage') && JSON.parse(init.body).contents[0].parts[0].fileData) {
      count.gemini += 1;
      return jsonResponse(geminiBody({endOfVideo: true, segments: [1, 2, 3].map(i => ({start: i, end: i + 1,
        text: `문장 ${i}`}))}));
    }
    return fetchFn(url, init);
  };
  const first = await (await routeV1(post('/api/v1/jobs', {url: `https://youtu.be/${ID}`}), env, null,
    {fetchFn: gem})).json();
  const second = await (await routeV1(post('/api/v1/jobs', {url: `https://youtu.be/${ID}`, transcriptMode: 'gemini'}),
    env, null, {fetchFn: gem, sleep: async () => {}})).json();
  assert.notEqual(second.job.id, first.job.id);
  const detail = await (await routeV1(new Request(`${BASE}/api/v1/jobs/${second.job.id}`), env, null, {})).json();
  assert.equal(detail.job.status, 'DONE');
  assert.equal(detail.job.transcriptSource, 'gemini-video');
  assert.deepEqual(detail.job.options, {geminiOnly: true});
  assert.equal(count.supadata, 1);
  const bad = await routeV1(post('/api/v1/jobs', {url: `https://youtu.be/${ID}`, transcriptMode: 'paid'}), env);
  assert.equal(bad.status, 400);
});

// The real Workflow engine re-wraps errors thrown inside step.do as plain Errors.
function rewrappingStep() {
  return {do: async (name, options, fn) => {
    try {
      return await (fn ?? options)();
    } catch (error) {
      throw new Error(error.message);
    }
  }};
}

test('error codes and provider reasons survive the Workflow error re-wrapping', async () => {
  const {env} = environment();
  const jobs = jobRepository(env.DB);
  const job = await jobs.create({videoId: ID, url: `https://www.youtube.com/watch?v=${ID}`,
    options: {geminiOnly: true}});
  const rejecting = async () => jsonResponse({error: {code: 400,
    message: 'Model not found for API key AIzaSyFAKEFAKEFAKEFAKE1234'}}, 400);
  const result = await runSummaryJob({jobId: job.id, env, step: rewrappingStep(), deps: {fetchFn: rejecting,
    sleep: async () => {}}});
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'TRANSCRIPT_UNAVAILABLE');
  const saved = await jobs.get(job.id);
  assert.equal(saved.errorCode, 'TRANSCRIPT_UNAVAILABLE');
  const gemini = saved.attempts.find(a => a.step === 'gemini');
  assert.equal(gemini.code, 'PROVIDER_FAILED');
  assert.match(gemini.detail, /gemini 400: Model not found/);
  assert.doesNotMatch(JSON.stringify(saved.attempts), /AIzaSy/);
  assert.match(saved.attempts.at(-1).detail, /^acquire: /);
});
