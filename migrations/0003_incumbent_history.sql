-- Candidate-history term (schema.sql includes this for fresh installs).
-- Dem-minus-Rep margin of the incumbent's most recent win in this same
-- race, when that same person is running again. NULL = no usable history.
ALTER TABLE races ADD COLUMN incumbent_last_margin REAL;
