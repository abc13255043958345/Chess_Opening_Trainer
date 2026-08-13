// In-drill analysis mode overlay (DESIGN.md §4.1/§4.4 crossover — a full-screen,
// free-play board the trainee can pop open mid-drill without losing their place).
// Deliberately mirrors src/screens/Explorer.tsx's free-play + "engine always on"
// pattern (same getEngine().evaluate({multiPv:3, depth:12}) call, same latest-wins
// EngineCancelledError swallow, same Prev/Next-over-a-linear-move-list shape) but
// stays self-contained here rather than reusing Explorer directly: Explorer is a
// full routed screen (its own header, deep-link handling, repertoire overlay, "add to
// repertoire", etc.) and is on the frozen list — this component is a stripped-down,
// reusable "just the free board + engine lines" piece meant to be rendered ON TOP of
// a live screen (Practice.tsx) as a fixed-position overlay, never routed to directly.
//
// Callers own all drill state: this component owns nothing but its own local free
// line (positions/moves/ply) seeded once from `seedFen` and the engine request for
// whatever position is currently showing. "Return to drill" is a pure callback — the
// caller decides what "returning" means (this component has no opinion on hints/SRS).

import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import Board from "./Board";
import EvalBar from "./EvalBar";
import MoveList from "../components/MoveList";
import { getEngine, EngineCancelledError, type EngineEvalResult } from "../lib/engine";
import { numberedSan } from "../lib/tree";
import type { Color } from "../types";
import "./evalbar.css";
import "../screens/screens.css";
import "./analysisPanel.css";

export interface AnalysisPanelProps {
  /** Position to seed free play from — exactly what's on the drill board at the
   *  moment the trainee opened this (see Practice.tsx's DrillScreen for the three
   *  entry points, all of which pass `currentNode.fen`). */
  seedFen: string;
  /** Board orientation — the drill's own perspective, so the board doesn't flip
   *  disorientingly when this opens on top of it. */
  orientation: Color;
  /** Called when the trainee taps "Return to drill". Purely a signal — this
   *  component holds no drill state to restore; the caller's own state was simply
   *  never touched while this was open. */
  onReturn: () => void;
}

interface FreeMove {
  san: string;
  uci: string;
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

export default function AnalysisPanel({ seedFen, orientation, onReturn }: AnalysisPanelProps) {
  const [positions, setPositions] = useState<string[]>([seedFen]);
  const [moves, setMoves] = useState<FreeMove[]>([]);
  const [ply, setPly] = useState(0);

  const currentFen = positions[ply];
  const sans = useMemo(() => moves.map((m) => m.san), [moves]);

  const lastMove: [string, string] | undefined =
    ply > 0 && moves[ply - 1]
      ? [moves[ply - 1].uci.slice(0, 2), moves[ply - 1].uci.slice(2, 4)]
      : undefined;

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

  function handleBoardMove(orig: string, dest: string) {
    let chess: Chess;
    try {
      chess = new Chess(currentFen);
    } catch {
      return;
    }
    const candidates = chess.moves({ verbose: true }).filter((m) => m.from === orig && m.to === dest);
    if (candidates.length === 0) return;
    // Auto-queen promotion, per spec — no promotion picker in analysis mode.
    const mv = candidates.find((m) => m.promotion === "q") ?? candidates[0];
    const newPositions = [...positions.slice(0, ply + 1), mv.after];
    const newMoves = [...moves.slice(0, ply), { san: mv.san, uci: `${mv.from}${mv.to}${mv.promotion ?? ""}` }];
    setPositions(newPositions);
    setMoves(newMoves);
    setPly(newPositions.length - 1);
  }

  // ---------- Engine, always on (mirrors Explorer.tsx exactly: multiPv 3, depth 12,
  // latest-wins via AbortController, EngineCancelledError swallowed). ----------
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

  return (
    <div className="analysis-overlay" role="dialog" aria-label="Analysis mode">
      <div className="analysis-overlay-header">
        <h2 className="analysis-overlay-title">Analysis</h2>
        <button type="button" className="primary analysis-return-btn" onClick={onReturn}>
          Return to drill
        </button>
      </div>

      <div className="board-eval-row">
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

      <div className="analysis-lines-panel">
        <div className="continuations-label">
          Engine lines {thinking && <span className="analysis-thinking">thinking…</span>}
        </div>
        {evalResult && evalResult.pvs.length > 0 ? (
          <ul className="analysis-lines-list">
            {evalResult.pvs.slice(0, 3).map((pv, i) => {
              const pawns = pv.cp / 100;
              const label = `${pawns > 0 ? "+" : ""}${pawns.toFixed(1)}`;
              const preview = numberedSan(pv.sanLine.slice(0, 6), ply);
              return (
                <li key={i} className="analysis-line-row">
                  <span className="analysis-line-eval">{label}</span>
                  <span className="analysis-line-moves text-dim">{preview}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-dim">{thinking ? "Thinking…" : "No engine lines yet."}</p>
        )}
      </div>
    </div>
  );
}
