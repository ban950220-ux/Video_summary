// Cross-check of numbers against a second listen (docs/v1/TRANSCRIPT_UNCERTAINTY.md, plan B).
// The summary-vs-transcript check cannot see errors in the transcript itself (auto captions said
// "103개사" where the speaker said "1053개사"). Here the evidence windows are transcribed again from
// the video by another pass and the numbers are compared.
import {extractNumbers, sameAtPrecision} from './numbers.mjs';

export const CROSS_VERSION = 'v1-crosscheck-1';
export const LIMITS = Object.freeze({padSec: 15, mergeGapSec: 10, maxWindows: 15, maxTotalSec: 900, maxWindowSec: 240});

// Evidence windows for facts with timed segments; mismatches first so they survive the caps.
export function planWindows(verification, transcript, limits = LIMITS) {
  const byId = new Map(transcript.segments.map(s => [s.id, s]));
  const order = {MISMATCH: 0, VERIFIED: 1, UNVERIFIABLE: 2};
  const spans = [];
  const facts = [...verification.items].sort((a, b) => order[a.status] - order[b.status]);
  for (const fact of facts) {
    const segs = (fact.segmentIds ?? []).map(id => byId.get(id)).filter(s => s && Number.isFinite(s.startMs));
    if (!segs.length) continue;
    const start = Math.max(0, Math.floor(Math.min(...segs.map(s => s.startMs)) / 1000) - limits.padSec);
    const end = Math.ceil(Math.max(...segs.map(s => s.endMs ?? s.startMs)) / 1000) + limits.padSec;
    spans.push({startSec: start, endSec: Math.min(end, start + limits.maxWindowSec)});
  }
  const windows = [];
  let total = 0;
  for (const span of spans) {
    const hit = windows.find(w => span.startSec <= w.endSec + limits.mergeGapSec && span.endSec >= w.startSec
      - limits.mergeGapSec);
    if (hit) {
      const merged = {startSec: Math.min(hit.startSec, span.startSec), endSec: Math.max(hit.endSec, span.endSec)};
      const growth = (merged.endSec - merged.startSec) - (hit.endSec - hit.startSec);
      if (merged.endSec - merged.startSec <= limits.maxWindowSec && total + growth <= limits.maxTotalSec) {
        Object.assign(hit, merged);
        total += growth;
      }
      continue;
    }
    const length = span.endSec - span.startSec;
    if (windows.length >= limits.maxWindows || total + length > limits.maxTotalSec) continue;
    windows.push({...span});
    total += length;
  }
  return windows.sort((a, b) => a.startSec - b.startSec);
}

// clips: [{startSec, endSec, segments: [{startMs, endMs, text}]}] from the second listen.
export function compareFacts(verification, transcript, clips, limits = LIMITS) {
  const byId = new Map(transcript.segments.map(s => [s.id, s]));
  const items = [];
  const seen = new Set();
  for (const fact of verification.items) {
    const segs = (fact.segmentIds ?? []).map(id => byId.get(id)).filter(s => s && Number.isFinite(s.startMs));
    if (!segs.length || !Number.isFinite(fact.value)) continue;
    const key = `${fact.value}|${fact.unit}|${fact.segmentIds.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = Math.min(...segs.map(s => s.startMs)) - limits.padSec * 1000;
    const to = Math.max(...segs.map(s => s.endMs ?? s.startMs)) + limits.padSec * 1000;
    // Timestamps inside a re-listened clip are approximate, so the whole clip that covers the evidence
    // is compared (clips are short), not only the segments at the exact time.
    const heard = clips.filter(c => c.endSec * 1000 >= from && c.startSec * 1000 <= to).flatMap(c => c.segments);
    const base = {surface: fact.surface, value: fact.value, unit: fact.unit, segmentIds: fact.segmentIds};
    if (!heard.length) {
      items.push({...base, result: 'NOT_CHECKED'});
      continue;
    }
    const numbers = extractNumbers(heard.map(s => s.text).join(' '));
    const written = extractNumbers(fact.surface ?? '').map(n => n.value);
    const heardHas = value => numbers.some(n => sameAtPrecision(n.value, value));
    // The fact value may be derived ("10곳 중 4곳" stored as 40%); the numbers as written also count.
    if (heardHas(fact.value) || (written.length > 0 && written.every(heardHas))) {
      items.push({...base, result: 'CONFIRMED'});
      continue;
    }
    const sameUnit = numbers.filter(n => n.unit === fact.unit);
    const heardValues = [...new Set((sameUnit.length ? sameUnit : numbers).map(n => n.raw))].slice(0, 5);
    const nearest = heard.filter(s => s.endMs >= from && s.startMs <= to);
    const heardText = (nearest.length ? nearest : heard).map(s => s.text).join(' ').slice(0, 300);
    items.push({...base, result: 'DIFFERS', heardValues, heardText});
  }
  const count = result => items.filter(i => i.result === result).length;
  return {items, counts: {total: items.length, confirmed: count('CONFIRMED'), differs: count('DIFFERS'),
    notChecked: count('NOT_CHECKED')}};
}
