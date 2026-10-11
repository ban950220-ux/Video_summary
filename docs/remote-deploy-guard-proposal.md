# Remote deployment guard proposal — not enabled

The current `npm run deploy:production` remains fail-closed with Wrangler
`--strict`. A future guarded deployment must not bypass that check merely by
pinning a Git SHA. In noninteractive builds, removing `--strict` accepts **every**
remote conflict, so the replacement guard must verify the remote state before
invoking Wrangler without strict mode. No remote read or deploy was performed
while preparing this proposal.

## Read-only inputs required

Use the existing Workers Builds token, only if it is exposed to the deploy
process as `CLOUDFLARE_API_TOKEN` and has read access to the endpoints below.
Require the expected full active version ID and a separately reviewed baseline
for observability, routes, binding names/types, and compatibility settings.
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
6. Fetch the active version and metadata again immediately before upload to
   narrow the time-of-check gap. Any mismatch, API error, non-JSON response or
   insufficient token scope must stop before Wrangler runs.

This is still a proposal, because the existing Build token's read scope and
availability have not been verified, and the full active version ID and full
observability baseline have not yet been supplied. Approval is also needed for
replacing Wrangler strict mode with this explicit allowlist. Cloudflare Access
application policy lives outside these Worker metadata endpoints; it requires
independent owner-only verification before and after deployment.
