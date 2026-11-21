// Summary engine: transcript -> {conclusion, keyPoints, chapters} with evidence segment IDs and facts.
// Short transcripts: one call. Long ones: summarize each chunk (map), then combine (reduce).
// Each call: retry policy per model, then the next model (e.g. Gemini -> Groq) if one is given.
import {AppError} from '../errors.mjs';
import {withRetry} from '../retry.mjs';
import {CHUNK_CHARS, CHUNK_SEC, chunkTranscript, SINGLE_CALL_CHARS, totalChars} from './chunks.mjs';
import {mapPrompt, reducePrompt, singlePrompt, SYSTEM_RULES} from './prompts.mjs';
import {FINAL_SCHEMA, MAP_SCHEMA, numberWarnings, validateFinal, validateMapOutput} from './schema.mjs';

export const SUMMARY_VERSION = 'v1-summary-1';

export async function callModels({label, models, prompt, schema, validate, usage, sleep, log}) {
  let lastError = null;
  for (const model of models) {
    const tries = [];
    try {
      const result = await withRetry(`${label}@${model.provider}`, async () => {
        await usage?.consume({[model.usageKey]: 1});
        const {data, usage: tokens} = await model.generateJson({system: SYSTEM_RULES, prompt, schema});
        return {value: validate(data), tokens};
      }, {sleep, attempts: tries});
      log.push({label, provider: model.provider, model: model.model, outcome: 'ok', tries, ...result.tokens});
      return result.value;
    } catch (error) {
      log.push({label, provider: model.provider, model: model.model, outcome: 'error',
        code: error instanceof AppError ? error.code : 'INTERNAL', tries});
      lastError = error;
    }
  }
  throw lastError ?? new AppError('PROVIDER_KEY_MISSING', 'no summary model');
}

// Chapter times come from the transcript, never from model output.
function placeChapters(chapters, transcript) {
  const byId = new Map(transcript.segments.map(s => [s.id, s]));
  const last = transcript.segments.at(-1);
  const videoEnd = last.endMs ?? last.startMs;
  return chapters.map((chapter, i) => {
    const next = chapters[i + 1];
    return {
      ...chapter,
      startMs: byId.get(chapter.startSegmentId).startMs,
      endMs: next ? byId.get(next.startSegmentId).startMs : videoEnd,
    };
  });
}

export function summaryPlan(transcript, {chunkSec = CHUNK_SEC, chunkChars = CHUNK_CHARS,
  singleCallChars = SINGLE_CALL_CHARS} = {}) {
  if (totalChars(transcript) <= singleCallChars) return {mode: 'single', chunks: []};
  const chunks = chunkTranscript(transcript, {chunkSec, chunkChars});
  return {mode: 'map-reduce', chunks: chunks.map(({index, fromId, toId}) => ({index, fromId, toId}))};
}

function requireModels(models) {
  if (!Array.isArray(models) || models.length === 0) throw new AppError('PROVIDER_KEY_MISSING', 'no summary model');
}

function finalValidator(transcript) {
  const segmentIds = transcript.segments.map(s => s.id);
  return data => validateFinal(data, {segmentIds});
}

// One step each: summarizeSingle, summarizeChunk (map), combinePartials (reduce).
export function summarizeSingle({transcript, title = null, models, usage, sleep, log = []}) {
  requireModels(models);
  return callModels({models, usage, sleep, log, label: 'single', schema: FINAL_SCHEMA,
    validate: finalValidator(transcript), prompt: singlePrompt({title, segments: transcript.segments})});
}

export async function summarizeChunk({transcript, chunk, total, title = null, models, usage, sleep, log = []}) {
  requireModels(models);
  const segments = transcript.segments.filter(s => s.id >= chunk.fromId && s.id <= chunk.toId);
  const full = {...chunk, segments, startMs: segments[0].startMs,
    endMs: segments.at(-1).endMs ?? segments.at(-1).startMs};
  const output = await callModels({models, usage, sleep, log, label: `map#${chunk.index + 1}`, schema: MAP_SCHEMA,
    validate: data => validateMapOutput(data, chunk), prompt: mapPrompt({title, chunk: full, total})});
  return {fromId: chunk.fromId, toId: chunk.toId, output};
}

export function combinePartials({transcript, partials, title = null, models, usage, sleep, log = []}) {
  requireModels(models);
  const ids = transcript.segments.map(s => s.id);
  const prompt = reducePrompt({title, partials, firstId: ids[0], lastId: ids.at(-1)});
  return callModels({models, usage, sleep, log, label: 'reduce', schema: FINAL_SCHEMA,
    validate: finalValidator(transcript), prompt});
}

export function finalizeSummary({final, transcript, plan, calls}) {
  const summary = {...final, chapters: placeChapters(final.chapters, transcript)};
  return {
    version: SUMMARY_VERSION,
    language: 'ko',
    ...summary,
    warnings: numberWarnings(summary),
    generation: {mode: plan.mode, chunkCount: plan.mode === 'single' ? 1 : plan.chunks.length, calls},
  };
}

// Convenience: the whole engine in one call (used by tests and small inline jobs).
export async function summarizeTranscript({transcript, title = null, models, usage, sleep, ...planOptions}) {
  requireModels(models);
  const plan = summaryPlan(transcript, planOptions);
  const log = [];
  const common = {transcript, title, models, usage, sleep, log};
  let final;
  if (plan.mode === 'single') {
    final = await summarizeSingle(common);
  } else {
    const partials = [];
    for (const chunk of plan.chunks) partials.push(await summarizeChunk({...common, chunk, total: plan.chunks.length}));
    final = await combinePartials({...common, partials});
  }
  return finalizeSummary({final, transcript, plan, calls: log});
}
