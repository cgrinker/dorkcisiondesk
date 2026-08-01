export interface Env {
  DB: D1Database;
  FORECAST_CACHE: KVNamespace;
  ELECTION_DAY: string;
  CYCLE: string;
  FEC_API_KEY?: string;
  FRED_API_KEY?: string;
  /** Bearer token for /admin/* routes. Unset (local dev) = no auth check. */
  ADMIN_TOKEN?: string;
}

export type Population = "lv" | "rv" | "a" | "v";
export type Party = "D" | "R" | "I" | "open";
export type RaceType = "senate" | "governor" | "house" | "generic";

export interface Poll {
  raceId: string;
  pollster: string;
  startDate: string;
  endDate: string;
  sampleSize: number | null;
  population: Population | null;
  demPct: number;
  repPct: number;
  /** Specific candidates tested, when known (see schema.sql polls table). */
  demCandidateId?: number | null;
  repCandidateId?: number | null;
  sponsorParty: "D" | "R" | null;
  sourceUrl?: string;
}

export interface Race {
  id: string;
  cycle: number;
  type: RaceType;
  state: string | null;
  district: number | null;
  partisanLean: number | null;
  incumbentParty: Party | null;
  region: string | null;
}

export interface PollsterInfo {
  id: number;
  name: string;
  quality: number;
  houseEffect: number;
}

/** A poll joined with its pollster metadata, as read back from D1. */
export interface ScoredPoll extends Poll {
  quality: number;
  houseEffect: number;
}

export interface RaceForecast {
  raceId: string;
  demMarginMean: number;
  demMarginSd: number;
  /** 80% interval on the Dem margin, from the simulation distribution. */
  demMarginP10: number;
  demMarginP90: number;
  demWinProb: number;
  /** Monte Carlo standard error of demWinProb (sampling noise, not outcome uncertainty). */
  demWinProbMcSe: number;
  pollWeight: number;
  nPolls: number;
}

export interface RunSummary {
  runId: string;
  nSims: number;
  generatedAt: string;
  daysToElection: number;
  genericBallot: number | null;
  senate: ChamberSummary;
  house: ChamberSummary;
  governors: { races: RaceForecast[] };
}

export interface ChamberSummary {
  races: RaceForecast[];
  /** P(Dem controls chamber) across simulations. */
  demControlProb: number;
  /** Histogram of Dem seats won among the modeled races. */
  seatDistribution: Record<number, number>;
  meanSeats: number;
  /** 80% interval on Dem seats, from the simulation distribution. */
  seatsP10: number;
  seatsP90: number;
}
