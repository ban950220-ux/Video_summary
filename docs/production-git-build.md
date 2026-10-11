# Existing Worker Git Build handoff

This repository now identifies the existing `holy-rice-b914` Worker and its existing
`DB` binding to `youtube-ai-analyzer-private-db`. The database UUID is deployment
metadata, not a credential. No database migration or remote write is part of this
branch. Production remains on its currently active version until an approved deploy.

## Reviewed Cloudflare Build settings

Use the existing Worker `holy-rice-b914` in Cloudflare Workers & Pages. Do not
connect or deploy the separate `video-summary` Worker. Keep the existing token
selection if it already has the required access; do not create or broaden a token
as part of this handoff. Confirm the connected repository is
`ban950220-ux/Video_summary`, root directory is `/`, and production branch is
`main`. Workers Builds may inject `WRANGLER_CI_OVERRIDE_NAME` and
`WRANGLER_CI_MATCH_TAG` automatically.
Do not try to remove a platform-managed value. The guard accepts it only when
its value is `holy-rice-b914`; `video-summary` or any other value stops the
build/deployment before Wrangler can override the target. A supplied match tag
is passed to Wrangler only after it matches the tag read from this Worker;
pinned Wrangler then performs its own account/name/tag check.

- Build command: `npm ci && npm run check && npm test`
- Deploy command after explicit production deployment approval: `npm run deploy:production`
- Preview command: `npm run preview:blocked` (until a separate D1 database and
  owner-only Access protection are verified for previews)

These settings are a recommendation for the later connection step, not permission
to submit the Cloudflare form or deploy now. Keep the production Worker Access
application on its existing owner-only policy. Verify the production and any
future preview hostname remain protected before enabling preview builds.

Before approving a merge, first inspect the existing `video-summary` Git Build
connection. A push to `main` must not trigger its default deployment. Disable
that connection or give it the deliberately blocking deploy command
`npm run release:gate` and blocking preview command `npm run preview:blocked`
before merging. Connect `holy-rice-b914` using the selected existing token with
the same blocked deploy and preview commands initially. Saving a Git Build
connection may trigger a build; expect `release:gate` to exit 2 with no deploy.
Do not enable `npm run deploy:production` until a separate deploy approval,
preflight review, and the correct Worker target are confirmed.

`deploy:production` requires `main`. In Workers Builds, it verifies
`WORKERS_CI_BRANCH=main` and that `WORKERS_CI_COMMIT_SHA` matches the checkout
HEAD, including detached checkouts. The deployment script now requires Workers
Builds, validates the Worker and D1 target, and reads the current Cloudflare
Worker metadata twice before invoking pinned Wrangler with
`--name holy-rice-b914 --keep-vars`. Missing Build token, missing read permission,
missing response fields, or unexpected remote changes stop before upload.
`--keep-vars` preserves existing dashboard runtime text variables not specified
by config, including `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`; the three configured
flags are explicitly sent as `false`, `false`, and `true`. The existing `ACCESS_OWNER_EMAIL` and
`KEY_ENCRYPTION_KEY_B64` Worker Secrets are not read or changed. Their values
must never be added to this repository. `ALLOW_PAID_API=false`,
`ENABLE_LIVE_FREE=false`, and `SITE_DEPLOYED=true` are explicit in the config.
The production `DB` binding points to the existing database. Never run a D1
migration or schema command as part of this Build.

### Dashboard-to-Wrangler configuration reconciliation

The first production Build for `d2195be` passed 57 tests and bundling but stopped
before upload at Wrangler's strict remote-configuration check. The active version
remained unchanged. The remote Worker has `preview_urls=false`, persistent logs
enabled, the same `DB` binding and database UUID, dashboard Access variables,
and no `ASSETS` binding. The local configuration now explicitly preserves the
preview and logging settings. Its D1 name and UUID match the actual database.
Wrangler's remote diff omits the D1 name metadata, so a name difference in that
diff does not mean the binding points to a different database.

Pinned Wrangler 4.149.0 compares dashboard variables against `[vars]` even with
`--keep-vars`. `--strict` therefore rejects the existing dashboard-only Access
variables. Putting their values in Git or in Build logs is not an acceptable
way to make the diff pass. The new `ASSETS` binding is intentional and required
by `src/site-worker.mjs` to serve authenticated static files. It is the only
planned new binding.

The previously proposed SHA-limited strict exception was removed. It could be
retried indefinitely for the same commit, and noninteractive Wrangler accepts
all remote conflicts when strict mode is absent. The replacement guard pins the
full active version ID, checks the full observability object, routes, domains,
workers.dev and preview URL switches, D1 UUID, Access variable/secret presence,
and runtime flags. It permits only the reviewed `ASSETS` binding addition.
The guard also reads script settings (`logpush`, `tail_consumers`, and the
separate script-settings `observability` object) and version metadata
(`streaming_tail_consumers`, limits, placement). The metadata fields may
legitimately be omitted by the API; the guard records presence separately from
value. The proposed baseline expects explicit `[]` for streaming tails and
explicit `null` for limits and placement. These shapes and values are **not
yet verified from the production API**. `remoteSettingsReviewed=false` blocks
deployment until an actual response is checked and the presence/value baseline
is updated and explicitly marked reviewed. Missing required settings or any
unexpected difference still blocks deployment.

### Read-only baseline preflight

`npm run preflight:remote-baseline` is a separate command for a later Workers
Build run with its existing `CLOUDFLARE_API_TOKEN`. It requires `WORKERS_CI`,
reuses the guard's fixed Cloudflare GET endpoints, and never calls Wrangler,
uploads code, deploys, or writes D1. It is not part of the current Build or
Deploy commands. Add it to a Build only after separately reviewing that change.
Exit code 0 and `diagnosticReadSucceeded=true` mean only that the read succeeded.
`matchesProposedBaseline` and a fixed `mismatchCode` separately report the
guard's diagnostic comparison; `reviewGateEnabled=false` still blocks deploy.
The `bindings` result reports availability, unique names, and complete
expected names/types without listing them. Object key order does not affect
comparisons. The JSON output contains only comparison booleans, observability
switches and sampling rates, optional-field presence/kind, and array counts. It omits
tokens, Access values, raw bindings/responses, account/DB/version IDs, Worker
tags, routes, domains and consumer names. Unexpected objects are classified
without printing their contents. A failed read emits only a fixed error code.
An empty/absent field shown by this command is evidence to review, not
automatic approval: `remoteSettingsReviewed` stays false until its exact
production response shape is independently reconciled.

Its approved baseline currently identifies active version
`a33b9720-c167-4998-b8cb-3b065439b0d0`. A later deployment must update the
baseline after independently confirming the then-active version. See
[the remote guard design](remote-deploy-guard-proposal.md).

The child Wrangler process receives a minimal environment: the expected token,
fixed account and reviewed CI Worker name, with unsupported `CF_`,
`CLOUDFLARE_`, and `WRANGLER_` overrides rejected. Its stdout and stderr are
captured but never relayed to Build output, and pinned Wrangler 4.149.0 receives
`WRANGLER_WRITE_LOGS=false`. The wrapper emits only a generic failure message.
This protects against Wrangler's raw dashboard diff appearing in its console
or Wrangler debug files under this pinned version. It does not make Cloudflare
platform logs or unrelated Build commands private; never print raw responses
or run an unguarded Wrangler deploy.

Two pre-deploy GET rounds and two post-deploy GET rounds narrow and detect drift
but are not an atomic lock. The wrapper reads pinned Wrangler's private
structured `WRANGLER_OUTPUT_FILE_PATH` deploy result, associates its exact
version ID with the checked-out commit in a `source-commit:<SHA>` deployment
message, and requires both that ID and message in the active remote deployment.
The private output file is removed after parsing; Wrangler's raw stdout and
stderr remain hidden. Missing output or message is an uncertain deployment,
not success. Another actor could change remote settings after the last
precheck or replace the just-deployed version after the postcheck.
There is no verified compare-and-swap condition in the documented Wrangler path
used here. A postcheck failure means upload may already have happened; stop and
inspect the active version and Access policy before any further action. The
owner-only Cloudflare Access application policy is outside the Worker metadata
guard and must be checked separately before and after deployment.

This guard is offline-tested, but the existing Build token's actual read scope
and the precise API response shape have not been tested. It deliberately stops
on insufficient permission or missing fields. The supplied browser review did
not independently establish query-string redaction or trace-persistence values;
the baseline currently expects `false` and `true` respectively. If the remote
values differ, the build stops and the local config must be reconciled only
after review. Keep Preview builds disabled. Do not paste raw Wrangler diff
output into Git or chat because it can contain runtime variable values.

Before a later production deployment, inspect the selected Worker, target URL,
active version, DB binding, Access policy, and names (not values) of variables
and secrets in Cloudflare. Record the currently active version; it was reported
as `a33b9720` during this preparation, but must be checked again immediately
before deploying. Run the build checks and Wrangler `--dry-run` first. If the
existing token cannot deploy this Worker, stop and review its existing scope;
do not switch to a broader token automatically. `npm run release:gate` still
returns exit 2 because it cannot prove remote Access, secrets, or D1 behavior.

After a later approved deployment, confirm owner login and that unauthenticated
requests cannot reach HTML, static assets, or API paths. Check that the `DB`
binding, runtime variable names, and secret names remain present and that live
provider calls remain disabled. If the new version fails, use Cloudflare
Workers & Pages > `holy-rice-b914` > Deployments > Rollback to the previously
recorded version. Cloudflare rollback does not undo database changes, which is
why this branch contains no D1 writes or migrations.

The live feature uses four additional tables: `yta_sources`, `yta_quota`,
`yta_operations`, and `yta_audio`, defined in `migrations/0002_live.sql`.
Runtime requests no longer run `CREATE TABLE`: quota, source, export and status
reads are read-only, and missing live tables return `LIVE_SCHEMA_REQUIRED`.
Writing a transcript, setting free-use grants, processing live providers, and
audio planning require a separately approved, additive application of that
migration to the existing D1 database. Do not run it as part of the Build or a
post-deploy read-only check. Also verify the base `schema.sql` tables exist
before attempting end-to-end writes; no production schema inventory has yet
been performed here.

MP3 bytes are read into a browser buffer, sent one chunk at a time to Groq,
and are not stored as binary in D1 or R2 by this application. `yta_audio`
stores plan times, state, the file hash and duplicate per-chunk transcript JSON.
The retained TXT content is `yta_sources.raw`, with timed segments alongside
it; summary and analysis stay in `jobs`. After every chunk succeeds and
`audio-finish` saves the full transcript, the owner can separately confirm
**임시 전사 조각 정리** in the library. The server checks planned time coverage,
every chunk's *retained* result, completion audit, matching file hash and D1
TXT readback before deleting `yta_audio` rows for that job. The duplicate
Groq result JSON in completed `yta_operations` is cleared too, while the
operation's `DONE` state and quota ledger remain to prevent duplicate calls.
Missing/failed chunks, discarded speech or mismatched saved text retain the
rows for resume and review. Repeating `audio-finish` on an identical completed
source preserves the existing summary. This does not delete the PC or
Library original. No production cleanup was run in this branch.
