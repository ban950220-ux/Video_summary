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

Before authorizing one live replacement, operations must establish a single
writer change window covering Workers Builds, Dashboard edits and other API
deployments, with an independent record of who holds it and when it ends.
A lock confined to one build runner is insufficient across these writers.
The current wrapper narrows the read-to-upload interval and never retries an
uncertain upload, but another actor can still change state after the final
GET or during Wrangler. This race remains an explicit operational blocker
unless a provider-supported conditional activation or enforceable global
change lock is independently demonstrated and reviewed.

The code PR and merge require CI and independent review of the exact final
diff and offline tests. Before any operational authorization or activation, a
separate independent review must validate the two real scope evidence records
without exposing their values, independently obtain the remote fingerprint,
verify the final deployment commit and asset digest, and approve the exact new
CI variable for one deployment. The concurrency blocker above must also be
resolved before activation. Local mock success and code merge alone do not
establish current production state or asset upload success.

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
