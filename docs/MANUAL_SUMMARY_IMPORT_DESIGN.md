# Imported summaries: isolated storage and review

## Purpose and delivery boundary

An owner can attach a completed plain-text summary to an existing analysis, save
it independently, and reopen it later. The imported content is labelled
**기존 전사 기반 가져온 요약**. This is a separate product feature from automatic
source acquisition, transcription, merging, provider summarization and saving.
An import never establishes that the automatic pipeline completed.

This document contains implementation requirements and the distinction between
runtime verification and the offline contract checker. It contains no real
summary, transcript, analysis identifier, user filename, Library identifier,
production URL, provider receipt, account usage or failure history. All public
fixtures use invented identities, metadata and text.

The local runtime is developed separately from the offline contract checker.
The API and schema contract below describes that implementation; verification
results must be reported from the actual local test run. Publishing, applying a
production migration, production database writes, provider calls and deployment
are separate actions. Neither this design nor passing a local test authorizes
them.

## Preservation invariants

An imported summary is a separate attachment, not a provider report. The import
path must not write to any of these existing fields or records:

- `jobs.report_json`, `jobs.status`, `jobs.audit_json` or `jobs.updated_at`;
- saved transcript raw bytes, segment text, timestamps or source provenance;
- audio chunks, provider operations or their success/failure classification;
- approval, reservation, receipt, payment or usage records;
- automatic completion, audio-verification or external-fact-check flags.

Keeping the original `updated_at` unchanged also preserves compare-and-swap
snapshots used by other processing paths. New attachment timestamps belong to
the attachment, not the parent analysis.

The import path must work when the analysis has no provider report and when a
report already exists. In both cases the original remains unchanged. A later
import is an additional immutable attachment; it does not silently replace an
earlier attachment. No automatic AI request is a prerequisite or consequence.

## Identity and provenance

The existing signed owner authentication remains authoritative. A browser cannot
choose the database owner by submitting an owner field. Every source read,
attachment read, request-state read and append must match the authenticated
owner and the requested parent analysis. Mutation requests also retain the
existing same-origin checks.

Requests for another owner's analysis return a fixed denial without its title,
source, text, hash, attachment count or other content. An absent or deleting
parent is ineligible. Parent identity and deletion guards must be checked inside
the final database mutation as well as during initial validation.

The display provenance is always **기존 전사 기반 가져온 요약**. Machine-readable
provenance records that the content was imported. It must not use a provider's
report kind, pretend a provider call took place, or fabricate a provider receipt.
The following are separate facts:

| Fact | What an import can establish |
| --- | --- |
| Current source identity | The server computed a digest from the stored source and matched it at append time. |
| Exact summary content | The server decoded valid UTF-8 and verified the submitted byte length and digest. |
| Authoring basis | The owner reviewed the source relationship; this is an explicit assertion, not independent semantic proof. |
| Original audio accuracy | Not established by importing a summary. |
| External factual accuracy | Not established by importing a summary. |
| Provider execution | No new provider execution occurs on this path. |
| Automatic pipeline completion | Unchanged. |

A filename, video identifier, cue count, chapter count or duration is insufficient
to establish that a summary was written from the current stored transcript.
A checksum binds exact content, not semantic accuracy or authorship. The UI must
make the owner review the source relationship before submission, and the stored
provenance must retain the limitation of that review.

## Exact source and content binding

Read the current owner-scoped analysis and its full saved source. The source
digest includes the analysis identity, source identity/provenance, declared
duration, raw transcript and all segment text and times. The final append must
compare the exact source snapshot again atomically. A changed transcript, source
provenance, parent identity, duration or deletion state invalidates a pending
submission even if segment counts still match.

The request binds the source digest, summary digest, byte length and provenance.
Unknown provider/receipt/completion fields must be rejected rather than accepted
as authority. A provenance change cannot relabel an existing identical import.
No source hash can be copied from a different hash domain without an explicit
conversion and verification contract.

The offline helper in `scripts/manual-summary-import-contract.mjs` uses the
`MANUAL_SUMMARY_SOURCE_SNAPSHOT_V1` digest domain. It accepts primitive minified
JSON text and rejects executable JavaScript inputs, duplicate/noncanonical JSON,
prototype keys, invalid Unicode and excess limits. It checks supplied claims; it
does not authenticate them, open a database, or implement runtime authorization.
The runtime uses a separate `MANUAL_SUMMARY_RUNTIME_SOURCE_V1` domain. It hashes
the UTF-8 bytes of `JSON.stringify` applied to this ordered array: domain,
server owner, parent ID, video ID, source URL, source type, duration seconds, raw
source text, the exact stored `segments_json` string, source provenance and
source `updated_at`. The segment JSON is not reparsed and reserialized for this
digest, so a change to its stored representation also invalidates the snapshot.
Neither runtime nor offline hashes can stand in for the other.

### UTF-8 content

The summary limit is measured in UTF-8 bytes, not JavaScript string length.
The offline contract limit is 1,000,000 bytes. A runtime limit, if smaller, must
be enforced consistently by the server and UI and reported in the source view.

Strict decoding rejects malformed UTF-8, empty/whitespace-only text, binary NUL
and forbidden controls. Valid UTF-8 BOM, CRLF and trailing newline bytes must
remain stable so that stored content, readback and TXT export have the same
digest. Content that looks like HTML or JavaScript is rendered as literal text.
There is no HTML execution, Markdown HTML injection or external resource load.
A user filename is unnecessary for identity and is not stored as a local path.

## Runtime API contract

All routes are under the existing owner-authenticated site API. They use the
owner-scoped analysis identifier in the path; that identifier is never taken
from an arbitrary owner field in the body.

| Method | Route relative to `/api/jobs/:id` | Purpose |
| --- | --- | --- |
| `GET` | `/imported-summaries/source` | Read current source digest, provenance, segment count, duration and byte limit. |
| `POST` | `/imported-summaries` | Verify exact content/source basis and atomically append or deduplicate an attachment. |
| `GET` | `/imported-summaries` | List the parent's imported attachments. |
| `GET` | `/imported-summaries/:importId` | Reopen one stored attachment. |
| `GET` | `/imported-summaries/:importId/export` | Export the stored plain-text bytes. |
| `GET` | `/imported-summary-requests/:requestId` | Reconcile an interrupted or delayed save through persisted request state. |
| `POST` | `/imported-summary-requests/:requestId/cancel` | Order cancellation against the same request identity. |

The save body contains only `requestId`, `sourceSha256`, `artifactSha256`,
`artifactBase64`, `provenance` and `basis`. Runtime provenance is the fixed
`EXISTING_TRANSCRIPT_IMPORTED` value. The basis record contains
`method: OWNER_SOURCE_RECONCILIATION`, the same source and artifact digests, and
`ownerConfirmed: true`. This stores an explicit owner assertion without claiming
independent audio, semantic, provider or automatic-pipeline verification.

The server computes the summary byte length and digest from strict base64/UTF-8
input. It enforces a 1,000,000-byte limit and matches both submitted digests to
the source and artifact actually accepted. Client-side validation provides
feedback, but is not a substitute for server checks.

`migrations/pending/0021_manual_summary_imports.sql` introduces `yta_summary_imports`
and `yta_summary_import_requests` as separate attachment and request-state
storage. The attachment has an immutable revision plus unique owner/parent/
source/content binding. The request ledger has a unique owner/parent/request
identity and only `COMMITTED` or `CANCELLED` terminal states. It must be applied explicitly to a temporary/local
database for verification. Runtime requests do not run DDL, upgrade a schema,
change bindings or apply a production migration. A missing schema is a fixed
unavailable state, not permission to bypass the new storage boundary.

The pending SQL is deliberately outside the top-level migration catalog already
approved for deployment. Local tests apply this exact candidate explicitly.
Promotion to the operational migration sequence needs its own source review,
preservation checks and catalog update; the existing catalog, deployment gates
and their approved source history remain unchanged by this feature.

The current source reader accepts stored transcripts with ordered segment IDs
and valid timestamps. Untimed plain-text source records are not eligible for
this import route. A source hash establishes the exact stored source snapshot,
not that its timing or content was independently verified against the audio.

## Append and request-state semantics

Two identities are needed: an immutable content identity and a request identity.
A database uniqueness constraint, not a preceding JavaScript check alone,
prevents duplicates. All request claims and content writes must commit as one
transaction or leave no partial attachment.

| Situation | Required result |
| --- | --- |
| First valid submission | Append one separate attachment and record the request result. |
| Same request and identical body | Return the original saved result; do not append again. |
| Same request and different body | Fixed request conflict; preserve the first result. |
| New request, same parent/source/content/provenance | Reuse the one immutable content attachment. |
| Same content with conflicting provenance | Reject the relabelling. |
| Different valid content | Append a new immutable attachment; preserve earlier versions. |
| Current source differs from submitted basis | Reject before writing imported content. |
| Database operation rolls back | No attachment or successful request remains. |
| Commit succeeds but acknowledgement is lost | Read the original request result; do not automatically submit again. |
| Owner or deletion state changes before append | Reject atomically and leave original data intact. |

Cancellation is ordered against the same request identity. If cancellation wins
before the append, later repeated submit attempts cannot create an attachment
for that cancelled request. If the append already committed, cancellation must
report that the summary is saved; it cannot claim that saved content was undone.
The UI must not treat `AbortController.abort()` as proof that the server did not
commit. A network interruption is an unknown result until a read-only request
lookup or attachment lookup resolves it.

Repeated button clicks share one in-flight request. A new request must not be
created merely because a response was delayed. Closing a panel, navigating away
or cancelling a local draft must not cause a delayed response to overwrite a
different analysis view. Recovery controls must perform reads before any new
explicit submission.

## Site display and export

The analysis list and detail view show imported summaries in a distinct section
with the imported provenance label. The absence of an automatic provider report
does not hide a saved imported summary. Conversely, an imported attachment does
not mark an automatic report or transcript verification complete.

Reopening an analysis after a page reload reads the saved attachment from the
server. The rendered text and any TXT export must correspond to the persisted
bytes and digest. Reopening must not require the original upload file, repeat a
provider call, regenerate the summary or rewrite the parent analysis.

The existing explicit owner analysis-delete action also removes that analysis's
separate imported attachments and request ledger after writing its deletion
tombstone. The tombstone blocks late import commits. Importing, cancelling a
draft or reading content never triggers analysis deletion. Deletion cleanup is
verified only with synthetic local data; no production deletion is part of this
feature-development work.

The UI needs explicit loading, ready, submitting, outcome-unknown, saved,
cancelled and conflict states. Save is disabled while the selected file or source
is unresolved. A pending or cancelled draft never displays a provider success.
The owner must be able to see whether a cancellation prevented saving or arrived
after a successful commit.

## Private source handling and public code boundary

Real user material belongs outside the public Git tree. This includes completed
summaries, source transcripts, actual analysis identifiers, local filenames and
paths, operation or failure histories, usage/payment records and links that tie
those records together. Public test data is generated from invented examples.

A parent task that already holds a completed summary can supply it through an
owner-authenticated browser file selection or a private in-memory input to a
local test harness. Do not ask the user to upload an already available source
again. Do not embed the text in source code, tests, shell command arguments,
request logs, screenshots committed to Git, documentation or generated bundles.
Only a verified private file path or an in-memory byte buffer should cross the
private handoff. Hash and source-basis checks still apply; possession of text is
not proof that it matches the current stored source.

Previously published historical documents are excluded from the current patch
rather than copied into new documentation. Excluding them does not claim to
remove previously published content from Git history. History rewriting and
repository-level removal are separate work and are not part of this change.

## Offline contract verification

The offline checker always reports all of these limitations, including when
supplied fixture structure is valid:

- `productionExecutionSupported: false`;
- `provenanceAuthenticated: false` and `permissionVerified: false`;
- `importReady: false` and `automaticPipelineCompleted: false`;
- zero provider calls, count-token calls and database writes.

Its authored-basis review supports a supplied author manifest or an explicit
owner reconciliation record. Missing basis remains blocked. Even a match is
reported as `MATCHES_SUPPLIED_HASH_CLAIMS_ONLY` with unauthenticated evidence.
The helper cannot upgrade a real attachment or satisfy production release gates.

Local runtime database tests must independently demonstrate persistent append,
readback, owner isolation, UTF-8 bounds, hash/provenance conflicts, source and
owner races, deletion guards, rollback, lost acknowledgement, cancellation and
repeated clicks. Before/after snapshots of original analysis, source, provider
and accounting rows demonstrate non-destructive behavior. Passing these tests
is local feature evidence; deployment and a real owner-site verification remain
separate acceptance gates.

## Local verification scope

The local access suite uses generated synthetic signing keys and a temporary
SQLite database. It exercises the existing signed owner JWT and same-origin
gate before database access, then saves, closes/reopens the database, lists,
reopens and exports synthetic UTF-8 content with BOM and CRLF intact. It also
checks duplicate handling, other-owner denial, unavailable schema and exact
preservation of original analysis/source/provider/usage rows. These tests make
no external request and do not use production credentials or records.

Runtime D1 tests and UI controller tests separately cover atomic writes and
request/cancellation races. The offline contract suites remain separate because
passing their supplied-claim checks does not establish actual persistence or
authentication. Report actual test totals from the completed run rather than
reusing an older count or a file-level test-runner success as individual-test
evidence.
