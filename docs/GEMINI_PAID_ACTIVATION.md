# Gemini two-pass paid activation: deployment binding connection

This delta changes deployment policy only. It creates no job, approval, provider
request, credential, Worker setting or D1 migration. Base: PR #36 HEAD
`82273accabc3891396c74326f258a047c6b042c3`, tree
`ce84683c108489473538a88f3a1a9652cbe60998`. Integration order is PR #35 (unused
quote renewal), PR #36 (separate source summary attempt), then this policy delta.
The original example is ineligible for unused renewal because prior paid and
uncertain history exists. Those records must remain unchanged.

## Three runtime flags

All three are dashboard `plain_text` bindings with the exact string `true`:

| Name | Existing execution requirement |
| --- | --- |
| `ENABLE_GEMINI_TWO_PASS_PAID` | Enables the bounded paid two-pass branch. |
| `GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED` | Requires separate paid execution acknowledgement. |
| `GEMINI_TWO_PASS_COST_BUFFER_APPROVED` | Requires the approved calculated cost buffer. |

The existing protected Build input `GROQ_DEPLOYMENT_EVIDENCE_JSON` may include
`geminiTwoPassPaidEnabled: true` (JSON boolean). No new Secret is introduced.
The optional key only permits and requires these three exact binding names,
types and values during preflight and postcheck. Without it the previous binding
set remains exact. Unknown/duplicate/missing bindings, wrong types/values and
`ALLOW_PAID_API=true` are blocked. The protected review's existing real timestamps
must remain current after remote reads; its validity is at most 24 hours.
This does not extend the per-job approval lifetime.

If Dashboard registration changes the source annotation, the normal lineage
check accepts only this exact reviewed three-binding addition relative to a
pinned prior Wrangler version: all other bindings must be byte-value equivalent
under canonical JSON, script ETags must match, complete runtime metadata must
match, and both versions must have exactly one Assets binding. Partial additions,
other changed settings, unknown additions and missing prior evidence still block
upload. Secret values are not exposed by this comparison; the job allowlist and
credential checks remain the application's responsibility.

These flags cannot appear in checked-in TOML, including indented, quoted, dotted,
inline-table or preview keys. `keep_vars=true` remains required. Existing Free
activation and the historical current-state replacement exception are unchanged.
The historical exception is not an alternative approval for this change.

## Exact job, source and budget binding

The three booleans do not themselves contain a job or budget. Existing runtime
guards require `ENABLE_GEMINI_TWO_PASS=true` and exact equality between the
request's job ID and `GEMINI_TWO_PASS_ALLOWED_JOB_ID`. The remote binding API can
verify the latter's name/type only; it cannot verify a hidden Secret's value.
The application checks the effective value before quote and generation.

Original example ID: `a69c6a73-6aa6-4ccb-a912-1fab0c35d6a9`. A new source-attempt
child must first be created through the explicit consent route, without provider
calls. Its returned UUID is the only intended new execution job ID. No child
exists as a result of this local work; inventing one or retaining the old job's
execution scope is not valid. The child retains the original source/audio
provenance, transcript quality and prior-cost/uncertainty disclosure.

The new D1 quote/approval binds the child ID, execution UUID, exact quote SHA-256,
source SHA-256, audit SHA-256, first request SHA-256, credential generation, model,
project billing mode, input/output caps and expiry. The source hash includes the
stored source snapshot, provenance and audio-file SHA; the old historical source
hash is not proof of the newly read source. Re-read and compare actual values.
Source/audit/credential/approval changes or deletion block execution at the final
D1 claim; flags, exact job and expiry are checked again after the last await.

Existing enforced bounds:

- Model `gemini-3.1-flash-lite`; maximum 2 generations; automatic retries 0.
- Input cap no greater than 120,000 counted tokens per call; output cap 8,192.
- Calculated total including the existing 100% buffer must be at most 170,000
  micro-USD ($0.17). Current maximum calculation is 169,152 micro-USD ($0.169152).
- Quote expires 30 minutes after fresh model/count evidence; approval must match
  that exact quote. A deployment review or old `PAID_APPROVED` label is insufficient.
- Actual metadata/countTokens evidence is still required. Local fixtures and
  UTF-8 byte counts are not actual token counts or proof of Free billing.
- Quote consent to send the necessary transcript to Google is separate from
  approval for generation. A successful count does not prove Free eligibility.

The price calculation is an application ceiling, not a provider invoice limit.
Fresh pricing/count evidence must fit the approved budget before generation.
An incomplete or uncertain response remains blocked; it does not authorize a
third call. Complete stored receipts may be recovered without provider calls.

## Safe operational order (not executed here)

1. Merge reviewed code in dependency order and deploy through the existing
   protected target/remote-state process. If the three paid bindings are absent,
   omit the new opt-in and keep generation disabled during this first code update.
   Do not enable paid execution against old code or the old example job.
2. Using the updated owner application, inspect the original ledgers and create
   one explicit independent source-attempt child. Check its source binding and
   prior-cost disclosure. No transcript/audio generation is repeated here.
3. Coordinate the exact returned child allowlist and paid flags through the
   approved settings process. Updating protected settings is a separate action;
   this patch does not perform or authorize it. Keep generation disabled until
   the allowlist points to that child and the reviewed code is active. Any later
   deployment preserving the three bindings requires a fresh matching opt-in.
4. Verify billing mode; obtain the consented fresh quote; stop if unavailable,
   expired, changed or over the approved ceiling. Approve the exact quote and run
   each of at most two phases once, with receipt/usage reconciliation before the
   next phase. Never replay the legacy uncertain requests.
5. Explicitly accept a validated two-pass result, then read the saved report and
   export TXT. Preserve `AUTO_CHECK_PASSED_HUMAN_UNREVIEWED`, transcript accuracy
   unverified and any partial/provenance limitations. Disable bounded execution
   after completion or uncertainty using the coordinated settings procedure.

No operational child, fresh source/quote hashes, effective allowlist value,
billing eligibility, final ledger review or new provider response was verified
by these offline tests. Those facts must not be filled with placeholders.
