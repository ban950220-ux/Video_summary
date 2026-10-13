-- Additive one-attempt contract after a consumed first trial. Existing approvals,
-- reservations, receipts and the singleton trial remain untouched.
CREATE TABLE IF NOT EXISTS yta_paid_retry_quotes(
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner_id TEXT NOT NULL CHECK(owner_id='owner'),
 prior_approval_id TEXT NOT NULL, prior_reservation_id TEXT NOT NULL,
 source_sha256 TEXT NOT NULL, request_sha256 TEXT NOT NULL, quote_sha256 TEXT NOT NULL,
 quote_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('ISSUED','EXPIRED')),
 expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_paid_retry_issued_job ON yta_paid_retry_quotes(job_id) WHERE state='ISSUED';
CREATE TABLE IF NOT EXISTS yta_paid_retry_attempts(
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL CHECK(owner_id='owner'),
 quote_id TEXT NOT NULL UNIQUE, prior_approval_id TEXT NOT NULL, prior_reservation_id TEXT NOT NULL,
 source_sha256 TEXT NOT NULL, request_sha256 TEXT NOT NULL, quote_sha256 TEXT NOT NULL,
 quote_json TEXT NOT NULL, model TEXT NOT NULL, credential_generation TEXT NOT NULL,
 max_micro_usd INTEGER NOT NULL CHECK(max_micro_usd>0), max_calls INTEGER NOT NULL CHECK(max_calls=1),
 expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('APPROVED','RESERVED','RELEASED','UNCERTAIN','SETTLED')),
 token_estimate_micro_usd INTEGER, usage_json TEXT, outcome TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS yta_paid_retry_receipts(
 attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner_id TEXT NOT NULL CHECK(owner_id='owner'),
 source_sha256 TEXT NOT NULL, request_sha256 TEXT NOT NULL, quote_sha256 TEXT NOT NULL,
 response_sha256 TEXT, response_bytes INTEGER NOT NULL, response_json TEXT,
 response_complete INTEGER NOT NULL CHECK(response_complete IN (0,1)), http_status INTEGER,
 model_version TEXT, finish_reason TEXT, usage_json TEXT,
 state TEXT NOT NULL CHECK(state IN ('RECEIVED','INCOMPLETE','ENVELOPE_INVALID','VALIDATION_FAILED','SAVE_FAILED','SAVED','SOURCE_DELETED')),
 error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
