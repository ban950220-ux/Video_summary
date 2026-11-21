# Current-state source replacement (local proposal)

This path is a separately reviewed, single-use replacement of code and static
assets from an exact Git commit. It does **not** claim that the Dashboard active
version has the same assets or bindings as its annotated predecessor. The normal
source-lineage guard remains unchanged when no replacement approval is present.
This change contains code and offline tests only. PR creation and merge do not
authorize operational replacement or approval-variable registration; neither is
performed by this change.

The protected `GROQ_CURRENT_STATE_REPLACEMENT_JSON` object must contain exactly:

- `kind: CURRENT_STATE_SOURCE_REPLACEMENT_V1` and
  `intent: REPLACE_REVIEWED_ACTIVE_CODE_AND_ASSETS`.
- Pinned account, Worker, D1, active version (`a1aa62cf-1ecb-4f51-9cd9-c8823f4e2167`),
  predecessor, predecessor script ETag and predecessor source commit.
- `reviewedCommitSha` equal to both the checked-out HEAD and Workers Builds SHA.
- `remoteFingerprint`, a SHA-256 of the complete read-only current-state response,
  including bindings and omitted/null/empty distinctions.
- `assetManifestDigest`, a SHA-256 of every tracked file name and content digest
  under `web/site`. Modified, missing, untracked, ignored-but-untracked and
  non-regular asset files block the upload.
- `ownerDiagnosticDigest` and `approvedScopeUpdateDigest` pointing to the
  separately reviewed owner-only diagnostic and approved scope update record.
  `scopeValueEquality` must literally be `UNVERIFIED`: secret presence does not
  establish its exact value. Both actual JSON records must also be supplied as
  separate protected inputs, with their independently reviewed SHA-256 digests
  in `GROQ_TRUSTED_OWNER_DIAGNOSTIC_SHA256` and
  `GROQ_TRUSTED_SCOPE_UPDATE_SHA256`. Code checks record contents, target,
  chronology, cross-reference and both trusted digests. Missing records or
  invented 64-digit hashes block. The trusted digests must be provisioned from
  the real owner diagnostic and approved change record by a separate reviewer;
  copying hashes from the deployment approval would defeat the trust boundary.
- Actual `reviewedAt` and `expiresAt`, at most 24 hours apart.

Before upload, both existing preflight rounds validate exact active version,
readable settings and bindings, D1, Access, paid flags, recovery setting, runtime
metadata, source predecessor and current fingerprint. Approval is rechecked after
asynchronous version reads and again immediately before dispatch. The reviewed
manifest is recomputed before dispatch. One final remote GET immediately before
dispatch rechecks the active version and fingerprint. The production config must retain
`keep_vars`, `ASSETS`, `run_worker_first`, D1 and only the reviewed production
variables. Wrangler remains pinned and is invoked once with `--keep-vars`.

After upload, both existing postchecks require the new active version at 100%,
the actual HEAD source annotation, preserved current settings and non-ASSETS
binding representations, exact readable recovery setting, and scope binding
presence. A postcheck failure is `DEPLOYED_UNVERIFIED`; it never starts another
upload. A successful replacement changes the active version, so the old approval
cannot be reused. Do not roll back to an older version to restore a scope secret.

## Concurrent change limit

The final GET does not make a subsequent upload atomic with the observed active
version. The documented [Create Worker Deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/)
lists the versions and percentages to deploy but does not document an expected
active-version/If-Match precondition. Wrangler documents `--strict` as a check
for conflicting remote changes, not an exact-version compare-and-swap guarantee.
Cloudflare also supports `versions upload` without immediate activation, then
`versions deploy` for a reviewed version. Moving to that two-step flow would
require a separate design and review of asset and secret preservation and a
second state check before activation; this patch does not switch commands.

### Single-run change window when a global lock is unavailable

This is a proposed operational exception, not a global lock or authorization
to deploy. It does not make the final read and Wrangler upload atomic. An
independent reviewer must approve this procedure and its residual race for
the exact deployment before any operational approval. If a provider-supported
conditional activation or enforceable global lock is later demonstrated, it
requires its own review; neither is assumed here.

Before proposing the window, the Cloudflare owner and reviewer must record
every known way to change this Worker: Git-connected Workers Builds (production
and preview branches, retries and deploy hooks), Dashboard code/settings/
variables/secrets edits and version promotions or rollbacks, Wrangler from
local machines or external CI, direct Workers API calls, and every member,
group, service identity and API token with corresponding write access. Record
the actor, credential, trigger, authority and whether it can affect production.
Inspect current Builds configuration, access grants, audit history and other
deployment automation. An unknown writer, uninspected trigger, or incomplete
inventory blocks the exception; a promise to avoid edits is not proof that a
writer is excluded.

For one short, named change window, obtain separate approval to pause every
automatic trigger that can write to this Worker, using a Cloudflare-supported
setting or credential control verified for this account. Record the prior
setting and the applied state so it can be restored deliberately. Check the
Workers Builds queue, running builds, retries, deploy hooks and other known
pipelines for both queued and active work; do not begin until none can deploy.
Do not treat disabling a Git push or locking one runner as covering Dashboard
and API writers. Verify and document how one manually authorized invocation
can run while automatic triggers stay paused; if this cannot be shown, stop.
Name one operator and one exact build/commit as the only planned deployment,
and record the window start, end and reviewer. Other known
writers must be excluded by verified controls where possible and explicitly
accounted for in the residual-risk review where exclusion is impossible.

Immediately before that one invocation, independently refresh the active
version, complete readable remote state and fingerprint, bindings, D1, Access,
paid flags, recovery setting, source evidence, approved scope records, exact
HEAD/build SHA and complete asset digest. Any change from the reviewed approval,
missing evidence, expired approval or unexpected writer activity cancels the
window. Keep all existing preflight and final-GET guards; this procedure does
not relax them. Run the pinned wrapper once, then immediately inspect both
postchecks and the resulting active version, settings and binding
representations. Do not label an ambiguous upload or failed postcheck as a
successful deployment, and do not issue a second upload to repair it.

Classify the outcome before restoring any trigger:

- **Verified success:** both postchecks confirm the new active version and
  preserved settings and binding representations. Record the deployment
  receipt and independently approve trigger restoration.
- **Canceled before upload:** retain evidence that no upload was dispatched
  and that the active version and settings remain unchanged. Independently
  approve restoration; a later deployment needs fresh approval and a new
  window.
- **Uncertain upload, postcheck or concurrent activity:** leave automatic
  triggers paused, stop further writes, preserve logs and receipts, and
  investigate the remote state with the owner and reviewer. Do not restore
  triggers until the outcome is classified. Never automatically retry; a new
  attempt needs a fresh fingerprint, asset and scope evidence, approval and
  window.

Before any approved restoration, inspect builds, retries, deploy hooks and
other pipelines that accumulated during the pause. Record their commit and
target; cancel or exclude stale and unapproved work through an approved,
verified control so an older commit cannot deploy on resume. If pending work
cannot be inspected or safely handled, keep triggers paused. Restore only the
reviewed trigger settings, then independently re-read the active version and
preserved settings and bindings. Unexpected drift stops further deployment
and requires investigation. Record the final state and window closure.

Even with these controls, an account owner or another credential may change
the Worker after the final GET or while Wrangler uploads. This race remains.
No one may treat this exception as satisfied until the writer inventory,
trigger pause, empty queue, one-operator plan, all preservation evidence and
an explicit independent acceptance of that residual risk are documented for
the exact target and commit. If any condition cannot be demonstrated, keep
the deployment blocked and seek a separately reviewed design change.

The code PR and merge require CI and independent review of the exact final
diff and offline tests. Before any operational authorization or activation, a
separate independent review must validate the two real scope evidence records
without exposing their values, independently obtain the remote fingerprint,
verify the final deployment commit and asset digest, and approve the exact new
CI variable for one deployment. The concurrency decision above must also be
independently reviewed and approved before activation. Local mock success and
code merge alone do not establish current production state or asset upload
success.

## Reproduce the PR19 base tree

GitHub commit `ca5e20e0f1df29ea36c3cb7e79d538fe0cb019a9` has tree
`75566f360a13180aca2b2c532b8d5620341252f3`. The latter is a **tree
object**, not a commit. In the isolated local checkout, PR #17, #18 and #19
diffs were applied sequentially to PR #16 commit
`30efec815ce72568fd21925d6e5fe2d9570bbe2a`; the resulting local
baseline commit `f7b862ab50755415af46e6986426a39e9f98338e` reports the
same tree with `git log -1 --format='%T'`. The proposed diff is only the
uncommitted changes against that local baseline. A reviewer can independently
compare GitHub's `/git/commits/ca5e20e...` `tree.sha` with this local tree,
and then inspect `git diff f7b862a --` for exactly the proposal files.

Cloudflare documents that [Direct Upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
uploads a manifest and assets for the new deployment. [Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
supports preserving existing variables with `--keep-vars`. Neither establishes
the historical active version's asset identity or a secret value hidden by the
read API.
