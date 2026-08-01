/**
 * Public API handlers. Everything here is read-only over D1/KV; admin
 * mutations stay in index.ts behind the bearer check.
 */

import type { Env } from "./types";

/** Slim per-run time series — toplines only, no per-race arrays. */
export async function history(env: Env, url: URL): Promise<unknown> {
  const limit = clampInt(url.searchParams.get("limit"), 1, 500, 100);
  const rows = await env.DB.prepare(
    "SELECT id, n_sims, summary_json FROM runs ORDER BY id DESC LIMIT ?",
  )
    .bind(limit)
    .all<{ id: string; n_sims: number; summary_json: string }>();

  return rows.results.map((r) => {
    const s = JSON.parse(r.summary_json);
    const chamber = (c: { demControlProb: number; meanSeats: number; seatsP10?: number; seatsP90?: number } | undefined) =>
      c && {
        demControlProb: c.demControlProb,
        meanSeats: c.meanSeats,
        seatsP10: c.seatsP10,
        seatsP90: c.seatsP90,
      };
    return {
      runId: r.id,
      nSims: r.n_sims,
      daysToElection: s.daysToElection,
      genericBallot: s.genericBallot,
      senate: chamber(s.senate),
      house: chamber(s.house),
    };
  });
}

/** Latest forecasts joined with race metadata and nominees; filterable. */
export async function racesList(env: Env, url: URL): Promise<unknown> {
  const type = url.searchParams.get("type");
  const state = url.searchParams.get("state")?.toUpperCase() ?? null;
  const competitive = url.searchParams.get("competitive") === "1" ? 1 : 0;
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 1000);

  const rows = await env.DB.prepare(
    `SELECT f.race_id, f.dem_margin_mean, f.dem_margin_sd, f.dem_margin_p10, f.dem_margin_p90,
            f.dem_win_prob, f.poll_weight, f.n_polls,
            r.type, r.state, r.district, r.partisan_lean, r.incumbent_party, r.region,
            (SELECT name FROM candidates c WHERE c.race_id = r.id AND c.party = 'D' AND c.nominee = 1 LIMIT 1) AS dem_nominee,
            (SELECT name FROM candidates c WHERE c.race_id = r.id AND c.party = 'R' AND c.nominee = 1 LIMIT 1) AS rep_nominee
       FROM forecasts f JOIN races r ON r.id = f.race_id
      WHERE f.run_id = (SELECT id FROM runs ORDER BY id DESC LIMIT 1)
        AND (?1 IS NULL OR r.type = ?1)
        AND (?2 IS NULL OR r.state = ?2)
        AND (?3 = 0 OR f.dem_win_prob BETWEEN 0.05 AND 0.95)
      ORDER BY ABS(f.dem_win_prob - 0.5) ASC
      LIMIT ?4`,
  )
    .bind(type, state, competitive, limit)
    .all();
  return rows.results;
}

/** Everything about one race: metadata, slate, forecast + history, polls. */
export async function raceDetail(env: Env, raceId: string): Promise<unknown | null> {
  const race = await env.DB.prepare("SELECT * FROM races WHERE id = ?").bind(raceId).first();
  if (!race) return null;

  const [candidates, forecast, historyRows, polls] = await Promise.all([
    env.DB.prepare(
      `SELECT name, party, incumbent, nominee, raised_usd FROM candidates
        WHERE race_id = ? ORDER BY nominee DESC, raised_usd DESC NULLS LAST, name LIMIT 30`,
    )
      .bind(raceId)
      .all(),
    env.DB.prepare(
      `SELECT * FROM forecasts WHERE race_id = ?
        ORDER BY run_id DESC LIMIT 1`,
    )
      .bind(raceId)
      .first(),
    env.DB.prepare(
      `SELECT run_id, dem_margin_mean, dem_margin_p10, dem_margin_p90, dem_win_prob, n_polls
         FROM forecasts WHERE race_id = ? ORDER BY run_id DESC LIMIT 90`,
    )
      .bind(raceId)
      .all(),
    env.DB.prepare(
      `SELECT ps.name AS pollster, ps.quality, p.start_date, p.end_date, p.sample_size,
              p.population, p.dem_pct, p.rep_pct, p.sponsor_party, p.source_url
         FROM polls p JOIN pollsters ps ON ps.id = p.pollster_id
        WHERE p.race_id = ? ORDER BY p.end_date DESC LIMIT 40`,
    )
      .bind(raceId)
      .all(),
  ]);

  return {
    race,
    candidates: candidates.results,
    forecast,
    history: historyRows.results,
    polls: polls.results,
  };
}

export async function pollsList(env: Env, url: URL): Promise<unknown> {
  const race = url.searchParams.get("race");
  const limit = clampInt(url.searchParams.get("limit"), 1, 500, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 100_000, 0);
  const rows = await env.DB.prepare(
    `SELECT p.race_id, ps.name AS pollster, p.start_date, p.end_date, p.sample_size,
            p.population, p.dem_pct, p.rep_pct, p.sponsor_party, p.source_url
       FROM polls p JOIN pollsters ps ON ps.id = p.pollster_id
      WHERE (?1 IS NULL OR p.race_id = ?1)
      ORDER BY p.end_date DESC LIMIT ?2 OFFSET ?3`,
  )
    .bind(race, limit, offset)
    .all();
  return rows.results;
}

/** Operational state: per-source scrape health, data counts, freshness. */
export async function meta(env: Env): Promise<unknown> {
  const now = Date.now();
  const throttleKeys = await env.FORECAST_CACHE.list({ prefix: "throttle:" });
  const sources: Record<string, { lastRun?: string; cooldownUntil?: string }> = {};
  for (const key of throttleKeys.keys) {
    const value = await env.FORECAST_CACHE.get(key.name);
    if (!value) continue;
    const [, kind, source] = key.name.split(":");
    if (!kind || !source) continue;
    const entry = (sources[source] ??= {});
    if (kind === "last") entry.lastRun = new Date(Number(value)).toISOString();
    if (kind === "cooldown") entry.cooldownUntil = new Date(Number(value)).toISOString();
  }

  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM polls) AS polls,
            (SELECT COUNT(*) FROM races) AS races,
            (SELECT COUNT(*) FROM candidates) AS candidates,
            (SELECT COUNT(*) FROM candidates WHERE nominee = 1) AS nominees,
            (SELECT COUNT(*) FROM pollsters) AS pollsters,
            (SELECT COUNT(*) FROM runs) AS runs,
            (SELECT MAX(id) FROM runs) AS latest_run`,
  ).first();

  const latest = await env.FORECAST_CACHE.get("latest");
  const generatedAt = latest ? (JSON.parse(latest).generatedAt as string) : null;
  return {
    now: new Date(now).toISOString(),
    forecast: {
      generatedAt,
      ageMinutes: generatedAt ? Math.round((now - Date.parse(generatedAt)) / 60_000) : null,
      stale: generatedAt ? now - Date.parse(generatedAt) > 6 * 3_600_000 : true,
    },
    sources,
    counts,
  };
}

/** Machine-readable contract, served at /docs. */
export const DOCS = {
  api: "elections forecast API",
  election_day: "2026-11-03",
  endpoints: {
    "GET /": "Interactive dashboard (HTML).",
    "GET /summary": "Latest full forecast: senate/house chamber summaries (competitive House districts only), governor races, generic ballot, stale flag, credits.",
    "GET /races": "Latest per-race forecasts joined with race metadata and called nominees. Filters: ?type=senate|governor|house, ?state=XX, ?competitive=1 (5-95% only), ?limit=N.",
    "GET /races/{id}": "One race in full: metadata, candidate slate (nominee/incumbent/fundraising), latest forecast, forecast history across runs, recent polls. Ids look like sen-2026-GA, gov-2026-AZ, house-2026-TX-23.",
    "GET /polls": "Ingested polls, newest first. Filters: ?race=id, ?limit=N (<=500), ?offset=N.",
    "GET /history": "Per-run topline time series (control probabilities, seats + intervals, generic ballot). ?limit=N (<=500).",
    "GET /meta": "Operational state: per-source last scrape / cooldowns, table counts, forecast freshness.",
    "GET /docs": "This document.",
  },
  field_glossary: {
    dem_margin_mean: "Expected Dem two-party margin, percentage points. Positive = Dem ahead.",
    dem_margin_sd: "Standard deviation of the simulated election-day margin (outcome uncertainty, not poll-average precision).",
    dem_margin_p10_p90: "80% interval on the margin, read from the simulation distribution — fat tails included, not a normal approximation.",
    dem_win_prob: "Share of simulations the Democrat wins.",
    demWinProbMcSe: "Monte Carlo sampling error of the win probability (simulation noise, NOT outcome uncertainty).",
    poll_weight: "Share of the forecast driven by polls vs the fundamentals prior (0 = pure fundamentals).",
    partisan_lean: "District/state lean in Dem margin points relative to the nation (2024-presidential-based).",
    seatsP10_seatsP90: "80% interval on chamber seats from the simulation distribution.",
  },
  correlated_errors:
    "Simulations share national (Student-t df=5) and regional error draws; race outcomes are NOT independent. Calibration: Silver Bulletin rawpolls 1998-2024.",
  credits: {
    pollster_ratings_and_generic_ballot: "Silver Bulletin (natesilver.net)",
    race_polls: "VoteHub (votehub.com); Wikipedia contributors (CC-BY-SA)",
    primary_results: "Ballotpedia (ballotpedia.org)",
    district_leans: "The Downballot (the-downballot.com) 2024 presidential results by congressional district",
    campaign_finance: "Federal Election Commission",
    economic_data: "FRED, Federal Reserve Bank of St. Louis",
  },
};

function clampInt(raw: string | null, min: number, max: number, dflt: number): number {
  const n = parseInt(raw ?? "");
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
