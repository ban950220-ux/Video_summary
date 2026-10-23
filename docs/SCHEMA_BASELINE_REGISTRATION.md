# Existing schema baseline registration

## Scope

This operator module handles an existing managed schema equivalent to the reviewed
schema through 0015 when `d1_migrations` is absent. It records a **new baseline
fact**, not a claim that historical migration files ran. It never inserts historical
`d1_migrations` rows, runs a migration, calls a provider, or deploys a Worker.

The fixed source is main `1745b884981ccc725de5c21aa389e6e26e8f9f10`, tree
`b8aec59427c2d4a0450b68ff77303aab1584b163`. The existing reviewed migration catalog
still pins all 14 SQL files and their exact LF/CRLF bytes. Schema comparisons retain
SQL literal case/content. Expected managed schema: 19 tables, 28 indexes, fingerprint
`78c5aa7885e8ea94ee012e7ecccfafe991e3d7da377c21c38f3250401983d300`.

The earlier proposal v1/v2 artifacts remain separate and unchanged. The copied
`schema-baseline-review.mjs` retains `productionExecutionSupported:false`: it is an
offline assessment, not proof that supplied observations or approvals are authentic.

## Executable interface and trust boundary

`scripts/schema-baseline-registration.mjs` exports:

- `readRegistrationSnapshot(db)`: read current managed SQL definitions, state counts,
  migration-table presence and the database clock in one SELECT. No row bodies,
  credentials or provider keys are returned.
- `registerManagedSchemaBaseline(db, input, {assertAuthorized})`: a single guarded
  D1 batch followed by readback.
- `inspectRegisteredBaseline(db)`: read and validate storage definitions and the
  immutable record; also use this after an uncertain result or expired approval.
- `readBaselineForMigration(db)`: read the persisted record and current managed
  schema fingerprint for the existing migration preflight/postcheck.

The module takes an **already authorized** D1 binding/adapter with
`prepare().bind().first()/all()` and atomic `batch()`. It has no HTTP endpoint, remote
client, credentials, automatic retry, command-line registration command or login
flow. Its source checks use local Node `node:sqlite` and authenticated repository
buffers. This is operator code, not a Worker runtime module.

The caller must implement `assertAuthorized({db, target, approvalDigest})`. It must
verify the actual selected database object, the approved evidence/operation digest,
and that the real writer pause and authorization still hold, returning exactly
`true` only then. There is no permissive default. SQL cannot discover a Cloudflare
account/database ID from `sqlite_master`. Labels in JSON do not prove that identity.
Hashes and boolean controls are bindings to reviewed evidence, not authentication.
Tests use a synthetic callback; that callback must never be used operationally.

There is currently **no operational identity/approval adapter**. In particular, an
always-true callback can authorize a schema-equivalent local DB: it is neither
proof of the real Cloudflare database nor proof of owner consent. This patch does
not promote that callback or the local registration result into operational
execution support.

The fixed target is account `fe9d7e2a164274b1ff6cef150a75cb0b`, database
`d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34` (`youtube-ai-analyzer-private-db`, binding
`DB`). Independently confirm that the authorized adapter actually selects it.

## Required input

The exact top-level fields are `observation`, `review`, `controls`, `dbSnapshot`
and `approval`. They must be assembled from fresh evidence within the same paused
window; the previously collected two-window operational observations are not a
registration snapshot.

1. `dbSnapshot` is returned by the SELECT above. Its schema must match the fixed
   managed schema, its content digest must match, no `d1_migrations` object may
   exist, and relevant active/unsettled counts must be zero. Historical
   `FAILED_UNCERTAIN` records remain present and are not treated as permission to
   retry their requests.
2. `observation` contains the exact observed schema rows, exact target IDs,
   `startedAt`/`completedAt`, and a canonical lowercase SHA-256 of the retained
   observation evidence. `review` binds that digest, schema fingerprint and catalog
   digest with `historyClaim: UNKNOWN_NO_HISTORICAL_APPLIED_ROWS`. Review follows
   the observation. The registration module compares rows with the live snapshot.
3. `controls` must pass the reviewed proposal contract: actual writer pause,
   relevant dispatch pause, both auto-build paths disabled, no running/queued
   build, no relevant unsettled operation, reviewed commands/protected evidence,
   exact target and schema fingerprint, and a fresh restore bookmark for that DB.
   Scope is `BASELINE_RECORD_ONLY_NO_MIGRATION_EXECUTION`. A nonempty bookmark
   string alone does not prove restorability; the authorized evidence reviewer
   must establish its source, target and meaning.
4. `approval` allows only these fields (extra fields are rejected):
   `kind`, `requestId`, `accountId`, `databaseId`, `action`, `approvedAt`, `expiresAt`,
   `windowId`, `windowStartsAt`, `windowEndsAt`, `observationDigest`, `snapshotDigest`,
   `schemaFingerprint`, `catalogDigest`, `controlsDigest`, `restoreBookmarkDigest`.
   Kind is `SCHEMA_BASELINE_REGISTRATION_APPROVAL_V1`; action is
   `REGISTER_BASELINE_ONLY`. Request/window IDs are UUIDs. Times are UTC ISO strings
   with milliseconds. Approval follows every supplied evidence timestamp, expires
   within five minutes, and sits inside a named window of at most fifteen minutes.
   All six digest bindings must match the exact reviewed inputs.

Evidence freshness is at most five minutes. Authorization is checked before reads
and again after the final awaited snapshot. The request is revalidated after the
last authorization await. The atomic INSERT independently checks the database
clock, evidence age, exact live schema/state snapshot, history-table absence, and
the exact baseline storage SQL definitions. No `snapshot absent` fallback exists.

## Writes, concurrency and uncertain outcomes

The batch creates only `codex_schema_baselines` and its two immutable update/delete
triggers, then inserts one whitelisted metadata record. It stores hashes, IDs,
scope and times, not the source transcript, report, usage rows, credentials or full
approval objects. An assertion at the end raises a runtime error if the expected
record/storage is absent or different; D1 rolls back the whole batch including DDL.
Unexpected baseline storage definitions/triggers are rejected.

### Identifier-case correction (v2)

`sqlite_master` retains the original spelling even though SQLite resolves ASCII
identifier case insensitively. Both the initial snapshot and the atomic INSERT
now use the same `COLLATE NOCASE` history-object lookup. `D1_MIGRATIONS` and
`D1_Migrations` require history review exactly as `d1_migrations` does. If a history
object appears just before the batch, registration fails and all baseline DDL
rolls back; the preexisting history object/rows remain untouched.

The baseline storage lookup and managed `jobs`/`usage_events`/`yta_` scope use the
same identifier discovery rule. Case variants are included in inspection and
rejected when their exact definitions differ from the reviewed schema; they are
not reported absent or silently canonicalized. This changes only identifier
discovery. SQL literals, state values, hashes and evidence remain exact. Tests
cover these cases in SQLite and actual local Workerd, including late object
creation. The v1 patch and its review records remain preserved separately.

Same approved request returns the existing record with zero new write batches.
Concurrent identical requests converge on one row. A different record conflicts.
The two triggers reject ordinary UPDATE/DELETE; they cannot protect against an
administrator intentionally dropping or rewriting schema. No recovery code silently
repairs a different or malformed record.

On batch error the module makes one read-only reconciliation attempt, never a
second write batch. Exact durable evidence returns `RECOVERED_AFTER_ACK_LOSS`.
Unavailable or inconclusive readback returns `BASELINE_REGISTRATION_UNCONFIRMED`.
Keep the write outcome unresolved and inspect later; do not automatically create a
new request ID or repeat the batch. A successful record is not a migration success.

## Integration with the 0016 guard

The original history-backed path is unchanged. The explicit new path requires
`snapshot.schemaBaseline = await readBaselineForMigration(db)` from an authorized
read, in addition to all existing quiet-window, backup, target and source evidence.

Before 0016, the actual history must be empty/absent and **all 14** catalog files
remain in the full repository pending list. The guard permits execution scope
containing **only 0016** in the already supported isolated migration directory.
It does not relabel nine historical files as applied or filter the observed queue.
Never run the full repository migration directory in this state.

After a separately authorized real 0016 application, the actual history must contain
only `0016_full_coverage_write_lock.sql`, and the full pending list must still contain
the other thirteen files. The exact baseline record must remain unchanged. A fresh
schema fingerprint must equal the authenticated baseline plus 0016, and all eleven
trigger SQL definitions must pass the existing checks. The local test inserts a
synthetic 0016 history row only after executing that SQL in a disposable database;
it does not demonstrate or alter operational history.

This closes the explicit history gap for the guarded **0016 stage only**. It does
not authorize 0017–0020, expose a registration route, restore auto-builds, enable a
feature, bypass production target/lineage/protected-evidence gates, or establish
that a whole production release is ready. Later phases retain their reviewed
sequence and independent preconditions.

## Verification and operational limits

SQLite tests exercise evidence rejection, expiry after the last await and during
the batch handoff, late schema/claim changes, malicious storage triggers, identical
concurrency, immutable records, pre-commit failure, ACK loss and persistent read
failure. They hash source/report/usage and seven synthetic historical uncertain
records before/after. A real local Miniflare/Workerd D1 test additionally verifies
transactional DDL rollback, late claim rejection, successful readback/idempotency
and ACK-loss reconciliation. Responses and database rows are synthetic.

No operational registration, migration, provider call, key change or deployment
was performed. Operational use still requires independent review of this patch,
an approved actual binding/authorization adapter, fresh same-window schema/state
reads, a verified restore point, enforced writer pause, command/protected evidence
and an authentic narrowly scoped registration approval. The historical two-window
schema match and seven uncertain rows are useful evidence, but cannot fill in those
missing controls.
