-- One owner-reviewed Groq retry for a specific unresolved Gemini 404. Original operations stay intact.
CREATE TABLE IF NOT EXISTS yta_free_recovery(
 job_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, file_sha256 TEXT NOT NULL,
 gemini_operation_id TEXT NOT NULL, groq_429_operation_id TEXT NOT NULL,
 retry_operation_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('APPROVED','CLAIMED','USED')),
 approved_at TEXT NOT NULL, PRIMARY KEY(job_id,chunk_index)
);
