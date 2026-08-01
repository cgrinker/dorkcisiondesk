-- D1 schema for the election model.
-- Apply with: npm run db:init (local) / npm run db:init:remote

CREATE TABLE IF NOT EXISTS pollsters (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  -- Quality grade mapped to a numeric weight in [0,1]; 0.5 for unknown pollsters.
  quality REAL NOT NULL DEFAULT 0.5,
  -- Estimated house effect in points of Dem margin (positive = leans Dem).
  -- Recomputed by the model from each pollster's deviation vs. the consensus.
  house_effect REAL NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,            -- e.g. 'sen-2026-GA', 'gov-2026-TX', 'generic-2026'
  cycle INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('senate','governor','house','generic')),
  state TEXT,                     -- 2-letter code, NULL for generic ballot
  district INTEGER,               -- house only
  -- Partisan lean of the state/district in Dem margin points (Cook-PVI-like, e.g. R+5 => -5).
  partisan_lean REAL,
  incumbent_party TEXT CHECK (incumbent_party IN ('D','R','I','open')),
  region TEXT,                    -- for correlated regional error (northeast/south/midwest/west/...)
  notes TEXT
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id),
  name TEXT NOT NULL,
  party TEXT NOT NULL,
  incumbent INTEGER NOT NULL DEFAULT 0,
  -- Set once the primary is called (POST /admin/nominee). While a race has
  -- no flagged nominee for a party, all matchup polls count; once flagged,
  -- polls testing primary losers are excluded from the model.
  nominee INTEGER NOT NULL DEFAULT 0,
  fec_id TEXT,
  raised_usd REAL,                -- from FEC, refreshed by fundamentals scraper
  UNIQUE (race_id, name)
);

CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id),
  pollster_id INTEGER NOT NULL REFERENCES pollsters(id),
  start_date TEXT NOT NULL,       -- ISO date
  end_date TEXT NOT NULL,
  sample_size INTEGER,
  population TEXT CHECK (population IN ('lv','rv','a','v')),  -- likely/registered/adults/voters
  dem_pct REAL NOT NULL,
  rep_pct REAL NOT NULL,
  -- Which specific candidates the poll tested (NULL for generic ballot or
  -- when the name match was ambiguous). Lets the model drop hypothetical
  -- matchups involving primary losers once nominees are known.
  dem_candidate_id INTEGER REFERENCES candidates(id),
  rep_candidate_id INTEGER REFERENCES candidates(id),
  sponsor_party TEXT,             -- 'D'/'R' if partisan-sponsored, else NULL
  source_url TEXT,
  -- Dedup key: same pollster+race+field dates+numbers = same poll.
  dedup_key TEXT NOT NULL UNIQUE,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_polls_race ON polls(race_id, end_date);

-- National fundamentals time series (generic ballot average, approval, econ index).
CREATE TABLE IF NOT EXISTS fundamentals (
  series TEXT NOT NULL,           -- 'generic_ballot','pres_approval','econ_index'
  date TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (series, date)
);

-- One row per race per model run.
CREATE TABLE IF NOT EXISTS forecasts (
  run_id TEXT NOT NULL,
  race_id TEXT NOT NULL REFERENCES races(id),
  dem_margin_mean REAL NOT NULL,  -- expected Dem margin, points
  dem_margin_sd REAL NOT NULL,
  -- 80% interval on the margin from the simulation distribution.
  dem_margin_p10 REAL,
  dem_margin_p90 REAL,
  dem_win_prob REAL NOT NULL,
  poll_weight REAL NOT NULL,      -- how much of the blend came from polls vs fundamentals
  n_polls INTEGER NOT NULL,
  PRIMARY KEY (run_id, race_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,            -- ISO timestamp
  n_sims INTEGER NOT NULL,
  summary_json TEXT NOT NULL      -- topline: seat distributions, majority probabilities
);
