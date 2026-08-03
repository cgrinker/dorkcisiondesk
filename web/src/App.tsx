import { Fragment, useEffect, useState } from "react";
import {
  fetchHistory, fetchPolls, fetchRaces, fetchSummary,
  type HistoryRow, type PollRow, type RaceRow, type Summary,
} from "./api";
import { MarginCI, SeatHistogram, TrendChart } from "./charts";
import { DistrictTileMap, MapLegend, StateTileMap } from "./tilemap";
import { fmtLeaderProb, fmtMargin, fmtPct, matchup, raceLabel } from "./format";

export default function App() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [tab, setTab] = useState<"senate" | "house" | "governor">("senate");
  const [races, setRaces] = useState<Record<string, RaceRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [polls, setPolls] = useState<Record<string, PollRow[] | "loading">>({});
  const [view, setView] = useState<"measured" | "adjusted">("measured");

  const toggleRace = (raceId: string) => setExpanded((cur) => (cur === raceId ? null : raceId));

  useEffect(() => {
    if (expanded && !polls[expanded]) {
      const raceId = expanded;
      setPolls((p) => ({ ...p, [raceId]: "loading" }));
      fetchPolls(raceId)
        .then((rows) => setPolls((p) => ({ ...p, [raceId]: rows })))
        .catch(() => setPolls((p) => ({ ...p, [raceId]: [] })));
    }
  }, [expanded, polls]);

  useEffect(() => {
    fetchSummary().then(setSummary).catch((e) => setError(String(e)));
    fetchHistory().then(setHistory).catch(() => {});
  }, []);
  useEffect(() => {
    if (!races[tab]) {
      fetchRaces(tab).then((rows) => setRaces((r) => ({ ...r, [tab]: rows }))).catch(() => {});
    }
  }, [tab, races]);

  if (error) return <div className="app">Failed to load forecast: {error}</div>;
  if (!summary) return <div className="app">Loading forecast…</div>;

  const all = races[tab] ?? [];
  const rows = all.filter((r) => r.dem_win_prob > 0.05 && r.dem_win_prob < 0.95).slice(0, 40);
  const active = view === "adjusted" && summary.adjusted ? summary.adjusted : summary;

  return (
    <div className="app">
      <h1>2026 Midterm Forecast</h1>
      <p className="subtitle">
        Updated {summary.generatedAt.slice(0, 16).replace("T", " ")} UTC · {summary.daysToElection} days to
        election{summary.stale && <span className="stale"> · STALE</span>}
      </p>

      {summary.adjusted && (
        <div className="tabs view-toggle">
          <button className={view === "measured" ? "active" : ""} onClick={() => setView("measured")}>
            Measured
          </button>
          <button className={view === "adjusted" ? "active" : ""} onClick={() => setView("adjusted")}>
            + Midterm drift
          </button>
          <span className="view-note">
            {view === "measured"
              ? "what polls and results say today"
              : `same model, environment shifted ${summary.adjusted.outPartyShift > 0 ? "+" : ""}${summary.adjusted.outPartyShift} pts toward the out-party (what midterms historically do) — both views scored in November`}
          </span>
        </div>
      )}

      <div className="cards">
        <Tile
          label="House control"
          probDem={active.house.demControlProb}
          sub={`mean ${active.house.meanSeats.toFixed(0)} D seats [${active.house.seatsP10}–${active.house.seatsP90}]`}
        />
        <Tile
          label="Senate control"
          probDem={active.senate.demControlProb}
          sub={`mean ${active.senate.meanSeats.toFixed(0)} Dem-caucus seats [${active.senate.seatsP10}–${active.senate.seatsP90}]`}
        />
        <div className="card">
          <div className="label">Generic ballot</div>
          <div className="hero">
            {summary.genericBallot !== null ? (
              <span className={summary.genericBallot >= 0 ? "dem" : "rep"}>{fmtMargin(summary.genericBallot)}</span>
            ) : (
              "–"
            )}
          </div>
          <div className="sub">house-effect-adjusted average</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-grid">
          <SeatHistogram chamber={active.house} threshold={218} title="House seat distribution" />
          <SeatHistogram chamber={active.senate} threshold={51} title="Senate seat distribution" />
        </div>
      </div>

      <div className="panel">
        <div className="panel-grid">
          <TrendChart
            history={history}
            pick={(h) => h.house?.demControlProb}
            pickAlt={(h) => h.adjusted?.house?.demControlProb}
            title="House over time"
          />
          <TrendChart
            history={history}
            pick={(h) => h.senate?.demControlProb}
            pickAlt={(h) => h.adjusted?.senate?.demControlProb}
            title="Senate over time"
          />
        </div>
      </div>

      <div className="panel">
        <h2>Race map</h2>
        <p className="desc">
          Every race equal weight — tiles are states{tab === "house" ? "; each small square is one district" : ""}.
          Hover for the forecast. Race-level views show the Measured track.
        </p>
        <div className="tabs">
          {(["senate", "house", "governor"] as const).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "governor" ? "Governors" : t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {tab === "house" ? <DistrictTileMap races={all} /> : <StateTileMap races={all} />}
        <MapLegend />
      </div>

      <div className="panel">
        <h2>Competitive races</h2>
        <p className="desc">Sorted by closeness · margin shown with its 80% interval (whisker) on a ±40 pt scale</p>
        <table className="races">
          <thead>
            <tr>
              <th>Race</th>
              <th>Win prob</th>
              <th>Margin</th>
              <th>80% interval</th>
              <th>Polls</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.race_id}>
                <tr
                  className="clickable"
                  onClick={() => toggleRace(r.race_id)}
                  aria-expanded={expanded === r.race_id}
                >
                  <td className="race-name">
                    <span className="chev">{expanded === r.race_id ? "▾" : "▸"}</span> {raceLabel(r)}
                    <span className="who">{matchup(r)}</span>
                  </td>
                  <td>
                    <span className="prob" style={{ color: r.dem_win_prob >= 0.5 ? "var(--dem)" : "var(--rep)" }}>
                      {fmtLeaderProb(r.dem_win_prob)}
                    </span>
                  </td>
                  <td>{fmtMargin(r.dem_margin_mean)}</td>
                  <td>
                    <MarginCI p10={r.dem_margin_p10} p90={r.dem_margin_p90} mean={r.dem_margin_mean} />
                  </td>
                  <td>{r.n_polls}</td>
                </tr>
                {expanded === r.race_id && (
                  <tr className="poll-detail">
                    <td colSpan={5}>
                      <PollList rows={polls[r.race_id]} pollWeight={r.poll_weight} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: "var(--muted)" }}>
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="footer">
        Correlated Monte Carlo forecast — races are not independent; intervals come from the simulation
        distribution. Backtested on 411 races, 2006–2022. Data: Silver Bulletin, VoteHub, Wikipedia
        contributors (CC-BY-SA), Ballotpedia, The Downballot, FEC, FRED.{" "}
        <a href="/methodology">How this works</a> · <a href="/docs">API docs</a>
      </p>
    </div>
  );
}

function PollList({ rows, pollWeight }: { rows: PollRow[] | "loading" | undefined; pollWeight: number }) {
  if (rows === "loading" || rows === undefined) return <div className="poll-note">Loading polls…</div>;
  if (rows.length === 0) {
    return (
      <div className="poll-note">
        No polls in the model — this forecast is fundamentals-driven (district lean + national environment
        + incumbency).
      </div>
    );
  }
  return (
    <div>
      <div className="poll-note">
        {Math.round(100 * pollWeight)}% of this forecast comes from polls; the rest is fundamentals.
      </div>
      <table className="polls-sub">
        <thead>
          <tr>
            <th>Pollster</th>
            <th>Dates</th>
            <th>Sample</th>
            <th>Dem</th>
            <th>Rep</th>
            <th>Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => {
            const margin = p.dem_pct - p.rep_pct;
            return (
              <tr key={i}>
                <td>
                  {p.source_url ? (
                    <a href={p.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      {p.pollster}
                    </a>
                  ) : (
                    p.pollster
                  )}
                  {p.sponsor_party && <span className="sponsor"> ({p.sponsor_party} sponsor)</span>}
                </td>
                <td>
                  {p.start_date.slice(5)} – {p.end_date.slice(5)}
                </td>
                <td>
                  {p.sample_size ?? "?"} {p.population?.toUpperCase() ?? ""}
                </td>
                <td>{p.dem_pct}%</td>
                <td>{p.rep_pct}%</td>
                <td style={{ color: margin >= 0 ? "var(--dem)" : "var(--rep)", fontWeight: 550 }}>
                  {fmtMargin(margin)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Tile({ label, probDem, sub }: { label: string; probDem: number; sub: string }) {
  const dem = probDem >= 0.5;
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="hero">
        <span className={dem ? "dem" : "rep"}>{fmtPct(dem ? probDem : 1 - probDem)}</span>{" "}
        <span style={{ fontSize: 15, color: "var(--ink-2)" }}>{dem ? "Dem" : "Rep"}</span>
      </div>
      <div className="sub">{sub}</div>
    </div>
  );
}
