// Stage 8-B: detailed analysis (claims, causes, context, uncertainty) with evidence, on request.
// Same shape as the summary engine: one call for short transcripts, chunk analysis + combine for long.
import {callModels, summaryPlan} from './engine.mjs';
import {formatClock} from '../transcript.mjs';
import {ANALYSIS_SCHEMA, validateAnalysis} from './schema.mjs';
import {segmentLines} from './prompts.mjs';

export const ANALYSIS_VERSION = 'v1-analysis-1';

const GUIDE = [
  '영상의 내용을 아래 네 종류로 분석하라. 각 항목은 한두 문장이다.',
  '- CLAIM: 화자의 주장. 근거·이유, 조건·예외, 영상 안의 반론이 있으면 함께 쓴다.',
  '- CAUSE: 원인 → 결과 관계. 화자가 말한 인과면 SPEAKER, 네가 추론한 인과면 INTERPRETATION.',
  '- CONTEXT: 숫자나 주장을 이해하는 데 필요한 전제·비교 기준·기간·분모.',
  '- UNCERTAINTY: 예측·가정·완곡 표현. 사실처럼 쓰지 말고 예측·가정임을 밝힌다.',
  '외부 지식으로 사실 여부를 판단하지 않는다. 영상에 없는 내용은 쓰지 않는다.',
  'attribution 규칙(엄격히 적용):',
  '- SPEAKER: 화자가 한 구간에서 직접 말한 내용을 옮긴 경우만.',
  '- INTERPRETATION: 화자가 직접 말하지 않은 것. 떨어진 여러 구간을 네가 연결한 인과, 일반화, 평가, 함의,',
  '  "~로 보인다/~을 시사한다" 같은 정리는 모두 INTERPRETATION이다. 확신이 없으면 INTERPRETATION으로 한다.',
  '- 화자가 "A 때문에 B"라고 직접 말했으면 CAUSE·SPEAKER, 네가 A와 B를 이어 붙였으면 CAUSE·INTERPRETATION.',
].join('\n');

function chunkSegments(transcript, chunk) {
  return transcript.segments.filter(s => s.id >= chunk.fromId && s.id <= chunk.toId);
}

export function analyzeSingle({transcript, title, models, usage, sleep, log = []}) {
  const ids = new Set(transcript.segments.map(s => s.id));
  const prompt = [title ? `영상 제목: ${title}` : '', GUIDE, '항목은 6~16개.', '', '전사문:',
    segmentLines(transcript.segments)].join('\n');
  return callModels({models, usage, sleep, log, label: 'analysis', schema: ANALYSIS_SCHEMA, prompt,
    validate: data => validateAnalysis(data, ids, {min: 1, max: 24})});
}

export async function analyzeChunk({transcript, chunk, total, title, models, usage, sleep, log = []}) {
  const segments = chunkSegments(transcript, chunk);
  const prompt = [title ? `영상 제목: ${title}` : '',
    `이 부분: 전체 ${total}개 중 ${chunk.index + 1}번째, 구간 #${chunk.fromId}~#${chunk.toId} `
      + `(${formatClock(segments[0].startMs)}~)`,
    GUIDE, `항목은 2~8개. 구간 번호는 #${chunk.fromId}~#${chunk.toId}만 쓴다.`, '', '전사문:',
    segmentLines(segments)].join('\n');
  const result = await callModels({models, usage, sleep, log, label: `analysis-map#${chunk.index + 1}`,
    schema: ANALYSIS_SCHEMA, prompt,
    validate: data => validateAnalysis(data, id => id >= chunk.fromId && id <= chunk.toId, {min: 1, max: 12})});
  return {fromId: chunk.fromId, toId: chunk.toId, output: result};
}

export function combineAnalysis({transcript, partials, title, models, usage, sleep, log = []}) {
  const ids = new Set(transcript.segments.map(s => s.id));
  const prompt = [title ? `영상 제목: ${title}` : '', GUIDE,
    '아래는 영상을 순서대로 나눠 분석한 결과다. 중복을 합치고 중요한 것만 골라 영상 전체 분석 8~20개로 정리하라.',
    '각 항목의 segmentIds·facts는 부분 분석의 것을 그대로 쓴다. 새 숫자를 만들지 않는다.',
    'attribution은 부분 분석의 값을 유지하되, 여러 항목을 합쳐 새 문장을 만들었으면 INTERPRETATION으로 바꾼다.', '',
    ...partials.map((p, i) => `## 부분 ${i + 1} (#${p.fromId}~#${p.toId})\n${JSON.stringify(p.output)}`)].join('\n');
  return callModels({models, usage, sleep, log, label: 'analysis-reduce', schema: ANALYSIS_SCHEMA, prompt,
    validate: data => validateAnalysis(data, ids, {min: 1, max: 24})});
}

export function analysisPlan(transcript) {
  return summaryPlan(transcript);
}

// A "speaker" item whose evidence is spread over distant parts of the video is a synthesis, not one
// direct statement. It keeps its attribution but is marked so the reader can see it.
export const SYNTHESIS_SPAN_MS = 5 * 60_000;

export function markSynthesis(items, transcript) {
  const byId = new Map((transcript?.segments ?? []).map(s => [s.id, s]));
  return items.map(item => {
    const times = item.segmentIds.map(id => byId.get(id)?.startMs).filter(Number.isFinite);
    const spread = times.length > 1 && Math.max(...times) - Math.min(...times) > SYNTHESIS_SPAN_MS;
    return spread && item.attribution === 'SPEAKER' ? {...item, synthesized: true} : item;
  });
}

export function finalizeAnalysis({result, plan, calls, transcript = null}) {
  return {version: ANALYSIS_VERSION, status: 'DONE', items: markSynthesis(result.items, transcript),
    generation: {mode: plan.mode, chunkCount: plan.mode === 'single' ? 1 : plan.chunks.length, calls},
    finishedAt: new Date().toISOString()};
}
