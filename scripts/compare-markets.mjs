/**
 * Diagnostic: our model vs prediction-market prices (Kalshi, via the public
 * elections API). Markets are NEVER model inputs (see docs/model-math.md);
 * this is the reverse direction — using the model to spot prices that
 * disagree with it. Kalshi event tickers come from data/scrape.json.
 *
 * Run: node scripts/compare-markets.mjs [api-base]
 */

import { readFileSync } from "node:fs";

const API = process.argv[2] ?? "https://elections.cgrinker.workers.dev";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

// race_id (ours) -> kalshi event ticker
const scrape = JSON.parse(readFileSync("data/scrape.json", "utf8"));
const SPECIALS = new Set(["OH", "FL"]);
const tickers = new Map();
for (const item of scrape.items) {
  const m = /^([SGH])2026([A-Z]{2})(\d{2})$/.exec(item.race_id);
  if (!m || !item.kalshi_market?.event_ticker) continue;
  const [, kind, state, num] = m;
  let id = null;
  if (kind === "S") id = SPECIALS.has(state) ? `sen-2026-${state}-special` : `sen-2026-${state}`;
  else if (kind === "G") id = `gov-2026-${state}`;
  else id = `house-2026-${state}-${String(num === "00" ? 1 : parseInt(num)).padStart(2, "0")}`;
  tickers.set(id, item.kalshi_market.event_ticker);
}

async function kalshiDemMid(eventTicker) {
  const res = await fetch(`${KALSHI}/markets?event_ticker=${eventTicker}`);
  if (!res.ok) return null;
  const markets = (await res.json()).markets ?? [];
  const dem = markets.find((m) => m.ticker.endsWith("-D"));
  if (!dem) return null; // person-style market; skip rather than guess
  const ob = await fetch(`${KALSHI}/markets/${dem.ticker}/orderbook`);
  if (!ob.ok) return null;
  const book = (await ob.json()).orderbook_fp ?? {};
  const best = (side) =>
    (book[side] ?? []).reduce((a, [p]) => Math.max(a, parseFloat(p)), 0);
  const yesBid = best("yes_dollars");
  const noBid = best("no_dollars");
  if (yesBid === 0 && noBid === 0) return null;
  const yesAsk = noBid > 0 ? 1 - noBid : null;
  const mid = yesAsk !== null && yesBid > 0 ? (yesBid + yesAsk) / 2 : (yesBid || yesAsk);
  return { mid, spread: yesAsk !== null && yesBid > 0 ? yesAsk - yesBid : null };
}

const ours = [];
for (const type of ["senate", "governor", "house"]) {
  ours.push(...(await (await fetch(`${API}/races?type=${type}&limit=500`)).json()));
}

const rows = [];
for (const r of ours) {
  const eventTicker = tickers.get(r.race_id);
  if (!eventTicker) continue;
  // Only bother with races where a disagreement could be meaningful.
  if (r.type === "house" && (r.dem_win_prob < 0.1 || r.dem_win_prob > 0.9)) continue;
  const market = await kalshiDemMid(eventTicker).catch(() => null);
  if (!market || market.mid === null) continue;
  rows.push({
    id: r.race_id,
    model: r.dem_win_prob,
    market: market.mid,
    spread: market.spread,
    diff: r.dem_win_prob - market.mid,
    nPolls: r.n_polls,
  });
  await new Promise((res) => setTimeout(res, 120)); // politeness
}

rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
console.log(`compared ${rows.length} races with live Kalshi quotes\n`);
console.log("race                   model  market  diff   spread  polls");
for (const r of rows) {
  console.log(
    `${r.id.padEnd(22)} ${(100 * r.model).toFixed(0).padStart(4)}%  ${(100 * r.market).toFixed(0).padStart(5)}%  ${((r.diff >= 0 ? "+" : "") + (100 * r.diff).toFixed(0)).padStart(4)}  ${r.spread !== null ? (100 * r.spread).toFixed(0).padStart(5) + "c" : "    ?"}  ${r.nPolls}`,
  );
}
