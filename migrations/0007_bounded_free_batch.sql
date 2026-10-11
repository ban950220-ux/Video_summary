-- Owner-approved, exact-file Groq Free batch. No provider balance is inferred.
CREATE TABLE IF NOT EXISTS yta_free_batches(
 job_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, file_sha256 TEXT NOT NULL,
 key_identity TEXT NOT NULL, model TEXT NOT NULL CHECK(model='whisper-large-v3-turbo'),
 chunk_ids_json TEXT NOT NULL, max_requests INTEGER NOT NULL CHECK(max_requests BETWEEN 1 AND 160),
 max_audio_seconds INTEGER NOT NULL CHECK(max_audio_seconds BETWEEN 10 AND 26000),
 free_tier_confirmed INTEGER NOT NULL CHECK(free_tier_confirmed=1), billing_disabled INTEGER NOT NULL CHECK(billing_disabled=1),
 state TEXT NOT NULL CHECK(state IN ('APPROVED','STOPPED','COMPLETE','CANCELLED')),
 approved_at TEXT NOT NULL, expires_at INTEGER NOT NULL,
 stop_reason TEXT, retry_after_at INTEGER
);
CREATE TABLE IF NOT EXISTS yta_free_batch_chunks(
 job_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, units INTEGER NOT NULL CHECK(units BETWEEN 10 AND 601),
 state TEXT NOT NULL CHECK(state IN ('APPROVED','CLAIMED','DONE','STOPPED')),
 operation_id TEXT NOT NULL UNIQUE, PRIMARY KEY(job_id,chunk_index)
);
