# Data sources (verified Aug 2026)

The polling-data landscape changed after ABC shut down FiveThirtyEight in
March 2025: all `projects.fivethirtyeight.com/polls/data/*.csv` endpoints now
redirect to abcnews.go.com, and the `fivethirtyeight/data` GitHub repo is
frozen at Feb 2025 (still useful as a historical archive, CC-BY-4.0).

## In use

| Source | What | Access | Status |
|---|---|---|---|
| **Silver Bulletin** generic-ballot sheet | Generic-ballot polls incl. Silver's weights/adjusted values (we ingest raw dem/rep) | Public Google-Sheets CSV, linked from [the article](https://www.natesilver.net/p/generic-ballot-average-2026-nate-silver-bulletin-congress-polls); free **with attribution** | wired: `silver-bulletin-gb` source (re-resolves the CSV link each scrape — sheet ids can rotate) |
| **Silver Bulletin** pollster ratings | 540 pollsters: SB grade, Predictive Plus-Minus, house effects, banned list (Jan 2026) + `rawpolls` archive (12,350 polls 1998–2024 with actuals) | Free xlsx downloads on [the ratings page](https://www.natesilver.net/p/pollster-ratings-silver-bulletin); attribution required | in `data/`; `scripts/build-pollster-ratings.mjs` → quality/house-effect seed; `scripts/calibrate-error-model.mjs` → error-model constants |
| **VoteHub API** | Raw race-level polls (senate, governor, house, generic, approval), continuously updated | `https://api.votehub.com/polls?poll_type=us-senator&page_size=1000` — open JSON, no key, free for researchers/civic use | wired: `votehub-senate` source. Subjects: `"2026 Georgia"` = general, `"... Democratic"` = primary (skipped). Answers lack party → mapped via FEC candidates |
| **FEC API** | Candidate lists (canonical party) + fundraising totals | `api.open.fec.gov/v1`, free key (api.data.gov), nightly data | wired: candidate bootstrap + bulk `/candidates/totals/` |
| **Ballotpedia** | Primary results → automatic nominee calls | HTML race pages (`United_States_Senate_[special_]election_in_{State},_2026`); no free API; serves browser UAs only; reuse requires attribution | wired: `ballotpedia-nominees` watcher (12h cadence, ≤12 pages/run, only races with missing nominees whose primary date has passed). Winner rows carry a `results_row winner` class; runoff blocks are decisive; 2+ primary winners = runoff pending. Manual `/admin/nominee` overrides it |
| **FRED API** | UNRATE, CPI YoY, consumer sentiment | free key | wired (needs `FRED_API_KEY`) |

## Available as fallback / next

- **RealClearPolitics JSON** (undocumented): `orig.realclearpolitics.com/poll/race/{id}/polling_data.json` and `www.realclearpolitics.com/epolls/json/{id}_historical.js` (JSONP). ToS gray area — cross-validation only.
- **Wikipedia**: per-race polling wikitables (`2026 United States Senate election in {State}`), race/candidate metadata, Cook PVI values, forecaster ratings tables. MediaWiki API, CC-BY-SA. Best source for **governor** candidates (FEC is federal-only).
- **MIT Election Lab (MEDSL)**: historical results for backtesting — Senate 1976–2024 (`doi:10.7910/DVN/PEJ5QU`), House (`doi:10.7910/DVN/IG0UN2`), President (`doi:10.7910/DVN/42MVDX`).
- **VoteHub approval/generic**: `poll_type=approval&subject=Donald Trump` — fallback if the SB sheet disappears.
- **FiftyPlusOne** (`fiftyplusone.news`): 538-style averages, CSV/API is paid ($100/mo) — option if free sources degrade.
- **538 GitHub archive**: 2023 pollster ratings + historical raw polls, frozen but stable.

## Known gaps

- **Governor races**: not seeded; VoteHub has the polls but party mapping needs
  a non-FEC candidate source (Wikipedia).
- **House district model**: needs district partisan leans. Cook PVI 2025
  spreadsheet is subscriber-only, and mid-decade redistricting (TX et al.)
  invalidates pre-2025 PVI for redrawn districts — recompute from MEDSL
  returns instead.
- **Presidential approval**: available (VoteHub/SB) but not yet an input.

## Attribution

Pollster ratings, rawpolls archive, and generic-ballot data: **Silver
Bulletin** (natesilver.net), used with attribution per their terms. Poll data:
**VoteHub** (votehub.com). Campaign finance: **FEC**. Economic data: **FRED**,
Federal Reserve Bank of St. Louis.
