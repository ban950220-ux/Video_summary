# Two-pass result acceptance (local patch)

Base: `2ac2a7f1a4d70c10c98bc8443b755c78e499e55d`. This patch is separate
from draft PR #27 and does not change its branch.

The second Gemini response still settles into the review ledger. A `PASS`
does not automatically publish it. The owner may make a separate no-provider
`gemini-two-pass-accept` POST only after acknowledging that this is a summary
of the stored transcript and that transcription accuracy, human semantic
review and external fact checks remain unverified. Review issues or absence
of a substantive content window block it. Validated transcript-gap windows may
be saved with an explicit partial-source label and gap ranges; they establish
absence of stored transcript, never silence in the original audio.

Acceptance recomputes the source/audit scope and validates both settled
receipts, usage estimates and the first report against the stored transcript.
The final `jobs.report_json` write is conditional on unchanged job, source,
two-pass ledger, both receipt hashes/usage records and no deletion marker.
The report carries its source/audit/second-receipt hashes and explicit quality
flags. A lost acknowledgement can be reconciled without another model call;
the second ledger update is retried only after an identical stored report is
observed. The existing owner GET and TXT export then read this same report.

The quote's prompt audit hash is retained for compatibility with stored requests.
A separate `sourceAssessmentSha256` from the status response binds acceptance to
the entire stored audit, source text, segments, provenance, source type and duration.
The final write checks source type and duration along with the raw audit and source.
Acceptance does not rewrite the source audit.

Saved reports use `STORED_TRANSCRIPT_SUMMARY` and `summaryCompletion: COMPLETE`.
The ledger's `COMPLETE` marks the acceptance workflow. The public job retains
`PARTIAL_TRANSCRIPT` or `TRANSCRIPT_UNVERIFIED`; neither processed audio chunks
nor a declared `FULL_TRANSCRIPT_VERIFIED` audit establishes independent accuracy.
The report preserves the declared audit, measured timestamp range, provenance,
audit consistency and explicit unverified audio/full-source/timestamp fields.
Missing source audit metadata allows a conservatively labelled summary; a missing
or malformed entire audit fails the existing source/receipt validation.

GET, list, status and TXT compare the current source with the accepted snapshot.
Changes produce `STALE_SOURCE` and `SOURCE_REVIEW_REQUIRED` without rewriting the
historical report. TXT does not attach historical evidence IDs to new timestamps.
List reads process at most five sources at a time and retain only lightweight list
results between batches. A page of 50 accepted reports uses 11 D1 queries total;
full source content is never returned by the list endpoint.

The Workerd D1 fixture exercises full, partial, missing, contradictory and malformed
audit metadata; audit-only changes before acceptance; atomic final-save races;
post-acceptance source, provenance, timestamp, duration and type changes; idempotent
recovery; and 50-report list query count. UI tests check the displayed caveats,
source-assessment binding and rendering of partial/stale saved reports.

The Workerd D1 fixture uses two synthetic model responses. Local tests do not
prove that real Gemini responses are accurate, that a user has reviewed the
audio, that the current production credential or approval is valid, or that
this patch is deployed. Validation results are reported with the final handoff;
no production/provider action ran.
