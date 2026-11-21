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
