# YouTube AI Analyzer — private mock-first MVP (2026-10-10)

Confirmed architecture: **B** transcript-first analysis; source policy **B** YouTube URL *assisted* source + uploaded transcript/audio fallback. Default **$0**, no paid subscription, no auto recharge, no other projects touched.

## Status and boundaries

- **Implemented & locally testable:** strict YouTube URL parser, SRT/VTT/TXT parser, duration <=120min enforcement, transcript timing QA, no-fabrication extractive report, quota-balance provenance, $0 budget gate, retry/failover rules, historical usage projection helper, authenticated serverless API prototype, optional D1 schema.
- **Optional provider functions present but NOT live-tested:** Supadata native captions, Groq audio STT (small legal audio files), Gemini transcript-based analysis. These default to off and require verified provider FREE plans. Supadata `mode=native` caption-only request implemented and unit-tested with mocked HTTP: 1 credit per request including 206 transcript-unavailable. `mode=auto` or `generate` is NOT enabled (120min could cost 240 credits). Live API remains disabled and untested without credentials.
- **Not implemented:** obtaining an arbitrary YouTube transcript with guaranteed rights, real 2h audio chunk upload pipeline, speaker diarization, reliable full coverage evidence, automatic accurate English→Korean translation, provider account usage reconciliation, persistent hosted deployment. Do not present as PASS.
- **Separate Lovable project:** frontend prototype built privately, mock/demo only; not merged into this independent backend package.

## Standalone HTML demo (no account or API required)

Open `web/demo.html` in any browser. It works entirely offline with embedded JavaScript. It imports/reads SRT/VTT/TXT and marks 98/30-minute samples PARTIAL and full-looking captions TRANSCRIPT_UNVERIFIED. No secrets, network calls, persistence, real AI or automatic translation. This is independent of the Lovable cloud prototype, which remained typecheck-uncertain after free workspace build credits ran out.

## Run locally for QA

```sh
npm test
npm run check
```

Node.js >= 20, no npm dependencies, no local server required to run tests. The Worker entry (`src/worker.mjs`) uses Web-standard Request/Response and D1 (when provisioned). It has not been deployed.

## Backend endpoints

`GET /api/health` (shows MOCK_ONLY); all remaining routes require `Authorization: Bearer <ADMIN_TOKEN>` in a private context. No CORS open origin. `ADMIN_TOKEN` minimum 24 bytes, configured via secret (never in source).

- `POST /api/preflight` `{"sourceType":"url","url":"https://youtu.be/2hUkTmwYm3A","durationSeconds":3600}`.
- `POST /api/jobs` with `sourceType:"text"`, `transcript:"..."`, `filename:"subtitle.srt"`, and `durationSeconds` returns literal extractive result and audit. URL-only returns NEED_UPLOAD and no invented analysis.
- `GET /api/usage` snapshots provenance; unknown account balances remain UNKNOWN.
- `GET /api/jobs/:id` requires D1 binding; without it returns 503 rather than pretending persistence.

For production, use owner-only authentication via access gateway and per-provider Worker secrets. Do not put private keys in frontend JS or localStorage. Published usage caps can differ from account reality. Use provider console sync before allowing requests.

## Cloud deployment gate (NOT authorized yet)

1. Review zero-cost account / privacy constraints and API terms.
2. Provision independent D1 database after approval and apply `schema.sql`.
3. Configure `ADMIN_TOKEN` as Worker secret; wire D1 binding using actual allocated ID.
4. Add owner-only access, verified account quotas, transactional reservation/settlement before any live provider requests.
5. Build controlled queued 120-min audio chunking and test actual YouTube captions availability, copyrights, and translation quality.
6. Confirm no existing repo/site has been modified, then request permission to deploy.

## Sources checked 2026-10-10

- https://supadata.ai/pricing (100 free credits/month, AI generation 2 credits/min)
- https://docs.supadata.ai/get-transcript (`mode=native`, 206 costs 1 credit, `x-billable-requests` response header)
- https://console.groq.com/docs/speech-to-text (Whisper Turbo $0.04/hour, free 25MB)
- https://ai.google.dev/gemini-api/docs/video-understanding (public YouTube URLs are not verified verbatim transcripts)
- https://developers.cloudflare.com/workers/platform/limits/ (Workers Free 10ms CPU/request)
- https://developers.cloudflare.com/queues/platform/pricing/ (10k standard operations/day free)

## v0.4 cloud site backend features (2026-10-10)

This package now adds mock-tested **D1-backed history + encrypted API-key backend settings**. See [docs/site-architecture.md](docs/site-architecture.md).

- `GET /api/jobs?limit=20&offset=0&q=...` lists report summaries from D1; `GET /api/jobs/:id` reopens; `DELETE /api/jobs/:id` removes. Without D1 these endpoints return `PERSISTENCE_NOT_CONFIGURED` (503). Search/list has not yet been tested against a real Cloudflare D1 instance.
- `GET /api/settings/providers` returns only configured flags. `PUT /api/settings/providers/{supadata|gemini|groq|assemblyai}/secret` submits `{"apiKey":"..."}` only to an authenticated Worker endpoint; `DELETE` removes encrypted secrets. **No site UI credential entry is enabled yet**. D1 stores AES-256-GCM ciphertext and IV, never raw key, while `KEY_ENCRYPTION_KEY_B64` is a server-side Worker Secret. No key is ever echoed in API responses. Do not place master key or `ADMIN_TOKEN` in a browser.
- A real site must first implement verified owner-only login/access-gateway identity and browser-safe sessions; the current `ADMIN_TOKEN` is a backend mock-only temporary guard and **must not be used as a browser login**. Worker's Cloudflare `Secret` bindings are simpler and recommended for manual initial setup when available.
- Unit tests use in-memory fake D1 only. **No D1 instance, live API key, site secret, provider connection, hosting, or publication was created**. The existing standalone HTML demo still has session-only history, not cloud persistence.

## v0.5 · Owner-only Cloudflare site shell and tests

- `web/site/index.html`, `style.css`, `app.js`: full UI shell connected to Worker API, independent from incomplete Lovable draft. It does not load third-party JS or handle credentials in localStorage.
- `src/access.mjs`, `src/site-worker.mjs`: owner-only Cloudflare Access RS256 JWT validation with JWKS, fixed audience/issuer/email, signed-token enforcement before serving assets and API, CSRF origin checks, default-deny when Access is unconfigured.
- `wrangler.toml` now points to **secure** `site-worker.mjs` and has `workers_dev=false`. Before any real deployment, an authenticated route, Access app, `DB` binding, and Worker Secret `KEY_ENCRYPTION_KEY_B64` must be set. Do not launch an unprotected host.
- Tests `npm run check && npm test`: **33/33 PASS** (sandbox). Headless Chromium UI with mocked APIs PASS for desktop/mobile. See [docs/production-handoff.md](docs/production-handoff.md).
- **Not yet deployed**. No actual Cloudflare account, D1, real Access login, or secret binding was accessed. None of Supadata/Gemini/Groq live APIs were invoked. This is a deploy-ready mock/backend shell, not an operational YouTube analyzer.


## v0.6 · Server-side encrypted credential bridge + deployment gate

- `src/provider-keys.mjs` resolves `provider_credentials` from D1, decrypts **only inside the Worker**, and passes keys transiently to Supadata native caption / Gemini summary / Groq STT adapters. Fallback is operator-managed Worker Secrets. Provider account FREE tier attestation + `ENABLE_LIVE_FREE=true` are both mandatory; unverified/free quota unknown cannot be claimed as real remaining balance.
- No route calls this bridge yet: live API calls, usage reservation and account-based quota reconciliation must be separately connected and tested before enabling the live toggle. DO NOT claim that merely saving the API key starts automatic transcription.
- `scripts/release-gate.mjs` is a read-only, offline pre-deploy checklist. Running `npm run release:gate` currently prints **BLOCKED_DEPLOY** by design (no real D1/Access route/secret setup) and exits 2. It does not create cloud resources.
- New 5 mock tests cover encrypted D1-key resolution with Supadata native mode, Gemini and Groq adapters, key non-exposure, free-tier gate and vault tamper rejection; total **38/38 PASS** on 2026-10-10.
- Access note (Cloudflare Aug 2026): individual Worker-wide Access protection covers `workers.dev`/routes/custom domains; it can replace a paid custom domain for a private personal Worker. The initial fail-closed Worker has no usable route in the checked-in `wrangler.toml` (`workers_dev=false`); choose a protected route only when account Access is configured. See `docs/production-handoff-v0.6.md`.
# v0.6.1 일반 웹 배포 경로

이번 패키지의 최신 안내는 START_HERE.md 및 docs/manual-cloudflare-v0.6.1.md입니다.
dist/dashboard-worker.txt는 화면 자산을 포함한 단일 Worker이며 Cloudflare Dashboard에 복사할 수 있습니다.
검증 결과: Node 41 PASS, 로컬 실제 SQLite 파일 재열기 PASS. 원격 배포/D1/Access/API 호출은 NOT RUN입니다.
아래 v0.6 기존 문서 및 스크린샷은 이전 단계의 기록이며 원격 실증 증거가 아닙니다.

