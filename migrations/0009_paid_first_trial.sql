-- One global, single-use first-generation trial. Apply only after separate review.
CREATE TABLE IF NOT EXISTS yta_paid_first_trial(
 id TEXT PRIMARY KEY CHECK(id='FIRST_GENERATION'),
 approval_id TEXT NOT NULL UNIQUE,
 job_id TEXT NOT NULL,
 source_sha256 TEXT NOT NULL,
 request_sha256 TEXT NOT NULL,
 quote_sha256 TEXT NOT NULL,
 model TEXT NOT NULL,
 credential_generation TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 max_calls INTEGER NOT NULL CHECK(max_calls=1),
 max_micro_usd INTEGER NOT NULL CHECK(max_micro_usd=720896),
 evidence_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING_APPROVAL','APPROVED','CONSUMED')),
 created_at TEXT NOT NULL,
 consumed_at TEXT
);
