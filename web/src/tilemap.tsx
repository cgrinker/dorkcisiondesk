import type { ReactNode } from "react";
import type { RaceRow } from "./api";
import { useTooltip } from "./charts";
import { fmtLeaderProb, fmtMargin, matchup, raceLabel } from "./format";

/** Standard state tile-grid positions (col, row) — every state equal weight. */
const GRID: Record<string, [number, number]> = {
  AK: [0, 0], ME: [10, 0],
  VT: [9, 1], NH: [10, 1],
  WA: [0, 2], ID: [1, 2], MT: [2, 2], ND: [3, 2], MN: [4, 2], IL: [5, 2], WI: [6, 2], MI: [7, 2], NY: [8, 2], RI: [9, 2], MA: [10, 2],
  OR: [0, 3], NV: [1, 3], WY: [2, 3], SD: [3, 3], IA: [4, 3], IN: [5, 3], OH: [6, 3], PA: [7, 3], NJ: [8, 3], CT: [9, 3],
  CA: [0, 4], UT: [1, 4], CO: [2, 4], NE: [3, 4], MO: [4, 4], KY: [5, 4], WV: [6, 4], VA: [7, 4], MD: [8, 4], DE: [9, 4],
  AZ: [1, 5], NM: [2, 5], KS: [3, 5], AR: [4, 5], TN: [5, 5], NC: [6, 5], SC: [7, 5],
  OK: [3, 6], LA: [4, 6], MS: [5, 6], AL: [6, 6], GA: [7, 6],
  HI: [0, 7], TX: [3, 7], FL: [8, 7],
};

/** Diverging classed scale: two hues + neutral midpoint; abbr labels and
 *  tooltips keep identity/values off color alone. Fills are mid-lightness
 *  and hold on both surfaces; the tossup neutral is mode-aware via CSS. */
type RatingClass = { label: string; fill: string; ink: string };
const CLASSES: RatingClass[] = [
  { label: "Safe D", fill: "#1c5cab", ink: "#ffffff" },
  { label: "Likely D", fill: "#2a78d6", ink: "#ffffff" },
  { label: "Lean D", fill: "#86b6ef", ink: "#0b0b0b" },
  { label: "Tossup", fill: "var(--map-tossup)", ink: "var(--ink)" },
  { label: "Lean R", fill: "#ef958e", ink: "#0b0b0b" },
  { label: "Likely R", fill: "#e34948", ink: "#ffffff" },
  { label: "Safe R", fill: "#a83232", ink: "#ffffff" },
];

function classify(pDem: number): RatingClass {
  if (pDem >= 0.95) return CLASSES[0]!;
  if (pDem >= 0.8) return CLASSES[1]!;
  if (pDem >= 0.65) return CLASSES[2]!;
  if (pDem > 0.35) return CLASSES[3]!;
  if (pDem > 0.2) return CLASSES[4]!;
  if (pDem > 0.05) return CLASSES[5]!;
  return CLASSES[6]!;
}

function raceTip(r: RaceRow): ReactNode {
  return (
    <>
      <strong>{raceLabel(r)}</strong>
      <br />
      {matchup(r)}
      <br />
      <span className="t-label">win prob </span>
      {fmtLeaderProb(r.dem_win_prob)}
      <span className="t-label"> · margin </span>
      {fmtMargin(r.dem_margin_mean)}
      <span className="t-label"> [{r.dem_margin_p10}, {r.dem_margin_p90}]</span>
      <br />
      <span className="t-label">
        {r.n_polls} polls · poll weight {(100 * r.poll_weight).toFixed(0)}%
      </span>
    </>
  );
}

const CELL = 62;
const GAP = 5;
const COLS = 11;
const ROWS = 8;
const W = COLS * (CELL + GAP);
const H = ROWS * (CELL + GAP);

/** One tile per state, colored by that state's race. */
export function StateTileMap({ races }: { races: RaceRow[] }) {
  const tt = useTooltip();
  const byState = new Map<string, RaceRow>();
  for (const r of races) byState.set(r.state, r);

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="State race map">
        {Object.entries(GRID).map(([state, [col, row]]) => {
          const race = byState.get(state);
          const x = col * (CELL + GAP);
          const y = row * (CELL + GAP);
          if (!race) {
            return (
              <g key={state}>
                <rect x={x} y={y} width={CELL} height={CELL} rx={6} fill="none" stroke="var(--grid)" strokeWidth={1} />
                <text x={x + CELL / 2} y={y + CELL / 2 + 4} textAnchor="middle" fontSize={13} fill="var(--grid)">
                  {state}
                </text>
              </g>
            );
          }
          const cls = classify(race.dem_win_prob);
          return (
            <g
              key={state}
              onMouseMove={(e) => tt.show(e, raceTip(race))}
              onMouseLeave={tt.hide}
              style={{ cursor: "default" }}
            >
              <rect x={x} y={y} width={CELL} height={CELL} rx={6} fill={cls.fill} />
              <text x={x + CELL / 2} y={y + CELL / 2 - 2} textAnchor="middle" fontSize={14} fontWeight={600} fill={cls.ink}>
                {state}
              </text>
              <text x={x + CELL / 2} y={y + CELL / 2 + 13} textAnchor="middle" fontSize={10} fill={cls.ink} opacity={0.85}>
                {fmtLeaderProb(race.dem_win_prob)}
              </text>
            </g>
          );
        })}
      </svg>
      {tt.node}
    </>
  );
}

/** The round-1 House dodge: districts as small squares clustered at their
 *  state's grid position — seat math without district geometry. */
export function DistrictTileMap({ races }: { races: RaceRow[] }) {
  const tt = useTooltip();
  const byState = new Map<string, RaceRow[]>();
  for (const r of races) {
    const list = byState.get(r.state) ?? [];
    list.push(r);
    byState.set(r.state, list);
  }

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="House district map">
        {Object.entries(GRID).map(([state, [col, row]]) => {
          const districts = (byState.get(state) ?? []).sort((a, b) => (a.district ?? 0) - (b.district ?? 0));
          const x0 = col * (CELL + GAP);
          const y0 = row * (CELL + GAP);
          if (districts.length === 0) {
            return (
              <text key={state} x={x0 + CELL / 2} y={y0 + CELL / 2 + 4} textAnchor="middle" fontSize={12} fill="var(--grid)">
                {state}
              </text>
            );
          }
          const cols = Math.ceil(Math.sqrt(districts.length));
          const rows = Math.ceil(districts.length / cols);
          // Cap the square size so a single at-large seat doesn't dwarf a
          // California district — equal-ish visual weight per seat.
          const size = Math.min(20, (CELL - (cols - 1)) / cols, (CELL - (rows - 1)) / rows);
          return (
            <g key={state}>
              {districts.map((r, i) => {
                const cx = x0 + (i % cols) * (size + 1);
                const cy = y0 + Math.floor(i / cols) * (size + 1);
                return (
                  <rect
                    key={r.race_id}
                    x={cx}
                    y={cy}
                    width={size}
                    height={size}
                    rx={Math.min(2, size / 4)}
                    fill={classify(r.dem_win_prob).fill}
                    onMouseMove={(e) => tt.show(e, raceTip(r))}
                    onMouseLeave={tt.hide}
                  />
                );
              })}
              <text
                x={x0 + CELL / 2}
                y={y0 + rows * (size + 1) + 11}
                textAnchor="middle"
                fontSize={9}
                fill="var(--muted)"
              >
                {state}
              </text>
            </g>
          );
        })}
      </svg>
      {tt.node}
    </>
  );
}

export function MapLegend() {
  return (
    <div className="map-legend">
      {CLASSES.map((c) => (
        <span key={c.label} className="legend-item">
          <span className="swatch" style={{ background: c.fill }} />
          {c.label}
        </span>
      ))}
    </div>
  );
}
