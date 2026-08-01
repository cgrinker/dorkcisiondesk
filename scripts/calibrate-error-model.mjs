/**
 * Calibrate the simulation's error structure against Silver Bulletin's
 * rawpolls archive (12k+ polls, 1998–2024, with actual results).
 *
 * Decomposes late-poll error into a cycle-level (national) component and a
 * residual race-level component per race type, which is exactly what
 * simulate.ts parameterizes (nationalErrorSd, idiosyncratic sd).
 *
 * Run: node scripts/calibrate-error-model.mjs
 */

import XLSX from "xlsx";

const wb = XLSX.readFile("data/rawpolls.xlsx");
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

// General-election polls with a real result, last 21 days before the election.
const general = rows.filter(
  (r) =>
    typeof r.margin_poll === "number" &&
    typeof r.margin_actual === "number" &&
    typeof r.polldate === "number" &&
    typeof r.electiondate === "number" &&
    r.electiondate - r.polldate <= 21 &&
    ["Sen-G", "Gov-G", "House-G", "Pres-GE"].includes(r.type_simple),
);

const sd = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

for (const type of ["Sen-G", "Gov-G", "House-G", "Pres-GE"]) {
  const polls = general.filter((r) => r.type_simple === type);
  const errs = polls.map((r) => r.margin_poll - r.margin_actual); // + = overstated Dem/cand1

  // Cycle-level mean error = the systematic "national" miss that year.
  const byYear = new Map();
  for (const r of polls) {
    const list = byYear.get(r.year) ?? [];
    list.push(r.margin_poll - r.margin_actual);
    byYear.set(r.year, list);
  }
  const cycleMeans = [...byYear.entries()]
    .filter(([, v]) => v.length >= 10)
    .map(([y, v]) => ({ year: y, bias: mean(v), n: v.length }));

  const residuals = polls
    .map((r) => {
      const cm = cycleMeans.find((c) => c.year === r.year);
      return cm ? r.margin_poll - r.margin_actual - cm.bias : null;
    })
    .filter((x) => x !== null);

  console.log(`\n=== ${type} (${polls.length} late polls) ===`);
  console.log(`  overall error sd:          ${sd(errs).toFixed(2)} pts`);
  console.log(`  cycle-mean bias sd:        ${sd(cycleMeans.map((c) => c.bias)).toFixed(2)} pts  <- national error`);
  console.log(`  residual (race-level) sd:  ${sd(residuals).toFixed(2)} pts  <- idiosyncratic error`);
  console.log(
    `  cycle biases: ${cycleMeans
      .sort((a, b) => a.year - b.year)
      .map((c) => `${c.year}: ${c.bias > 0 ? "+" : ""}${c.bias.toFixed(1)}`)
      .join(", ")}`,
  );
}
