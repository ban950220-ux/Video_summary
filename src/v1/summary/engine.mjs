// Summary engine: transcript -> {conclusion, keyPoints, chapters} with evidence segment IDs and facts.
// Short transcripts: one call. Long ones: summarize each chunk (map), then combine (reduce).
// Each call: retry policy per model, then the next model (e.g. Gemini -> Groq) if one is given.
import {AppError} from '../errors.mjs';
import {withRetry} from '../retry.mjs';
import {CHUNK_CHARS, CHUNK_SEC, chunkTranscript, SINGLE_CALL_CHARS, totalChars} from './chunks.mjs';
import {mapPrompt, reducePrompt, singlePrompt, SYSTEM_RULES} from './prompts.mjs';
import {FINAL_SCHEMA, MAP_SCHEMA, numberWarnings, validateFinal, validateMapOutput} from './schema.mjs';

export const SUMMARY_VERSION = 'v1-summary-1';

async function callModels({label, models, prompt, schema, validate, usage, sleep, log}) {
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

export async function summarizeTranscript({transcript, title = null, models, usage, sleep,
  chunkSec = CHUNK_SEC, chunkChars = CHUNK_CHARS, singleCallChars = SINGLE_CALL_CHARS}) {
  if (!Array.isArray(models) || models.length === 0) throw new AppError('PROVIDER_KEY_MISSING', 'no summary model');
  const segmentIds = transcript.segments.map(s => s.id);
  const log = [];
  const common = {models, usage, sleep, log};
  const finalValidate = data => validateFinal(data, {segmentIds});
  let mode;
  let final;
  let chunkCount = 1;

  if (totalChars(transcript) <= singleCallChars) {
    mode = 'single';
    final = await callModels({...common, label: 'single', schema: FINAL_SCHEMA, validate: finalValidate,
      prompt: singlePrompt({title, segments: transcript.segments})});
  } else {
    mode = 'map-reduce';
    const chunks = chunkTranscript(transcript, {chunkSec, chunkChars});
    chunkCount = chunks.length;
    const partials = [];
    for (const chunk of chunks) {
      const output = await callModels({...common, label: `map#${chunk.index + 1}`, schema: MAP_SCHEMA,
        validate: data => validateMapOutput(data, chunk),
        prompt: mapPrompt({title, chunk, total: chunks.length})});
      partials.push({fromId: chunk.fromId, toId: chunk.toId, output});
    }
    final = await callModels({...common, label: 'reduce', schema: FINAL_SCHEMA, validate: finalValidate,
      prompt: reducePrompt({title, partials, firstId: segmentIds[0], lastId: segmentIds.at(-1)})});
  }

  const summary = {...final, chapters: placeChapters(final.chapters, transcript)};
  return {
    version: SUMMARY_VERSION,
    language: 'ko',
    ...summary,
    warnings: numberWarnings(summary),
    generation: {mode, chunkCount, calls: log},
  };
}
