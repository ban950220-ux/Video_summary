# One new quote for the legacy uncertain job

Local implementation only. No production grant has been installed and no Google
request has been made by this change.

## Scope and approval

- Job: `a69c6a73-6aa6-4ccb-a912-1fab0c35d6a9`, owner: `owner`.
- Human approval reference: `Sentinel_48e6e35a627081918873a47c108571dd`.
- This accepts remaining uncertainty about earlier requests and authorizes one
  new metadata lookup and one transcript-bearing CountTokens request. It does
  not approve generation, paid quote costs, retries, or another job.
- Existing Access authentication, owner checks and allowed-job configuration
  continue to apply. The old paid-summary quote route stays blocked.

## Official CountTokens billing evidence

The official billing FAQ currently says `GetTokens` is not billed and does not
count against inference quota:
https://ai.google.dev/gemini-api/docs/billing#is-gettokens-billed

The REST endpoint used here is `models.countTokens`:
https://ai.google.dev/api/tokens#method:-models.counttokens

Google's Firebase documentation explicitly states that calling `countTokens`
(the Count Tokens API) has no charge:
https://firebase.google.com/docs/ai-logic/count-tokens#pricing_for_these_options

Together with the direct Gemini REST reference and token guide, this supports
the no-charge CountTokens assertion for the authorized one-quote recovery:
https://ai.google.dev/gemini-api/docs/tokens

This is a cross-document assessment, not a claim that `GetTokens` was formally
renamed. The Firebase page's 3000 RPM quota is not evidence of this direct API
project's quota. The project remains paid; generation still requires a separate
exact-quote cost approval. Mock billing evidence in tests is not production
evidence. Actual quote execution belongs to the separately designated UI
operator, who must avoid any concurrent quote request from this release task.

## Server-managed grant

`GEMINI_LEGACY_QUOTE_RECOVERY_JSON` is a server-managed JSON manifest, not a
browser-supplied authorization. The default with no manifest remains blocked.
It contains these required fields:

| Field | Value |
| --- | --- |
| kind | `LEGACY_UNCERTAIN_NEW_QUOTE_ONCE_V1` |
| approvalId | Human approval reference above |
| ownerId / jobId / model | Exact owner, job and current `TWO_PASS_MODEL` |
| projectMode | `PAID_APPROVED` (the project is paid; generation is unapproved) |
| maxMetadataCalls / maxCountCalls | `1` / `1` |
| maxGenerationCalls / maxRetries | `0` / `0` |
| residualUncertaintyAccepted | `true` |
| confirmFullTranscriptSentToGoogleForTokenCount | `true` |
| countTokensNoChargeVerified / countTokensMaxMicroUsd | `true` / `0`, only with verified billing evidence |
| countTokensBillingEvidence | Exact official source and the endpoint-specific conclusion |
| approvedAt / expiresAt | Integer epoch milliseconds; future expiry at most 30 minutes after grant recording |
| sourceSha256 | SHA256 of JSON `[sourceSnapshot(source), provenance, audioFileSha256]` |
| auditSha256 | SHA256 of JSON `promptAudit(job)` including duration |
| firstRequestSha256 | SHA256 of JSON `summaryRequest(source, promptAudit(job))` |
| credentialGeneration | `capacityIdentity` of the exact stored credential snapshot |
| legacyEvidence / legacyEvidenceSha256 | Evidence object and SHA256 of its exact JSON serialization |

Capture all bindings through authorized read-only access immediately before
preparing the grant. Preserve evidence that the observed 2026-10-14
15:36:48.469 UTC POST `paid-summary-quote` returned 409 on Worker
`02b69af3-2f39-4cb6-8ae3-9caf9fbbf456`, source
`aedf2339b752a98182a2db43232ff4699a150e8e`; that route has no Google calls.
Also preserve the 15:30–15:50 UTC log search scope, sampling limitation, and
the observed zero quote-operation and two-pass-job rows. These observations
do not prove that every historical request was unsent. Do not erase historical
approval, usage, operation or legacy incident records.

## Reservation and failure behavior

The first successful quote reservation stores the complete grant and historical
evidence in the existing `yta_operations` row at
`<jobId>:gemini-two-pass-quote`. No migration is needed. Its unique job key
prevents another reservation even with a renewed manifest, cancelled quote or
expired quote. Existing reservations are never reset for this legacy job.

SQL checks the current owner, transcript, audit, duration, credential snapshot,
deletion state and absence of generation calls before each external stage.
Flags, grant and expiry are checked after the last awaited SQL operation.
`MODEL_LOOKUP` and `COUNT_SENT` persist before network dispatch. A lost dispatch
commit acknowledgment stops the request; a new POST cannot dispatch again.
Reservation ACK loss may read back the same exact reservation before continuing.
No automatic request retry occurs. Failure or timeout consumes the attempt.

Before a quote row exists, the existing authenticated `gemini-two-pass-cancel`
route can mark the attempt `RECOVERY_CANCELLED` without deleting evidence.
It prevents later stages; a request already reserved/sent cannot be recalled.
The status route remains read-only. A successfully saved quote is `QUOTED`,
never automatically `APPROVED`. Old paid approvals do not authorize it.

## Local verification

`tests/gemini-two-pass.test.mjs` uses SQLite and injected providers for binding
changes, concurrent POSTs, cancellation, expiry, commit/ACK failures, model/count
failure, quote persistence failure and old-generation-approval isolation.
`tests/gemini-two-pass-workerd.test.mjs` exercises the new SQL with local Workerd
D1. All credentials, transcript text and billing evidence in these fixtures are
offline mocks. Production generation and CountTokens are not test dependencies.
