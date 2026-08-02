# Backtesting: how we check the model against history

## The framework in one paragraph

Before trusting the model on 2026, we run it on the past: every Senate and
governor's race from **2006–2022 with at least two polls in the final 35
days** — 411 races across 9 cycles — gets a full election-eve forecast from
the *actual production code* (same averaging, house effects, blending, and
simulation — not a reimplementation), which is then scored against the
certified result. The backtest lives at `test/backtest.test.ts`, runs on
**every CI build**, and fails the build if the model stops passing its
gates — so nobody can quietly make the model worse.

Data: the Silver Bulletin **rawpolls** archive (12,350 polls, 1998–2024,
with actual results attached; committed at `data/rawpolls.xlsx`).

## The four measurements

Each answers a different question, in plain terms:

1. **Calibration — "does 70% mean 70%?"** Group races by predicted win
   probability; within each group, the average prediction must match the
   fraction actually won. Current results: races called ~65% won 73%; ~83%
   won 95%; ~98% won 99%. Gate: each group within 15 points, or within 2.5
   binomial standard deviations for small groups (a 26-race group can miss
   by 20 points on luck alone).

2. **Brier score — overall probability error.** Average of
   (probability − outcome)² across all races, where outcome is 1 or 0.
   Always answering "50%" scores 0.250. **We score 0.069.** Gate: < 0.12.

3. **Interval coverage — "is our stated uncertainty the right size?"** How
   often the actual margin landed inside the predicted 80% interval. Must
   be ≈80% — above means our intervals are too wide (favorites underpriced),
   below means overconfident. **Currently 81.0%.** Gate: 72–90%.

4. **Margin error.** Mean absolute miss of the predicted margin:
   **4.8 points** — the number to compare with published forecasters
   (late-cycle statewide averages historically miss by ~5).

## What the backtest has already changed

This is not a vanity metric — it has teeth. The original model shipped with
a race-noise term derived from raw poll residuals; the backtest showed 80%
intervals covering **89%** of outcomes and mid-range favorites winning more
often than priced. Diagnosis: that term double-counted uncertainty already
carried by the shared national/regional errors. It was re-fit (3 → 1.5
points) until stated intervals matched reality (81.0%). The rule going
forward: **error-model constants are set by the backtest, not by intuition**
— and any PR changing them must show the before/after table.

## What it does and doesn't validate — read this part

Validated:
- the poll-averaging pipeline (weights, house effects, sponsor handling)
- the blend's behavior as poll volume varies
- the size and shape of per-race uncertainty (the dice)

Not validated (known, documented, and open):
- **Cross-race correlation.** The backtest scores each race on its own.
  The shared-national-error assumption drives *chamber control*
  probabilities, and 9 cycles is too few to test seat-total distributions
  statistically. Toplines inherit race-level calibration plus an unverified
  correlation structure.
- **The fundamentals path.** Historical partisan leans aren't in the
  archive, so backtested forecasts are polls-only (a very wide prior).
  Unpolled races — most House districts — lean on coefficients
  (incumbency ±2.5, elasticity 0.8) that are literature values, not fitted.
- **The House noise floor** (±5): district polling is too sparse
  historically to score.
- **Pollster quality weighting**: historical pollster names don't join
  cleanly to today's ratings, so the backtest uses a flat quality — the
  quality feature itself is untested.
- **Honest asterisk on independence**: the error constants were originally
  derived from this same archive's aggregate statistics, and the 1.5
  refit was chosen using this backtest. So this is a goodness-of-fit
  check, not a clean out-of-sample test. **2026 is the out-of-sample test.**

## How to run it

```sh
npm test            # backtest included; prints the calibration table
```

Change a model constant → the printed table and the gates tell you what it
did to history. That's the workflow.

## Future hardening (ordered by value)

1. Cycle-level joint scoring: per year, compare realized total Dem wins
   against the predicted seat distribution (tests correlation, weakly).
2. Historical leans (from MEDSL results) to backtest the fundamentals path
   and fit incumbency/elasticity instead of assuming them.
3. Pollster-name reconciliation to validate quality weighting.
4. Hold-out discipline for future refits: fit on 2006–2016, score on
   2018–2022.
