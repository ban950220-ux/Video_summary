// Job repository over D1 (v1_ tables only). Single owner app: Access already limits callers.
import {AppError} from '../errors.mjs';
import {ensureV1Schema} from './schema.mjs';

export const STATUS = Object.freeze({
  QUEUED: 'QUEUED', ACQUIRING: 'ACQUIRING', SUMMARIZING: 'SUMMARIZING', DONE: 'DONE', FAILED: 'FAILED',
  WAITING_PC: 'WAITING_PC', PC_RUNNING: 'PC_RUNNING',
});
const ACTIVE = [STATUS.QUEUED, STATUS.ACQUIRING, STATUS.SUMMARIZING, STATUS.DONE, STATUS.WAITING_PC, STATUS.PC_RUNNING];
export const PC_LEASE_MS = 30 * 60_000;

function requireDb(db) {
  if (!db) throw new AppError('PERSISTENCE_UNAVAILABLE');
  return db;
}

function parse(json, fallback = null) {
  if (json === null || json === undefined) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function jobFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, videoId: row.video_id, url: row.url, title: row.title, status: row.status,
    transcriptSource: row.transcript_source, errorCode: row.error_code, attempts: parse(row.attempts_json, []),
    options: parse(row.options_json, {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function jobRepository(db, {now = () => new Date().toISOString(), newId = () => crypto.randomUUID()} = {}) {
  const ready = async () => ensureV1Schema(requireDb(db));
  return {
    // The PC runner takes the oldest waiting job; a job whose runner went silent for PC_LEASE_MS is
    // offered again. The conditional UPDATE makes the claim atomic across runners.
    async claimPcJob() {
      await ready();
      const stale = new Date(Date.parse(now()) - PC_LEASE_MS).toISOString();
      const row = await db.prepare(`SELECT id, status FROM v1_jobs WHERE status = ? OR (status = ? AND updated_at < ?)
        ORDER BY created_at ASC LIMIT 1`).bind(STATUS.WAITING_PC, STATUS.PC_RUNNING, stale).first();
      if (!row) return null;
      const result = await db.prepare(`UPDATE v1_jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?
        AND (status = ? OR updated_at < ?)`).bind(STATUS.PC_RUNNING, now(), row.id, row.status, STATUS.WAITING_PC,
        stale).run();
      return Number(result?.meta?.changes ?? 0) === 1 ? this.get(row.id) : null;
    },
    async create({videoId = null, url = null, title = null, options = {}, status = STATUS.QUEUED}) {
      await ready();
      const id = newId();
      const at = now();
      await db.prepare(`INSERT INTO v1_jobs(id, video_id, url, title, status, options_json, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, videoId, url, title, status, JSON.stringify(options), at, at)
        .run();
      return this.get(id);
    },
    async get(id) {
      await ready();
      return jobFromRow(await db.prepare('SELECT * FROM v1_jobs WHERE id = ?').bind(id).first());
    },
    // An unfinished or finished job for the same video is reused instead of spending quota again.
    async findReusable(videoId) {
      await ready();
      const marks = ACTIVE.map(() => '?').join(',');
      const row = await db.prepare(`SELECT * FROM v1_jobs WHERE video_id = ? AND status IN (${marks})
        ORDER BY created_at DESC LIMIT 1`).bind(videoId, ...ACTIVE).first();
      return jobFromRow(row);
    },
    async update(id, fields) {
      await ready();
      const columns = {status: 'status', title: 'title', transcriptSource: 'transcript_source',
        errorCode: 'error_code', attempts: 'attempts_json', options: 'options_json'};
      const sets = [];
      const values = [];
      for (const [key, column] of Object.entries(columns)) {
        if (!Object.hasOwn(fields, key)) continue;
        sets.push(`${column} = ?`);
        values.push(key === 'attempts' || key === 'options' ? JSON.stringify(fields[key]) : fields[key]);
      }
      sets.push('updated_at = ?');
      values.push(now(), id);
      await db.prepare(`UPDATE v1_jobs SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
    },
    async list({q = '', limit = 20, offset = 0} = {}) {
      await ready();
      const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const skip = Math.max(Number(offset) || 0, 0);
      const like = `%${String(q).slice(0, 100).replace(/[%_\\]/g, ch => `\\${ch}`)}%`;
      const {results = []} = await db.prepare(`SELECT * FROM v1_jobs
        WHERE (? = '' OR title LIKE ? ESCAPE '\\' OR video_id LIKE ? ESCAPE '\\')
        ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(String(q), like, like, size, skip).all();
      return results.map(jobFromRow);
    },
    async remove(id) {
      await ready();
      for (const table of ['v1_summaries', 'v1_transcripts', 'v1_corrections', 'v1_checks']) {
        await db.prepare(`DELETE FROM ${table} WHERE job_id = ?`).bind(id).run();
      }
      const result = await db.prepare('DELETE FROM v1_jobs WHERE id = ?').bind(id).run();
      return Number(result?.meta?.changes ?? 0) > 0;
    },
    async saveTranscript(jobId, transcript, {legacyJobId = null} = {}) {
      await ready();
      await db.prepare(`INSERT INTO v1_transcripts(job_id, source, language, duration_sec, coverage_json,
        segments_json, legacy_job_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET source = excluded.source, language = excluded.language,
        duration_sec = excluded.duration_sec, coverage_json = excluded.coverage_json,
        segments_json = excluded.segments_json, legacy_job_id = excluded.legacy_job_id`)
        .bind(jobId, transcript.source, transcript.language, transcript.durationSec,
          JSON.stringify(transcript.coverage), JSON.stringify(transcript.segments), legacyJobId, now()).run();
    },
    async loadTranscript(jobId) {
      await ready();
      const row = await db.prepare('SELECT * FROM v1_transcripts WHERE job_id = ?').bind(jobId).first();
      if (!row) return null;
      const segments = parse(row.segments_json, []);
      return {
        source: row.source, language: row.language, durationSec: row.duration_sec,
        timed: segments.every(s => s.startMs !== null), coverage: parse(row.coverage_json, {}), segments,
        legacyJobId: row.legacy_job_id,
      };
    },
    async saveCorrection(jobId, segmentId, text) {
      await ready();
      if (!text) {
        await db.prepare('DELETE FROM v1_corrections WHERE job_id = ? AND segment_id = ?').bind(jobId, segmentId).run();
        return;
      }
      await db.prepare(`INSERT INTO v1_corrections(job_id, segment_id, text, updated_at) VALUES(?, ?, ?, ?)
        ON CONFLICT(job_id, segment_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`)
        .bind(jobId, segmentId, text, now()).run();
    },
    async loadCorrections(jobId) {
      await ready();
      const {results = []} = await db.prepare('SELECT segment_id, text FROM v1_corrections WHERE job_id = ?')
        .bind(jobId).all();
      return Object.fromEntries(results.map(r => [r.segment_id, r.text]));
    },
    async saveSummary(jobId, summary) {
      await ready();
      await db.prepare(`INSERT INTO v1_summaries(job_id, version, summary_json, created_at) VALUES(?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET version = excluded.version, summary_json = excluded.summary_json,
        created_at = excluded.created_at`).bind(jobId, summary.version, JSON.stringify(summary), now()).run();
    },
    // Raw stored JSON, so a result can be returned without parsing and re-serializing the transcript.
    async loadTranscriptRaw(jobId) {
      await ready();
      return db.prepare(`SELECT source, language, duration_sec, coverage_json, segments_json, legacy_job_id
        FROM v1_transcripts WHERE job_id = ?`).bind(jobId).first();
    },
    async loadSummaryRaw(jobId) {
      await ready();
      const row = await db.prepare('SELECT summary_json FROM v1_summaries WHERE job_id = ?').bind(jobId).first();
      return row?.summary_json ?? null;
    },
    async saveChecks(jobId, checks) {
      await ready();
      await db.prepare(`INSERT INTO v1_checks(job_id, version, checks_json, created_at) VALUES(?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET version = excluded.version, checks_json = excluded.checks_json,
        created_at = excluded.created_at`).bind(jobId, checks.version, JSON.stringify(checks), now()).run();
    },
    async loadChecks(jobId) {
      await ready();
      const row = await db.prepare('SELECT checks_json FROM v1_checks WHERE job_id = ?').bind(jobId).first();
      return row ? parse(row.checks_json) : null;
    },
    async loadSummary(jobId) {
      await ready();
      const row = await db.prepare('SELECT summary_json FROM v1_summaries WHERE job_id = ?').bind(jobId).first();
      return row ? parse(row.summary_json) : null;
    },
  };
}
