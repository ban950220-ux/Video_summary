-- Local owner-runner proposal. No credentials. Approval records below are
-- bounded upload contracts; provider dispatch remains unimplemented/disabled.
CREATE TABLE IF NOT EXISTS yta_local_runner_outbox (
 -- No FK to jobs: deletion must retain uncertain operation metadata.
 job_id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE,
 video_id TEXT NOT NULL,
 canonical_url TEXT NOT NULL,
 source_url_snapshot TEXT NOT NULL,
 duration_seconds REAL NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('QUEUED','LEASED','ACQUIRED','DISPATCH_UNCERTAIN','BLOCKED','CANCELLED','COMPLETE')),
 lease_owner TEXT,
 lease_nonce TEXT,
 lease_expires_at INTEGER,
 revision INTEGER NOT NULL DEFAULT 0,
 manifest_json TEXT,
 manifest_sha256 TEXT,
 audio_link_manifest_sha256 TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK((lease_owner IS NULL AND lease_nonce IS NULL AND lease_expires_at IS NULL) OR
       (lease_owner IS NOT NULL AND lease_nonce IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_yta_local_runner_queue ON yta_local_runner_outbox(state,lease_expires_at);
CREATE TABLE IF NOT EXISTS yta_local_runner_batches (
 request_id TEXT PRIMARY KEY,
 job_id TEXT NOT NULL UNIQUE,
 approval_json TEXT NOT NULL,
 approval_sha256 TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 max_calls INTEGER NOT NULL,
 max_micro_usd INTEGER NOT NULL,
 per_call_micro_usd INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('APPROVED','CANCELLED'))
);
CREATE TABLE IF NOT EXISTS yta_local_runner_transfers (
 job_id TEXT NOT NULL,
 chunk_index INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 chunk_sha256 TEXT NOT NULL,
 reserved_micro_usd INTEGER NOT NULL,
 -- Receipt means local upload admission only, never provider dispatch/completion.
 state TEXT NOT NULL CHECK(state IN ('RECEIVED')),
 receipt_json TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY(job_id,chunk_index)
);
