// The opening browser (M1 core screen + M3 branch heat-map, DESIGN.md §3, §5, §6):
// step through a shipped or customized tree on the board, jump around via the move
// list, see the opponent's prepared replies (including mistake branches) at each
// branch point tinted by that branch's mastery, read the annotation for the current
// position, and — when there's more than one continuation — see a per-branch mastery
// bar with its due count (the "Branches" section).

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Chess } from "chess.js";
import Board from "../components/Board";
import MoveList from "../components/MoveList";
import MasteryBar from "../components/MasteryBar";
import ProgressRing from "../components/ProgressRing";
import { getTree, isInTrainingSet, loadCatalog, toggleTrainingSet } from "../lib/content";
import { isUserTurn, mainlineChild, pathToNode } from "../lib/tree";
import { bandColor, dueCountInSubtree, masteryBand, subtreeMastery } from "../lib/srs";
import { loadCards } from "../lib/srsStore";
import type { CatalogEntry, OpeningTree, RepertoireNode, SrsCard } from "../types";
import "./screens.css";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "no-content" }
  | { status: "ready"; entry: CatalogEntry; tree: OpeningTree };

export default function OpeningView() {
  const { id = "" } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      let catalog;
      try {
        catalog = await loadCatalog();
      } catch {
        if (!cancelled) setState({ status: "no-content" });
        return;
      }
      const entry = catalog.entries.find((e) => e.id === id);
      if (!entry) {
        if (!cancelled) setState({ status: "not-found" });
        return;
      }
      const tree = await getTree(id);
      if (!tree) {
        if (!cancelled) setState({ status: "no-content" });
        return;
      }
      if (!cancelled) setState({ status: "ready", entry, tree });
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.status === "loading") {
    return (
      <div className="screen-padding">
        <p className="text-dim">Loading…</p>
      </div>
    );
  }

  if (state.status === "not-found") {
    return (
      <div className="screen-padding not-found">
        <p>Opening not found.</p>
        <Link to="/catalog">Back to catalog</Link>
      </div>
    );
  }

  if (state.status === "no-content") {
    return (
      <div className="screen-padding not-found">
        <p>This opening's content isn't available.</p>
        <p className="text-dim">
          Either the content pipeline hasn't generated it yet, or it couldn't be loaded (check
          you're online for the first load).
        </p>
        <Link to="/catalog">Back to catalog</Link>
      </div>
    );
  }

  return <OpeningReady entry={state.entry} tree={state.tree} />;
}

function OpeningReady({ entry, tree }: { entry: CatalogEntry; tree: OpeningTree }) {
  const [currentNodeId, setCurrentNodeId] = useState(tree.rootId);
  const [inTrainingSet, setInTrainingSet] = useState(false);
  const [illegalFlash, setIllegalFlash] = useState(false);
  const [cards, setCards] = useState<Map<string, SrsCard>>(new Map());
  // Fixed for the life of this screen instance — mastery display shouldn't visibly
  // "decay" while the user is just looking at it.
  const [now] = useState(() => new Date());

  // Reset to the start whenever a different opening is loaded into this screen.
  useEffect(() => {
    setCurrentNodeId(tree.rootId);
  }, [tree]);

  useEffect(() => {
    let cancelled = false;
    isInTrainingSet(entry.id).then((v) => {
      if (!cancelled) setInTrainingSet(v);
    });
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  useEffect(() => {
    let cancelled = false;
    loadCards([entry.id]).then((c) => {
      if (!cancelled) setCards(c);
    });
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  const openingMastery = useMemo(
    () => subtreeMastery(tree, tree.rootId, cards, now),
    [tree, cards, now]
  );
  const openingBand = masteryBand(openingMastery);

  const currentNode = tree.nodes[currentNodeId] ?? tree.nodes[tree.rootId];

  // Path from root to the current node (inclusive), extended forward along the
  // current node's own mainline continuation so the user sees the whole line.
  const displayPath = useMemo(() => {
    const path = pathToNode(tree, currentNode.id);
    let node = currentNode;
    let next = mainlineChild(tree, node);
    while (next) {
      path.push(next);
      node = next;
      next = mainlineChild(tree, node);
    }
    return path;
  }, [tree, currentNode]);

  const moveNodes = useMemo(() => displayPath.filter((n) => n.san !== ""), [displayPath]);
  const sans = useMemo(() => moveNodes.map((n) => n.san), [moveNodes]);
  const currentPly = useMemo(
    () => pathToNode(tree, currentNode.id).filter((n) => n.san !== "").length,
    [tree, currentNode]
  );

  const lastMove: [string, string] | undefined =
    currentNode.uci.length >= 4
      ? [currentNode.uci.slice(0, 2), currentNode.uci.slice(2, 4)]
      : undefined;

  const inCheck = useMemo(() => {
    try {
      return new Chess(currentNode.fen).inCheck();
    } catch {
      return false;
    }
  }, [currentNode.fen]);

  // Legal-per-book targets only: the viewer is read-only off-book (DESIGN.md §6).
  const dests = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const cid of currentNode.children) {
      const child = tree.nodes[cid];
      if (!child || child.uci.length < 4) continue;
      const orig = child.uci.slice(0, 2);
      const dest = child.uci.slice(2, 4);
      const arr = m.get(orig) ?? [];
      arr.push(dest);
      m.set(orig, arr);
    }
    return m;
  }, [tree, currentNode]);

  const childNodes = useMemo(
    () =>
      currentNode.children
        .map((cid) => tree.nodes[cid])
        .filter((n): n is RepertoireNode => !!n),
    [tree, currentNode]
  );

  // Branch points where the opponent has multiple prepared replies (theory + mistakes).
  const opponentContinuations =
    childNodes.length > 1 && !isUserTurn(tree, currentNode) ? childNodes : [];

  function goToNode(nodeId: string) {
    setCurrentNodeId(nodeId);
  }

  function handleSelectPly(ply: number) {
    const node = moveNodes[ply - 1];
    if (node) goToNode(node.id);
  }

  function handlePrev() {
    if (currentNode.parentId) goToNode(currentNode.parentId);
  }

  const nextMainline = mainlineChild(tree, currentNode);
  function handleNext() {
    if (nextMainline) goToNode(nextMainline.id);
  }

  function handleBoardMove(orig: string, dest: string) {
    const child = childNodes.find(
      (n) => n.uci.slice(0, 2) === orig && n.uci.slice(2, 4) === dest
    );
    if (child) {
      goToNode(child.id);
    } else {
      // Off-book: chessground already restricts dests to book moves, but flash red
      // and re-render (Board re-syncs to the unchanged fen every render) as a
      // defensive snap-back in case this is ever reached.
      setIllegalFlash(true);
      window.setTimeout(() => setIllegalFlash(false), 350);
    }
  }

  async function handleToggleTrainingSet() {
    const nowIn = await toggleTrainingSet(entry.id);
    setInTrainingSet(nowIn);
  }

  const evalText =
    typeof currentNode.endOfTheory?.evalCp === "number"
      ? `${currentNode.endOfTheory.evalCp >= 0 ? "+" : ""}${(
          currentNode.endOfTheory.evalCp / 100
        ).toFixed(1)}`
      : null;

  return (
    <div className="opening-view screen-padding">
      <header className="opening-header">
        <div className="opening-header-top">
          <div>
            <h1>{tree.name}</h1>
            <div className="opening-header-meta">
              <span className="badge">{tree.eco}</span>
              <span className={`badge badge-${tree.perspective}`}>
                {tree.perspective === "white" ? "White" : "Black"}
              </span>
            </div>
            <div className="opening-mastery">
              <ProgressRing value={openingMastery} size={40} color={bandColor(openingBand)} />
              <span className="opening-mastery-band">{openingBand}</span>
            </div>
          </div>
          <div className="opening-header-actions">
            <button
              type="button"
              className={`training-toggle ${inTrainingSet ? "training-toggle-active" : ""}`}
              onClick={handleToggleTrainingSet}
            >
              {inTrainingSet ? "✓ In my set" : "+ Add"}
            </button>
            <Link to={`/edit/${entry.id}`} className="edit-link">
              Edit
            </Link>
          </div>
        </div>
      </header>

      <div className={`board-frame ${illegalFlash ? "board-frame-illegal" : ""}`}>
        <Board
          fen={currentNode.fen}
          orientation={tree.perspective}
          lastMove={lastMove}
          dests={dests}
          onMove={handleBoardMove}
          check={inCheck}
        />
      </div>

      <MoveList sans={sans} currentPly={currentPly} onSelect={handleSelectPly} />

      <div className="nav-row">
        <button type="button" onClick={handlePrev} disabled={!currentNode.parentId}>
          ◀ Prev
        </button>
        <button type="button" onClick={handleNext} disabled={!nextMainline}>
          Next ▶
        </button>
      </div>

      {opponentContinuations.length > 0 && (
        <div className="continuations-row">
          <div className="continuations-label">Opponent's replies</div>
          <div className="chip-row">
            {opponentContinuations.map((child) => {
              const isActive = child.id === currentNodeId;
              const color = bandColor(masteryBand(subtreeMastery(tree, child.id, cards, now)));
              return (
                <button
                  key={child.id}
                  type="button"
                  className={`chip continuation-chip ${isActive ? "chip-active" : ""}`}
                  style={
                    isActive
                      ? { borderColor: color }
                      : { borderColor: color, background: `color-mix(in srgb, ${color} 16%, var(--bg-input))` }
                  }
                  onClick={() => goToNode(child.id)}
                >
                  {child.san}
                  {typeof child.weight === "number" && (
                    <span className="continuation-weight">
                      {Math.round(child.weight * 100)}%
                    </span>
                  )}
                  {child.moveKind === "opponent_mistake" && (
                    <span className="badge badge-amber">?!</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {childNodes.length > 1 && (
        <div className="branches-section">
          <div className="continuations-label">Branches</div>
          <ul className="branches-list">
            {childNodes.map((child) => {
              const mastery = subtreeMastery(tree, child.id, cards, now);
              const due = dueCountInSubtree(tree, child.id, cards, now);
              return (
                <li key={child.id}>
                  <MasteryBar
                    value={mastery}
                    color={bandColor(masteryBand(mastery))}
                    label={child.san}
                    due={due}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="annotation-panel">
        {currentNode.moveKind === "opponent_mistake" && (
          <div className="annotation-kind-badge">Club mistake — punish it</div>
        )}
        {currentNode.annotation?.explanation && (
          <p className="annotation-explanation">{currentNode.annotation.explanation}</p>
        )}
        {currentNode.annotation?.plans && (
          <p className="annotation-plans text-dim">{currentNode.annotation.plans}</p>
        )}
        {currentNode.endOfTheory && (
          <div className="end-of-theory-banner">
            Theory ends:{" "}
            {currentNode.endOfTheory.reason === "winning"
              ? "clearly winning"
              : "play chess from here"}
            {evalText ? `, ${evalText}` : ""}
          </div>
        )}
        {!currentNode.annotation && !currentNode.endOfTheory && (
          <p className="text-dim">No notes on this position yet.</p>
        )}
      </div>
    </div>
  );
}
