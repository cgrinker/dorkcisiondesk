/**
 * Diagnostic: compare our Senate forecast against published forecaster
 * ratings (VoteHub, Cook, Sabato via Wikipedia's ratings table) and
 * cross-check our called nominees against the candidates VoteHub's most
 * recent poll actually tested. Read-only; never feeds back into the model.
 *
 * (VoteHub's forecast site itself is behind bot protection; their published
 * ratings in Wikipedia's table + their open polls API are the accessible
 * signals.)
 *
 * Run: node scripts/compare-forecasts.mjs [api-base]
 */

const API = process.argv[2] ?? "https://elections.cgrinker.workers.dev";
const UA = "elections-model/0.1 (cgrinker@gmail.com)";

const ORDER = ["Safe R", "Likely R", "Lean R", "Tossup", "Lean D", "Likely D", "Safe D"];
const classOf = (pDem) =>
  pDem >= 0.95 ? "Safe D" : pDem >= 0.8 ? "Likely D" : pDem >= 0.65 ? "Lean D"
  : pDem > 0.35 ? "Tossup" : pDem > 0.2 ? "Lean R" : pDem > 0.05 ? "Likely R" : "Safe R";

function normalizeRating(raw) {
  const s = raw.toLowerCase();
  const party = /\bd\b|dem/.test(s) ? "D" : /\br\b|rep/.test(s) ? "R" : null;
  if (/tossup|toss-up/.test(s)) return "Tossup";
  if (!party) return null;
  if (/solid|safe/.test(s)) return `Safe ${party}`;
  if (/likely/.test(s)) return `Likely ${party}`;
  if (/lean|tilt/.test(s)) return `Lean ${party}`;
  return null;
}

const STATE_ABBR = {
  Alabama: "AL", Alaska: "AK", Arkansas: "AR", Colorado: "CO", Delaware: "DE", Florida: "FL",
  Georgia: "GA", Idaho: "ID", Illinois: "IL", Iowa: "IA", Kansas: "KS", Kentucky: "KY",
  Louisiana: "LA", Maine: "ME", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Montana: "MT", Nebraska: "NE", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "North Carolina": "NC", Ohio: "OH", Oklahoma: "OK", Oregon: "OR",
  "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN",
  Texas: "TX", Virginia: "VA", "West Virginia": "WV", Wyoming: "WY",
};

const strip = (s) => s.replace(/&#91;[\s\S]*?&#93;/g, "").replace(/<[^>]+>/g, "").replace(/&#160;|&nbsp;/g, " ").trim();

// ---- Wikipedia ratings table ----
const wikiRes = await fetch(
  "https://en.wikipedia.org/w/api.php?action=parse&page=2026%20United%20States%20Senate%20elections&format=json&formatversion=2&prop=text",
  { headers: { "user-agent": UA } },
);
const html = (await wikiRes.json()).parse.text;
const table = (html.match(/<table class="wikitable[^"]*"[\s\S]*?<\/table>/g) ?? []).find(
  (t) => /VoteHub|Cook/.test(t) && /Tossup|Toss-up/.test(t),
);
if (!table) throw new Error("ratings table not found");

const rows = table.split(/<tr[^>]*>/).slice(1);
const headerRow = rows.find((r) => strip(r).startsWith("State"));
const headers = (headerRow.match(/<th[^>]*>[\s\S]*?<\/th>/g) ?? []).map(strip);
const colOf = (name) => headers.findIndex((h) => h.startsWith(name));
const cols = { cook: colOf("Cook"), sabato: colOf("Sabato"), votehub: colOf("VoteHub") };
console.log(`ratings columns found: ${headers.join(" | ")}\n`);

const ratings = new Map(); // abbr -> {cook, sabato, votehub}
for (const row of rows) {
  const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) ?? []).map(strip);
  const abbr = STATE_ABBR[cells[0]];
  if (!abbr || cells.length < headers.length - 1) continue;
  const entry = {};
  for (const [k, i] of Object.entries(cols)) {
    if (i >= 0 && cells[i]) entry[k] = normalizeRating(cells[i]);
  }
  // Two senate races in a state (special): second occurrence keyed abbr-2.
  ratings.set(ratings.has(abbr) ? `${abbr}-2` : abbr, entry);
}

// ---- Our forecast + VoteHub latest-poll candidates ----
const ours = await (await fetch(`${API}/races?type=senate&limit=100`)).json();
const vhPolls = await (
  await fetch("https://api.votehub.com/polls?poll_type=us-senator&page_size=1000", {
    headers: { "user-agent": UA },
  })
).json();

const latestPollByState = new Map();
for (const p of vhPolls) {
  const m = /^2026 (.+?)( Democratic| Republican)?$/.exec(p.subject);
  if (!m || m[2]) continue;
  const abbr = STATE_ABBR[m[1]];
  if (!abbr) continue;
  const prev = latestPollByState.get(abbr);
  if (!prev || p.end_date > prev.end_date) latestPollByState.set(abbr, p);
}

const surname = (name) => {
  if (!name) return null;
  const comma = name.split(",");
  return (comma.length > 1 ? comma[0] : name.trim().split(/\s+/).pop()).trim().toLowerCase();
};

console.log("race     ours          P(D)   VoteHub      Cook         Sabato       flags");
console.log("-".repeat(95));
const flags = [];
for (const r of ours.sort((a, b) => a.state.localeCompare(b.state))) {
  const rat = ratings.get(r.state) ?? {};
  const ourClass = classOf(r.dem_win_prob);
  const rowFlags = [];

  if (rat.votehub) {
    const gap = Math.abs(ORDER.indexOf(ourClass) - ORDER.indexOf(rat.votehub));
    if (gap >= 2) rowFlags.push(`DIVERGES from VoteHub by ${gap} steps`);
  }

  const poll = latestPollByState.get(r.state);
  if (poll && (r.dem_nominee || r.rep_nominee)) {
    const polled = poll.answers.map((a) => surname(a.choice));
    for (const [nom, party] of [[r.dem_nominee, "D"], [r.rep_nominee, "R"]]) {
      if (nom && !polled.includes(surname(nom))) {
        rowFlags.push(`our ${party} nominee "${nom}" NOT in VoteHub's latest poll (${polled.join("/")})`);
      }
    }
  }

  const pad = (s, n) => String(s ?? "—").padEnd(n);
  console.log(
    `${pad(r.race_id.replace("sen-2026-", ""), 8)} ${pad(ourClass, 13)} ${String((100 * r.dem_win_prob).toFixed(0)).padStart(3)}%   ${pad(rat.votehub, 12)} ${pad(rat.cook, 12)} ${pad(rat.sabato, 12)} ${rowFlags.join("; ")}`,
  );
  if (rowFlags.length) flags.push(`${r.race_id}: ${rowFlags.join("; ")}`);
}

console.log(`\n${flags.length} flag(s):`);
for (const f of flags) console.log(" -", f);
