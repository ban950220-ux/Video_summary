# Paid full-summary review contract (offline only)

The paid path is disabled unless `ENABLE_PAID_SUMMARY`,
`PAID_SUMMARY_EXECUTION_APPROVED`, `PAID_MODEL_ACCESS_VERIFIED`, and
`PAID_TAX_MAX_BPS_VERIFIED` are all `true`. `ALLOW_PAID_API` stays `false`
so the existing Groq Free path remains usable.
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
- Google's `max_output_tokens` description says the cap includes thought
  tokens. The app requests 8,192 output tokens and conservatively reserves
  against the model's full 65,536-token output limit:
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
source audit and the JSON schema. It refuses a request if its UTF-8 body plus
8,192 bytes of margin exceeds the model input limit. The charge ceiling still
reserves the **entire model input limit** and **entire output limit**, including
thinking. One call, zero automatic retries, the catalog token prices, and a
0–100% tax allowance yield a conservative app reservation of $0.720896.
This is an app authorization ceiling, not a verified Google invoice or tax
quote. An operator must verify account model access and the applicable tax
upper bound before enabling execution.

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
