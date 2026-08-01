import { useEffect, useState } from "react";
import { fetchHistory, fetchRaces, fetchSummary, type HistoryRow, type RaceRow, type Summary } from "./api";
import { MarginCI, SeatHistogram, TrendChart } from "./charts";
import { DistrictTileMap, MapLegend, StateTileMap } from "./tilemap";
import { fmtLeaderProb, fmtMargin, fmtPct, matchup, raceLabel } from "./format";

export default function App() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [tab, setTab] = useState<"senate" | "house" | "governor">("senate");
  const [races, setRaces] = useState<Record<string, RaceRow[]>>({});
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="app">
      <h1>2026 Midterm Forecast</h1>
      <p className="subtitle">
        Updated {summary.generatedAt.slice(0, 16).replace("T", " ")} UTC · {summary.daysToElection} days to
        election{summary.stale && <span className="stale"> · STALE</span>}
      </p>

      <div className="cards">
        <Tile
          label="House control"
          probDem={summary.house.demControlProb}
          sub={`mean ${summary.house.meanSeats.toFixed(0)} D seats [${summary.house.seatsP10}–${summary.house.seatsP90}]`}
        />
        <Tile
          label="Senate control"
          probDem={summary.senate.demControlProb}
          sub={`mean ${summary.senate.meanSeats.toFixed(0)} Dem-caucus seats [${summary.senate.seatsP10}–${summary.senate.seatsP90}]`}
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
          <SeatHistogram chamber={summary.house} threshold={218} title="House seat distribution" />
          <SeatHistogram chamber={summary.senate} threshold={51} title="Senate seat distribution" />
        </div>
      </div>

      <div className="panel">
        <div className="panel-grid">
          <TrendChart history={history} pick={(h) => h.house?.demControlProb} title="House over time" />
          <TrendChart history={history} pick={(h) => h.senate?.demControlProb} title="Senate over time" />
        </div>
      </div>

      <div className="panel">
        <h2>Race map</h2>
        <p className="desc">
          Every race equal weight — tiles are states{tab === "house" ? "; each small square is one district" : ""}.
          Hover for the forecast.
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
              <tr key={r.race_id}>
                <td className="race-name">
                  {raceLabel(r)}
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
        distribution. Data: Silver Bulletin, VoteHub, Wikipedia contributors (CC-BY-SA), Ballotpedia, The
        Downballot, FEC, FRED. <a href="/docs">API docs</a>
      </p>
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
