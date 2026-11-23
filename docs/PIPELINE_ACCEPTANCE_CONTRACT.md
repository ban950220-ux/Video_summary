# Automatic video-summary acceptance contract

## Completion means a saved, reopenable full-video result

The product goal is a complete owner workflow: enter a supported video link,
obtain the authorized full source, transcribe it, merge the transcript, produce a
coherent whole-video summary, save the result, and reopen it from the analysis
list. A deployed build, a contract test, an existing transcript, an imported
summary or a provider's accepted request is not sufficient evidence for that
whole workflow.

Imported summaries have a separate acceptance track. Their site label is
**기존 전사 기반 가져온 요약**. They can satisfy the manual/imported storage feature
when owner-authenticated saving and later readback work, but cannot satisfy the
automatic `summary` or whole-pipeline completion stage.

This public contract contains no real user summary, transcript, analysis ID,
Library identifier, source filename, production URL, receipt, usage or failure
record. All counts, timestamps, IDs and texts in public fixtures are invented.
Private quality references remain outside the public Git tree.

## Synthetic structural fixture

`scripts/pipeline-acceptance-contract.mjs` checks one synthetic evidence shape.
Its reference is deliberately unrelated to a user's analysis:

| Field | Synthetic value |
| --- | --- |
| Video identity | `synthetic01` |
| Transcript segments | 120 |
| Summary chapters | 12 |
| Audio chunks | 12 |
| Audio duration | 600,000 ms |
| Last segment end | 599,500 ms |
| Reference size marker | 4,096 UTF-8 bytes |
| Reference identity | `SYNTHETIC_FULL_TRANSCRIPT_SUMMARY_V1` |

No media or real summary is represented by that fixture. Its reference byte size
is a test marker, not a content digest or a quality measure. Real acceptance must
use the actual authorized source and independently reviewed summary, with a
chapter structure appropriate to that source. Matching a count alone cannot
prove accuracy, source identity or quality.

The helper only accepts primitive JSON text. It does not invoke arbitrary
getters, proxies or `toJSON`, authenticate callers, contact providers, run SQL or
deploy anything. Even a complete synthetic capture returns:

- `structuralCriteriaSatisfied: true` only for the supplied structure;
- `automaticCompletion: false`;
- `provenanceAuthenticated: false`;
- `productionExecutionSupported: false`;
- zero provider calls and database writes.

Caller-supplied flags and copied receipts cannot change those fixed limitations.

## Stage acceptance

| Stage | Required evidence | What does not establish completion |
| --- | --- | --- |
| `link` | Canonical supported URL and exact video/analysis binding. | A pasted URL or a job ID without source binding. |
| `source` | Authorized automatic acquisition from that link, complete media identity/digest and declared duration. | A native-caption-only result, partial media or a manually supplied audio file presented as automatic acquisition. |
| `transcript` | Every expected chunk durably saved with complete responses; unique ordered segments; source and transcript digests; tail coverage; separate full-audio review. | Timeline coverage, cue count, an HTTP success, or text labelled unverified. |
| `merged` | All expected chunks included once; exact merged text and source/transcript hashes; overlap and boundary ambiguities reviewed. | Concatenating only successful chunks or dropping uncertain boundary text. |
| `summary` | Real automatic-provider provenance and completed operation evidence; exact source/merged/transcript binding; coherent full-video summary and semantic review. | Extractive preview, raw intermediate checkpoints, a manually imported summary, a byte count or a fabricated receipt. |
| `saved` | Durable write/readback, owner-authenticated list and reopen after reload, complete export, unchanged source/history/accounting, resolved uncertainty. | A POST response, an in-memory browser display, a saved transcript with no summary or a cached page. |

### Source and transcript review

Acquisition identity, audio accuracy, transcription processing coverage and
summary quality are different facts. Covering an entire declared timeline does
not show that words were correctly heard or that a speaker was attributed
correctly. Review must bind the exact audio and transcript digests, cover the
full source range, and resolve omissions and boundary ambiguity. Store failures
and uncertainties as such rather than rewriting them to make acceptance pass.

Chunk inventory must match the expected manifest. A smaller newly declared
chunk count cannot disguise missing work. The merge must preserve the transcript
text and the intended ordering, and its digest must bind the input chunk indices
and transcript identity. Any source or content change invalidates old evidence.

### Full-video summary quality

A semantic review must examine the complete current transcript and the complete
summary. It records the reviewer, review time, review-record digest, exact
transcript/report hashes and explicit findings for each criterion:

1. All chapters and distinct material claims are represented without losing a
   substantial part of the source.
2. Causes, consequences, qualifications and negations retain their meaning.
3. Numbers, units, time periods and forecast horizons remain correctly bound.
4. Statements and forecasts remain attributed to the correct speaker or source.
5. Uncertain transcription and other source limits remain visible in the summary.
6. Unsupported new facts are not introduced as if they came from the source.
7. The overview, chapter summaries and conclusion form a coherent account of the
   whole video rather than a bundle of unrelated partial outputs.

For example, in an invented transcript, Speaker A may propose a trial while
Speaker B reports a completed experiment. A summary must not turn the proposal
into a completed result or attribute B's measurement to A. This example is
synthetic and does not describe a user's source.

Each criterion needs a reasoned review finding. A bare `PASS`, a total chapter
count, a byte size, a few sampled cues or a complete-looking time axis is not a
substitute for that review. External fact checking is separate and must not be
claimed unless performed.

### Saved result and owner experience

Read the saved result independently of the mutation response. Confirm that its
parent identity and source/transcript/report digests match the accepted result.
A lost write acknowledgement can be reconciled by exact durable readback; the
record must not claim that the acknowledgement was received when it was not.

Use a fresh owner-authenticated session, find the analysis in the list, open it,
reload, and reopen the same saved summary. Exported summary and transcript must
match the stored accepted content without silently truncating large results.
Existing transcript, provider operation states, failure records, approvals,
receipts and usage history remain unchanged by readback or manual import.

Local browser and temporary-database tests demonstrate local behavior. Actual
production authentication, the current deployed version, bindings, migration
state and operator-visible results need separate verified evidence before a
production completion claim.

## Failure reuse and duplicate-charge prevention

`scripts/pipeline-acceptance-contract.mjs` also exposes a read-only resume-policy
checker. Its output selects a review step; it never authorizes a runtime dispatch.
The operation scope binds analysis ID, stage, logical unit, source identity,
available source/transcript hashes, request hash, model and contract version.
For early stages, future hashes are explicitly absent rather than invented.

| Saved state | Required next action |
| --- | --- |
| Validated `DONE` operation plus exact saved checkpoint and readback | Reuse the same checkpoint without a provider call. |
| Complete preserved response after an uncertain attempt | Review no-call recovery while preserving original failure and cost history. |
| Claimed, reserved, dispatching, pending, running or uncertain result | Read-only reconciliation; no automatic retry or fallback. |
| Completed operation without a verified checkpoint | Reconcile saved state; do not regenerate because a save response was lost. |
| Known local merge/save step | Review stored inputs; no provider call is needed for that step. |
| Proven-not-sent attempt | Require affirmative zero-dispatch evidence and no contradictory response evidence before reviewing a fresh plan. |
| Changed source, transcript, request, model or logical unit | Old checkpoint/approval cannot be reused for the changed scope. |
| Missing, expired, consumed, cancelled or mismatched approval | Block new dispatch. |
| Unknown or insufficient free quota | Block; do not fall back to paid service. |
| New paid plan | Require an exact fresh owner-approved scope and cost cap before any runtime authorization. |

A prior approval expiring does not invalidate free reuse of an already verified
saved checkpoint. It does block a new provider call. A `DONE` label without
complete validated response evidence is insufficient for reuse. Expected costs,
remaining calls and explicit caps must match the exact operation scope at the
atomic runtime claim, not merely in a prior JSON preview.

Repeated clicks, browser reloads and a lost HTTP response must keep the same
logical operation identity. Neither a new request ID nor a provider switch is an
automatic escape from an uncertain prior attempt. No historical receipt,
verification flag or provider success is manufactured to satisfy acceptance.

## Separate imported-summary acceptance

The local imported-summary implementation must meet the following requirements
without changing automatic status:

- Existing owner authentication and same-origin mutation checks remain in force.
- The source snapshot and summary's exact UTF-8 content are independently hashed
  and checked at append time.
- The attachment is separate from `jobs.report_json` and source/provider records.
- Repeated submission deduplicates durably, while changed content or provenance
  with the same request ID conflicts.
- Another owner's analysis cannot be listed, read, modified or inferred through
  the import endpoints.
- Cancellation and lost acknowledgements are resolved through the saved request
  state; automatic resubmission is forbidden.
- A page reload can reopen the persisted imported text and export it intact.
- The provenance is **기존 전사 기반 가져온 요약**, with no new provider success or
  automatic-completion claim.

See `MANUAL_SUMMARY_IMPORT_DESIGN.md` for persistence, race handling, content
limits and the public/private data boundary. The offline preview helper remains
an unauthenticated specification checker even when a separate runtime feature
has been implemented and tested.

## Release and evidence boundaries

No contract test bypasses existing metadata, ETag, version, asset, binding,
settings-preservation, migration or rollback checks. An imported-summary feature
must fail closed when its schema is unavailable; it must not silently create or
alter a production schema during a request. Production deployment, migration and
real owner-site verification are separate steps requiring the applicable scope
and approval.

Automatic completion remains unproven until authenticated evidence demonstrates
all six stages on the actual accepted source and saved result. Local feature
implementation, public code review and deployment progress should be reported
separately so each claim has the appropriate evidence.
