/**
 * Poll sources.
 *
 * votehub-senate     — api.votehub.com open JSON API (free, no key). Raw
 *                      race-level polls; candidate names are mapped to
 *                      parties via the FEC-seeded candidates table.
 * silver-bulletin-gb — Nate Silver's free generic-ballot polls sheet (used
 *                      with attribution to Silver Bulletin). We ingest the
 *                      RAW dem/rep numbers, not his adjusted ones, so our
 *                      own house-effect machinery stays the single pipeline.
 *
 * Division of labor: Silver Bulletin is the only generic-ballot source and
 * VoteHub the only race-level source, so the same poll never arrives twice
 * with slightly different numbers.
 */

import type { Env, Poll, Population } from "../types";
import { matchCandidate, testsPrimaryLoser, type RaceCandidate } from "./candidates";
import { HttpError } from "./throttle";

/** Identify ourselves consistently so upstreams can reach us before blocking us. */
export const USER_AGENT =
  "elections-model/0.1 (github.com/OffByOneStudios/elections; cgrinker@gmail.com)";

export interface PollSource {
  name: string;
  fetch(env: Env): Promise<Poll[]>;
}

import { STATE_ABBR } from "./states";

// States whose only 2026 Senate contest is a special election.
const SPECIALS = new Set(["OH", "FL"]);

interface VoteHubPoll {
  id: string;
  sample_size: number | null;
  population: string | null;
  url: string | null;
  start_date: string;
  end_date: string;
  pollster: string;
  answers: { choice: string; pct: number }[];
  internal: boolean;
  partisan: string | null;
  subject: string;
}

function normPopulation(p: string | null): Population | null {
  if (p === "lv" || p === "rv" || p === "a" || p === "v") return p;
  return null;
}

function normPartisan(p: string | null): "D" | "R" | null {
  const s = p?.toLowerCase() ?? "";
  if (s.startsWith("d")) return "D";
  if (s.startsWith("r")) return "R";
  return null;
}

function votehubSource(
  name: string,
  pollType: string,
  subjectToRaceId: (subjectBody: string) => string | null,
): PollSource {
  return {
    name,
    async fetch(env) {
      const res = await fetch(
        `https://api.votehub.com/polls?poll_type=${pollType}&page_size=1000`,
        { headers: { "user-agent": USER_AGENT } },
      );
      if (!res.ok) throw new HttpError(res.status, `votehub ${res.status}`);
      const raw = (await res.json()) as VoteHubPoll[];

      // Candidate lookup, per race.
      const candidateRows = (
        await env.DB.prepare(
          "SELECT id, race_id, name, party, nominee FROM candidates",
        ).all<RaceCandidate & { race_id: string }>()
      ).results;
      const byRace = new Map<string, RaceCandidate[]>();
      for (const c of candidateRows) {
        const list = byRace.get(c.race_id) ?? [];
        list.push(c);
        byRace.set(c.race_id, list);
      }

      const polls: Poll[] = [];
      let unmapped = 0;
      let loserMatchups = 0;
      for (const p of raw) {
        // "2026 Georgia" = general; "2026 Texas Democratic" = primary — skip primaries.
        const m = /^(\d{4}) (.+?)( Democratic| Republican)?$/.exec(p.subject);
        if (!m || m[1] !== env.CYCLE || m[3]) continue;
        const raceId = subjectToRaceId(m[2]!);
        if (!raceId) continue;

        const candidates = byRace.get(raceId) ?? [];
        let dem: { pct: number; candidate: RaceCandidate | null } | null = null;
        let rep: { pct: number; candidate: RaceCandidate | null } | null = null;
        for (const a of p.answers) {
          const match = matchCandidate(a.choice, candidates);
          if (!match) continue;
          if (match.party === "D" && a.pct > (dem?.pct ?? -1)) dem = { pct: a.pct, candidate: match.candidate };
          if (match.party === "R" && a.pct > (rep?.pct ?? -1)) rep = { pct: a.pct, candidate: match.candidate };
        }
        if (dem === null || rep === null) {
          unmapped++;
          continue;
        }

        // Once a party's nominee is called, hypothetical matchups testing a
        // primary loser stop being evidence about the general election.
        if (testsPrimaryLoser(dem.candidate, candidates, "D") ||
            testsPrimaryLoser(rep.candidate, candidates, "R")) {
          loserMatchups++;
          continue;
        }

        polls.push({
          raceId,
          pollster: p.pollster,
          startDate: p.start_date,
          endDate: p.end_date,
          sampleSize: p.sample_size,
          population: normPopulation(p.population),
          demPct: dem.pct,
          repPct: rep.pct,
          demCandidateId: dem.candidate?.id ?? null,
          repCandidateId: rep.candidate?.id ?? null,
          sponsorParty: normPartisan(p.partisan),
          sourceUrl: p.url ?? undefined,
        });
      }
      if (unmapped > 0) {
        console.warn(`${name}: ${unmapped} polls skipped (candidates not yet mapped)`);
      }
      if (loserMatchups > 0) {
        console.warn(`${name}: ${loserMatchups} polls skipped (matchups testing primary losers)`);
      }
      return polls;
    },
  };
}

const stateSubject = (raceIdForAbbr: (abbr: string) => string) => (body: string) => {
  const abbr = STATE_ABBR[body];
  return abbr ? raceIdForAbbr(abbr) : null;
};

const votehubSenate = votehubSource(
  "votehub-senate",
  "us-senator",
  stateSubject((abbr) => (SPECIALS.has(abbr) ? `sen-2026-${abbr}-special` : `sen-2026-${abbr}`)),
);

const votehubGovernor = votehubSource(
  "votehub-governor",
  "governor",
  stateSubject((abbr) => `gov-2026-${abbr}`),
);

// House subjects are district codes: "2026 TX-23", at-large as "AK-01".
const votehubHouse = votehubSource("votehub-house", "us-representative", (body) => {
  const m = /^([A-Z]{2})-(\d{2}|AL)$/.exec(body);
  if (!m) return null;
  const district = m[2] === "AL" ? 1 : parseInt(m[2]!);
  return `house-2026-${m[1]}-${String(district).padStart(2, "0")}`;
});

const SB_ARTICLE =
  "https://www.natesilver.net/p/generic-ballot-average-2026-nate-silver-bulletin-congress-polls";

const SB_LINK_CACHE = "sb:csv-url";

/**
 * The sheet id can rotate, so the CSV link is resolved from the article —
 * but the article page is hit at most ~once a day (link cached in KV), and
 * only re-resolved immediately if the cached link stops working.
 */
async function resolveSbCsvLink(env: Env, force = false): Promise<string> {
  if (!force) {
    const cached = await env.FORECAST_CACHE.get(SB_LINK_CACHE);
    if (cached) return cached;
  }
  const page = await fetch(SB_ARTICLE, { headers: { "user-agent": USER_AGENT } });
  if (!page.ok) throw new HttpError(page.status, `silver bulletin article ${page.status}`);
  const html = await page.text();
  const link = /https:\/\/docs\.google\.com\/spreadsheets\/[^"'\\]+output=csv/.exec(html)?.[0];
  if (!link) throw new Error("no CSV link found in Silver Bulletin article");
  await env.FORECAST_CACHE.put(SB_LINK_CACHE, link, { expirationTtl: 86_400 });
  return link;
}

const silverBulletinGenericBallot: PollSource = {
  name: "silver-bulletin-gb",
  async fetch(env) {
    let res = await fetch(await resolveSbCsvLink(env), { headers: { "user-agent": USER_AGENT } });
    if (!res.ok) {
      // Cached link may be stale — re-resolve once before giving up.
      res = await fetch(await resolveSbCsvLink(env, true), { headers: { "user-agent": USER_AGENT } });
    }
    if (!res.ok) throw new HttpError(res.status, `silver bulletin csv ${res.status}`);
    const rows = parseCsv(await res.text());
    const header = rows[0] ?? [];
    const col = (name: string) => header.indexOf(name);
    const [cSub, cPollster, cStart, cEnd, cN, cPop, cDem, cRep, cUrl, cPartisan] = [
      col("subgroup"), col("pollster"), col("startdate"), col("enddate"),
      col("samplesize"), col("population"), col("dem"), col("rep"), col("url"), col("partisan"),
    ];

    const polls: Poll[] = [];
    for (const row of rows.slice(1)) {
      if (row[cSub] !== "All polls") continue;
      const dem = parseFloat(row[cDem] ?? "");
      const rep = parseFloat(row[cRep] ?? "");
      const start = usDateToIso(row[cStart] ?? "");
      const end = usDateToIso(row[cEnd] ?? "");
      if (!start || !end || Number.isNaN(dem) || Number.isNaN(rep)) continue;

      const pop = row[cPop]?.trim().toLowerCase();
      polls.push({
        raceId: `generic-${env.CYCLE}`,
        pollster: row[cPollster] ?? "unknown",
        startDate: start,
        endDate: end,
        sampleSize: parseInt(row[cN] ?? "") || null,
        population: normPopulation(pop === "lv" || pop === "rv" || pop === "a" || pop === "v" ? pop : null),
        demPct: dem,
        repPct: rep,
        sponsorParty: normPartisan(row[cPartisan] ?? null),
        sourceUrl: row[cUrl],
      });
    }
    return polls;
  },
};

/** "7/26/2026" -> "2026-07-26" */
function usDateToIso(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

/** Minimal quote-aware CSV parser (no embedded newlines in this sheet's fields). */
function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields: string[] = [];
      let cur = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') inQuotes = false;
          else cur += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ",") { fields.push(cur); cur = ""; }
        else cur += ch;
      }
      fields.push(cur);
      return fields;
    });
}

import { wikipediaRaces } from "./wikipedia";

// Order matters for cross-source dedup: VoteHub is the primary race-poll
// feed, so it ingests first; Wikipedia (the redundancy feed) then only adds
// polls the primaries missed.
export const POLL_SOURCES: PollSource[] = [
  silverBulletinGenericBallot,
  votehubSenate,
  votehubGovernor,
  votehubHouse,
  wikipediaRaces,
];
