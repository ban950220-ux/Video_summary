# Remote deployment guard — review branch implementation

The review branch `npm run deploy:production` reads remote Worker metadata and
compares it to an approved baseline before invoking Wrangler without `--strict`.
In noninteractive builds, removing `--strict` otherwise accepts **every** remote
conflict. The guard fails closed if its read or comparison fails. No real remote
read or deploy was performed while preparing this implementation.

## Read-only inputs required

Use the existing Workers Builds token, only if it is exposed to the deploy
process as `CLOUDFLARE_API_TOKEN` and has read access to the endpoints below.
The expected full active version ID and baseline for observability, routes,
binding names/types, and compatibility settings are in
`scripts/remote-state-policy.mjs` and must be reviewed before each rollout.
Do not print tokens, Access variable values, raw API responses or raw diffs.
If the token, permissions, response fields or approved baseline are missing,
exit before any upload. No new token or broader permission is assumed.

Pinned Wrangler 4.149.0 itself reads these account-scoped API endpoints when
comparing a Dashboard-managed Worker:

- `GET /workers/services/holy-rice-b914` to identify the default environment.
- `GET /workers/services/holy-rice-b914/environments/{environment}` for script
  metadata, including observability and compatibility settings.
- `GET /workers/services/holy-rice-b914/environments/{environment}/bindings`
  for binding types and identifiers.
- `GET /workers/services/holy-rice-b914/environments/{environment}/subdomain`
  for workers.dev and version URL switches.
- `GET /workers/scripts/holy-rice-b914/deployments` for the latest active
  deployment and its version ID/traffic percentage.
- `GET /workers/scripts/holy-rice-b914/script-settings` for Logpush and tail
  consumers. The environment metadata supplies streaming tail consumers,
  limits, and placement.
- Read routes and domains too; unexpected routes must stop deployment.

Every path above is under `/accounts/{account_id}`. The account ID may be
recorded as deployment metadata, but the Build token must remain private.
The read response can include plaintext runtime values; discard them after
in-memory validation and log only field names and generic pass/fail codes.

## Exact pre-deploy checks

1. Require Workers Builds on `main` at the checked-out commit. Require exactly
   one active version at 100% traffic matching the operator-approved full ID.
2. Require the exact existing Worker, default environment, workers.dev route,
   `preview_urls=false`, and unchanged routes/domains.
3. Compare every observability field, including log and trace enabled state,
   sampling rates, invocation logging, persistence and query-string redaction.
   The local Wrangler config must explicitly match those remote values.
4. Require `DB` to reference the reviewed D1 UUID. Require the current Access
   variable and secret **names and types** to remain present. Check expected
   runtime flag values in memory; never print them. Reject unknown bindings.
5. Permit `ASSETS` to be absent on the first deploy and present with the
   expected type afterward. Reject any other binding addition, deletion, type
   change or identifier change. Keep `--keep-vars` in both config and command.
6. Reject target-changing environment overrides and give Wrangler a minimal
   environment. Capture its stdout/stderr without relaying raw remote diffs;
   disable its debug-file logging with the pinned-version setting.
7. Fetch the active version and metadata twice immediately before upload to
   narrow the time-of-check gap. Any mismatch, API error, non-JSON response or
   insufficient token scope stops before Wrangler runs.
8. Read pinned Wrangler's private structured deploy result to obtain the
   exact uploaded version ID. The deployment message records the checked-out
   source SHA. Require the post-deploy active version and message to match
   both values on two reads. If the structured result or message is absent,
   report uncertain deployment even if Wrangler exits zero. A mismatch is a
   failed verification of a possibly completed deployment, not proof that no
   upload happened. These reads do not atomically lock remote settings.

The full active version ID has been independently supplied. Log persistence,
invocation logs, 100% sampling, and disabled traces/Issues/exports are also
confirmed. Query-string redaction and trace persistence were not independently
reported, so the guard's expected `false`/`true` values require confirmation;
any difference fails the build. The existing Build token's actual read scope,
runtime availability and API response shape remain unverified. Approval is
needed before replacing Wrangler strict mode with this explicit allowlist on
`main`. Cloudflare Access application policy lives outside these Worker
metadata endpoints; it requires independent owner-only verification before and
after deployment.
