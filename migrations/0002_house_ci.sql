-- Margin confidence intervals (schema.sql already includes these for fresh installs).
ALTER TABLE forecasts ADD COLUMN dem_margin_p10 REAL;
ALTER TABLE forecasts ADD COLUMN dem_margin_p90 REAL;
