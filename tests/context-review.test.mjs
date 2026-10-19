import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sourceBindingSha256, independentBindingSha256, validateContextReviewLayer } from '../web/site/context-review.mjs';

const source = { segments: [
  { id: 1, startMs: 0, endMs: 1000, text: '내국인은 못 받는다' },
  { id: 2, startMs: 1000, endMs: 2000, text: '외국인은 받는다' }
] };
const independent = [
  { chunk: 0, startMs: 0, endMs: 1000, text: '외국인은 못 받는다' },
  { chunk: 0, startMs: 1000, endMs: 2000, text: '내국인은 받는다' }
];
async function layer() {
  return {
    schema: 'offline-context-candidates/v3', source_segment_count: 2,
    source_binding_sha256: await sourceBindingSha256(source.segments),
    independent_segment_count: 2, independent_binding_sha256: await independentBindingSha256(independent),
    independent_evidence_status: 'USER_SUPPLIED_ASR_NOT_AUDIO_VERIFIED',
    source_mutated: false, external_search_executed: false, audio_verified: false,
    candidates: [{ confirmed: false, decision: 'HUMAN_AUDIO_REVIEW_REQUIRED', category: 'subject_reversal', original_phrase: '내국인', proposed_phrase: '외국인', evidence_kind: 'stored_vs_offline_asr', reason: '검토', time_ms: [0, 2000], independent_window_ms: [0, 2000], source_segment_ids: [1, 2], stored_context: source.segments.map(s => ({ id: s.id, start_ms: s.startMs, end_ms: s.endMs, text: s.text })), offline_context: independent.map((s,index) => ({ index, chunk:s.chunk, start_ms:s.startMs, end_ms:s.endMs, text:s.text })) }],
    semantic_review_candidates: [{ confirmed: false, decision: 'HUMAN_AUDIO_REVIEW_REQUIRED', start_ms: 0, end_ms: 2000, flags: ['SUBJECT_POLARITY_REVERSAL_REVIEW'], source_segment_ids: [1, 2], stored_text: source.segments.map(s => s.text).join(' '), offline_text: independent.map(s => s.text).join(' ') }]
  };
}

test('both full texts are required and all evidence fields are independently checked', async () => {
  const item = await layer();
  const valid = await validateContextReviewLayer(item, source, independent);
  assert.equal(valid.candidates.length, 1);
  assert.equal(valid.evidenceStatus, 'USER_SUPPLIED_ASR_NOT_AUDIO_VERIFIED');
  await assert.rejects(validateContextReviewLayer(item, source), /별도 자동 전사/);
  await assert.rejects(validateContextReviewLayer(item, { segments: [{ ...source.segments[0], text: '바뀐 원문' }, source.segments[1]] }, independent), /저장 전사/);
  await assert.rejects(validateContextReviewLayer(item, source, [{ ...independent[0], text: '바뀐 독립 전사' }, independent[1]]), /별도 자동 전사 원문/);
  const altered = change => { const copy = structuredClone(item); change(copy); return copy; };
  for (const change of [
    copy => { copy.candidates[0].time_ms[0] = 1; },
    copy => { copy.candidates[0].original_phrase = '임의의 표현'; },
    copy => { copy.candidates[0].stored_context[0].start_ms = 1; },
    copy => { copy.candidates[0].offline_context[0].text = '바뀐 독립 전사'; },
    copy => { copy.candidates[0].offline_context[0].start_ms = 1; },
    copy => { copy.semantic_review_candidates[0].stored_text = '바뀐 원문'; },
    copy => { copy.semantic_review_candidates[0].offline_text = '바뀐 독립 전사'; },
    copy => { copy.semantic_review_candidates[0].start_ms = 1000; },
    copy => { copy.candidates[0].confirmed = true; }
  ]) await assert.rejects(validateContextReviewLayer(altered(change), source, independent));
});

test('local UI blocks display until separate ASR file is selected, then only GETs source', async () => {
  const calls = [], node = tag => ({ tag, children: [], isConnected: true, append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = [...children]; }, setAttribute() {} });
  const target = node('div');
  const script = readFileSync(new URL('../web/site/app.js', import.meta.url), 'utf8').replace(/\r\n?/g, '\n').replace(/^import .*;\n/gm, '').replace(/\ninit\(\);\s*$/, '\nglobalThis.showReviewImport=showContextReviewImport;');
  const context = { document: { createElement: node, querySelector: () => node('div') }, window: {}, location: { hash: '' }, clearTimeout, setTimeout, validateContextReviewLayer,
    fetch: async (path, options) => { calls.push([path, options.method]); return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ source }) }; } };
  runInNewContext(script, context, { filename: 'app.js' });
  context.showReviewImport({ id: 'job-1' }, target);
  const section = target.children[0], input = section.children[1].children[0], independentInput = section.children[2].children[0];
  input.files = [{ size: 2000, text: async () => JSON.stringify(await layer()) }];
  await input.onchange();
  assert.deepEqual(calls, []);
  assert.equal(section.children[4].children.length, 0);
  independentInput.files = [{ size: 2000, text: async () => JSON.stringify(independent) }];
  await independentInput.onchange();
  assert.deepEqual(calls, [['/api/jobs/job-1/source', 'GET']]);
  assert.match(section.children[3].textContent, /원음 정확성은 검증되지/);
  assert.match(section.children[4].children[0].children[0].textContent, /미확정/);
});
