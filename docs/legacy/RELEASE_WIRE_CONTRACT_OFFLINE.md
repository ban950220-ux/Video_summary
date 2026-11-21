# Exact release request compiler — offline delta

## What is implemented

`scripts/release-wire-contract.mjs` fills the request serialization gap left by
the reviewed v4 proposal. It constructs local WHATWG `Request` objects for exactly
four existing descriptors: asset upload session, requested multipart asset bucket,
beta version creation, and separate traffic promotion. It never calls `fetch`.
There is no CLI, credential loading, OAuth storage, response reader or production
transport. It is not imported by the application, default deployment script,
production package commands. Repository CI runs its offline tests against the
committed frozen artifact, without activating any production command. `productionExecutionSupported` remains **false**.

The isolated base commit `7e6de2487401d446570b4d60292e3840a0171eb1` has the exact
independently reviewed v4 tree `a33827a8f1c5845ad9c04aaf1c8500edfe892fce`.
The v4 proposal and main deployment guards are unchanged. PR38 is not included.
This delta is only the compiler, its local tests, and this document.

## Fixed artifact and wire contract

- Worker: `holy-rice-b914`, account `fe9d7e2a164274b1ff6cef150a75cb0b`.
- Approved baseline identifier: `adc0e786-5fdf-4daf-bea1-02304de1e1b0`.
  This identifier is historical contract input, not a fresh remote observation.
- Candidate commit `6c3f309c30f270d696fecc581cd928532c767499`, candidate tree
  `d5ac6ab65696e06484809794867610f6658fa97a`.
- Full eight-asset digest
  `09e9fdd7ae49f3753818f7566219db990909f9822fa27d8c2dfef90fca041467`.
- Actual bundled `site-worker.js`: 897758 bytes; module-payload digest
  `e8b67790b2e6eae73d7194c49d2a4f07a52f919816664d4a701c1c75c74e48e1`.

The compiler reconstructs the asset manifest from bytes and refuses synthetic or
altered modules. Each multipart file is the exact base64 encoding of the reviewed
bytes, with the manifest hash as field name and filename. The multipart boundary
comes from `Request`/`FormData`; it is not guessed or put in JSON.
Other bodies are JSON with explicit `deploy=false` or `force=false` in the query.
Preserved bindings use `type: inherit` and the exact baseline `version_id`.
Unknown bindings, value overrides, renames, `latest`, alternate account/path,
extra headers, unreviewed runtime fields, missing assets and byte changes fail.
The compiler supports the official name-or-ID path syntax; this is not evidence
that a particular account/Worker is compatible. The unchanged v4 observation
validator still requires its reviewed identity representation.

The fields follow the previously reviewed official API contract:

- [Asset direct upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
- [Beta version create](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create/)
- [Deployment create](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/)

## Boundaries

This is a serialization boundary, **not an authorization verifier or HTTP client**.
`verifiedCreatedVersionId` is a caller contract; a string alone is not a verified
receipt. The v4 journal must establish `VERSION_VERIFIED` before a real transport
could consume a promotion request. Likewise the compiler cannot establish owner
approval, current metadata, master=false, a writer window, or existing key scope.

Prepared requests expose only fixed metadata and digests through JSON/inspection.
The body and synthetic asset token are held privately until the single
`takeForReviewedTransport()` handoff. That handoff grants no network authority;
its raw `Request` must never be logged. No reusable OAuth authorization is attached.
The asset upload capability is in memory only. Only synthetic tokens are used in
tests. An adversarial same-process caller can extract a handed-off Request or
clone it; this is not a security sandbox or an exactly-once network guarantee.
The reviewed v4 durable operation key, local process lock, write-ahead journal,
fresh observation checks and no-write-retry rule remain the execution controls.
This is not a server CAS, Dashboard writer lock, or Secret-value equality proof.

## Local evidence and reproduction

Run from this isolated clone with Node 24:

```text
node --test tests/release-wire-contract.test.mjs
```

The default fixture is committed at `tests/fixtures/release-reviewed-6c3f309`,
resolved relative to the test file, with an optional `REVIEWED_RELEASE_BUNDLE_DIR`
override for the same pinned bytes. Missing or altered artifacts fail. Tests compare
the actual module digest, all eight manifest entries, and every frozen asset byte.
The frozen files were independently compared with commit `6c3f309` and its locked
Wrangler rebuild during import; current HEAD is never silently substituted.

36 author tests passed: JSON/query/multipart parsing, exact bytes, redacted
inspection, one-time handoff, mutation rejection, defensive copies, actual-bundle
integration through v4's journal and separate promotion, and lost-create-ACK
reconciliation after restart/new approval ID with no repeated write. All server
responses, identities, timestamps and approval claims are **fixtures**. The test
replaces global fetch with a throwing function and performs no remote requests.
It creates local temporary journal files only. Mock `CONFIRMED` is not deployment.

Independent review reproduced mutable nested audit query metadata in the initial
compiler. The actual Request was unaffected, but its displayed evidence could
diverge. The query is now copied and frozen, with an explicit mutation regression.
The fixed compiler passed 19 independent local probes, including all four lost-ACK
phases. Session/upload uncertainty stays blocked; create/promotion reconcile only
through fixture reads and never repeat the write. This certifies the ordinary
JSON descriptor serialization scope only, not account compatibility or execution.

## Remaining actual blocker

The exact metadata GET was denied before execution and has not been resubmitted.
No official exact-action override is present in this task; the user reports no
`/approve` UI. Support case 16969142 is pending, response unknown. This patch does
not resolve that access decision and provides no alternate read route.

Before production use, the authorized metadata read must become supported and
pass, the current exact baseline/master=false/known bindings/API compatibility
and single-writer window must be established, and an authenticated transport and
response projection must be reviewed together with this compiler. No real
authorization record is generated from test callbacks or placeholder digests.
AI/countTokens, transcript transmission, DB/settings changes, upload/promotion,
push and PR creation were not performed. Actual whole-video AI summary,
save/reopen/TXT remains unverified and is not replaced by these fixtures.

## 2026-10-27 asset Content-Type correction

The imported compiler assigned `application/octet-stream` to every multipart file.
Cloudflare preserves each part's Content-Type when serving the asset, so that
blanket type can break JavaScript/CSS loading under this Worker's `nosniff` header.
The compiler now derives MIME from the reviewed asset extension: HTML is
`text/html; charset=utf-8`, CSS is `text/css; charset=utf-8`, and JS/MJS is
`text/javascript; charset=utf-8`. Unknown types or a shared hash with conflicting
types are rejected. Exact file bytes, hashes, artifact pins and runtime metadata
constraints are unchanged.

The regression parses the actual prepared multipart Request and checks all eight
parts against explicit expected browser MIME types. It failed against the imported
compiler and passes after the correction. This is local wire-format verification,
not a claim that live assets were uploaded or served.

Official contract: https://developers.cloudflare.com/workers/static-assets/direct-upload/
