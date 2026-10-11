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
`main`. Workers Builds may inject `WRANGLER_CI_OVERRIDE_NAME` automatically.
Do not try to remove a platform-managed value. The guard accepts it only when
its value is `holy-rice-b914`; `video-summary` or any other value stops the
build/deployment before Wrangler can override the target.

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
HEAD, including detached checkouts. Outside Workers Builds it requires a local
`main` branch. It validates the Worker and D1 target, and invokes
the pinned Wrangler with `--name holy-rice-b914 --keep-vars --strict` by default.
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

For the **one reviewed reconciliation deploy**, the Cloudflare Build operator
must first recheck the remote Worker settings and selected Access application,
then set the Build environment variable `APPROVED_CONFIG_RECONCILIATION_SHA` to
the exact commit being deployed. That commit must be the reviewed `main` SHA;
do not set the variable until that SHA is final. This allows the deploy script
to omit `--strict` for that one SHA only, while still using `--keep-vars`, the
production target guard, and the branch/SHA guard. A missing or mismatched value
keeps strict mode or stops the deploy. After confirming the resulting version,
remove the one-commit exception from Build settings so later commits use strict
mode again. Keep Preview builds disabled. Do not paste raw Wrangler diff output
into Git or chat because it can contain runtime variable values.

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
