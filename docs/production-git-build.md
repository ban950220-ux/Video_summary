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
`ban950220-ux/Video_summary`, root directory is `/`, production branch is `main`,
and remove the existing `WRANGLER_CI_OVERRIDE_NAME` build variable. The guard
fails if that override remains set, so it cannot silently target `video-summary`.

- Build command: `npm ci && npm run check && npm test`
- Deploy command: `npm run deploy:production`
- Preview command: `npm run preview:blocked` (until a separate D1 database and
  owner-only Access protection are verified for previews)

These settings are a recommendation for the later connection step, not permission
to submit the Cloudflare form or deploy now. Keep the production Worker Access
application on its existing owner-only policy. Verify the production and any
future preview hostname remain protected before enabling preview builds.

`deploy:production` requires the checked-out `main` branch, refuses any
`WRANGLER_CI_OVERRIDE_NAME`, validates the Worker and D1 target, and invokes
the pinned Wrangler with `--name holy-rice-b914 --keep-vars --strict`.
`--keep-vars` preserves existing dashboard runtime text variables, including
`ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`. The existing `ACCESS_OWNER_EMAIL` and
`KEY_ENCRYPTION_KEY_B64` Worker Secrets are not read or changed. Their values
must never be added to this repository. `ALLOW_PAID_API=false`,
`ENABLE_LIVE_FREE=false`, and `SITE_DEPLOYED=true` are explicit in the config.
The production `DB` binding points to the existing database. Never run a D1
migration or schema command as part of this Build.

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
