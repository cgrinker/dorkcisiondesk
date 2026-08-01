/**
 * The fundamentals prior: what we'd predict for a race if we had no polls.
 *
 *   prior = partisan lean
 *         + elasticity * national environment (generic ballot margin)
 *         + incumbency advantage
 *         + fundraising signal
 *
 * The national environment already embeds the midterm penalty — the generic
 * ballot IS the measurement of it — so there's no separate term for it.
 * Coefficients are in the neighborhood of published fundamentals models
 * (Abramowitz, 538's "Deluxe" fundamentals); tune against 2018/2022 backtests.
 */

import type { Race } from "../types";

export interface FundamentalsInput {
  /** Current generic-ballot Dem margin, points. Null when we have no data. */
  genericBallot: number | null;
  /** log(demRaised / repRaised), clamped. Null when FEC data is missing. */
  logFundraisingRatio: number | null;
}

export interface Prior {
  margin: number;
  sd: number;
}

const INCUMBENCY_PTS = 2.5;
const ELASTICITY = 0.8; // how much of the national swing a typical race absorbs
const FUNDRAISING_PTS_PER_LOG = 1.5;
const MAX_FUNDRAISING_EFFECT = 4;

export function fundamentalsPrior(
  race: Race,
  input: FundamentalsInput,
  daysToElection: number,
): Prior {
  let margin = race.partisanLean ?? 0;

  if (input.genericBallot !== null) margin += ELASTICITY * input.genericBallot;

  if (race.incumbentParty === "D") margin += INCUMBENCY_PTS;
  else if (race.incumbentParty === "R") margin -= INCUMBENCY_PTS;

  if (input.logFundraisingRatio !== null) {
    const effect = FUNDRAISING_PTS_PER_LOG * input.logFundraisingRatio;
    margin += Math.max(-MAX_FUNDRAISING_EFFECT, Math.min(MAX_FUNDRAISING_EFFECT, effect));
  }

  // Fundamentals are a blunt instrument; the prior is wide, and wider when
  // the election is far away and the national environment can still move.
  const sd = 7 + 3 * Math.min(1, daysToElection / 365);
  return { margin, sd };
}
