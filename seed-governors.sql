-- 2026 gubernatorial races (36 states; territories not modeled).
-- Apply after seed.sql:
--   wrangler d1 execute elections --local --file=./seed-governors.sql
--
-- !! VERIFY BEFORE TRUSTING TOPLINES !!
-- Partisan leans are approximate (recent-presidential-margin based, Dem
-- margin points). Incumbent/open reflects term limits and retirements known
-- through mid-2025 — re-check against the final fields. Candidates are NOT
-- seeded here; the Ballotpedia watcher harvests them (FEC is federal-only).

INSERT OR IGNORE INTO races (id, cycle, type, state, partisan_lean, incumbent_party, region) VALUES
  ('gov-2026-AL', 2026, 'governor', 'AL', -30, 'open', 'south'),      -- Ivey term-limited
  ('gov-2026-AK', 2026, 'governor', 'AK', -15, 'open', 'west'),       -- Dunleavy term-limited
  ('gov-2026-AZ', 2026, 'governor', 'AZ',  -2, 'D',    'west'),
  ('gov-2026-AR', 2026, 'governor', 'AR', -30, 'R',    'south'),
  ('gov-2026-CA', 2026, 'governor', 'CA',  25, 'open', 'west'),       -- Newsom term-limited
  ('gov-2026-CO', 2026, 'governor', 'CO',  10, 'open', 'west'),       -- Polis term-limited
  ('gov-2026-CT', 2026, 'governor', 'CT',  12, 'D',    'northeast'),
  ('gov-2026-FL', 2026, 'governor', 'FL', -12, 'open', 'south'),      -- DeSantis term-limited
  ('gov-2026-GA', 2026, 'governor', 'GA',  -1, 'open', 'south'),      -- Kemp term-limited
  ('gov-2026-HI', 2026, 'governor', 'HI',  25, 'D',    'west'),
  ('gov-2026-ID', 2026, 'governor', 'ID', -35, 'R',    'west'),
  ('gov-2026-IL', 2026, 'governor', 'IL',  13, 'D',    'midwest'),
  ('gov-2026-IA', 2026, 'governor', 'IA', -12, 'open', 'midwest'),    -- Reynolds retiring
  ('gov-2026-KS', 2026, 'governor', 'KS', -20, 'open', 'midwest'),    -- Kelly term-limited
  ('gov-2026-ME', 2026, 'governor', 'ME',   5, 'open', 'northeast'),  -- Mills term-limited
  ('gov-2026-MD', 2026, 'governor', 'MD',  25, 'D',    'northeast'),
  ('gov-2026-MA', 2026, 'governor', 'MA',  25, 'D',    'northeast'),
  ('gov-2026-MI', 2026, 'governor', 'MI',   0, 'open', 'midwest'),    -- Whitmer term-limited
  ('gov-2026-MN', 2026, 'governor', 'MN',   4, 'D',    'midwest'),
  ('gov-2026-NE', 2026, 'governor', 'NE', -20, 'R',    'midwest'),
  ('gov-2026-NV', 2026, 'governor', 'NV',   0, 'R',    'west'),
  ('gov-2026-NH', 2026, 'governor', 'NH',   2, 'R',    'northeast'),
  ('gov-2026-NM', 2026, 'governor', 'NM',   7, 'open', 'west'),       -- Lujan Grisham term-limited
  ('gov-2026-NY', 2026, 'governor', 'NY',  15, 'D',    'northeast'),
  ('gov-2026-OH', 2026, 'governor', 'OH', -10, 'open', 'midwest'),    -- DeWine term-limited
  ('gov-2026-OK', 2026, 'governor', 'OK', -33, 'open', 'south'),      -- Stitt term-limited
  ('gov-2026-OR', 2026, 'governor', 'OR',  12, 'D',    'west'),
  ('gov-2026-PA', 2026, 'governor', 'PA',  -1, 'D',    'northeast'),
  ('gov-2026-RI', 2026, 'governor', 'RI',  15, 'D',    'northeast'),
  ('gov-2026-SC', 2026, 'governor', 'SC', -17, 'open', 'south'),      -- McMaster term-limited
  ('gov-2026-SD', 2026, 'governor', 'SD', -28, 'R',    'midwest'),
  ('gov-2026-TN', 2026, 'governor', 'TN', -28, 'open', 'south'),      -- Lee term-limited
  ('gov-2026-TX', 2026, 'governor', 'TX', -12, 'R',    'south'),
  ('gov-2026-VT', 2026, 'governor', 'VT',  30, 'R',    'northeast'),
  ('gov-2026-WI', 2026, 'governor', 'WI',   0, 'open', 'midwest'),    -- Evers retiring
  ('gov-2026-WY', 2026, 'governor', 'WY', -45, 'R',    'west');
