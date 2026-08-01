export interface RaceForecast {
  raceId: string;
  demMarginMean: number;
  demMarginSd: number;
  demMarginP10: number;
  demMarginP90: number;
  demWinProb: number;
  demWinProbMcSe: number;
  pollWeight: number;
  nPolls: number;
}

export interface ChamberSummary {
  races: RaceForecast[];
  demControlProb: number;
  seatDistribution: Record<string, number>;
  meanSeats: number;
  seatsP10: number;
  seatsP90: number;
}

export interface Summary {
  generatedAt: string;
  daysToElection: number;
  genericBallot: number | null;
  senate: ChamberSummary;
  house: ChamberSummary;
  governors: { races: RaceForecast[] };
  stale: boolean;
}

export interface RaceRow {
  race_id: string;
  dem_margin_mean: number;
  dem_margin_p10: number;
  dem_margin_p90: number;
  dem_win_prob: number;
  poll_weight: number;
  n_polls: number;
  type: string;
  state: string;
  district: number | null;
  partisan_lean: number | null;
  incumbent_party: string | null;
  dem_nominee: string | null;
  rep_nominee: string | null;
}

export interface HistoryRow {
  runId: string;
  daysToElection: number;
  genericBallot: number | null;
  senate?: { demControlProb: number; meanSeats: number; seatsP10?: number; seatsP90?: number };
  house?: { demControlProb: number; meanSeats: number; seatsP10?: number; seatsP90?: number };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

export interface PollRow {
  race_id: string;
  pollster: string;
  start_date: string;
  end_date: string;
  sample_size: number | null;
  population: string | null;
  dem_pct: number;
  rep_pct: number;
  sponsor_party: string | null;
  source_url: string | null;
}

export const fetchSummary = () => get<Summary>("/summary");
export const fetchPolls = (raceId: string) =>
  get<PollRow[]>(`/polls?race=${encodeURIComponent(raceId)}&limit=15`);
export const fetchRaces = (type: string) => get<RaceRow[]>(`/races?type=${type}&limit=500`);
export const fetchHistory = () => get<HistoryRow[]>("/history?limit=90");
