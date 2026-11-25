// Checks derived from a saved summary: numeric verification plus the few transcript segments the review
// list needs. Computed once after the summary (or analysis) is saved, so opening a result does not redo
// the verification or parse the whole transcript (Workers Free: 10ms CPU per request).
import {reviewList} from './corrections.mjs';
import {VERIFY_VERSION, verifySummary} from './verify/facts.mjs';

export const CHECKS_VERSION = `v1-checks-2/${VERIFY_VERSION}`;

export function computeChecks(summary, transcript) {
  const verification = verifySummary(summary, transcript);
  const ids = new Set();
  for (const segment of transcript.segments) if (segment.flags?.some(f => f !== 'CORRECTED')) ids.add(segment.id);
  // Cross-check windows are planned from these same verification items, so their segments are covered.
  for (const item of verification.items) for (const id of item.segmentIds ?? []) ids.add(id);
  // Evidence sentences of the JSON export (conclusion, key points, analysis items).
  for (const item of [summary.conclusion, ...summary.keyPoints, ...(summary.analysis?.items ?? [])]) {
    for (const id of item?.segmentIds ?? []) ids.add(id);
  }
  const segments = transcript.segments.filter(s => ids.has(s.id))
    .map(({id, startMs, text, flags}) => ({id, startMs, text, ...(flags ? {flags} : {})}));
  const uncertain = transcript.segments.filter(s => s.flags?.some(f => f !== 'CORRECTED')).length;
  return {version: CHECKS_VERSION, verification, segments,
    counts: {segments: transcript.segments.length, uncertain}};
}

export const checksCurrent = checks => checks?.version === CHECKS_VERSION;

// Analysis items can disappear after the checks were computed (analysis restarted or failed).
export function currentVerification(verification, summary) {
  const analysisCount = summary?.analysis?.items?.length ?? 0;
  const items = verification.items.filter(item => {
    const m = /^analysis\[(\d+)\]$/.exec(item.path ?? '');
    return !m || Number(m[1]) < analysisCount;
  });
  if (items.length === verification.items.length) return verification;
  const count = status => items.filter(i => i.status === status).length;
  const counts = {total: items.length, verified: count('VERIFIED'), mismatch: count('MISMATCH'),
    unverifiable: count('UNVERIFIABLE')};
  const judgedRatio = items.length ? Number(((counts.verified + counts.mismatch) / items.length).toFixed(3)) : null;
  return {...verification, counts, judgedRatio, items};
}

// The review list from stored checks. Corrected segments outside the stored set need the full transcript,
// which loadTranscript supplies only in that (rare) case.
export async function reviewFromChecks({checks, verification, summary, corrections, loadTranscript}) {
  let segments = checks.segments;
  const known = new Set(segments.map(s => s.id));
  if (Object.keys(corrections).some(id => !known.has(Number(id)))) segments = (await loadTranscript()).segments;
  return reviewList({segments}, verification, summary?.crossCheck, corrections);
}
