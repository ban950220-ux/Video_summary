-- READ ONLY. No transcript, credential, report, response, or raw result JSON.
-- Run using the existing authorized D1 session; do not repair/reset these rows.
WITH records AS (
 SELECT id,provider,state,created_at,
 CASE WHEN json_valid(result_json) THEN result_json ELSE '{}' END AS safe_json,
 json_valid(result_json) AS valid_json
 FROM yta_operations
 WHERE job_id='a69c6a73-6aa6-4ccb-a912-1fab0c35d6a9'
 AND provider='groq-summary-recovery'
)
SELECT id AS recovery_operation_id,state,created_at,valid_json,
 CASE WHEN length(json_extract(safe_json,'$.contractHash'))=64 AND json_extract(safe_json,'$.contractHash') NOT GLOB '*[^a-f0-9]*' THEN json_extract(safe_json,'$.contractHash') END AS recorded_contract_hash,
 CASE WHEN length(json_extract(safe_json,'$.sourceSha256'))=64 AND json_extract(safe_json,'$.sourceSha256') NOT GLOB '*[^a-f0-9]*' THEN json_extract(safe_json,'$.sourceSha256') END AS recorded_source_hash,
 CASE WHEN length(json_extract(safe_json,'$.auditSha256'))=64 AND json_extract(safe_json,'$.auditSha256') NOT GLOB '*[^a-f0-9]*' THEN json_extract(safe_json,'$.auditSha256') END AS recorded_audit_hash,
 CASE WHEN length(json_extract(safe_json,'$.failedResultSha256'))=64 AND json_extract(safe_json,'$.failedResultSha256') NOT GLOB '*[^a-f0-9]*' THEN json_extract(safe_json,'$.failedResultSha256') END AS recorded_failed_result_hash,
 CASE WHEN length(json_extract(safe_json,'$.responseSha256'))=64 AND json_extract(safe_json,'$.responseSha256') NOT GLOB '*[^a-f0-9]*' THEN json_extract(safe_json,'$.responseSha256') END AS recorded_response_hash,
 CASE WHEN length(json_extract(safe_json,'$.evidenceHash'))=64 AND json_extract(safe_json,'$.evidenceHash') NOT GLOB '*[^a-f0-9]*' THEN json_extract(safe_json,'$.evidenceHash') END AS recorded_evidence_hash,
 json_type(safe_json,'$.approvalId')='text' AS has_approval_id,
 json_type(safe_json,'$.approvalResultSha256')='text' AS has_approval_result_hash,
 json_type(safe_json,'$.usageEventId')='text' AS has_usage_event_id,
 json_type(safe_json,'$.report')='object' AS has_report_object,
 (SELECT count(*) FROM json_each(safe_json)) AS record_field_count
FROM records ORDER BY created_at,id;

-- This proves only that a key registration exists and when it was updated.
-- The schema stores no organization/project mapping or registration history.
SELECT provider,updated_at AS current_registration_updated_at,
 'ORG_PROJECT_MAPPING_NOT_STORED' AS project_binding_evidence
FROM provider_credentials WHERE owner_id='owner' AND provider='groq';
