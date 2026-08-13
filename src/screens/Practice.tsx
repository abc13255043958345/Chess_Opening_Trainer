// Practice mode — the core drill screen (DESIGN.md §4.1, §4.2, §6 M2). Two phases:
// setup (pick openings + mix) and drill (board + deviation feedback + replay-until-
// clean). All session logic lives in src/lib/practice.ts as pure functions/reducers;
// this file is state plumbing + rendering only.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Chess } from "chess.js";
import Board from "../components/Board";
import MoveList from "../components/MoveList";
import { getTree, listTrainingSet } from "../lib/content";
import { numberedSan } from "../lib/tree";
import type { CatalogEntry, Color, OpeningTree } from "../types";
import {
  accuracy,
  advanceOpponentMove,
  createSession,
  formatEvalPawns,
  isLineComplete,
  mulberry32,
  nextLine,
  nextMover,
  nodeAt,
  playedSoFarSans,
  replayLine,
  sessionSummary,
  skipLine,
  submitMove,
  type DeviationFeedback,
  type MixMode,
  type SessionState,
} from "../lib/practice";
import "./screens.css";
import "./practice.css";

type Phase =
  | { kind: "setup" }
  | { kind: "drill"; session: SessionState }
  | { kind: "summary"; session: SessionState };

export default function Practice() {
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });

  if (phase.kind === "setup") {
    return <SetupScreen onStart={(session) => setPhase({ kind: "drill", session })} />;
  }
  if (phase.kind === "drill") {
    return (
      <DrillScreen
        session={phase.session}
        onSessionChange={(session) => setPhase({ kind: "drill", session })}
        onEnd={(session) => setPhase({ kind: "summary", session })}
      />
    );
  }
  return (
    <SummaryScreen session={phase.session} onRestart={() => setPhase({ kind: "setup" })} />
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const MIX_OPTIONS: { value: MixMode; label: string }[] = [
  { value: "theory", label: "Theory only" },
  { value: "mix", label: "Mixed (80/20)" },
  { value: "mistakes", label: "Mistakes only" },
];

function SetupScreen({ onStart }: { onStart: (session: SessionState) => void }) {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mix, setMix] = useState<MixMode>("mix");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTrainingSet()
      .then((list) => {
        setEntries(list);
        setSelected(new Set(list.map((e) => e.id)));
      })
      .catch(() => setEntries([]));
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleStart() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setStarting(true);
    setError(null);
    try {
      const loaded = await Promise.all(ids.map((id) => getTree(id)));
      const trees: Record<string, OpeningTree> = {};
      loaded.forEach((tree, i) => {
        // Gracefully exclude any opening whose content couldn't be loaded.
        if (tree) trees[ids[i]] = tree;
      });
      const usableIds = Object.keys(trees);
      if (usableIds.length === 0) {
        setError("None of the selected openings have content available right now.");
        setStarting(false);
        return;
      }
      const session = createSession(trees, usableIds, mix, mulberry32(Date.now()));
      onStart(session);
    } catch {
      setError("Couldn't start practice. Try again.");
      setStarting(false);
    }
  }

  return (
    <div className="screen-padding practice-setup">
      <h1>Practice</h1>

      {entries === null && <p className="text-dim">Loading your training set…</p>}

      {entries !== null && entries.length === 0 && (
        <div className="empty-state">
          <p>Your training set is empty.</p>
          <p className="text-dim">
            Add openings from the <Link to="/catalog">catalog</Link> before practicing them.
          </p>
        </div>
      )}

      {entries !== null && entries.length > 0 && (
        <>
          <section className="practice-setup-section">
            <h2>Openings ({selected.size} of {entries.length})</h2>
            <ul className="practice-opening-list">
              {entries.map((entry) => (
                <li key={entry.id} className="practice-opening-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(entry.id)}
                      onChange={() => toggle(entry.id)}
                    />
                    <span className="practice-opening-name">{entry.name}</span>
                    <span className={`badge badge-${entry.perspective}`}>
                      {entry.perspective === "white" ? "White" : "Black"}
                    </span>
                    {entry.mistakeCount > 0 && (
                      <span className="badge badge-amber">{entry.mistakeCount} traps</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </section>

          <section className="practice-setup-section">
            <h2>Mix</h2>
            <div className="chip-row">
              {MIX_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`chip ${mix === opt.value ? "chip-active" : ""}`}
                  onClick={() => setMix(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          {error && <p className="text-dim practice-error">{error}</p>}

          <button
            type="button"
            className="primary practice-start-button"
            disabled={selected.size === 0 || starting}
            onClick={handleStart}
          >
            {starting ? "Starting…" : "Start practice"}
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drill
// ---------------------------------------------------------------------------

function allLegalDests(fen: string): Map<string, string[]> {
  const chess = new Chess(fen);
  const dests = new Map<string, string[]>();
  for (const move of chess.moves({ verbose: true })) {
    const arr = dests.get(move.from) ?? [];
    if (!arr.includes(move.to)) arr.push(move.to);
    dests.set(move.from, arr);
  }
  return dests;
}

function DrillScreen({
  session,
  onSessionChange,
  onEnd,
}: {
  session: SessionState;
  onSessionChange: (session: SessionState) => void;
  onEnd: (session: SessionState) => void;
}) {
  const [flash, setFlash] = useState<"red" | "green" | null>(null);
  const [feedback, setFeedback] = useState<DeviationFeedback | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);

  const { run, trees } = session;
  const tree = trees[run.line.openingId];
  const idx = run.idx;
  const currentNode = nodeAt(tree, run.line, idx);
  const lineComplete = isLineComplete(run.line, idx);
  const pendingMover = nextMover(tree, run.line, idx);

  // Reset ephemeral, per-line UI state whenever a new line starts (fresh run object).
  useEffect(() => {
    setFlash(null);
    setFeedback(null);
    setMenuOpen(false);
    setConfirmingEnd(false);
  }, [run.line]);

  // Opponent's move is pinned; it just needs to visually land after a short delay.
  // The very first move of a line (idx 0, e.g. White's opening move when the trainee
  // plays Black) gets a slightly longer beat (~400ms) than mid-line replies (~350ms).
  useEffect(() => {
    if (pendingMover !== "opponent" || lineComplete) return;
    const delay = idx === 0 ? 400 : 350;
    const timer = window.setTimeout(() => {
      onSessionChange(advanceOpponentMove(session));
    }, delay);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMover, lineComplete, idx, run.line]);

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

  const dests = useMemo(() => {
    if (pendingMover !== "user" || lineComplete) return undefined;
    return allLegalDests(currentNode.fen);
  }, [pendingMover, lineComplete, currentNode.fen]);

  const sans = playedSoFarSans(tree, run.line, idx);

  function handleBoardMove(orig: string, dest: string) {
    if (pendingMover !== "user" || lineComplete) return;
    const chess = new Chess(currentNode.fen);
    let move;
    try {
      move = chess.move({ from: orig, to: dest, promotion: "q" });
    } catch {
      move = null;
    }
    if (!move) return;
    const attemptedUci = `${move.from}${move.to}${move.promotion ?? ""}`;
    const { state: nextSession, outcome } = submitMove(session, attemptedUci, move.san);
    if (outcome.kind === "correct") {
      setFeedback(null);
      setFlash("green");
      window.setTimeout(() => setFlash(null), 260);
      onSessionChange(nextSession);
    } else if (outcome.kind === "wrong") {
      setFlash("red");
      setFeedback(outcome.feedback);
      window.setTimeout(() => setFlash(null), 350);
      onSessionChange(nextSession);
    }
  }

  const totalPlies = run.line.nodeIds.length - 1;
  const moveNumber = Math.min(idx + 1, Math.max(totalPlies, 1));

  function handleEndClick() {
    const midLine = idx > 0 && !lineComplete;
    if (midLine && !confirmingEnd) {
      setConfirmingEnd(true);
      return;
    }
    onEnd(session);
  }

  return (
    <div className="screen-padding practice-drill">
      <header className="practice-header">
        <div className="practice-header-top">
          <div>
            <h1>{tree.name}</h1>
            <div className="text-dim">
              Move {moveNumber} of {totalPlies}
            </div>
          </div>
          <div className="practice-header-actions">
            {confirmingEnd ? (
              <div className="practice-confirm-end">
                <span className="text-dim">End now?</span>
                <button type="button" onClick={() => onEnd(session)}>
                  Yes
                </button>
                <button type="button" onClick={() => setConfirmingEnd(false)}>
                  No
                </button>
              </div>
            ) : (
              <button type="button" onClick={handleEndClick}>
                End session
              </button>
            )}
            <div className="practice-menu-wrap">
              <button
                type="button"
                aria-label="More options"
                onClick={() => setMenuOpen((v) => !v)}
              >
                …
              </button>
              {menuOpen && (
                <div className="practice-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onSessionChange(skipLine(session));
                    }}
                  >
                    Skip this line
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="practice-stats-row text-dim">
          <span>{session.stats.linesCompleted} done</span>
          <span>{session.stats.cleanPasses} clean</span>
          <span>{Math.round(accuracy(session.stats) * 100)}% accuracy</span>
        </div>
      </header>

      <div className="board-frame">
        <Board
          fen={currentNode.fen}
          orientation={tree.perspective}
          lastMove={lastMove}
          dests={dests}
          viewOnly={pendingMover !== "user" || lineComplete}
          onMove={handleBoardMove}
          check={inCheck}
          flash={flash}
        />
      </div>

      <MoveList sans={sans} currentPly={sans.length} onSelect={() => {}} />

      {feedback && !lineComplete && (
        <DeviationPanel feedback={feedback} idx={idx} perspective={tree.perspective} />
      )}

      {lineComplete && (
        <LineCompleteCard
          tree={tree}
          session={session}
          onReplay={() => onSessionChange(replayLine(session))}
          onNext={() => onSessionChange(nextLine(session))}
          onEnd={() => onEnd(session)}
        />
      )}
    </div>
  );
}

function DeviationPanel({
  feedback,
  idx,
  perspective,
}: {
  feedback: DeviationFeedback;
  idx: number;
  perspective: Color;
}) {
  const previewText =
    feedback.previewSans.length > 0 ? numberedSan(feedback.previewSans, idx + 1) : null;

  // evalDeltaCp is a raw white-positive centipawn difference (expected − attempted,
  // per src/lib/practice.ts). Whether that's actually a *loss* for the trainee depends
  // on which side they're playing: White wants a higher (more positive) eval, Black
  // wants a lower (more negative) one. Flip the sign accordingly and only show the
  // line when the attempted move was genuinely worse.
  let lossText: string | null = null;
  if (feedback.evalDeltaCp != null) {
    const lossCp = perspective === "white" ? feedback.evalDeltaCp : -feedback.evalDeltaCp;
    const lossPawns = lossCp / 100;
    if (lossPawns >= 0.05) {
      lossText = `Your move loses ~${lossPawns.toFixed(1)} pawns.`;
    }
  }

  return (
    <div className="annotation-panel practice-feedback-panel">
      <p className="practice-feedback-attempted">
        You played <strong>{feedback.attemptedSan}</strong>
      </p>
      <p className="practice-feedback-correct">
        Correct move: <strong>{feedback.correctSan}</strong>
      </p>
      <p className="annotation-explanation">{feedback.explanation}</p>
      {previewText && <p className="text-dim">Play continues {previewText}…</p>}
      {lossText && <p className="practice-feedback-loss">{lossText}</p>}
      <p className="text-dim practice-feedback-hint">Play {feedback.correctSan} to continue.</p>
    </div>
  );
}

function LineCompleteCard({
  tree,
  session,
  onReplay,
  onNext,
  onEnd,
}: {
  tree: OpeningTree;
  session: SessionState;
  onReplay: () => void;
  onNext: () => void;
  onEnd: () => void;
}) {
  const { run } = session;
  const finalNode = nodeAt(tree, run.line, run.idx);
  const evalCp = finalNode.endOfTheory?.evalCp ?? finalNode.evalCp;
  const plans = finalNode.annotation?.plans;
  const total = run.results.length;
  const firstTryCount = run.results.filter((r) => r.firstTry).length;
  const runAccuracy = total > 0 ? Math.round((firstTryCount / total) * 100) : 100;

  return (
    <div className="annotation-panel practice-line-complete">
      <div className={`practice-clean-badge ${run.clean ? "practice-clean" : "practice-dirty"}`}>
        {run.clean ? "Clean pass" : "Needs a replay"}
      </div>
      <h2>Line complete — {tree.name}</h2>
      {typeof evalCp === "number" && (
        <p className="text-dim">Final eval: {formatEvalPawns(evalCp)}</p>
      )}
      {plans && <p className="annotation-plans">{plans}</p>}
      <p className="text-dim">This run: {runAccuracy}% first-try ({firstTryCount}/{total || 0})</p>
      <div className="practice-line-complete-actions">
        {run.clean ? (
          <button type="button" className="primary" onClick={onNext}>
            Next line
          </button>
        ) : (
          <button type="button" className="primary" onClick={onReplay}>
            Replay this line
          </button>
        )}
        <button type="button" className="practice-subtle-end" onClick={onEnd}>
          End session
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function SummaryScreen({
  session,
  onRestart,
}: {
  session: SessionState;
  onRestart: () => void;
}) {
  const summary = sessionSummary(session);
  return (
    <div className="screen-padding practice-summary">
      <h1>Session summary</h1>
      <div className="practice-summary-stats">
        <div className="practice-summary-stat">
          <div className="practice-summary-stat-value">{summary.stats.linesCompleted}</div>
          <div className="text-dim">lines completed</div>
        </div>
        <div className="practice-summary-stat">
          <div className="practice-summary-stat-value">{summary.stats.cleanPasses}</div>
          <div className="text-dim">clean passes</div>
        </div>
        <div className="practice-summary-stat">
          <div className="practice-summary-stat-value">{Math.round(summary.accuracy * 100)}%</div>
          <div className="text-dim">accuracy</div>
        </div>
      </div>

      <h2>Per opening</h2>
      <ul className="practice-summary-breakdown">
        {summary.perOpening.map((row) => (
          <li key={row.openingId} className="practice-summary-row">
            <span>{session.trees[row.openingId]?.name ?? row.openingId}</span>
            <span className="text-dim">
              {row.linesCompleted} lines · {row.cleanPasses} clean
            </span>
          </li>
        ))}
      </ul>

      <button type="button" className="primary practice-start-button" onClick={onRestart}>
        Practice again
      </button>
    </div>
  );
}
