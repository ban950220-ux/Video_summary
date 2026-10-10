# YouTube AI Analyzer v0.7 candidate

Owner-only Cloudflare Worker/D1 app. The current implementation and limitations are documented in [IMPLEMENTATION-v0.7.md](IMPLEMENTATION-v0.7.md). Paid API budget remains $0; real providers are disabled by default.

## Implemented paths

- Existing native YouTube captions through Supadata, with explicit asynchronous result lookup.
- Owned SRT/VTT/TXT imports and frame-aligned MP3 transcription up to 120 minutes through Groq, with progress and resume.
- Gemini Korean evidence-linked summaries, chapters, claims, numbers and source-based critical analysis.
- Original/clean transcript retention, protected report reopening, title/ID search, deletion and Markdown/TXT export.
- Owner JWT validation, same-origin writes, AES-GCM encrypted provider keys and conservative atomic free-use grants.

## Validation

`npm run check` and `npm test` run dependency-free local checks under Node 24. Current suite: 50 tests. HTTP provider responses are mocked; local persistence tests use real SQLite. This does **not** prove real-provider quality, hosted runtime resource limits or successful Cloudflare deployment.

`npm run build:dashboard` generates the single Worker bundle. The repository's `deploy/dashboard-worker.mjs` is the tested deployment candidate. Use it only in the existing protected holy-rice-b914 Worker, retaining its DB binding and Secrets. Do not deploy the unconfigured wrangler.toml template. The CI release gate remains blocked pending remote evidence.

Remote v0.7 acceptance and a verified summary for 2hUkTmwYm3A remain NOT_RUN. No unverified capability is marked PASS. The example's provided full MP3 was only locally sliced and inspected, not transcribed by a real API.

## Current limitations

No PDF, M4A/MP4 import, automatic YouTube media download, speaker diarization or external fact-checking. A processed time axis is not independent proof of full transcription. Model reference validation proves IDs exist, not semantic correctness. Provider remaining balances and billing-disabled account status are owner-attested and expire after one hour; they are not independently reconciled.

The production entry is src/site-worker.mjs; src/worker.mjs bearer-token entry exists for isolated tests only. Browser UI never receives provider keys and never stores them in localStorage. Existing v0.6 instructions remain historical; use the current implementation document above.
