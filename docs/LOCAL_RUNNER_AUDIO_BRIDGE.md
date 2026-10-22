# Local runner audio bridge: offline review candidate

This records the frozen first bridge snapshot. Its BLOCKED-resume limitation
and receipt/finalization implementation are superseded by the separate
`LOCAL_RUNNER_BLOCKED_RESUME.md` delta. Historical test totals below describe
that frozen snapshot; consult the new delivery manifest for the current tree.

## Exact integration order

1. PR28 HEAD `b47729bd79d7905559e756d9d23b42663f7b1370`, source tree
   `d044307f569cea589d8488f08b8457ac9dcd405d`. PR28 remains a separate draft;
   nothing here changes or pushes it.
2. Preserved runner v2 patch
   `0B17369605826058FC196A0B5A15D46F9E00D549B83BC1CCBD6BA550719A2BCB`.
   It originally targets PR26 `2ac2a7f1...`; its ten added files apply cleanly
   after PR28. The combined local baseline tree is
   `a94fc6f5ae8105d12f00ade49a10a7896b6865ca`, local snapshot commit
   `4b7c391a40094dba20d24911979ae46f1867d305`.
3. Apply this bridge delta after that combined baseline. It revises the
   **unapplied proposal** 0018 and adds proposal 0019. If any environment has
   applied an earlier 0018, it requires a separately reviewed ALTER migration;
   rerunning CREATE IF NOT EXISTS will not add `audio_link_manifest_sha256`.

The fixed v3 and v2 patch files are preserved unchanged. No PR, push, migration
of an operational database, deployment, real login/key or provider call is part
of this work.

## Connected flow

`createRunnerAudioHandler` is an unrouted server adapter. It requires a caller
supplied trusted `authenticate(Request)` implementation and defaults to disabled
dispatch. It is not imported by site-worker or its production bundle. The PC
client accepts only `http://127.0.0.1:<port>/`, rejects redirects, and receives
authentication headers transiently from a callback. No actual Cloudflare Access
handoff is implemented or stored.

The local fixture flows through a real loopback HTTP server into the existing
`routeApi` and real Workerd D1:

1. Explicit rights and URL-to-audio linkage confirmation atomically updates the
   same owner job to `source_type=audio`, preserving its original URL and pinning
   its acquired file and manifest hashes. This fixes the outbox URL / free-batch
   audio contract mismatch without generally widening free-batch eligibility.
2. The existing `audio-plan` stores the exact ordered ranges/file hash. Plan
   insertion is now transactional, deletion-aware and replayable after ACK loss.
3. The bridge hashes bounded received bytes before reserving a dispatch. A
   separate unique row binds job, request, manifest, chunk and the actual legacy
   operation ID. Existing `audio-chunk` validates MP3 frames/duration and uses
   its existing quota, capacity, credential-resolution and usage code.
4. The bridge adds a guard at the existing before-dispatch and before-fetch
   callbacks. It checks authentication expiry, cancellation/deletion, lease,
   unchanged approved manifest and approval, live-Free flags and no paid mode.
   Only the actual existing fixed model `whisper-large-v3-turbo` is connected;
   no Gemini or paid fallback is enabled.
5. A `TRANSCRIBED` receipt requires the real audio row, successful operation
   result and existing usage accounting. Unknown model outcomes keep the
   existing reservation and uncertain operation; restarts never resend them.
   A committed audio response with a lost HTTP ACK reconciles by GET, without a
   new provider call. Known pre-dispatch BLOCKED bridge rows currently require
   explicit future recovery work; they are not automatically reopened.
6. Actual `audio-finish` combines the stored chunks and writes source/audit in a
   transaction pinned to their exact row snapshots. It cannot resurrect source
   content after DELETE. GET source and TXT export use the existing APIs.

The resulting state is `TRANSCRIPT_STORED_SOURCE_UNVERIFIED`, with
`summaryComplete:false` and report still null. It does not assert real speech
accuracy or whole-video AI summary completion. A separate guarded summary
approval/execution is still necessary.

## Independent v2 findings addressed

- **F1, concurrent stale READY:** both upload/session drivers hold an exclusive
  per-directory process lock and re-read the checkpoint immediately before
  handoff. Two actual Node processes reproduce the old race; the second now
  stops with `RUNNER_PROCESS_LOCKED`. A post-uncertainty restart never sends.
  Dead process recovery is explicit, exact-nonce and PID-checked. Time alone
  never steals a lock; reused PIDs, permission errors, corrupt locks and stale
  recovery gates require manual review.
- **F2, arbitrary auth fields:** approval validation uses an exact field set and
  storage constructs a canonical record from those fields. Synthetic
  authorization/cookie/apiKey/session extras fail before any D1 record.
- **I1, job-type mismatch:** the explicit source-preserving transition above
  makes existing `audio-free-batch` GET return its correct bounded plan. This
  does not create that Free batch approval or use the unknown-capacity/probe
  route. The bridge still requires the ordinary existing current quota and
  observed-capacity grants before actual chunk dispatch.
- **I2, deletion residue:** after the durable tombstone, actual DELETE atomically
  scrubs runner URL, video ID, manifest, approval body and receipt body. It keeps
  hashes, limits, reservations, operation IDs and uncertainty/accounting state.
  Late writes fail their owner/tombstone predicates.

## Verification and limits

Targeted runner/bridge plus existing live regression suite: 139 tests, 137 pass,
2 FFmpeg skips, zero failures. The fixtures exercise actual local files, two OS
processes, loopback HTTP and Workerd D1; every provider response is synthetic.
The complete local suite passes 614 of 616 tests, with the same two skips and
zero failures. `npm run check` (including the offline production target guard)
and syntax checks for the newly added modules also pass.
They include denied approval/paid mode/quota, byte tampering, cancellation/auth
expiry after claim, concurrent HTTP requests, plan INSERT rollback and ACK loss,
provider uncertainty, source readback/TXT and DELETE before final persistence.

Provider usage is the existing **app-reserved audio-seconds upper bound**, not
an actual provider bill or proof of Free-project membership. A zero micro-USD
proposal is not proof that the connected key cannot be billed. Real credential
organization/billing linkage, remaining capacity, real Access authentication,
actual yt-dlp/FFmpeg acquisition, codec/options and source-to-chunk derivation,
and AI quality remain unverified. The runner reads approved local files; it does
not download here. Audio stays on the user's local disk; server persistence is
transcript/results and usage metadata, not a new remote audio archive.

Only one foreground plan/chunk/finalize transition runs per invocation. There
is no unattended scheduler, automatic retry, credential store or open production
endpoint. This review candidate must not be activated merely because fixtures
pass; real authentication and bounded provider authorization still need their
own supported integration and independent security review.
