-- A client generated submission UUID remains bound to one owned-audio request.
-- The jobs primary key is the concurrent insert arbiter. Existing rows stay NULL.
ALTER TABLE jobs ADD COLUMN submission_hash TEXT;
