# YouTube AI Analyzer v0.7 candidate

Owner-only Cloudflare Worker/D1 app. The current implementation and limitations are documented in [IMPLEMENTATION-v0.7.md](IMPLEMENTATION-v0.7.md). Paid API budget remains $0; real providers are disabled by default.

## Implemented paths

- Existing native YouTube captions through Supadata, with explicit asynchronous result lookup.
- Owned SRT/VTT/TXT imports and frame-aligned MP3 transcription up to 120 minutes through Groq, with an owner-approved Gemini 2.5 Flash fallback for pending chunks, progress and resume. The fallback requires additive migration 0003 and a fresh provider-console capacity observation.
- Gemini Korean evidence-linked summaries, chapters, claims, numbers and source-based critical analysis.
- Original/clean transcript retention, protected report reopening, title/ID search, deletion and Markdown/TXT export.
- Owner JWT validation, same-origin writes, AES-GCM encrypted provider keys and conservative atomic free-use grants.

## Validation

`npm run check` and `npm test` run local checks under Node 24. HTTP provider responses are mocked; local persistence tests use real SQLite. This does **not** prove real-provider quality, hosted runtime resource limits or successful Cloudflare deployment.

`npm run build:dashboard` generates the single Worker bundle used by local tests.
The Wrangler configuration now targets the existing protected `holy-rice-b914`
Worker and its existing D1 database. See [the Git Build handoff](docs/production-git-build.md)
for the guarded production command and required Cloudflare settings. This branch
does not deploy. The CI release gate remains blocked pending remote evidence.

For 2hUkTmwYm3A, the existing production job has completed 20/20 real transcription chunks. Its 1,226 timed segments and combined TXT were saved to D1 and read back. The first Groq summary call returned a schema-invalid response and remains `FAILED_UNCERTAIN`; the final summary and end-to-end login/reopen/export acceptance are pending. Continue from the preserved D1 source rather than repeating MP3 upload or transcription. See [full-video acceptance](docs/example-2hUkTmwYm3A-acceptance.md).

## Current limitations

No PDF, M4A/MP4 import, automatic YouTube media download, speaker diarization or external fact-checking. A processed time axis is not independent proof of full transcription. Model reference validation proves IDs exist, not semantic correctness. App grants and billing-disabled status are owner-attested. Groq/Gemini dispatch also requires manually copied provider-console remaining capacity for the exact model, valid for at most 60 seconds; those observations are not independently authenticated by an API. The fallback has local mocked tests only and has not been deployed or used on the example video.

The production entry is src/site-worker.mjs; src/worker.mjs bearer-token entry exists for isolated tests only. Browser UI never receives provider keys and never stores them in localStorage. Existing v0.6 instructions remain historical; use the current implementation document above.
