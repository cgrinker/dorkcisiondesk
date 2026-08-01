import type { RaceRow } from "./api";

export const fmtPct = (p: number) => `${(100 * p).toFixed(0)}%`;
export const fmtMargin = (m: number) => (m >= 0 ? `D+${m.toFixed(1)}` : `R+${(-m).toFixed(1)}`);

/** Turn "STEVENS, HALEY" / "Haley Stevens" into "Stevens". */
export function surname(name: string | null): string | null {
  if (!name) return null;
  const comma = name.split(",");
  const last = comma.length > 1 ? comma[0]! : name.trim().split(/\s+/).pop()!;
  return last
    .toLowerCase()
    .split(/([ -])/)
    .map((w) => (w.length > 1 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join("");
}

export function raceLabel(r: RaceRow): string {
  if (r.type === "house") return `${r.state}-${String(r.district).padStart(2, "0")}`;
  const kind = r.type === "senate" ? "Senate" : "Governor";
  return `${r.state} ${kind}${r.race_id.endsWith("-special") ? " (special)" : ""}`;
}

export function matchup(r: RaceRow): string {
  const d = surname(r.dem_nominee);
  const rep = surname(r.rep_nominee);
  if (d && rep) return `${d} (D) vs ${rep} (R)`;
  if (d) return `${d} (D) vs TBD (R)`;
  if (rep) return `TBD (D) vs ${rep} (R)`;
  if (r.incumbent_party && r.incumbent_party !== "open") return `${r.incumbent_party} incumbent · nominees TBD`;
  return "open seat · nominees TBD";
}
