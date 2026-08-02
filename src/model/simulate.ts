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

/**
 * Irreducible race-level noise floor. Statewide 1.5 pts: backtested against
 * 411 Senate/Governor races 2006-2022 (test/backtest.test.ts) — the original
 * residual-derived 3 pts double-counted uncertainty already carried by the
 * shared national/regional errors (80% CI coverage 89% instead of 80%);
 * 1.5 lands coverage at 81%. House 5 pts from the rawpolls district
 * residual (~7); the House floor is NOT backtested — district polling is
 * too sparse historically — and mostly matters less than the prior sd.
 */
function idioFloor(type: Race["type"]): number {
  return type === "house" ? 5 : 1.5;
}

// Margin histogram bins for quantiles: 1-pt bins covering [-150, +150].
const BIN_OFFSET = 150;
const N_BINS = 301;

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
  // Per-race margin histogram -> simulation-distribution quantiles without
  // storing nSims margins per race.
  const histograms = simRaces.map(() => new Uint32Array(N_BINS));
  const demWinsPerSim: Uint8Array[] = [];

  for (let s = 0; s < nSims; s++) {
    const natErr = studentT(rng, T_DF, natSd);
    const regErr = regions.map(() => normal(rng) * REGIONAL_SD);
    const wins = new Uint8Array(simRaces.length);

    for (let i = 0; i < simRaces.length; i++) {
      const sr = simRaces[i]!;
      const reg = regErr[regionIndex.get(sr.race.region ?? "national")!]!;
      const idio = studentT(rng, T_DF, sr.blended.sd + idioFloor(sr.race.type));
      const margin = sr.blended.margin + natErr + reg + idio;
      marginSums[i]! += margin;
      marginSqSums[i]! += margin * margin;
      const bin = Math.min(N_BINS - 1, Math.max(0, Math.round(margin) + BIN_OFFSET));
      histograms[i]![bin] = (histograms[i]![bin] ?? 0) + 1;
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
    const p = winCounts[i]! / nSims;
    return {
      raceId: sr.race.id,
      demMarginMean: mean,
      demMarginSd: Math.sqrt(variance),
      demMarginP10: histogramQuantile(histograms[i]!, nSims, 0.1),
      demMarginP90: histogramQuantile(histograms[i]!, nSims, 0.9),
      demWinProb: p,
      demWinProbMcSe: Math.sqrt((p * (1 - p)) / nSims),
      pollWeight: sr.blended.pollWeight,
      nPolls: sr.nPolls,
    };
  });

  return { forecasts, demWinsPerSim };
}

function histogramQuantile(hist: Uint32Array, total: number, q: number): number {
  const target = q * total;
  let cum = 0;
  for (let b = 0; b < hist.length; b++) {
    cum += hist[b]!;
    if (cum >= target) return b - BIN_OFFSET;
  }
  return hist.length - 1 - BIN_OFFSET;
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
  const seatQuantile = (q: number) => {
    const target = q * n;
    let cum = 0;
    for (const seats of Object.keys(dist).map(Number).sort((a, b) => a - b)) {
      cum += dist[seats]!;
      if (cum >= target) return seats;
    }
    return 0;
  };
  return {
    races: result.forecasts.filter((f) => idx.some((i) => simRaces[i]!.race.id === f.raceId)),
    demControlProb: controlWins / n,
    seatDistribution: dist,
    meanSeats: seatSum / n,
    seatsP10: seatQuantile(0.1),
    seatsP90: seatQuantile(0.9),
  };
}
