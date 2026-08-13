// Catalog browser: search + filter all shipped openings, toggle into the training
// set, tap through to the board (DESIGN.md §3, §6 M1 scope).

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Catalog, CatalogEntry, Color } from "../types";
import { isInTrainingSet, loadCatalog, toggleTrainingSet } from "../lib/content";
import "./screens.css";

const ECO_LETTERS = ["A", "B", "C", "D", "E"] as const;
const PAGE_SIZE = 100;

export default function CatalogScreen() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [ecoFilter, setEcoFilter] = useState<string | null>(null);
  const [perspectiveFilter, setPerspectiveFilter] = useState<Color | null>(null);
  const [onlyTrainingSet, setOnlyTrainingSet] = useState(false);
  const [trainingIds, setTrainingIds] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then(async (c) => {
        if (cancelled) return;
        setCatalog(c);
        const flags = await Promise.all(c.entries.map((e) => isInTrainingSet(e.id)));
        if (cancelled) return;
        setTrainingIds(new Set(c.entries.filter((_, i) => flags[i]).map((e) => e.id)));
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    return catalog.entries.filter((e) => {
      if (q && !e.name.toLowerCase().includes(q) && !e.eco.toLowerCase().includes(q)) return false;
      if (ecoFilter && !e.eco.startsWith(ecoFilter)) return false;
      if (perspectiveFilter && e.perspective !== perspectiveFilter) return false;
      if (onlyTrainingSet && !trainingIds.has(e.id)) return false;
      return true;
    });
  }, [catalog, query, ecoFilter, perspectiveFilter, onlyTrainingSet, trainingIds]);

  const visible = filtered.slice(0, visibleCount);

  async function handleToggle(id: string) {
    const nowIn = await toggleTrainingSet(id);
    setTrainingIds((prev) => {
      const next = new Set(prev);
      if (nowIn) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function resetPaging() {
    setVisibleCount(PAGE_SIZE);
  }

  if (loadFailed) {
    return (
      <div className="screen-padding">
        <h1>Openings</h1>
        <div className="empty-state">
          <p>No opening content found.</p>
          <p className="text-dim">
            The content pipeline hasn't been run yet, so <code>content/catalog.json</code>{" "}
            doesn't exist. Run the build-time content pipeline to generate the opening catalog,
            then reload.
          </p>
        </div>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="screen-padding">
        <p className="text-dim">Loading catalog…</p>
      </div>
    );
  }

  return (
    <div className="screen-padding catalog-screen">
      <h1>Openings</h1>
      <input
        type="search"
        placeholder="Search by name or ECO…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          resetPaging();
        }}
        className="catalog-search"
      />

      <div className="chip-row">
        {ECO_LETTERS.map((letter) => (
          <button
            key={letter}
            type="button"
            className={`chip ${ecoFilter === letter ? "chip-active" : ""}`}
            onClick={() => {
              setEcoFilter((prev) => (prev === letter ? null : letter));
              resetPaging();
            }}
          >
            {letter}
          </button>
        ))}
      </div>

      <div className="chip-row">
        {(["white", "black"] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={`chip ${perspectiveFilter === p ? "chip-active" : ""}`}
            onClick={() => {
              setPerspectiveFilter((prev) => (prev === p ? null : p));
              resetPaging();
            }}
          >
            {p === "white" ? "White" : "Black"}
          </button>
        ))}
        <button
          type="button"
          className={`chip ${onlyTrainingSet ? "chip-active" : ""}`}
          onClick={() => {
            setOnlyTrainingSet((v) => !v);
            resetPaging();
          }}
        >
          In my set
        </button>
      </div>

      {filtered.length === 0 && <p className="text-dim">No openings match your filters.</p>}

      <ul className="catalog-list">
        {visible.map((entry) => (
          <CatalogRow
            key={entry.id}
            entry={entry}
            inTrainingSet={trainingIds.has(entry.id)}
            onToggle={() => handleToggle(entry.id)}
          />
        ))}
      </ul>

      {visibleCount < filtered.length && (
        <button
          type="button"
          className="show-more"
          onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
        >
          Show more ({filtered.length - visibleCount} remaining)
        </button>
      )}
    </div>
  );
}

function CatalogRow({
  entry,
  inTrainingSet,
  onToggle,
}: {
  entry: CatalogEntry;
  inTrainingSet: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="catalog-row">
      <Link to={`/opening/${entry.id}`} className="catalog-row-link">
        <div className="catalog-row-main">
          <span className="catalog-row-name">{entry.name}</span>
          <span className={`badge badge-${entry.perspective}`}>
            {entry.perspective === "white" ? "White" : "Black"}
          </span>
          {entry.mistakeCount > 0 && (
            <span className="badge badge-amber">{entry.mistakeCount} traps</span>
          )}
        </div>
        <div className="catalog-row-sub">
          {entry.eco} · {entry.line}
        </div>
      </Link>
      <button
        type="button"
        className={`training-toggle ${inTrainingSet ? "training-toggle-active" : ""}`}
        onClick={onToggle}
        aria-label={inTrainingSet ? "Remove from my openings" : "Add to my openings"}
      >
        {inTrainingSet ? "✓" : "+"}
      </button>
    </li>
  );
}
