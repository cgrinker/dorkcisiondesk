/**
 * Ballotpedia nominee watcher.
 *
 * For senate races that don't yet have a called nominee for both parties,
 * fetch the race's Ballotpedia page and read the primary results: Ballotpedia
 * marks decided contests with a `results_row winner` class. Parsing rules
 * learned from decided pages (e.g. Texas 2026):
 *
 *   - A page stacks election cycles newest-first; blocks before the SECOND
 *     "General election" heading belong to the current cycle.
 *   - A "primary runoff" block, when present, is decisive for that party.
 *   - A plain "primary" block with exactly one winner = nominee; two winner
 *     rows = advanced-to-runoff, so no call.
 *
 * The watcher only writes when a race+party has NO nominee set, so a manual
 * /admin/nominee call always wins. (To override a bad Ballotpedia call, set
 * the correct nominee — don't just clear it, or the watcher will re-apply.)
 *
 * Ballotpedia has no free API and serves content only to browser
 * user-agents; content reuse requires attribution (see /'s credits block).
 */

import type { Env } from "../types";
import { matchCandidate, type RaceCandidate } from "./candidates";
import { HttpError } from "./throttle";
import { STATE_NAME } from "./states";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Don't fetch a race's page before its primary has happened (2026 calendar;
 *  races absent from this map voted earlier in the year). */
const PRIMARY_DATES: Record<string, string> = {
  MI: "2026-08-04",
  KS: "2026-08-04",
  TN: "2026-08-06",
  MN: "2026-08-11",
  AK: "2026-08-18",
  FL: "2026-08-18",
  WY: "2026-08-18",
  MA: "2026-09-01",
  NH: "2026-09-08",
  RI: "2026-09-09",
  DE: "2026-09-15",
};

/** Bound requests per run; leftovers are picked up next cycle. */
const MAX_PAGES_PER_RUN = 12;

export interface NomineeReport {
  checked: number;
  called: string[];
  unmatched: string[];
}

export async function watchNominees(env: Env): Promise<NomineeReport> {
  const report: NomineeReport = { checked: 0, called: [], unmatched: [] };
  const today = new Date().toISOString().slice(0, 10);

  const races = (
    await env.DB.prepare(
      "SELECT id, state FROM races WHERE type = 'senate' AND cycle = ?",
    )
      .bind(Number(env.CYCLE))
      .all<{ id: string; state: string }>()
  ).results;

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

  for (const race of races) {
    if (report.checked >= MAX_PAGES_PER_RUN) break;
    const primaryDate = PRIMARY_DATES[race.state];
    if (primaryDate && today < primaryDate) continue;

    const candidates = byRace.get(race.id) ?? [];
    const missing = (["D", "R"] as const).filter(
      (p) => !candidates.some((c) => c.party === p && c.nominee),
    );
    if (missing.length === 0) continue;

    report.checked++;
    const winners = parseNominees(await fetchRacePage(race));
    for (const party of missing) {
      const winnerName = winners[party];
      if (!winnerName) continue;
      const match = matchCandidate(winnerName, candidates);
      if (!match?.candidate || match.party !== party) {
        report.unmatched.push(`${race.id}/${party}: "${winnerName}" not in candidates table`);
        continue;
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE candidates SET nominee = 0 WHERE race_id = ? AND party = ?")
          .bind(race.id, party),
        env.DB.prepare("UPDATE candidates SET nominee = 1 WHERE id = ?").bind(match.candidate.id),
      ]);
      report.called.push(`${race.id}/${party}: ${winnerName}`);
      console.warn(`nominee-watch: called ${race.id} ${party} for ${winnerName} (via Ballotpedia)`);
    }
  }
  return report;
}

async function fetchRacePage(race: { id: string; state: string }): Promise<string> {
  const name = STATE_NAME[race.state]?.replace(/ /g, "_");
  const kind = race.id.endsWith("-special") ? "special_election" : "election";
  const url = `https://ballotpedia.org/United_States_Senate_${kind}_in_${name},_2026`;
  const res = await fetch(url, { headers: { "user-agent": BROWSER_UA } });
  if (!res.ok) throw new HttpError(res.status, `ballotpedia ${res.status} for ${race.id}`);
  return res.text();
}

/** Extract this cycle's called D/R nominees from a Ballotpedia race page. */
export function parseNominees(html: string): { D?: string; R?: string } {
  const blocks = html.split('class="votebox"');
  const result: { D?: string; R?: string } = {};
  const seen = { primary: {} as Record<string, string[]>, runoff: {} as Record<string, string[]> };

  let generalsSeen = 0;
  for (const block of blocks.slice(1)) {
    const heading = /votebox-header-election-type[^>]*>([^<]+)/.exec(block)?.[1]?.trim() ?? "";
    if (/^General election/i.test(heading)) {
      generalsSeen++;
      if (generalsSeen >= 2) break; // older cycles start here
      continue;
    }
    const party = /^Democratic/i.test(heading) ? "D" : /^Republican/i.test(heading) ? "R" : null;
    if (!party || !/primary/i.test(heading)) continue;

    const winners = [
      ...block.matchAll(
        /results_row\s+winner[\s\S]*?votebox-results-cell--text"[^>]*>\s*<a [^>]*>([^<]+)/g,
      ),
    ].map((m) => m[1]!.trim());

    const kind = /runoff/i.test(heading) ? "runoff" : "primary";
    seen[kind][party] = winners;
  }

  for (const party of ["D", "R"] as const) {
    const runoff = seen.runoff[party];
    const primary = seen.primary[party];
    // Runoff is decisive when present; a plain primary with 2+ winners just
    // means "advanced to a runoff that hasn't been decided yet".
    if (runoff?.length === 1) result[party] = runoff[0];
    else if (!runoff && primary?.length === 1) result[party] = primary[0];
  }
  return result;
}
