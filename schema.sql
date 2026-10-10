-- Private owner-only YouTube AI Analyzer D1 schema. No plaintext provider keys.
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 video_id TEXT,
 title TEXT,
 source_url TEXT,
 source_type TEXT NOT NULL,
 status TEXT NOT NULL,
 duration_seconds REAL NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 report_json TEXT,
 audit_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_owner_date ON jobs(owner_id,created_at DESC);
CREATE TABLE IF NOT EXISTS usage_events (
 id TEXT PRIMARY KEY,
 job_id TEXT,
 owner_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 capability TEXT NOT NULL,
 unit TEXT NOT NULL,
 used_units REAL NOT NULL DEFAULT 0,
 estimated_usd REAL NOT NULL DEFAULT 0,
 actual_usd REAL,
 provenance TEXT NOT NULL,
 captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_events(owner_id,provider,captured_at DESC);
CREATE TABLE IF NOT EXISTS provider_credentials (
 owner_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 cipher_version INTEGER NOT NULL,
 iv_b64 TEXT NOT NULL,
 ciphertext_b64 TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,provider)
);
CREATE TABLE IF NOT EXISTS provider_credential_events (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 event_type TEXT NOT NULL,
 at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_events_date ON provider_credential_events(owner_id,at DESC);
