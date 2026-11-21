# 0016–0020 staged migration review (local evidence only)

Base: PR29 `043ba56ee716f044698a6de66f079a7c7bae8753`, tree
`4e5eeda2d4781719af3e543d5eeaef62de342df0`. This is a separate local delta.
It does not change SQL migrations, application routes, deployment settings,
provider authorization, or the frozen PR26–29 patches. Nothing is applied remotely.

## Confirmed blocker and narrowly scoped correction

The original 0016 assessor requires the complete pending list to be `[0016]`
before apply and `[]` after apply. PR27 adds 0017; PR29 adds 0018–0020. The
unmodified assessor therefore rejects the normal pending queue of those trees.
The regression fails on the base tree (`false !== true`) before this delta.

Ordinary multi-file apply remains rejected. An explicit, separately inspected
single-file execution scope can now coexist with the full repository queue.
The additional `executionScope` fields are:

```js
{
  kind: 'SINGLE_MIGRATION_DIRECTORY_V1',
  databaseId: /* same pinned database as the full observation */,
  migrationsTable: 'd1_migrations',
  files: [{ name: '0016_full_coverage_write_lock.sql', sha256: /* exact file bytes */ }],
  pendingMigrations: ['0016_full_coverage_write_lock.sql']
}
```

These fields describe an exhaustive inspected execution directory/config and
its list result. They are not a caller-selected subset of a larger directory.
The snapshot's original `pendingMigrations` remains the full, unfiltered list.
It must be exactly all five reviewed files 0016–0020. The v1 local patch
incorrectly accepted shortened tails; this v2 rejects all four omissions.
Unknown, skipped, shortened, reordered, duplicate or earlier pending lists block.
`appliedMigrations` must be the exact sorted names through 0015. Wrong target,
history table, extra file, different bytes, missing prerequisites, partial
triggers, active relevant work, missing backup and stale evidence still block.

The snapshot kind is now `FULL_COVERAGE_MIGRATION_READONLY_V2`; the old V1
snapshot is rejected. `repositorySource` must equal the complete catalog returned
by `reviewedMigrationSource()` from `scripts/migration-source-catalog.mjs`, based
on commit `043ba56ee716f044698a6de66f079a7c7bae8753` and tree
`4e5eeda2d4781719af3e543d5eeaef62de342df0`. Its fourteen ordered SQL names and
hashes cover prerequisites and deferred files. This is the migration-source
identity, not the future release/merge SHA. A different catalog requires separate
review; an operator must not copy these labels over a different source tree.

The validator also re-reads the local SQL directory on EVERY before/after check.
Extra/missing files, renamed files and same-name byte changes block, including
changes made after module import. Observed hash replacement cannot change the
fixed trust catalog. Two exact byte representations are pinned from the Git
blobs: LF and the Windows CRLF checkout. Arbitrary SQL is never normalized;
case/whitespace/literal changes are rejected. The isolated 0016 file's exact
chosen hash must stay the same before and after. Its selection still cannot
include any other migration.

V3 additionally authenticates the exact 0016 byte buffer BEFORE converting it
to text or extracting any cached trigger expectations. Importing altered SQL
throws `FULL_COVERAGE_MIGRATION_SOURCE_INVALID`; restoring the on-disk file later
cannot authenticate an earlier unverified definition. Full-catalog before/after
rechecks remain in place. A synthetic read/restore race verifies that hashing
does not re-read a different buffer. LF/CRLF controls use actual SQLite triggers:
the altered provider literal allows a CLAIMED source update, the normal literal
raises `FULL_COVERAGE_SOURCE_LOCKED`, and only the normal definitions pass after
a fresh verified import.

Call `verifyFullCoverageMigration(after, {before})` for this explicit path.
The after observation must show the same directory/target, no pending file in
that directory, only 0016 newly recorded, all eleven exact trigger definitions,
and exactly **0017–0020 still pending in the full repository**. A postcheck without
the reviewed before snapshot now fails closed. The separately named
`verifyFullCoverageTriggerDefinitions` compares only schema definitions; it does
not assess migration completion or readiness. This patch never applies a migration.

The installed Wrangler 4.149.0 source (`src/d1/migrations/apply.ts` and
`helpers.ts`, bundled in `wrangler-dist/cli.js`) confirms that apply processes
every pending file selected by the D1 binding's `migrations_dir`/pattern. It
appends an INSERT into the configured migration-history table to each SQL file.
It offers no single migration filename argument. Therefore a normal full-tree
`migrations apply` must not be used as a substitute for one selected file.
A separately reviewed temporary config/directory with one byte-identical SQL
file is the supported selection mechanism; retain the same D1 target and history
table. Inspect both full-tree and isolated lists. No remote invocation or
temporary operational config was created in this task.

## Stage conditions and compatibility

Every stage requires a fresh authorized D1 schema/history observation, quiet
writers/builds, a real recovery point, and a reviewed single-file scope. Reading
names alone is insufficient: inspect complete table/column/index/trigger SQL.
Do not invent a history row to make partial DDL appear complete. Pending 0015 or
an unknown migration requires a separate prior review; this sequence does not
skip it. Keep full-coverage/synthesis execution disabled and runner unrouted.

| Stage | Schema change | Allowed next step | Block / compatibility limit |
| --- | --- | --- | --- |
| 0016 | Eleven source/job/proof/usage write-lock triggers | Exact trigger SQL and 0016 history verified; all later files still pending | Pre-existing/partial/wrong triggers, CLAIMED or RECEIPT_STORED full-coverage/synthesis operations, missing fresh backup, or nonisolated queue block. Idle legacy named-column writers still work; active request proof edits abort. |
| 0017 | Nullable `jobs.submission_hash` | Column shape/history verified, legacy rows still NULL | Required for PR27–29 URL+owned-audio idempotent creation; missing column returns `LIVE_SCHEMA_REQUIRED` before creating a job. Pure audio legacy creation remains compatible. Replay of the ALTER is not idempotent. |
| 0018 | Outbox, batch approval and transfer tables; queue index | Exact new table SQL/constraints, including `audio_link_manifest_sha256`, verified | Earlier proposal 0018 lacks that column; `CREATE IF NOT EXISTS` does not upgrade it. Stop for a reviewed ALTER if already applied. No bridge execution before 0019/0020. Old PR26–28 deletion does not scrub populated runner records. |
| 0019 | Unique per-chunk dispatch ledger, unique operation ID | Exact table and history verified, uncertainty metadata retained | Full PR29 bridge also needs 0020. Do not activate an intermediate older bridge. Existing BLOCKED/uncertain records must not be retried or cleared. |
| 0020 | Nullable dispatch `attempt_id`, attempts and one-use resume approvals | All exact columns/tables/constraints and history verified | Historical rows retain NULL attempt IDs and receive no proof. They cannot become resumable by schema upgrade. Duplicate ALTER fails; partial objects require reconciliation. Actual runner remains unrouted and real auth/acquisition/Free linkage unverified. |

PR26 is `2ac2a7f1a4d70c10c98bc8443b755c78e499e55d`; PR27 is
`69e0be6545044b1e206721fe631e90893935f9ea`; PR28 is
`b47729bd79d7905559e756d9d23b42663f7b1370`. Basic text creation, saved report
readback, TXT export and deletion were exercised using each exact version against
all six schema prefixes (through 0015, then each of 0016–0020): 24 combinations.
This establishes that limited compatibility, not all provider/feature behavior.

## Interrupted application and recovery

1. **Before commit / confirmed transaction failure:** local SQLite and Workerd
   D1 tests show DDL and history rollback together, with earlier stages and source,
   report, FAILED_UNCERTAIN receipt and usage preserved. Obtain fresh real state
   before retry. A client error alone is not confirmation of remote rollback.
2. **Committed but acknowledgement lost:** read history and full schema first.
   If both exactly match the reviewed stage, skip it. If neither changed, a fresh
   review can permit that same stage. Mixed, absent or inconsistent evidence
   blocks. Do not resend 0017/0020 ALTER or mark them applied by hand.
3. **Partial/manual DDL:** wrong or partial 0016 triggers and earlier 0018 table
   shapes are explicitly reproduced. Neither blind replay nor `IF NOT EXISTS`
   proves equivalence. Preserve rows and prepare a separately reviewed repair.
4. **Stopping after a complete stage:** additive schema can remain installed with
   affected functionality disabled. Preserve original requests, usage and
   uncertainty. Never reset budgets, delete ledger rows or synthesize PROVEN_ZERO.
5. **Code rollback:** before runner data exists, basic old-code operations pass on
   additive schema. Once runner rows exist, PR26–28 DELETE leaves URL/manifest
   bodies behind (nine version/prefix cases reproduced); PR29 scrubs them. A
   rollback then needs compatible deletion/reconciliation or stopped writes.
   Similarly, do not send new idempotent audio submissions to pre-0017-era code
   and claim its duplicate-prevention guarantee still holds.
6. **Database restore:** no automatic Time Travel rollback. A restore can remove
   intervening receipts/usage and allow previously dispatched work to appear new.
   Pause writers, preserve post-bookmark accounting evidence, and reconcile it
   before any execution resumes. Local fixtures do not establish remote backup
   validity or restore safety.

## Verification and remaining operational access

`node --test tests/migration-import-buffer.test.mjs tests/full-coverage-migration-preflight.test.mjs
tests/full-coverage-migration-isolation.test.mjs
tests/migration-source-catalog.test.mjs tests/migration-sequence-sqlite.test.mjs
tests/migration-sequence-workerd.test.mjs` passes 19/19 with zero skips.
The actual local Workerd test injects a late UNIQUE failure after each file's
DDL and history INSERT and verifies atomic rollback. File-backed SQLite also
closes/reopens after simulated lost acknowledgements and verifies committed
schema/history and retained data. All input content is synthetic; no provider
requests, production D1 access, backups, deployments or credentials are used.

V2 adversarial fixtures reject all four truncated queues before/after, all
fourteen same-name physical SQL mutations, source commit/tree/hash substitutions,
extra/missing files and a post-import mutation. They also verify the two pinned
LF/CRLF representations while rejecting isolated-file byte changes during apply.
Both V3 import-buffer regressions fail on frozen V2 before the fix and pass on
V3; the fifteen other tests plus the two V2 catalog tests remain passing.

The standalone historical-code matrix is recorded in
`../video-migration-version-matrix.json` with its reproduction script outside
this checkout. Its 24 cases include nine deliberate unsafe-downgrade detections.

Still required: authorized real migration/history/SQL reads, in-flight writer
and queue observations, a valid private recovery bookmark, and independent review
of this delta before use. This local assessor does not authenticate operator
snapshots, grant access, approve a change window or prove an operational backup.
The previously rejected settings reads were not retried. No new user permission
was needed for this local work; production execution still depends on those
access/evidence conditions and the applicable existing authorization.
