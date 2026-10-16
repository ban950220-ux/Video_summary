# Groq recovery scope diagnostic: local change only

The observed message "기존 복구 기록과 현재 근거가 다릅니다" is thrown by
`checkpointRecoveryContext` when a saved recovery row is not DONE or its exact
serialized record differs from the record reconstructed from current evidence.
That reconstruction binds source, audit, contract, failed response and result,
usage event, legacy pilot evidence, optional approval evidence, and report.
The available production observations identify this comparison boundary, not
which field changed. It is not evidence that the Groq quota is exhausted.

## Local fix

Authenticated owner-only GET
`/api/jobs/{id}/groq-summary-recovery-diagnostic` returns bounded metadata even
when the existing status/approval/complete handlers correctly remain blocked.
It inspects at most three recovery rows and reports omitted rows explicitly.
No result/report/source text, credential material, response bodies or tokens are
returned. Comparisons expose only fixed field names and booleans. Canonical
equality helps distinguish serialization order from changed data, but does not
waive the existing exact-byte recovery check. No record is trusted or repaired
by this endpoint; observed DONE rows are not validated completion counts.

The UI exposes "복구 스코프 무호출 진단" on a recovery scope error and in the
stored-source review fallback. The button performs one GET only. Original
scope validation continues to reject status/approval/run/finalization where
evidence differs. No catch-and-continue execution path was added.

`tools/groq-recovery-metadata.sql` supplies an existing-session SELECT-only
alternative for safe metadata collection before any approved future release.
It does not select report contents or any credential values.

## Operational follow-up required

1. Read safe recovery metadata through the existing authenticated D1 session,
   or the diagnostic endpoint after a separately authorized deployment.
2. Identify the mismatched fixed fields. Preserve source, successful checkpoints,
   original failures, recoveries and usage ledgers. Do not reset or rewrite them.
3. Determine whether a contract/schema evolution, serialization difference,
   source/audit change, changed failed response/usage, or record corruption is
   supported by evidence. No cause is assumed in advance.
4. Design any migration or additional immutable review record from that evidence.
   This local change does not restore trust in a mismatched recovery.
5. Verify that the existing app key belongs to the independently confirmed Free
   organization/project before new inference. Provider settings expose only
   configured/updatedAt, and encrypted key-generation proofs establish key
   consistency, not provider organization membership. The current schema has no
   registration history or org/project identity. Never replace/expose a key to
   infer this relationship. No Free-project binding is claimed by this change.

No deployment, production setting update, key change, database mutation,
retranscription, Gemini request or model generation is part of this work.
