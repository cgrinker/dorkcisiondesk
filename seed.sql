-- Seed data for the 2026 cycle.
-- Apply after schema.sql: wrangler d1 execute elections --local --file=./seed.sql
--
-- !! VERIFY BEFORE TRUSTING TOPLINES !!
-- Partisan leans are approximate (recent-presidential-margin based, Dem margin
-- points). Incumbent/open status reflects retirements announced through
-- mid-2025 and should be re-checked against the final candidate field.
-- Governor races are not seeded yet.

-- The national environment "race" — generic-ballot polls attach here.
INSERT OR IGNORE INTO races (id, cycle, type, state, partisan_lean, incumbent_party, region) VALUES
  ('generic-2026', 2026, 'generic', NULL, 0, NULL, NULL);

-- 2026 Senate: Class 2 plus OH/FL specials.
INSERT OR IGNORE INTO races (id, cycle, type, state, partisan_lean, incumbent_party, region) VALUES
  ('sen-2026-AL', 2026, 'senate', 'AL', -30, 'open', 'south'),
  ('sen-2026-AK', 2026, 'senate', 'AK', -15, 'R',    'west'),
  ('sen-2026-AR', 2026, 'senate', 'AR', -30, 'R',    'south'),
  ('sen-2026-CO', 2026, 'senate', 'CO',  10, 'D',    'west'),
  ('sen-2026-DE', 2026, 'senate', 'DE',  15, 'D',    'northeast'),
  ('sen-2026-GA', 2026, 'senate', 'GA',  -1, 'D',    'south'),
  ('sen-2026-ID', 2026, 'senate', 'ID', -35, 'R',    'west'),
  ('sen-2026-IL', 2026, 'senate', 'IL',  13, 'open', 'midwest'),
  ('sen-2026-IA', 2026, 'senate', 'IA', -12, 'open', 'midwest'),
  ('sen-2026-KS', 2026, 'senate', 'KS', -20, 'R',    'midwest'),
  ('sen-2026-KY', 2026, 'senate', 'KY', -30, 'open', 'south'),
  ('sen-2026-LA', 2026, 'senate', 'LA', -22, 'R',    'south'),
  ('sen-2026-ME', 2026, 'senate', 'ME',   5, 'R',    'northeast'),
  ('sen-2026-MA', 2026, 'senate', 'MA',  25, 'D',    'northeast'),
  ('sen-2026-MI', 2026, 'senate', 'MI',   0, 'open', 'midwest'),
  ('sen-2026-MN', 2026, 'senate', 'MN',   4, 'open', 'midwest'),
  ('sen-2026-MS', 2026, 'senate', 'MS', -18, 'R',    'south'),
  ('sen-2026-MT', 2026, 'senate', 'MT', -20, 'R',    'west'),
  ('sen-2026-NE', 2026, 'senate', 'NE', -20, 'R',    'midwest'),
  ('sen-2026-NH', 2026, 'senate', 'NH',   2, 'open', 'northeast'),
  ('sen-2026-NJ', 2026, 'senate', 'NJ',  10, 'D',    'northeast'),
  ('sen-2026-NM', 2026, 'senate', 'NM',   7, 'D',    'west'),
  ('sen-2026-NC', 2026, 'senate', 'NC',  -3, 'open', 'south'),
  ('sen-2026-OK', 2026, 'senate', 'OK', -33, 'R',    'south'),
  ('sen-2026-OR', 2026, 'senate', 'OR',  12, 'D',    'west'),
  ('sen-2026-RI', 2026, 'senate', 'RI',  15, 'D',    'northeast'),
  ('sen-2026-SC', 2026, 'senate', 'SC', -17, 'R',    'south'),
  ('sen-2026-SD', 2026, 'senate', 'SD', -28, 'R',    'midwest'),
  ('sen-2026-TN', 2026, 'senate', 'TN', -28, 'R',    'south'),
  ('sen-2026-TX', 2026, 'senate', 'TX', -12, 'R',    'south'),
  ('sen-2026-VA', 2026, 'senate', 'VA',   6, 'D',    'south'),
  ('sen-2026-WV', 2026, 'senate', 'WV', -40, 'R',    'south'),
  ('sen-2026-WY', 2026, 'senate', 'WY', -45, 'R',    'west'),
  ('sen-2026-OH-special', 2026, 'senate', 'OH', -10, 'R', 'midwest'),
  ('sen-2026-FL-special', 2026, 'senate', 'FL', -12, 'R', 'south');

-- Pollster quality/house effects come from Silver Bulletin's ratings:
-- run `npm run ratings`, then apply data/pollster-ratings.sql.
-- Unknown pollsters auto-register at quality 0.5 during ingestion.
