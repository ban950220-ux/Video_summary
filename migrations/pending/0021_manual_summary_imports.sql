-- Additive storage for owner-confirmed, externally authored summaries.
-- Pending local-test candidate: excluded from the approved migration catalog.
-- Promote only through the separately reviewed migration process. No existing
-- job, transcript, provider operation or billing row is changed here.
CREATE TABLE IF NOT EXISTS yta_summary_imports (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 job_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 source_sha256 TEXT NOT NULL,
 source_provenance TEXT NOT NULL,
 artifact_sha256 TEXT NOT NULL,
 artifact_bytes INTEGER NOT NULL CHECK(artifact_bytes > 0 AND artifact_bytes <= 1000000),
 content_text TEXT NOT NULL,
 provenance TEXT NOT NULL CHECK(provenance = 'EXISTING_TRANSCRIPT_IMPORTED'),
 basis_method TEXT NOT NULL CHECK(basis_method = 'OWNER_SOURCE_RECONCILIATION'),
 created_at TEXT NOT NULL,
 UNIQUE(owner_id, job_id, source_sha256, artifact_sha256),
 UNIQUE(owner_id, job_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_summary_imports_job ON yta_summary_imports(owner_id, job_id, revision DESC);
CREATE TABLE IF NOT EXISTS yta_summary_import_requests (
 owner_id TEXT NOT NULL,
 job_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('COMMITTED', 'CANCELLED')),
 request_sha256 TEXT,
 import_id TEXT,
 created_at TEXT NOT NULL,
 CHECK((state = 'COMMITTED' AND request_sha256 IS NOT NULL AND import_id IS NOT NULL)
    OR (state = 'CANCELLED' AND request_sha256 IS NULL AND import_id IS NULL)),
 PRIMARY KEY(owner_id, job_id, request_id)
);
