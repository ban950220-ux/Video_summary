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

async function checksFor(jobs, id, summary) {
  if (!summary) return null;
  const checks = await jobs.loadChecks(id);
  return checksCurrent(checks) ? checks : refreshChecks(jobs, id);
}

async function load(jobs, id) {
  const job = await jobs.get(id);
  if (!job) throw new AppError('NOT_FOUND');
  const [transcriptRow, summaryText, corrections] = await Promise.all([jobs.loadTranscriptRaw(id),
    jobs.loadSummaryRaw(id), jobs.loadCorrections(id)]);
  const summary = summaryText ? JSON.parse(summaryText) : null;
  const checks = transcriptRow ? await checksFor(jobs, id, summary) : null;
  const verification = checks ? currentVerification(checks.verification, summary) : null;
  const review = checks ? await reviewFromChecks({checks, verification, summary, corrections,
    loadTranscript: () => jobs.loadTranscript(id)}) : [];
  return {job, transcriptRow, summaryText, summary, verification, corrections, review};
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

// Parsed detail for the exports. Only the JSON export needs the transcript segments.
export async function exportDetail(jobs, id, {segments = false} = {}) {
  const d = await load(jobs, id);
  if (!d.summary) throw new AppError('NOT_FOUND', 'summary not ready');
  const row = d.transcriptRow;
  const transcript = row ? {source: row.source, language: row.language, durationSec: row.duration_sec,
    coverage: JSON.parse(row.coverage_json || '{}'), segments: segments ? JSON.parse(row.segments_json || '[]') : [],
    legacyJobId: row.legacy_job_id} : null;
  return {job: d.job, transcript, summary: d.summary, verification: d.verification, corrections: d.corrections,
    review: d.review};
}
