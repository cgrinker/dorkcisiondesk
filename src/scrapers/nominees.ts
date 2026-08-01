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
const MAX_PAGES_PER_RUN = 15;

export interface NomineeReport {
  checked: number;
  called: string[];
  unmatched: string[];
  harvested: number;
  errors: string[];
}

export async function watchNominees(env: Env): Promise<NomineeReport> {
  const report: NomineeReport = { checked: 0, called: [], unmatched: [], harvested: 0, errors: [] };
  const today = new Date().toISOString().slice(0, 10);

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
  const byRace = new Map<string, RaceCandidate[]>();
  for (const c of candidateRows) {
    const list = byRace.get(c.race_id) ?? [];
    list.push(c);
    byRace.set(c.race_id, list);
  }

  // Some races stay pending for weeks (runoff scheduled, Ballotpedia not yet
  // updated), and refetching them every run would starve the rest of the
  // queue under MAX_PAGES_PER_RUN. Harvest-needed races go first (they gate
  // poll mapping); everything else is shuffled so all pending races cycle
  // through eventually.
  const eligible = races.filter((race) => {
    const candidates = byRace.get(race.id) ?? [];
    // Governors have no FEC feed, so their candidates come from Ballotpedia
    // too — which justifies one pre-primary visit for an empty race (poll
    // matchup mapping needs names before the primary resolves).
    const needsHarvest = race.type === "governor" && candidates.length === 0;
    const primaryDate = PRIMARY_DATES[race.state];
    if (primaryDate && today < primaryDate && !needsHarvest) return false;
    return (["D", "R"] as const).some(
      (p) => !candidates.some((c) => c.party === p && c.nominee),
    );
  });
  const harvestNeeded = (r: { id: string; type: string }) =>
    r.type === "governor" && (byRace.get(r.id) ?? []).length === 0;
  eligible.sort(
    (a, b) => Number(harvestNeeded(b)) - Number(harvestNeeded(a)) || Math.random() - 0.5,
  );

  for (const race of eligible) {
    if (report.checked >= MAX_PAGES_PER_RUN) break;
    let candidates = byRace.get(race.id) ?? [];
    const missing = (["D", "R"] as const).filter(
      (p) => !candidates.some((c) => c.party === p && c.nominee),
    );

    report.checked++;
    let html: string;
    try {
      html = await fetchRacePage(race);
    } catch (e) {
      // Rate-limiting must propagate (cools down the whole source); a bad
      // page title or transient miss shouldn't abort the rest of the sweep.
      if (e instanceof HttpError && (e.status === 429 || e.status === 403)) throw e;
      report.errors.push(e instanceof Error ? e.message : String(e));
      continue;
    }

    if (race.type === "governor") {
      const found = parseCandidates(html);
      const fresh = found.filter(
        (f) => !candidates.some((c) => c.name.toLowerCase() === f.name.toLowerCase()),
      );
      if (fresh.length > 0) {
        await env.DB.batch(
          fresh.map((f) =>
            env.DB.prepare(
              "INSERT OR IGNORE INTO candidates (race_id, name, party) VALUES (?, ?, ?)",
            ).bind(race.id, f.name, f.party),
          ),
        );
        report.harvested += fresh.length;
        // Reload so nominee matching below sees the new rows (with ids).
        candidates = (
          await env.DB.prepare(
            "SELECT id, name, party, nominee FROM candidates WHERE race_id = ?",
          )
            .bind(race.id)
            .all<RaceCandidate>()
        ).results;
      }
    }

    const winners = parseNominees(html);
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

async function fetchRacePage(race: { id: string; state: string; type: string }): Promise<string> {
  const name = STATE_NAME[race.state]?.replace(/ /g, "_");
  // Alaska elects governor + lt. governor as a ticket; Ballotpedia's title
  // reflects that.
  const govKind =
    race.state === "AK" ? "gubernatorial_and_lieutenant_gubernatorial" : "gubernatorial";
  const url =
    race.type === "governor"
      ? `https://ballotpedia.org/${name}_${govKind}_election,_2026`
      : `https://ballotpedia.org/United_States_Senate_${race.id.endsWith("-special") ? "special_election" : "election"}_in_${name},_2026`;
  const res = await fetch(url, { headers: { "user-agent": BROWSER_UA } });
  if (!res.ok) throw new HttpError(res.status, `ballotpedia ${res.status} for ${race.id}`);
  const html = await res.text();
  // Ballotpedia's bot challenge answers 202 (or 200 with a stub body) under
  // burst load; a real race page is hundreds of KB. Don't parse a challenge
  // page as "no candidates".
  if (res.status === 202 || html.length < 20_000) {
    throw new HttpError(429, `ballotpedia challenge page for ${race.id}`);
  }
  return html;
}

/**
 * Extract this cycle's candidates (name + party) from a Ballotpedia race
 * page. Two signals, current cycle only: general-election rows carry a
 * "(D)"/"(R)" marker after the name; party-primary blocks imply the party of
 * everyone in them. Write-ins are skipped.
 */
export function parseCandidates(html: string): { name: string; party: string }[] {
  const blocks = html.split('class="votebox"');
  const out = new Map<string, string>();
  let generalsSeen = 0;

  for (const block of blocks.slice(1)) {
    const heading = /votebox-header-election-type[^>]*>([^<]+)/.exec(block)?.[1]?.trim() ?? "";
    // Winner names may be wrapped in <b><u> — tolerate inline formatting
    // tags between the cell and the anchor, and after the anchor closes.
    const rows = [
      ...block.matchAll(
        /votebox-results-cell--text"[^>]*>(?:\s|<\/?[bui]>)*<a [^>]*>([^<]+)<\/a>(?:\s|<\/?[bui]>)*((?:&#160;|[^<])*)/g,
      ),
    ].map((m) => ({ name: m[1]!.trim(), trailer: m[2]!.replace(/&#160;/g, " ").trim() }));

    if (/^General election/i.test(heading)) {
      generalsSeen++;
      if (generalsSeen >= 2) break; // older cycles below
      for (const r of rows) {
        if (/write-?in/i.test(r.trailer)) continue;
        const party = /^\(([A-Z])\)/.exec(r.trailer)?.[1];
        if (party && !out.has(r.name.toLowerCase())) out.set(r.name.toLowerCase(), `${r.name}|${party}`);
      }
      continue;
    }

    const party = /^Democratic primary/i.test(heading) ? "D" : /^Republican primary/i.test(heading) ? "R" : null;
    if (!party) continue;
    for (const r of rows) {
      if (/write-?in/i.test(r.trailer)) continue;
      if (!out.has(r.name.toLowerCase())) out.set(r.name.toLowerCase(), `${r.name}|${party}`);
    }
  }

  return [...out.values()].map((v) => {
    const [name, party] = v.split("|");
    return { name: name!, party: party! };
  });
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
        /results_row\s+winner[\s\S]*?votebox-results-cell--text"[^>]*>(?:\s|<\/?[bui]>)*<a [^>]*>([^<]+)/g,
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
