import { useState, type ReactNode } from "react";
import type { ChamberSummary, HistoryRow } from "./api";

/** Fixed-position tooltip that follows the pointer. */
export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const show = (e: { clientX: number; clientY: number }, body: ReactNode) =>
    setTip({ x: e.clientX + 12, y: e.clientY + 12, body });
  const hide = () => setTip(null);
  const node = tip ? (
    <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.body}
    </div>
  ) : null;
  return { show, hide, node };
}

const fmtPct = (p: number) => `${(100 * p).toFixed(0)}%`;

/**
 * Seat-distribution histogram. Polarity coloring: outcomes at/above the
 * control threshold in Dem blue, below in Rep red (validated diverging pair);
 * 2px surface gaps between bars, rounded data-ends, threshold rule labeled.
 */
export function SeatHistogram({
  chamber,
  threshold,
  title,
}: {
  chamber: ChamberSummary;
  threshold: number;
  title: string;
}) {
  const tt = useTooltip();
  const entries = Object.entries(chamber.seatDistribution)
    .map(([seats, n]) => [Number(seats), n] as const)
    .sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) return null;

  const total = entries.reduce((s, [, n]) => s + n, 0);
  const lo = entries[0]![0];
  const hi = entries[entries.length - 1]![0];
  const maxN = Math.max(...entries.map(([, n]) => n));

  const W = 460;
  const H = 150;
  const padB = 22;
  const padT = 8;
  const barW = Math.max(1, W / (hi - lo + 1) - 2);
  const x = (seats: number) => ((seats - lo) / (hi - lo + 1)) * W;
  const y = (n: number) => padT + (1 - n / maxN) * (H - padT - padB);

  const ticks = niceTicks(lo, hi, 6);

  return (
    <div>
      <h2>{title}</h2>
      <p className="desc">
        Dem seats across simulations - mean {chamber.meanSeats.toFixed(0)}, 80% interval [
        {chamber.seatsP10}, {chamber.seatsP90}]
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label={title}>
        {entries.map(([seats, n]) => (
          <rect
            key={seats}
            x={x(seats)}
            y={y(n)}
            width={barW}
            height={H - padB - y(n)}
            rx={Math.min(2, barW / 2)}
            fill={seats >= threshold ? "var(--dem)" : "var(--rep)"}
            onMouseMove={(e) =>
              tt.show(e, (
                <>
                  <span className="t-label">{seats} Dem seats - </span>
                  {fmtPct(n / total)} of sims
                </>
              ))
            }
            onMouseLeave={tt.hide}
          />
        ))}
        <line x1={0} x2={W} y1={H - padB} y2={H - padB} stroke="var(--baseline)" strokeWidth={1} />
        {ticks.map((t) => (
          <text key={t} x={x(t) + barW / 2} y={H - 8} fontSize={10} fill="var(--muted)" textAnchor="middle">
            {t}
          </text>
        ))}
        <line
          x1={x(threshold)}
          x2={x(threshold)}
          y1={padT}
          y2={H - padB}
          stroke="var(--muted)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <text x={x(threshold) + 4} y={padT + 9} fontSize={10} fill="var(--muted)">
          {threshold} to control
        </text>
      </svg>
      {tt.node}
    </div>
  );
}

/**
 * P(Dem control) over time — one line per chart (small multiples upstream),
 * blue because the metric is a Dem quantity. Crosshair + tooltip.
 */
export function TrendChart({
  history,
  pick,
  title,
}: {
  history: HistoryRow[];
  pick: (h: HistoryRow) => number | undefined;
  title: string;
}) {
  const tt = useTooltip();
  const [hoverI, setHoverI] = useState<number | null>(null);
  const pts = history
    .slice()
    .reverse()
    .map((h) => ({ runId: h.runId, v: pick(h) }))
    .filter((p): p is { runId: string; v: number } => p.v !== undefined);
  if (pts.length < 2) {
    return (
      <div>
        <h2>{title}</h2>
        <p className="desc">Not enough runs yet - check back after a few model cycles.</p>
      </div>
    );
  }

  const W = 460;
  const H = 130;
  const padB = 18;
  const padT = 6;
  const x = (i: number) => (i / (pts.length - 1)) * (W - 8) + 4;
  const y = (v: number) => padT + (1 - v) * (H - padT - padB);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((fx - 4) / (W - 8)) * (pts.length - 1))));
    setHoverI(i);
    const p = pts[i]!;
    tt.show(e, (
      <>
        <span className="t-label">{p.runId.slice(0, 16).replace("T", " ")} - </span>
        P(Dem control) {fmtPct(p.v)}
      </>
    ));
  };

  return (
    <div>
      <h2>{title}</h2>
      <p className="desc">P(Dem control) by model run</p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto" }}
        role="img"
        aria-label={title}
        onMouseMove={onMove}
        onMouseLeave={() => {
          setHoverI(null);
          tt.hide();
        }}
      >
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line x1={0} x2={W} y1={y(g)} y2={y(g)} stroke="var(--grid)" strokeWidth={1} />
            <text x={2} y={y(g) - 3} fontSize={9} fill="var(--muted)">
              {fmtPct(g)}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--dem)" strokeWidth={2} strokeLinejoin="round" />
        {hoverI !== null && (
          <g>
            <line x1={x(hoverI)} x2={x(hoverI)} y1={padT} y2={H - padB} stroke="var(--muted)" strokeWidth={1} />
            <circle cx={x(hoverI)} cy={y(pts[hoverI]!.v)} r={4} fill="var(--dem)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {tt.node}
    </div>
  );
}

/** 80% margin interval as a whisker on a shared ±scale, mean dot, zero rule. */
export function MarginCI({
  p10,
  p90,
  mean,
  scale = 40,
}: {
  p10: number;
  p90: number;
  mean: number;
  scale?: number;
}) {
  const W = 170;
  const H = 18;
  const x = (v: number) => ((Math.max(-scale, Math.min(scale, v)) + scale) / (2 * scale)) * W;
  const color = mean >= 0 ? "var(--dem)" : "var(--rep)";
  return (
    <svg width={W} height={H} aria-label={`80% interval ${p10} to ${p90}`}>
      <line x1={x(0)} x2={x(0)} y1={1} y2={H - 1} stroke="var(--grid)" strokeWidth={1} />
      <line x1={x(p10)} x2={x(p90)} y1={H / 2} y2={H / 2} stroke={color} strokeWidth={2} strokeLinecap="round" opacity={0.55} />
      <circle cx={x(mean)} cy={H / 2} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo;
  const step = Math.max(1, Math.round(span / n / 5) * 5);
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  return ticks;
}
