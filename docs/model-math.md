# The model, in plain math

**The rule this project holds itself to: every part of the model must be
explainable with arithmetic, weighted averages, and dice.** No matrices, no
regression black boxes. If a proposed feature can't be written on this page
in that language, it doesn't ship. (This is also the review bar for PRs that
touch `src/model/`.)

Everything below is the complete model — there is no hidden math elsewhere.

---

## Step 1 — Average the polls (a weighted average)

Every poll gets turned into a single number: the Democrat's lead in points
(negative = Republican lead). Before averaging, each poll is adjusted:

- **House effect**: if a pollster consistently shows Democrats 2 points
  better than everyone else polling the same races, subtract 2 from its
  polls. We measure this by comparing each pollster to the average of all
  other pollsters, and we only trust it gradually (a pollster with 2 polls
  gets a small correction; one with 20 gets nearly the full measured amount).
- **Partisan sponsor**: a poll paid for by a campaign or party is shifted
  1.5 points against its sponsor, and only counts half as much.
- **Who was surveyed**: polls of registered voters get shifted 1 point
  toward Republicans (historically they run about that much bluer than
  likely-voter polls); polls of all adults, 1.5.

Then it's a weighted average. Each poll's weight is three numbers multiplied:

```
weight = recency × size × quality

recency  = 0.5 ^ (days old ÷ half-life)     "a poll loses half its weight
                                             every half-life" — 10 days near
                                             the election, up to 35 far out
           ...with one rule: a poll only loses weight to FRESHER POLLS, not
           to the calendar. In a sparsely-polled race the newest poll never
           drops below half strength (older ones rescale with it, so fresher
           still beats staler). Otherwise a once-a-month state's polls decay
           to nothing and the fundamentals guess silently takes over.
           Backtested: this rule improved historical accuracy (Brier
           0.069 → 0.061, margin error 4.8 → 4.4 pts).
size     = √(sample ÷ 600), capped at 5000  "a 2,400-person poll counts
                                             double a 600-person poll, not
                                             quadruple" (square root!)
quality  = 0.05 to 1.0                       from Silver Bulletin's public
                                             pollster grades; unknown
                                             pollsters get 0.5
```

`average = sum of (weight × adjusted lead) ÷ sum of weights` — that's it.

## Step 2 — The fundamentals guess (addition)

What we'd predict with zero polls. Four terms added together:

```
guess = state lean                    how the state voted for president in
                                      2024 relative to the country
      + 0.8 × generic ballot          the national mood: if the country
                                      says D+5, a typical race moves +4
      + 2.5 if incumbent running      (minus 2.5 for a Republican incumbent)
      + money term, capped at ±4      each doubling of the fundraising
                                      ratio between the candidates is
                                      worth about 1 point
```

## Step 3 — Mix the two (a confidence-weighted average)

The forecast margin is a weighted average of the poll average and the
fundamentals guess. Each side's weight is its **confidence**, defined as
`1 ÷ (typical miss)²` — an estimate that typically misses by half as much
counts four times as much:

- The fundamentals guess typically misses by 7–10 points → low confidence,
  always.
- The poll average's typical miss shrinks as poll weight accumulates: one
  fresh quality poll ≈ ±5 points; ten of them ≈ ±1.6.

So an unpolled House district is nearly all fundamentals; Michigan with 30
polls is nearly all polls. Every race reports its own split (`poll_weight`
in the API, "% of this forecast comes from polls" on the site).

## Step 4 — Roll dice 10,000 times (the simulation)

The mixed margin is our best guess, but polls miss — and crucially, they
miss **together**. In 2020 nearly every state's polls were too Democratic at
once. So one pretend election works like this:

```
for each of 10,000 pretend elections:
    roll ONE national error        typically ±3 points on election eve —
                                   added to EVERY race in the country
    roll one regional error        typically ±1.5 points, shared by races
                                   in the same region
    for each race:
        roll a race error          that race's own surprise
        result = mixed margin + national + regional + race errors
    count who won each race, add up seats
```

The dice are not plain bell curves — they're drawn with more frequent
extreme rolls, matched to how wrong polls have actually been in every cycle
since 1998 (the 2016 and 2020 misses happen at their real-world frequency).

A race's **win probability** is simply the fraction of the 10,000 pretend
elections it wins. The **80% interval** is the range the middle 8,000
outcomes fall in. Chamber control is the fraction of pretend elections with
≥218 House seats or ≥51 Dem-caucus Senate seats. No formulas — just
counting.

This is also why a 3-point favorite is ~73% and never 99%: a 3-point
national roll happens all the time, and it hits every race at once.

## Worked example: a Michigan-style race

Polls: thirty polls averaging D+0.3 after adjustments, heavily weighted to
recent ones → poll average **D+0.3**, high confidence (typical miss ~1.5).
Fundamentals: lean 0.0, generic ballot D+4.5 × 0.8 = +3.6, open seat +0,
money roughly even → guess **D+3.6**, low confidence (typical miss ~8).

Mix: poll confidence 1/1.5² = 0.44; fundamentals 1/8² = 0.016. The mix is
96% polls: forecast ≈ **D+0.4**.

Simulate: national dice ±5.5 (93 days out), regional ±1.5, race dice ±3ish
→ the Democrat wins about 51% of pretend elections, 80% interval [−7, +8].
A coin flip, honestly labeled.

## Every constant, and where it came from

| Constant | Value | Source |
|---|---|---|
| Recency half-life | 10–35 days | shrinks near the election |
| Sample-size cap | 5,000 | mega-polls aren't 10× better |
| Sponsor shift / penalty | 1.5 pts / half weight | literature-standard |
| RV / adult shift | 1.0 / 1.5 pts | historical RV-vs-LV gap |
| National environment factor | 0.8 | typical race absorbs 80% of the national swing |
| Incumbency | ±2.5 pts | literature-standard, not fitted |
| Money cap | ±4 pts | fundraising signal saturates |
| Fundamentals typical miss | 7–10 pts | wide on purpose |
| National dice, election eve | ±3 pts | measured: every cycle 1998–2024 |
| Regional dice | ±1.5 pts | assumption, not separately validated |
| Race dice floor (statewide) | ±1.5 pts | **backtested** — see [backtesting.md](backtesting.md) |
| Race dice floor (House) | ±5 pts | measured from district polls; not backtested |
| Extra-extreme dice shape | t, df=5 | matches historical extreme misses |

"Literature-standard" and "assumption" mean exactly that: not fitted by us,
and honest candidates for future backtesting.
