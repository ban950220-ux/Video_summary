-- Unapplied proposal; provider accounting remains in existing yta_operations,
-- yta_quota, yta_capacity and usage_events. This table does not replace them.
CREATE TABLE IF NOT EXISTS yta_local_runner_audio_dispatches (
 job_id TEXT NOT NULL,
 chunk_index INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 manifest_sha256 TEXT NOT NULL,
 chunk_sha256 TEXT NOT NULL,
 operation_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('DISPATCH_UNCERTAIN','BLOCKED','TRANSCRIBED')),
 error_code TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY(job_id,chunk_index)
);
