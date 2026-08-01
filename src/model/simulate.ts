/**
 * Correlated Monte Carlo simulation.
 *
 * The single most important idea in a Silver-style model: polling errors are
 * CORRELATED. If polls are off in Georgia they're probably off the same way
 * in North Carolina. Each simulation therefore draws a shared error
 * structure, not independent race errors:
 *
 *   race outcome = blended margin
 *               + national error   (t-dist, shared by every race)
 *               + regional error   (normal, shared within a region)
 *               + race error       (t-dist, idiosyncratic)
 *
 * Fat tails (t with 5 df) on the national and race components make extreme
 * systematic polling misses — 2016-style — appear at realistic frequency.
 */

import type { Race, RaceForecast, ChamberSummary } from "../types";
import type { Blended } from "./blend";
import { makeRng, seedFromString, studentT, normal } from "./stats";

const T_DF = 5;
const REGIONAL_SD = 1.5;

/** Systematic national polling error: ~3 pts sd on election eve, larger out. */
export function nationalErrorSd(daysToElection: number): number {
  return 3 + 2.5 * Math.min(1, daysToElection / 300);
}

export interface SimRace {
  race: Race;
  blended: Blended;
  nPolls: number;
}

export interface SimResult {
  forecasts: RaceForecast[];
  /** Per-sim Dem win counts, for seat distributions. Index-aligned with input. */
  demWinsPerSim: Uint8Array[];
}

export function simulate(
  simRaces: SimRace[],
  daysToElection: number,
  nSims: number,
  seed: string,
): SimResult {
  const rng = makeRng(seedFromString(seed));
  const natSd = nationalErrorSd(daysToElection);

  const regions = [...new Set(simRaces.map((s) => s.race.region ?? "national"))];
  const regionIndex = new Map(regions.map((r, i) => [r, i]));

  const winCounts = new Float64Array(simRaces.length);
  const marginSums = new Float64Array(simRaces.length);
  const marginSqSums = new Float64Array(simRaces.length);
  const demWinsPerSim: Uint8Array[] = [];

  for (let s = 0; s < nSims; s++) {
    const natErr = studentT(rng, T_DF, natSd);
    const regErr = regions.map(() => normal(rng) * REGIONAL_SD);
    const wins = new Uint8Array(simRaces.length);

    for (let i = 0; i < simRaces.length; i++) {
      const sr = simRaces[i]!;
      const reg = regErr[regionIndex.get(sr.race.region ?? "national")!]!;
      // Estimate sd + irreducible race noise. The 3-pt floor is calibrated
      // from Silver Bulletin rawpolls 1998-2024 (scripts/calibrate-error-model.mjs):
      // late-poll race-level residual ~5.9 pts, minus ~3.5 pts sampling noise.
      const idio = studentT(rng, T_DF, sr.blended.sd + 3);
      const margin = sr.blended.margin + natErr + reg + idio;
      marginSums[i]! += margin;
      marginSqSums[i]! += margin * margin;
      if (margin > 0) {
        winCounts[i]!++;
        wins[i] = 1;
      }
    }
    demWinsPerSim.push(wins);
  }

  const forecasts: RaceForecast[] = simRaces.map((sr, i) => {
    const mean = marginSums[i]! / nSims;
    const variance = Math.max(0, marginSqSums[i]! / nSims - mean * mean);
    return {
      raceId: sr.race.id,
      demMarginMean: mean,
      demMarginSd: Math.sqrt(variance),
      demWinProb: winCounts[i]! / nSims,
      pollWeight: sr.blended.pollWeight,
      nPolls: sr.nPolls,
    };
  });

  return { forecasts, demWinsPerSim };
}

/**
 * Roll per-race simulation outcomes up to chamber control.
 * `baselineDemSeats` = seats not up for election this cycle (plus any modeled
 * races we chose to hard-code); `seatsForControl` includes tie-break rules.
 */
export function chamberSummary(
  simRaces: SimRace[],
  result: SimResult,
  chamberFilter: (r: Race) => boolean,
  baselineDemSeats: number,
  seatsForControl: number,
): ChamberSummary {
  const idx = simRaces
    .map((sr, i) => (chamberFilter(sr.race) ? i : -1))
    .filter((i) => i >= 0);

  const dist: Record<number, number> = {};
  let controlWins = 0;
  let seatSum = 0;

  for (const wins of result.demWinsPerSim) {
    let seats = baselineDemSeats;
    for (const i of idx) seats += wins[i]!;
    dist[seats] = (dist[seats] ?? 0) + 1;
    seatSum += seats;
    if (seats >= seatsForControl) controlWins++;
  }

  const n = result.demWinsPerSim.length;
  return {
    races: result.forecasts.filter((f) => idx.some((i) => simRaces[i]!.race.id === f.raceId)),
    demControlProb: controlWins / n,
    seatDistribution: dist,
    meanSeats: seatSum / n,
  };
}
