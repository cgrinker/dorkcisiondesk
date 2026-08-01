/**
 * Politeness layer for upstream sources, tracked in KV.
 *
 * Two mechanisms:
 *   cadence  — each source declares how often it's worth fetching (the cron
 *              fires every 2h, but FEC data updates nightly and FRED monthly;
 *              hitting them 12x/day is noise). `isDue` gates on the last
 *              successful run.
 *   cooldown — when an upstream pushes back (429/403/5xx), we stop calling
 *              it for a while instead of retrying into a ban.
 */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Hours to back off for a given upstream failure; null = no cooldown. */
export function cooldownHours(status: number): number | null {
  if (status === 429) return 6; // explicitly rate limited — go away for a while
  if (status === 403) return 24; // blocked — retrying faster makes it worse
  if (status >= 500) return 1; // upstream outage — give it an hour
  return null;
}

export async function isDue(
  kv: KVNamespace,
  source: string,
  intervalHours: number,
  now: Date,
): Promise<"due" | "not-due" | "cooldown"> {
  const cooldownUntil = await kv.get(`throttle:cooldown:${source}`);
  if (cooldownUntil && now.getTime() < Number(cooldownUntil)) return "cooldown";

  const last = await kv.get(`throttle:last:${source}`);
  // The 0.9 factor keeps a job scheduled every N hours from slipping a whole
  // cron period because the previous run finished a few seconds "late".
  if (last && now.getTime() - Number(last) < intervalHours * 3_600_000 * 0.9) return "not-due";
  return "due";
}

export async function markRan(kv: KVNamespace, source: string, now: Date): Promise<void> {
  await kv.put(`throttle:last:${source}`, String(now.getTime()));
}

export async function startCooldown(
  kv: KVNamespace,
  source: string,
  hours: number,
  now: Date,
): Promise<void> {
  const until = now.getTime() + hours * 3_600_000;
  await kv.put(`throttle:cooldown:${source}`, String(until), {
    expirationTtl: Math.ceil(hours * 3600) + 60,
  });
  console.warn(`throttle: ${source} cooling down ${hours}h`);
}
