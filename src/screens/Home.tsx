// Home / Dashboard (DESIGN.md §3, §5, §6 M3): overall mastery ring, streak, due-today
// count, one mastery ring per repertoire, and a mastery-history chart. The M1 backup
// export/import section stays here — it's still the one place that touches the
// whole on-device DB.

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import type { CatalogEntry, MasterySnapshot, OpeningTree, SrsCard } from "../types";
import { exportUserData, getTree, importUserData, listTrainingSet } from "../lib/content";
import {
  bandColor,
  dueCards,
  masteryBand,
  subtreeMastery,
  weakestPracticedBranches,
  type WeakBranchRow,
} from "../lib/srs";
import { currentStreak, getSnapshots, loadCards, recordDailySnapshot } from "../lib/srsStore";
import { getLichessToken, setLichessToken } from "../lib/settings";
import ProgressRing from "../components/ProgressRing";
import MasteryBar from "../components/MasteryBar";
import "./screens.css";

interface OpeningRow {
  entry: CatalogEntry;
  mastery: number;
  due: number;
}

/** A weakest-lines row (DESIGN §6 M5) with the opening name resolved for display. */
interface WeakLineRow extends WeakBranchRow {
  openingName: string;
}

interface DashboardData {
  rows: OpeningRow[];
  overallMastery: number;
  totalDue: number;
  streak: number;
  history: { date: string; mastery: number }[];
  weakLines: WeakLineRow[];
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
    return {
      rows: [],
      overallMastery: 0,
      totalDue: 0,
      streak: await currentStreak(now),
      history: [],
      weakLines: [],
    };
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

  // Weakest lines (DESIGN §6 M5): computed once here, off the same trees/cards
  // already loaded for the rest of the dashboard — no extra IO.
  const nameById = new Map(entries.map((e) => [e.id, e.name]));
  const weakLines: WeakLineRow[] = weakestPracticedBranches(trees, cards, now).map((w) => ({
    ...w,
    openingName: nameById.get(w.openingId) ?? w.openingId,
  }));

  // Daily snapshot: no-ops after the first call of the local day (see srsStore.ts).
  await recordDailySnapshot(entries, trees, cards, now);
  const snapshots = await getSnapshots();

  return { rows, overallMastery, totalDue, streak, history: buildHistory(snapshots), weakLines };
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
        if (!cancelled) {
          setData({ rows: [], overallMastery: 0, totalDue: 0, streak: 0, history: [], weakLines: [] });
        }
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
                  <li key={entry.id} className="home-opening-row-wrap">
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
                    {entry.mistakeCount > 0 && (
                      <Link
                        to="/practice"
                        state={{ openingIds: [entry.id], mix: "mistakes" }}
                        className="home-drill-traps-btn"
                      >
                        Drill traps
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="home-section">
            <h2>Mastery history</h2>
            <MasteryHistoryChart history={data.history} />
          </section>

          <section className="home-section">
            <h2>Weakest lines</h2>
            {data.weakLines.length === 0 ? (
              <p className="text-dim">
                Nothing to show yet — practice a few lines and the branches you're weakest
                on will show up here.
              </p>
            ) : (
              <ul className="weak-lines-list">
                {data.weakLines.map((row) => (
                  <li key={`${row.openingId}:${row.branchNodeId}`}>
                    <Link to={`/opening/${row.openingId}`} className="weak-line-link">
                      <div className="weak-line-main">
                        <span className="weak-line-opening">{row.openingName}</span>
                        <span className="text-dim weak-line-san">{row.sanLabel} line</span>
                      </div>
                      <MasteryBar value={row.mastery} color={bandColor(masteryBand(row.mastery))} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <SettingsSection />

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

/** Lichess API token (DESIGN §4.4/§6 M5): the app is public on GitHub Pages, so no
 *  token can ship in the bundle — this is a per-device value the user pastes in once,
 *  read by src/screens/Explorer.tsx to gate its live club-games lookup. Persisted via
 *  src/lib/settings.ts (db.meta), never sent anywhere from this screen. */
function SettingsSection() {
  const [token, setToken] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLichessToken().then((t) => {
      if (!cancelled) {
        setToken(t ?? "");
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    await setLichessToken(token);
    setStatus(token.trim() ? "Saved." : "Cleared.");
    window.setTimeout(() => setStatus(null), 2000);
  }

  return (
    <section className="home-section">
      <h2>Settings</h2>
      <div className="settings-field">
        <label className="settings-label" htmlFor="lichess-token-input">
          Lichess API token (optional)
        </label>
        <input
          id="lichess-token-input"
          type="password"
          autoComplete="off"
          value={token}
          disabled={!loaded}
          placeholder="Paste a personal access token"
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="settings-row">
          <button type="button" onClick={handleSave} disabled={!loaded}>
            Save
          </button>
          <a
            href="https://lichess.org/account/oauth/token"
            target="_blank"
            rel="noreferrer"
            className="edit-link"
          >
            Get one at lichess.org/account/oauth/token
          </a>
        </div>
        <p className="text-dim">
          Stored only on this device. Enables live club-games lookups in Explorer.
        </p>
        {status && <p className="text-dim">{status}</p>}
      </div>
    </section>
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
