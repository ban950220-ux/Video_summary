# Explicit unused Gemini quote renewal

Base: remote main `b009d0cc09097815457ef31966786ca332757414`, tree
`58118eac93d2f19b74d30e6ee97a3fc90ec41b02`. This is a local change, not an
operational approval, migration, provider run or deployment.

## Owner flow

1. `GET /api/jobs/<id>/gemini-two-pass-renewal` returns eligibility and an
   evidence digest. It sends no provider request.
2. `POST` to that endpoint with a fresh UUID `requestId`, the returned
   `evidenceSha256`, `confirmArchiveUnusedQuote:true`, and
   `confirmNoProviderCall:true` archives the old quote/attempt and records a
   five-minute renewal approval. Repeating the same approval ID returns the
   same grant. It does not send the transcript or approve generation.
3. A separate `POST /gemini-two-pass-quote` supplies `renewalApprovalId`, a
   new UUID `quoteRequestId`, the unchanged `projectMode`, and
   `confirmFullTranscriptSentToGoogleForTokenCount:true`. Free mode additionally
   needs its existing billing-disabled attestation and server flags. This
   permits at most one metadata request and one countTokens request. These
   requests are never labelled free just because generation has not started.
4. The new quote is `QUOTED`, with a new execution ID and incremented revision.
   Generation still requires the existing separate exact-quote cost approval.
   Maximum two generations, no automatic retry, existing price/cap guards and
   partial/unverified final report labels are unchanged.

The UI presents these actions separately, including the Google transcript
transfer consent. Existing direct renewal POSTs without a renewal approval are
rejected. The initial-quote and historical special-grant routes are preserved.

## Admission and preservation

Only a valid expired `QUOTED`/`APPROVED` quote or unused `CANCELLED` quote with
a matching completed `QUOTE_SAVED` attempt qualifies. A missing attempt is not
proof of non-use. Source, audit, model, credential generation and exact request
must still match. Any two-pass phase row, including RESERVED, blocks renewal.
First/review results, errors, unknown/unfinished operations, summary usage,
paid approval/reservation/receipt/trial history also block it. Completed audio
operations and their recognized transcription usage may remain, unchanged;
they are not evidence of summary generation.

The known legacy job `a69c6a73-6aa6-4ccb-a912-1fab0c35d6a9` is explicitly
ineligible (`TWO_PASS_RENEWAL_LEGACY_UNCERTAIN`). Its historical uncertainty
cannot be cleared merely because current two-pass call rows are empty. This
patch does not claim that the operational example is unused or unlock it.
The owner browser observations at 2026-10-23 05:34 UTC show QUOTED,
QUOTE_SAVED, expiry 2026-10-16 00:30:12 UTC, and no current two-pass call rows.
They do not establish absence of historical provider activity; the legacy
block remains. PAID_APPROVED in that expired quote is not new paid consent.

The immutable application archive resides in `yta_operations` under provider
`gemini-two-pass-quote-renewal`: original quote row and canonical attempt,
original request IDs, quote hash, old approval state/expiry, evidence hash,
new approval ID/expiry, and consumed quote-request ID. Source and encrypted
credential bytes are compared in memory/SQL, never copied into that archive.
All existing usage and generation rows are retained. This is not a mechanism
to erase a consumed generation count.

## Concurrency and uncertain outcomes

Exact ordered row-set SQL guards bind current source/job/credential, old quote,
the complete other-operation and usage sets, optional paid-table presence and
their records. An atomic D1 batch consumes the approval and replaces only the
canonical quote attempt. A SQL assertion rolls back either write if the other
cannot occur. Metadata and token count each have a final guarded transition,
followed by a clock/feature-flag check after the last await. The final quote and
`QUOTE_SAVED` transition also commit together.

The evolving canonical attempt and renewal approval each bind all eight
operation columns (ID, job, provider, units, state, creation time, error, exact
result JSON). Each transition supplies only its own expected state/result
changes. Reservation no longer clears error_code. Idempotent approval and
approval ACK recovery recheck the canonical snapshot. A concurrent change is
retained and stops that request, including during final quote storage.

Before-commit failures leave the old approval/quote usable only through an
explicit request. A lost reservation ACK, lost count response or persistent DB
failure stops; no automatic provider retry occurs. Saved-quote ACK loss is
resolved by reading status. Quote preparation errors can remain conservatively
blocked even if no network request actually started; this patch does not invent
proof to reopen them. External direct DB modification outside the application
write contracts is not solved by an application archive.

## Local evidence and limits

`tests/gemini-quote-renewal-workerd.test.mjs` uses actual local Workerd D1 and
synthetic provider responses: archive preservation, duplicate requests, all
phase states, historical usage/uncertainty, last-write source/key/audit/expiry/
flag races, before/after-commit ACK loss and count uncertainty. UI tests require
three distinct decisions: renewal approval, transcript count consent, and
generation approval. No operational network call is required by these tests.

A separate private local fixture uses the existing 1,226-segment transcript:
expired unused quote -> renewal -> two synthetic model outputs -> acceptance
-> D1 report readback -> TXT. It preserves TRANSCRIPT_UNVERIFIED and
AUTO_CHECK_PASSED_HUMAN_UNREVIEWED. Synthetic token count 300 is not a tokenizer
measurement or an operational quote. Source/job file hashes are rechecked.

Query measurements are fixture-specific: the minimal 1,226-segment flow used
at most 32 D1 queries in one request. With optional paid ledgers and completed
audio usage present, the measured review/approval/renewal counts are 26/28/38.
These are observations, not a universal 32-query upper bound. Each measurement
uses synthetic model/count responses, never a real provider call.

The v2 regression suite injects late canonical errors, units, job/provider
ownership and creation-time changes at approval, reservation, metadata,
count dispatch, count receipt and final save. It also mutates the consumed
approval, checks the idempotent approval read race, and retains all original
quote/source bytes. Re-running reviewer reproduction cases as the author is
not independent re-review; that verdict must come from a separate reviewer.

Only schema.sql, 0002_live and 0015_gemini_two_pass are required for this flow;
0016-0020 and baseline registration are not prerequisites. Optional historical
paid ledgers are inspected when present. Operational Access authentication,
current job eligibility, current provider billing/limits, fresh deployment
evidence and separate paid approval remain unverified. No new runtime flags,
keys, protected inputs or operations are enabled by this patch.
