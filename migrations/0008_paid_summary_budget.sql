-- Dormant paid-summary contract and conservative reservation ledger. No provider dispatch uses these tables.
CREATE TABLE IF NOT EXISTS yta_paid_summary_approvals(
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner_id TEXT NOT NULL CHECK(owner_id='owner'),
 source_sha256 TEXT NOT NULL, quote_sha256 TEXT NOT NULL, quote_json TEXT NOT NULL, model TEXT NOT NULL,
 price_version TEXT NOT NULL, credential_generation TEXT NOT NULL,
 max_micro_usd INTEGER NOT NULL CHECK(max_micro_usd>0), max_call_micro_usd INTEGER NOT NULL CHECK(max_call_micro_usd>0), max_calls INTEGER NOT NULL CHECK(max_calls>0),
 expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('APPROVED','CANCELLED')),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS yta_paid_summary_reservations(
 id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, call_index INTEGER NOT NULL CHECK(call_index>=0),
 reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd>0),
 state TEXT NOT NULL CHECK(state IN ('RESERVED','UNCERTAIN','SETTLED','RELEASED')),
 created_at TEXT NOT NULL, UNIQUE(approval_id,call_index)
);
