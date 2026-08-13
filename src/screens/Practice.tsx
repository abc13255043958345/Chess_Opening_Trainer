// Practice mode — the core drill screen (DESIGN.md §4.1, §4.2, §5, §6 M2/M3). Three
// phases: setup (pick openings + scope + mix), drill (board + deviation feedback +
// replay-until-clean), summary. Session/line logic lives in src/lib/practice.ts as
// pure functions/reducers; SRS grading/scheduling logic lives in src/lib/srs.ts
// (also pure) — this file is state plumbing + rendering + the IO glue between them
// (src/lib/srsStore.ts) only.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import { Chess } from "chess.js";
import Board from "../components/Board";
import MoveList from "../components/MoveList";
import { getTree, listTrainingSet } from "../lib/content";
import { numberedSan } from "../lib/tree";
import type { CatalogEntry, Color, OpeningTree, RepertoireNode, SrsCard } from "../types";
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
  type GradingEvent,
  type LineRun,
  type MixMode,
  type SessionState,
} from "../lib/practice";
import { dueCards, dueSubtreeSet, gradeCard, subtreeMastery, touchCard } from "../lib/srs";
import { loadCards, recordActivity, saveCard } from "../lib/srsStore";
import "./screens.css";
import "./practice.css";

type Phase =
  | { kind: "setup" }
  | { kind: "drill"; session: SessionState }
  | { kind: "summary"; session: SessionState };

export default function Practice() {
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  // The session's live SRS cards: loaded (a snapshot) at setup time, mutated in place
  // as grading events resolve during the drill, and persisted in batches at each line
  // completion (DESIGN §4.1.5/§7). A ref, not state — grading shouldn't trigger
  // re-renders on its own; the session state already does that.
  const cardsRef = useRef<Map<string, SrsCard>>(new Map());

  if (phase.kind === "setup") {
    return (
      <SetupScreen
        cardsRef={cardsRef}
        onStart={(session) => setPhase({ kind: "drill", session })}
      />
    );
  }
  if (phase.kind === "drill") {
    return (
      <DrillScreen
        session={phase.session}
        cardsRef={cardsRef}
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

/** "All moves" vs "due only" session scoping (DESIGN §4.1 setup / §4.2 interleaving). */
type Scope = "all" | "due";

const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { value: "all", label: "All moves" },
  { value: "due", label: "Due only" },
];

function SetupScreen({
  cardsRef,
  onStart,
}: {
  cardsRef: RefObject<Map<string, SrsCard>>;
  onStart: (session: SessionState) => void;
}) {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mix, setMix] = useState<MixMode>("mix");
  const [scope, setScope] = useState<Scope>("all");
  const [dueCounts, setDueCounts] = useState<Record<string, number>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTrainingSet()
      .then(async (list) => {
        setEntries(list);
        setSelected(new Set(list.map((e) => e.id)));
        const cards = await loadCards(list.map((e) => e.id));
        const { perOpeningDueCount } = dueCards(cards, list.map((e) => e.id), new Date());
        setDueCounts(perOpeningDueCount);
      })
      .catch(() => setEntries([]));
  }, []);

  const dueOpeningIds = useMemo(
    () => new Set(Object.keys(dueCounts).filter((id) => dueCounts[id] > 0)),
    [dueCounts]
  );

  // "Due only" narrows the checkbox list to openings that actually have something due.
  const visibleEntries = useMemo(() => {
    if (!entries) return [];
    return scope === "due" ? entries.filter((e) => dueOpeningIds.has(e.id)) : entries;
  }, [entries, scope, dueOpeningIds]);

  // Re-select "all visible" whenever the scope narrows/widens what's on screen, so a
  // stale selection from the other scope doesn't linger unseen.
  useEffect(() => {
    if (!entries) return;
    setSelected(new Set(visibleEntries.map((e) => e.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, entries]);

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

      const cards = await loadCards(usableIds);
      cardsRef.current = cards;
      const now = new Date();

      // Low-mastery interleaving (DESIGN §4.2): a candidate branch's sampling weight
      // is multiplied by 1 + 1.5×(1 − mastery/100), so weak/unlearned branches come up
      // more often; "due only" additionally triples that for any branch that actually
      // contains a due node. Both the mastery numbers and the due-subtree sets are
      // fixed snapshots taken now — a session's bias shouldn't shift under the
      // trainee's feet as they grade cards mid-session.
      const dueSubtrees: Record<string, Set<string>> = {};
      if (scope === "due") {
        for (const id of usableIds) {
          const { due } = dueCards(cards, [id], now);
          dueSubtrees[id] = dueSubtreeSet(trees[id], new Set(due.map((c) => c.nodeId)));
        }
      }
      const masteryMemo = new Map<string, number>();
      function biasFn(tree: OpeningTree, node: RepertoireNode): number {
        const memoKey = `${tree.id}:${node.id}`;
        let score = masteryMemo.get(memoKey);
        if (score == null) {
          score = subtreeMastery(tree, node.id, cards, now);
          masteryMemo.set(memoKey, score);
        }
        let multiplier = 1 + 1.5 * (1 - score / 100);
        if (scope === "due" && dueSubtrees[tree.id]?.has(node.id)) multiplier *= 3;
        return multiplier;
      }

      const session = createSession(trees, usableIds, mix, mulberry32(Date.now()), biasFn);
      onStart(session);
    } catch {
      setError("Couldn't start practice. Try again.");
      setStarting(false);
    }
  }

  const nothingDue =
    scope === "due" && entries !== null && entries.length > 0 && dueOpeningIds.size === 0;

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
            <h2>Scope</h2>
            <div className="chip-row">
              {SCOPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`chip ${scope === opt.value ? "chip-active" : ""}`}
                  onClick={() => setScope(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {nothingDue && (
              <p className="text-dim practice-nothing-due">
                Nothing due —{" "}
                <button
                  type="button"
                  className="practice-link-button"
                  onClick={() => setScope("all")}
                >
                  practice everything?
                </button>
              </p>
            )}
          </section>

          <section className="practice-setup-section">
            <h2>
              Openings ({selected.size} of {visibleEntries.length})
            </h2>
            <ul className="practice-opening-list">
              {visibleEntries.map((entry) => (
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
                    {(dueCounts[entry.id] ?? 0) > 0 && (
                      <span className="badge badge-accent">{dueCounts[entry.id]} due</span>
                    )}
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
  cardsRef,
  onSessionChange,
  onEnd,
}: {
  session: SessionState;
  cardsRef: RefObject<Map<string, SrsCard>>;
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

  // Cards touched (graded or just touched) since the last persist, and a guard so a
  // given completed LineRun object only gets persisted once.
  const dirtyKeysRef = useRef<Set<string>>(new Set());
  const savedForLineRef = useRef<LineRun | null>(null);

  function flushDirtyCards() {
    const dirty = dirtyKeysRef.current;
    if (dirty.size === 0) return;
    const toSave = [...dirty]
      .map((k) => cardsRef.current.get(k))
      .filter((c): c is SrsCard => !!c);
    dirty.clear();
    if (toSave.length > 0) void saveCard(toSave);
  }

  // Apply a grading event as soon as a user move resolves correctly (DESIGN §4.1.5,
  // §7): grade the card on the line's first run, or just touch it (attempts/lastSeen,
  // no schedule change) on a replay. Batched to disk at line completion, below.
  function applyGradingEvent(evt: GradingEvent) {
    const cards = cardsRef.current;
    const prev = cards.get(evt.key) ?? null;
    const now = new Date();
    const updated = evt.isFirstRun
      ? gradeCard(prev, {
          firstTry: evt.firstTry,
          hesitated: false, // wired in M5 — see src/lib/srs.ts's GradeOptions doc.
          now,
          key: evt.key,
          openingId: evt.openingId,
          nodeId: evt.nodeId,
        })
      : touchCard(prev, { now, key: evt.key, openingId: evt.openingId, nodeId: evt.nodeId });
    cards.set(evt.key, updated);
    dirtyKeysRef.current.add(evt.key);
  }

  // Batch-persist graded/touched cards and log the day as active once a line finishes
  // (DESIGN §6 M3: "save via srsStore after each line completes"). Guarded by run
  // identity so it fires exactly once per completed LineRun object, not on every
  // re-render while the completed state is showing.
  useEffect(() => {
    if (!lineComplete) return;
    if (savedForLineRef.current === run) return;
    savedForLineRef.current = run;
    flushDirtyCards();
    void recordActivity(new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineComplete, run]);

  // Flush on unmount too (e.g. navigating away mid-line) so a partially-graded line
  // isn't silently lost.
  useEffect(() => {
    return () => flushDirtyCards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      applyGradingEvent(outcome.gradingEvent);
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
    flushDirtyCards();
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
                      flushDirtyCards();
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
