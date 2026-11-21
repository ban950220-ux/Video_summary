# YouTube AI Analyzer — Cloud site, history & secure settings design v0.4

Date: 2026-10-10. Status: implementation scaffold tested; **no live cloud deployment, no provider API calls, no secrets configured**.

## Confirmed direction
- Transcript-first analysis (Architecture B), YouTube URL assistant + user-provided file fallback (Source B).
- Paid spending cap $0, no monthly/annual subscription, automatic charge/recharge disabled.
- An independent cloud website usable from PC and phone, with job history and a provider settings page.
- Owner-only first; other-user membership requires separate multi-tenant threat model and budget isolation.

## Where keys originate
1. Supadata account Dashboard (https://dash.supadata.ai): caption retrieval, initially native existing captions only.
2. Google AI Studio (https://aistudio.google.com/api-keys): model/API key for Korean translation and structured summary.
3. Groq Console (https://console.groq.com/keys): ASR from lawfully provided audio, not a YouTube watch URL.
4. AssemblyAI dashboard is optional fallback.
These are **provider** API keys. They cannot be minted by this site. Do not paste them into ChatGPT messages, GitHub, localStorage, or checked-in files.

## Hosting layout
User → owner-only login → Cloudflare Worker (same-origin website+API, future access gateway) → D1 for job/report index + usage + encrypted provider-credential records. Optional R2 for user-consented full transcript/large attachments with retention period; avoid keeping original audio by default. Queue for long-running jobs; never assume Work or a single Worker request can execute 120-minute audio transcoding.

D1 stores reports/metadata by default; full transcript is **not persisted** by prototype. Reports saved: date, title, video ID, status, source, duration, extracted summary and QA audit. Site can search/reopen/delete these records. Raw transcript only on an explicit future opt-in after retention/privacy design.

## Secrets and site Settings UX
### Safer phase-zero option
Cloudflare Dashboard > Workers & Pages > Worker > Settings > Variables and Secrets > Add > **Secret** for `SUPADATA_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`. Site Settings displays provider status, basic connection self-test, rotation and no raw key. This does not let the site's admin type/change secrets directly in the app. Cloudflare dashboard secrets are encrypted and hidden.

### Proposed phase-one site-managed vault
After verified owner-only authentication, site Settings renders fields for each API provider. `PUT /api/settings/providers/:provider/secret` sends key only over HTTPS to Worker; never to another client, telemetry, query string, log or localStorage. Worker encrypts AES-256-GCM with a separate 32-byte randomly generated `KEY_ENCRYPTION_KEY_B64` root key stored as **Cloudflare Worker Secret**. D1 only stores IV+ciphertext, immutable provider name + owner as authenticated additional data, updated time, and an audit event. `GET /api/settings/providers` returns configured yes/no and last change, never the key; `DELETE .../secret` removes key. Key change rotates data key, NOT automatically the Worker root. Master root rotation needs decrypt/reencrypt migration and rollback plan; losing master key prevents decrypting stored provider keys.

The currently coded API uses `ADMIN_TOKEN` in an Authorization header for **backend unit testing only**. **Never put `ADMIN_TOKEN` into a browser bundle or localStorage**. Before production: validate Cloudflare Access JWT/session identity or a tested OIDC login using server-side verification, ensure owner email/account allowlist, use secure HttpOnly/SameSite cookies or verified Access JWT, enforce origin/CSRF protection and strict content security policy, rate limits and security review. Do not open the write endpoints without these controls. The client-side demo intentionally DOES NOT accept live keys.

No `API verification succeeded` status may be shown until actual provider call/health quota checks are performed with the account's consent. Connecting API keys is not the same as enabling paid API usage.

## Data storage and API endpoints
Schema: `schema.sql` jobs, usage_events, provider_credentials (ciphertext only), provider_credential_events (no key contents).
- `POST /api/jobs`: submit URL preflight or user text; currently URL-only returns NEED_UPLOAD, audio blocked until pipeline ready.
- `GET /api/jobs?limit=20&offset=0&q=search`: D1-backed report library summaries.
- `GET /api/jobs/:id`: re-open report + QA audit.
- `DELETE /api/jobs/:id`: delete report record.
- `GET /api/usage`: APP_OBSERVED_ONLY quotas, external provider account balances UNKNOWN until measured.
- `GET /api/settings/providers`: configured flags only.
- `PUT /api/settings/providers/:provider/secret`: server-side AES-GCM encrypted key insert/rotation.
- `DELETE /api/settings/providers/:provider/secret`: delete encrypted key.
Authentication for these routes is prototype-only; login integration NOT_DONE.

## Cost outlook
- Workers + D1 free plan can be $0 at small personal volume; D1 free published limits 5 GB storage, 5M reads/day, 100k writes/day (account limits still need confirmation).
- Queues free published 10k operations/day, where a message usually has write+read+delete operations; avoid pretending it is 10k completed jobs.
- R2 free published 10 GB-month, Standard only; paid account activation or usage outside free allocations must be separately reviewed. Avoid R2 initially if reports fit D1.
- Supadata public free credits, Groq free ASR and Gemini free request/tokens are NOT one unified account quota; monitor provenance and reset per provider.
- Domain name and optional identity provider may incur extra cost. Do not buy domain or upgrade plans before approval.

## Acceptance gates before publish
A. owner-only login verified (forged JWT/session rejected; no ADMIN_TOKEN on client), HTTPS, CORS/CSRF/cookie/CSP controls
B. configured vault root, ciphertext only in D1, negative auth tests, key not echoed to responses/logs, key removal+rotation
C. actual D1 storage roundtrip across worker restarts and PC-off re-access, 120-minute entries, search, delete, owner isolation
D. provider free account quotas verified, $0 hard billing policy reviewed, native-caption 206 usage booked, error 403 no rights bypass
E. audio chunking 2h, English-to-Korean actual API result and QA; incomplete transcripts never marked FULL
F. QA for mobile, data retention/backups, account deletion, no changes to existing apps

### Current evidence (mock-only)
`npm test` and `npm run check` run locally; 25/25 tests PASS on 2026-10-10. Mock D1 and AES-GCM vault tests are NOT a real cloud DB deployment. No cloud host/auth, API credentials, billing, R2 or Queues provisioned. Cloudflare account access not connected here. Lovable preview built separately but currently has known TS/status validation problems; it must not be promoted as production.
