-- An exact, one-response Free-tier probe. UNKNOWN account capacity is never replaced with a fabricated balance.
CREATE TABLE IF NOT EXISTS yta_free_probe(
 job_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, file_sha256 TEXT NOT NULL,
 retry_operation_id TEXT NOT NULL UNIQUE, key_identity TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('APPROVED','CLAIMED','USED')),
 approved_at TEXT NOT NULL, expires_at INTEGER NOT NULL, response_meta_json TEXT,
 PRIMARY KEY(job_id,chunk_index)
);
