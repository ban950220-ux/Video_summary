# Release handoff import and independent corrections

The release-preparation implementation previously existed only in the owner's
local handoff. This change brings its offline state machine, request compiler and
their exact frozen test artifact into the repository so the same checks can run
in a clean checkout and in CI.

## Provenance and boundaries

- Source archive: `video-release-code-handoff-v1.zip`, SHA256
  `4ea141cae1685b54b594ab6d1cd4040d04f1c174ecb7f777d4e1e3f9df354db9`.
- Original v4 patch: SHA256
  `ac4c75a1a58b32ef32e1c5c3193fe5ae53d377e0957aabdd3e5303797132d34f`.
- Original wire v1 patch: SHA256
  `357e053f8ae44e33c8a5ea6b4b1746e50c12f3bc2d721eee537b0aeb992fa400`.
- Current main at import: `6c3f309c30f270d696fecc581cd928532c767499`.
- All 11 packaged baseline files match that Git commit exactly.
- The original ten changed paths apply cleanly; the imported source patches and
  user archive remain preserved separately from these reviewed corrections.

This code remains an offline proposal. The existing production uploader, deployment
guards, Worker code, D1 schema, Access configuration and credentials are not wired
to it. `productionExecutionSupported` remains false. Test approval fields and
capture fixtures are not real operational authorization or freshness evidence.

## Corrections

1. Asset upload parts now carry explicit HTML, CSS and JavaScript MIME types.
   The imported generic binary type would also become the served type under the
   documented Cloudflare contract. The regression parses the actual multipart
   request and checks every pinned asset's type, bytes and hash name.
2. A write-path metadata snapshot must be collected after the single-writer window
   begins. A still-recent snapshot from before that window is rejected before the
   next write. Historical read-only reconciliation remains possible.
3. Test assets are fixed fixtures rather than `HEAD:web/site` reads. Tests resolve
   the bundle inside the repository instead of depending on an untracked sibling
   folder. A shallow checkout therefore tests the same reviewed bytes.
4. A pure supplied-capture projector validates the supported non-secret Worker,
   deployment and version shapes, their identity and timestamps, and explicit
   omission of secret values. Contradictory supplied pagination metadata is
   rejected. Its result explicitly leaves permission, provenance authentication
   and production execution unverified; it performs no API requests.

## Verification

- Unmodified handoff: 119 individual tests passed, zero failures or skips.
- MIME regression against the imported compiler: one expected failure; corrected
  compiler: all 36 wire tests passed.
- Writer-window regressions against the imported state machine: four expected
  failures out of six; all six pass after correction.
- Combined imported tests plus writer-window regressions: 125 passed, zero failed,
  zero skipped, using Node 24's normal isolated test runner and the default committed
  fixture path.
- Supplied-capture projector: 42 individual tests pass. Five additional pagination
  regression cases first failed against the incomplete consistency checks and pass
  with the correction. The cases use synthetic local captures, not production API
  responses or operational approval evidence.
- Final integrated isolated run: 167 individual tests passed, zero failed and zero
  skipped. The final pagination checks also passed an independent six-case review.
- The original package's runner hit `spawnSync ... EPERM` in the restricted runtime.
  That attempt is not counted as a pass. Acceptance uses the actual individual
  test totals from the permitted offline test run.

## Exact artifact reconstruction and PR39

Both candidates were built with lock-matched Wrangler 4.149.0 and esbuild 0.28.2 in
dry-run mode. The environment had no account credentials; a preload denied network
calls. One attempted network call per build was blocked. No upload or promotion
occurred. Every esbuild source input and all eight asset files were compared with
the corresponding Git commit.

The main candidate reconstructs the original frozen `site-worker.js` exactly:
897,758 bytes, SHA256 `8d83ed98f2416ab26bfc99d51ed3d1686a93ee9e22db8bffd585e3aee2a3f031`.

PR39 at `f4c6d880c72c8565158090640dadfc4236d80405` produces a distinct 897,932-byte
Worker and changes `web/site/app.js`. Its module payload and asset manifest digests
are recorded in `PR39_RELEASE_ARTIFACT_COMPARISON.json`. It is intentionally rejected
by the old candidate contract. Updating a label or automatically replacing the
old pins with current HEAD would create incorrect provenance.

## Remaining operational gate

The old frozen candidate is not a deployment authorization for PR39. Actual use
still requires a separately reviewed candidate contract, legitimately captured
current exact metadata and evidence, and a reviewed authenticated executor. A
supplied-capture projector can validate shape and consistency, but cannot grant
permission, authenticate a caller's evidence or resolve a policy-denied read.

The prior operational snapshot verified stored transcript readback only. It did
not prove a final AI summary was saved, the effective hidden Gemini flag, or a fresh
deployment baseline. No fixture or offline test result replaces those checks.

## Current-code integration

The owner requested integration and release of the current code on 2026-10-27.
PR39 at `f4c6d880c72c8565158090640dadfc4236d80405` is merged into this proposal's
branch without changing the frozen main fixture or its old contract. The two
application changes and their regression tests retain their exact reviewed bytes.
Any real deployment must build the final merged commit's `src/site-worker.mjs`
and `web/site` assets through the existing guarded production path. The old
`tests/fixtures/release-reviewed-6c3f309` payload is test input only and is never a
production release candidate for this integrated code.

The source merge does not satisfy the separate live metadata, settings preservation,
authenticated execution or exact-version verification requirements. CI deliberately
continues to assert that the release gate is blocked without those current inputs.
