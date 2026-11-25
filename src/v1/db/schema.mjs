// v1 tables. Additive only (CREATE ... IF NOT EXISTS); never touches v0.7 tables.
// Kept in code rather than migrations/ because the v0.7 migration catalog is pinned by tests
// and release guards. Applying it to production D1 happens with the stage 6 deploy approval.
export const V1_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS v1_jobs (
    id TEXT PRIMARY KEY,
    video_id TEXT,
    url TEXT,
    title TEXT,
    status TEXT NOT NULL,
    transcript_source TEXT,
    error_code TEXT,
    attempts_json TEXT,
    options_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS v1_jobs_created ON v1_jobs(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS v1_jobs_video ON v1_jobs(video_id)',
  `CREATE TABLE IF NOT EXISTS v1_transcripts (
    job_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    language TEXT,
    duration_sec REAL,
    coverage_json TEXT NOT NULL,
    segments_json TEXT NOT NULL,
    legacy_job_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS v1_summaries (
    job_id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  // Human corrections are stored apart from the transcript, which is never edited.
  `CREATE TABLE IF NOT EXISTS v1_corrections (
    job_id TEXT NOT NULL,
    segment_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, segment_id)
  )`,
  // Checks derived from a saved summary (numeric verification and the segments the review list needs),
  // computed once in a Workflow step so reading a result stays within the Workers Free CPU limit.
  `CREATE TABLE IF NOT EXISTS v1_checks (
    job_id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    checks_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS v1_usage (
    day TEXT NOT NULL,
    key TEXT NOT NULL,
    units INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key)
  )`,
]);

export const V1_OBJECTS = Object.freeze(V1_SCHEMA.map(sql => /IF NOT EXISTS (\w+)/.exec(sql)[1]));

// Once per Worker instance and database. One lookup when everything exists (the normal case); the
// CREATE statements run only when something is missing. The promise is shared, so parallel loads in one
// request do not each start the check (they did: 4 x 9 statements on a cold result read).
const ready = new WeakMap();

export function ensureV1Schema(db) {
  if (!ready.has(db)) {
    const run = (async () => {
      const marks = V1_OBJECTS.map(() => '?').join(', ');
      const {results = []} = await db.prepare(`SELECT name FROM sqlite_master WHERE name IN (${marks})`)
        .bind(...V1_OBJECTS).all();
      if (results.length === V1_OBJECTS.length) return;
      for (const sql of V1_SCHEMA) await db.prepare(sql).run();
    })();
    run.catch(() => ready.delete(db));
    ready.set(db, run);
  }
  return ready.get(db);
}
