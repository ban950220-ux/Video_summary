# Complete Groq synthesis review branch

This branch is an offline implementation and review candidate. It does not run
Groq, migrate D1, deploy, or authorize a new synthesis call. The current main
deployment and the owner's existing raw-stage run are separate work.

## Evidence and state model

`GET /api/jobs/:id/groq-summary-complete` classifies every current raw stage.
Validated `DONE` checkpoints remain AI output. A `FAILED_UNCERTAIN` /
`SUMMARY_RESPONSE_INVALID` stage remains failed even if the owner records an
exact source excerpt for it. `GET ?stage=raw:N` shows its source IDs, time,
literal transcript, source hash, audit hash, failed result hashes, and token
usage evidence. `POST step=register-excerpt` requires explicit owner review and
writes a separate `groq-summary-excerpt` operation with zero units. It binds the
full excerpt, original failure JSON, token-unit ledger and current audit/source
snapshot with a conditional insert, then reads its result back. It never
changes a failed operation, usage event, existing approval, or dispatch lock.
Raw:8 and raw:9 are independent gaps. Registration can occur while later raw
stages remain pending, but no full synthesis readiness is asserted until every
stage has one validated checkpoint or reviewed source excerpt.

Content substitution and network/usage uncertainty require separate reviews.
The excerpt attestation does **not** establish a complete provider receipt,
actual remaining Groq quota, or permission to resume raw or synthesis calls.
The historical usage table lacks an operation ID foreign key, so equal token
counts plus provider/provenance are evidence but not a unique per-call receipt.
No clearance or synthesis dispatch endpoint is added here.

The independent `abbreviated-year-source-preserving-v1` offline candidate is
for the observed raw:9 `2022년`/`2023년` versus source `22년`/`23년` mismatch.
It only derives source spelling from exact cited source IDs and times. It
records the original response hash, failed-result hash, source/audit hash,
confirmed usage, every changed field and source-text hash, and derived-report
hash. Ambiguous source spelling, an extra unsupported number, an incorrect
evidence ID, or a different token unit fails closed. It never infers a century
from a two-digit year. The actual private 1,827-character response was not
available to this workspace, so this synthetic test does not establish that
the production response passes. No production recovery row is written.

## Bounded composition and completion

`groq-complete-synthesis-v1` builds one coverage manifest from the ordered
source segments. It requires each segment to appear exactly once in a raw
stage, with that stage backed by an AI checkpoint, audited derived checkpoint,
or reviewed verbatim source excerpt. A changed source, missing stage, duplicate
ID, failed grounding, altered report hash, or altered excerpt/recovery record
blocks completion. The manifest checks source coverage. It does not by itself
prove that a paraphrase has the correct meaning.

Every full detail item is preserved in the report appendix. Compact evidence
notes split large source text into ordered fragments while retaining the full
detail in the appendix. Two notes are merged at a time. The code checks the
actual serialized request body plus 512 bytes against 4,800 and caps each
response at 1,800 tokens; a validated node must also fit the next merge input
bound. Each saved node is bound to the exact request, response and node hashes
and can be revalidated in order after a lost response. No missing node starts
a model call automatically. Numeric/quote grounding and both child ranges are
checked for every response. A separate owner meaning review tied to the
manifest and root hashes is required for finalization; external fact checking
remains unperformed.

The compact 79-stage synthetic fixture makes 79 bounded notes and 78 binary merges:
78 × (4,800 + 1,800) = **514,800 conservatively reserved tokens**, requiring
at least **3** approval windows at 29 calls/window. Longer real checkpoints
may split into more notes. The read-only quote estimate derives its call count,
total reservation and minimum windows from the actual saved notes, never from
79 alone. It does not claim known account balance, elapsed time, or free quota.
A second fixture spans the video's 98:12.864 timeline with 1,226 segments in
79 raw stages and completes the same offline manifest, tree, report and TXT
checks. Both fixtures are synthetic and do not contain the private transcript.

After validated synthesis nodes and owner meaning review, the no-provider-call
finalizer writes `jobs.report_json` conditionally, reads it back exactly, and
uses the existing owner-only TXT export. The final report and TXT distinguish
the AI synthesis, detailed AI checkpoints, audited derived checkpoints, and
owner-reviewed source excerpts, including their failure uncertainty. Offline
tests seed synthetic saved model nodes in SQLite and exercise the actual app
reopen and TXT routes. There is no production synthesis quote, approval,
guarded executor, or usage-recording path on this branch; therefore the final
route cannot advance a real job from notes to complete model synthesis yet.
Those paths need a separate security review with source/key/approval,
duplicate, local-limit, pacing, failure-clearance and usage guards before any
provider call. No migration is needed for this proposal: the existing
`yta_operations`, `usage_events`, and `jobs.report_json` columns suffice.

The browser gap runner now asks the durable status endpoint after a failed
gap read. If it can see raw:9's saved `SUMMARY_RESPONSE_INVALID`, it displays
that stage and error. If a new read fails too, it retains the last server
error separately from the read error and never resends automatically.
