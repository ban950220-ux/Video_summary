# Live audio capacity and fallback gate

This branch adds a separate, additive `migrations/0003_observed_capacity.sql`. Apply it only as part of the reviewed rollout. The branch has no live provider evidence and does not imply that the 98-minute job is complete.

## Dispatch requirements

- The owner must confirm a free-only account with billing and automatic recharge disabled, then enter **current account/project-wide remaining capacity** from the provider console for the exact model. This is a manual copy of provider evidence, not an independently authenticated quota API response. Missing values, stale observations (over 60 seconds), model mismatch, and reported activity outside this Worker block dispatch.
- Gemini 2.5 Flash audio and summary share one atomic reservation for requests per minute, input tokens per minute, and requests per day. For audio, input is bounded at 32 tokens per second plus the maximum configured output and prompt allowance, then a 25% margin. The app grant remains a separate limit. Google's [audio documentation](https://ai.google.dev/gemini-api/docs/audio) lists 32 audio tokens per second and a 20 MB inline request cap. Its [rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits) describes per-project RPM, input TPM and RPD, with daily reset at Pacific midnight. The inline request here is limited to 8 MB of MP3 and less than 19 MB after JSON encoding.
- Groq Whisper uses account-wide remaining requests per minute, audio seconds per hour and day, plus the existing app-only rolling cap. Its next chunk reservation includes the planned overlap, rounding, a 25% margin and 60 seconds of metadata headroom. These estimates are conservative app forecasts, not provider billing facts.
- The app writes a durable `yta_wait` reason and reset time when observed capacity is insufficient. A fresh console observation and renewed free-only app grant are required to resume; reaching a reset timestamp alone never starts a call. A provider `429` remains uncertain until the owner checks the exact failed operation ID in official provider logs and confirms that no output was produced. Unknown failures never switch providers automatically.
- A chunk claim is atomic across Groq and Gemini. `DONE` chunks are returned from D1 without another provider request. Mixed-provider results retain per-chunk provider/model and operation history; final TXT, source segments, audit, and cleanup verify all planned chunks and the original file hash. No audio bytes are stored in D1.

## Owner workflow before a future live run

1. Review and apply migration 0003, then independently verify schema and owner-only Access. Keep `ALLOW_PAID_API=false` and existing secrets unchanged.
2. Review Cloudflare runtime metadata and the new branch, run read-only preflight, and deploy only after the separate rollout review. A passed local test is not a production result.
3. On the owner PC, select the same MP3 and resume the existing job ID. Choose Groq or the separately approved Gemini fallback for pending chunks; completed chunks stay untouched. For Gemini, confirm the free API's data processing conditions in the UI.
4. Immediately before a request, copy exact remaining capacity and reset times for every applicable dimension from the official provider console. If the console does not display a reliable remaining figure, pause. Confirm the app grant separately. Recheck after 60 seconds and after any outside use.
5. For a Groq or Gemini `429`, inspect that operation's official request log, confirm rejection and no output, then submit its exact ID. On any timeout or ambiguous result, stop for manual review.
6. After all chunks finish, verify stored source segments, TXT export, summary, login/reopen, file SHA-256 and D1 readback. Only then use the separate temporary-result cleanup action. Keep PC and Library originals.

The tests use local SQLite and mocked provider responses. They cover stale and insufficient observations, every configured limit dimension, an external-use invalidation during key lookup, same-chunk concurrency, exact 429 recovery, mixed-provider TXT preservation, and cleanup. They do not establish provider quota semantics or the quality/completeness of an actual 98-minute transcript.
