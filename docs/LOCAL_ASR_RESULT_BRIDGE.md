# Owner-submitted local ASR result bridge

This follow-up connects an existing local ASR result to one authenticated
owner's analysis, then reuses the existing transcript and structured-summary
routes. It does not acquire YouTube audio, run an ASR model, provision a worker,
or make a summary provider free. The UI states that the audio worker is not
connected. Receiving a transcript does not start a summary request.

## Workflow and honest states

An analysis whose URL acquisition stopped at `NO_CAPTIONS` can create an audio
request. It remains `WAITING_FOR_WORKER` until the owner submits matching
acquisition/result evidence. The UI can also create a record from a selected
owned MP3 or PCM WAV with the explicit **existing local ASR result** mode. That
mode hashes the selected original file, preserves the submission identifier,
creates the analysis record, and opens the bridge. It does not upload that audio
to a provider or automatically request an audio plan.

| Route under `/api/jobs/:id` | Purpose |
| --- | --- |
| `GET /audio-request` | Read state, source snapshot, context, and receipt. |
| `POST /audio-request` | Create/reuse a request after rights and local-only confirmation. |
| `POST /audio-request-bind` | Pin owner-submitted media identity and measurement evidence. |
| `POST /audio-request-cancel` | Cancel the identified request and revision. |
| `POST /asr-result` | Validate and atomically receive the matching transcript. |

`SOURCE_BOUND` means the owner-submitted media metadata is pinned to the request.
`RESULT_STORED` requires matching stored transcript and receipt hashes.
`EXPIRED`, `CANCELLED`, and `SOURCE_REVIEW_REQUIRED` are distinct from success.
The request lifetime is one hour. A new request after expiry or cancellation
uses a new request identifier and the latest analysis snapshot. A cancelled or
expired request cannot accept a late result.

The owner may explicitly retrieve a summary plan after source readback. A
separate confirmed action runs one existing summary step under its current
approval, capacity, source, and format checks. Subsequent steps need another
explicit action. An existing report opens without generation. The bridge
requests `approved-four-part-v1` and checks persistence and the exact transcript
binding before displaying an approved-format result. Structural acceptance does
not establish semantic quality or audio accuracy.

## Identity, duration, and provenance

The result binds the analysis ID, request ID, revision, analysis source snapshot,
source binding digest, original file digest, normalized WAV digest, PCM digest,
raw transcript digest, input segment digest, and normalized stored-source digest.
The original file, WAV container, and headerless PCM have separate SHA-256
identities. The adapter verifies that decoding the complete original produces
the exact PCM bytes in the supplied ASR input.

Four time measurements have different meanings:

- The analysis retains the user's declared duration unchanged.
- Original-container duration and start time come from local `ffprobe`.
- ASR input duration comes from the actual mono 16 kHz PCM sample count.
- The last transcript cue is a speech boundary, not a full-video duration.

The time axis is `NORMALIZED_AUDIO_FRAME_ZERO`. The measured PCM duration keeps
its fractional precision. Transport segments use nearest integer milliseconds,
with an end bound of `Math.round(asrInput.durationMs)`. The producer's original
JSON timestamps remain untouched. Producer v1 merge times have six decimal
places in seconds; verification permits only that rounding error at measured
EOF, not an additional unprocessed interval.

URL jobs also require the matching video identity, canonical URL, official
duration, and metadata digest. These fields remain owner-submitted claims until
a separately reviewed acquisition worker verifies them. The offline adapter in
this change deliberately accepts owned-audio contexts only. It rejects a URL
context instead of relabelling an unrelated public recording as YouTube audio.

The stored provenance is `OWNER_SUBMITTED_LOCAL_ASR`. Source accuracy remains
`UNVERIFIED`, and identity is `OWNER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED`.
Coverage of all input samples does not prove that every spoken word was
recognized, that no nonsilent interval was omitted, or that the text is correct.
An owner-submitted result is not a provider execution receipt. Model name and
version remain declared metadata; this bridge does not independently rerun the
producer.

## Offline file preparation

The CLI requires already-installed Node, Python 3 standard library, `ffprobe`,
and `ffmpeg`. It does not install packages, download models, use a network
protocol, contact the application, write a database, or perform ASR inference.
Save the request context from the owner UI and keep all real media, transcript,
context, and delivery files outside the public repository.

```sh
node scripts/prepare-local-asr-result.mjs \
  --original /private/original.mp3 \
  --asr-input /private/normalized.wav \
  --manifest /private/asr/manifest.json \
  --merged /private/asr/merged.json \
  --context /private/audio-request-context.json \
  --model producer-declared-model \
  --engine-version producer-declared-version \
  --out /private/owner-asr-delivery.json \
  --evidence /private/offline-evidence.json
```

A PCM WAV may replace the original MP3. Format selection follows the file
content; the normalized ASR input must be a mono 16 kHz PCM S16LE WAV. Both
decoder programs are restricted to local `file,pipe` protocols and fixed input
formats. Output files use exclusive creation and private permissions; existing
files are not overwritten. Diagnostics return codes and counts instead of
transcript text or private paths.

The accepted producer manifest is the existing `pipeline_version: 1.0.0`
format with CPU, word timestamps, numbered cached chunks, and the
`word_midpoint_core_ownership` merge. The adapter checks contiguous sample/core
coverage, chunk identities, raw merged words, overlap decisions, and cache
hashes. It recomputes the producer configuration identity using isolated Python
standard-library JSON on the original manifest bytes, preserving distinctions
such as `60.0` and `60`. Changing a manifest's input hash cannot silently reuse
old cache identities.

Adjacent ASR word pieces without a whitespace boundary are grouped into one app
segment so that adding a space cannot alter the raw transcript. The exact raw
string is retained separately. Edited reference text cannot replace raw ASR
text while retaining its previous hashes.

The delivery document has exactly two members, `source` and `result`. The UI
validates its UTF-8 byte size and hashes, previews its content, and asks for
explicit source binding and transcript receipt. Only `revision` and
`sourceBindingSha256` are filled from the successful current binding response;
the transcript and engine fields are not rewritten. The whole document is
limited to 2,000,000 bytes; stored raw plus normalized segments are limited to
1,500,000 UTF-8 bytes and 20,000 segments.

## Persistence, races, and recovery

No new schema or migration is introduced. Existing `yta_operations` records use
the dedicated `local-asr-result-v1` namespace and zero units. They do not use a
provider `DONE` state, debit usage, manufacture a paid receipt, or modify an
existing transcript or report. Source storage is insert-only. Existing audio,
provider, and runner work prevents conflicting receipt writes.

The existing owner and same-origin authentication checks still surround every
route. Final write predicates recheck owner, deletion, request generation,
revision, expiry, source snapshot, and an empty source slot. Transcript, job
audit, and receipt writes are in one database batch. The conditional writes form
a `changes()`-guarded chain ending in an SQL assertion; a zero-row
compare-and-set fails inside SQL so the batch rolls back. Throwing only after a
successful batch would not provide this property.
The receipt's complete hash is also pinned in the job audit.

Cloudflare documents D1 `batch()` as sequential statements in a transaction,
rolling back the sequence on a statement failure. The code uses a
`first-primary` session when available for the write and receipt readback.
Session consistency is not a transaction lock. See the official
[D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
and [read replication/session documentation](https://developers.cloudflare.com/d1/best-practices/read-replication/).
Local SQLite adapters use a local transaction to model this contract; no SQLite
`BEGIN IMMEDIATE` is sent to remote D1 by this implementation or its tests.

An uncertain response triggers state readback, not an automatic new request or
provider execution. Repeating an identical received result returns its existing
receipt without changing text or records. A different result, old generation,
foreign owner, cancelled request, or mismatched digest cannot overwrite it.
The existing analysis deletion path clears operation payloads; delayed callbacks
cannot restore deleted source data.

## Validation boundaries

Repository tests contain generated tones, invented transcripts, synthetic owner
identities, mocked providers, and temporary SQLite databases. They separately
exercise the owner route, browser controller, decoder/file verifier, duplicate
and cancellation races, uncertain responses, and approved-format persistence.
Mocked four-part summary tests prove wiring and structure, not provider quality.

A private runtime harness can supply real existing ASR files to those application
routes with providers disabled, close and reopen its temporary DB, and compare
the stored bytes and hashes. Its real inputs, delivery JSON, context, IDs, and DB
are not public fixtures. A separate report must identify whether this real-data
trial was actually executed; this document alone does not claim such execution.

This change does not establish an always-running audio worker, live YouTube
acquisition, long-recording accuracy, actual provider summary quality, production
D1 transaction behavior, production screen behavior, or deployment readiness.
Existing release, migration, preservation, owner-only, and exact-version gates
remain separate requirements.
