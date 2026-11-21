// Common transcript model shared by every acquisition path.
//   {source, language, segments: [{id, startMs, endMs, text}], timed, durationSec, coverage}
// segments are sorted, trimmed and renumbered from 1. Untimed text has startMs/endMs = null.
import {AppError} from './errors.mjs';

export const SOURCES = Object.freeze({
  LEGACY_D1: 'legacy-d1',
  SUPADATA_NATIVE: 'supadata-native',
  GEMINI_VIDEO: 'gemini-video',
  PC_WHISPER: 'pc-whisper',
  UPLOAD: 'upload',
});
const SOURCE_VALUES = new Set(Object.values(SOURCES));
export const MAX_SEGMENTS = 20_000;
export const MAX_TEXT_CHARS = 1_500_000;
const MAX_DURATION_SEC = 6 * 60 * 60;

function finiteMs(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

export function makeTranscript({source, language = null, segments, durationSec = null, partial = false}) {
  if (!SOURCE_VALUES.has(source)) throw new AppError('INTERNAL', `unknown source ${source}`);
  if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS) throw new AppError('INVALID_TRANSCRIPT');
  const cleaned = [];
  let chars = 0;
  for (const segment of segments) {
    const text = String(segment?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const startMs = finiteMs(segment.startMs);
    const endMs = finiteMs(segment.endMs);
    if (startMs !== null && endMs !== null && endMs < startMs) throw new AppError('INVALID_TRANSCRIPT', 'end < start');
    chars += text.length;
    cleaned.push({startMs, endMs, text});
  }
  if (!cleaned.length) throw new AppError('INVALID_TRANSCRIPT', 'empty transcript');
  if (chars > MAX_TEXT_CHARS) throw new AppError('PAYLOAD_TOO_LARGE');
  const timed = cleaned.every(s => s.startMs !== null);
  if (timed) cleaned.sort((a, b) => a.startMs - b.startMs || (a.endMs ?? a.startMs) - (b.endMs ?? b.startMs));
  const result = cleaned.map((s, index) => ({id: index + 1, ...s}));
  const duration = Number.isFinite(durationSec) && durationSec > 0 && durationSec <= MAX_DURATION_SEC
    ? durationSec : null;
  return {
    source,
    language: typeof language === 'string' && language.length <= 16 ? language : null,
    timed,
    durationSec: duration,
    segments: result,
    coverage: coverageOf(result, duration, partial),
  };
}

// "complete" is a timeline estimate (start and end of the video are covered), not proof that
// every spoken word was transcribed. The UI must label it as such.
export function coverageOf(segments, durationSec, partial = false) {
  const timed = segments.filter(s => s.startMs !== null);
  if (!timed.length) return {firstSec: null, lastSec: null, ratio: null, complete: false, partial};
  const firstSec = timed[0].startMs / 1000;
  const lastSec = Math.max(...timed.map(s => (s.endMs ?? s.startMs))) / 1000;
  if (!durationSec) return {firstSec, lastSec, ratio: null, complete: false, partial};
  const ratio = Math.min(1, lastSec / durationSec);
  const slack = Math.min(60, durationSec * 0.05);
  const complete = !partial && firstSec <= slack && lastSec >= durationSec - slack;
  return {firstSec, lastSec, ratio: Number(ratio.toFixed(4)), complete, partial};
}

export function formatClock(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Plain text with segment IDs and clock times, used as model input in later stages.
export function transcriptAsPromptText(transcript, {fromId = 1, toId = Infinity} = {}) {
  return transcript.segments
    .filter(s => s.id >= fromId && s.id <= toId)
    .map(s => `[#${s.id} ${formatClock(s.startMs)}] ${s.text}`)
    .join('\n');
}
