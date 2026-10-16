# Groq diagnostic deploy baseline: local review

The current production version is `6b2f1c56-7880-4515-aea0-786b51b4c625`.
It was created by a dashboard update to
`GEMINI_LEGACY_QUOTE_RECOVERY_JSON`, so its deployment message is not a source
commit annotation. The immediately preceding Wrangler version
`6a3fcf05-03fe-4d2b-911f-b43631a17a85` is annotated with PR9 merge
`950cce886988803765616212ef657254b415bb9a`. Read-only version metadata
showed equal script ETags, equal script runtime metadata, and exactly one
additional plain-text binding with that recovery variable name. The ETag is
pinned in the guard, not printed in the diagnostic report. These checks
establish the reviewed script lineage; the dashboard version itself has no
Git-source assertion. Secret binding values are not exposed by this evidence.

The updated guard permits only this exact active/prior version pair, pinned
script ETag, annotated prior commit, dashboard/current and Wrangler/prior
provenance, equal runtime metadata, and the single known binding addition.
The existing target, D1, Access, runtime flag, routes, preview, compatibility,
observability and source checks still run. Before upload, two remote reads
must find an identical recovery variable value; after a guarded upload, two
remote reads must find that same value. No value is logged. The existing
`--keep-vars` upload preserves the binding; this change does not parse,
extend, replace or delete the expired recovery configuration.

A read-only run of `assertRemoteDeploymentBaseline` against the current Worker
passed with the reviewed lineage. This is not deployment approval or proof of
a successful new version. If the live version, metadata, binding set, or
recovery variable changes before a later build, the pre-deploy guard blocks.
If the setting unexpectedly changes during deployment, the postcheck reports
an unverified deployment without printing its value. That postcheck cannot
undo an upload, so the new version must be inspected before any further step.
