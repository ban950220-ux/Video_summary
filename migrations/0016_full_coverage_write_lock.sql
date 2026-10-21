-- A claimed full-coverage provider request pins its source and job audit until
-- the request outcome is durably settled. This applies to every app writer.
CREATE TRIGGER IF NOT EXISTS full_coverage_source_insert_lock BEFORE INSERT ON yta_sources
WHEN EXISTS(SELECT 1 FROM yta_operations WHERE job_id=NEW.job_id AND provider IN ('groq-full-coverage','groq-summary-synthesis') AND state IN ('CLAIMED','RECEIPT_STORED'))
BEGIN SELECT RAISE(ABORT,'FULL_COVERAGE_SOURCE_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS full_coverage_source_update_lock BEFORE UPDATE ON yta_sources
WHEN EXISTS(SELECT 1 FROM yta_operations WHERE job_id=OLD.job_id AND provider IN ('groq-full-coverage','groq-summary-synthesis') AND state IN ('CLAIMED','RECEIPT_STORED'))
BEGIN SELECT RAISE(ABORT,'FULL_COVERAGE_SOURCE_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS full_coverage_source_delete_lock BEFORE DELETE ON yta_sources
WHEN EXISTS(SELECT 1 FROM yta_operations WHERE job_id=OLD.job_id AND provider IN ('groq-full-coverage','groq-summary-synthesis') AND state IN ('CLAIMED','RECEIPT_STORED'))
BEGIN SELECT RAISE(ABORT,'FULL_COVERAGE_SOURCE_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS full_coverage_job_update_lock BEFORE UPDATE OF audit_json,report_json,duration_seconds,source_type ON jobs
WHEN EXISTS(SELECT 1 FROM yta_operations WHERE job_id=OLD.id AND provider IN ('groq-full-coverage','groq-summary-synthesis') AND state IN ('CLAIMED','RECEIPT_STORED'))
BEGIN SELECT RAISE(ABORT,'FULL_COVERAGE_JOB_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS full_coverage_job_delete_lock BEFORE DELETE ON jobs
WHEN EXISTS(SELECT 1 FROM yta_operations WHERE job_id=OLD.id AND provider IN ('groq-full-coverage','groq-summary-synthesis') AND state IN ('CLAIMED','RECEIPT_STORED'))
BEGIN SELECT RAISE(ABORT,'FULL_COVERAGE_JOB_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS full_coverage_proof_update_lock BEFORE UPDATE ON yta_operations
WHEN (OLD.provider IN ('groq-summary','groq-summary-recovery','groq-full-coverage-approval')
 OR (OLD.provider='groq-full-coverage' AND OLD.state='DONE'))
 AND EXISTS(SELECT 1 FROM yta_operations WHERE job_id=OLD.job_id AND provider IN ('groq-full-coverage','groq-summary-synthesis') AND state IN ('CLAIMED','RECEIPT_STORED'))
BEGIN SELECT RAISE(ABORT,'FULL_COVERAGE_PROOF_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS full_coverage_proof_insert_lock BEFORE INSERT ON yta_operations
WHEN NEW.provider IN ('groq-summary','groq-summary-recovery','groq-full-coverage-approval')
 AND EXISTS(SELECT 1 FROM yta_operations WHERE job_id=NEW.job_id AND provider IN ('groq-full-coverage','groq-summary-synthesis') AND state IN ('CLAIMED','RECEIPT_STORED'))
BEGIN SELECT RAISE(ABORT,'FULL_COVERAGE_PROOF_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS full_coverage_proof_delete_lock BEFORE DELETE ON yta_operations
WHEN (OLD.provider IN ('groq-summary','groq-summary-recovery','groq-full-coverage-approval') OR (OLD.provider='groq-full-coverage' AND OLD.state='DONE'))
 AND EXISTS(SELECT 1 FROM yta_operations WHERE job_id=OLD.job_id AND provider IN ('groq-full-coverage','groq-summary-synthesis') AND state IN ('CLAIMED','RECEIPT_STORED'))
BEGIN SELECT RAISE(ABORT,'FULL_COVERAGE_PROOF_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS full_coverage_usage_update_lock BEFORE UPDATE ON usage_events
WHEN OLD.provider='groq' AND OLD.capability IN ('LIVE_FREE_SUMMARY','LIVE_FREE_FULL_COVERAGE')
 AND EXISTS(SELECT 1 FROM yta_operations WHERE job_id=OLD.job_id AND provider IN ('groq-full-coverage','groq-summary-synthesis') AND state IN ('CLAIMED','RECEIPT_STORED'))
BEGIN SELECT RAISE(ABORT,'FULL_COVERAGE_USAGE_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS full_coverage_usage_insert_lock BEFORE INSERT ON usage_events
WHEN NEW.provider='groq' AND NEW.capability='LIVE_FREE_SUMMARY'
 AND EXISTS(SELECT 1 FROM yta_operations WHERE job_id=NEW.job_id AND provider IN ('groq-full-coverage','groq-summary-synthesis') AND state IN ('CLAIMED','RECEIPT_STORED'))
BEGIN SELECT RAISE(ABORT,'FULL_COVERAGE_USAGE_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS full_coverage_usage_delete_lock BEFORE DELETE ON usage_events
WHEN OLD.provider='groq' AND OLD.capability IN ('LIVE_FREE_SUMMARY','LIVE_FREE_FULL_COVERAGE')
 AND EXISTS(SELECT 1 FROM yta_operations WHERE job_id=OLD.job_id AND provider IN ('groq-full-coverage','groq-summary-synthesis') AND state IN ('CLAIMED','RECEIPT_STORED'))
BEGIN SELECT RAISE(ABORT,'FULL_COVERAGE_USAGE_LOCKED'); END;
