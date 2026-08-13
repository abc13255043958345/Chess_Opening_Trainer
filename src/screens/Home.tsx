// M1 Home: "My openings" (training set) + backup export/import. The real dashboard
// (mastery rings, streaks, due count) is M3 (DESIGN.md §3, §6).

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import type { CatalogEntry } from "../types";
import { exportUserData, importUserData, listTrainingSet } from "../lib/content";
import "./screens.css";

export default function Home() {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listTrainingSet()
      .then(setEntries)
      .catch(() => setEntries([]));
  }, []);

  async function refreshTrainingSet() {
    try {
      setEntries(await listTrainingSet());
    } catch {
      // Leave the previous list showing rather than blanking it on a transient error.
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
      await refreshTrainingSet();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Import failed.");
    }
  }

  return (
    <div className="screen-padding home-screen">
      <h1>Chess Opening Trainer</h1>

      <section className="home-section">
        <h2>My openings{entries ? ` (${entries.length})` : ""}</h2>
        {entries === null && <p className="text-dim">Loading…</p>}
        {entries !== null && entries.length === 0 && (
          <p className="text-dim">
            Nothing in your training set yet. Browse the <Link to="/catalog">catalog</Link> and
            add openings.
          </p>
        )}
        {entries !== null && entries.length > 0 && (
          <ul className="home-opening-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <Link to={`/opening/${entry.id}`} className="home-opening-row">
                  <span className="home-opening-name">{entry.name}</span>
                  <span className="text-dim">
                    {entry.eco} · {entry.line}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

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
