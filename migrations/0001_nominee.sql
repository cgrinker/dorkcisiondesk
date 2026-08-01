-- Nominee tracking (schema.sql already includes these for fresh installs).
-- Apply to existing databases:
--   wrangler d1 execute elections --local --file=./migrations/0001_nominee.sql
ALTER TABLE candidates ADD COLUMN nominee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE polls ADD COLUMN dem_candidate_id INTEGER REFERENCES candidates(id);
ALTER TABLE polls ADD COLUMN rep_candidate_id INTEGER REFERENCES candidates(id);
