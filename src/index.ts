import type { Env } from "./types";
import { runForecast } from "./model/forecast";
import { scrapeAll } from "./scrapers";
import { DOCS, history, meta, pollsList, raceDetail, racesList } from "./api";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/admin/") && env.ADMIN_TOKEN) {
      if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ error: "unauthorized" }, 401);
      }
    }

    // GET /races/{id}
    if (url.pathname.startsWith("/races/") && url.pathname.length > 7) {
      const detail = await raceDetail(env, url.pathname.slice(7));
      return detail ? json(detail) : json({ error: "unknown race" }, 404);
    }

    switch (url.pathname) {
      // "/" serves the dashboard (static asset); the JSON topline lives here.
      case "/summary": {
        const cached = await env.FORECAST_CACHE.get("latest");
        if (!cached) return json({ error: "no forecast yet — run POST /admin/run" }, 404);
        const summary = JSON.parse(cached);
        const ageMs = Date.now() - Date.parse(summary.generatedAt ?? 0);
        return json({
          ...summary,
          stale: ageMs > 6 * 3_600_000, // point an uptime monitor at this
          docs: "/docs",
          credits: DOCS.credits,
        });
      }

      case "/races":
        return json(await racesList(env, url));

      case "/polls":
        return json(await pollsList(env, url));

      case "/history":
        return json(await history(env, url));

      case "/meta":
        return json(await meta(env), 200, 60);

      case "/docs":
        return json(DOCS, 200, 3600);

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
        return json({ error: "not found", docs: "/docs" }, 404);
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

function json(data: unknown, status = 200, maxAge = 300): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });
}
