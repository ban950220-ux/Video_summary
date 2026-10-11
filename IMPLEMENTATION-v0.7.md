# v0.7 implemented candidate — remote acceptance incomplete

Repository changes apply only to YouTube AI Analyzer. Existing other projects are untouched.

Implemented: native-only Supadata captions with explicit polling; owner-uploaded frame-aligned MP3 chunk transcription using Groq; evidence-linked Korean Gemini JSON reports; source/clean transcript retention; Markdown/TXT export; encrypted site-managed keys; history search/reopen/delete; same-origin binary upload protection; atomic conservative app quota reservation; duplicate call blocking; uncertain calls are never automatically refunded or retried.

Supported upload: SRT/VTT/TXT and MP3, <=120 minutes. PDF, M4A, MP4, speaker diarization and external fact-checking are not implemented in this candidate. No automatic YouTube media download. A processed MP3 is not certified as a complete or verbatim transcript. Long pauses/missing transcript are flagged for listening review. Evidence validation checks referenced source IDs exist, not that a generated claim accurately follows the reference. Review actual model outputs before acceptance.

Free policy: ALLOW_PAID_API=false, ENABLE_LIVE_FREE defaults disabled. An owner confirms a billing-disabled/free account and current remaining allowance in the site settings. This is an expiring owner attestation, not provider-side billing verification. Paid billing and auto-recharge must remain disabled in provider consoles. Grants cannot be reset while active; changed keys require re-attestation. Ambiguous attempts consume reserved upper bounds. No claim of exact provider remaining quota.

Deployment: the review-branch Wrangler configuration now identifies the existing holy-rice-b914 Worker and D1 binding. Use only the guarded command and settings in docs/production-git-build.md after separate deployment approval; no deployment has occurred. Existing DB tables are retained; new additive yta_* tables are created on live/source operations. Keep ENABLE_LIVE_FREE=false and ALLOW_PAID_API=false until a separately approved, verified live-provider test. ACCESS_* and encryption secret remain unchanged. Never post API keys to GitHub/chat.

Example evidence: local provided MP3 for 2hUkTmwYm3A is 56,076,980 bytes; frame scan gives 5892.888 seconds, 20 chunks, largest 2,926,776 bytes, overlapping upload duration 5949.672 seconds. This verifies file slicing only. Real transcription, actual Gemini output, deployed resource limits and remote D1 persistence for v0.7 remain NOT_RUN until authenticated deployment/acceptance. Existing v0.6 site/key/history confirmations were user-reported, not agent-observed remote tests.

Acceptance gate: do not declare productionReady or PASS for real providers until owner login, deployed version, a real encrypted key operation, example transcription, evidence review, report export and D1 reload all succeed. npm tests use mocked providers and local SQLite, and cannot satisfy this gate.
