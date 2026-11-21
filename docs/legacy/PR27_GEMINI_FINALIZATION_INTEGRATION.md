# PR27 + Gemini finalization integration review

This is a local review snapshot, not a pushed branch or deployment.

- Verified remote PR27 HEAD: `69e0be6545044b1e206721fe631e90893935f9ea`.
- Verified remote and local PR27 source tree: `53354cfdbd25150df678c9977ffe855328884a84`.
- PR27 parent/base: `2ac2a7f1a4d70c10c98bc8443b755c78e499e55d` (PR26).
- Local snapshot commit: `1dce98a1fe36db6877339df4003f3e03019cc296`.
  Direct Git network access was unavailable. This local commit is not the remote
  commit object; its exact file tree was checked against the GitHub Git API.
- Applied finalization-v2 patch SHA-256:
  `BEE1C10163EB764E7875D213269ED2E4E6BADD1A9CEAB60DD1DF6C4D41373CA7`.

The integration diff applies after PR27, not after finalization-v2. The original
PR27 working copy and fixed v2 patch remain unchanged. Three-way application had
no textual conflicts. Shared serializers retain native `mediaCoverage` and
Gemini `sourceAssessment` independently; neither processed chunks nor model PASS
changes partial/unverified source evidence into verified full audio.

Two integration changes accompany the fixed v2 implementation:

1. The library list returns a narrow `nativeTranscriptSummaryReady` boolean.
   PR27's native-caption action previously depended on `job.audit` absent from
   list responses. The UI consumes this flag; the existing server action still
   validates actual provenance/coverage and requires a separate summary approval.
2. Corrupt stored segment JSON, a non-array, or null/non-object entries cause
   `SOURCE_STORAGE_INVALID` on status/export/source consumers. A Gemini report
   detail read shows stale binding. Historical report bytes are not rewritten;
   corruption does not become a successful or empty transcript.

The new local Workerd D1/VM integration tests cover mixed native/Gemini reports,
GET/list/TXT quality labels, 0017 preserving prior report/audit bytes, absent-0017
admission failure, concurrent same-ID creation, missing-ID rejection, native
library action visibility and corrupt-source read errors. Existing suites cover
actual mocked Gemini quote/approval/two receipts/acceptance, native caption
acquisition and Groq global summary transitions. All model results are fixtures.

## Migration and build dependencies

Finalization adds no migration. It needs the existing 0015 Gemini ledger tables.
PR27's URL plus owned-audio idempotency needs 0017 `jobs.submission_hash`.
The inherited full-coverage path needs 0016 lock triggers; inspect their exact
SQL and the current operation state before any production application. This
snapshot does not include the separate proposed 0018 local runner/outbox work.
The dashboard bundle explicitly registers the new source-assessment helper
after its dependencies. No runtime flags, keys, approvals or deploy guards are
enabled or weakened by this integration.

## Before a real existing-transcript summary

1. Read the current owner job/source and Gemini ledger. Bind the exact stored
   transcript/audit/provenance; inspect settled/uncertain receipts and usage.
   Reconcile saved receipts without a new call. If two settled receipts and PASS
   already exist, explicit limited-source acceptance requires zero generations.
2. Confirm the actual active credential's project, billing mode and model access.
   Registration metadata and a different Console organization's Free plan are
   insufficient. Free execution needs verified Free/billing-disabled status and
   current remaining capacity; otherwise use a separately approved paid route.
3. If new generation is needed, obtain current source-bound quote consent for
   sending the transcript to Google/countTokens separately from paid execution
   approval. The code pins model `gemini-3.1-flash-lite`, max two generations,
   zero automatic retries, 120000 input and 8192 output tokens per call, and a
   calculated approval ceiling at most 170000 micro-USD. That is an app ceiling,
   not a current quote, provider billing limit or permission to spend. Do not
   reset consumed/uncertain calls or reuse expired approvals.
4. Review the integrated tree and CI before deployment. Read current Worker,
   settings, queue and D1 migration state; establish a single writer window and
   backup/rollback evidence. Deploy only with current target/asset/approval
   evidence and explicit job/feature/project gates. Then verify active version,
   source-bound report save/readback/TXT and retain every partial/unverified flag.

Production credential validity, quota, protected settings, current migration
state and actual AI quality were not verified by this local work. No provider
request, production D1 mutation, push, PR creation, merge or deployment ran.

## Native replay preservation correction

Independent integration review reproduced a cached `/native` result clearing an
accepted Gemini report on a URL-associated audio job. The initial integration
patch remains preserved as evidence; the corrected v2 integration patch replaces
it as a review candidate and still applies directly after PR27.

- `/native` rejects every non-URL source type before consulting its operation
  cache. Both native entry points reject an existing report or source before any
  provider request. Acquiring another transcript requires an explicit new job.
- Native result persistence compares the original owner, source type, URL,
  duration, status, raw report/audit values and update timestamp, requires the
  source slot still to be empty, and excludes deletion. It never clears a report.
- Successful caption persistence commits the job audit and source insert in one
  D1 batch transaction. The insert depends on `changes()=1` from the snapshot CAS;
  an insert failure rolls the batch back. A committed response with a lost ACK
  is preserved and a replay cannot overwrite the source.
- The older `/summary` action now rejects other saved summary kinds before its
  provider/cache path. Its existing extractive-input upgrade and same-kind cached
  return remain supported. Paid receipt revalidation and full-coverage save/
  recovery already require an empty report or return the existing report; their
  preservation is exercised in the new regression fixture. Existing audio-finish
  replay tests also retain the saved report. No general restore endpoint exists
  in the current worker; this review does not certify an external DB restore.

`native-report-preservation-workerd.test.mjs` exercises 40 mutations immediately
before final D1 persistence across cached available/missing/pending results and
mocked asynchronous polling. It also checks source-insert rollback, post-commit
ACK loss, concurrent 200/409, invalid/unknown duration, report-kind isolation and
unchanged polling credit accounting. The Gemini acceptance Workerd tests verify
that cached native replay preserves the actual accepted report and COMPLETE
ledger and that a later explicit reaccept still succeeds. Model responses and
polling responses are fixtures; real provider requests are zero.

Corrected integration validation: `npm test` 569 tests, 567 pass, 2 skip (FFmpeg
unavailable), 0 failures; `npm run check` and the offline deployment guard pass.
That v2 integration required independent re-review and remote CI.

## Late response deletion correction (v3)

Independent review then reproduced a completed DELETE followed by a late native
response writing private caption text back into `yta_operations.result_json`.
The shared `execute()` success and failure UPDATEs now use a single SQL CASE
whose predicate requires the owner job to exist and its deletion tombstone to be
absent. Otherwise the result body remains NULL. Operation identity, units,
success/uncertainty state and usage accounting remain available; DONE here means
the provider response arrived, never that a deleted job has a saved report.

Cache replay re-reads its result with the same owner/deletion predicate. Missing
or scrubbed cached content stops without a new provider request. A DELETE after
that read is still caught by the downstream source/report persistence guards.

The real local Workerd D1 fixture `live-late-delete-workerd.test.mjs` covers native
captions and the shared Gemini summary executor: 16 late success/failure cases
(completed DELETE, tombstone while the job exists, missing job without a marker,
and changed owner), 4 deletion-during-cache-read cases, and 4 reverse-order cases
where DELETE scrubs an already saved success/failure body. It checks preserved
usage/reservations, FAILED_UNCERTAIN metadata, and zero body resurrection. All 20
provider responses are mocks; no actual provider request is made. This correction
does not change schema, provider permissions, paid approval, or deletion scope.

V3 validation: full suite 570 tests, 568 pass, 2 skip (FFmpeg unavailable), 0
failures; targeted shared-executor/preservation suites 93 pass, 2 skip; dashboard
build, syntax checks and offline deployment guard pass. Independent re-review of
this v3 correction and remote CI remain outstanding.
