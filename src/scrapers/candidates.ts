/**
 * Bootstrap the candidates table from the FEC API so poll answers
 * (candidate names) can be mapped to parties. Federal races only —
 * governors need a different source.
 */

import type { Env } from "../types";
import { HttpError } from "./throttle";

const PARTY_MAP: Record<string, string> = { DEM: "D", REP: "R", IND: "I", LIB: "L", GRE: "G" };

interface FecCandidate {
  candidate_id: string;
  name: string; // "LAST, FIRST M"
  party: string;
  state: string;
  office: string;
}

export async function bootstrapCandidates(env: Env): Promise<number> {
  if (!env.FEC_API_KEY) return 0;

  const raceIds = new Map<string, string>(); // state -> race id
  const races = (
    await env.DB.prepare("SELECT id, state FROM races WHERE type = 'senate' AND cycle = ?")
      .bind(Number(env.CYCLE))
      .all<{ id: string; state: string }>()
  ).results;
  for (const r of races) raceIds.set(r.state, r.id);

  let inserted = 0;
  for (let page = 1; page <= 20; page++) {
    const url =
      `https://api.open.fec.gov/v1/candidates/search/?api_key=${env.FEC_API_KEY}` +
      `&election_year=${env.CYCLE}&office=S&has_raised_funds=true&per_page=100&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429 || res.status === 403) throw new HttpError(res.status, `fec candidates ${res.status}`);
      console.warn(`fec candidates page ${page}: HTTP ${res.status}`);
      break;
    }
    const data = (await res.json()) as { results: FecCandidate[]; pagination: { pages: number } };

    for (const c of data.results) {
      const raceId = raceIds.get(c.state);
      if (!raceId) continue;
      const party = PARTY_MAP[c.party] ?? c.party ?? "?";
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO candidates (race_id, name, party, fec_id) VALUES (?, ?, ?, ?)`,
      )
        .bind(raceId, c.name, party, c.candidate_id)
        .run();
      inserted += result.meta.changes ?? 0;
    }
    if (page >= data.pagination.pages) break;
  }
  return inserted;
}

export interface RaceCandidate {
  id: number;
  name: string;
  party: string;
  nominee: number;
}

export interface CandidateMatch {
  party: string;
  /** The matched candidate, or null when several same-party candidates share the last name. */
  candidate: RaceCandidate | null;
}

/**
 * True when a poll's matched candidate is a known primary loser: the race
 * has a called nominee for that party and this poll tested someone else.
 * Polls with an ambiguous (null) candidate are kept — we can't prove they
 * tested a loser.
 */
export function testsPrimaryLoser(
  polled: RaceCandidate | null,
  raceCandidates: RaceCandidate[],
  party: string,
): boolean {
  if (!polled) return false;
  const nominee = raceCandidates.find((c) => c.party === party && c.nominee);
  if (!nominee) return false;
  return polled.id !== nominee.id;
}

/**
 * Match a poll answer choice ("Jon Ossoff") to a candidate using the
 * FEC-seeded table ("OSSOFF, T. JONATHAN"). Last-name containment is almost
 * always unambiguous within a single race; if two candidates from different
 * parties share the last name we can't attribute the answer at all.
 */
export function matchCandidate(
  choice: string,
  candidates: RaceCandidate[],
): CandidateMatch | null {
  const lastName = choice.trim().split(/\s+/).pop()?.toLowerCase();
  if (!lastName || lastName.length < 3) return null;
  const matches = candidates.filter((c) =>
    c.name.toLowerCase().split(",")[0]?.trim().split(/\s+/).includes(lastName),
  );
  const parties = [...new Set(matches.map((m) => m.party))];
  if (parties.length !== 1) return null;
  return { party: parties[0]!, candidate: matches.length === 1 ? matches[0]! : null };
}
