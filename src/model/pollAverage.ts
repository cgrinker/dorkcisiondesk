/**
 * Poll averaging, Silver-style.
 *
 * Each poll's Dem-minus-Rep margin is adjusted, then weighted by:
 *   recency  — exponential decay; the half-life tightens as election day nears
 *   size     — sqrt(sample), capped so mega-polls don't dominate
 *   quality  — pollster grade in [0,1]
 *
 * Adjustments applied to the margin before averaging:
 *   house effect     — subtract the pollster's estimated partisan lean
 *   partisan sponsor — polls released by a campaign/party get shifted 1.5 pts
 *                      against their sponsor and half weight
 *   population       — registered-voter/adult samples historically lean a bit
 *                      more Dem than likely-voter screens; shift toward R
 */

import type { ScoredPoll } from "../types";
import { totalWeight, weightedMean, type WeightedPoint } from "./stats";

const PARTISAN_SPONSOR_SHIFT = 1.5;
const POPULATION_SHIFT: Record<string, number> = { lv: 0, v: 0, rv: -1.0, a: -1.5 };

export interface PollAverage {
  /** Adjusted mean Dem margin in points. NaN when there are no usable polls. */
  margin: number;
  /** Total poll weight — the "how much evidence" input to the blend. */
  evidence: number;
  nPolls: number;
}

/** Recency half-life in days: 10 near the election, up to 35 a year out. */
export function recencyHalfLife(daysToElection: number): number {
  return Math.min(35, Math.max(10, daysToElection / 8));
}

export function adjustedMargin(p: ScoredPoll): number {
  let margin = p.demPct - p.repPct;
  margin -= p.houseEffect;
  if (p.sponsorParty === "D") margin -= PARTISAN_SPONSOR_SHIFT;
  if (p.sponsorParty === "R") margin += PARTISAN_SPONSOR_SHIFT;
  margin += POPULATION_SHIFT[p.population ?? "lv"] ?? 0;
  return margin;
}

export function pollWeight(p: ScoredPoll, asOf: Date, daysToElection: number): number {
  const ageDays = Math.max(0, (asOf.getTime() - Date.parse(p.endDate)) / 86_400_000);
  const halfLife = recencyHalfLife(daysToElection);
  const recency = Math.pow(0.5, ageDays / halfLife);

  const n = Math.min(p.sampleSize ?? 500, 5000);
  const size = Math.sqrt(n / 600);

  const sponsorPenalty = p.sponsorParty ? 0.5 : 1;
  return recency * size * Math.max(0.05, p.quality) * sponsorPenalty;
}

export function averagePolls(
  polls: ScoredPoll[],
  asOf: Date,
  daysToElection: number,
): PollAverage {
  const points: WeightedPoint[] = polls.map((p) => ({
    value: adjustedMargin(p),
    weight: pollWeight(p, asOf, daysToElection),
  }));
  return {
    margin: weightedMean(points),
    evidence: totalWeight(points),
    nPolls: polls.length,
  };
}

/**
 * Estimate house effects from the data itself: a pollster's house effect is
 * the shrunken mean deviation of its polls from the same-race consensus.
 * Two passes: average without house effects, then measure each pollster's
 * deviation. Shrinkage toward 0 keeps low-volume pollsters from getting
 * wild estimates (needs ~6 polls before half the raw deviation sticks).
 */
export function estimateHouseEffects(
  pollsByRace: Map<string, ScoredPoll[]>,
  asOf: Date,
  daysToElection: number,
): Map<string, number> {
  const consensus = new Map<string, number>();
  for (const [raceId, polls] of pollsByRace) {
    const neutral = polls.map((p) => ({ ...p, houseEffect: 0 }));
    const avg = averagePolls(neutral, asOf, daysToElection);
    if (!Number.isNaN(avg.margin)) consensus.set(raceId, avg.margin);
  }

  const deviations = new Map<string, number[]>();
  for (const [raceId, polls] of pollsByRace) {
    const base = consensus.get(raceId);
    if (base === undefined) continue;
    for (const p of polls) {
      const dev = p.demPct - p.repPct - base;
      const list = deviations.get(p.pollster) ?? [];
      list.push(dev);
      deviations.set(p.pollster, list);
    }
  }

  const SHRINK = 6;
  const effects = new Map<string, number>();
  for (const [pollster, devs] of deviations) {
    const mean = devs.reduce((a, b) => a + b, 0) / devs.length;
    effects.set(pollster, mean * (devs.length / (devs.length + SHRINK)));
  }
  return effects;
}
