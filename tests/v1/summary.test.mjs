import assert from 'node:assert/strict';
import test from 'node:test';
import {AppError} from '../../src/v1/errors.mjs';
import {chunkTranscript} from '../../src/v1/summary/chunks.mjs';
import {summarizeTranscript} from '../../src/v1/summary/engine.mjs';
import {FINAL_SCHEMA, MAP_SCHEMA} from '../../src/v1/summary/schema.mjs';
import {makeTranscript, SOURCES} from '../../src/v1/transcript.mjs';
import {createMemoryUsage} from '../../src/v1/usage.mjs';
import {noSleep} from './fakes.mjs';

// 2 hours, one 5-second segment each: #1 at 0s ... #1440 at 7195s.
function twoHourTranscript() {
  const segments = Array.from({length: 1440}, (_, i) => ({
    startMs: i * 5000, endMs: i * 5000 + 5000,
    text: `${Math.floor(i / 180) + 1}번째 주제에 대한 설명 문장 ${i + 1}입니다. 매출 비중은 약 20%라고 말했다.`,
  }));
  return makeTranscript({source: SOURCES.LEGACY_D1, segments, durationSec: 7200});
}

const shortTranscript = () => makeTranscript({source: SOURCES.UPLOAD, segments: [
  {startMs: 0, endMs: 1000, text: '짧은 영상'}, {startMs: 1000, endMs: 2000, text: '둘째'},
  {startMs: 2000, endMs: 3000, text: '셋째'}]});

const fact = id => ({surface: '약 20%', value: 20, unit: 'PERCENT', qualifier: 'APPROXIMATE', kind: 'SHARE',
  subject: '매출', segmentIds: [id], quote: '매출 비중은 약 20%라고 말했다.'});
const point = (id, attribution = 'SPEAKER') => ({text: `매출 비중은 약 20%다 (#${id}).`, attribution,
  segmentIds: [id], facts: [fact(id)]});

// A fake model that answers like a well-behaved LLM, based only on the prompt it receives.
function fakeModel({provider = 'gemini', usageKey = 'geminiCalls', broken = 0} = {}) {
  const prompts = [];
  return {
    provider, model: `${provider}-fake`, usageKey, prompts,
    async generateJson({prompt, schema, system}) {
      prompts.push({prompt, schema, system});
      if (prompts.length <= broken) return {data: {nope: true}, usage: {promptTokens: 1}};
      if (schema === MAP_SCHEMA) {
        const [, from, to] = prompt.match(/구간 #(\d+)~#(\d+)/).map(Number);
        return {data: {points: [point(from), point(to, 'INTERPRETATION'), point(from + 1)],
          chapters: [{startSegmentId: from, title: `주제 ${from}`, summary: '설명', facts: []}]},
        usage: {promptTokens: 1000, outputTokens: 200}};
      }
      assert.equal(schema, FINAL_SCHEMA);
      const starts = [...prompt.matchAll(/\(#(\d+)~#\d+\)/g)].map(m => Number(m[1]));
      const ids = starts.length ? starts : [1];
      return {data: {
        conclusion: {text: '핵심 결론입니다.', segmentIds: [ids[0]], facts: []},
        keyPoints: [point(ids[0]), point(ids.at(-1)), point(ids[0] + 1, 'INTERPRETATION')],
        chapters: ids.map(id => ({startSegmentId: id, title: `챕터 ${id}`, summary: '요약', facts: []})),
      }, usage: {promptTokens: 3000, outputTokens: 800}};
    },
  };
}

const limits = {supadataCalls: 3, geminiCalls: 200, geminiVideoSeconds: 21_600, groqCalls: 200};

test('2-hour transcript: 8 chunks map-reduce, chapters timed from transcript segments', async () => {
  const transcript = twoHourTranscript();
  const model = fakeModel();
  const usage = createMemoryUsage(limits);
  const result = await summarizeTranscript({transcript, title: '예시', models: [model], usage, sleep: noSleep});
  assert.equal(result.generation.mode, 'map-reduce');
  assert.equal(result.generation.chunkCount, 8);
  assert.equal(model.prompts.length, 9);
  assert.equal(usage.totals.geminiCalls, 9);
  assert.equal(result.chapters.length, 8);
  assert.deepEqual(result.chapters.map(c => c.startSegmentId), [1, 181, 361, 541, 721, 901, 1081, 1261]);
  assert.deepEqual(result.chapters.map(c => c.startMs / 1000), [0, 900, 1800, 2700, 3600, 4500, 5400, 6300]);
  assert.equal(result.chapters.at(-1).endMs, 7_200_000);
  result.chapters.slice(1).forEach((c, i) => assert.equal(result.chapters[i].endMs, c.startMs));
  assert.equal(result.conclusion.text, '핵심 결론입니다.');
  assert.deepEqual(result.keyPoints.map(p => p.attribution), ['SPEAKER', 'SPEAKER', 'INTERPRETATION']);
  assert.equal(result.keyPoints[0].facts[0].qualifier, 'APPROXIMATE');
  assert.equal(result.version, 'v1-summary-1');
  assert.ok(result.generation.calls.every(c => c.outcome === 'ok' && c.promptTokens > 0));
  // Every map call only sees its own chunk and is told its allowed ID range.
  assert.match(model.prompts[1].prompt, /구간 #181~#360/);
  assert.doesNotMatch(model.prompts[1].prompt, /\[#361 /);
  assert.match(model.prompts[0].system, /비중.*증가율/);
});

test('short transcript is summarized in a single call', async () => {
  const transcript = makeTranscript({source: SOURCES.UPLOAD, segments: [
    {startMs: 0, endMs: 4000, text: '안녕하세요.'}, {startMs: 4000, endMs: 9000, text: '오늘은 날씨 이야기입니다.'}]});
  const model = fakeModel();
  const result = await summarizeTranscript({transcript, models: [model], sleep: noSleep});
  assert.equal(result.generation.mode, 'single');
  assert.equal(model.prompts.length, 1);
  assert.match(model.prompts[0].prompt, /\[#2 00:04\] 오늘은 날씨 이야기입니다\./);
  assert.equal(result.chapters[0].startMs, 0);
});

test('invalid output is retried once; second success is used', async () => {
  const transcript = shortTranscript();
  const model = fakeModel({broken: 1});
  const result = await summarizeTranscript({transcript, models: [model], sleep: noSleep});
  assert.equal(model.prompts.length, 2);
  assert.deepEqual(result.generation.calls[0].tries.map(t => t.outcome), ['error', 'ok']);
});

test('invalid twice -> fails with PROVIDER_INVALID_OUTPUT, or falls back to the next model', async () => {
  const transcript = shortTranscript();
  const only = fakeModel({broken: 2});
  await assert.rejects(summarizeTranscript({transcript, models: [only], sleep: noSleep}),
    {code: 'PROVIDER_INVALID_OUTPUT'});
  assert.equal(only.prompts.length, 2);
  const primary = fakeModel({broken: 2});
  const fallback = fakeModel({provider: 'groq', usageKey: 'groqCalls'});
  const usage = createMemoryUsage(limits);
  const result = await summarizeTranscript({transcript, models: [primary, fallback], usage, sleep: noSleep});
  assert.deepEqual(result.generation.calls.map(c => `${c.provider}:${c.outcome}`), ['gemini:error', 'groq:ok']);
  assert.deepEqual(usage.totals, {geminiCalls: 2, groqCalls: 1});
});

test('daily cap on the primary model moves to the fallback without calling the primary', async () => {
  const transcript = shortTranscript();
  const primary = fakeModel();
  const fallback = fakeModel({provider: 'groq', usageKey: 'groqCalls'});
  const usage = createMemoryUsage(limits, {geminiCalls: 200});
  const result = await summarizeTranscript({transcript, models: [primary, fallback], usage, sleep: noSleep});
  assert.equal(primary.prompts.length, 0);
  assert.equal(result.generation.calls[0].code, 'DAILY_LIMIT_REACHED');
  assert.equal(result.generation.calls[1].provider, 'groq');
});

test('no model configured is a clear error', async () => {
  const transcript = makeTranscript({source: SOURCES.UPLOAD, segments: [{text: 'x'}]});
  await assert.rejects(summarizeTranscript({transcript, models: []}), e => e instanceof AppError
    && e.code === 'PROVIDER_KEY_MISSING');
});

test('chunking respects segment boundaries, time windows and character budget', () => {
  const chunks = chunkTranscript(twoHourTranscript());
  assert.equal(chunks.length, 8);
  assert.deepEqual([chunks[0].fromId, chunks[0].toId, chunks[7].toId], [1, 180, 1440]);
  const small = chunkTranscript(twoHourTranscript(), {chunkChars: 5000});
  assert.ok(small.length > 8);
  small.forEach((c, i) => i && assert.equal(c.fromId, small[i - 1].toId + 1));
  const untimed = makeTranscript({source: SOURCES.UPLOAD, segments: Array.from({length: 10}, () => ({
    text: '가'.repeat(1000)}))});
  assert.equal(chunkTranscript(untimed, {chunkChars: 3100}).length, 4);
});
