/**
 * Bayesian blend of the poll average with the fundamentals prior.
 *
 * The poll average is treated as a measurement whose precision grows with
 * accumulated poll weight ("evidence"). Precision-weighted combination gives
 * the classic Silver behavior: sparse or stale polling → fundamentals
 * dominate; heavy late polling → polls dominate.
 */

import type { PollAverage } from "./pollAverage";
import type { Prior } from "./fundamentals";

export interface Blended {
  margin: number;
  /** Uncertainty of the *estimate* (not the election-day outcome). */
  sd: number;
  /** Share of the blend attributable to polls, in [0,1]. */
  pollWeight: number;
}

/**
 * Convert accumulated poll weight into a measurement sd. One fresh
 * high-quality poll (weight ~1) measures the race to about ±5 pts;
 * ten of them get you to about ±1.6.
 */
function pollMeasurementSd(evidence: number): number {
  return 5 / Math.sqrt(Math.max(evidence, 1e-9));
}

export function blend(polls: PollAverage, prior: Prior): Blended {
  const havePolls = polls.nPolls > 0 && !Number.isNaN(polls.margin);
  if (!havePolls) {
    return { margin: prior.margin, sd: prior.sd, pollWeight: 0 };
  }

  const pollSd = pollMeasurementSd(polls.evidence);
  const wPolls = 1 / (pollSd * pollSd);
  const wPrior = 1 / (prior.sd * prior.sd);
  const total = wPolls + wPrior;

  return {
    margin: (polls.margin * wPolls + prior.margin * wPrior) / total,
    sd: Math.sqrt(1 / total),
    pollWeight: wPolls / total,
  };
}
