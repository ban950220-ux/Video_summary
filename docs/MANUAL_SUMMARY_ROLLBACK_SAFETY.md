# Imported-summary rollback preparation

## Status and execution boundary

This is an unpublished local preparation and rehearsal. It does not execute a
Worker rollback, contact Cloudflare, install a production write fence, change
Access, update credentials, or modify production D1. Every exported decision
contains `productionExecutionSupported: false`, `operationallyAuthorized: false`,
and `writesMayResume: false`.

`scripts/manual-summary-rollback.mjs` accepts a native temporary/in-memory SQLite
database. Remote bindings, attached databases, temporary schemas, and local files
outside the temporary directory are rejected by the migration schema inspector.
Target identity inputs must explicitly identify synthetic local execution.
Supplying production-looking flags or a copied JSON receipt cannot turn a local
rehearsal into production authorization.

No runtime route or deployed Worker flag is changed by this module. In particular,
the in-process test fence is not a durable fence for old/new Workers or background
writers, and the module never claims that such a production fence exists.

## Why a previous Worker version may be unsafe

Imported summaries and their request ledger live in separate tables. A version
whose analysis-deletion path predates these tables can delete the parent analysis
while leaving imported personal text in the database. Changing the Worker version
does not revert D1 or remove this orphan risk.

The local regression suite demonstrates this using a synthetic legacy deletion
fixture and actual SQLite. It also invokes the current authenticated analysis
deletion route and verifies that it removes only the deleted analysis's imported
text/request rows, leaves the other analysis's imported text intact, retains the
deletion tombstone, and preserves unrelated usage/approval/reservation records.
The existing explicit deletion behavior clears private provider response content
while retaining its receipt identity. This explicit user deletion is separate
from rollback, which must not delete any rows.

## Preconditions before the first production import

Before real imported content is stored, prepare a rollback target that has the
reviewed owner-scoped, deletion-tombstone import cleanup behavior. Validate it
against the exact target artifact and compatible D1 schema. A label or boolean
declaring compatibility is not operational evidence.

The production release plan must also identify an independently enforced way to
stop **all mutations**, including import saves and cancellations, analysis
deletions, source replacements, provider callbacks, queued work, and writes from
both old and new versions. A disabled button or a new-version-only flag cannot
fence an old Worker. Do not change Access/WAF/routes or introduce credentials to
create that control without the applicable separate approval.

The current production fence and authenticated target reader are not implemented
or verified by this local preparation. That remains a blocker before production
import/rollback can be declared ready.

## Required operational sequence

1. **Bind the exact targets.** Obtain authorized, current evidence of the active
   and fallback source commits, artifacts and Worker versions. Verify owner-only
   policy, database identity, bindings and preserved configuration.
2. **Stop new mutation admission.** Activate and observe the reviewed durable
   fence. Prove that direct requests, old clients and background writers cannot
   bypass it. Keep owner-only reads protected.
3. **Drain admitted work.** Reconcile admitted save/cancel/delete operations and
   late provider/database writes. A request whose response was lost needs durable
   GET readback; it must not be retried blindly. Import request rows only encode
   terminal states, so counting their rows alone does not prove no request is in
   flight. A `DELETING` tombstone whose parent analysis or imported content/request
   rows remain is unfinished durable cleanup even if its callback has already
   failed and the process reports zero active requests. Resolve it through a
   reviewed compatible cleanup path before preparing a rollback. Completed
   tombstones remain as late-write protection and are not deleted for rollback.
4. **Inspect the entire import DDL and existing data.** Use the dedicated 0021
   verifier. Check columns, defaults, nullability, primary and unique constraints,
   checks, foreign keys, indexes, triggers/views and table flags. Reject partial,
   mismatched or unexpected objects. Capture original and imported data hashes in
   a consistent snapshot without exporting record text.
5. **Choose a compatible target.** Once imports or request-ledger rows exist, this
   local planner rejects a target without `OWNER_TOMBSTONE_IMPORT_CLEANUP_V1`.
   Preserve the current compatible code and the write stop until a reviewed
   compatible target is available. The planner does not authorize an emergency
   legacy switch merely because someone asserts it will remain read-only.
6. **Switch code only through the normal preserved deployment gates.** Do not
   drop import tables, clear rows, rewind receipts, run a reverse migration or
   use a stale fixed-version/offline proposal as a deployment shortcut.
7. **Read back while writes remain stopped.** Verify the exact active version,
   owner-only access, database/configuration identity, full import DDL, absence of
   orphan imports, and unchanged original/imported record digests. Verify the
   target's explicit deletion behavior with reviewed local tests and a properly
   authorized operational validation plan; do not insert an arbitrary live sample.
8. **Review resumption separately.** Unknown acknowledgements, a new deployment,
   changed configuration or any data/schema drift keeps writes stopped. No
   function in this preparation automatically resumes mutations. Production
   resumption requires the actual enforced fence and target to be revalidated.

## Local implementation and evidence

`createLocalRollbackWriteFence()` closes mutation admission, waits for every
admitted callback to finish or fail, and provides an opaque process-local window.
Tests perform real SQLite writes through it and prove that save, cancel, delete,
provider-completion and other mutation callbacks are not invoked after closure.
This only covers callbacks explicitly enrolled in that process; it is not proof
that a distributed production deployment has stopped every writer.

`prepareLocalImportedSummaryRollback()` calls the dedicated full-DDL inspector on
the actual temporary SQLite database. It checks a drained fence, resolved lost
responses, matching owner/database/configuration identities, fresh evidence, and
absence of orphan records. Imported rows or even a durable cancelled request
block a cleanup-incompatible target. The issued plan is bound to its process
window and cannot be recreated by JSON copying. Durable incomplete analysis
deletion blocks both preparation and readback; a drained callback alone does not
clear that condition. A completed deletion tombstone is preserved and allowed.

`captureLocalRollbackSnapshot()` fingerprints every application table, including
separate approval, reservation and receipt tables. TEXT/BLOB content is converted
to SQLite hex before JavaScript decoding; integer values use BigInt and REAL
values use their IEEE-754 bytes. Record values and actual analysis IDs are not
returned. Ordinary-table implicit rowids are included; `WITHOUT ROWID` tables are
handled separately, and an inaccessible rowid caused by shadowing all aliases is
rejected. Schema inspection and all table fingerprints run within one read
transaction. Existing caller transactions are rejected without being committed
or rolled back.

The WAL regression uses a second local connection to change rows during the
snapshot. The observed snapshot remains one consistent generation. A change
after the plan snapshot is detected at readback. The test illustrates why a
process-local fence does not establish control over other writers.

`verifyLocalImportedSummaryRollback()` checks the exact synthetic target,
unchanged full DDL, all data digests, the same held fence, and the bounded time
window. The fixture can reopen SQLite read-only and verify that writes really
fail on that connection. Verification never unfences the application.

## Run the local regression

From the isolated preparation checkout:

```sh
node --test --test-isolation=none --test-concurrency=1 tests/manual-summary-rollback.test.mjs
```

All fixtures are invented. No provider request, production metadata read,
production migration, actual imported-summary write, GitHub upload, or release
operation is part of this test command.
