/**
 * Full model run: load races + polls from D1, estimate house effects,
 * average, blend with fundamentals, simulate, persist, cache.
 */

import type { Env, Race, ScoredPoll, RunSummary } from "../types";
import { averagePolls, estimateHouseEffects } from "./pollAverage";
import { fundamentalsPrior } from "./fundamentals";
import { blend } from "./blend";
import { simulate, chamberSummary, type SimRace } from "./simulate";

// 10k sims over ~500 races stays well inside the Worker CPU budget; the
// Monte Carlo se on a 50% win probability is ±0.5 pts (reported per race).
const N_SIMS = 10_000;

// 2026 Senate control baseline: Dem-CAUCUS seats NOT up this cycle.
// Current chamber 53R / 45D / 2I (King, Sanders — both caucus D) = 47
// Dem-caucus; 13 of the 35 seats up are Dem-held; 47 - 13 = 34.
const SENATE_BASELINE_DEM = 34;
const SENATE_CONTROL = 51; // VP (R) breaks ties, so Dems need 51 outright

/**
 * The "+ Midterm drift" track: history says midterm polls understate the
 * president's opposition — the November result moved toward the out-party
 * in 6 of the last 8 midterms (avg +1.5, +2.7 excluding 2002), and the
 * Bafumi/Erikson/Wlezien regression puts the effect near 3 margin points
 * at this horizon. +2 is deliberately conservative. Party-symmetric by
 * construction: under a Democratic president this same term would shift
 * the environment toward Republicans. Published as a second view, never
 * silently mixed into the default — November scores both (see the
 * pre-registered rule on /methodology).
 */
const OUT_PARTY_DRIFT_PTS = 2;
const PRESIDENT_PARTY: "D" | "R" = "R";
const OUT_PARTY_SHIFT = PRESIDENT_PARTY === "R" ? OUT_PARTY_DRIFT_PTS : -OUT_PARTY_DRIFT_PTS;

export async function runForecast(env: Env): Promise<RunSummary> {
  const now = new Date();
  const runId = now.toISOString();
  const daysToElection = Math.max(
    0,
    (Date.parse(env.ELECTION_DAY) - now.getTime()) / 86_400_000,
  );

  const races = (
    await env.DB.prepare("SELECT * FROM races WHERE cycle = ?").bind(Number(env.CYCLE)).all()
  ).results.map(rowToRace);

  const pollRows = (
    await env.DB.prepare(
      `SELECT p.*, ps.name AS pollster_name, ps.quality
         FROM polls p JOIN pollsters ps ON ps.id = p.pollster_id
        WHERE ps.banned = 0 AND p.end_date > date('now', '-120 days')`,
    ).all()
  ).results;

  // Called nominees, per race+party. A stored poll that tested a primary
  // loser (candidate id set, differs from the nominee) is excluded.
  const nomineeRows = (
    await env.DB.prepare(
      "SELECT id, race_id, party FROM candidates WHERE nominee = 1",
    ).all<{ id: number; race_id: string; party: string }>()
  ).results;
  const nominees = new Map<string, number>(); // "raceId|party" -> candidate id
  for (const n of nomineeRows) nominees.set(`${n.race_id}|${n.party}`, n.id);

  const pollsByRace = new Map<string, ScoredPoll[]>();
  for (const row of pollRows) {
    const p = rowToPoll(row);
    if (isLoserMatchup(p, nominees)) continue;
    const list = pollsByRace.get(p.raceId) ?? [];
    list.push(p);
    pollsByRace.set(p.raceId, list);
  }

  // Estimate house effects from cross-pollster deviations, then re-score.
  const houseEffects = estimateHouseEffects(pollsByRace, now, daysToElection);
  for (const polls of pollsByRace.values()) {
    for (const p of polls) p.houseEffect = houseEffects.get(p.pollster) ?? 0;
  }

  // National environment: our own average of ingested generic-ballot polls,
  // falling back to the stored fundamentals series if none are loaded.
  const genericPolls = pollsByRace.get(`generic-${env.CYCLE}`) ?? [];
  const genericAvg = averagePolls(genericPolls, now, daysToElection);
  const genericBallot = !Number.isNaN(genericAvg.margin)
    ? genericAvg.margin
    : await latestFundamental(env, "generic_ballot");

  // The generic-ballot "race" is averaged for the national environment but
  // not simulated as a contest.
  const contested = races.filter((r) => r.type !== "generic");

  // One fundraising query for all races (used by both tracks).
  const fundraising = await fundraisingByRace(env);

  // Both tracks share every input except the effective national environment.
  const track = (effectiveGeneric: number | null, seed: string) => {
    const simRaces: SimRace[] = contested.map((race) => {
      const polls = pollsByRace.get(race.id) ?? [];
      const avg = averagePolls(polls, now, daysToElection);
      const prior = fundamentalsPrior(
        race,
        { genericBallot: effectiveGeneric, logFundraisingRatio: fundraising.get(race.id) ?? null },
        daysToElection,
      );
      return { race, blended: blend(avg, prior), nPolls: polls.length };
    });
    const result = simulate(simRaces, daysToElection, N_SIMS, seed);
    const senate = chamberSummary(
      simRaces, result, (r) => r.type === "senate", SENATE_BASELINE_DEM, SENATE_CONTROL,
    );
    // All 435 House seats are modeled, so the baseline is 0 and 218 controls.
    const house = chamberSummary(simRaces, result, (r) => r.type === "house", 0, 218);
    // Topline carries only competitive districts (5%..95%); every district
    // is still persisted and served via /races.
    house.races = house.races.filter((f) => f.demWinProb > 0.05 && f.demWinProb < 0.95);
    const governors = { races: result.forecasts.filter((f) => f.raceId.startsWith("gov-")) };
    return { result, senate, house, governors };
  };

  const measured = track(genericBallot, runId);
  const adjusted = track(
    genericBallot === null ? null : genericBallot + OUT_PARTY_SHIFT,
    `${runId}-adjusted`,
  );

  const summary: RunSummary = {
    runId,
    nSims: N_SIMS,
    generatedAt: runId,
    daysToElection: Math.round(daysToElection),
    genericBallot,
    senate: measured.senate,
    house: measured.house,
    governors: measured.governors,
    adjusted: {
      outPartyShift: OUT_PARTY_SHIFT,
      senate: adjusted.senate,
      house: adjusted.house,
      governors: adjusted.governors,
    },
  };

  await persist(env, runId, measured.result.forecasts, summary);
  await env.FORECAST_CACHE.put("latest", JSON.stringify(summary));
  return summary;
}

async function latestFundamental(env: Env, series: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT value FROM fundamentals WHERE series = ? ORDER BY date DESC LIMIT 1",
  )
    .bind(series)
    .first<{ value: number }>();
  return row?.value ?? null;
}

async function fundraisingByRace(env: Env): Promise<Map<string, number>> {
  const rows = (
    await env.DB.prepare(
      "SELECT race_id, party, SUM(raised_usd) AS raised FROM candidates GROUP BY race_id, party",
    ).all<{ race_id: string; party: string; raised: number | null }>()
  ).results;
  const byRace = new Map<string, { dem?: number; rep?: number }>();
  for (const r of rows) {
    const entry = byRace.get(r.race_id) ?? {};
    if (r.party === "D") entry.dem = r.raised ?? undefined;
    if (r.party === "R") entry.rep = r.raised ?? undefined;
    byRace.set(r.race_id, entry);
  }
  const out = new Map<string, number>();
  for (const [raceId, { dem, rep }] of byRace) {
    if (dem && rep && dem > 0 && rep > 0) out.set(raceId, Math.log(dem / rep));
  }
  return out;
}

async function persist(
  env: Env,
  runId: string,
  forecasts: RunSummary["senate"]["races"],
  summary: RunSummary,
): Promise<void> {
  const stmts = forecasts.map((f) =>
    env.DB.prepare(
      `INSERT INTO forecasts (run_id, race_id, dem_margin_mean, dem_margin_sd, dem_margin_p10, dem_margin_p90, dem_win_prob, poll_weight, n_polls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      f.raceId,
      f.demMarginMean,
      f.demMarginSd,
      f.demMarginP10,
      f.demMarginP90,
      f.demWinProb,
      f.pollWeight,
      f.nPolls,
    ),
  );
  stmts.push(
    env.DB.prepare("INSERT INTO runs (id, n_sims, summary_json) VALUES (?, ?, ?)").bind(
      runId,
      summary.nSims,
      JSON.stringify(summary),
    ),
  );
  await env.DB.batch(stmts);
}

function isLoserMatchup(p: ScoredPoll, nominees: Map<string, number>): boolean {
  const demNominee = nominees.get(`${p.raceId}|D`);
  if (demNominee !== undefined && p.demCandidateId != null && p.demCandidateId !== demNominee) {
    return true;
  }
  const repNominee = nominees.get(`${p.raceId}|R`);
  if (repNominee !== undefined && p.repCandidateId != null && p.repCandidateId !== repNominee) {
    return true;
  }
  return false;
}

function rowToRace(row: Record<string, unknown>): Race {
  return {
    id: row.id as string,
    cycle: row.cycle as number,
    type: row.type as Race["type"],
    state: (row.state as string) ?? null,
    district: (row.district as number) ?? null,
    partisanLean: (row.partisan_lean as number) ?? null,
    incumbentParty: (row.incumbent_party as Race["incumbentParty"]) ?? null,
    incumbentLastMargin: (row.incumbent_last_margin as number) ?? null,
    region: (row.region as string) ?? null,
  };
}

function rowToPoll(row: Record<string, unknown>): ScoredPoll {
  return {
    raceId: row.race_id as string,
    pollster: row.pollster_name as string,
    startDate: row.start_date as string,
    endDate: row.end_date as string,
    sampleSize: (row.sample_size as number) ?? null,
    population: (row.population as ScoredPoll["population"]) ?? null,
    demPct: row.dem_pct as number,
    repPct: row.rep_pct as number,
    demCandidateId: (row.dem_candidate_id as number) ?? null,
    repCandidateId: (row.rep_candidate_id as number) ?? null,
    sponsorParty: (row.sponsor_party as "D" | "R") ?? null,
    quality: row.quality as number,
    houseEffect: 0,
  };
}
