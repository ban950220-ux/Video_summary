# Explicit zero-dispatch resume and bridge review corrections

## Fixed base

This delta applies after the frozen bridge patch
`D1AE54A7E95401DCD89E1B7F900D92ADFDB7BD38D76B9CF42894F6FD1A879802`.
The local snapshot commit is `e8c803fb2e0d49938634c6532a87419f464c479a`,
tree `e1937368bf6ff6f4f4cd26a4e4bfaf89809a1d24`. The earlier PR28,
runner v2 and bridge patch files are unchanged. This is an offline candidate;
it is not part of the PR26/27/28 release chain.

## Zero-dispatch proof

Proposal migration 0020 adds an attempt ID to the dispatch row and two new
tables for attempts and single-use resume approvals. Existing BLOCKED rows
receive no fabricated proof and cannot use this path.

An attempt starts PREPARED. Immediately before the external fetch it must
persist FENCED and pass the current authentication, lease, original approval,
optional resume approval, source/job and live-Free guards. A FENCED attempt can
never become PROVEN_ZERO, even if the final guard prevented the fetch. Database
ACK loss, process death and uncertainty therefore stop rather than imply a safe
retry.

After a known pre-fetch failure, PROVEN_ZERO requires all of:

- No send fence, no uncertain/in-flight operation or deletion marker.
- Confirmed app quota release (or confirmed no reservation) and known capacity
  reservation outcome. A refund ACK loss is insufficient.
- A still-planned/paused exact audio chunk, an absent operation or eligible
  BLOCKED operation with no response, and consistent job usage versus DONE
  operations. The proof captures operation/usage metadata and exact chunk state.
- An atomic comparison of that snapshot when the proof is saved and again when
  an explicitly approved resume is claimed. Earlier proof rows stay preserved.

Observed-capacity reservations remain conservative; this path does not reset
them. It does not assert provider billing or organization membership.

## Explicit action

The ordinary restart still stops on UNCERTAIN. A separate
`resumeBlockedRunnerAudioSession` action requires foreground confirmation,
unchanged verified local files and a newly supplied allowlisted
`LOCAL_AUDIO_BLOCKED_RESUME_V1` approval. It uses the existing process lock.
The server's `resume-blocked` endpoint records approval without making a model
request. A subsequent chunk request consumes it atomically, at most once.

The new approval has its own UUID and binds the proof hash, blocked attempt,
original approval hash, job/request, original file and ordered chunk hashes,
provider/model, original call/cost caps and a deadline no later than the still
valid original approval. Expired original approval, broader budget, changed
model/body or different chunks require a separate new-consent workflow; this
delta does not implement such a workflow. Cancelled/deleted jobs cannot reopen.

Approval ACK loss may replay the same approval ID. A chunk ACK loss must use
receipt reconciliation, never re-send the model request. Two local processes
are serialized; independent HTTP clients also contend on one durable claim.
The old generic audio route cannot bypass this contract on a runner-linked job.

## Separate bridge findings B1 and B2

- **B1:** the real Groq audio adapter returns a SHA-256 computed from its input
  bytes. A runner receipt requires that same hash in both persisted operation
  and audio result, the exact request/manifest/chunk/operation dispatch row,
  its FENCED attempt and matching approval evidence. Previously stored unbound
  legacy results are not adopted. There is no implicit adoption endpoint.
- **B2:** the final audio-source transaction now compares the duration,
  source type and source URL used by validation, in addition to existing
  audit/report/ordered-chunk/deletion checks. A last-moment change prevents
  source insertion and cannot store stale complete-coverage audit values.

DELETE also clears the new approval/proof bodies while retaining IDs, digests
and uncertainty/accounting metadata. No old source, receipt or usage ledger is
deleted to enable a retry.

## Verification and remaining limits

Tests use real Workerd D1, loopback HTTP, local files and two Node processes;
all provider responses are synthetic. Separate regressions cover B1 unbound
different-byte results and B2 duration/source changes at final CAS, alongside
resume concurrency, exact consent, no-proof history, settlement ACK loss,
unknown responses, expiry, cancellation, deletion and approval/chunk ACK loss.
Exact test totals and patch/tree identities are in the delivery manifest.

The handler remains unrouted in production and the client remains loopback-only.
Real authentication, URL acquisition, source-to-chunk derivation, Free-project
key linkage and actual provider execution remain unverified. The completed
fixture ends at source storage/readback/export with accuracy UNVERIFIED and
summaryComplete=false. Neither this delta nor the historical bridge alone is
ready for deployment before independent review and CI.
