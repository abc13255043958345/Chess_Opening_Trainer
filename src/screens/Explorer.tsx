// Explorer / theory calculator (DESIGN.md §4.4, §6 M4): a free analysis board. Every
// legal move is playable (unlike OpeningView, which is read-only off-book); the engine
// is always on (top-3 lines via getEngine().evaluate); a repertoire overlay shows which
// of the current position's moves are already prepared in a training-set tree; and a
// line that isn't yet in any tree can be grafted in via "Add to repertoire".
//
// The "free line" is a single linear sequence from wherever it started (the standard
// start position, or wherever a deep link dropped it) — not a tree. Playing a move from
// a jumped-back point discards whatever used to come after it, same as any other simple
// PGN-style move list.

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Chess } from "chess.js";
import Board from "../components/Board";
import EvalBar from "../components/EvalBar";
import MoveList from "../components/MoveList";
import { getEngine, EngineCancelledError, type EngineEvalResult } from "../lib/engine";
import { getTree, listTrainingSet } from "../lib/content";
import { saveUserTree } from "../lib/userTree";
import { addMove, numberedSan, sideToMove, START_FEN } from "../lib/tree";
import type { CatalogEntry, Mover, MoveKind, OpeningTree } from "../types";
import "./screens.css";
import "../components/evalbar.css";
import "./explorer.css";

interface FreeMove {
  san: string;
  uci: string;
}

/** First 4 FEN fields (board, side to move, castling, en passant) — ignores the
 *  halfmove/fullmove counters so transpositions with a different move-clock still
 *  match (DESIGN §4.4's repertoire overlay). */
function positionKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

interface RepChip {
  san: string;
  moveKind: MoveKind;
}

function buildRepertoireIndex(trees: OpeningTree[]): Map<string, RepChip[]> {
  const index = new Map<string, RepChip[]>();
  for (const tree of trees) {
    for (const node of Object.values(tree.nodes)) {
      const key = positionKey(node.fen);
      for (const cid of node.children) {
        const child = tree.nodes[cid];
        if (!child) continue;
        const arr = index.get(key) ?? [];
        if (!arr.some((c) => c.san === child.san && c.moveKind === child.moveKind)) {
          arr.push({ san: child.san, moveKind: child.moveKind });
        }
        index.set(key, arr);
      }
    }
  }
  return index;
}

/** Is `ucis` (from the tree's root) already fully present in `tree`? */
function lineFullyInTree(tree: OpeningTree, ucis: string[]): boolean {
  let node = tree.nodes[tree.rootId];
  for (const uci of ucis) {
    const child = node.children.map((id) => tree.nodes[id]).find((c) => c?.uci === uci);
    if (!child) return false;
    node = child;
  }
  return true;
}

/** Replays `ucis`/`sans` into `tree` from its root, appending only nodes that don't
 *  already exist (addMove is itself idempotent on a matching uci) — same
 *  mover/moveKind rules as src/screens/Editor.tsx's playMove. Mutates `tree` in place;
 *  callers own cloning. Returns how many new nodes were actually created. */
function graftLineIntoTree(tree: OpeningTree, ucis: string[], sans: string[]): number {
  let added = 0;
  let parentId = tree.rootId;
  for (let i = 0; i < ucis.length; i++) {
    const uci = ucis[i];
    const san = sans[i];
    const parent = tree.nodes[parentId];
    if (!parent) break;
    const existing = parent.children.map((cid) => tree.nodes[cid]).find((c) => c?.uci === uci);
    if (existing) {
      parentId = existing.id;
      continue;
    }
    let chess: Chess;
    try {
      chess = new Chess(parent.fen);
    } catch {
      break;
    }
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    let mv;
    try {
      mv = chess.move({ from, to, promotion });
    } catch {
      mv = null;
    }
    if (!mv) break;
    const mover: Mover = sideToMove(parent.fen) === tree.perspective ? "user" : "opponent";
    let moveKind: MoveKind = "mainline";
    if (mover === "user" && parent.children.some((cid) => tree.nodes[cid]?.moveKind === "mainline")) {
      moveKind = "sideline";
    }
    const created = addMove(tree, parentId, { san: mv.san, uci, fen: mv.after, moveKind });
    added++;
    parentId = created.id;
  }
  return added;
}

function allLegalDests(fen: string): Map<string, string[]> {
  const dests = new Map<string, string[]>();
  try {
    const chess = new Chess(fen);
    for (const mv of chess.moves({ verbose: true })) {
      const arr = dests.get(mv.from) ?? [];
      if (!arr.includes(mv.to)) arr.push(mv.to);
      dests.set(mv.from, arr);
    }
  } catch {
    // malformed fen — no legal moves offered
  }
  return dests;
}

export default function Explorer() {
  const location = useLocation();

  const [originFen, setOriginFen] = useState(START_FEN);
  const [nonStartOrigin, setNonStartOrigin] = useState(false);
  const [positions, setPositions] = useState<string[]>([START_FEN]);
  const [moves, setMoves] = useState<FreeMove[]>([]);
  const [ply, setPly] = useState(0);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [illegalFlash, setIllegalFlash] = useState(false);

  // ---------- Deep-link init (location.state, then ?moves= query fallback) ----------
  useEffect(() => {
    const state = (location.state ?? null) as { fen?: string; moves?: string[] } | null;
    let ucis: string[] | null = null;
    let fen: string | null = null;

    if (state?.moves && state.moves.length > 0) {
      ucis = state.moves;
    } else if (state?.fen) {
      fen = state.fen;
    } else {
      const params = new URLSearchParams(location.search);
      const movesParam = params.get("moves");
      if (movesParam) ucis = movesParam.split(",").filter(Boolean);
    }

    if (ucis && ucis.length > 0) {
      const chess = new Chess();
      const posArr = [chess.fen()];
      const moveArr: FreeMove[] = [];
      for (const uci of ucis) {
        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);
        const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
        let mv;
        try {
          mv = chess.move({ from, to, promotion });
        } catch {
          mv = null;
        }
        if (!mv) break;
        posArr.push(chess.fen());
        moveArr.push({ san: mv.san, uci });
      }
      setOriginFen(START_FEN);
      setNonStartOrigin(false);
      setPositions(posArr);
      setMoves(moveArr);
      setPly(posArr.length - 1);
    } else if (fen) {
      setOriginFen(fen);
      setNonStartOrigin(fen !== START_FEN);
      setPositions([fen]);
      setMoves([]);
      setPly(0);
    }
    // Deep link is only applied once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentFen = positions[ply];
  const sans = useMemo(() => moves.map((m) => m.san), [moves]);

  const lastMove: [string, string] | undefined =
    ply > 0 && moves[ply - 1] ? [moves[ply - 1].uci.slice(0, 2), moves[ply - 1].uci.slice(2, 4)] : undefined;

  const inCheck = useMemo(() => {
    try {
      return new Chess(currentFen).inCheck();
    } catch {
      return false;
    }
  }, [currentFen]);

  const dests = useMemo(() => allLegalDests(currentFen), [currentFen]);

  function goToPly(p: number) {
    setPly(Math.max(0, Math.min(moves.length, p)));
  }

  function handlePrev() {
    goToPly(ply - 1);
  }
  function handleNext() {
    goToPly(ply + 1);
  }
  function handleReset() {
    setPositions([originFen]);
    setMoves([]);
    setPly(0);
  }
  function handleFlip() {
    setOrientation((o) => (o === "white" ? "black" : "white"));
  }

  function handleBoardMove(orig: string, dest: string) {
    let chess: Chess;
    try {
      chess = new Chess(currentFen);
    } catch {
      return;
    }
    const candidates = chess.moves({ verbose: true }).filter((m) => m.from === orig && m.to === dest);
    if (candidates.length === 0) {
      setIllegalFlash(true);
      window.setTimeout(() => setIllegalFlash(false), 300);
      return;
    }
    const mv = candidates.find((m) => m.promotion === "q") ?? candidates[0];
    const newPositions = [...positions.slice(0, ply + 1), mv.after];
    const newMoves = [...moves.slice(0, ply), { san: mv.san, uci: `${mv.from}${mv.to}${mv.promotion ?? ""}` }];
    setPositions(newPositions);
    setMoves(newMoves);
    setPly(newPositions.length - 1);
  }

  // ---------- Engine, always on ----------
  const [evalResult, setEvalResult] = useState<EngineEvalResult | null>(null);
  const [thinking, setThinking] = useState(false);

  useEffect(() => {
    const fen = currentFen;
    const controller = new AbortController();
    setThinking(true);
    getEngine()
      .evaluate(fen, { multiPv: 3, depth: 12, signal: controller.signal })
      .then((res) => {
        setEvalResult(res);
        setThinking(false);
      })
      .catch((err) => {
        if (err instanceof EngineCancelledError) return;
        setThinking(false);
      });
    return () => controller.abort();
  }, [currentFen]);

  // ---------- Repertoire overlay (fen -> tree index, built once per mount) ----------
  const [trainingEntries, setTrainingEntries] = useState<CatalogEntry[]>([]);
  const [trainingTrees, setTrainingTrees] = useState<OpeningTree[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await listTrainingSet();
      const loaded = await Promise.all(entries.map((e) => getTree(e.id)));
      const trees = loaded.filter((t): t is OpeningTree => !!t);
      if (!cancelled) {
        setTrainingEntries(entries);
        setTrainingTrees(trees);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const repIndex = useMemo(
    () => buildRepertoireIndex(trainingTrees ?? []),
    [trainingTrees]
  );
  const repChips = repIndex.get(positionKey(currentFen)) ?? [];

  // ---------- Add to repertoire ----------
  const pathUcis = useMemo(() => moves.slice(0, ply).map((m) => m.uci), [moves, ply]);
  const pathSans = useMemo(() => moves.slice(0, ply).map((m) => m.san), [moves, ply]);

  const alreadyFullyBooked =
    trainingTrees != null && trainingTrees.some((t) => lineFullyInTree(t, pathUcis));
  const canAdd = !nonStartOrigin && ply > 0 && trainingEntries.length > 0 && !alreadyFullyBooked;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function handleAddTo(entry: CatalogEntry) {
    setPickerOpen(false);
    const shipped = await getTree(entry.id);
    if (!shipped) return;
    const tree = structuredClone(shipped);
    const added = graftLineIntoTree(tree, pathUcis, pathSans);
    await saveUserTree(tree);
    setTrainingTrees((prev) => (prev ? prev.map((t) => (t.id === tree.id ? tree : t)) : prev));
    setToast(
      added > 0
        ? `Added ${added} move${added === 1 ? "" : "s"} to ${entry.name}.`
        : `That line is already in ${entry.name}.`
    );
    window.setTimeout(() => setToast(null), 3000);
  }

  return (
    <div className="explorer-screen screen-padding">
      <header className="explorer-header">
        <h1>Explorer</h1>
        <p className="text-dim">Free analysis board — engine always on.</p>
      </header>

      <div className={`board-eval-row ${illegalFlash ? "board-frame-illegal" : ""}`}>
        <EvalBar evalCp={evalResult?.cp ?? null} mateIn={evalResult?.mateIn ?? null} />
        <div className="board-frame">
          <Board
            fen={currentFen}
            orientation={orientation}
            lastMove={lastMove}
            dests={dests}
            onMove={handleBoardMove}
            check={inCheck}
          />
        </div>
      </div>

      <MoveList sans={sans} currentPly={ply} onSelect={goToPly} />

      <div className="nav-row">
        <button type="button" onClick={handlePrev} disabled={ply <= 0}>
          ◀ Prev
        </button>
        <button type="button" onClick={handleNext} disabled={ply >= moves.length}>
          Next ▶
        </button>
      </div>

      <div className="explorer-controls-row">
        <button type="button" onClick={handleReset}>
          Reset
        </button>
        <button type="button" onClick={handleFlip}>
          Flip board
        </button>
      </div>

      {repChips.length > 0 && (
        <div className="continuations-row">
          <div className="continuations-label">In your repertoire</div>
          <div className="chip-row">
            {repChips.map((chip, i) => (
              <span key={`${chip.san}-${i}`} className="chip explorer-rep-chip">
                {chip.san}
                {chip.moveKind === "opponent_mistake" && <span className="badge badge-amber">?!</span>}
                {chip.moveKind === "sideline" && <span className="badge badge-sideline">side</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="explorer-lines-panel">
        <div className="continuations-label">Engine lines {thinking && <span className="explorer-thinking">thinking…</span>}</div>
        {evalResult && evalResult.pvs.length > 0 ? (
          <ul className="explorer-lines-list">
            {evalResult.pvs.slice(0, 3).map((pv, i) => {
              const pawns = pv.cp / 100;
              const label = `${pawns > 0 ? "+" : ""}${pawns.toFixed(1)}`;
              const preview = numberedSan(pv.sanLine.slice(0, 6), ply);
              return (
                <li key={i} className="explorer-line-row">
                  <span className="explorer-line-eval">{label}</span>
                  <span className="explorer-line-moves text-dim">{preview}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-dim">{thinking ? "Thinking…" : "No engine lines yet."}</p>
        )}
      </div>

      {canAdd && (
        <div className="explorer-add-section">
          {!pickerOpen ? (
            <button type="button" className="primary explorer-add-btn" onClick={() => setPickerOpen(true)}>
              + Add this line to repertoire
            </button>
          ) : (
            <div className="explorer-picker">
              <div className="continuations-label">Add to which opening?</div>
              <div className="chip-row">
                {trainingEntries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="chip"
                    onClick={() => handleAddTo(entry)}
                  >
                    {entry.name}
                  </button>
                ))}
              </div>
              <button type="button" className="explorer-picker-cancel" onClick={() => setPickerOpen(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {toast && <div className="explorer-toast">{toast}</div>}
    </div>
  );
}
