# Existing Worker Git Build handoff

## Current guarded free-provider rollout

The current 100% active version is `d899f6db-0cab-475b-9fdb-da8c5c8e4301`
from source `4cde3937269ab764a91185ebdd15616edb9ba7ea`. It already has one
`ASSETS` binding. The next guarded deployment expects `ENABLE_LIVE_FREE=true`
before and after upload. `ALLOW_PAID_API=false`,
`SITE_DEPLOYED=true`, the production D1 binding, owner-only Access, secrets,
exposure and metadata remain guarded. Preview flags remain disabled. The
precheck rereads remote state twice immediately before upload; a mismatch
blocks the deployment. Free-provider execution also requires a current
provider-specific D1 quota grant and confirmed billing-disabled status.
Passing local tests does not verify a provider call or a complete video result.

The historical first-assets-deployment discussion below describes the prior
rollout; use the current baseline in `scripts/remote-state-policy.mjs` for the
next deployment.

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
flags are explicitly sent as `true`, `false`, and `true`. The existing `ACCESS_OWNER_EMAIL` and
`KEY_ENCRYPTION_KEY_B64` Worker Secrets are not read or changed. Their values
must never be added to this repository. `ALLOW_PAID_API=false`,
`ENABLE_LIVE_FREE=true`, and `SITE_DEPLOYED=true` are explicit in the config.
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
and runtime flags. The initial pre-deploy check requires zero `ASSETS` bindings;
the post-deploy check requires exactly one `ASSETS` binding of type `assets`.
The guard also reads script settings (`logpush`, `tail_consumers`, and the
separate script-settings `observability` object) and version metadata
(`streaming_tail_consumers`, limits, placement). Read-only Build
`603ce3f5-e363-43c6-994b-b3e520fffefd` at source `055647b1` observed
omitted compatibility flags, limits, placement mode, streaming tails, log and
trace destinations, and issues. Script-settings tail consumers was explicitly
`null`. The baseline records these distinct response shapes without treating
omission as `[]` or `false`. Wrangler config omits destinations and issues to
match the observed state. A new active version and `ASSETS` binding are the
only intentional post-deploy differences; other drift fails the check.
Read-only Build `e9c72f29-3051-4685-a16c-c5b2fdf2381e` at source
`ec69db7be3f7a328c078fa9c924619da07a6549b` reported
`diagnosticReadSucceeded=true`, `matchesProposedBaseline=true`,
`mismatchCode=null`, and `reviewGateEnabled=false`; active version
`a33b9720-c167-4998-b8cb-3b065439b0d0` remained at 100% with no upload.
After independent review of that response, `remoteSettingsReviewed=true` was
set without changing any expected field or the active version. A post-deploy API
shape change fails the postcheck rather than being silently accepted.
That is historical. Read-only Build
`1323e142-ee46-47d2-b541-df604c1a7a50`
confirmed the omitted/null distinction and the former pinned version
`1fcd78b0-363c-4cc1-8b7e-1a6571ef455e` from
`fce76164541f2785a0e89953d92e58202aa97701`. The review branch now pins
`caf22f64-997c-427c-8373-4f487bc4a5aa` from
`c302e8599c4b98f0bd25ec89743f5ff1838273fd` and retains the same exact
metadata checks. `remoteSettingsReviewed=true` carries forward the earlier
reviewed shape; it does not assert a fresh metadata review.
runtime and Access checks, a fresh pre-deploy read, and separate rollout
authorization remain required. The Cloudflare Builds deploy command was
restored to `npm run deploy:production` after the diagnostic. Do not trigger
a new production build under that command as a diagnostic.
Pinned Wrangler 4.149.0 normalizes an omitted `compatibility_flags` config
entry to `[]` in its upload metadata. It is not yet known whether Cloudflare
will return the newly uploaded version's flags as omitted or as `[]`. If the
postcheck reports `COMPATIBILITY_MISMATCH` after upload, treat deployment as
**unverified**, not successful. Do not retry or automatically redeploy. Read
the active version, source commit annotation, bindings and metadata through
read-only API calls, then reconcile the actual shape through a separately
reviewed baseline change. The comparison must not treat all omitted flags as
a wildcard.

### Read-only baseline preflight

`npm run preflight:remote-baseline` is the GET-only diagnostic command used
temporarily in the approved one-off Build. The current Workers Builds deploy
command is `npm run deploy:production`; do not start a new Build for diagnosis.
The diagnostic uses the existing `CLOUDFLARE_API_TOKEN` and requires `WORKERS_CI`,
reuses the guard's fixed Cloudflare GET endpoints, and never calls Wrangler,
uploads code, deploys, or writes D1.
Exit code 0 and `diagnosticReadSucceeded=true` mean only that the read succeeded.
`matchesProposedBaseline` and a fixed `mismatchCode` separately report the
guard's diagnostic comparison. The review branch records the current baseline;
the deployed main source still contains its older pinned version.
The `bindings` result reports availability, unique names, and complete
expected names/types without listing them. Object key order does not affect
comparisons. The JSON output contains only comparison booleans, observability
switches and sampling rates, optional-field presence/kind, and array counts. It omits
tokens, Access values, raw bindings/responses, account/DB/version IDs, Worker
tags, routes, domains and consumer names. Unexpected objects are classified
without printing their contents. A failed read emits only a fixed error code.
An empty/absent field shown by this command is evidence to review, not
automatic approval. The exact observed production response shape was
independently reconciled before the gate changed.

The review baseline identifies active version
`caf22f64-997c-427c-8373-4f487bc4a5aa`. A later deployment must recheck
that version immediately before upload and update the baseline after success. See
[the remote guard design](remote-deploy-guard-proposal.md).

### Post-deploy read failure after the `91c2aa9` release

Build `36beef3a-ed76-4aea-8002-e77f7854447c` passed its local tests, then
reported `REMOTE_READ_FAILED` from the first post-deploy parallel GET. This
failure has no HTTP status and does not establish that upload failed. Separate
owner readback found active version `a037172d-37e6-48ab-a7cb-54bdf4f4d538`
at 100% with `source-commit:91c2aa919f2fccf9a5879aa0cb2aa77557d48cbb`.
The Build itself did not complete its required two postchecks, so its own
result is unverified. The owner's UI and D1 checks are separate evidence, not
a retroactive Build success receipt.

The next review candidate retries only post-deploy GET transport failures,
with at most three read attempts and 0.5/1-second backoff per required
postcheck. It never re-runs Wrangler. HTTP errors, invalid responses, version
or metadata mismatches fail immediately. If both postchecks cannot finish,
the Build reports `DEPLOYED_UNVERIFIED` with a fixed stage code and suppresses
raw API and Wrangler output. Before any later rollout, independently review
the current version and exact metadata response, then update the stale pinned
version and source in the guard. Do not infer the optional API field shapes
from the dashboard UI.

### Baseline lifecycle

For this first assets deployment, `assetsPresent=false` requires zero `ASSETS`
bindings before upload. The postcheck requires exactly one binding with name
`ASSETS` and type `assets`, independently of the pre-deploy baseline. It also
requires the new active version and its source commit annotation; all other
remote settings must still match the reviewed baseline.

Before any later normal redeployment, run the read-only preflight again and
independently review the active version, binding names and types, D1, Access,
runtime flags, exposure and full metadata shape. Update the pinned active
version ID **and** set `assetsPresent=true` only after
confirming the existing single `ASSETS` binding. Review and test that baseline
change before enabling the next deployment. The later precheck then requires
one `ASSETS` binding, and its postcheck requires one as well. If any setting or
field-presence shape has changed, investigate it and update the baseline only
after separate review; do not infer that omitted, `null`, and empty values are
equivalent. Changing only the active version ID will leave the initial
`assetsPresent=false` policy in place and block the normal precheck. An
unchanged old version ID or an unexpected binding also blocks upload.

The child Wrangler process receives a minimal environment: the expected token,
fixed account and reviewed CI Worker name, with unsupported `CF_`,
`CLOUDFLARE_`, and `WRANGLER_` overrides rejected. Its stdout and stderr are
captured but never relayed to Build output, and pinned Wrangler 4.149.0 receives
`WRANGLER_WRITE_LOGS=false`. The wrapper emits only a generic failure message.
Build `f4d2066e-5cbd-4bab-a4b0-46f64d6a4108` at source `38c88c2` stopped
before Wrangler execution or upload because Workers Builds supplied
`WRANGLER_CI_GENERATE_PREVIEW_ALIAS`. Pinned Wrangler 4.149.0 accepts only
`true` or `false` for that flag (default `false`) and uses `true` when forming
an alias for `versions upload`. The wrapper now accepts only those exact input
strings and always passes `false` to its child Wrangler; invalid values and
all other unreviewed overrides still fail before the child starts. The guarded
command is `wrangler deploy`, with no preview-alias argument. This flag does
not enable a separate preview environment. A version alias, if created by an
upload path, would name the same Worker version; `preview_urls=false` remains
explicit in config and is checked against remote before and after upload.
[Cloudflare's Version URLs documentation](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)
states that disabling Version URLs disables routing to aliased Version URLs.
Build `ba6cdca2-09f9-442e-9f05-aedacd7c1e66` at source `81026bb` passed
the code checks and tests but stopped before Wrangler upload on the injected
`WRANGLER_OUTPUT_FILE_DIRECTORY`. Wrangler gives `WRANGLER_OUTPUT_FILE_PATH`
priority over that directory. The wrapper accepts these two exact Build input
names, validates that supplied values are nonempty strings, and discards both
values. It creates its own private temporary directory, passes only its own
`WRANGLER_OUTPUT_FILE_PATH` to the child, verifies the structured deploy
record, and deletes the temporary file. A parent-supplied output path or
directory cannot redirect that record. Unsupported `CF_`, `CLOUDFLARE_`, and
`WRANGLER_` variables still block the child; the error reports at most 12
safe variable names together, never values or paths. The documented default
Workers Builds variables (`CI` and `WORKERS_CI_*`) remain separate from this
Wrangler override allowlist. See [Workers Builds default variables](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
and [Wrangler output variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).
Build `fc770220-75fb-4831-9125-66aacf798376` at source `66ef068`
then stopped before Wrangler upload and reported both
`CLOUDFLARE_API_BASE_URL` and `WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST`.
Pinned Wrangler uses the former as the base for API requests; the read-only
guard uses `https://api.cloudflare.com/client/v4`. The wrapper now accepts
the Build value only if it is byte-for-byte that canonical base, and passes
the same fixed base to Wrangler. A changed origin, path, query or userinfo
fails before upload. The pinned Wrangler source uses the latter flag only in
the Docker command that builds a container image (`--network host`). This
Worker has no container configuration. The wrapper accepts only exact
`true`/`false` inputs and passes neither value to the child, so it cannot
change the production deployment's network mode. Other API and Wrangler
overrides remain blocked.

If the actual Build-injected API base needs inspection, run
`npm run preflight:build-env` as a separate read-only Build command before
restoring the production deploy command. It reports only whether the API base
exactly matches the canonical base, non-sensitive flag classifications,
target-match booleans, output-location presence, and bounded unsupported
variable names. It does not print raw URLs, paths, tokens or Access values.
Do not start an upload when `apiBaseCanonicalMatch` is false or unknown.
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
as `caf22f64-997c-427c-8373-4f487bc4a5aa` at 100% with source commit
`c302e8599c4b98f0bd25ec89743f5ff1838273fd` in the latest owner review, but must be checked again immediately
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
