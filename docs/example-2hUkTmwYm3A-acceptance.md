# Full-video acceptance: 2hUkTmwYm3A

## Confirmed production state (2026-10-12 handoff)

The user-supplied 98m12.864s MP3 has SHA-256
`DDCA27C16C14F8D9AE48CBFBDC5FB09B93779E2DDBA4BAC184907C612A15CAB7`
and 56,076,980 bytes. The existing owner job
`a69c6a73-6aa6-4ccb-a912-1fab0c35d6a9` has completed all 20 of 20
transcription chunks. Its 1,226 timed segments and combined TXT were saved to
D1 and read back. This status comes from the verified production handoff; the
current code checkout does not contain the private MP3 or D1 transcript.
Re-uploading the MP3 or repeating transcription is not a prerequisite for
the remaining summary work.

The first Groq summary request was sent once. Its `raw:0` operation is
`FAILED_UNCERTAIN` with `SUMMARY_RESPONSE_INVALID`. The saved response is
valid JSON whose top-level `summary` is a string where an evidence-linked
array was required. The recorded usage is 2,220 tokens (1,258 input, 962
output, including 74 reasoning). The previous approval is stopped. A separate
`finish_reason` receipt was not saved; completion of the response envelope is
inferred from the adapter path and requires human review. After separate
owner review and one-call approval, a new strict-contract `raw:0` request
returned a valid 1,954-character JSON report with 4 summary items, 20 chapters
and a 66-character conclusion for segments 1–20 (0–90.602 s). Schema,
grounding and range checks passed, but the operation ended
`FAILED_UNCERTAIN` / `SUMMARY_CHECKPOINT_TOO_LARGE` because a hypothetical
two-report merge exceeded the 4,800 conservative input bound. The new call
used 2,169 tokens (1,157 input, 1,012 output, including 59 reasoning).
Both failures and usage events must remain intact. No final summary is saved,
and production login/reopen of a completed summary and TXT export have not
been accepted as a complete end-to-end result.

The offline size reproducer uses the reported shape and length, not the
private response text. Its 1,954 UTF-16 characters are 4,234 UTF-8 bytes;
the strict schema contributes 807 bytes to the request body. Repeating the
report in the hypothetical self-pair produces an 11,357-byte request body,
plus the existing 512-byte safety margin = 11,869, or 7,069 above 4,800.
These are exact numbers for the synthetic fixture, not a byte measurement of
the private production response. The prompt's “500 characters” instruction
does not enforce a schema length limit, and the 1,012 output tokens reported
by Groq are a different unit from this conservative UTF-8 input bound.

## Remaining acceptance

1. Complete the independent code and remote baseline review. Confirm the
   owner-only Access policy, existing D1 binding, free-only settings, secret
   names, and the exact production Worker version. The approved GET-only
   diagnostic finished without deploying. Confirm the Cloudflare Builds command
   and exact remote baseline before any production build; do not start one
   before separate rollout authorization. Do not copy credential values.
2. Review the proposed no-call recovery of the new stored response. Its
   source, owner job, strict contract hash, response hash, original failed row
   and 2,169-token usage must all match. The old 2,220-token failure and the
   new 2,169-token failure remain unchanged. Recovery records a separate
   checked checkpoint and does not approve or start another model request.
3. After a reviewed rollout, separately approve each further Groq Free window.
   The app retains the 4,800 conservative input bound, 1,800 completion cap,
   6,600 reservation ceiling, 61-second pacing and daily cap. Account free
   balance remains `UNKNOWN`; confirm billing is disabled. A timeout or
   unknown result leaves a durable lock and must not be automatically retried.
4. Require a coherent Korean report with chapter and original segment evidence
   covering the full 98-minute timeline. Check numerical claims, speaker
   uncertainty, gaps and partial markers against the preserved source.
   Evidence ID validation alone does not prove factual accuracy. For a long
   source or an oversized valid checkpoint, the proposed offline code can
   expose every validated raw report as a separate read-only
   `RAW_CHECKPOINT_BUNDLE` with its own contract and hash. It retains chapters,
   summary items, references and conclusions in time order; it does not save
   `jobs.report` or complete the requested single full-video synthesis.
   Bundles above 1 MB stop for review instead of truncation.
5. Verify the final report and full source after a fresh owner login and page
   reload, search by video ID/title, export TXT, and read back the corresponding
   D1 job, source and operation ledger. Only then mark the video end-to-end
   summary accepted. A bundle export is an intermediate artifact and does not
   satisfy this final-report acceptance. Retain the PC and Library originals; temporary service
   audio/result cleanup needs its separate explicit confirmation.

Code and mocked Chromium/SQLite/Workerd tests are development evidence, not
proof that the remaining real summary, deployment and login/export steps
succeeded.

## Review-branch verification (mock only)

On 2026-10-12, the earlier review commit passed `npm run check` and 249 local tests. Workerd D1
tests injected stored Groq key rotation, a deletion marker, an audit change,
and pilot approval cancellation immediately before the final single-statement
dispatch guard; each blocked the provider mock with zero calls and kept the
old failed operation intact. Local Chromium exercised separate review,
approval and one-call execution; slow responses, double clicks, tab changes,
reopening, lost POST responses, and a successful POST followed by failed GET
all produced zero automatic follow-up calls. The expired approval UI offered
status review rather than a new approval. Additional SQLite and Workerd D1
tests revalidated a synthetic stored 1,954-character report without a model
call, retained both usage records, and kept the recovery write separate from
later approval and execution. A 1,226-segment / 90-checkpoint fixture retained
all 1,226 chapter references in a separate read-only bundle and TXT export,
without a final `jobs.report` row.
These tests did not call production.
