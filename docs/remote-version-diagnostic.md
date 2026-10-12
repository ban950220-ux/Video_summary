# Read-only active version diagnostic

The read-only preflight has an opt-in active-version diagnostic. This review candidate pins Worker version `a037172d-37e6-48ab-a7cb-54bdf4f4d538` and source `91c2aa919f2fccf9a5879aa0cb2aa77557d48cbb` from the owner's separate version/source readback. `remoteSettingsReviewed=true` carries forward the separately reviewed metadata shape from read-only Build `1323e142-ee46-47d2-b541-df604c1a7a50`; it is not a new review of all current remote metadata. A fresh preflight must compare the actual metadata and fail on any mismatch.

In an authorized Workers Builds context with the existing read-only Build token, run:

```sh
REMOTE_PREFLIGHT_VERSION_DIAGNOSTIC=true npm run preflight:remote-baseline
```

The preflight continues to use its fixed Cloudflare GET endpoints. With the flag set, `versionDiagnostic` contains only a UUID-shaped active version ID and a 40-character SHA from an exact `source-commit:<sha>` deployment annotation. Invalid or absent values become `UNAVAILABLE`. The report never copies raw API objects, binding values, token material, or arbitrary deployment messages into logs. Without the flag the field is absent.

Use the result as diagnostic evidence for reviewing the pinned remote baseline. It does not approve the baseline, deploy a Worker, change Cloudflare Builds settings, or prove owner-only Access. If the active version/source is unavailable or runtime settings still mismatch, leave the guarded deployment blocked and investigate the read-only report.

## 2026-10-12 access and schema review

An earlier authorized Workers Builds read-only preflight reported
`diagnosticReadSucceeded=true`, `matchesProposedBaseline=false`, and
`mismatchCode=METADATA_INCOMPLETE`. That run reached its GET endpoints; its
result is not evidence of a permission denial. The sanitized field diagnosis
reported incomplete observability and tail-consumer metadata. The current
local executor has neither `WORKERS_CI` nor `CLOUDFLARE_API_TOKEN` available,
so its preflight stops at `BUILD_CONTEXT_OR_TOKEN_UNAVAILABLE` before any
Cloudflare request. This local result cannot establish whether the current
active version's API fields are omitted, null, or inaccessible.

Cloudflare's [Get Worker Script Settings API reference](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/)
marks `logpush`, `observability`, and `tail_consumers` as optional response
fields. The guard intentionally pins the observed shape, rather than treating
all optional forms as equivalent. Never infer null, empty arrays, or default
values from omission.

Build `1323e142-ee46-47d2-b541-df604c1a7a50` ran the existing GET-only
preflight from production source `fce76164541f2785a0e89953d92e58202aa97701`.
It reported `diagnosticReadSucceeded=true`, active version
`1fcd78b0-363c-4cc1-8b7e-1a6571ef455e` at 100%, and the matching source
annotation. Its `ACTIVE_VERSION_MISMATCH` compares against that old source's
stale pinned UUID (`28cfd3f4…`), not against the current review baseline.
The sanitized report independently marked compatibility date/flags,
observability, optional script fields, logpush, tail consumers, and script
observability as matching their proposed values. It classified
`compatibility_flags`, limits, placement, streaming-tail consumers,
observability destinations and issues as omitted, while script-settings
`tail_consumers` was explicitly null. The current guard already distinguishes
those shapes and rejects a change from omission to null or an empty array.
Review-branch tests reconstruct the observed shape against the current pinned
UUID/source and check every target, binding, Access, runtime, exposure and
metadata condition. Cloudflare Builds restored `npm run deploy:production`
after the diagnostic without a deployment; a later build under that command
must wait for separate rollout authorization and fresh remote prechecks.

The `c302e8599c4b98f0bd25ec89743f5ff1838273fd` source uses the same
`readRemoteState` and `assertRemoteState` code as this review branch. Its
guarded deployment reads the remote state twice before upload and twice after
upload, checking the exact optional-field and observability shape each time.
The owner reports Build `f6d115a0-319b-433c-ba24-f11d04133a3a` succeeded
under that deploy command and the current Worker version/source annotation was
read back. This supports changing only the pinned version/source; the next
deployment still requires fresh GET checks. A successful build by itself would
not prove the postcheck without confirming which deploy command ran.

## Read-only lineage diagnostic trigger

This documentation-only review-branch commit is reserved for one Cloudflare
Build trigger after the browser operator confirms the review branch and the
temporary `npm run preflight:version-lineage` deploy command. The diagnostic
result must be reviewed separately; the trigger commit itself did not prove a
Build result.

Build `b8903046-5c3d-4357-982c-43874f7addcd` later reported that the
Dashboard settings version `37ffbd37-a256-41a9-816a-e1967c03d68c` has an
`OTHER` deployment annotation, while the Wrangler version
`bf955e63-0b85-4535-ad39-2858742f89e4` has the expected
`source-commit:415825bef1f152376c6e49ed01fffb3793f940a2` annotation.
Both version-detail reads returned the same script ETag
`eb6b6cbff792f3149a6f3795e54a9d717fd03b893a2ff57f906d3221f5c5262f`.
The version API did not expose an asset-set identifier, so this evidence
establishes only script-content equality. The narrow pre-deploy guard path
re-reads those exact versions and the prior annotation twice, while retaining
the current settings, Access, D1, and assets-binding checks. The post-deploy
guard still requires the new deployment's exact source annotation.
