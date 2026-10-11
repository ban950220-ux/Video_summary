# Read-only active version diagnostic

This branch adds one opt-in field to the existing remote baseline preflight report. It does not change Worker runtime code, the remote baseline, deployment commands, or `remoteSettingsReviewed`.

In an authorized Workers Builds context with the existing read-only Build token, run:

```sh
REMOTE_PREFLIGHT_VERSION_DIAGNOSTIC=true npm run preflight:remote-baseline
```

The preflight continues to use its fixed Cloudflare GET endpoints. With the flag set, `versionDiagnostic` contains only a UUID-shaped active version ID and a 40-character SHA from an exact `source-commit:<sha>` deployment annotation. Invalid or absent values become `UNAVAILABLE`. The report never copies raw API objects, binding values, token material, or arbitrary deployment messages into logs. Without the flag the field is absent.

Use the result as diagnostic evidence for reviewing the pinned remote baseline. It does not approve the baseline, deploy a Worker, change Cloudflare Builds settings, or prove owner-only Access. If the active version/source is unavailable or runtime settings still mismatch, leave the guarded deployment blocked and investigate the read-only report.
