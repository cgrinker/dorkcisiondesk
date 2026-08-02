/**
 * Backtest the model's statistical core against history.
 *
 * For every Senate/Governor general-election race 2006-2022 with >=2 late
 * polls in the Silver Bulletin rawpolls archive, run the REAL pipeline —
 * house-effect estimation, weighted poll average, blend (wide prior:
 * historical partisan leans aren't in this dataset, so this validates the
 * poll-driven path), and the correlated simulation — as an election-eve
 * forecast, then score it against the actual result.
 *
 * What "makes sense" means, quantitatively:
 *   - calibration: races called p% for the Dem should be won by Dems ~p%
 *   - coverage: the 80% margin interval should contain the actual margin
 *     ~80% of the time
 *   - skill: Brier score should beat the always-50% baseline (0.25) by a lot
 *
 * Honest caveat baked into the assertions: the error-model constants were
 * calibrated on this same archive's aggregate error statistics, so this is
 * a consistency check of the full pipeline, not a purely out-of-sample test.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { averagePolls, estimateHouseEffects } from "../src/model/pollAverage";
import { blend } from "../src/model/blend";
import { simulate, type SimRace } from "../src/model/simulate";
import type { Race, ScoredPoll } from "../src/types";

const YEARS = [2006, 2008, 2010, 2012, 2014, 2016, 2018, 2020, 2022];
const LATE_WINDOW_DAYS = 35;
const MIN_POLLS = 2;

interface RawRow {
  race: string;
  year: number;
  location: string;
  type_simple: string;
  pollster: string;
  partisan: string | null;
  polldate: number;
  samplesize: number | null;
  cand1_party: string;
  cand2_party: string;
  margin_poll: number;
  electiondate: number;
  margin_actual: number;
}

const excelToIso = (serial: number) =>
  new Date((serial - 25569) * 86_400_000).toISOString().slice(0, 10);

function loadRaces() {
  const wb = XLSX.read(readFileSync("data/rawpolls.xlsx"), { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<RawRow>(wb.Sheets[wb.SheetNames[0]]!);

  // race key -> { polls, actualDemMargin, electiondate }
  const races = new Map<string, { polls: ScoredPoll[]; actual: number; electionIso: string }>();
  for (const r of rows) {
    if (!YEARS.includes(r.year)) continue;
    if (r.type_simple !== "Sen-G" && r.type_simple !== "Gov-G") continue;
    if (typeof r.margin_poll !== "number" || typeof r.margin_actual !== "number") continue;
    if (r.electiondate - r.polldate > LATE_WINDOW_DAYS || r.electiondate < r.polldate) continue;

    // Normalize to Dem-minus-Rep margin; skip races led by independents.
    let flip: 1 | -1;
    if (r.cand1_party === "DEM" && r.cand2_party === "REP") flip = 1;
    else if (r.cand1_party === "REP" && r.cand2_party === "DEM") flip = -1;
    else continue;

    const entry = races.get(r.race) ?? {
      polls: [],
      actual: flip * r.margin_actual,
      electionIso: excelToIso(r.electiondate),
    };
    entry.polls.push({
      raceId: r.race,
      pollster: r.pollster,
      startDate: excelToIso(r.polldate),
      endDate: excelToIso(r.polldate),
      sampleSize: r.samplesize ?? null,
      population: null,
      demPct: flip * r.margin_poll, // encode the margin directly; rep side 0
      repPct: 0,
      sponsorParty: r.partisan === "D" ? "D" : r.partisan === "R" ? "R" : null,
      quality: 0.7, // flat quality: historical pollster-name joins are unreliable
      houseEffect: 0,
    });
    races.set(r.race, entry);
  }
  for (const [key, entry] of races) if (entry.polls.length < MIN_POLLS) races.delete(key);
  return races;
}

describe("backtest: 2006-2022 Senate + Governor races, election-eve, polls-only path", () => {
  const races = loadRaces();

  // Run the real pipeline year by year (house effects are per-cycle).
  const results: { key: string; pDem: number; p10: number; p90: number; margin: number; actual: number }[] = [];
  const byYear = new Map<number, string[]>();
  for (const key of races.keys()) {
    const year = parseInt(key.slice(0, 4));
    byYear.set(year, [...(byYear.get(year) ?? []), key]);
  }

  for (const [, keys] of byYear) {
    const electionIso = races.get(keys[0]!)!.electionIso;
    const asOf = new Date(electionIso);
    const pollsByRace = new Map(keys.map((k) => [k, races.get(k)!.polls]));
    const houseEffects = estimateHouseEffects(pollsByRace, asOf, 0);
    for (const polls of pollsByRace.values()) {
      for (const p of polls) p.houseEffect = houseEffects.get(p.pollster) ?? 0;
    }

    const simRaces: SimRace[] = keys.map((k) => {
      const avg = averagePolls(pollsByRace.get(k)!, asOf, 0);
      const blended = blend(avg, { margin: 0, sd: 25 }); // effectively polls-only
      const race: Race = {
        id: k, cycle: 0, type: "senate", state: k.slice(-2),
        district: null, partisanLean: null, incumbentParty: null, region: null,
      };
      return { race, blended, nPolls: pollsByRace.get(k)!.length };
    });

    const sim = simulate(simRaces, 0, 4000, `backtest-${keys[0]}`);
    for (let i = 0; i < keys.length; i++) {
      const f = sim.forecasts[i]!;
      results.push({
        key: keys[i]!,
        pDem: f.demWinProb,
        p10: f.demMarginP10,
        p90: f.demMarginP90,
        margin: f.demMarginMean,
        actual: races.get(keys[i]!)!.actual,
      });
    }
  }

  it("has a substantial race sample", () => {
    console.log(`races backtested: ${results.length} across ${byYear.size} cycles`);
    expect(results.length).toBeGreaterThan(250);
  });

  it("is calibrated: predicted probabilities track actual win rates", () => {
    const buckets: { lo: number; hi: number; pred: number[]; won: number[] }[] = [
      { lo: 0, hi: 0.1, pred: [], won: [] }, { lo: 0.1, hi: 0.25, pred: [], won: [] },
      { lo: 0.25, hi: 0.45, pred: [], won: [] }, { lo: 0.45, hi: 0.55, pred: [], won: [] },
      { lo: 0.55, hi: 0.75, pred: [], won: [] }, { lo: 0.75, hi: 0.9, pred: [], won: [] },
      { lo: 0.9, hi: 1.001, pred: [], won: [] },
    ];
    for (const r of results) {
      const b = buckets.find((b) => r.pDem >= b.lo && r.pDem < b.hi)!;
      b.pred.push(r.pDem);
      b.won.push(r.actual > 0 ? 1 : 0);
    }
    console.log("calibration (predicted -> actual Dem win rate):");
    for (const b of buckets) {
      if (b.pred.length === 0) continue;
      const mp = b.pred.reduce((a, x) => a + x, 0) / b.pred.length;
      const aw = b.won.reduce((a, x) => a + x, 0) / b.won.length;
      console.log(
        `  ${String(b.pred.length).padStart(3)} races predicted ~${(100 * mp).toFixed(0).padStart(2)}% -> won ${(100 * aw).toFixed(0)}%`,
      );
      // Gate: within 15 pts, or within 2.5 binomial sigmas for small buckets.
      const sigma = Math.sqrt((mp * (1 - mp)) / b.pred.length);
      expect(Math.abs(mp - aw)).toBeLessThan(Math.max(0.15, 2.5 * sigma));
    }
  });

  it("has skill: Brier score well under the 0.25 coin-flip baseline", () => {
    const brier =
      results.reduce((a, r) => a + (r.pDem - (r.actual > 0 ? 1 : 0)) ** 2, 0) / results.length;
    console.log(`Brier score: ${brier.toFixed(4)} (0 = perfect, 0.25 = always-50%)`);
    expect(brier).toBeLessThan(0.12);
  });

  it("80% margin intervals cover the actual margin ~80% of the time", () => {
    const covered = results.filter((r) => r.actual >= r.p10 && r.actual <= r.p90).length;
    const rate = covered / results.length;
    const mae = results.reduce((a, r) => a + Math.abs(r.margin - r.actual), 0) / results.length;
    console.log(`80% CI coverage: ${(100 * rate).toFixed(1)}%   margin MAE: ${mae.toFixed(2)} pts`);
    expect(rate).toBeGreaterThan(0.72);
    expect(rate).toBeLessThan(0.9);
  });
});
