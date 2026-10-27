# Supplied release capture projection — offline only

`scripts/release-observation-projection.mjs` validates explicitly supplied non-secret capture objects and produces `offlineObservation`. It performs no API request, reads no credential, changes no setting, and has no production transport. `productionExecutionSupported`, `provenanceAuthenticated`, and `permissionVerified` are always `false`.

This closes a local shape-validation gap. It does **not** resolve the prior production metadata access denial, establish permission to repeat that read, or turn the existing release proposal into an executable deployment tool. No additional archive is required for this module.

## Official response shapes reviewed

Primary Cloudflare documentation, reviewed 2026-10-26 UTC:

| Source | Fields used and deliberate limits |
| --- | --- |
| [Get Worker](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/get/) | `result.id` is the immutable Worker ID; `name` binds it to the expected script. The documented Worker object supplies logging, observability, subdomain, tags, tail consumers and reference metadata. This narrow implementation requires explicit observability/subdomain settings, rejects missing or unknown fields, and accepts only empty references/tail consumers. Optional fields remain absent when absent; they are never changed to `false`, `null` or `[]`. Preview base configuration is currently unsupported. |
| [List Worker Deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/) | The first deployment is documented as the one currently serving traffic. Only an unfiltered `page:1, per_page:1` capture is accepted. The first entry must have its own UUID and exactly the pinned baseline version at 100%. Present pagination `count` must match the returned array; present totals must be positive, and `total_count` must equal `total_pages` when both are supplied for this fixed page size. Absent pagination fields remain absent. A lookup of an arbitrary historical deployment cannot substitute for this list capture. |
| [Get Worker Version](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/) | The beta API returns top-level `id`, `bindings`, compatibility settings and `assets`; the older scripts-version `resources.script_runtime` shape is not substituted. D1 uses documented `database_id`; deprecated `id` is accepted only alongside the same canonical identifier. `latest`, prefix IDs, module content, unknown runtime fields, extra asset settings and an asset upload JWT are rejected. Required-for-this-projection settings must be present even where the broader API makes them optional. |

These checks cover a conservative subset of the documented API. A valid API response outside that subset is rejected for further review, not silently normalized. For example, omitted compatibility flags do not become an empty list, `base_path:"/"` does not disappear, and a null tail-consumer value does not become an empty array.

## Exact unresolved schema gap: secret binding values

The beta Version reference reuses a binding union that describes `SecretText.text`; it also permits `assets.jwt`. That schema alone does not establish how a permitted read returns value-free secret metadata for this account. This module does not assert that a secret's `text` field is optional in the raw Cloudflare response.

Its input is therefore explicitly named `CLOUDFLARE_NON_SECRET_RELEASE_CAPTURES_V1`, a **local capture contract**, not a claim to be an unchanged raw API response. `omittedSecretTextBindings` must list every and only `secret_text` binding whose text is absent. Any present `text` or `value`, even `null`, empty or masked, is rejected; any asset JWT is rejected. Plain-text bindings require their documented text field, but those values never appear in output, errors or the settings digest. Binding values are not verified by this projector.

An independently reviewed, permitted collector still needs to establish value-free response behavior and the integrity/completeness of supplied captures. **Do not fetch secret values in order to redact them.** Do not fill missing fields from screenshots or assumed defaults. If the approved interface cannot produce these inputs, retain the explicit schema/access gap. The supplied `nonSecretCaptureReviewEvidenceDigest` is only an external reference; the projector does not authenticate it.

## Input and output boundary

Call `projectReleaseObservation({captures, externalEvidence, now})` with an explicit millisecond clock. `captures` contains the format tag, account ID, three captures (`worker`, `deployments`, `version`) and the secret-omission names. Each capture has:

- `request`: exact `GET` method, account-scoped path and exact query object; no headers, URL credentials or token.
- `startedAt` and `completedAt`: strict UTC ISO strings with milliseconds.
- `response`: success envelope with empty errors/messages and documented result fields. Error response text is never echoed.

The named Worker GET resolves the immutable ID; the exact-version request must use that ID and the full pinned baseline UUID. All three capture intervals must start after or at the supplied writer-window start, finish before expiry, and fit within the 60-second freshness limit. The normalized observation uses the **earliest collection start**, so a later completion cannot refresh old data. Capture times are caller claims, not trusted timestamps.

`externalEvidence` is separate from captured API fields. It supplies account/Worker/baseline/active-deployment scope, compatibility and master-OFF evidence digests, non-secret capture review digest, and the writer window. Missing or mismatched evidence is rejected. Well-formed digests do not prove their contents, owner approval, effective OFF, exclusivity or account compatibility. The module creates none of those claims. Owner approval remains in the existing adapter's separate approval contract.

The module computes `workerSettingsDigest` only from the supplied, validated Worker response settings and identity, using a versioned canonical SHA-256 input. It does not accept a caller-chosen settings digest. That digest covers **GET Worker settings only**, not routes, Cloudflare Access, build configuration, binding values or the entire account. Those missing coverage areas are explicit unresolved gates in the result; a matching digest is not a comprehensive production readiness check.

`offlineObservation` remains compatible with the original offline adapter's validator and unchanged baseline/candidate pins. Its surrounding result retains unresolved provenance, response-safety, evidence-content, configuration-coverage and transport gates. It must not be detached and relabeled as an authenticated production observation. No runtime Gemini OFF check, full D1 schema audit, candidate retargeting or paid-generation authority is supplied here.

## Focused validation

Run `node --test tests/release-observation-projection.test.mjs`. All captures and evidence in those tests are synthetic. Cases cover time ordering/freshness, writer-window boundaries, immutable identity, active deployment changes, exact endpoint selection, unsupported or missing settings, D1 identifiers, secret/JWT rejection, omission accounting, fixed privacy-safe errors, and explicit absence of provenance/production support.
