// Result data for GET /jobs/:id and the exports, kept within the Workers Free CPU limit (10ms):
// - the transcript and summary go out as the JSON text stored in D1 (no parse + re-serialize of 100KB+);
// - numeric verification and the review segments come from precomputed checks (src/v1/checks.mjs).
// Summaries saved before checks existed get them computed once on first read.
import {checksCurrent, computeChecks, currentVerification, reviewFromChecks} from './checks.mjs';
import {AppError} from './errors.mjs';

export async function refreshChecks(jobs, jobId) {
  const [summary, transcript] = await Promise.all([jobs.loadSummary(jobId), jobs.loadTranscript(jobId)]);
  if (!summary || !transcript) return null;
  const checks = computeChecks(summary, transcript);
  await jobs.saveChecks(jobId, checks);
  return checks;
}

async function load(jobs, id) {
  const stored = await jobs.loadDetail(id);
  if (!stored) throw new AppError('NOT_FOUND');
  const {job, transcriptRow, summaryText, corrections} = stored;
  const summary = summaryText ? JSON.parse(summaryText) : null;
  let checks = null;
  if (summary && transcriptRow) checks = checksCurrent(stored.checks) ? stored.checks : await refreshChecks(jobs, id);
  const verification = checks ? currentVerification(checks.verification, summary) : null;
  const review = checks ? await reviewFromChecks({checks, verification, summary, corrections,
    loadTranscript: () => jobs.loadTranscript(id)}) : [];
  return {job, transcriptRow, summaryText, summary, checks, verification, corrections, review};
}

const transcriptText = row => (row ? `{"source":${JSON.stringify(row.source)},`
  + `"language":${JSON.stringify(row.language ?? null)},"durationSec":${JSON.stringify(row.duration_sec ?? null)},`
  + `"coverage":${row.coverage_json || '{}'},"segments":${row.segments_json || '[]'},`
  + `"legacyJobId":${JSON.stringify(row.legacy_job_id ?? null)}}` : 'null');

// JSON text with the same shape as {job, transcript, summary, verification, corrections, review}.
export async function jobDetailText(jobs, id) {
  const d = await load(jobs, id);
  return `{"job":${JSON.stringify(d.job)},"transcript":${transcriptText(d.transcriptRow)},`
    + `"summary":${d.summaryText ?? 'null'},"verification":${JSON.stringify(d.verification)},`
    + `"corrections":${JSON.stringify(d.corrections)},"review":${JSON.stringify(d.review)}}`;
}

// Parsed detail for the exports. Neither parses the whole transcript: the JSON export cites only the
// segments kept in the checks, with the transcript counts stored alongside.
export async function exportDetail(jobs, id) {
  const d = await load(jobs, id);
  if (!d.summary) throw new AppError('NOT_FOUND', 'summary not ready');
  const row = d.transcriptRow;
  const transcript = row ? {source: row.source, language: row.language, durationSec: row.duration_sec,
    coverage: JSON.parse(row.coverage_json || '{}'), segments: d.checks?.segments ?? [], counts: d.checks?.counts,
    legacyJobId: row.legacy_job_id} : null;
  return {job: d.job, transcript, summary: d.summary, verification: d.verification, corrections: d.corrections,
    review: d.review};
}
