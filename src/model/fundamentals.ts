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
/**
 * When the SAME candidate runs again, their next margin is about 85% of
 * their last one, blended with what a generic candidate would get. Computed
 * (k = 0.869) from 343 repeat-candidate race pairs 1998-2024 in the
 * rawpolls archive (scripts/build-incumbent-history.mjs); predicting with
 * k x last beats both "same as last time" and "ignore history". This is
 * what prices crossover incumbents (Scott, Collins) correctly — their
 * demonstrated personal vote IS evidence.
 */
const PERSISTENCE = 0.85;

export function fundamentalsPrior(
  race: Race,
  input: FundamentalsInput,
  daysToElection: number,
): Prior {
  // What a generic candidate of no particular strength would do here.
  let structural = race.partisanLean ?? 0;
  if (input.genericBallot !== null) structural += ELASTICITY * input.genericBallot;
  if (input.logFundraisingRatio !== null) {
    const effect = FUNDRAISING_PTS_PER_LOG * input.logFundraisingRatio;
    structural += Math.max(-MAX_FUNDRAISING_EFFECT, Math.min(MAX_FUNDRAISING_EFFECT, effect));
  }

  let margin: number;
  if (race.incumbentLastMargin !== null && race.incumbentLastMargin !== undefined) {
    // Same person running again: mostly their own history, a little structure.
    // (Their last margin already contains their incumbency advantage — no
    // flat incumbency bonus on top.)
    margin = PERSISTENCE * race.incumbentLastMargin + (1 - PERSISTENCE) * structural;
  } else {
    margin = structural;
    if (race.incumbentParty === "D") margin += INCUMBENCY_PTS;
    else if (race.incumbentParty === "R") margin -= INCUMBENCY_PTS;
  }

  // Fundamentals are a blunt instrument; the prior is wide, and wider when
  // the election is far away and the national environment can still move.
  const sd = 7 + 3 * Math.min(1, daysToElection / 365);
  return { margin, sd };
}
