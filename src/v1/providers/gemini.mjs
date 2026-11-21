// Gemini: transcribe a public YouTube video directly from its URL, one clip at a time.
// Free tier only: the model must be a Flash-family ID and the key must belong to a Google
// project without billing (owner-confirmed 2026-11-21).
import {AppError} from '../errors.mjs';
import {makeTranscript, SOURCES} from '../transcript.mjs';
import {withRetry} from '../retry.mjs';
import {markUnclear} from '../uncertainty.mjs';
import {failedResponse, providerFetch, readProviderJson} from './http.mjs';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Google closed gemini-2.5-flash to new users (error seen 2026-11-21) and points to gemini-3.8-flash instead
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const FREE_MODEL = /^gemini-\d+(?:\.\d+)?-flash(?:-lite)?(?:-\d{3})?$/;
export const DEFAULT_CLIP_SEC = 15 * 60;
export const MAX_VIDEO_SEC = 2 * 60 * 60;
const EDGE_SLACK_SEC = 5;

export function assertFreeModel(model) {
  if (typeof model !== 'string' || !FREE_MODEL.test(model)) throw new AppError('PAID_API_BLOCKED', `model ${model}`);
  return model;
}

const TRANSCRIPT_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    language: {type: 'STRING'},
    endOfVideo: {type: 'BOOLEAN'},
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {start: {type: 'NUMBER'}, end: {type: 'NUMBER'}, text: {type: 'STRING'}},
        required: ['start', 'end', 'text'],
      },
    },
  },
  required: ['endOfVideo', 'segments'],
});

function transcriptPrompt(startSec, endSec) {
  return [
    `이 영상의 ${startSec}초부터 ${endSec}초까지 구간의 말소리를 원래 언어 그대로 빠짐없이 전사하세요.`,
    '요약하거나 번역하거나 고쳐 쓰지 마세요. 알아들을 수 없는 부분은 [불명확]으로 적으세요.',
    'start와 end는 영상 맨 처음을 0초로 하는 절대 시각(초)입니다. 한 항목은 한두 문장으로 나누세요.',
    '이 구간 안에서 영상이 끝나면 endOfVideo를 true로, 그렇지 않으면 false로 하세요.',
    'language에는 주된 언어 코드(예: ko, en)를 넣으세요.',
  ].join('\n');
}

export function geminiClipRequest({canonicalUrl, startSec, endSec}) {
  return {
    contents: [{
      role: 'user',
      parts: [
        {fileData: {fileUri: canonicalUrl}, videoMetadata: {startOffset: `${startSec}s`, endOffset: `${endSec}s`}},
        {text: transcriptPrompt(startSec, endSec)},
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: TRANSCRIPT_SCHEMA,
      mediaResolution: 'MEDIA_RESOLUTION_LOW',
      maxOutputTokens: 32_768,
    },
  };
}

// Places clip segments on the absolute timeline. Models sometimes answer with times relative
// to the clip start; that is detected and shifted. Anything else is invalid output.
export function placeSegments(raw, startSec, endSec) {
  const items = raw.map(item => ({start: Number(item?.start), end: Number(item?.end), text: String(item?.text ?? '')}));
  if (items.some(s => !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end < s.start || s.start < 0)) {
    throw new AppError('PROVIDER_INVALID_OUTPUT', 'gemini segment time invalid');
  }
  const inside = (lo, hi) => items.every(s => s.start >= lo - EDGE_SLACK_SEC && s.end <= hi + EDGE_SLACK_SEC);
  let offset = 0;
  if (!inside(startSec, endSec)) {
    if (startSec > 0 && inside(0, endSec - startSec)) offset = startSec;
    else throw new AppError('PROVIDER_INVALID_OUTPUT', 'gemini segment outside clip');
  }
  return items.map(s => ({startMs: (s.start + offset) * 1000, endMs: (s.end + offset) * 1000, text: s.text}));
}

export async function transcribeClip({canonicalUrl, startSec, endSec, apiKey, model = DEFAULT_GEMINI_MODEL,
  fetchFn = fetch}) {
  if (!apiKey) throw new AppError('PROVIDER_KEY_MISSING', 'gemini');
  assertFreeModel(model);
  const url = `${GEMINI_BASE}/${model}:generateContent`;
  const init = {
    method: 'POST',
    headers: {'x-goog-api-key': apiKey, 'content-type': 'application/json'},
    body: JSON.stringify(geminiClipRequest({canonicalUrl, startSec, endSec})),
  };
  const response = await providerFetch(url, init, {fetchFn, name: 'gemini', timeoutMs: 300_000});
  if (!response.ok) throw await failedResponse(response, 'gemini');
  const body = await readProviderJson(response, 'gemini');
  const candidate = body?.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    if (candidate.finishReason === 'MAX_TOKENS') throw new AppError('PROVIDER_INVALID_OUTPUT', 'gemini MAX_TOKENS');
    throw new AppError('PROVIDER_FAILED', `gemini finish ${candidate.finishReason}`);
  }
  const text = candidate?.content?.parts?.map(part => part?.text ?? '').join('') ?? '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('PROVIDER_INVALID_OUTPUT', 'gemini output is not JSON');
  }
  if (!parsed || !Array.isArray(parsed.segments) || typeof parsed.endOfVideo !== 'boolean') {
    throw new AppError('PROVIDER_INVALID_OUTPUT', 'gemini output shape');
  }
  return {
    segments: placeSegments(parsed.segments, startSec, endSec),
    endOfVideo: parsed.endOfVideo,
    language: typeof parsed.language === 'string' ? parsed.language.slice(0, 16) : null,
    usage: {
      promptTokens: body?.usageMetadata?.promptTokenCount ?? null,
      outputTokens: body?.usageMetadata?.candidatesTokenCount ?? null,
      totalTokens: body?.usageMetadata?.totalTokenCount ?? null,
    },
  };
}

function dropBoundaryDuplicates(previous, next) {
  const last = previous.at(-1);
  if (!last) return next;
  return next.filter(s => !(s.startMs < last.endMs && s.text.trim() === last.text.trim()));
}

// Transcribes clip by clip until the model reports the end, the known duration is reached,
// or MAX_VIDEO_SEC. usage.consume() is called before every request (throws at the daily cap).
export async function transcribeVideo({canonicalUrl, apiKey, model = DEFAULT_GEMINI_MODEL, durationSec = null,
  clipSec = DEFAULT_CLIP_SEC, fetchFn = fetch, usage, sleep, attempts = []}) {
  assertFreeModel(model);
  const limit = Math.min(MAX_VIDEO_SEC, durationSec ?? MAX_VIDEO_SEC);
  const segments = [];
  const calls = [];
  let language = null;
  let modelEnded = false;
  for (let start = 0; start < limit && !modelEnded; start += clipSec) {
    const end = Math.min(start + clipSec, limit);
    const clip = await withRetry(`gemini ${start}-${end}s`, async () => {
      await usage?.consume({geminiCalls: 1, geminiVideoSeconds: end - start});
      return transcribeClip({canonicalUrl, startSec: start, endSec: end, apiKey, model, fetchFn});
    }, {sleep, attempts});
    calls.push({startSec: start, endSec: end, ...clip.usage});
    segments.push(...dropBoundaryDuplicates(segments, clip.segments));
    language ??= clip.language;
    modelEnded = clip.endOfVideo;
  }
  // Without a known duration, stopping at MAX_VIDEO_SEC means the rest of the video is missing.
  const reachedCap = !durationSec && !modelEnded;
  const lastEnd = segments.length ? Math.max(...segments.map(s => s.endMs)) / 1000 : null;
  const transcript = makeTranscript({
    source: SOURCES.GEMINI_VIDEO,
    language,
    segments: markUnclear(segments),
    durationSec: durationSec ?? (modelEnded && lastEnd ? lastEnd : null),
    partial: reachedCap,
  });
  return {transcript, calls, model};
}
