import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFreeModel, geminiClipRequest, placeSegments, transcribeClip, transcribeVideo,
} from '../../src/v1/providers/gemini.mjs';
import {fetchNativeCaptions, supadataRequestUrl} from '../../src/v1/providers/supadata.mjs';
import {createMemoryUsage} from '../../src/v1/usage.mjs';
import {geminiBody, jsonResponse, noSleep, scriptedFetch} from './fakes.mjs';

const URL_ = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const caption = (offset, duration, text) => ({offset, duration, text, lang: 'ko'});

test('Supadata request is always mode=native, never auto/generate, key only in header', async () => {
  const url = new URL(supadataRequestUrl(URL_));
  assert.equal(url.searchParams.get('mode'), 'native');
  assert.equal(url.searchParams.get('url'), URL_);
  const {fetchFn, calls} = scriptedFetch([jsonResponse({lang: 'ko', content: [caption(0, 1500, '안녕')]})]);
  const t = await fetchNativeCaptions({canonicalUrl: URL_, apiKey: 'sd-key', fetchFn});
  assert.equal(t.source, 'supadata-native');
  assert.equal(t.language, 'ko');
  assert.deepEqual(t.segments[0], {id: 1, startMs: 0, endMs: 1500, text: '안녕'});
  assert.equal(new URL(calls[0].url).searchParams.get('mode'), 'native');
  assert.doesNotMatch(calls[0].url, /sd-key/);
  assert.equal(calls[0].init.headers['x-api-key'], 'sd-key');
});

test('Supadata 206 means no captions; 202 job is polled until completed or failed', async () => {
  assert.equal(await fetchNativeCaptions({canonicalUrl: URL_, apiKey: 'k',
    fetchFn: scriptedFetch([jsonResponse(null, 206)]).fetchFn}), null);
  const polled = scriptedFetch([
    jsonResponse({jobId: 'job-1'}, 202), jsonResponse({status: 'active'}),
    jsonResponse({status: 'completed', result: {content: [caption(1000, 1000, 'done')]}}),
  ]);
  const t = await fetchNativeCaptions({canonicalUrl: URL_, apiKey: 'k', fetchFn: polled.fetchFn, sleep: noSleep});
  assert.equal(t.segments[0].text, 'done');
  assert.match(polled.calls[2].url, /\/v1\/transcript\/job-1$/);
  const failed = scriptedFetch([jsonResponse({jobId: 'job-2'}, 202), jsonResponse({status: 'failed'})]);
  assert.equal(await fetchNativeCaptions({canonicalUrl: URL_, apiKey: 'k', fetchFn: failed.fetchFn,
    sleep: noSleep}), null);
});

test('Supadata errors map to retry classes', async () => {
  const call = response => fetchNativeCaptions({canonicalUrl: URL_, apiKey: 'k',
    fetchFn: scriptedFetch([response]).fetchFn});
  await assert.rejects(call(jsonResponse({}, 429, {'retry-after': '7'})), e => e.code === 'PROVIDER_RATE_LIMITED'
    && e.retryAfterMs === 7000);
  await assert.rejects(call(jsonResponse({}, 503)), e => e.code === 'PROVIDER_FAILED' && e.retryable === true);
  await assert.rejects(call(jsonResponse({}, 401)), e => e.code === 'PROVIDER_FAILED' && !e.retryable);
  await assert.rejects(call(jsonResponse({content: [{text: 'x'}]})), {code: 'PROVIDER_INVALID_OUTPUT'});
  await assert.rejects(call(new TypeError('offline')), e => e.code === 'PROVIDER_FAILED' && e.retryable);
  await assert.rejects(fetchNativeCaptions({canonicalUrl: URL_, apiKey: ''}), {code: 'PROVIDER_KEY_MISSING'});
});

test('only free Flash-family Gemini models are accepted', () => {
  for (const ok of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.0-flash-001']) {
    assert.equal(assertFreeModel(ok), ok);
  }
  for (const bad of ['gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-2.5-flash-preview-tts', 'gpt-4o', '', null]) {
    assert.throws(() => assertFreeModel(bad), {code: 'PAID_API_BLOCKED'});
  }
});

test('Gemini clip request uses the YouTube URL, clip offsets, JSON schema and low resolution', () => {
  const body = geminiClipRequest({canonicalUrl: URL_, startSec: 900, endSec: 1800});
  const [video, prompt] = body.contents[0].parts;
  assert.deepEqual(video, {fileData: {fileUri: URL_}, videoMetadata: {startOffset: '900s', endOffset: '1800s'}});
  assert.match(prompt.text, /900초부터 1800초/);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW');
  assert.deepEqual(body.generationConfig.responseSchema.required, ['endOfVideo', 'segments']);
});

test('clip segments: absolute kept, relative shifted, outside rejected', () => {
  assert.equal(placeSegments([{start: 905, end: 910, text: 'a'}], 900, 1800)[0].startMs, 905_000);
  assert.equal(placeSegments([{start: 5, end: 10, text: 'a'}], 900, 1800)[0].startMs, 905_000);
  assert.throws(() => placeSegments([{start: 2000, end: 2100, text: 'a'}], 900, 1800),
    {code: 'PROVIDER_INVALID_OUTPUT'});
  assert.throws(() => placeSegments([{start: 'x', end: 1, text: 'a'}], 0, 900), {code: 'PROVIDER_INVALID_OUTPUT'});
});

test('Gemini finish reasons and malformed output', async () => {
  const call = body => transcribeClip({canonicalUrl: URL_, startSec: 0, endSec: 900, apiKey: 'g',
    fetchFn: scriptedFetch([jsonResponse(body)]).fetchFn});
  await assert.rejects(call(geminiBody({segments: [], endOfVideo: false}, {finishReason: 'MAX_TOKENS'})),
    {code: 'PROVIDER_INVALID_OUTPUT'});
  await assert.rejects(call(geminiBody({segments: []}, {finishReason: 'SAFETY'})), {code: 'PROVIDER_FAILED'});
  await assert.rejects(call({candidates: [{finishReason: 'STOP', content: {parts: [{text: 'not json'}]}}]}),
    {code: 'PROVIDER_INVALID_OUTPUT'});
  await assert.rejects(call(geminiBody({segments: []})), {code: 'PROVIDER_INVALID_OUTPUT'});
  await assert.rejects(transcribeClip({canonicalUrl: URL_, startSec: 0, endSec: 900, apiKey: 'g',
    model: 'gemini-2.5-pro'}), {code: 'PAID_API_BLOCKED'});
});

function clipHandler(endAtSec) {
  return (url, init) => {
    const {startOffset, endOffset} = JSON.parse(init.body).contents[0].parts[0].videoMetadata;
    const start = parseInt(startOffset, 10);
    const end = Math.min(parseInt(endOffset, 10), endAtSec ?? Infinity);
    const segments = start < end ? [{start, end: start + 10, text: `구간 ${start}`}, {start: end - 10, end,
      text: `끝 ${end}`}] : [];
    return jsonResponse(geminiBody({language: 'ko', segments, endOfVideo: endAtSec !== undefined && end >= endAtSec},
      {usage: {promptTokenCount: 1234, candidatesTokenCount: 50, totalTokenCount: 1284}}));
  };
}

test('video is transcribed clip by clip until the model reports the end', async () => {
  const {fetchFn, calls} = scriptedFetch([clipHandler(2000)]);
  const usage = createMemoryUsage({geminiCalls: 100, geminiVideoSeconds: 100_000});
  const {transcript, calls: usageLog} = await transcribeVideo({canonicalUrl: URL_, apiKey: 'g', fetchFn, usage,
    sleep: noSleep});
  assert.equal(calls.length, 3);
  assert.deepEqual(usageLog.map(c => [c.startSec, c.endSec, c.promptTokens]), [[0, 900, 1234], [900, 1800, 1234],
    [1800, 2700, 1234]]);
  assert.equal(usage.totals.geminiCalls, 3);
  assert.equal(transcript.source, 'gemini-video');
  assert.equal(transcript.durationSec, 2000);
  assert.equal(transcript.coverage.complete, true);
  assert.equal(transcript.language, 'ko');
});

test('known duration stops at the end; unknown duration stops at 2h and is marked partial', async () => {
  const known = scriptedFetch([clipHandler()]);
  const a = await transcribeVideo({canonicalUrl: URL_, apiKey: 'g', durationSec: 1000, fetchFn: known.fetchFn,
    sleep: noSleep});
  assert.equal(known.calls.length, 2);
  assert.equal(a.transcript.coverage.complete, true);
  const unknown = scriptedFetch([clipHandler()]);
  const b = await transcribeVideo({canonicalUrl: URL_, apiKey: 'g', fetchFn: unknown.fetchFn, sleep: noSleep});
  assert.equal(unknown.calls.length, 8);
  assert.equal(b.transcript.coverage.partial, true);
  assert.equal(b.transcript.coverage.complete, false);
});

test('daily cap stops Gemini before the request that would exceed it', async () => {
  const {fetchFn, calls} = scriptedFetch([clipHandler(5000)]);
  const usage = createMemoryUsage({geminiCalls: 100, geminiVideoSeconds: 1800});
  await assert.rejects(transcribeVideo({canonicalUrl: URL_, apiKey: 'g', fetchFn, usage, sleep: noSleep}),
    {code: 'DAILY_LIMIT_REACHED'});
  assert.equal(calls.length, 2);
});

test('an invalid clip response is retried once, then the clip succeeds', async () => {
  const good = clipHandler(600);
  const {fetchFn, calls} = scriptedFetch([jsonResponse(geminiBody({nope: true})), good]);
  const attempts = [];
  const {transcript} = await transcribeVideo({canonicalUrl: URL_, apiKey: 'g', fetchFn, sleep: noSleep, attempts});
  assert.equal(calls.length, 2);
  assert.deepEqual(attempts.map(a => a.outcome), ['error', 'ok']);
  assert.equal(transcript.segments.length, 2);
});
