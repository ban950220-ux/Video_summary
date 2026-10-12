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
inferred from the adapter path and requires human review. No final summary is
saved, and production login/reopen of a completed summary and TXT export have
not been accepted as a complete end-to-end result.

## Remaining acceptance

1. Complete the independent code and remote baseline review. Confirm the
   owner-only Access policy, existing D1 binding, free-only settings, secret
   names, and the exact production Worker version. The approved GET-only
   diagnostic finished without deploying, and the Cloudflare Builds command
   is back at `npm run deploy:production`; do not start a production build
   before separate rollout authorization. Do not copy credential values.
2. Use the existing job's preserved D1 transcript and failed response. Inspect
   the old response hash and 2,220-token usage, the old and new `raw:0` segment
   ID/time ranges, and the strict schema diagnostic. Record human review,
   then separately approve at most one new Groq Free call with a 4,800-token
   input bound, 1,800-token completion cap and 6,600-token reservation.
   Account free balance remains `UNKNOWN`; confirm billing is disabled and
   there is no paid or Gemini fallback. Do not treat the old approval as new
   authorization.
3. Run the new first stage only after the reviewed rollout. A timeout,
   unknown result or invalid response leaves a durable lock and must not be
   automatically retried. A successful first stage must not start another
   stage automatically. Review each later window and free capacity before any
   further calls.
4. Require a coherent Korean report with chapter and original segment evidence
   covering the full 98-minute timeline. Check numerical claims, speaker
   uncertainty, gaps and partial markers against the preserved source.
   Evidence ID validation alone does not prove factual accuracy.
5. Verify the final report and full source after a fresh owner login and page
   reload, search by video ID/title, export TXT, and read back the corresponding
   D1 job, source and operation ledger. Only then mark the video end-to-end
   summary accepted. Retain the PC and Library originals; temporary service
   audio/result cleanup needs its separate explicit confirmation.

Code and mocked Chromium/SQLite/Workerd tests are development evidence, not
proof that the remaining real summary, deployment and login/export steps
succeeded.

## Review-branch verification (mock only)

On 2026-10-12, `npm run check` and all 244 local tests passed. Workerd D1
tests injected stored Groq key rotation, a deletion marker, an audit change,
and pilot approval cancellation immediately before the final single-statement
dispatch guard; each blocked the provider mock with zero calls and kept the
old failed operation intact. Local Chromium exercised separate review,
approval and one-call execution; slow responses, double clicks, tab changes,
reopening, lost POST responses, and a successful POST followed by failed GET
all produced zero automatic follow-up calls. The expired approval UI offered
status review rather than a new approval. These tests did not call production.
