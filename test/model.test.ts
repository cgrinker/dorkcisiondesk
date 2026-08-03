import { describe, expect, it } from "vitest";
import { makeRng, normal, studentT, normalCdf } from "../src/model/stats";
import { averagePolls, adjustedMargin } from "../src/model/pollAverage";
import { fundamentalsPrior } from "../src/model/fundamentals";
import { blend } from "../src/model/blend";
import { simulate, chamberSummary, type SimRace } from "../src/model/simulate";
import { matchCandidate, testsPrimaryLoser, type RaceCandidate } from "../src/scrapers/candidates";
import { cooldownHours, isDue, markRan, startCooldown } from "../src/scrapers/throttle";
import { parseCandidates, parseNominees } from "../src/scrapers/nominees";
import { parseDateRange, parseWikiPolls } from "../src/scrapers/wikipedia";
import type { Race, ScoredPoll } from "../src/types";

function poll(overrides: Partial<ScoredPoll> = {}): ScoredPoll {
  return {
    raceId: "sen-2026-GA",
    pollster: "Test Polling",
    startDate: "2026-07-20",
    endDate: "2026-07-25",
    sampleSize: 800,
    population: "lv",
    demPct: 48,
    repPct: 46,
    sponsorParty: null,
    quality: 0.8,
    houseEffect: 0,
    ...overrides,
  };
}

const race = (id: string, overrides: Partial<Race> = {}): Race => ({
  id,
  cycle: 2026,
  type: "senate",
  state: "GA",
  district: null,
  partisanLean: -1,
  incumbentParty: "D",
  incumbentLastMargin: null,
  region: "south",
  ...overrides,
});

describe("stats", () => {
  it("seeded rng is reproducible", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect(a()).toBe(b());
  });

  it("normal draws have ~0 mean and ~1 sd", () => {
    const rng = makeRng(1);
    const draws = Array.from({ length: 20000 }, () => normal(rng));
    const mean = draws.reduce((a, b) => a + b) / draws.length;
    const sd = Math.sqrt(draws.reduce((a, b) => a + b * b, 0) / draws.length - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(sd - 1)).toBeLessThan(0.03);
  });

  it("studentT respects requested sd", () => {
    const rng = makeRng(2);
    const draws = Array.from({ length: 40000 }, () => studentT(rng, 5, 3));
    const mean = draws.reduce((a, b) => a + b) / draws.length;
    const sd = Math.sqrt(draws.reduce((a, b) => a + b * b, 0) / draws.length - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.1);
    expect(Math.abs(sd - 3)).toBeLessThan(0.25);
  });

  it("normalCdf matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });
});

describe("poll adjustments", () => {
  it("subtracts house effects", () => {
    expect(adjustedMargin(poll({ houseEffect: 2 }))).toBeCloseTo(0);
  });

  it("shifts partisan-sponsored polls against the sponsor", () => {
    expect(adjustedMargin(poll({ sponsorParty: "D" }))).toBeCloseTo(0.5);
    expect(adjustedMargin(poll({ sponsorParty: "R" }))).toBeCloseTo(3.5);
  });

  it("in a sparse race, the newest poll keeps at least half strength", () => {
    const asOf = new Date("2026-08-01");
    // Only poll is 5 weeks old: absolute decay would leave ~12% weight.
    const sparse = averagePolls([poll({ endDate: "2026-06-27", startDate: "2026-06-24" })], asOf, 93);
    expect(sparse.evidence).toBeGreaterThan(0.4); // floored, not decayed away
    // A fresh-polled race is untouched by the floor.
    const fresh = averagePolls([poll({ endDate: "2026-07-30", startDate: "2026-07-28" })], asOf, 93);
    expect(fresh.evidence).toBeGreaterThan(sparse.evidence);
    // And staler polls still rank below fresher ones within the race.
    const mixed = averagePolls(
      [
        poll({ demPct: 50, repPct: 40, endDate: "2026-06-27" }),
        poll({ demPct: 40, repPct: 50, endDate: "2026-05-01" }),
      ],
      asOf,
      93,
    );
    expect(mixed.margin).toBeGreaterThan(0);
  });

  it("weights recent polls more", () => {
    const asOf = new Date("2026-08-01");
    const fresh = averagePolls([poll({ demPct: 50, repPct: 40 })], asOf, 94);
    const staleAndFresh = averagePolls(
      [
        poll({ demPct: 50, repPct: 40 }),
        poll({ demPct: 40, repPct: 50, endDate: "2026-04-01", startDate: "2026-03-28" }),
      ],
      asOf,
      94,
    );
    expect(fresh.margin).toBeCloseTo(10);
    expect(staleAndFresh.margin).toBeGreaterThan(5); // stale poll pulls down only slightly
  });
});

describe("candidate history (crossover incumbents)", () => {
  it("a repeat incumbent's own record dominates the structural guess", () => {
    // Vermont-style: deep-blue lean, wildly overperforming R incumbent.
    const vt = race("gov-2026-VT", {
      type: "governor", state: "VT", partisanLean: 30,
      incumbentParty: "R", incumbentLastMargin: -51.6,
    });
    const prior = fundamentalsPrior(vt, { genericBallot: 4.5, logFundraisingRatio: null }, 90);
    expect(prior.margin).toBeLessThan(-35); // Scott heavily favored despite D+30 lean
  });

  it("without history, behavior is unchanged (flat incumbency)", () => {
    const withHist = fundamentalsPrior(
      race("x", { incumbentLastMargin: null, incumbentParty: "D", partisanLean: 5 }),
      { genericBallot: 4, logFundraisingRatio: null }, 90,
    );
    expect(withHist.margin).toBeCloseTo(5 + 0.8 * 4 + 2.5, 5);
  });
});

describe("blend", () => {
  it("falls back to the prior with no polls", () => {
    const prior = fundamentalsPrior(race("sen-2026-GA"), { genericBallot: 2, logFundraisingRatio: null }, 94);
    const b = blend({ margin: NaN, evidence: 0, nPolls: 0 }, prior);
    expect(b.margin).toBe(prior.margin);
    expect(b.pollWeight).toBe(0);
  });

  it("polls dominate as evidence accumulates", () => {
    const prior = { margin: -5, sd: 8 };
    const light = blend({ margin: 5, evidence: 0.5, nPolls: 1 }, prior);
    const heavy = blend({ margin: 5, evidence: 20, nPolls: 25 }, prior);
    expect(heavy.pollWeight).toBeGreaterThan(light.pollWeight);
    expect(heavy.margin).toBeGreaterThan(light.margin);
    expect(heavy.pollWeight).toBeGreaterThan(0.9);
  });
});

describe("candidate matching and nominee filter", () => {
  const mi: RaceCandidate[] = [
    { id: 1, name: "STEVENS, HALEY", party: "D", nominee: 0 },
    { id: 2, name: "EL-SAYED, ABDUL", party: "D", nominee: 0 },
    { id: 3, name: "MCMORROW, MALLORY", party: "D", nominee: 0 },
    { id: 4, name: "ROGERS, MIKE", party: "R", nominee: 0 },
  ];

  it("matches poll answer names to FEC candidates by last name", () => {
    expect(matchCandidate("Haley Stevens", mi)).toEqual({ party: "D", candidate: mi[0] });
    expect(matchCandidate("Mike Rogers", mi)).toEqual({ party: "R", candidate: mi[3] });
    expect(matchCandidate("Abdul El-Sayed", mi)).toEqual({ party: "D", candidate: mi[1] });
    expect(matchCandidate("Someone Unknown", mi)).toBeNull();
  });

  it("keeps all matchups while no nominee is called", () => {
    expect(testsPrimaryLoser(mi[1]!, mi, "D")).toBe(false);
  });

  it("drops primary-loser matchups once the nominee is called", () => {
    const called = mi.map((c) => (c.id === 1 ? { ...c, nominee: 1 } : c));
    expect(testsPrimaryLoser(called[1]!, called, "D")).toBe(true); // El-Sayed poll
    expect(testsPrimaryLoser(called[0]!, called, "D")).toBe(false); // Stevens poll
    expect(testsPrimaryLoser(called[3]!, called, "R")).toBe(false); // Rogers unaffected
    expect(testsPrimaryLoser(null, called, "D")).toBe(false); // ambiguous match kept
  });
});

describe("ballotpedia nominee parsing", () => {
  const block = (heading: string, rows: { name: string; winner: boolean }[]) =>
    `class="votebox"><div class="votebox-header-election-type">${heading}</div>` +
    rows
      .map(
        (r) =>
          `<tr class="results_row ${r.winner ? " winner" : ""}"><td class="votebox-results-cell--text"><a href="#">${r.name}</a></td></tr>`,
      )
      .join("");

  it("reads called primaries from the current cycle only", () => {
    const html =
      `<html>` +
      block("General election for U.S. Senate Michigan", [{ name: "TBD", winner: false }]) +
      block("Democratic primary for U.S. Senate Michigan", [
        { name: "Haley Stevens", winner: true },
        { name: "Abdul El-Sayed", winner: false },
      ]) +
      block("Republican primary for U.S. Senate Michigan", [{ name: "Mike Rogers", winner: true }]) +
      // Older cycle below the second General heading — must be ignored.
      block("General election for U.S. Senate Michigan", [{ name: "Elissa Slotkin", winner: true }]) +
      block("Democratic primary for U.S. Senate Michigan", [{ name: "Elissa Slotkin", winner: true }]);
    expect(parseNominees(html)).toEqual({ D: "Haley Stevens", R: "Mike Rogers" });
  });

  it("does not call an undecided primary", () => {
    const html = block("Democratic primary for U.S. Senate Michigan", [
      { name: "Haley Stevens", winner: false },
      { name: "Abdul El-Sayed", winner: false },
    ]);
    expect(parseNominees(html)).toEqual({});
  });

  it("harvests candidates with parties from general and primary blocks", () => {
    const html =
      `class="votebox"><div class="votebox-header-election-type">General election for Governor of Arizona</div>` +
      `<tr class="results_row"><td class="votebox-results-cell--text"><a href="#">Katie Hobbs</a> (D)  </td></tr>` +
      `<tr class="results_row"><td class="votebox-results-cell--text"><a href="#">Andy Biggs</a> (R)&#160;</td></tr>` +
      `<tr class="results_row"><td class="votebox-results-cell--text"><a href="#">Liana West</a> (G)&#160;(Write-in)</td></tr>` +
      `class="votebox"><div class="votebox-header-election-type">Democratic primary for Governor of Arizona</div>` +
      `<tr class="results_row"><td class="votebox-results-cell--text"><a href="#">Marco Lopez</a> &#160;</td></tr>` +
      `class="votebox"><div class="votebox-header-election-type">General election for Governor of Arizona</div>` +
      `<tr class="results_row"><td class="votebox-results-cell--text"><a href="#">Old Timer</a> (D)</td></tr>`;
    expect(parseCandidates(html)).toEqual([
      { name: "Katie Hobbs", party: "D" },
      { name: "Andy Biggs", party: "R" },
      { name: "Marco Lopez", party: "D" },
    ]);
  });

  it("handles winner names wrapped in bold/underline (unopposed primaries)", () => {
    const html =
      `class="votebox"><div class="votebox-header-election-type">Democratic primary for Governor of Arizona</div>` +
      `<tr class="results_row  winner"><td class="votebox-results-cell--check">&#10004;</td>` +
      `<td class="votebox-results-cell--text"><b><u><a href="#">Katie Hobbs</a></u></b></td></tr>`;
    expect(parseNominees(html)).toEqual({ D: "Katie Hobbs" });
    expect(parseCandidates(html)).toEqual([{ name: "Katie Hobbs", party: "D" }]);
  });

  it("general-election slate overrides the primary record (post-primary withdrawal)", () => {
    const html =
      `class="votebox"><div class="votebox-header-election-type">General election for U.S. Senate Maine</div>` +
      `<tr class="results_row"><td class="votebox-results-cell--text"><a href="#">Troy Dale Jackson</a> (D)  </td></tr>` +
      `class="votebox"><div class="votebox-header-election-type">Democratic primary for U.S. Senate Maine</div>` +
      `<p>The following candidates advanced from the Democratic ranked-choice voting primary: <a href="#">Graham Platner</a> in round 1.</p>`;
    expect(parseNominees(html)).toEqual({ D: "Troy Dale Jackson" });
  });

  it("reads ranked-choice primary winners from the advanced-from prose", () => {
    const rcv =
      `class="votebox"><div class="votebox-header-election-type">Democratic primary for U.S. Senate Maine</div>` +
      `<p>The following candidates advanced from the Democratic ranked-choice voting primary for U.S. Senate Maine on June 9, 2026: ` +
      `<a href="#">Graham Platner</a> in round 1.</p><table></table>`;
    expect(parseNominees(rcv)).toEqual({ D: "Graham Platner" });

    // Top-four (AK): several advancers -> ambiguous, no call.
    const topFour =
      `class="votebox"><div class="votebox-header-election-type">Republican primary for U.S. Senate Alaska</div>` +
      `<p>The following candidates advanced from the ranked-choice voting primary: ` +
      `<a href="#">Al Alpha</a> in round 1, <a href="#">Bo Bravo</a> in round 1.</p>`;
    expect(parseNominees(topFour)).toEqual({});
  });

  it("treats two primary winners as advanced-to-runoff, runoff as decisive", () => {
    const pending =
      block("Republican primary for U.S. Senate Texas", [
        { name: "Ken Paxton", winner: true },
        { name: "Wesley Hunt", winner: true },
      ]);
    expect(parseNominees(pending)).toEqual({});

    const decided =
      block("Republican primary runoff for U.S. Senate Texas", [{ name: "Ken Paxton", winner: true }]) +
      pending;
    expect(parseNominees(decided)).toEqual({ R: "Ken Paxton" });
  });
});

describe("wikipedia poll parsing", () => {
  it("parses date ranges in all observed formats", () => {
    expect(parseDateRange("July 28–30, 2026")).toEqual(["2026-07-28", "2026-07-30"]);
    expect(parseDateRange("June 30 – July 2, 2026")).toEqual(["2026-06-30", "2026-07-02"]);
    expect(parseDateRange("July 28, 2026")).toEqual(["2026-07-28", "2026-07-28"]);
    expect(parseDateRange("through July 30, 2026")).toBeNull();
  });

  const table = (headers: string[], rows: string[][]) =>
    `<table class="wikitable sortable"><tbody><tr>` +
    headers.map((h) => `<th>${h}</th>`).join("") +
    `</tr>` +
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
    `</tbody></table>`;

  it("extracts general-election polls, skipping primaries and aggregates", () => {
    const html =
      // primary table: no (R) column -> ignored
      table(["Poll source", "Date(s) administered", "Sample size", "Margin of error", "Abdul El-Sayed", "Haley Stevens"],
        [["Emerson", "July 1–2, 2026", "500 (LV)", "± 4%", "40%", "45%"]]) +
      table(
        ["Poll source", "Date(s) administered", "Sample size", "Margin of error", "Haley <br/>Stevens (D)", "Mike Rogers (R)", "Other", "Undecided"],
        [
          ["SoCal Strategies (R)", "July 28–30, 2026", "640 (LV)", "± 3.8%", "44%", "42%", "—", "14%"],
          ["Glengariff Group&#91;a&#93;", "July 22–24, 2026", "600 (LV)", "± 4.0%", "45.5%", "44.7%", "1%", "9%"],
          ["Average", "45%", "43%", "", ""],
        ],
      );
    const polls = parseWikiPolls(html);
    expect(polls).toHaveLength(2);
    expect(polls[0]).toMatchObject({
      pollster: "SoCal Strategies", sponsorParty: "R",
      startDate: "2026-07-28", endDate: "2026-07-30",
      sampleSize: 640, population: "lv", demPct: 44, repPct: 42,
      demName: "Haley Stevens", repName: "Mike Rogers",
    });
    expect(polls[1]).toMatchObject({ pollster: "Glengariff Group", sponsorParty: null, demPct: 45.5, repPct: 44.7 });
  });
});

describe("scrape throttling", () => {
  function fakeKv(): KVNamespace {
    const store = new Map<string, string>();
    return {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    } as unknown as KVNamespace;
  }

  it("maps upstream pushback to sensible cooldowns", () => {
    expect(cooldownHours(429)).toBe(6);
    expect(cooldownHours(403)).toBe(24);
    expect(cooldownHours(503)).toBe(1);
    expect(cooldownHours(404)).toBeNull();
  });

  it("gates sources on their cadence", async () => {
    const kv = fakeKv();
    const t0 = new Date("2026-08-01T00:00:00Z");
    expect(await isDue(kv, "src", 6, t0)).toBe("due");
    await markRan(kv, "src", t0);
    expect(await isDue(kv, "src", 6, new Date("2026-08-01T02:00:00Z"))).toBe("not-due");
    // 0.9 slack: due again slightly before the full interval elapses.
    expect(await isDue(kv, "src", 6, new Date("2026-08-01T05:30:00Z"))).toBe("due");
  });

  it("cooldown blocks until it expires", async () => {
    const kv = fakeKv();
    const t0 = new Date("2026-08-01T00:00:00Z");
    await startCooldown(kv, "src", 6, t0);
    expect(await isDue(kv, "src", 2, new Date("2026-08-01T03:00:00Z"))).toBe("cooldown");
    expect(await isDue(kv, "src", 2, new Date("2026-08-01T06:01:00Z"))).toBe("due");
  });
});

describe("simulation", () => {
  const simRaces: SimRace[] = [
    { race: race("sen-2026-GA"), blended: { margin: 2, sd: 3, pollWeight: 0.8 }, nPolls: 10 },
    { race: race("sen-2026-NC", { state: "NC" }), blended: { margin: -2, sd: 3, pollWeight: 0.8 }, nPolls: 8 },
    { race: race("sen-2026-ME", { state: "ME", region: "northeast" }), blended: { margin: 8, sd: 4, pollWeight: 0.6 }, nPolls: 5 },
  ];

  it("is reproducible given a seed", () => {
    const a = simulate(simRaces, 94, 2000, "seed-1");
    const b = simulate(simRaces, 94, 2000, "seed-1");
    expect(a.forecasts).toEqual(b.forecasts);
  });

  it("favored candidates win more often", () => {
    const { forecasts } = simulate(simRaces, 94, 5000, "seed-2");
    expect(forecasts[0]!.demWinProb).toBeGreaterThan(0.5);
    expect(forecasts[1]!.demWinProb).toBeLessThan(0.5);
    expect(forecasts[2]!.demWinProb).toBeGreaterThan(forecasts[0]!.demWinProb);
  });

  it("same-region outcomes are correlated", () => {
    const pair: SimRace[] = [
      { race: race("a", { region: "south" }), blended: { margin: 0, sd: 2, pollWeight: 1 }, nPolls: 5 },
      { race: race("b", { region: "south" }), blended: { margin: 0, sd: 2, pollWeight: 1 }, nPolls: 5 },
    ];
    const { demWinsPerSim } = simulate(pair, 94, 5000, "seed-3");
    let both = 0;
    let first = 0;
    for (const w of demWinsPerSim) {
      if (w[0]) first++;
      if (w[0] && w[1]) both++;
    }
    // P(B wins | A wins) should exceed the unconditional ~50%.
    expect(both / first).toBeGreaterThan(0.6);
  });

  it("reports margin confidence intervals from the sim distribution", () => {
    const { forecasts } = simulate(simRaces, 94, 10000, "seed-ci");
    for (const f of forecasts) {
      expect(f.demMarginP10).toBeLessThan(f.demMarginMean);
      expect(f.demMarginP90).toBeGreaterThan(f.demMarginMean);
      // An 80% interval of a ~N(mean, sd) is about mean +/- 1.28 sd; the
      // t-tails widen it slightly. Sanity-bound it.
      const halfWidth = (f.demMarginP90 - f.demMarginP10) / 2;
      expect(halfWidth).toBeGreaterThan(f.demMarginSd);
      expect(halfWidth).toBeLessThan(2 * f.demMarginSd);
      expect(f.demWinProbMcSe).toBeGreaterThan(0);
      expect(f.demWinProbMcSe).toBeLessThan(0.01);
    }
  });

  it("house races carry more idiosyncratic uncertainty than statewide races", () => {
    const senate: SimRace[] = [{ race: race("s"), blended: { margin: 2, sd: 2, pollWeight: 0.5 }, nPolls: 3 }];
    const house: SimRace[] = [{ race: race("h", { type: "house" }), blended: { margin: 2, sd: 2, pollWeight: 0.5 }, nPolls: 3 }];
    const sSd = simulate(senate, 94, 20000, "x").forecasts[0]!.demMarginSd;
    const hSd = simulate(house, 94, 20000, "x").forecasts[0]!.demMarginSd;
    expect(hSd).toBeGreaterThan(sSd + 1);
  });

  it("rolls up to chamber control", () => {
    const result = simulate(simRaces, 94, 5000, "seed-4");
    const chamber = chamberSummary(simRaces, result, (r) => r.type === "senate", 48, 51);
    expect(chamber.demControlProb).toBeGreaterThan(0);
    expect(chamber.demControlProb).toBeLessThan(1);
    expect(chamber.meanSeats).toBeGreaterThan(48);
    expect(chamber.meanSeats).toBeLessThan(52);
  });
});
