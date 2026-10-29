# Manual summary: operational write fence and rollback contract

## Scope

This candidate implements an offline, durable state-machine contract. Synthetic
local stores exercise competing controllers, restart recovery, stale handles,
unknown acknowledgements, and rollback compatibility. It does not install a
production fence, change authentication, disable Builds, pause a real queue, or
modify application D1 bindings.

The Node-hosted contract uses a separate temporary SQLite control database. Its
closed D1 fixture factory implements binding-shaped batches with local SQLite
transactions; those transaction-control statements never leave that fixture.
It is not a deployable production coordinator or a D1 administration endpoint.

Every result remains explicitly offline and operationally unauthorized. No
public HTTP maintenance route, production evidence issuer, automatic write
resume, or operational rollback command is included.

## Why the fence covers more than HTTP writes

A browser maintenance screen or a JavaScript process mutex cannot exclude
another isolate, a previous Worker version, a queued continuation, a local
runner, a database administrator, or an external build. An operational fence
must be enforced at every writer and must survive controller failure.

The contract's inventory has to cover at least these surfaces:

| Surface | Required exclusion or drain |
| --- | --- |
| HTTP application actions | Job creation, source changes, import, cancel, delete, settings and credential-event writes |
| Read routes with side effects | Schema initialization, lazy repair, status polling, and reconciliation that can write |
| Provider continuations | Dispatch, reservations, receipts, usage, completion, retries, and recovery writes already in flight |
| Background execution | Scheduled events, queues, `waitUntil`, delivery retries, and local-runner/outbox acknowledgement |
| Other application versions | All traffic splits, old deployments, service bindings, preview workers, and shared database clients |
| Build and release automation | Git-triggered builds, manual builds, deployment jobs, and rollback changes during the window |
| Direct database administration | Dashboard, REST, Wrangler, migrations, consoles, restores, imports, and other credential holders |

This is a review inventory, not a claim that every listed surface is enabled in
the current service. An unknown or unverified surface blocks the window. A
configuration document or an old screenshot cannot prove current exclusion.

Existing owner authentication and CSRF checks remain required. A new fence would
add coordination; it would not replace either protection or grant an operator
access to private records.

## Durable coordination and capabilities

The model uses a persisted revision and monotonically advancing epoch. Admission,
closure, drain, mutation claim, and result recording use compare-and-swap state
transitions. An older controller cannot overwrite a newer state or acquire a
second migration claim. The synthetic store is isolated from application data.

Closure denies new admissions before draining already admitted work. A failed
callback is not sufficient evidence that its database write did not commit.
Unknown acknowledgements, outstanding continuations, and unfinished deletion
tombstones must be resolved through a separate observation path. Lease expiry,
clock advancement, process restart, and a failed postcheck never reopen writes.

`captureDrainedSnapshot()` is available only after every writer checkpoint and
all admissions have drained. Its opaque receipt binds the precise persisted
revision, epoch, and control database. `sealWindow()` rejects a pre-drain or
stale revision even when both observations have the same timestamp, and rereads
the actual local database to reject changes since capture.

After an uncertain migration and process restart, the persisted attempt may
issue a new read-only capability. That capability can obtain readback while
the review window is still fresh. It cannot create a new before-snapshot for
writing, finish the old attempt as successful, or dispatch another mutation.
Expiry keeps the window closed and requires fresh, separately established
evidence; it never extends itself or converts an unknown attempt into failure.

Only the actual state transition can issue the opaque in-process capability used
by the D1 adapter. Serialized copies and caller-supplied assertions cannot act
as that capability. The capability is bound to the epoch, exact source, version,
artifact, D1 identity, preserved configuration, owner policy, operation, and
review window. The implementation provides synthetic rehearsal authority only;
none of these local objects authenticate a real Cloudflare observation.

The production equivalent must have an authenticated, durable authority and
enforcement mechanism. A check performed once before an external D1 call is not
an atomic fence against an independent direct writer. Such writers require
verified exclusion for the whole window or a separately reviewed mechanism
that checks the fencing epoch in the same write transaction. No such
installation is authorized by this candidate.

## Rollback contract

Worker code rollback does not revert D1. Imported summary text and its request
records survive a Worker version change unless an explicitly authorized,
compatible application path handles them.

If import or request records exist, a rollback target must preserve owner-only
access and the `OWNER_TOMBSTONE_IMPORT_CLEANUP_V1` deletion behavior. A legacy
target without that behavior is rejected. A target must also match the reviewed
exact source, artifact, version, database, and preserved settings; a short
version prefix or a familiar branch name is insufficient.

No rollback plan deletes imported summaries, rewrites original transcripts,
changes provider success state, alters usage/approval records, or drops the new
tables. The compatible target is verified before dispatch, the write fence
remains closed during the change, and exact target/schema/data readback is
required afterward. Any unresolved deletion or uncertain mutation blocks the
transition.

Rollback target and data postchecks must be captured after plan issuance. A
private causal sequence enforces this even if all timestamps are identical;
previous target or data receipts cannot be renamed as postchecks. The local
database is also reread when preparing and verifying the rollback. These local
observations remain synthetic and do not authenticate an active Worker.

A database restore is a different, destructive operation. Cloudflare's
[Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/)
states that restore overwrites the database in place. A restore is not a
substitute for preserving later user records, and this preparation exposes no
restore operation or authorization.

## Terminal states and operational evidence

Successful offline checks leave writes closed. A production write-resume
operation would require separate, explicit authority plus fresh verification of
the exact active version, complete DDL, original records, owner-only access,
cleanup compatibility, resolved acknowledgements, and all writer integrations.
There is intentionally no automatic transition back to open in this scope.

External Builds can act on a main push independently of GitHub Actions. If
Builds is enabled but current root/build/deploy commands or preservation gates
are unknown, the pre-merge gate remains unsatisfied. The absence of a GitHub CI
deploy step is not evidence that merge has no operational effect.

Operational evidence must be obtained through an allowed path, remain tied to
the exact current version and review window, and expose only permitted
non-sensitive projections. Synthetic observations, old-version adapters,
offline exact-version proposals, or a refused metadata request accessed through
another tool cannot fill that gap.
