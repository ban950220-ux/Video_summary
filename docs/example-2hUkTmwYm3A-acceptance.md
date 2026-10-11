# Full-video acceptance plan: 2hUkTmwYm3A

The acceptance target is the complete user-supplied video, approximately
98m12.864s, not a 30-minute transcript or the 2% fixture. The owned full MP3
was previously inspected locally: 56,076,980 bytes, MP3 frame duration
5892.888s, 20 planned chunks, and 5949.672s of uploads including overlap.
These numbers prove slicing only. No real provider call or full summary has
been completed.

1. After separate rollout approval, confirm the protected `holy-rice-b914`
   production version, owner-only Cloudflare Access, existing `DB` binding,
   runtime variable/Secret **names**, and `ALLOW_PAID_API=false`. Keep
   `ENABLE_LIVE_FREE=false` until the specific free-only execution is approved.
   Do not publish credential values.
2. Transfer the already owned full MP3 from Library in the authorized workflow.
   Check its byte size/hash against the selected file, duration, every MP3 frame,
   20 chunk boundaries, <=8 MB per chunk, and overlap before any upload. The
   scanner now rejects a large unparsed tail. Use the full file and the same
   analysis ID when resuming; a short fixture is not acceptable evidence.
3. In the provider consoles, check that Groq and Gemini billing and automatic
   recharge are disabled, the account is free-only, and the *current* remaining
   allowance and request count cover the proposed calls. The app's grant is an
   owner attestation, not an independent provider balance check. For the known
   MP3, Groq requires 20 requests and at most about 5,970 reserved audio seconds
   after per-chunk rounding; confirm the exact plan before setting a grant.
   Grants expire after one hour. If no safe verified allowance is available,
   stop before calling a provider. Do not enable paid API calls.
4. Create one audio job, save its full 20-chunk plan, and upload each chunk once.
   `audio-progress` shows `DONE` chunks; the browser skips those on resume.
   A blocked quota reservation can resume after a fresh verified grant without
   repeating completed calls. A timeout or uncertain provider outcome is
   deliberately not retried: inspect provider usage and the operation record
   before choosing a new job. Only run `audio-finish` when all 20 are `DONE`.
5. Review the saved source, its first and last timestamps, gap warnings, and
   transitions at all chunk boundaries. All planned chunks processed does not
   prove every spoken word was captured. Listen to suspicious or silent spans;
   mark the transcript incomplete if the content is missing.
6. Call `summary-plan` for the *full* stored source. It reports the number of
   raw groups and first-pass conservative Gemini units without sending content.
   The later synthesis cost is unknown until intermediate reports exist. Each
   request is capped below the 250,000-unit app grant. If the first pass exceeds
   one grant, explicitly approve staged processing and refresh a verified
   free-only grant as needed. Each stage has a durable operation ID, so a
   completed stage is reused after interruption. Invalid or uncertain results
   are not automatically called again. No input segment is silently dropped.
7. Require a final coherent Korean report with a chapter and original segment
   evidence from every raw group. Review the meaning of citations, coverage
   across the whole 98-minute timeline, numerical claims, speaker uncertainty,
   and any gap or partial markers. Existence of an evidence ID is not factual
   verification. Reject a report that treats partial transcription as full.
8. Confirm the same report and full source can be reopened after a fresh login
   and page reload, searched by video ID/title, and exported. Verify the D1
   job/source records and operation ledger show one successful provider call
   per completed chunk/stage, with no automatic replay. Only then report the
   actual example as accepted; local test/CI success is not this acceptance.

Current blockers: rollout has not been approved or performed, the full MP3 has
not been transferred into this environment, provider free-plan status and
remaining quotas are not independently verified, and the 98-minute transcript
and final report have not been generated or inspected. Hosted Worker resource
limits and production persistence still need the above live acceptance.
