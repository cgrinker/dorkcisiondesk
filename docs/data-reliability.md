# Data reliability: how 2026 data keeps flowing

## The rule

**Every input the forecast depends on has either (a) two independent
sources with cross-source dedup, or (b) a documented single point of
failure with a detection signal and a manual override.** This table is the
contract; a new input isn't "done" until it has a row here.

## The redundancy matrix

| Input | Primary | Fallback | Dedup across sources | Failure detection | Manual override |
|---|---|---|---|---|---|
| Race polls (Sen/Gov) | VoteHub API (2h) | Wikipedia race articles (12h) | end-date ±1 day + both pcts within 0.7 | `/meta` per-source health | direct D1 insert |
| Race polls (House) | VoteHub API (6h) | Wikipedia (competitive districts appear in race articles) | same | `/meta` | direct D1 insert |
| Generic ballot | Silver Bulletin sheet (6h; link re-resolved from article, sheet ids rotate) | VoteHub generic-ballot API (12h) | same mechanism | `/meta` | direct D1 insert |
| Nominees / primary results | Ballotpedia watcher (12h; general-election slate beats primary record; RCV prose handled) | comparison scripts flag disagreements vs VoteHub slates + ratings | n/a | scrape report `unmatched[]`/`errors[]` | `POST /admin/nominee` (always wins) |
| Candidates + party (federal) | FEC API nightly | Ballotpedia harvest; Downballot incumbent list (House) | `INSERT OR IGNORE` by (race, name) | `/meta` counts | direct D1 insert (used for Jackson, Risch) |
| Candidates (governor) | Ballotpedia harvest | — (FEC is federal-only) | same | watcher report | direct D1 insert |
| District leans | The Downballot pres-by-CD (static, committed) | recompute from MEDSL precinct data (documented, not built) | n/a | build script refuses unreconciled data | edit seed + re-run validation |
| Pollster ratings | Silver Bulletin workbook (static, committed; ~annual refresh) | frozen 538 ratings (2023) | n/a | n/a (static) | edit `data/pollster-ratings.sql` |
| Economic series | FRED API (24h) | — (low-stakes input) | n/a | `/meta` | none needed |

## Politeness = reliability

Getting blocked is the main way a source dies. Every source runs on its own
cadence (matched to how often the upstream changes), backs off automatically
on any 429/403/5xx (6h/24h/1h cooldowns), sends an identifying User-Agent
with contact email, and treats Ballotpedia's bot-challenge pages (HTTP 202 /
stub bodies) as rate-limiting rather than as empty data. Burst-testing
against production keys is the known self-inflicted failure mode (FEC's
1000/hr is shared between local and prod).

## Detection: how we notice a source died

- `GET /meta` reports, per source: last successful run, any active
  cooldown, and a **health verdict** (`ok` / `overdue` / `cooling-down`) —
  overdue means more than 2.5× its cadence has passed.
- `GET /summary` carries `stale: true` if no forecast ran for 6h — the
  single field an uptime monitor needs.
- The scrape report (returned by every run, visible in Worker logs) lists
  per-source errors, unmatched nominees, and pages that failed to parse —
  failures are *reported*, never silently swallowed into empty data.

## Known single points of failure (accepted, with eyes open)

1. **Ballotpedia for governor candidates** — no federal registry exists.
   Mitigation: manual insert path is proven; comparison scripts catch wrong
   slates.
2. **Silver Bulletin pollster ratings** — static file, so it can't "die,"
   but it ages; refresh when they publish (~annually).
3. **The 2026 maps themselves** — mid-decade redistricting litigation could
   redraw districts after seeding; leans would need a re-run of the
   validated build script against updated Downballot data.

## Post-mortem log (what actually broke, and what changed)

- **Wikipedia hypothetical trial-heats** polluted race averages → polls must
  map to declared candidates.
- **RCV primaries** rendered as prose, not winner rows → Maine never
  auto-called; parser extended.
- **Post-primary withdrawal** (ME) → primary winner ≠ nominee; the
  general-election slate now overrides the primary record.
- **Stale pre-fix nominee calls** (AR, MS, CO, ID) persisted because the
  watcher never revisits called races → the comparison scripts are the
  audit; run them after every primary week.
- **FEC `party=UNK`** left an incumbent unmapped (Risch) → manual insert.
- **Undercounted Senate baseline** (King/Sanders) → topline reconciliation
  against an external model is part of the audit toolkit.
- **Stale-cycle nominee calls** (VT/AK/HI/WY): pages with no current-cycle
  votebox yet made the previous cycle's completed general the first block,
  and the general-slate override called old matchups as 2026 nominees (AK
  briefly showed the 2018 race). Caught by a user hovering the map. Fix:
  blocks must contain the cycle year to be parsed; position is never proof.
  Lesson: user-visible surfaces are audit surfaces — matchup labels made a
  silent data bug visible.
