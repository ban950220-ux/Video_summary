# Paid retry rollout readiness (offline review, 2026-10-13)

No production migration, configuration write, provider call, build, or deployment is authorized by this review. The complete transcript remains saved; no audio upload or transcription rerun is needed.

## Additive D1 migration 0011

Apply `migrations/0011_paid_summary_retry.sql` only after separate production approval. It creates exactly three new `yta_*` tables and one partial unique index; it does not alter existing jobs, source, first-trial, approval, reservation, receipt, or audio rows:

| Object | Purpose and invariant |
| --- | --- |
| `yta_paid_retry_quotes` | One active `ISSUED` quote per job, bound to prior approval/reservation, source/request/quote hashes and expiry. |
| `idx_paid_retry_issued_job` | Unique `job_id` only while quote state is `ISSUED`. |
| `yta_paid_retry_attempts` | At most one second attempt per job; quote ID unique; `max_calls=1`; `APPROVED`, `CANCELLED`, `RESERVED`, `RELEASED`, `UNCERTAIN`, or `SETTLED`. |
| `yta_paid_retry_receipts` | One bounded response receipt per attempt, with complete bytes/hash, model, finish reason and usage metadata. Job deletion scrubs response text/hash. |

A read-only schema verification after approved migration should inspect `sqlite_master` for these four names and use `PRAGMA table_info` and `PRAGMA index_list` on the three tables. Confirm pre-existing table/index definitions are unchanged. Do not run the migration from a Worker Build. Runtime route `paid-retry-status` requires all three tables before it serves a status.

## Runtime and deployment guard

The new second attempt uses the **ordinary** paid gate. `ENABLE_PAID_SUMMARY=true`, `PAID_SUMMARY_EXECUTION_APPROVED=true`, `PAID_MODEL_ACCESS_VERIFIED=true`, and `PAID_TAX_MAX_BPS_VERIFIED=true` must all be present as exact strings; `ALLOW_PAID_API=false` stays exact. Owner-only Cloudflare Access, the existing D1 binding, stored encrypted Gemini key, and the approved migration are also required. First-trial flags do not authorize a second attempt. Quote inspection alone does not send a provider request.

The tracked remote baseline currently expects `ENABLE_LIVE_FREE=true`, `ALLOW_PAID_API=false`, `SITE_DEPLOYED=true`, `ENABLE_PAID_SUMMARY=true`, `PAID_SUMMARY_EXECUTION_APPROVED=true`, `PAID_FIRST_GENERATION_TRIAL_ENABLED=true`, and `PAID_FIRST_TRIAL_USD_COST_REVIEWED=true`. It has **no** `PAID_MODEL_ACCESS_VERIFIED` or `PAID_TAX_MAX_BPS_VERIFIED` binding. The exact binding-set guard would reject simply adding them. Keep them unset until evidence is reviewed; any later gate activation requires a separately reviewed guard/baseline update and explicit configuration approval. Do not infer current live values solely from this tracked baseline.

The separate guard commit pins owner-supplied active version `f5bb4540-be89-44ff-b362-6719ad22a4ce` and source `7a2407bdc0fcf73245399f75917e8dc6b949a272`. It leaves `remoteSettingsReviewed`, Access, observability, bindings, DB UUID, and runtime values unchanged. A fresh GET-only preflight must independently confirm the actual active version, source annotation, metadata shape and all baseline fields before a future build. The offline guard tests do not constitute that readback.

## 98-minute prompt and validator

The paid request prompt now explicitly asks for exactly the five arrays and `conclusion`, real source evidence IDs for every item, numbers and units grounded in referenced text, and at least one `chapters` reference from each nonempty 10-minute window. The JSON schema has the same five arrays of `{text,evidenceIds}` and a conclusion string. `validatePaidFullReport` rejects missing/extra top-level keys, invalid IDs, unsupported numbers or direct quotes, and any uncovered 10-minute window. Offline fixture `tests/paid-summary-98m-contract.test.mjs` uses 1,226 synthetic segments over 1:38:12.864, tests all ten windows and these rejection cases. It does not assert that a real Gemini response will satisfy the contract or reproduce the private transcript.

## Evidence needed before ordinary paid gates

| Evidence | What is established now | Still required for a new run |
| --- | --- | --- |
| Model and key/project | An earlier single generation has observed usage and a Google cost display. This supports historical reachability and charge, not current access. | Verify the **current stored key generation and its project** against the Google AI Studio project/model listing, paid tier and account status. Confirm `gemini-3.1-flash-lite` remains available to that project and the intended text-only Standard request, and check current prepaid balance and auto-reload state. Only then consider `PAID_MODEL_ACCESS_VERIFIED=true`. No key copying is needed. |
| Published model price | [Google Standard pricing](https://ai.google.dev/gemini-api/docs/pricing) lists text input $0.25 and output including thinking $1.50 per million tokens for `gemini-3.1-flash-lite`. [Model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite) lists input limit 1,048,576 and output limit 65,536. The code's full-limit ceiling is $0.360448 before its 100% app buffer, or $0.720896 reserved for one call. | Recheck the published SKU and account pricing immediately before approval. The app reservation is not a provider billing cap. Usage metadata and the earlier displayed cost do not determine the next invoice. |
| Tax, fees, currency | [Google Cloud's South Korea VAT page](https://docs.cloud.google.com/billing/docs/resources/vat-overview#south_korea) states 10% VAT on usage. The prior ₩8,000 prepaid purchase displayed ₩7,273 credit plus ₩727 VAT. This does not establish whether VAT is applied again at usage, how the account invoices Gemini API usage, or the absence of other fees. [Google's currency policy](https://docs.cloud.google.com/billing/docs/resources/currency) says local non-USD conversion uses rates set monthly; the account's applied rate is not known here. | Review this **account's** usage line, tax/adjustment line and payment profile or provider billing explanation for the applicable tax/fee upper bound and currency. Keep `PAID_TAX_MAX_BPS_VERIFIED` unset while that upper bound remains unknown. Do not treat the 100% app buffer or the first cost display as tax proof. |

The first trial's observed Google cost display and token usage are historical evidence only. They do not authorize a second provider call or a second charge. No setting in this document is a request to enable a gate.
