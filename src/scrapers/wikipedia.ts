/**
 * Wikipedia poll source — the redundancy feed.
 *
 * Per-race election articles carry community-maintained polling wikitables,
 * fetched via the official MediaWiki API (CC-BY-SA; identify with a contact
 * UA). General-election matchup tables self-identify: their headers contain
 * both a "(D)" and an "(R)" candidate column, which also excludes primary
 * tables. Partisan pollsters are marked in the source cell ("SoCal
 * Strategies (R)") and mapped to our sponsor adjustment.
 *
 * Cross-source dedup: a poll VoteHub already ingested must not be counted
 * twice. dedup_key only catches identical pollster strings, so this source
 * additionally drops any poll matching an existing row on (race, end date
 * ±1 day, both percentages within 0.7 pts) regardless of pollster spelling.
 */

import type { Env, Poll, Population } from "../types";
import { matchCandidate, testsPrimaryLoser, type RaceCandidate } from "./candidates";
import { HttpError } from "./throttle";
import { STATE_NAME } from "./states";
import { USER_AGENT, type PollSource } from "./polls";

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function pageTitle(race: { id: string; state: string; type: string }): string {
  const name = STATE_NAME[race.state] ?? race.state;
  if (race.type === "governor") return `2026 ${name} gubernatorial election`;
  if (race.id.endsWith("-special")) return `2026 United States Senate special election in ${name}`;
  return `2026 United States Senate election in ${name}`;
}

async function fetchArticleHtml(title: string): Promise<string | null> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2&prop=text` +
    `&page=${encodeURIComponent(title)}`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new HttpError(res.status, `wikipedia ${res.status} for ${title}`);
  const data = (await res.json()) as { parse?: { text: string }; error?: { code: string } };
  if (data.error) return null; // article doesn't exist (yet)
  return data.parse?.text ?? null;
}

interface WikiPoll {
  pollster: string;
  sponsorParty: "D" | "R" | null;
  startDate: string;
  endDate: string;
  sampleSize: number | null;
  population: Population | null;
  demPct: number;
  repPct: number;
  demName: string;
  repName: string;
}

const stripTags = (s: string): string =>
  s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&#91;[\s\S]*?&#93;/g, "") // [ref] markers
    .replace(/<[^>]+>/g, "")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Parse all general-election poll tables out of a race article. */
export function parseWikiPolls(html: string): WikiPoll[] {
  const polls: WikiPoll[] = [];
  const tables = html.match(/<table class="wikitable[^"]*"[\s\S]*?<\/table>/g) ?? [];

  for (const table of tables) {
    const headers = (table.match(/<th[^>]*>[\s\S]*?<\/th>/g) ?? []).map((h) => stripTags(h));
    if (!/^(Poll source|Pollster)/i.test(headers[0] ?? "")) continue;

    const demCols: number[] = [];
    const repCols: number[] = [];
    for (let i = 0; i < headers.length; i++) {
      if (/\(D\)$/.test(headers[i]!)) demCols.push(i);
      if (/\(R\)$/.test(headers[i]!)) repCols.push(i);
    }
    if (demCols.length === 0 || repCols.length === 0) continue; // primary/aggregate table

    const candName = (i: number) => headers[i]!.replace(/\s*\((D|R)\)$/, "");

    for (const rowHtml of table.split(/<tr[^>]*>/).slice(2)) {
      const cells = (rowHtml.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map((c) => stripTags(c));
      // Rowspan continuation rows and aggregate/average rows come up short.
      if (cells.length < headers.length - 1) continue;

      const src = cells[0] ?? "";
      if (!src || /average|aggregate/i.test(src)) continue;
      const sponsor = /\((R)\)\s*$/.exec(src) ? "R" : /\((D)\)\s*$/.exec(src) ? "D" : null;
      const pollster = src.replace(/\s*\([DR]\)\s*$/, "").trim();

      const dates = parseDateRange(cells[1] ?? "");
      if (!dates) continue;

      const sample = /([\d,]+)\s*\((LV|RV|A|V)\)/i.exec(cells[2] ?? "");
      const pick = (cols: number[]) => {
        let best = NaN;
        for (const c of cols) {
          const v = parseFloat((cells[c] ?? "").replace("%", ""));
          if (!Number.isNaN(v) && !(v <= (best || -1))) best = v;
        }
        return best;
      };
      const dem = pick(demCols);
      const rep = pick(repCols);
      if (Number.isNaN(dem) || Number.isNaN(rep)) continue;

      polls.push({
        pollster,
        sponsorParty: sponsor,
        startDate: dates[0],
        endDate: dates[1],
        sampleSize: sample ? parseInt(sample[1]!.replace(/,/g, "")) : null,
        population: sample ? (sample[2]!.toLowerCase() as Population) : null,
        demPct: dem,
        repPct: rep,
        demName: candName(demCols[0]!),
        repName: candName(repCols[0]!),
      });
    }
  }
  return polls;
}

/** "July 28–30, 2026" | "June 30 – July 2, 2026" | "July 28, 2026" -> [start, end] ISO. */
export function parseDateRange(raw: string): [string, string] | null {
  const s = raw.replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim();
  const year = /(\d{4})\s*$/.exec(s)?.[1];
  if (!year) return null;
  const body = s.replace(/,?\s*\d{4}\s*$/, "");

  const parts = body.split("-").map((p) => p.trim());
  const first = /^([A-Za-z]+)\s+(\d{1,2})$/.exec(parts[0] ?? "");
  if (!first) return null;
  const m1 = MONTHS[first[1]!.toLowerCase()];
  if (!m1) return null;
  const d1 = parseInt(first[2]!);

  let m2 = m1;
  let d2 = d1;
  if (parts.length > 1) {
    const second = /^(?:([A-Za-z]+)\s+)?(\d{1,2})$/.exec(parts[1] ?? "");
    if (!second) return null;
    m2 = second[1] ? MONTHS[second[1].toLowerCase()] ?? m1 : m1;
    d2 = parseInt(second[2]!);
  }
  const iso = (m: number, d: number) =>
    `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return [iso(m1, d1), iso(m2, d2)];
}

export const wikipediaRaces: PollSource = {
  name: "wikipedia-races",
  async fetch(env) {
    const races = (
      await env.DB.prepare(
        "SELECT id, state, type FROM races WHERE type IN ('senate','governor') AND cycle = ?",
      )
        .bind(Number(env.CYCLE))
        .all<{ id: string; state: string; type: string }>()
    ).results;

    const candidateRows = (
      await env.DB.prepare(
        "SELECT id, race_id, name, party, nominee FROM candidates",
      ).all<RaceCandidate & { race_id: string }>()
    ).results;
    const candsByRace = new Map<string, RaceCandidate[]>();
    for (const c of candidateRows) {
      const list = candsByRace.get(c.race_id) ?? [];
      list.push(c);
      candsByRace.set(c.race_id, list);
    }

    // Existing polls (any source) for cross-source dedup.
    const existing = (
      await env.DB.prepare(
        "SELECT race_id, end_date, dem_pct, rep_pct FROM polls WHERE end_date > date('now', '-150 days')",
      ).all<{ race_id: string; end_date: string; dem_pct: number; rep_pct: number }>()
    ).results;
    const existingByRace = new Map<string, { end: number; dem: number; rep: number }[]>();
    for (const e of existing) {
      const list = existingByRace.get(e.race_id) ?? [];
      list.push({ end: Date.parse(e.end_date), dem: e.dem_pct, rep: e.rep_pct });
      existingByRace.set(e.race_id, list);
    }

    const out: Poll[] = [];
    let missingPages = 0;
    let duplicates = 0;
    for (const race of races) {
      const html = await fetchArticleHtml(pageTitle(race));
      if (html === null) {
        missingPages++;
        continue;
      }
      const candidates = candsByRace.get(race.id) ?? [];
      const seen = existingByRace.get(race.id) ?? [];

      for (const p of parseWikiPolls(html)) {
        const dup = seen.some(
          (e) =>
            Math.abs(e.end - Date.parse(p.endDate)) <= 86_400_000 &&
            Math.abs(e.dem - p.demPct) < 0.7 &&
            Math.abs(e.rep - p.repPct) < 0.7,
        );
        if (dup) {
          duplicates++;
          continue;
        }

        // Wikipedia articles keep hypothetical-matchup tables for people who
        // never filed (Whitmer/Buttigieg-style trial heats). Only accept a
        // poll when both names map to declared candidates of the right
        // party — same strictness as the VoteHub source.
        const demMatch = matchCandidate(p.demName, candidates);
        const repMatch = matchCandidate(p.repName, candidates);
        if (demMatch?.party !== "D" || repMatch?.party !== "R") continue;
        if (
          testsPrimaryLoser(demMatch.candidate, candidates, "D") ||
          testsPrimaryLoser(repMatch.candidate, candidates, "R")
        ) {
          continue;
        }

        out.push({
          raceId: race.id,
          pollster: p.pollster,
          startDate: p.startDate,
          endDate: p.endDate,
          sampleSize: p.sampleSize,
          population: p.population,
          demPct: p.demPct,
          repPct: p.repPct,
          demCandidateId: demMatch?.candidate?.id ?? null,
          repCandidateId: repMatch?.candidate?.id ?? null,
          sponsorParty: p.sponsorParty,
          sourceUrl: `https://en.wikipedia.org/wiki/${pageTitle(race).replace(/ /g, "_")}`,
        });
      }
    }
    if (missingPages > 0) console.warn(`wikipedia-races: ${missingPages} race articles missing`);
    if (duplicates > 0) console.warn(`wikipedia-races: ${duplicates} polls already known from other sources`);
    return out;
  },
};
