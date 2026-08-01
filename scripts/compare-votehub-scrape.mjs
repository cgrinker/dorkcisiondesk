/**
 * Exact-number comparison against a VoteHub forecast scrape (data/scrape.json,
 * captured manually from their site — their forecast pages are bot-protected).
 * Diagnostic only; never feeds the model.
 *
 * Decode: every summary number (probability, margin, CIs) references the
 * REPUBLICAN side, regardless of candidate order (verified: Hickenlooper's
 * CO p=0.001, Omar's MN-05 margin=-57.1, Collins's ME p=0.371). Race ids:
 * S2026ME02 = senate (class suffix), G2026AK00 = governor, H2026TX23 = house
 * district (00 = at-large).
 *
 * Run: node scripts/compare-votehub-scrape.mjs [api-base]
 */

import { readFileSync } from "node:fs";

const API = process.argv[2] ?? "https://elections.cgrinker.workers.dev";
const scrape = JSON.parse(readFileSync("data/scrape.json", "utf8"));

const SPECIALS = new Set(["OH", "FL"]);

function ourRaceId(vh) {
  const m = /^([SGH])2026([A-Z]{2})(\d{2})$/.exec(vh.race_id);
  if (!m) return null;
  const [, kind, state, num] = m;
  if (kind === "S") return SPECIALS.has(state) ? `sen-2026-${state}-special` : `sen-2026-${state}`;
  if (kind === "G") return `gov-2026-${state}`;
  const district = num === "00" ? 1 : parseInt(num);
  return `house-2026-${state}-${String(district).padStart(2, "0")}`;
}

function demSide(vh) {
  if (!vh.summary) return null;
  const p = vh.summary.probability;
  const margin = vh.summary.margin;
  const [lo, hi] = vh.summary.margin_conf_intervals ?? [null, null];
  return {
    pDem: 1 - p,
    demMargin: -margin,
    ciLo: hi === null ? null : -hi,
    ciHi: lo === null ? null : -lo,
    demName: vh.cands?.find((c) => (c.caucus ?? c.party) === "D")?.candidate_name ?? null,
    repName: vh.cands?.find((c) => (c.caucus ?? c.party) === "R")?.candidate_name ?? null,
  };
}

const ours = new Map();
for (const type of ["senate", "governor", "house"]) {
  const rows = await (await fetch(`${API}/races?type=${type}&limit=500`)).json();
  for (const r of rows) ours.set(r.race_id, r);
}

const surname = (n) => n?.split(",")[0]?.trim().split(/\s+/).pop()?.toLowerCase() ?? n?.trim().split(/\s+/).pop()?.toLowerCase();

const joined = [];
const nameFlags = [];
for (const vh of scrape.items) {
  const id = ourRaceId(vh);
  const us = id && ours.get(id);
  const them = demSide(vh);
  if (!us || !them) continue;
  joined.push({
    id,
    type: us.type,
    usP: us.dem_win_prob,
    vhP: them.pDem,
    dP: us.dem_win_prob - them.pDem,
    usM: us.dem_margin_mean,
    vhM: them.demMargin,
    usW: us.dem_margin_p90 - us.dem_margin_p10,
    vhW: them.ciHi !== null && them.ciLo !== null ? them.ciHi - them.ciLo : null,
    nPolls: us.n_polls,
  });

  // Nominee cross-check (senate/gov only — we don't call House nominees).
  if (us.type !== "house") {
    for (const [ourName, theirName, party] of [
      [us.dem_nominee, them.demName, "D"],
      [us.rep_nominee, them.repName, "R"],
    ]) {
      if (ourName && theirName && surname(ourName) !== surname(theirName)) {
        nameFlags.push(`${id} ${party}: ours="${ourName}" votehub="${theirName}"`);
      }
    }
  }
}

const byType = (t) => joined.filter((j) => j.type === t);
const stats = (rows) => {
  const abs = rows.map((r) => Math.abs(r.dP));
  const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
  const flips = rows.filter((r) => (r.usP - 0.5) * (r.vhP - 0.5) < 0 && Math.abs(r.usP - 0.5) > 0.03 && Math.abs(r.vhP - 0.5) > 0.03);
  const withW = rows.filter((r) => r.vhW !== null && r.vhW > 0 && r.usW > 0);
  const wRatio = withW.reduce((a, r) => a + r.usW / r.vhW, 0) / withW.length;
  return { n: rows.length, meanAbsDp: mean, flips, wRatio };
};

console.log("=== per-chamber agreement (Δp = ours − VoteHub, Dem win prob) ===");
for (const t of ["senate", "governor", "house"]) {
  const s = stats(byType(t));
  console.log(
    `${t.padEnd(9)} n=${s.n}  mean|Δp|=${(100 * s.meanAbsDp).toFixed(1)}pts  direction-flips=${s.flips.length}  our-CI/their-CI width=${s.wRatio.toFixed(2)}`,
  );
}

const theirSeats = byType("house").reduce((a, r) => a + r.vhP, 0);
const ourSeats = byType("house").reduce((a, r) => a + r.usP, 0);
console.log(`\nHouse expected D seats: ours ${ourSeats.toFixed(1)} vs VoteHub ${theirSeats.toFixed(1)}`);

console.log("\n=== largest divergences ===");
for (const r of [...joined].sort((a, b) => Math.abs(b.dP) - Math.abs(a.dP)).slice(0, 12)) {
  console.log(
    `${r.id.padEnd(22)} ours ${(100 * r.usP).toFixed(0).padStart(3)}% (D${r.usM >= 0 ? "+" : ""}${r.usM.toFixed(1)})  vh ${(100 * r.vhP).toFixed(0).padStart(3)}% (D${r.vhM >= 0 ? "+" : ""}${r.vhM.toFixed(1)})  Δ${(100 * r.dP).toFixed(0)}pts  polls=${r.nPolls}`,
  );
}

console.log("\n=== direction flips (each model >53% for opposite parties) ===");
for (const t of ["senate", "governor", "house"]) {
  for (const r of stats(byType(t)).flips) {
    console.log(`${r.id}: ours ${(100 * r.usP).toFixed(0)}% D, VoteHub ${(100 * r.vhP).toFixed(0)}% D`);
  }
}

console.log(`\n=== nominee mismatches (${nameFlags.length}) ===`);
for (const f of nameFlags) console.log(" -", f);
