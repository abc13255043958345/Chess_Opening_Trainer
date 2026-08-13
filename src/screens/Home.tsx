// Home / Dashboard (DESIGN.md §3, §5, §6 M3): overall mastery ring, streak, due-today
// count, one mastery ring per repertoire, and a mastery-history chart. The M1 backup
// export/import section stays here — it's still the one place that touches the
// whole on-device DB.

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import type { CatalogEntry, MasterySnapshot, OpeningTree, SrsCard } from "../types";
import { exportUserData, getTree, importUserData, listTrainingSet } from "../lib/content";
import { bandColor, dueCards, masteryBand, subtreeMastery } from "../lib/srs";
import { currentStreak, getSnapshots, loadCards, recordDailySnapshot } from "../lib/srsStore";
import ProgressRing from "../components/ProgressRing";
import "./screens.css";

interface OpeningRow {
  entry: CatalogEntry;
  mastery: number;
  due: number;
}

interface DashboardData {
  rows: OpeningRow[];
  overallMastery: number;
  totalDue: number;
  streak: number;
  history: { date: string; mastery: number }[];
}

function buildHistory(snapshots: MasterySnapshot[]): { date: string; mastery: number }[] {
  const byDate = new Map<string, number[]>();
  for (const s of snapshots) {
    const arr = byDate.get(s.date) ?? [];
    arr.push(s.mastery);
    byDate.set(s.date, arr);
  }
  return [...byDate.entries()]
    .map(([date, values]) => ({
      date,
      mastery: values.reduce((a, b) => a + b, 0) / values.length,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-30);
}

async function loadDashboard(): Promise<DashboardData> {
  const entries = await listTrainingSet();
  const now = new Date();

  if (entries.length === 0) {
    return { rows: [], overallMastery: 0, totalDue: 0, streak: await currentStreak(now), history: [] };
  }

  const ids = entries.map((e) => e.id);
  const [treeList, cards, streak] = await Promise.all([
    Promise.all(ids.map((id) => getTree(id))),
    loadCards(ids),
    currentStreak(now),
  ]);

  const trees: Record<string, OpeningTree> = {};
  treeList.forEach((tree, i) => {
    if (tree) trees[ids[i]] = tree;
  });

  const { perOpeningDueCount } = dueCards(cards, ids, now);
  const rows: OpeningRow[] = entries.map((entry) => {
    const tree = trees[entry.id];
    const mastery = tree ? subtreeMastery(tree, tree.rootId, cards, now) : 0;
    return { entry, mastery, due: perOpeningDueCount[entry.id] ?? 0 };
  });

  const overallMastery = rows.reduce((sum, r) => sum + r.mastery, 0) / rows.length;
  const totalDue = rows.reduce((sum, r) => sum + r.due, 0);

  // Daily snapshot: no-ops after the first call of the local day (see srsStore.ts).
  await recordDailySnapshot(entries, trees, cards, now);
  const snapshots = await getSnapshots();

  return { rows, overallMastery, totalDue, streak, history: buildHistory(snapshots) };
}

export default function Home() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadDashboard()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData({ rows: [], overallMastery: 0, totalDue: 0, streak: 0, history: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    try {
      setData(await loadDashboard());
    } catch {
      // Leave the previous state showing rather than blanking it on a transient error.
    }
  }

  async function handleExport() {
    setStatus(null);
    try {
      const blob = await exportUserData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chess-opener-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Export failed.");
    }
  }

  async function handleImportChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setStatus(null);
    try {
      await importUserData(file);
      setStatus("Import complete.");
      await refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Import failed.");
    }
  }

  return (
    <div className="screen-padding home-screen">
      <div className="home-title-row">
        <h1>Chess Opening Trainer</h1>
        <Link to="/practice" className="home-practice-link">
          Practice
        </Link>
      </div>

      {data === null && <p className="text-dim">Loading…</p>}

      {data !== null && data.rows.length === 0 && (
        <div className="empty-state">
          <p>Nothing in your training set yet.</p>
          <p className="text-dim">
            Browse the <Link to="/catalog">catalog</Link> and add openings to start tracking
            mastery.
          </p>
        </div>
      )}

      {data !== null && data.rows.length > 0 && (
        <>
          <section className="home-summary">
            <ProgressRing
              value={data.overallMastery}
              size={84}
              color={bandColor(masteryBand(data.overallMastery))}
              label="overall"
            />
            <div className="home-summary-stats">
              <div className="home-summary-stat">
                <span className="home-summary-stat-value">🔥 {data.streak}</span>
                <span className="text-dim">day streak</span>
              </div>
              <div className="home-summary-stat">
                <span className="home-summary-stat-value">{data.totalDue}</span>
                <span className="text-dim">due today</span>
              </div>
            </div>
          </section>

          <section className="home-section">
            <h2>My openings ({data.rows.length})</h2>
            <ul className="home-opening-list">
              {data.rows.map(({ entry, mastery, due }) => {
                const band = masteryBand(mastery);
                const color = bandColor(band);
                return (
                  <li key={entry.id}>
                    <Link to={`/opening/${entry.id}`} className="home-opening-card">
                      <ProgressRing value={mastery} size={48} color={color} />
                      <div className="home-opening-card-main">
                        <span className="home-opening-name">{entry.name}</span>
                        <div className="home-opening-card-meta">
                          <span className="badge">{entry.eco}</span>
                          <span className={`badge badge-${entry.perspective}`}>
                            {entry.perspective === "white" ? "White" : "Black"}
                          </span>
                          <span className="text-dim home-opening-band">{band}</span>
                        </div>
                      </div>
                      {due > 0 && (
                        <span className="badge badge-accent home-opening-due">{due} due</span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="home-section">
            <h2>Mastery history</h2>
            <MasteryHistoryChart history={data.history} />
          </section>
        </>
      )}

      <section className="home-section">
        <h2>Data</h2>
        <div className="data-actions">
          <button type="button" onClick={handleExport}>
            Export backup
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            Import backup
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={handleImportChange}
          />
        </div>
        {status && <p className="text-dim">{status}</p>}
      </section>
    </div>
  );
}

function MasteryHistoryChart({ history }: { history: { date: string; mastery: number }[] }) {
  if (history.length < 2) {
    return (
      <p className="text-dim">
        Keep practicing — your mastery history will show up here after a couple of days.
      </p>
    );
  }

  const width = 320;
  const height = 90;
  const pad = 6;
  const points = history.map((h, i) => {
    const x = pad + (i / (history.length - 1)) * (width - pad * 2);
    const y = pad + (1 - h.mastery / 100) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const areaPoints = [`${pad},${height - pad}`, ...points, `${width - pad},${height - pad}`].join(
    " "
  );

  return (
    <div className="mastery-history-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <polygon points={areaPoints} className="mastery-history-area" />
        <polyline points={points.join(" ")} className="mastery-history-line" fill="none" />
      </svg>
      <div className="mastery-history-range text-dim">
        <span>{history[0].date}</span>
        <span>{history[history.length - 1].date}</span>
      </div>
    </div>
  );
}
