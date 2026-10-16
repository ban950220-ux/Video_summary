# Groq recovery scope diagnostic: local change only

The observed message "기존 복구 기록과 현재 근거가 다릅니다" is thrown by
`checkpointRecoveryContext` when a saved recovery row is not DONE or its exact
serialized record differs from the record reconstructed from current evidence.
That reconstruction binds source, audit, contract, failed response and result,
usage event, legacy pilot evidence, optional approval evidence, and report.
The available production observations identify this comparison boundary, not
which field changed. It is not evidence that the Groq quota is exhausted.

The production job's differing field is still unknown. The local fixture tests
prove that the diagnostic can distinguish source, audit, and serialization
changes; they do not identify the field in the production database.

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
Its output is limited to row order, state, JSON/hash shape checks, and a key
registration boolean. It returns no operation IDs, hash values, timestamps,
report contents, or credential values. Shape checks alone cannot establish
which current evidence differs; use the owner-scoped diagnostic comparison for
that determination.

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

Before changing any recovery configuration or migrating a row, verify within
the protected operational review the owner-scoped job ID, recovery operation
ID and state, the recorded contract hash, and the diagnostic's fixed-field
comparison against current evidence. Do not export recovery operation IDs or
hash values through the metadata SQL or a diagnostic response.
For each mismatch, verify the persisted source and audit revision, the original
failed operation state and result hash, its usage event ID and token count, and
any pilot or approval record used by that recovery. Establish the intended
contract version and why the stored and recomputed forms differ. If only byte
ordering differs, preserve both representations and require a reviewed
migration; canonical equality alone does not authorize execution. Separately,
confirm the currently registered app key's organization/project using provider
account evidence without displaying or replacing the key, then confirm Free
eligibility and capacity before any new model request. The console's Free plan
and model limits alone do not bind the app key to that organization.

No deployment, production setting update, key change, database mutation,
retranscription, Gemini request or model generation is part of this work.
