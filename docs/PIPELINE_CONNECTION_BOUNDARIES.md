# URL pipeline connections and remaining boundaries

This document describes the local application contract. Synthetic tests replace
provider responses and use temporary SQLite. They do not establish provider
availability, real transcription accuracy, semantic quality, production Access,
remote D1 success, deployment readiness, or operating-site completion.

## Existing captions

The owner-authenticated route is URL input → native-caption acquisition → stored
timed source → explicitly selected `approved-four-part-v1` plan and generation →
validated report storage → owner list, detail and TXT/Markdown export.

Native captions retain `TRANSCRIPT_UNVERIFIED` or `PARTIAL_TRANSCRIPT`. Timestamp
coverage is measured against the declared duration and is not a measurement of
all spoken content. The duration is still supplied by the user; the application
does not fetch and independently verify video duration from a link.

An asynchronous native response is stored as `NATIVE_PENDING`. A user action may
poll that same job. Polling is a provider request but does not make a second app
credit reservation in the existing accounting path. This is not a new assertion
about the provider account's actual invoice or remaining allowance. A successful
poll makes the saved transcript available for a separate summary action.

The approved format is connected to the generic Gemini path. It is not silently
substituted into paid single-summary, Gemini two-pass or Groq generation. Existing
staged checkpoints and format contracts remain isolated. A stored older report
remains readable and is not counted as a newly generated approved-format report.

## No captions

`NO_CAPTIONS → NEED_UPLOAD` is a stopped acquisition boundary. No automatic audio
acquisition worker or ASR task is created by this transition. No source or report
is invented. Summary planning and generation remain blocked without source.

A user-supplied MP3 and an automatically obtained URL audio source are distinct
paths. The owned-MP3 workflow's explicit approvals, chunk resume and stop-before-
summary boundary stay intact. The existence of local-runner code or saved ASR
artifacts does not prove that a URL/no-caption job is connected to them.

A state indicating that no caption result is stored is intentionally neutral
about whether an earlier provider request was dispatched. The operation ledger
is authoritative for in-flight, failed-uncertain and cached outcomes. Discovery
controls are invitations to inspect that job, not authorization to replay an
uncertain request. Manual/imported summary storage is not automatic completion.

## Stable URL submission and recovery

New clients may supply a UUID `submissionId` on URL job creation. The server binds
the ID to canonical video identity, source type, title and declared duration,
using the existing `jobs.submission_hash` column. The existing primary key is the
atomic replay slot; no new migration is introduced by this change.

Repeated matching requests reuse the same saved job. Changed inputs, owner
collisions, deletion tombstones and orphaned prior operation/source/usage records
cannot turn that ID into a fresh request. Unknown writes require same-ID
readback. A client must retain the ID before its POST and must not create a new
job to work around a lost acknowledgement. Legacy clients that omit the ID keep
their legacy creation behavior; they do not gain idempotency automatically.

An explicit URL resume validates the stored ID, type, canonical URL, duration
and title. A stored report can be opened without provider calls or a fresh quota
grant. A stored transcript skips native acquisition. Pending/no-caption states
stop for explicit review; no new audio worker is scheduled.

SQL `NULL` and JSON text `"null"` are both supported empty-report representations.
Null-safe exact snapshot comparisons preserve the original source, audit,
report, owner, deletion, format, credential, capacity and quota checks. Existing
report bytes are not rewritten to normalize their null representation.

## Completion and failure boundaries

For the approved-format browser flow, a report kind alone is insufficient to
claim completion. A successful result must belong to the requested job and
profile, report persistence, and carry the validated structured report plus a
source-bound `MATCHED` reading projection. A cached legacy mismatch is readable
but does not complete a request for newly generated approved-format output.

Navigation, changing the selected job, cancellation and repeated clicks must
invalidate pending UI work before a provider POST. A late plan response cannot
reactivate an obsolete action. The UI also preserves existing server uncertainty
guards rather than treating an error as permission to retry with a new ID.

The owner-only summary response review is read-only. Partial or complete stored
provider text may be inspected without changing operation state, receipts or
usage. Complete stored text can be a raw intermediate stage or malformed output;
it is not asserted to be a validated final report. Metadata is projected from
the operation row and allowed response fields, not arbitrary stored properties.

## Local evidence required

Meaningful integration tests cross the actual owner-authenticated route with
invented signed identities and fully mocked provider transport. They cover
immediate and pending native captions, no captions, partial coverage, SQL-null
reports, stable submission replay, discarded acknowledgements, uncertain
dispatch, changed source, invalid output, owner isolation and durable database
reopen. They assert that readback does not add provider requests or usage.

These tests do not exercise a real video, provider account, production database,
new saved-ASR task, or a manually imported summary as a substitute. Real source
acquisition, real four-part output quality, production save/list/reopen and
deployment preservation evidence remain separate requirements. Existing output
caps and no-automatic-paid-fallback policy are unchanged.
