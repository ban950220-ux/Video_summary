import assert from 'node:assert/strict';
import test from 'node:test';
import {geminiTextModel, groqTextModel} from '../../src/v1/providers/llm.mjs';
import {
  FINAL_SCHEMA, numberWarnings, toJsonSchema, validateFinal, validateMapOutput,
} from '../../src/v1/summary/schema.mjs';
import {geminiBody, jsonResponse, scriptedFetch} from './fakes.mjs';

const ids = {segmentIds: [1, 2, 3, 4, 5]};
const fact = (over = {}) => ({surface: '약 20%', value: 20, unit: 'PERCENT', qualifier: 'APPROXIMATE', segmentIds: [2],
  quote: '이십 퍼센트 정도', ...over});
const point = (over = {}) => ({text: '내용', attribution: 'SPEAKER', segmentIds: [1], facts: [], ...over});
const chapter = (startSegmentId, over = {}) => ({startSegmentId, title: '제목', summary: '요약', facts: [], ...over});
const final = (over = {}) => ({
  conclusion: {text: '결론', segmentIds: [1], facts: []},
  keyPoints: [point(), point({segmentIds: [2]}), point({segmentIds: [3], attribution: 'INTERPRETATION'})],
  chapters: [chapter(1), chapter(3)],
  ...over,
});
const rejects = (fn, why) => assert.throws(fn, e => e.code === 'PROVIDER_INVALID_OUTPUT' && why.test(e.detail));

test('a valid final summary passes and is normalized', () => {
  const out = validateFinal(final({keyPoints: [point({segmentIds: [3, 1, 1], facts: [fact()]}), point(), point()]}),
    ids);
  assert.deepEqual(out.keyPoints[0].segmentIds, [1, 3]);
  assert.deepEqual(out.keyPoints[0].facts[0], {...fact(), kind: null, subject: null});
});

test('evidence must exist: unknown or missing segment IDs are rejected', () => {
  rejects(() => validateFinal(final({conclusion: {text: '결론', segmentIds: [99], facts: []}}), ids), /#99/);
  rejects(() => validateFinal(final({keyPoints: [point({segmentIds: []}), point(), point()]}), ids), /no evidence/);
  rejects(() => validateFinal(final({keyPoints: [point({facts: [fact({segmentIds: [42]})]}), point(), point()]}), ids),
    /#42/);
});

test('speaker/interpretation, units and qualifiers must use the fixed vocabulary', () => {
  rejects(() => validateFinal(final({keyPoints: [point({attribution: 'FACT'}), point(), point()]}), ids),
    /attribution/);
  rejects(() => validateFinal(final({keyPoints: [point({facts: [fact({unit: '%'})]}), point(), point()]}), ids),
    /unit/);
  rejects(() => validateFinal(final({keyPoints: [point({facts: [fact({qualifier: '약'})]}), point(), point()]}), ids),
    /qualifier/);
  rejects(() => validateFinal(final({keyPoints: [point({facts: [fact({value: '20'})]}), point(), point()]}), ids),
    /value/);
  rejects(() => validateFinal(final({keyPoints: [point({facts: [fact({quote: ''})]}), point(), point()]}), ids),
    /quote/);
});

test('chapters must be ascending and within bounds; keyPoints 3-12', () => {
  rejects(() => validateFinal(final({chapters: [chapter(3), chapter(1)]}), ids), /ascending/);
  rejects(() => validateFinal(final({chapters: [chapter(1), chapter(1)]}), ids), /ascending/);
  rejects(() => validateFinal(final({chapters: []}), ids), /need 1-40/);
  rejects(() => validateFinal(final({keyPoints: [point()]}), ids), /3-12/);
  rejects(() => validateFinal('not json object', ids), /not object/);
});

test('map output may only cite its own chunk range', () => {
  const chunk = {fromId: 10, toId: 20};
  const ok = validateMapOutput({points: [point({segmentIds: [10]})], chapters: [chapter(10)]}, chunk);
  assert.equal(ok.chapters[0].startSegmentId, 10);
  rejects(() => validateMapOutput({points: [point({segmentIds: [21]})], chapters: [chapter(10)]}, chunk), /#21/);
  rejects(() => validateMapOutput({points: [point({segmentIds: [10]})], chapters: [chapter(9)]}, chunk),
    /startSegmentId/);
});

test('numbers without facts are recorded as warnings (verified in stage 8)', () => {
  const summary = validateFinal(final({keyPoints: [point({text: '30명이 참석했다'}), point(), point()]}), ids);
  assert.deepEqual(numberWarnings(summary), [{path: 'keyPoints[0]', code: 'NUMBER_WITHOUT_FACT'}]);
});

test('JSON Schema conversion lowercases types and forbids extra fields', () => {
  const schema = toJsonSchema(FINAL_SCHEMA);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.keyPoints.items.properties.facts.items.properties.value.type, 'number');
});

test('Gemini text model: system rules, response schema, Flash-only, finish reasons', async () => {
  const {fetchFn, calls} = scriptedFetch([jsonResponse(geminiBody({a: 1}))]);
  const model = geminiTextModel({apiKey: 'g', fetchFn});
  const out = await model.generateJson({system: 'RULES', prompt: 'P', schema: FINAL_SCHEMA});
  assert.deepEqual(out.data, {a: 1});
  assert.match(calls[0].url, /gemini-3\.8-flash:generateContent$/);
  assert.equal(calls[0].body.systemInstruction.parts[0].text, 'RULES');
  assert.deepEqual(calls[0].body.generationConfig.responseSchema, FINAL_SCHEMA);
  assert.throws(() => geminiTextModel({apiKey: 'g', model: 'gemini-2.5-pro'}), {code: 'PAID_API_BLOCKED'});
  const cut = geminiTextModel({apiKey: 'g', fetchFn: scriptedFetch([jsonResponse(geminiBody({}, {
    finishReason: 'MAX_TOKENS'}))]).fetchFn});
  await assert.rejects(cut.generateJson({system: '', prompt: '', schema: {}}), {code: 'PROVIDER_INVALID_OUTPUT'});
});

test('Groq text model: allowlisted free models, JSON mode, schema in the system message', async () => {
  const reply = {choices: [{finish_reason: 'stop', message: {content: '{"ok":true}'}}],
    usage: {prompt_tokens: 5, completion_tokens: 2}};
  const {fetchFn, calls} = scriptedFetch([jsonResponse(reply)]);
  const model = groqTextModel({apiKey: 'q', fetchFn});
  const out = await model.generateJson({system: 'RULES', prompt: 'P', schema: FINAL_SCHEMA});
  assert.deepEqual(out, {data: {ok: true}, usage: {promptTokens: 5, outputTokens: 2}});
  assert.equal(calls[0].body.response_format.type, 'json_object');
  assert.match(calls[0].body.messages[0].content, /출력 JSON 스키마/);
  assert.equal(calls[0].init.headers.authorization, 'Bearer q');
  assert.throws(() => groqTextModel({apiKey: 'q', model: 'some-paid-model'}), {code: 'PAID_API_BLOCKED'});
  const cut = groqTextModel({apiKey: 'q', fetchFn: scriptedFetch([jsonResponse({choices: [{finish_reason: 'length',
    message: {content: '{'}}]})]).fetchFn});
  await assert.rejects(cut.generateJson({system: '', prompt: '', schema: {}}), {code: 'PROVIDER_INVALID_OUTPUT'});
});
