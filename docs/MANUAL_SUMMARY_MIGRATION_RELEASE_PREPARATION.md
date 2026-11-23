# Manual summary migration and release preparation

## Scope and status

This change is an unpublished local preparation candidate. It does not merge a
pull request, contact Cloudflare, deploy a Worker, change access controls, or
import a real summary. The SQLite executor and rollback rehearsal operate on
local test databases. Their receipts are local observations, not authenticated
production evidence or a permission grant.

The published import feature keeps its SQL under `migrations/pending/`. A PR
merge or Worker upload does not apply that SQL. Runtime checks for table presence
are not a substitute for complete schema verification.

## Explicit source activation candidate

The local candidate copies the exact reviewed pending SQL to
`migrations/0021_manual_summary_imports.sql` and extends
`scripts/migration-source-catalog.mjs` from fourteen files to fifteen. The pending
source remains unchanged for provenance and existing local tests.

- LF SHA256: `04de16a15c295e1d1c172dcc799dc15d293b8721b5db58f9dae0d94ed9f21e01`
- Exact CRLF SHA256: `c76eab87d0dcbf5ada0ed4597b1ab79b5ca3836f7f43d26bcc91d0b2e6621377`
- The original fourteen file hashes and their source provenance are preserved.
- `additionalSources` records the actual reviewed pending source path and its
  public source commit. It does not claim that the activated path existed in that
  earlier commit.
- The catalog binds exact file count, ordered names, and reviewed bytes. Missing,
  extra, substituted, or same-name modified sources fail validation.

Registering these source bytes does not authorize database execution. In
particular, `full-coverage-migration-preflight.mjs` remains limited to its original
0016 migration. It must reject an execution scope containing 0021. Do not run
`wrangler d1 migrations apply` against the whole directory to apply this change.

## Dedicated local 0021 execution and verification

`scripts/manual-summary-migration.mjs` provides the dedicated local SQLite
session and complete import-schema inspector. The executor accepts only the
reviewed 0021 source buffer and its isolated execution scope. It has no remote D1
client, credential reader, or production execution path.

Before changing a database, the schema must be either fully absent or exactly
equal to the expected schema. Two table names alone are insufficient. Partial
installation, conflicting object names, wrong column definitions, changed
constraints, unexpected indexes or triggers, and other definition mismatches
must be rejected. Existing objects are never repaired, dropped, or overwritten
automatically.

The expected schema is derived by executing the authenticated source bytes in a
separate in-memory SQLite database. Comparison covers stored DDL and SQLite
schema metadata rather than a loose list of table names. The executing buffer
must be the same buffer whose hash was checked; a later disk read must not replace
it.

The session obtains a write transaction, rechecks the captured schema and data
state, executes only 0021, checks the complete post-schema, and compares the
original records before committing. Existing schema and typed row fingerprints
include tables outside the import feature, including approval, reservation,
receipt, usage, provider-state, transcript, and parent-analysis records present
in the test database. TEXT/BLOB bytes, integer precision, real-number bits, and
implicit row identity are preserved. Unsupported layouts that hide every rowid
alias are rejected; a verified WITHOUT ROWID table uses its explicit keys. Raw
row values and summary text are not returned in the receipt.

Any mismatch or execution failure must roll back the transaction. A replay is
accepted only if the complete schema and preserved records still match; it must
not synthesize historical migration rows or provider receipts. An interrupted
acknowledgement is resolved through readback before deciding whether another
operation is appropriate.

## Rollback compatibility

Worker version rollback does not roll back D1. A legacy Worker that does not know
about the new import tables can delete a parent analysis without cleaning up its
imported personal text. Retaining the tables therefore requires a compatibility
plan as well as a data-preservation plan.

Before any later operational import:

1. Establish and independently verify a write fence covering import saves,
   cancellations, analysis deletion, relevant background work, and other writers.
2. Drain or reconcile in-flight and uncertain requests. A UI-disabled button or
   an empty request list is not proof that all writers are fenced. Persistent
   unfinished deletion markers with a remaining parent/import/request record
   still block the plan after a failed callback drains. Completed deletion
   tombstones remain preserved.
3. Bind the rollback candidate to an exact version/source, owner-access policy,
   D1 binding, and preserved configuration. Verify complete schema and data
   readback around the transition.
4. Require cleanup compatibility for imported content and request-ledger rows.
   A target lacking that behavior must not resume writes after imports exist.
5. Preserve the import tables and content. Do not use a table drop, blanket text
   deletion, migration-history fabrication, or a provider-status rewrite as a
   rollback step.

`scripts/manual-summary-rollback.mjs` and its local tests rehearse those
conditions. An in-process fence proves only the behavior of work admitted
through that local fence. It is not proof that an external Worker, Build, queue,
or other database writer is stopped. Operational enforcement remains a separate
required observation; a local receipt must never be treated as an operational
rollback authorization. See `MANUAL_SUMMARY_ROLLBACK_SAFETY.md` for the detailed
rehearsal contract and limitations.

## External Builds are a pre-merge condition

GitHub Actions and Cloudflare Builds are independent integrations. A GitHub CI
workflow without a deployment step does not prove that a main push cannot deploy
through Cloudflare. Before merging a change that may trigger an external Build,
use formally permitted current evidence to establish either that the relevant
automatic deployment trigger is disabled, or that its actual repository, branch,
root directory, deploy command, target, and preservation guards are valid.

The intended guarded command documented in the repository is not evidence of the
command currently configured in the service. Old UI observations cannot be
relabelled as current configuration proof. Missing evidence blocks the merge as
well as a separate manual deployment.

## Operational evidence still required

The local candidate does not replace the existing deployment gates. An
operational run still needs permitted current source/version/ETag, complete
asset and binding preservation evidence, owner-only positive and negative access
tests, paid-execution blocking, current schema and migration-history observation,
an isolated 0021 execution plan, a fresh rollback target, and before/after
preservation evidence for existing records.

Previously refused metadata access must be resolved through its formal approval
boundary. Do not switch tools, authentication, or execution environments to work
around a refusal. A bounded read-only approval is not approval for repeated
deployment reads. Raw metadata, credentials, private text, and personal records
must not be copied into the repository or CI artifacts.

When no prior operational import has been observed, preserve that state rather
than writing a fabricated or synthetic operational sample. Local synthetic tests
prove local behavior only. Code preparation, publication, merge, active
deployment, schema application, and real-data save/list/reopen must each be
reported separately.
