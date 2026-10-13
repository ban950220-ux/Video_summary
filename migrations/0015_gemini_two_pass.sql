-- Separate, default-disabled two-call Gemini review. Apply only after review.
CREATE TABLE IF NOT EXISTS yta_gemini_two_pass_jobs(
 job_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL CHECK(owner_id='owner'), source_sha256 TEXT NOT NULL,
 audit_sha256 TEXT NOT NULL, first_request_sha256 TEXT NOT NULL, quote_sha256 TEXT NOT NULL,
 quote_json TEXT NOT NULL, project_mode TEXT NOT NULL CHECK(project_mode IN ('FREE_ATTESTED','PAID_APPROVED')),
 credential_generation TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('QUOTED','APPROVED','FIRST_PENDING','FIRST_READY','REVIEW_PENDING','ISSUES','COMPLETE','BLOCKED','CANCELLED')),
 first_report_json TEXT, review_json TEXT, error_code TEXT, expires_at INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS yta_gemini_two_pass_calls(
 job_id TEXT NOT NULL, phase INTEGER NOT NULL CHECK(phase IN (0,1)), request_sha256 TEXT NOT NULL,
 input_tokens_counted INTEGER NOT NULL, output_tokens_cap INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('RESERVED','RECEIVED','INCOMPLETE','VALIDATION_FAILED','SETTLED','UNCERTAIN')),
 response_json TEXT, response_sha256 TEXT, response_bytes INTEGER, response_complete INTEGER NOT NULL DEFAULT 0,
 http_status INTEGER, finish_reason TEXT, usage_json TEXT, token_estimate_micro_usd INTEGER,
 error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(job_id,phase), FOREIGN KEY(job_id) REFERENCES yta_gemini_two_pass_jobs(job_id)
);
