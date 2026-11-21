// Transcript uncertainty markers (docs/v1/TRANSCRIPT_UNCERTAINTY.md, plan A). No model calls.
// Thresholds follow OpenAI Whisper's own fallback rules.
export const THRESHOLDS = Object.freeze({compressionRatio: 2.4, avgLogprob: -1.0, noSpeechProb: 0.6,
  silentLogprob: -0.5, gapSec: 30, repeatRun: 3});

export function whisperFlags(segment) {
  const flags = [];
  if (Number(segment.compression_ratio) > THRESHOLDS.compressionRatio) flags.push('REPETITIVE');
  if (Number(segment.avg_logprob) < THRESHOLDS.avgLogprob) flags.push('LOW_CONFIDENCE');
  const silent = Number(segment.no_speech_prob) > THRESHOLDS.noSpeechProb;
  if (silent && Number(segment.avg_logprob) < THRESHOLDS.silentLogprob) {
    flags.push('LIKELY_NO_SPEECH');
  }
  return flags;
}

// The same sentence three or more times in a row is a known Whisper hallucination pattern.
export function markRepeats(segments) {
  const norm = text => String(text).replace(/\s+/g, ' ').trim();
  const out = segments.map(s => ({...s, flags: [...(s.flags ?? [])]}));
  for (let i = 0; i < out.length;) {
    let j = i + 1;
    while (j < out.length && norm(out[j].text) === norm(out[i].text)) j += 1;
    if (j - i >= THRESHOLDS.repeatRun) for (let k = i; k < j; k += 1) out[k].flags.push('REPEAT');
    i = j;
  }
  return out;
}

export function markUnclear(segments) {
  return segments.map(s => (/\[(불명확|inaudible|unclear)\]/i.test(s.text)
    ? {...s, flags: [...(s.flags ?? []), 'UNCLEAR_MARK']} : s));
}

export function findGaps(segments, gapSec = THRESHOLDS.gapSec) {
  const timed = segments.filter(s => Number.isFinite(s.startMs));
  const gaps = [];
  for (let i = 1; i < timed.length; i += 1) {
    const prevEnd = timed[i - 1].endMs ?? timed[i - 1].startMs;
    if (timed[i].startMs - prevEnd >= gapSec * 1000) gaps.push({fromMs: prevEnd, toMs: timed[i].startMs});
  }
  return gaps;
}

export function uncertaintyReport(transcript) {
  const segments = transcript?.segments ?? [];
  const flagged = segments.filter(s => s.flags?.length);
  const byFlag = {};
  for (const s of flagged) for (const f of s.flags) byFlag[f] = (byFlag[f] ?? 0) + 1;
  return {
    segments: segments.length,
    uncertainSegments: flagged.length,
    uncertainIds: flagged.map(s => s.id).slice(0, 500),
    byFlag,
    gaps: findGaps(segments),
  };
}
