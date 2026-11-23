// Summary engine: transcript -> {conclusion, keyPoints, chapters} with evidence segment IDs and facts.
// Short transcripts: one call. Long ones: summarize each chunk (map), then combine (reduce).
// Each call: retry policy per model, then the next model (e.g. Gemini -> Groq) if one is given.
import {AppError} from '../errors.mjs';
import {withRetry} from '../retry.mjs';
import {CHUNK_CHARS, CHUNK_SEC, chunkTranscript, SINGLE_CALL_CHARS, totalChars} from './chunks.mjs';
import {mapPrompt, reducePrompt, singlePrompt, SYSTEM_RULES} from './prompts.mjs';
import {FINAL_SCHEMA, MAP_SCHEMA, numberWarnings, validateFinal, validateMapOutput} from './schema.mjs';

export const SUMMARY_VERSION = 'v1-summary-1';

const LONG_OUTPUT_TOKENS = 24_576; // final step with detailed chapters; worst case stays under the budget reserve
export const MAX_CHAPTERS = 40;

// prompt may be a function of the model, so a model with a small output limit gets the short form.
export async function callModels({label, models, prompt, schema, validate, usage, sleep, log, longOutput = false}) {
  let lastError = null;
  for (const model of models) {
    const tries = [];
    try {
      const result = await withRetry(`${label}@${model.provider}`, async () => {
        await usage?.consume({[model.usageKey]: 1});
        const {data, usage: tokens} = await model.generateJson({system: SYSTEM_RULES, schema,
          prompt: typeof prompt === 'function' ? prompt(model) : prompt,
          ...(longOutput && !model.brief ? {maxOutputTokens: LONG_OUTPUT_TOKENS} : {})});
        if (model.provider === 'gemini') await usage?.charge?.(tokens ?? {});
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
  return callModels({models, usage, sleep, log, label: 'single', schema: FINAL_SCHEMA, longOutput: true,
    validate: finalValidator(transcript),
    prompt: model => singlePrompt({title, segments: transcript.segments, brief: Boolean(model.brief)})});
}

export async function summarizeChunk({transcript, chunk, total, title = null, models, usage, sleep, log = []}) {
  requireModels(models);
  const segments = transcript.segments.filter(s => s.id >= chunk.fromId && s.id <= chunk.toId);
  const full = {...chunk, segments, startMs: segments[0].startMs,
    endMs: segments.at(-1).endMs ?? segments.at(-1).startMs};
  const output = await callModels({models, usage, sleep, log, label: `map#${chunk.index + 1}`, schema: MAP_SCHEMA,
    validate: data => validateMapOutput(data, chunk),
    prompt: model => mapPrompt({title, chunk: full, total, brief: Boolean(model.brief)})});
  return {fromId: chunk.fromId, toId: chunk.toId, output};
}

// The reduce step sometimes drops whole parts of the video (seen: nothing after 1:12 of a 1:38 talk).
// Any part without a final chapter gets its own map chapters back, so coverage never depends on the model.
export function coverChapters(final, partials) {
  const chapters = [...final.chapters];
  for (const part of partials) {
    if (chapters.some(c => c.startSegmentId >= part.fromId && c.startSegmentId <= part.toId)) continue;
    chapters.push(...part.output.chapters);
  }
  chapters.sort((a, b) => a.startSegmentId - b.startSegmentId);
  const unique = chapters.filter((c, i) => !i || c.startSegmentId !== chapters[i - 1].startSegmentId);
  return {...final, chapters: unique.slice(0, MAX_CHAPTERS)};
}

export async function combinePartials({transcript, partials, title = null, models, usage, sleep, log = []}) {
  requireModels(models);
  const ids = transcript.segments.map(s => s.id);
  const final = await callModels({models, usage, sleep, log, label: 'reduce', schema: FINAL_SCHEMA, longOutput: true,
    validate: finalValidator(transcript),
    prompt: model => reducePrompt({title, partials, firstId: ids[0], lastId: ids.at(-1),
      brief: Boolean(model.brief)})});
  return coverChapters(final, partials);
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
