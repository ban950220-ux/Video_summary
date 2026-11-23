# Manual summary: D1 binding adapter preparation

## Status and boundary

This is an unpublished offline implementation candidate. The earlier local
SQLite migration and rollback preparation remains unchanged. A synthetic D1
binding fixture exercises the new adapter; no production binding, credentials,
administrative endpoint, deployment command, or database read is supplied.

The current harness runs in Node and imports the separate local SQLite
coordination model. It is not a self-contained, deployable Worker module. The
D1 calls are binding-shaped protocol operations; a production integration still
needs an authenticated authority, persistent coordination, and binding setup.

`productionExecutionSupported: false` and `operationallyAuthorized: false` are
intentional. A successful rehearsal is not a Cloudflare execution receipt,
authenticated deployment observation, migration history entry, or permission to
resume application writes. The adapter is not imported by the application or its
deployment scripts.

## D1 rules used by the implementation

The [Workers binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
documents transactional `batch()` execution: a failed statement aborts or rolls
back the batch. This candidate uses that binding protocol. It does not infer
equivalent guarantees for REST request arrays, `exec()`, a directory-wide
Wrangler migration command, or a series of individual `run()` calls.

The adapter never sends `BEGIN`, `BEGIN IMMEDIATE`, `COMMIT`, `ROLLBACK`, or
`SAVEPOINT` to D1. Explicit SQLite transactions used inside test fixtures belong
to the local emulator and are not adapter SQL.

The same binding documentation defines `withSession("first-primary")`: only the
first query must use the primary. Later reads may use replicas while maintaining
sequential consistency. A session does not reserve a database snapshot across
several application calls or prevent another writer from committing. A bookmark
is an opaque consistency token, returned as a string or null, rather than a
deployment version, ETag, identity proof, write lock, or authorization.

The adapter therefore combines primary-started readback, transactional read
batches, exact identity binding, and a retained all-writer fence contract. It
does not treat a bookmark or a caller-provided `verified: true` as preservation
evidence. The operational fence still needs a separately reviewed installation
and authenticated observations before any production use.

For this rehearsal, a closed fixture constructor creates the binding around an
actual local SQLite database. A private registry associates that binding with
the database captured by the fence; arbitrary binding objects and a second
database with identical contents are rejected. This establishes a local fixture
association only. `authenticatedTransportVerified` and
`databaseIdentityVerified` remain false: the candidate cannot authenticate a
Cloudflare binding or accept one through a synthetic capability.

[D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
document the schema inspection surface used here: `sqlite_master`, `table_list`,
`table_xinfo`, `foreign_key_list`, `index_list`, and `index_xinfo`. Unsupported or
malformed inspection results block execution; a table-name existence check is
insufficient.

## Exact migration scope

Only `migrations/0021_manual_summary_imports.sql` is eligible. Its reviewed LF
SHA-256 is
`04de16a15c295e1d1c172dcc799dc15d293b8721b5db58f9dae0d94ed9f21e01`.
The independently pinned CRLF representation is checked separately. The
reviewed catalog contains fifteen files, but catalog membership does not
authorize execution of all fifteen. The adapter emits only the three reviewed
0021 `CREATE` statements.

The existing pending copy, earlier fourteen catalog entries, 0016 preflight,
runtime authentication, application routes, and deployment gates are unchanged.
0016 approval cannot satisfy this adapter's 0021 capability or source identity.

Before execution, the adapter requires an exact source, catalog, identity,
fresh before-snapshot, and an opaque capability issued by the offline operational
contract. A JSON clone or an independently invented success flag cannot replace
the capability. There is no production authority issuer in this candidate.

## Schema and preservation checks

Schema comparison includes complete table and index SQL, columns and hidden
columns, types, nullability, defaults, primary keys, CHECK and UNIQUE clauses,
foreign keys, index order/collation/expression/partial-index metadata, and table
options. Unexpected objects, partial tables, name collisions, and changed
definitions block the operation. The adapter does not repair or delete them.

Discovery prepares the exact table, column, index, and page queries. The final
schema metadata, every data page, complete catalog, and count checks are then
read together in one D1 binding batch. This avoids constructing a preservation
digest from different row generations across independent page requests.
Discovery drift blocks comparison; the retained fence covers the wider window.

Application data comparison preserves SQLite value types and original bytes.
INTEGER values are encoded in SQL as decimal text before JavaScript can lose
precision. TEXT and BLOB data use hexadecimal byte representation; finite REAL
values are compared without decimal truncation. Implicit row identifiers, or
explicit keys for WITHOUT ROWID tables, are included. Unsupported values,
inaccessible identity, incomplete results, and configured size limits fail
closed rather than produce a partial preservation claim.

Synthetic fixture transcripts, reports, imported summaries, request records,
provider state, usage, approvals, and migration history are read by the rehearsal
and fingerprinted in memory. No real user records are supplied. Raw rows, text,
provider values, and database error
messages are not returned as public diagnostics. This does not authorize reading
production records in a later run.

An exact existing 0021 schema permits a read-only confirmation; it does not
establish who created the schema or fabricate a migration history entry. No
`d1_migrations` record is inserted or marked successful. Any later history
registration needs its own exact, reviewed policy. Directory-wide migration
application remains outside this preparation.

## Commit, post-readback, and uncertainty

A SQL failure inside the one mutation batch has D1's documented batch rollback
semantics. A JavaScript check or a later readback failure occurs after that batch
may already have committed. It cannot roll back committed DDL. Such failures
retain a closed write fence and require inspection; they never trigger DROP,
restore, a synthetic rollback receipt, or an automatic write retry.

A lost response is an unknown commit outcome. The durable contract records the
attempt before dispatch so another process cannot silently start the same
mutation after a crash. Fresh primary-started, read-only reconciliation checks
schema and original data. Observing an exact schema is not by itself proof that
this attempt committed it. Unknown attribution and incomplete postchecks remain
explicit in the result.

[D1 retry guidance](https://developers.cloudflare.com/d1/best-practices/retry-queries/)
notes that the platform may automatically retry read-only requests. This adapter
does not add a write-retry loop. Its no-replay rule is stricter than general
application retry advice because this is a reviewed one-time migration scope.

## Limits and future operational work

The [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) apply to
each SQL statement inside a batch. Local result-size and row-count caps are
safety bounds, not evidence that the production database fits them. A limit
failure must be addressed with a separately reviewed bounded snapshot strategy;
it must not be resolved by omitting large tables or ignoring unmatched rows.

The current conservative rehearsal profile permits at most 100 tables, 500
schema objects, 10,000 rows per table, 50,000 total rows, 1,000 result pages,
1,900,000 encoded bytes per row, and 32,000,000 snapshot bytes. A row-size probe
precedes hexadecimal expansion. The adapter permits 45 batch calls over its
lifetime and reserves six remaining calls for the one mutation batch and a
worst-case five-call post-snapshot before dispatch. Callers may lower these
limits but cannot silently raise them. These are candidate bounds, not a
production capacity, price, or account-plan verification.

Before any real binding is used, the following remain necessary:

1. Exact publication scope approval and the existing independent review/CI gates.
2. Current, permitted external Builds command, root, branch, target, and guarded
   deployment evidence before main can change.
3. Formally permitted current metadata and access/preservation evidence; a denied
   metadata request cannot be retried or accessed through another route.
4. A separately approved operational authority and binding integration, with
   exact D1 identity and no new persistent credential created implicitly.
5. Verified closure and drain of every application and administrative writer,
   including other Worker versions and changes made outside the application.
6. Current complete schema/history evidence, compatible rollback target, bounded
   read costs, and an approved migration/history policy for this exact 0021 file.
7. Authorized real execution and post-readback; then separate application
   save/list/reopen acceptance. Rehearsal success satisfies none of those live
   observations by itself.

No provider call or paid approval is required for these offline tests. Future
database or service usage requires its own cost and authorization assessment.
