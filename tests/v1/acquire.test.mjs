import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {acquireTranscript} from '../../src/v1/acquire.mjs';
import {findLegacyTranscript} from '../../src/v1/legacy-transcripts.mjs';
import {createMemoryUsage} from '../../src/v1/usage.mjs';
import {d1, geminiBody, jsonResponse, memoryDb, noSleep, scriptedFetch} from './fakes.mjs';

const ID = 'dQw4w9WgXcQ';
const URL_ = `https://youtu.be/${ID}`;
const root = new URL('../../', import.meta.url);

function legacyDb() {
  const db = memoryDb();
  db.exec(readFileSync(new URL('schema.sql', root), 'utf8'));
  db.exec(readFileSync(new URL('migrations/0002_live.sql', root), 'utf8'));
  return db;
}

function addLegacy(db, {jobId, duration, lastSec, updatedAt = '2026-10-20T00:00:00Z', videoId = ID}) {
  db.prepare(`INSERT INTO jobs(id, owner_id, video_id, title, source_url, source_type, status, duration_seconds,
    created_at, updated_at) VALUES(?, 'owner', ?, '예시', NULL, 'audio', 'DONE', ?, ?, ?)`)
    .run(jobId, videoId, duration, updatedAt, updatedAt);
  const segments = [{id: 1, startMs: 0, endMs: 5000, text: '시작'},
    {id: 2, startMs: (lastSec - 5) * 1000, endMs: lastSec * 1000, text: '끝'}];
  db.prepare('INSERT INTO yta_sources(job_id, raw, segments_json, provenance, updated_at) VALUES(?,?,?,?,?)')
    .run(jobId, '시작\n끝', JSON.stringify(segments), 'AUDIO', updatedAt);
}

const limits = {supadataCalls: 3, geminiCalls: 50, geminiVideoSeconds: 21_600, groqCalls: 0};
const keys = {supadata: 'sd', gemini: 'gm'};

test('legacy reader prefers a complete transcript and ignores other videos', async () => {
  const db = legacyDb();
  addLegacy(db, {jobId: 'partial', duration: 5892, lastSec: 3000, updatedAt: '2026-10-25T00:00:00Z'});
  addLegacy(db, {jobId: 'full', duration: 5892, lastSec: 5890, updatedAt: '2026-10-20T00:00:00Z'});
  addLegacy(db, {jobId: 'other', duration: 100, lastSec: 100, videoId: 'zzzzzzzzzzz'});
  const found = await findLegacyTranscript(d1(db), ID);
  assert.equal(found.legacyJobId, 'full');
  assert.equal(found.transcript.source, 'legacy-d1');
  assert.equal(found.transcript.coverage.complete, true);
  assert.equal(await findLegacyTranscript(d1(memoryDb()), ID), null);
  assert.equal(await findLegacyTranscript(null, ID), null);
});

test('a complete legacy transcript is reused with zero provider calls', async () => {
  const db = legacyDb();
  addLegacy(db, {jobId: 'full', duration: 600, lastSec: 600});
  const {fetchFn, calls} = scriptedFetch([new Error('must not be called')]);
  const result = await acquireTranscript({url: URL_, db: d1(db), keys, liveProvidersEnabled: true, fetchFn});
  assert.equal(result.method, 'legacy-d1');
  assert.equal(result.legacyJobId, 'full');
  assert.equal(calls.length, 0);
});

test('with live providers disabled nothing is called and the failure lists why', async () => {
  const {fetchFn, calls} = scriptedFetch([new Error('must not be called')]);
  await assert.rejects(acquireTranscript({url: URL_, keys, fetchFn}), error => {
    assert.equal(error.code, 'TRANSCRIPT_UNAVAILABLE');
    assert.deepEqual(error.attempts.map(a => a.step + ':' + a.outcome), ['legacy:none', 'providers:skipped']);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('existing captions win; Gemini is not called', async () => {
  const {fetchFn, calls} = scriptedFetch([jsonResponse({lang: 'en', content: [{offset: 0, duration: 900,
    text: 'hi'}]})]);
  const usage = createMemoryUsage(limits);
  const result = await acquireTranscript({url: URL_, keys, liveProvidersEnabled: true, fetchFn, usage});
  assert.equal(result.method, 'supadata-native');
  assert.equal(calls.length, 1);
  assert.equal(usage.totals.supadataCalls, 1);
});

test('no captions -> Gemini; Supadata 206 still counts one credit', async () => {
  const gemini = jsonResponse(geminiBody({language: 'ko', endOfVideo: true,
    segments: [{start: 0, end: 30, text: '전사'}]}));
  const {fetchFn, calls} = scriptedFetch([jsonResponse(null, 206), gemini]);
  const usage = createMemoryUsage(limits);
  const result = await acquireTranscript({url: URL_, keys, liveProvidersEnabled: true, fetchFn, usage,
    sleep: noSleep});
  assert.equal(result.method, 'gemini-video');
  assert.match(calls[1].url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.deepEqual(usage.totals, {supadataCalls: 1, geminiCalls: 1, geminiVideoSeconds: 900});
  assert.deepEqual(result.attempts.map(a => a.step + ':' + a.outcome), ['legacy:none', 'supadata:no-captions',
    'gemini:found']);
});

test('Supadata daily cap reached -> skips to Gemini without calling Supadata', async () => {
  const gemini = jsonResponse(geminiBody({endOfVideo: true, segments: [{start: 0, end: 5, text: 'x'}]}));
  const {fetchFn, calls} = scriptedFetch([gemini]);
  const usage = createMemoryUsage(limits, {supadataCalls: 3});
  const result = await acquireTranscript({url: URL_, keys, liveProvidersEnabled: true, fetchFn, usage,
    sleep: noSleep});
  assert.equal(result.method, 'gemini-video');
  assert.equal(calls.length, 1);
  assert.equal(result.attempts[1].code, 'DAILY_LIMIT_REACHED');
});

test('all paths failing falls back to a partial legacy transcript, else TRANSCRIPT_UNAVAILABLE', async () => {
  const db = legacyDb();
  addLegacy(db, {jobId: 'partial', duration: 600, lastSec: 200});
  const failing = () => scriptedFetch([jsonResponse({}, 403)]).fetchFn;
  const partial = await acquireTranscript({url: URL_, db: d1(db), keys, liveProvidersEnabled: true,
    fetchFn: failing(), sleep: noSleep});
  assert.equal(partial.method, 'legacy-d1');
  assert.equal(partial.transcript.coverage.complete, false);
  await assert.rejects(acquireTranscript({url: URL_, keys: {}, liveProvidersEnabled: true, fetchFn: failing()}),
    error => error.code === 'TRANSCRIPT_UNAVAILABLE'
      && error.attempts.filter(a => a.reason === 'PROVIDER_KEY_MISSING').length === 2);
});

test('transient Supadata failures are retried at most twice', async () => {
  const {fetchFn, calls} = scriptedFetch([jsonResponse({}, 503)]);
  const usage = createMemoryUsage(limits);
  await assert.rejects(acquireTranscript({url: URL_, keys: {supadata: 'sd'}, liveProvidersEnabled: true, fetchFn,
    usage, sleep: noSleep}), {code: 'TRANSCRIPT_UNAVAILABLE'});
  assert.equal(calls.length, 3);
  assert.equal(usage.totals.supadataCalls, 3);
});

test('Gemini-only mode skips saved transcripts and captions', async () => {
  const db = legacyDb();
  addLegacy(db, {jobId: 'full', duration: 600, lastSec: 600});
  const gemini = jsonResponse(geminiBody({endOfVideo: true, segments: [{start: 0, end: 5, text: '제미나이'}]}));
  const {fetchFn, calls} = scriptedFetch([gemini]);
  const usage = createMemoryUsage(limits);
  const result = await acquireTranscript({url: URL_, db: d1(db), keys, liveProvidersEnabled: true, fetchFn, usage,
    sleep: noSleep, geminiOnly: true});
  assert.equal(result.method, 'gemini-video');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /generativelanguage/);
  assert.equal(usage.totals.supadataCalls, undefined);
  assert.deepEqual(result.attempts.map(a => `${a.step}:${a.outcome}`), ['legacy:skipped', 'supadata:skipped',
    'gemini:found']);
});
