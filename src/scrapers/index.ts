/**
 * Scrape orchestrator, run on the cron trigger. Poll sources are pluggable:
 * each source fetches raw data and returns normalized Poll rows; ingestion
 * and dedup are shared. Sources are tried independently so one broken
 * upstream doesn't kill the run.
 *
 * The cron fires every 2h, but each source runs on its own cadence (gated
 * through KV — see throttle.ts) so we only hit upstreams as often as their
 * data actually changes, and upstream pushback (429/403/5xx) triggers an
 * automatic cooldown instead of retries.
 */

import type { Env } from "../types";
import { ingestPolls } from "./ingest";
import { scrapeFred, scrapeFec } from "./fundamentals";
import { bootstrapCandidates } from "./candidates";
import { watchNominees, type NomineeReport } from "./nominees";
import { POLL_SOURCES } from "./polls";
import { cooldownHours, HttpError, isDue, markRan, startCooldown } from "./throttle";

/** Requests per day at these cadences: votehub ~12, silver bulletin CSV ~4
 *  (+ ~1 article-page hit/day for link resolution), FEC ~10, FRED ~3. */
const CADENCE_HOURS: Record<string, number> = {
  "votehub-senate": 2,
  "votehub-governor": 2,
  "silver-bulletin-gb": 6,
  "ballotpedia-nominees": 12,
  fec: 24,
  fred: 24,
};

type SourceResult =
  | { fetched: number; inserted: number }
  | { error: string }
  | { skipped: "not-due" | "cooldown" };

export interface ScrapeReport {
  polls: Record<string, SourceResult>;
  fec: SourceResult;
  fred: SourceResult;
  nominees: SourceResult | (NomineeReport & { fetched?: number; inserted?: number });
}

export async function scrapeAll(env: Env, force = false): Promise<ScrapeReport> {
  const now = new Date();
  const report: ScrapeReport = {
    polls: {},
    fec: { skipped: "not-due" },
    fred: { skipped: "not-due" },
    nominees: { skipped: "not-due" },
  };

  // FEC first: the VoteHub source needs candidates to map names -> parties.
  report.fec = await runGated(env, "fec", now, force, async () => {
    const newCandidates = await bootstrapCandidates(env);
    const updated = await scrapeFec(env);
    return { fetched: newCandidates, inserted: updated };
  });

  // Nominee watch after FEC (matching needs the candidates table), before
  // polls (so a fresh call filters this run's ingestion too).
  const nomineeResult = await runGated(env, "ballotpedia-nominees", now, force, async () => {
    const r = await watchNominees(env);
    return { fetched: r.checked, inserted: r.called.length, ...r };
  });
  report.nominees = nomineeResult;

  for (const source of POLL_SOURCES) {
    report.polls[source.name] = await runGated(env, source.name, now, force, async () => {
      const polls = await source.fetch(env);
      const inserted = await ingestPolls(env, polls);
      return { fetched: polls.length, inserted };
    });
  }

  report.fred = await runGated(env, "fred", now, force, async () => {
    const stored = await scrapeFred(env);
    return { fetched: stored, inserted: stored };
  });

  return report;
}

async function runGated(
  env: Env,
  name: string,
  now: Date,
  force: boolean,
  fn: () => Promise<{ fetched: number; inserted: number }>,
): Promise<SourceResult> {
  if (!force) {
    const due = await isDue(env.FORECAST_CACHE, name, CADENCE_HOURS[name] ?? 2, now);
    if (due !== "due") return { skipped: due };
  }

  try {
    const result = await fn();
    await markRan(env.FORECAST_CACHE, name, now);
    return result;
  } catch (e) {
    if (e instanceof HttpError) {
      const hours = cooldownHours(e.status);
      if (hours !== null) await startCooldown(env.FORECAST_CACHE, name, hours, now);
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
