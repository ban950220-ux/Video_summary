# Local runner outbox: offline implementation slice

This separate patch is based on `2ac2a7f1a4d70c10c98bc8443b755c78e499e55d`
(PR26). It is not stacked on PR27 or the Gemini finalization integration.
The original C02428EE4AC0CABE1E1B91A0FFB68A7346AAE10EFFF39D51FF399A7C0D37F99A
patch remains preserved. V2 expands the local implementation; migration 0018
and these modules are **not wired to an HTTP route, application bundle or
deployment**. Tests use real temporary files, real child processes and local
Workerd D1, with synthetic media bytes and metadata. No video download,
transcription, external upload, authentication persistence or provider call runs.

The intended control path is an owner-authenticated site outbox, polled by a
user-operated PC process over outbound HTTPS. No public localhost server,
tunnel, open port, new service token, or stored browser credential is included.
The owner and runner still need an approved, supported authentication handoff
before an HTTP route or unattended polling may be enabled.

The outbox stores a canonical YouTube ID and one request ID per job. It uses a
revision-checked lease and heartbeat. A crashed local acquisition can be
reclaimed after lease expiry. Once external dispatch might have happened, the
row becomes `DISPATCH_UNCERTAIN` and no other runner can claim it. Unknown
provider results require reconciliation against the existing audio operation
ledger before any separate approval. V2 deliberately blocks
`completeFromStoredReport` with `RUNNER_REPORT_VERIFIER_NOT_CONNECTED`: the
initial check accepted arbitrary report JSON and an empty source. A real
source-bound settled summary ledger must be connected before completion exists.

The manifest contract binds job ID, canonical URL/video ID, acquisition method,
tool versions, audio SHA-256/size/duration, conversion options and the ordered
chunk hashes/times. Its builder hashes existing task-local files. A separate
ffprobe comparison against the reported duration and codec is still required.
The PC command adapter accepts only fixed argv templates and locally pinned
tool SHA-256 values, uses `shell:false`, and passes a minimal child environment.
The batch approval contract binds job/request ID, provider,
model, manifest/source hashes, chunk list, maximum calls, calculated micro-USD
cap and expiry. This contract alone is not billing proof or authorization to
call a provider; the existing server-side audio guards must enforce it at each
dispatch. Historical example job `a69c6a73-…` already has a 1,226-segment
transcript and should use its stored source rather than the acquisition queue.

Remaining implementation before a safe end-to-end run: owner route and PC
authentication, tool invocation orchestration and ffprobe checks, durable
audio storage and real audio/provider receipts, exact integration with
`audio-plan`/`audio-chunk`/`audio-finish`, server-side bounded batch dispatch
and expiry checks, and final summary readback/export. Access-restricted, private, live,
playlist and over-two-hour videos fail closed. No login or access bypass is
implemented.

## V2 local connection and evidence

- `local-runner-session.mjs` creates a task-local checkpoint without credentials
  or lease data. A new process can read it; each resume hashes the audio and all
  chunks again. It compares the exact bytes immediately before handoff. Writes
  use a synced temporary file and rename. This handles process interruption;
  arbitrary storage corruption/power-loss durability is not guaranteed. Invalid
  checkpoints stop, and initial creation never overwrites an existing file.
- Before transfer the checkpoint records `UNCERTAIN`. After response loss it
  reads the matching server receipt; it never resends an uncertain chunk with
  no durable receipt. A confirmed receipt reconciles without another upload.
  This is intentionally conservative: a request that never reached the local
  transport can still require manual reconciliation.
- The in-process D1 transport hashes actual bytes and atomically checks the job,
  owner, URL/duration snapshot, empty source/report, tombstone, lease, approval,
  expiry, chunk count and integer cost ceiling. Concurrent same-chunk requests
  share one receipt and one reservation. This is not deduplication across
  different jobs/request IDs, and these reservations are not provider usage.
- The D1 receipt is `UPLOAD_RECEIVED_PROVIDER_NOT_DISPATCHED`, stores hashes and
  metadata only, and has `providerCalls:0`. **It does not durably store audio or
  mean transcription succeeded.** The only dispatch method throws
  `RUNNER_PROVIDER_NOT_CONNECTED`; there is no provider callback to enable by
  supplying a permissive approval. A zero micro-USD approval is not Free proof.
- Cancellation revokes the batch. Source/report/deletion checks are also in the
  final INSERT, so cancellation or deletion during an earlier read cannot admit
  another chunk. Existing receipt/accounting metadata remains; actual deletion
  integration must additionally scrub proposal manifest/URL data. No production
  deletion behavior is claimed for an unapplied, unrouted migration.
- Authentication comes from an injected server context on each call and after
  awaited reads; SQL checks expiry against its execution time too. Fixtures
  simulate expiry and refresh. There is no real Access handshake or auth cache.
- Real child-process tests use the installed Node binary as a pinned test shim,
  preserving the media-tool argv arrays. They verify literal shell characters,
  minimal child environment, tool hash mismatch, timeout and output caps. They
  do **not** prove yt-dlp/FFmpeg versions, decoding, extraction or YouTube access.
- URL validation rejects ambiguous IDs and lexical traversal before URL
  normalization. Manifest validation binds request ID and ordered chunk range,
  hash and size; unknown fields, gaps and non-progressing ranges are rejected.

Focused V2 fixtures: 25 passed, 0 failed. Full suite on this PR26-based proposal:
561 tests, 559 passed, 2 skipped, 0 failed; `npm run check` and dashboard build
passed. These counts are separate from PR28's 570-test CI. Fixtures cover disk restart in a separate
process, committed receipt ACK loss, unknown transfer, auth expiry during a D1
read, post-scan file modification, same-chunk concurrent admission, competing
lease takeover, stale nonce, no approval, expired approval, independent call/
cost limits, cancel/delete/tombstone/owner/source/report races at the final D1
INSERT, malformed manifests, argv safety, process timeout/output cap and
unconnected provider/final-report rejection. All media/model data is synthetic.

This is a local review candidate, not independently reviewed or deployed. Actual
HTTP upload and storage, batch execution/usage accounting, bounded free-project
credential binding and end-to-end summary completion remain separate work.
