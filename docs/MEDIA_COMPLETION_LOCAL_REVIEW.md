# Media completion fixes and cloud reproduction

## Problem and resulting behavior

A completed final audio chunk can contain only transcript text already retained from the intentional overlap. The merger previously removed that duplicate and then classified the chunk as missing, so progress could reach 100% while finalization returned `AUDIO_INCOMPLETE`. The merger now accounts for valid overlap duplicates separately. Empty chunks, invalid-only chunks, and invalid segments still fail the existing completion checks. The change does not certify speech accuracy.

The Gemini two-pass UI previously allowed delayed status responses to replace a pending request view. A lost phase-1 acknowledgment could also be incorrectly cleared by the already-settled phase-0 receipt. The UI now tracks the active request and status response order, and ties uncertainty to its specific phase. Both stale successful responses and stale failed responses are ignored; a delayed failure can no longer erase a newer completed report view. Generation remains a separate action for each phase. Server-side reservation, source, cost, authorization, and idempotency controls are unchanged.

## Scope

The implementation starts from main `6c3f309c30f270d696fecc581cd928532c767499` (tree `d5ac6ab65696e06484809794867610f6658fa97a`). Product changes are limited to `src/audio.mjs` and `web/site/app.js`. The two added test files contain synthetic fixtures. No private audio, private transcript, generated report, credentials, deployment bindings, or production database contents are included in this change.

## Verified cloud reproduction

On 2026-10-26, the application patch was applied to the verified baseline and executed on Linux with Node 24.22.1.

- Five focused test files: **44 individual cases passed, 0 failed, 0 skipped** (including the additional stale-rejection regression).
- Optional private SRT integration path: **5 individual cases passed, 0 failed, 0 skipped**. The source contained 1,226 segments across 10 windows. SQLite save, reopen, and TXT export passed.
- Existing MP3 frame planning and preparation: 20 chunks, 245,537 frames, zero uncovered frames. Original MP3 and SRT hashes were unchanged.
- The added stale-rejection regression fails against the previous behavior and passes with the fix. Syntax checks, dashboard build, and diff whitespace checks pass.
- Every model response and token-count response in these tests was a fixture. Real provider calls and test network attempts were zero. The saved source remained `TRANSCRIPT_UNVERIFIED`.

The original bundled runner printed PASS while its child-process logs contained `spawnSync EPERM`. That summary was not accepted as the test receipt. The commands were run directly, and the individual TAP totals were independently captured using `--test-isolation=none`. Initial logs were retained with the private verification evidence.

```sh
node --test --test-isolation=none --test-reporter=tap \
  tests/media-completion-local.test.mjs \
  tests/gemini-progress-race.test.mjs \
  tests/audio-runner.test.mjs \
  tests/two-pass-windows.test.mjs \
  tests/gemini-two-pass-ui.test.mjs
```

For the optional private-input test, set `LOCAL_REVIEW_SRT` to an existing local SRT, `LOCAL_REVIEW_AUDIO_SHA` to the checked audio hash, and `LOCAL_REVIEW_OUTPUT` to a private evidence directory, then run `tests/media-completion-local.test.mjs`. The default test uses synthetic text. The optional `MOCK-ONLY-report.txt` includes source text and must remain private; it is not a real AI summary.

## Operational acceptance remains separate

Cloud reproduction verifies the application logic and local persistence. It does not verify Cloudflare authentication, the deployed Worker version, real AI generation, operational D1 writes, or production readback. A complete operational result requires authenticated source and deployment checks, a currently authorized provider execution, and final report save, reopen, and export. This change does not deploy or alter production settings.
