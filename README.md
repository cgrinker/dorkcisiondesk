# elections

A Nate Silver-style election forecasting model for the 2026 midterms, running
entirely on Cloudflare Workers: cron-triggered scrapers feed a D1 database,
a scheduled model run does correlated Monte Carlo simulation, and the latest
forecast is served as cached JSON from the edge.

## Architecture

```
cron (every 2h)                    cron (+15min)
     │                                  │
     ▼                                  ▼
┌──────────┐    ┌──────────┐    ┌─────────────┐    ┌──────────────┐
│ scrapers │───▶│ D1 (SQL) │───▶│  model run  │───▶│ KV + D1 hist │
└──────────┘    └──────────┘    └─────────────┘    └──────┬───────┘
  polls, FRED,    polls, races,   average → blend →       ▼
  FEC             fundamentals    simulate (20k)     GET / (edge JSON)
```

## Endpoints

| Route | Description |
|---|---|
| `GET /` | Latest full forecast (cached in KV) |
| `GET /races` | Per-race forecasts from the latest run, sorted by competitiveness |
| `GET /polls?race=sen-2026-GA` | Recent ingested polls |
| `GET /history` | Past run summaries (forecast-over-time) |
| `POST /admin/scrape` | Manual scrape trigger (dev; add auth before exposing) |
| `POST /admin/run` | Manual model run (dev) |
| `POST /admin/nominee?race=sen-2026-MI&party=D&name=stevens` | Call a primary; the model then drops matchup polls that tested primary losers. `&clear=1` un-calls it |

## The model

Per race, the pipeline is **average → prior → blend → simulate**:

1. **Poll average** (`src/model/pollAverage.ts`). Each poll's Dem−Rep margin
   is adjusted for the pollster's *house effect* (estimated in-model from
   each pollster's shrunken deviation vs. the same-race consensus), shifted
   1.5 pts against partisan sponsors, and shifted right for registered-voter
   /adult samples. Weights = recency (exponential decay whose half-life
   tightens from 35 → 10 days as the election approaches) × √sample size ×
   pollster quality grade.

2. **Fundamentals prior** (`src/model/fundamentals.ts`). What we'd guess with
   no polls: state partisan lean + 0.8 × generic-ballot margin + 2.5 pts of
   incumbency + a capped fundraising term from FEC receipts. Wide sd
   (7–10 pts) — fundamentals are a blunt instrument.

3. **Bayesian blend** (`src/model/blend.ts`). Precision-weighted combination.
   Poll evidence accumulates as total poll weight; sparse/stale polling means
   fundamentals dominate, heavy late polling means polls dominate. The blend
   exposes `pollWeight` so every forecast reports how poll-driven it was.

4. **Correlated simulation** (`src/model/simulate.ts`). The load-bearing
   Silver idea: polling errors are *correlated*. Each of 20,000 sims draws
     - a **national error** — Student-t(5), sd ≈ 3 pts on election eve
       (fat tails put 2016-style systematic misses at realistic frequency),
     - a **regional error** per region — Normal, sd 1.5,
     - an **idiosyncratic race error** — Student-t(5).
   Race outcomes share the national and regional draws, so a polling miss in
   Georgia propagates to North Carolina. Per-sim win vectors roll up to seat
   counts and P(chamber control). Runs are seeded by run id → reproducible.

### The House model

All 435 districts are modeled fundamentals-first: district lean (2024
presidential margin on the **2026 maps** — including mid-decade redistricting
— minus the national margin; computed by `scripts/build-district-leans.mjs`
from The Downballot's data, reconciled against certified national totals and
statewide spot-checks before seeding) + 0.8 × generic ballot + incumbency
(FEC `incumbent_challenge` + The Downballot's incumbent list) + fundraising,
with VoteHub district polls layered on where they exist (~30 districts).
District idiosyncratic error uses a 5-pt floor (vs 3 statewide) per the
rawpolls calibration. Chamber rollup: 218 to control.

### Uncertainty is part of the API

Every race reports `demMarginSd`, an 80% interval (`demMarginP10`/`P90`)
taken from the simulation distribution (not a normal approximation — the
fat tails are in it), and `demWinProbMcSe`, the Monte Carlo sampling error
on the win probability. Chambers report `seatsP10`/`seatsP90` alongside the
full seat distribution. A lean-driven House district at 93 days shows an
80% margin interval of roughly ±15 pts — that width is the honest answer.

### Honest caveats

- Coefficients (incumbency, elasticity, sponsor shift, error sds) are
  literature-neighborhood values, not fitted. Backtest against 2018/2022
  before believing the toplines.
- `SENATE_BASELINE_DEM` in `src/model/forecast.ts` and the race map in
  `seed.sql` are seed data — **verify against the final 2026 map** (specials,
  retirements, independents who caucus).
- Uncontested and same-party (top-two) House districts are simulated like
  any other race rather than auto-awarded; their leans make this mostly
  harmless, but it's unmodeled structure.
- Governor candidates/nominees come from Ballotpedia (no FEC for state
  races); top-four states (AK) never resolve D/R nominees automatically and
  pool all matchups.

## Data sources

Poll sources plug into `src/scrapers/polls.ts` (`POLL_SOURCES`) — each source
normalizes an upstream into `Poll` rows; dedup/storage is shared. Wired today:

- **Silver Bulletin** (natesilver.net, used with attribution) — generic-ballot
  polls via their public CSV, plus their Jan 2026 **pollster ratings** (540
  pollsters → quality weights, house effects, banned list; regenerate with
  `npm run ratings`) and the **rawpolls archive** (12,350 polls, 1998–2024)
  used to calibrate the error model (`node scripts/calibrate-error-model.mjs`).
- **VoteHub** open API — race-level Senate polls; candidate names are mapped
  to parties via FEC-seeded candidates.
- **FEC API** — candidate bootstrap + fundraising totals.
- **FRED** — economic series.

Free API keys: `wrangler secret put FEC_API_KEY` (api.data.gov) and
`FRED_API_KEY` (fred.stlouisfed.org); locally, put them in `.dev.vars`.
The full source survey — including fallbacks (RCP JSON, Wikipedia, MEDSL) and
known gaps (governors, House districts) — is in
[docs/data-sources.md](docs/data-sources.md).

## Setup

```sh
npm install
npx wrangler d1 create elections           # paste id into wrangler.jsonc
npx wrangler kv namespace create FORECAST_CACHE  # paste id into wrangler.jsonc
npm run db:init                            # schema, local
npx wrangler d1 execute elections --local --file=./seed.sql
npx wrangler d1 execute elections --local --file=./seed-governors.sql
node scripts/build-district-leans.mjs      # Downballot pres-by-CD -> house seed
npx wrangler d1 execute elections --local --file=./data/seed-house.sql
npm run ratings                            # Silver Bulletin xlsx -> ratings SQL
npx wrangler d1 execute elections --local --file=./data/pollster-ratings.sql
npm run dev
curl -X POST localhost:8787/admin/scrape   # ingest polls + candidates + econ
curl -X POST localhost:8787/admin/run      # run the forecast
curl localhost:8787/                       # topline
```

Deploy: `npm run deploy`, then repeat `db:init:remote` + seed with `--remote`.

## Tests

`npm test` — distribution sanity checks (seeded RNG, t-draw sd), poll
adjustment/weighting behavior, blend limits, simulation correlation
(P(B wins | A wins) > unconditional in same region), chamber rollup.
