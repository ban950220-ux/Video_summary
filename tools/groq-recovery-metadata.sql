-- READ ONLY. Output contains only row order, state, and shape checks.
-- No operation IDs, hashes, timestamps, transcript, report, result JSON, or key material.
-- Substitute __OWNER_SCOPED_JOB_UUID__ in a protected authorized D1 session.
-- Do not commit the substituted query or repair/reset these rows.
WITH records AS (
 SELECT row_number() OVER (ORDER BY created_at,id) AS recovery_row_number,state,
 CASE WHEN json_valid(result_json) THEN result_json ELSE '{}' END AS safe_json,
 json_valid(result_json) AS valid_json
 FROM yta_operations
 WHERE job_id='__OWNER_SCOPED_JOB_UUID__'
 AND provider='groq-summary-recovery'
)
SELECT recovery_row_number,state,valid_json,
 CASE WHEN json_type(safe_json,'$.contractHash')='text' THEN length(json_extract(safe_json,'$.contractHash'))=64 AND json_extract(safe_json,'$.contractHash') NOT GLOB '*[^a-f0-9]*' ELSE 0 END AS valid_contract_hash_shape,
 CASE WHEN json_type(safe_json,'$.sourceSha256')='text' THEN length(json_extract(safe_json,'$.sourceSha256'))=64 AND json_extract(safe_json,'$.sourceSha256') NOT GLOB '*[^a-f0-9]*' ELSE 0 END AS valid_source_hash_shape,
 CASE WHEN json_type(safe_json,'$.auditSha256')='text' THEN length(json_extract(safe_json,'$.auditSha256'))=64 AND json_extract(safe_json,'$.auditSha256') NOT GLOB '*[^a-f0-9]*' ELSE 0 END AS valid_audit_hash_shape,
 CASE WHEN json_type(safe_json,'$.failedResultSha256')='text' THEN length(json_extract(safe_json,'$.failedResultSha256'))=64 AND json_extract(safe_json,'$.failedResultSha256') NOT GLOB '*[^a-f0-9]*' ELSE 0 END AS valid_failed_result_hash_shape,
 CASE WHEN json_type(safe_json,'$.responseSha256')='text' THEN length(json_extract(safe_json,'$.responseSha256'))=64 AND json_extract(safe_json,'$.responseSha256') NOT GLOB '*[^a-f0-9]*' ELSE 0 END AS valid_response_hash_shape,
 CASE WHEN json_type(safe_json,'$.evidenceHash')='text' THEN length(json_extract(safe_json,'$.evidenceHash'))=64 AND json_extract(safe_json,'$.evidenceHash') NOT GLOB '*[^a-f0-9]*' ELSE 0 END AS valid_evidence_hash_shape,
 json_type(safe_json,'$.approvalId')='text' AS has_approval_id,
 json_type(safe_json,'$.approvalResultSha256')='text' AS has_approval_result_hash,
 json_type(safe_json,'$.usageEventId')='text' AS has_usage_event_id,
 json_type(safe_json,'$.report')='object' AS has_report_object,
 (SELECT count(*) FROM json_each(safe_json)) AS record_field_count
FROM records ORDER BY recovery_row_number;

-- Registration does not prove the key's organization or project.
-- The schema stores no organization/project mapping or registration history.
SELECT EXISTS(SELECT 1 FROM provider_credentials
 WHERE owner_id='owner' AND provider='groq') AS groq_key_registered,
 'ORG_PROJECT_MAPPING_NOT_STORED' AS project_binding_evidence
;
