# Paid full-summary review contract (offline only)

The paid path is disabled unless `ENABLE_PAID_SUMMARY`,
`PAID_SUMMARY_EXECUTION_APPROVED`, `PAID_MODEL_ACCESS_VERIFIED`, and
`PAID_TAX_MAX_BPS_VERIFIED` are all `true`. `ALLOW_PAID_API` stays `false`
so the existing Groq Free path remains usable.
For the first generation only, `PAID_FIRST_GENERATION_TRIAL_ENABLED` replaces
the prior-generation-success flag. Its separate
`PAID_FIRST_TRIAL_USD_COST_REVIEWED` means only that this one Standard text
request's official model-token ceiling plus the observed 10% prepaid VAT
arithmetic is within the user's approved USD app reservation. It does not
mean an invoice, KRW conversion, or every future fee is verified. The other
operator and budget gates remain mandatory. No generation success is asserted
before the first call. All new flags are absent from production vars.
This review branch changes none of those production settings and does not apply
`0008_paid_summary_budget.sql` to production. The 98-minute private transcript
and the user's provider account were not read or called for this work.
`npm run deploy:production` invokes only `wrangler deploy`; it does not apply
the D1 migration. Production currently lacks the three paid-summary tables,
so their application and schema readback require a separate authorized step.

## Official catalog checked 2026-10-12

- `gemini-3.1-flash-lite` is listed as **stable**, supports structured output,
  and has limits of 1,048,576 input and 65,536 output tokens:
  <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite>.
- Standard paid text input is $0.25 per million tokens; output **including
  thinking** is $1.50 per million tokens:
  <https://ai.google.dev/gemini-api/docs/pricing>.
- Google's general `max_output_tokens` description says the cap includes thought
  tokens. The app requests 8,192, but reserves the model's full 65,536-token
  output limit until this model-specific billing bound is independently verified:
  <https://ai.google.dev/gemini-api/docs/thinking>.
- JSON Schema objects, arrays, required fields, and `additionalProperties`
  are documented as supported; output is still checked locally:
  <https://ai.google.dev/gemini-api/docs/structured-output>.

These documents establish a **code candidate**, not that this owner's project
can use the model or has paid balance. The response and UI say those facts are
`UNVERIFIED`/`UNKNOWN`. No `countTokens`, model, billing, or provider API call
was made to check them.

## Contract and bounds

The server builds one full-transcript request, including timed segment IDs,
source audit and the JSON schema. It measures the exact serialized request in
UTF-8 bytes. Twice those bytes plus 8,192 is an **offline request-size
admission check**, not a certified token count or monetary approval ceiling.
The app refuses an oversized request. It requests `maxOutputTokens=8192`,
but the reservation retains the official model limits of **1,048,576 input
and 65,536 output tokens** until a narrower billing bound is independently
verified. The adapter verifies the serialized body's size, SHA-256 and
configured output cap against the server-issued, hashed quote before the
final no-send D1 guard and fetch. A user amount below the full one-call
reservation is rejected at approval, so it cannot become executable.

The owner-facing range is an **offline cost scenario**, not an invoice forecast:
input tokens are illustrated at request bytes / 4 through bytes / 2, and
output plus thinking at 2,048 through 8,192 tokens. The range uses catalog
text prices before tax; Korean tokenization and actual output can fall outside
it. The server displays the separate maximum approval and atomic reservation
from the official model limits. One call and zero
automatic retries remain fixed. The additional **100% app budget buffer** is
for unknown tax and other billing differences; it is not a claim that the
applicable tax rate is 100%, or a verified tax quote. Actual token count,
provider invoice, tax, balance and ETA remain `UNKNOWN`. The optional
provider `countTokens` request could give a model token count, but it needs
authorized account API access and has not been called. Its price/billing
treatment for this account has not been verified; do not assume it is free.
An operator must verify the applicable tax upper bound before any execution.
Ordinary paid execution also requires prior model-generation evidence; the
one-time trial below handles the first generation separately.

## First generation trial (offline contract)

The owner has separately approved one Gemini 3.1 Flash-Lite full-transcript
attempt up to the app's $0.720896 reservation, with zero automatic retries,
no fallback, and use of existing prepaid credit only. The owner confirmed the
site's stored Gemini key belongs to the project whose UI showed an ₩8,000
prepaid balance, auto-reload off, and this model in the list. The separate
2026-10-11 Cloud Billing prepay transaction displayed ₩8,000 paid as
₩7,273 prepaid credit plus ₩727 VAT. This is **account transaction evidence**
of VAT on that top-up, not evidence of how this request's usage is taxed or
of a current balance readback. The owner must confirm the quote's current key
generation belongs to that project at app approval. No key or token value is
stored in the evidence record. `models.get/list` was not called.

The [official Models metadata endpoint](https://ai.google.dev/api/models)
can report model limits and `supportedGenerationMethods`. It does not prove
this key's project binding, paid balance, quota at dispatch, or a successful
`generateContent`. Metadata GET is useful as an optional additional
preflight check, not a necessary prerequisite to the first approved
generation. It requires separate permission to use the saved key; its
account-specific billing treatment has not been established, so this
contract does not send it or claim it is free.

The distinct `FIRST_GENERATION_UNTESTED` approval displays and persists the
owner-reported facts, official price, scoped USD cost review, metadata
`NOT_REQUESTED`, generation `UNTESTED`, and actual invoice and KRW amount
`UNVERIFIED`. Migration 0009 adds a
single global trial row. It binds the exact job, source SHA-256, serialized
request SHA-256, quote SHA-256, model, key generation, expiry, **one** call,
and **720896 microUSD**. Approval first claims the singleton in
`PENDING_APPROVAL`, preventing a concurrent second trial approval; only a
matching saved budget approval advances it to `APPROVED`. A failed approval
leaves a non-executable pending row for explicit reconciliation. The final
guard consumes the approved row with a conditional D1 update that also
rechecks the current owner, job, source, key, deletion marker, approval and
reservation. It checks approval and trial expiry again when that write returns,
before the only fetch. It cannot be reissued or retried. A lost or
uncertain provider result leaves it consumed; readback must establish the
outcome. This migration is not applied to production.

The text-model token ceiling yields $0.360448 before tax. The [general South
Korean Cloud Billing rule](https://docs.cloud.google.com/billing/docs/resources/vat-overview#south_korea)
states 10% VAT; if it applies to precisely that taxable amount, it adds
$0.0360448, for $0.3964928 in model fees plus VAT. The observed top-up VAT
supports the account's VAT treatment for purchasing prepaid credit, but does
not establish a second VAT charge on usage or rule out every account-specific
fee. No new prepaid purchase or card charge is part of the trial. A card or
foreign-transaction fee on a new purchase has no intended trigger here;
unexpected provider usage adjustments or a separate account-specific charge
remain unverified. [KRW Cloud Billing conversion](https://docs.cloud.google.com/billing/docs/resources/currency)
depends on account currency and the applicable monthly exchange rate. The
$0.720896 USD app buffer exceeds the model-plus-10%-VAT arithmetic by
$0.3244032. This establishes the narrow one-request USD cost review; proving
that every unknown future fee is absent is not required for that review. The
app amount is not a provider-enforced invoice cap or a guaranteed KRW amount.
No new purchase or top-up is in scope. The separate trial review flag remains
unset in production; ordinary execution still uses its own
`PAID_TAX_MAX_BPS_VERIFIED` gate.

The browser sends a server-issued quote ID, user maximum microUSD, call count,
expiry, and explicit confirmation. It cannot submit a price or model. The
server rechecks its catalog and stored quote, owner job, full source and audit
projection, request hash, encrypted key generation, approval and reservation
at the final D1 admission before fetch. The reservation takes the full quoted
per-call maximum in one SQLite statement. A duplicated approval for the same
job and a duplicate call index are rejected. Cancellation and expiry block new
dispatches. A proved pre-dispatch failure releases a reservation; an unknown
provider result keeps it. A response with valid usage records a token-cost
estimate separately from the unknown provider invoice.

Only a single validated full-video report is saved as
`GEMINI_PAID_FULL_EVIDENCE_LINKED`. The JSON shape, evidence IDs, grounded
numbers and quotes, and time-window coverage are checked before the atomic
job save. The separate raw checkpoint bundle never satisfies this contract.

## Review evidence and remaining gates

Local SQLite, local Workerd D1 and mocked provider responses exercise quote
issuance, approval, key/source/audit/cancel/expiry changes, concurrent calls,
uncertain accounting, final save, fresh readback, and TXT export. These tests
do not establish account availability, real model output quality, actual
provider invoice, production migration safety, Cloudflare baseline approval,
or the requested real-video acceptance. Those remain separate rollout and
user-cost approval gates.
