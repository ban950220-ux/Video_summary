# Read-only active version diagnostic

The read-only preflight has an opt-in active-version diagnostic. The current review branch pins the separately confirmed Worker version and source SHA in the offline baseline while keeping `remoteSettingsReviewed=false`; this diagnostic does not change the Cloudflare Builds command or deploy a Worker.

In an authorized Workers Builds context with the existing read-only Build token, run:

```sh
REMOTE_PREFLIGHT_VERSION_DIAGNOSTIC=true npm run preflight:remote-baseline
```

The preflight continues to use its fixed Cloudflare GET endpoints. With the flag set, `versionDiagnostic` contains only a UUID-shaped active version ID and a 40-character SHA from an exact `source-commit:<sha>` deployment annotation. Invalid or absent values become `UNAVAILABLE`. The report never copies raw API objects, binding values, token material, or arbitrary deployment messages into logs. Without the flag the field is absent.

Use the result as diagnostic evidence for reviewing the pinned remote baseline. It does not approve the baseline, deploy a Worker, change Cloudflare Builds settings, or prove owner-only Access. If the active version/source is unavailable or runtime settings still mismatch, leave the guarded deployment blocked and investigate the read-only report.

## 2026-10-12 access and schema review

The earlier authorized Workers Builds read-only preflight reported
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
fields. Therefore, requiring `tail_consumers` to be explicitly null and
every observability subfield to be present is stricter than that endpoint's
documented response contract. The gate must remain closed until an authorized
read identifies the actual current field presence and a reviewed policy
defines how to compare an omitted field. Do not infer null, empty arrays, or
default values from omission.
