/**
 * Shared ingestion: upsert polls into D1 with dedup, auto-registering
 * unknown pollsters at default quality.
 */

import type { Env, Poll } from "../types";

export async function ingestPolls(env: Env, polls: Poll[]): Promise<number> {
  if (polls.length === 0) return 0;

  const names = [...new Set(polls.map((p) => p.pollster))];
  await env.DB.batch(
    names.map((n) =>
      env.DB.prepare("INSERT OR IGNORE INTO pollsters (name) VALUES (?)").bind(n),
    ),
  );
  const idRows = (
    await env.DB.prepare(
      `SELECT id, name FROM pollsters WHERE name IN (${names.map(() => "?").join(",")})`,
    )
      .bind(...names)
      .all<{ id: number; name: string }>()
  ).results;
  const pollsterIds = new Map(idRows.map((r) => [r.name, r.id]));

  // On re-scrape, backfill candidate ids onto existing rows (they were added
  // after early ingests); the WHERE keeps unchanged rows out of the change
  // count so scrape reports stay meaningful.
  const stmts = polls.map((p) =>
    env.DB.prepare(
      `INSERT INTO polls
         (race_id, pollster_id, start_date, end_date, sample_size, population,
          dem_pct, rep_pct, dem_candidate_id, rep_candidate_id, sponsor_party,
          source_url, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedup_key) DO UPDATE SET
         dem_candidate_id = excluded.dem_candidate_id,
         rep_candidate_id = excluded.rep_candidate_id
       WHERE polls.dem_candidate_id IS NOT excluded.dem_candidate_id
          OR polls.rep_candidate_id IS NOT excluded.rep_candidate_id`,
    ).bind(
      p.raceId,
      pollsterIds.get(p.pollster)!,
      p.startDate,
      p.endDate,
      p.sampleSize,
      p.population,
      p.demPct,
      p.repPct,
      p.demCandidateId ?? null,
      p.repCandidateId ?? null,
      p.sponsorParty,
      p.sourceUrl ?? null,
      dedupKey(p),
    ),
  );
  const results = await env.DB.batch(stmts);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

export function dedupKey(p: Poll): string {
  return [p.raceId, p.pollster, p.startDate, p.endDate, p.demPct, p.repPct].join("|");
}
