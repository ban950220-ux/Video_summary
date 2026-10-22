-- Additive proposal. Old BLOCKED rows have no new proof and cannot be reopened.
ALTER TABLE yta_local_runner_audio_dispatches ADD COLUMN attempt_id TEXT;
CREATE TABLE yta_local_runner_audio_attempts (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
 gate TEXT NOT NULL CHECK(gate IN ('PREPARED','FENCED','PROVEN_ZERO')),
 approval_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
 resume_approval_id TEXT,
 evidence_json TEXT, evidence_sha256 TEXT, created_at TEXT NOT NULL
);
CREATE TABLE yta_local_runner_audio_resumes (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
 blocked_attempt_id TEXT NOT NULL UNIQUE, approval_json TEXT NOT NULL,
 approval_sha256 TEXT NOT NULL, expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('APPROVED','USED')),
 created_at TEXT NOT NULL
);
