# Independently decodable local MP3 chunks

Base: main `1745b884981ccc725de5c21aa389e6e26e8f9f10`, tree
`b8aec59427c2d4a0450b68ff77303aab1584b163`. This change is separate from the
schema-baseline registration PR. It changes no Worker, database, authorization,
provider, upload, retry or MP3-parser guard.

## Reproduced failure

An existing private sample was converted with the existing FFmpeg template using
the installed `N-126374-g089a48eb36-20260831` binary. Both the original and complete
converted file decoded successfully. The default low bitrate output began with a
180-byte Info/Lavc frame. The shared metadata correction requires a 190-byte CRC
span and correctly stopped with `MP3_LAME_CRC_SPAN_UNSUPPORTED`. No chunk or
production runner checkpoint was accepted from that attempt. The initial files
and evidence were preserved.

## Minimal contract change

The local conversion template now specifies `-b:a 64k -reservoir 0 -write_xing 0`.
The installed encoder/muxer help confirmed both boolean options are supported.
Disabling reservoir references permits frame slices to decode independently;
omitting whole-file Xing metadata avoids retaining a seek table for the wrong
file. Existing uploads still pass the unchanged shared metadata checks.

At 64 kbit/s, 300 seconds is approximately 2.4 MB and 7,200 seconds approximately
57.6 MB, within existing chunk/file limits. This is an encoding size bound, not a
provider token or cost estimate. The output remains MP3, 16 kHz, mono. No source
speech-accuracy claim is made. Omitting gapless metadata leaves encoder padding;
the measured complete output was about 91 ms longer than decoded source audio.
Timestamp ranges describe the converted audio and do not prove alignment with
the video or any previously stored transcript.

## Verification and limits

- Related acquisition/session/outbox/bridge tests plus the new process-boundary
  regression: 91 passed, zero failed/skipped. Tests reject altered or omitted
  bitrate/reservoir/Xing options before spawn and preserve existing output.
- Actual local sample: 5,892.821354 seconds decoded input; converted output
  47,143,340 bytes, 163,692 frames, all 16 kHz mono, 5,892.912 seconds.
- All 20 existing `planMp3`/`prepareMp3Chunk` chunks decoded independently with
  strict FFmpeg error handling. Maximum chunk size 2,399,904 bytes. Complete
  timeline coverage with the existing planned overlap; no missing range.
- Every chunk hash and the local validation checkpoint were reread; original
  media SHA-256 remained unchanged. No production checkpoint was created.
- Private media, exact local run scripts/logs and source paths are retained only
  in the local workspace, outside this patch.

Real execution covered conversion, decoding and frame chunking of an existing
file. URL acquisition, authentication, upload, external transcription, summaries,
operational database changes and deployment were not performed. Existing runner
fixtures remain fixtures. This patch still requires independent code review
before publishing or deployment.
