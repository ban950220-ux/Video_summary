# Live capacity gate: acceptance criteria

The current Groq audio path has owner-attested app grants, atomic app reservations,
a conservative 6,500-second rolling app-hour cap below the observed 7,200-second
provider-hour limit, and a one-hour app cooldown after HTTP 429. These controls
do **not** establish the provider account's remaining capacity. The observed
7,107 seconds used after five short successful chunks shows why app reservations
alone cannot authorize the next upload. Keep the paused job and its completed
chunks intact while this gap is resolved.

Before any further production audio request is considered capacity-safe:

1. Obtain fresh, account-wide provider-observed remaining capacity and reset
   times for every applicable hourly, daily, request, and token dimension.
   Record source and observation time. An owner-entered free-plan attestation,
   app usage ledger, stale dashboard estimate, or missing dimension is `UNKNOWN`,
   not sufficient capacity. Account for activity outside this Worker.
2. Forecast the next exact chunk's billed upper bound including intentional
   overlap, encoder/container metadata uncertainty, provider rounding, and a
   conservative overhead margin. Compare the bound against every observed
   remaining dimension and the app-local reservation limits before dispatch.
3. If any bound is unavailable or insufficient, persist a pause with the
   limiting dimension and observed reset time. Resume only after a fresh
   observation and renewed free-only authorization. Never replay `DONE` chunks
   or silently retry an uncertain operation.
4. Keep provider provenance for each logical chunk. A future alternate audio
   provider needs its own reviewed adapter, normalized relative timestamps,
   provider-aware attempt history, identity/coverage checks, and cleanup rules.
   AssemblyAI is only a stored-key option today. Gemini summarizes text; it is
   not an approved MP3 transcription fallback. Supadata native captions are
   scoped to URL jobs and cannot currently fill this audio job's missing chunks.

Acceptance tests must cover fresh and stale observations; unknown or externally
changed usage; hourly/day/request/token exhaustion; overlap and overhead;
reset-time pause/resume; successful chunk reuse; 429 without output versus
timeouts/unknown failures; and mixed-provider provenance before any alternate
provider is enabled. The current recovery tests cover only app-local safeguards
and explicit 429 review. The provider-observed dispatch gate is not implemented.

## Desktop-only MP3 metadata check

The frame slicer begins the first chunk at the first MPEG frame, so it drops a
leading ID3 tag but retains any Xing/Info/VBRI header inside that frame. A
synthetic test proves retention, not that this caused Groq's reported usage.
On the owner's PC, read at most the first 1 MiB of the original MP3 to locate
the first frame after ID3, then inspect only that frame's first 256 bytes for
Xing, Info, or VBRI and its declared frame count. Report marker, offset,
declared frame count/duration, and the frame-scan duration of the exact first
upload slice; do not print audio bytes or transfer the file. If `ffprobe` is
available, compare its duration for that exact slice with the frame-scan
duration. Also compare the rejected chunk's exact bytes and frame-scan duration
with Groq's 341/342-second request accounting. This is read-only evidence;
provider billing semantics remain unverified until the provider confirms them.
