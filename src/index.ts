import type { Env } from "./types";
import { runForecast } from "./model/forecast";
import { scrapeAll } from "./scrapers";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/admin/") && env.ADMIN_TOKEN) {
      if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ error: "unauthorized" }, 401);
      }
    }

    switch (url.pathname) {
      case "/": {
        const cached = await env.FORECAST_CACHE.get("latest");
        if (!cached) return json({ error: "no forecast yet — run POST /admin/run" }, 404);
        const summary = JSON.parse(cached);
        const ageMs = Date.now() - Date.parse(summary.generatedAt ?? 0);
        return json({
          ...summary,
          stale: ageMs > 6 * 3_600_000, // point an uptime monitor at this
          credits: {
            pollster_ratings_and_generic_ballot: "Silver Bulletin (natesilver.net)",
            race_polls: "VoteHub (votehub.com)",
            primary_results: "Ballotpedia (ballotpedia.org)",
            campaign_finance: "Federal Election Commission",
            economic_data: "FRED, Federal Reserve Bank of St. Louis",
          },
        });
      }

      case "/races": {
        const rows = await env.DB.prepare(
          `SELECT f.* FROM forecasts f
            WHERE f.run_id = (SELECT id FROM runs ORDER BY id DESC LIMIT 1)
            ORDER BY ABS(f.dem_win_prob - 0.5) ASC`,
        ).all();
        return json(rows.results);
      }

      case "/polls": {
        const race = url.searchParams.get("race");
        const rows = await env.DB.prepare(
          `SELECT p.*, ps.name AS pollster FROM polls p
             JOIN pollsters ps ON ps.id = p.pollster_id
            WHERE (? IS NULL OR p.race_id = ?)
            ORDER BY p.end_date DESC LIMIT 200`,
        )
          .bind(race, race)
          .all();
        return json(rows.results);
      }

      case "/history": {
        const rows = await env.DB.prepare(
          "SELECT id, n_sims, summary_json FROM runs ORDER BY id DESC LIMIT 50",
        ).all();
        return json(
          rows.results.map((r) => ({ ...r, summary_json: JSON.parse(r.summary_json as string) })),
        );
      }

      // Manual triggers for development; put behind auth before exposing publicly.
      // ?force=1 bypasses per-source throttle gating (e.g. right after a
      // primary is called). Cooldowns from upstream pushback also reset.
      case "/admin/scrape":
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        return json(await scrapeAll(env, url.searchParams.get("force") === "1"));

      case "/admin/run":
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        return json(await runForecast(env));

      // Call a primary: POST /admin/nominee?race=sen-2026-MI&party=D&name=stevens
      // Clear a call:   POST /admin/nominee?race=sen-2026-MI&party=D&clear=1
      case "/admin/nominee": {
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        const race = url.searchParams.get("race");
        const party = url.searchParams.get("party");
        if (!race || !party) return json({ error: "race and party are required" }, 400);

        if (url.searchParams.get("clear")) {
          await env.DB.prepare(
            "UPDATE candidates SET nominee = 0 WHERE race_id = ? AND party = ?",
          )
            .bind(race, party)
            .run();
          return json({ cleared: { race, party } });
        }

        const name = url.searchParams.get("name")?.toLowerCase();
        if (!name) return json({ error: "name (last name) is required" }, 400);
        const matches = (
          await env.DB.prepare(
            "SELECT id, name FROM candidates WHERE race_id = ? AND party = ? AND lower(name) LIKE ?",
          )
            .bind(race, party, `%${name}%`)
            .all<{ id: number; name: string }>()
        ).results;
        if (matches.length !== 1) {
          return json({ error: "need exactly one match", matches: matches.map((m) => m.name) }, 400);
        }

        await env.DB.batch([
          env.DB.prepare("UPDATE candidates SET nominee = 0 WHERE race_id = ? AND party = ?")
            .bind(race, party),
          env.DB.prepare("UPDATE candidates SET nominee = 1 WHERE id = ?").bind(matches[0]!.id),
        ]);
        return json({ nominee: { race, party, candidate: matches[0]!.name } });
      }

      default:
        return json({ error: "not found" }, 404);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Two cron expressions: minute 0 = scrape, minute 15 = model run.
    const minute = new Date(controller.scheduledTime).getUTCMinutes();
    if (minute === 0) {
      ctx.waitUntil(scrapeAll(env));
    } else {
      ctx.waitUntil(runForecast(env));
    }
  },
} satisfies ExportedHandler<Env>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
    },
  });
}
