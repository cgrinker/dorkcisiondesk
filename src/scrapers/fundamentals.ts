/**
 * Fundamentals scrapers: economic indicators from FRED, candidate
 * fundraising from the FEC. Both are stable, keyed, JSON APIs — the easy part.
 */

import type { Env } from "../types";
import { HttpError } from "./throttle";

/** FRED series folded into a single "economic index" (z-score-ish blend). */
const FRED_SERIES = [
  { id: "UNRATE", weight: -0.5 }, // unemployment: higher is worse for incumbents
  { id: "CPIAUCSL", weight: -0.3, yoy: true }, // inflation, year-over-year
  { id: "UMCSENT", weight: 0.2 }, // consumer sentiment
];

export async function scrapeFred(env: Env): Promise<number> {
  if (!env.FRED_API_KEY) return 0;
  let stored = 0;

  for (const series of FRED_SERIES) {
    const url =
      `https://api.stlouisfed.org/fred/series/observations` +
      `?series_id=${series.id}&api_key=${env.FRED_API_KEY}&file_type=json` +
      `&sort_order=desc&limit=${series.yoy ? 13 : 1}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429 || res.status === 403) throw new HttpError(res.status, `fred ${res.status}`);
      continue;
    }
    const data = (await res.json()) as { observations: { date: string; value: string }[] };
    const obs = data.observations.filter((o) => o.value !== ".");
    if (obs.length === 0) continue;

    let value = parseFloat(obs[0]!.value);
    if (series.yoy && obs.length >= 13) {
      const prior = parseFloat(obs[12]!.value);
      value = ((value - prior) / prior) * 100;
    }

    await env.DB.prepare(
      "INSERT OR REPLACE INTO fundamentals (series, date, value) VALUES (?, ?, ?)",
    )
      .bind(`fred_${series.id.toLowerCase()}`, obs[0]!.date, value)
      .run();
    stored++;
  }
  return stored;
}

/**
 * Refresh fundraising for all Senate candidates in a few bulk pages (a
 * Worker has a per-invocation subrequest budget — never one call per
 * candidate).
 */
export async function scrapeFec(env: Env): Promise<number> {
  if (!env.FEC_API_KEY) return 0;

  const totals = new Map<string, number>();
  for (let page = 1; page <= 20; page++) {
    const url =
      `https://api.open.fec.gov/v1/candidates/totals/?api_key=${env.FEC_API_KEY}` +
      `&election_year=${env.CYCLE}&office=S&per_page=100&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429 || res.status === 403) throw new HttpError(res.status, `fec totals ${res.status}`);
      break;
    }
    const data = (await res.json()) as {
      results: { candidate_id: string; receipts?: number }[];
      pagination: { pages: number };
    };
    for (const r of data.results) {
      if (r.receipts !== undefined) totals.set(r.candidate_id, r.receipts);
    }
    if (page >= data.pagination.pages) break;
  }
  if (totals.size === 0) return 0;

  const candidates = (
    await env.DB.prepare(
      "SELECT id, fec_id FROM candidates WHERE fec_id IS NOT NULL",
    ).all<{ id: number; fec_id: string }>()
  ).results;

  const stmts = [];
  for (const c of candidates) {
    const raised = totals.get(c.fec_id);
    if (raised === undefined) continue;
    stmts.push(
      env.DB.prepare("UPDATE candidates SET raised_usd = ? WHERE id = ?").bind(raised, c.id),
    );
  }
  if (stmts.length > 0) await env.DB.batch(stmts);
  return stmts.length;
}
