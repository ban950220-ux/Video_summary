# Separate stored-transcript summary attempt

Base: PR #35 tree `07cc5017fa6c37bad29f1d0e9a613a023a78cd57` (remote commit `b241532b74f3de48afa86ad46a42cee327ae4482`). This delta does not reset or renew the historical example.

## Implemented contract

- Owner GET `/api/jobs/:originalId/source-summary-attempt` reads the stored audio transcript, audit and historical ledgers. It returns source/evidence hashes, quality limits, recorded paid reservation outcomes and uncertainty counts. It makes no provider request and writes nothing.
- Owner POST requires a new UUID, that exact evidence digest, and explicit acknowledgements: new summary, stored transcript reuse, prior costs and uncertainty, possible duplicate summary tokens, independent copy retention, no provider call.
- One permanent parent slot and one D1 transaction create a child job, source snapshot and origin registry. The complete original job/source/ledger sets and relevant table inventory are compared at insertion. Simultaneous different IDs cannot create multiple copies. Same-ID response loss reads back the stored copy. A deleted child cannot be recreated through this slot.
- The original raw text, segment IDs/timestamps, provenance and audio audit are retained verbatim; only `sourceSummaryOrigin` is added to the child audit. No new audio DONE records, transcription usage or provider approvals are invented. `PARTIAL_TRANSCRIPT` / `TRANSCRIPT_UNVERIFIED` are retained.
- The original remains independently deletable. The explicitly retained child copy survives original deletion; child DELETE removes its source/report and scrubs its registry body. This retention choice is disclosed before creation.
- Child source mutation and alternative provider routes are blocked. Gemini quote, count, dispatch and acceptance bind the exact origin registry and source snapshot in final SQL conditions. Initial quote transitions also bind the complete expected canonical attempt row; its final digest is retained in the quote. A partial quote-save acknowledgement cannot become generation approval.
- The existing exact `GEMINI_TWO_PASS_ALLOWED_JOB_ID` gate remains unchanged. Creating a child does **not** delegate the parent's execution permission. Quote consent, exact cost approval, the two-call cap, expiry, receipt accounting and no automatic generation retry remain in the existing engine.
- Report source origin, historical cost disclosure and quality limits survive stored report reads and TXT export. A synthetic test report is never substituted for a production result.

## Minimum schema

`schema.sql`, `0002_live.sql`, `0015_gemini_two_pass.sql`. Existing optional paid/free ledgers are read and preserved if present, including `yta_paid_first_trial`. This module neither needs nor applies 0016–0020, creates migration history, nor registers a schema baseline.

## Deliberate limits

- V1 has one child slot per original. It does not automatically renew a child quote or allocate a second child after failure, expiry or deletion. The existing unused-renewal guard rejects the child origin registry as prior activity.
- Active or recoverable response evidence blocks creation. Historical uncertain operations are preserved and disclosed, never marked unused or retried. The current production job still needs the implemented eligibility review against its actual complete D1 records; the observed summary status alone is insufficient.
- Exact source coverage is coverage of stored transcript IDs, not proof of audio accuracy, complete spoken content, human semantic review or external facts.
- Model output and count values in tests are synthetic. The private 1,226-segment fixture uses a historical saved transcript, not a fresh operational D1 snapshot. No actual AI outcome or present provider quota is proven.

## Operational steps still required

1. Independent review and exact candidate CI/deployment checks. No production deployment is part of this local patch.
2. Read the actual job evidence; obtain the explicit snapshot-retention/new-attempt consent, create the child once, verify readback before any retry.
3. Review and authorize changing the protected `GEMINI_TWO_PASS_ALLOWED_JOB_ID` to that exact child ID. No new credential is needed by this design. Existing original ledger scopes remain untouched.
4. Establish current Free project/key linkage and quota, or obtain bounded paid approval. The existing paid engine also requires `ENABLE_GEMINI_TWO_PASS_PAID`, `GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED`, and `GEMINI_TWO_PASS_COST_BUFFER_APPROVED`. Current remote binding policy does not enumerate those three names; enabling them requires a separately reviewed explicit activation-policy change. This delta does not add or bypass that policy.
5. Obtain full-transcript Google token-count consent; obtain the new exact quote; separately approve its total ceiling and maximum two generation calls. Existing legacy paid approval is not reused.
6. Execute each approved phase once, reconcile receipts, explicitly accept the source-based result with caveats, reopen and export TXT. Any uncertain dispatch stops rather than creating another attempt.

## Budget planning (no provider call)

Model: `gemini-3.1-flash-lite`. Existing code limits input to at most 120,000 tokens/call and output, including thoughts, to 8,192 tokens/call. Maximum two generation calls, zero automatic retries. Catalog maximum: 84,576 microUSD pre-tax estimate plus 84,576 microUSD buffer = **169,152 microUSD ($0.169152)** application approval ceiling. It is not a provider invoice guarantee.

Successful clean execution needs one metadata lookup, one quote count and two execution counts, then two generation calls. The actual input token count has not been measured; UTF-8 byte counts are not model tokens. Free quota/key-project binding remains unverified. Public model/pricing references: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite and https://ai.google.dev/gemini-api/docs/pricing .

## Local verification

- Full suite: 781 tests, 779 passed, 2 skipped, zero failed. Dashboard bundling, syntax/deployment-target check and diff whitespace check pass.
- Actual historical saved transcript: 1,226 segments and 10 windows pass the local Workerd D1 create/quote/approve/two-phase/accept/readback/TXT flow with synthetic model responses. Original files and historical rows remain unchanged. Real external calls and operational writes are zero.
- Independent core review: 8 scenarios passed, including canonical quote-row mutation, partial quote-save acknowledgement, atomic creation rollback, parent deletion, exact child allowlist and paid-first-trial history races.
- Independent final route review: removing the child's audit origin still blocks 22 alternative POST routes using registry evidence. Five ordinary Groq query counts remain unchanged; the two previously failing Groq budget regressions pass. No D1 budget was increased.
- Query counts depend on optional ledgers. The 1,226-segment fixture measured at most 30 statements for creation; this is an observation, not a universal upper bound or evidence of production success.
