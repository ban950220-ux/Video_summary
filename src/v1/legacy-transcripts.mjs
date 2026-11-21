// Read-only reuse of transcripts saved by v0.7 (tables jobs + yta_sources). Never writes.
// Legacy segments look like {id, startMs, endMs, text}.
import {makeTranscript, SOURCES} from './transcript.mjs';

const QUERY = `SELECT j.id AS job_id, j.title, j.duration_seconds, s.segments_json, s.provenance, s.updated_at
  FROM jobs j JOIN yta_sources s ON s.job_id = j.id
  WHERE j.video_id = ? AND j.owner_id = 'owner'
  ORDER BY s.updated_at DESC LIMIT 5`;

async function legacyTablesExist(db) {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('jobs','yta_sources')",
  ).first();
  return Number(row?.n) === 2;
}

function candidateFrom(row) {
  let segments;
  try {
    segments = JSON.parse(row.segments_json);
  } catch {
    return null;
  }
  if (!Array.isArray(segments)) return null;
  try {
    const duration = Number(row.duration_seconds);
    const transcript = makeTranscript({
      source: SOURCES.LEGACY_D1,
      segments,
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    });
    return {transcript, legacyJobId: row.job_id, legacyProvenance: row.provenance, title: row.title ?? null};
  } catch {
    return null;
  }
}

// Returns the best saved transcript for the video (complete coverage first, then newest), or null.
export async function findLegacyTranscript(db, videoId) {
  if (!db || !(await legacyTablesExist(db))) return null;
  const {results = []} = await db.prepare(QUERY).bind(videoId).all();
  const candidates = results.map(candidateFrom).filter(Boolean);
  return candidates.find(c => c.transcript.coverage.complete) ?? candidates[0] ?? null;
}

// Transcript saved by an earlier v1 job for the same video (any status), so a retry after a
// summary failure does not spend caption or Gemini quota again. Read-only.
export async function findSavedV1Transcript(db, videoId) {
  if (!db) return null;
  const exists = await db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('v1_jobs','v1_transcripts')",
  ).first();
  if (Number(exists?.n) !== 2) return null;
  const row = await db.prepare(`SELECT t.job_id, t.source, t.language, t.duration_sec, t.segments_json
    FROM v1_transcripts t JOIN v1_jobs j ON j.id = t.job_id
    WHERE j.video_id = ? AND t.source != 'upload' ORDER BY t.created_at DESC LIMIT 1`).bind(videoId).first();
  if (!row) return null;
  try {
    const transcript = makeTranscript({source: row.source, language: row.language,
      segments: JSON.parse(row.segments_json), durationSec: row.duration_sec ?? null});
    return {transcript, fromJobId: row.job_id};
  } catch {
    return null;
  }
}

// v0.7 jobs that have a saved transcript, so the owner can pick one that has no video ID
// (e.g. an MP3 upload) and summarize it with v1. Read-only; transcript text is not returned.
export async function listLegacySources(db, {limit = 50} = {}) {
  if (!db || !(await legacyTablesExist(db))) return [];
  const {results = []} = await db.prepare(`SELECT j.id, j.title, j.video_id, j.source_type, j.duration_seconds,
      j.created_at, length(s.segments_json) AS bytes
    FROM jobs j JOIN yta_sources s ON s.job_id = j.id WHERE j.owner_id = 'owner'
    ORDER BY j.created_at DESC LIMIT ?`).bind(Math.min(Math.max(Number(limit) || 50, 1), 100)).all();
  return results.map(r => ({legacyJobId: r.id, title: r.title ?? null, videoId: r.video_id ?? null,
    sourceType: r.source_type, durationSec: r.duration_seconds ?? null, createdAt: r.created_at,
    bytes: Number(r.bytes)}));
}

export async function loadLegacyTranscript(db, legacyJobId) {
  if (!db || !(await legacyTablesExist(db))) return null;
  const row = await db.prepare(`SELECT j.id AS job_id, j.title, j.duration_seconds, s.segments_json, s.provenance
    FROM jobs j JOIN yta_sources s ON s.job_id = j.id WHERE j.id = ? AND j.owner_id = 'owner'`)
    .bind(legacyJobId).first();
  return row ? candidateFrom(row) : null;
}
