# Local media acquisition module

## Scope and base

Separate local delta from merged main `b20a797e196398ed5010205c8575f6c64d562d8e`, tree `8d6c0b4cd3b69001a063975df99f0befad4c33ab`. The local equivalent base commit is `3393930dcbbeb53f3467aa1b974ba96d921805f9`. Reviewed PR26–30 files are preserved in that base. This delta has not been independently reviewed, pushed or deployed.

`prepareLocalMedia(options)` in `scripts/local-media-acquisition.mjs` connects these existing boundaries:

1. Acquisition contract: canonical single YouTube URL, public/non-live metadata, explicit local acquisition consent, fixed 7,200 second and 128 MiB limits.
2. Pinned executable adapter: version check, metadata inspection, source acquisition with exact argument arrays and `shell:false`.
3. Audio conversion: existing mono/16 kHz MP3 conversion command; acquired source hash is retained separately from converted MP3 hash.
4. Chunk validation: existing MP3 frame planner and byte slices; each exact chunk hash and time/byte range is recorded.
5. Local storage: existing runner manifest/checkpoint plus `runner-acquisition.json` provenance.

The output is `LOCAL_MEDIA_READY`, with `transcriptComplete:false`, `summaryComplete:false` and `providerCalls:0`. Existing provider, summary, verification and final report contracts remain separate.

## Input and execution contract

The caller supplies a new dedicated empty work directory, UUID job/request IDs, executable absolute paths and SHA-256 pins, a foreground callback and optional AbortSignal. Consent has exactly: `kind=LOCAL_MEDIA_ACQUISITION_CONSENT_V1`, `jobId`, `requestId`, `canonicalUrl`, `rightsConfirmed=true`, `maxDurationSeconds=7200`, `maxSourceBytes=134217728`, and integer UTC-millisecond `expiresAt` within the next hour. Unknown fields are rejected. This authorizes local acquisition only; provider approval is separate.

Command templates disable inherited configuration, plugins, browser cookies, retries, overwrite, automatic continuation and automatic media fixup. Metadata stdout contains a selected JSON field set. Raw metadata URLs, formats or unrelated fields are not persisted. Supported yt-dlp templates and `--fixup never` are documented in the [official README](https://github.com/yt-dlp/yt-dlp#output-template).

The downloader limit and post-download size check do not prove a hard network-byte ceiling when a server omits size metadata. Actual public availability/extractor behavior is still untested. Login, cookies, paywalls and access-restriction workarounds are outside this module.

## Resume and failure behavior

The existing cross-process lock protects a work directory. Consent, foreground/abort, checkpoint bytes and lock identity are checked again after executable hashing and immediately before spawn. A completed checkpoint verifies acquired source, converted audio and chunk hashes before reuse, making no repeat command.

An incomplete or failed phase becomes `RECONCILIATION_REQUIRED`. Partial files and the last phase are retained; no automatic re-download or conversion occurs. A stopped-process lock may be reviewed with the existing explicit lock recovery API, but removing that lock does not approve repeating an uncertain acquisition. This first module does not yet implement a user-facing partial-file reconciliation flow.

## Evidence and limits

The new tests use real temporary files, exact MP3 frame slices, two real Node processes, a real subprocess cancellation, and the existing manifest/checkpoint APIs. Downloader/encoder outputs are fixtures; the generated frame bytes are synthetic and contain no verified speech. They prove local orchestration, locking, hash checks and stopping behavior, not a successful real YouTube download, audio decoding or transcription.

On this PC yt-dlp was found via the normal command lookup. FFmpeg/ffprobe were not on PATH. Listing the known WinGet FFmpeg package's nested binary directory returned Access denied. It was not retried through another path or escalated, and no tool was installed or downloaded. A normal permitted executable path/hash and real media validation are needed before a live acquisition trial.

Production integration remains outstanding: an authenticated user invocation, the protected outbox job linkage, and the actual outbound Access adapter. Existing runner HTTP remains loopback-only for tests. No login, token persistence, public port, tunnel, provider call, operational DB write or deployment is performed by this delta.

Related regression command:

V1 result on 2026-10-23: **83/83 passed**, including 10 new acquisition tests and existing local Workerd/audio bridge/session tests. Independent review subsequently found the output-format gap below. These are local fixture results, not an operational media or model run.

```text
node --test tests/local-media-acquisition.test.mjs tests/local-runner-session.test.mjs tests/local-runner-outbox.test.mjs tests/local-runner-audio-bridge.test.mjs
```

## V2 output-format correction

Frozen V1 patch SHA-256 `7D89DA781890F51437529C7C27BED8715CA7D5B4CDD7FDA496B5E85912EED2EB` and tree `a91ad19fcde1f6a13af3fe72bc5e6f3d3a049770` remain unchanged. This separate checkout preserves that tree as local commit `447701ca30b3cf3acba3e9e26f3afc463c577595` before the correction.

The independent P2 finding is reproduced: V1 accepted synthetic 44.1 kHz stereo output while the manifest claimed 16 kHz mono. Five regression cases fail on V1: 44.1 kHz stereo, 44.1 kHz mono, 16 kHz stereo, mixed sample rates, and a late channel-mode change.

V2 uses the existing MP3 scanner's actual frame offsets and validates the sample rate and channel mode of every frame before generating any chunk or checkpoint. Nonconforming output raises `RUNNER_CONVERSION_FORMAT_MISMATCH`, preserves acquired/converted bytes and remains `RECONCILIATION_REQUIRED` without automatic repeat. Successful preparation records measured `outputFormat` and frame count. READY reuse also rechecks the actual MP3 header format against the hashed audio, so a historically invalid but internally hash-consistent checkpoint cannot be returned as READY.

Seven new local regression cases include ID3-offset handling and rejection of a historical READY checkpoint whose incorrect audio bytes and all stored hashes agree. This establishes frame-header format only; real decoding, speech quality, FFmpeg behavior and external acquisition remain untested. No shared Worker audio parser, provider route, database migration or operational setting is changed by this correction.
