// Practice mode — the core drill screen (DESIGN.md §4.1, §4.2, §5, §6 M2/M3). Three
// phases: setup (pick openings + scope + mix), drill (board + deviation feedback +
// replay-until-clean), summary. Session/line logic lives in src/lib/practice.ts as
// pure functions/reducers; SRS grading/scheduling logic lives in src/lib/srs.ts
// (also pure) — this file is state plumbing + rendering + the IO glue between them
// (src/lib/srsStore.ts) only.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import { Chess } from "chess.js";
import Board from "../components/Board";
import EvalBar from "../components/EvalBar";
import MoveList from "../components/MoveList";
import AnalysisPanel from "../components/AnalysisPanel";
import { getTree, listTrainingSet } from "../lib/content";
import { numberedSan } from "../lib/tree";
import { getEngine, EngineCancelledError } from "../lib/engine";
import type { CatalogEntry, Color, OpeningTree, RepertoireNode, SrsCard } from "../types";
import {
  accuracy,
  advanceOpponentMove,
  createSession,
  expectedMove,
  formatEvalPawns,
  HESITATION_MS,
  isLineComplete,
  markHintUsed,
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
import "../components/evalbar.css";
import "./practice.css";

type Phase =
  | { kind: "setup" }
  | { kind: "drill"; session: SessionState }
  | { kind: "summary"; session: SessionState };

/** Shape of the location.state a caller can pass to jump straight into a drill,
 *  skipping setup (DESIGN §6 M5's "Drill traps" shortcut on Home's per-opening cards —
 *  see src/screens/Home.tsx — mix="mistakes" for a single opening; nothing else uses
 *  this today, but it's not mix-specific). */
export interface PracticeAutoStart {
  openingIds: string[];
  mix?: MixMode;
}

export default function Practice() {
  const location = useLocation();
  const autoStart = (location.state ?? null) as PracticeAutoStart | null;
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
        autoStart={autoStart}
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
  autoStart,
  onStart,
}: {
  cardsRef: RefObject<Map<string, SrsCard>>;
  autoStart: PracticeAutoStart | null;
  onStart: (session: SessionState) => void;
}) {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mix, setMix] = useState<MixMode>(autoStart?.mix ?? "mix");
  const [scope, setScope] = useState<Scope>("all");
  const [dueCounts, setDueCounts] = useState<Record<string, number>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoStartedRef = useRef(false);

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

  // Auto-start (DESIGN §6 M5's "Drill traps" shortcut): once the training set has
  // loaded, jump straight into a session for the requested opening(s)/mix, skipping
  // the setup form entirely — guarded so it only ever fires once per mount even if
  // entries reload for some other reason.
  useEffect(() => {
    if (!entries || autoStartedRef.current) return;
    if (!autoStart || autoStart.openingIds.length === 0) return;
    const ids = autoStart.openingIds.filter((id) => entries.some((e) => e.id === id));
    if (ids.length === 0) return;
    autoStartedRef.current = true;
    setSelected(new Set(ids));
    void handleStart(ids, autoStart.mix ?? mix);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  async function handleStart(idsOverride?: string[], mixOverride?: MixMode) {
    const ids = idsOverride ?? [...selected];
    if (ids.length === 0) {
      setError("Nothing selected to practice.");
      return;
    }
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

      const session = createSession(
        trees,
        usableIds,
        mixOverride ?? mix,
        mulberry32(Date.now()),
        biasFn
      );
      onStart(session);
    } catch {
      setError("Couldn't start practice. Try again.");
      setStarting(false);
    }
  }

  const nothingDue =
    scope === "due" && entries !== null && entries.length > 0 && dueOpeningIds.size === 0;

  // Skip the setup form entirely while an auto-start (DESIGN §6 M5's "Drill traps"
  // shortcut) is in flight, so it doesn't flash on screen — unless it already failed
  // (surfaced via `error`), in which case fall through to the normal form so the
  // trainee isn't stuck on a bare loading screen forever.
  if (autoStart && autoStart.openingIds.length > 0 && !error) {
    return (
      <div className="screen-padding practice-setup">
        <p className="text-dim">Starting drill…</p>
      </div>
    );
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
            onClick={() => handleStart()}
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
  // Live engine eval of the attempted (wrong) position, depth 12 (DESIGN §4.3): purely
  // a nicer number for the feedback panel than the cached-eval fallback — engine
  // failure/timeout just leaves this null and DeviationPanel silently falls back.
  const [liveEvalCp, setLiveEvalCp] = useState<number | null>(null);
  const liveEvalAbortRef = useRef<AbortController | null>(null);
  // In-drill analysis mode (feature): non-null while the free-play overlay is showing,
  // holding the FEN it was seeded from. The drill's own state below is never touched
  // while this is set — see the guards on the opponent-advance effect and Board's
  // viewOnly, and handleReturnFromAnalysis for what happens on the way back.
  const [analysisSeedFen, setAnalysisSeedFen] = useState<string | null>(null);

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

  // ---------- Hesitation timing (DESIGN §5/§6 M5) ----------
  // Timed from when a *fresh* pending user move appears (opponent move animation
  // landed / this is a brand-new node, not a retry at the same one) to that node's
  // FIRST attempt — never shown in the UI mid-drill (no timer anxiety). A ref, not
  // state: it drives a value read at the moment of the next attempt, not a render.
  const turnStartRef = useRef<number | null>(null);
  const pendingUserNode =
    pendingMover === "user" && !lineComplete ? expectedMove(tree, run.line, idx) : undefined;
  useEffect(() => {
    if (pendingUserNode) turnStartRef.current = Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUserNode?.id]);
  // Slow-first-attempts seen so far THIS run — shown subtly on the line-complete card,
  // never mid-drill. Reset alongside the rest of the per-line UI state below.
  const hesitationCountRef = useRef(0);

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
  // `hesitated` (DESIGN §5/§6 M5) only ever affects the first-run grade path — a
  // retry-run touch doesn't schedule anyway (DESIGN §4.1.5/§7), so it's simply ignored
  // there, matching src/lib/srs.ts's GradeOptions doc.
  function applyGradingEvent(evt: GradingEvent, hesitated: boolean) {
    const cards = cardsRef.current;
    const prev = cards.get(evt.key) ?? null;
    const now = new Date();
    const updated = evt.isFirstRun
      ? gradeCard(prev, {
          firstTry: evt.firstTry,
          hesitated,
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
    liveEvalAbortRef.current?.abort();
    setLiveEvalCp(null);
    hesitationCountRef.current = 0;
    setAnalysisSeedFen(null);
  }, [run.line]);

  // Abort any in-flight live eval on unmount so a stale resolve can't fire after the
  // screen (or the drill) is gone.
  useEffect(() => {
    return () => liveEvalAbortRef.current?.abort();
  }, []);

  // Opponent's move is pinned; it just needs to visually land after a short delay.
  // The very first move of a line (idx 0, e.g. White's opening move when the trainee
  // plays Black) gets a slightly longer beat (~400ms) than mid-line replies (~350ms).
  // Suspended while the analysis overlay is open (analysisSeedFen set) so the drill
  // never silently advances underneath the trainee while they're exploring — it
  // re-arms with a fresh delay once they return (analysisSeedFen back to null).
  useEffect(() => {
    if (pendingMover !== "opponent" || lineComplete || analysisSeedFen != null) return;
    const delay = idx === 0 ? 400 : 350;
    const timer = window.setTimeout(() => {
      onSessionChange(advanceOpponentMove(session));
    }, delay);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMover, lineComplete, idx, run.line, analysisSeedFen]);

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

    // Hesitation (DESIGN §5/§6 M5): only the FIRST attempt at a node counts — read
    // wrongAttemptsAtCurrent (and the turn-start timestamp) BEFORE submitMove resolves
    // this attempt, since submitMove's returned state has already moved past it.
    const isFirstAttempt = run.wrongAttemptsAtCurrent === 0;
    const hesitated =
      isFirstAttempt &&
      turnStartRef.current != null &&
      Date.now() - turnStartRef.current > HESITATION_MS;

    const attemptedUci = `${move.from}${move.to}${move.promotion ?? ""}`;
    const { state: nextSession, outcome } = submitMove(session, attemptedUci, move.san);
    if (outcome.kind === "correct") {
      applyGradingEvent(outcome.gradingEvent, hesitated);
      if (hesitated) hesitationCountRef.current += 1;
      setFeedback(null);
      liveEvalAbortRef.current?.abort();
      setLiveEvalCp(null);
      setFlash("green");
      window.setTimeout(() => setFlash(null), 260);
      onSessionChange(nextSession);
    } else if (outcome.kind === "wrong") {
      setFlash("red");
      setFeedback(outcome.feedback);
      window.setTimeout(() => setFlash(null), 350);
      onSessionChange(nextSession);

      // Live engine eval of the position the trainee actually reached (DESIGN §4.3):
      // depth 12, cancels any still-pending eval from a previous wrong attempt at this
      // same node. Best-effort — a failure/timeout just leaves liveEvalCp null and the
      // feedback panel falls back to the cached-eval delta (if any).
      liveEvalAbortRef.current?.abort();
      const controller = new AbortController();
      liveEvalAbortRef.current = controller;
      setLiveEvalCp(null);
      getEngine()
        .evaluate(move.after, { depth: 12, signal: controller.signal })
        .then((res) => setLiveEvalCp(res.cp))
        .catch((err) => {
          if (!(err instanceof EngineCancelledError)) setLiveEvalCp(null);
        });
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

  // ---------- In-drill analysis mode ----------
  // SRS honesty rule: entering analysis while a user move is pending and NOT yet
  // failed counts as a hint (same consequence as a wrong attempt — the line replays).
  // Entering from the deviation panel (the move already failed, `feedback` is set) or
  // the line-complete card (no pending move at all) never costs anything.
  const hintWouldApply = pendingMover === "user" && !lineComplete && !feedback;

  function enterAnalysis(applyHintPenalty: boolean) {
    setMenuOpen(false);
    if (applyHintPenalty) {
      onSessionChange({ ...session, run: markHintUsed(run) });
    }
    // Void the hesitation timer for whatever move is pending — time spent exploring
    // must never turn into a bogus "hesitated" grade once they come back and play it.
    turnStartRef.current = null;
    // The overlay is seeded with exactly what's on the board right now: currentNode
    // is the last move actually played, unaffected by a pending/failed attempt (the
    // board never advances past it until a move is accepted).
    setAnalysisSeedFen(currentNode.fen);
  }

  function handleExploreFromMenu() {
    enterAnalysis(hintWouldApply);
  }

  function handleReturnFromAnalysis() {
    setAnalysisSeedFen(null);
    // Restart the timer fresh for whatever's still pending — same node, but the
    // clock shouldn't include time spent away in analysis.
    if (pendingMover === "user" && !lineComplete) {
      turnStartRef.current = Date.now();
    }
  }

  return (
    <div className="screen-padding practice-drill">
      <header className="practice-header">
        <div className="practice-header-top">
          <h1 className="practice-header-title" title={tree.name}>
            {tree.name}
          </h1>
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
                  <button type="button" onClick={handleExploreFromMenu}>
                    Explore from here
                    {hintWouldApply && (
                      <span className="practice-menu-hint-warning"> (counts as a hint)</span>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="practice-header-progress text-dim">
          Move {moveNumber} of {totalPlies}
        </div>
        <div className="practice-stats-row text-dim">
          <span>{session.stats.linesCompleted} done</span>
          <span>{session.stats.cleanPasses} clean</span>
          <span>{Math.round(accuracy(session.stats) * 100)}% accuracy</span>
        </div>
      </header>

      <div className="board-eval-row">
        <EvalBar evalCp={currentNode.evalCp ?? null} />
        <div className="board-frame">
          <Board
            fen={currentNode.fen}
            orientation={tree.perspective}
            lastMove={lastMove}
            dests={dests}
            viewOnly={pendingMover !== "user" || lineComplete || analysisSeedFen != null}
            onMove={handleBoardMove}
            check={inCheck}
            flash={flash}
          />
        </div>
      </div>

      <MoveList sans={sans} currentPly={sans.length} onSelect={() => {}} />

      {feedback && !lineComplete && (
        <DeviationPanel
          feedback={feedback}
          idx={idx}
          perspective={tree.perspective}
          liveEvalCp={liveEvalCp}
          bookEvalCp={expectedMove(tree, run.line, idx)?.evalCp ?? null}
          onExplore={() => enterAnalysis(false)}
        />
      )}

      {lineComplete && (
        <LineCompleteCard
          tree={tree}
          session={session}
          slowMoveCount={hesitationCountRef.current}
          onReplay={() => onSessionChange(replayLine(session))}
          onNext={() => onSessionChange(nextLine(session))}
          onEnd={() => onEnd(session)}
          onExplore={() => enterAnalysis(false)}
        />
      )}

      {analysisSeedFen != null && (
        <AnalysisPanel
          seedFen={analysisSeedFen}
          orientation={tree.perspective}
          onReturn={handleReturnFromAnalysis}
        />
      )}
    </div>
  );
}

function DeviationPanel({
  feedback,
  idx,
  perspective,
  liveEvalCp,
  bookEvalCp,
  onExplore,
}: {
  feedback: DeviationFeedback;
  idx: number;
  perspective: Color;
  /** Live depth-12 eval of the position the trainee actually reached (DESIGN §4.3),
   *  or null if it's still running / failed / timed out. */
  liveEvalCp?: number | null;
  /** Cached eval of the correct node, for the "vs book" half of the live comparison. */
  bookEvalCp?: number | null;
  /** Opens the in-drill analysis overlay seeded at the current (pre-attempt) position.
   *  The move already failed here, so this never costs a hint. */
  onExplore: () => void;
}) {
  const previewText =
    feedback.previewSans.length > 0 ? numberedSan(feedback.previewSans, idx + 1) : null;

  // Prefer the live engine number (works for ANY attempted move) over the cached-eval
  // delta (src/lib/practice.ts's evalDeltaCp, which only exists when the attempted
  // move happens to also be a known tree child with its own cached eval).
  let lossText: string | null = null;
  if (liveEvalCp != null && bookEvalCp != null) {
    lossText = `Your move: ${formatEvalPawns(liveEvalCp)} vs book ${formatEvalPawns(bookEvalCp)}`;
  } else if (feedback.evalDeltaCp != null) {
    // evalDeltaCp is a raw white-positive centipawn difference (expected − attempted).
    // Whether that's actually a *loss* for the trainee depends on which side they're
    // playing: White wants a higher (more positive) eval, Black a lower one. Flip the
    // sign accordingly and only show the line when the attempted move was genuinely worse.
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
      <button type="button" className="practice-explore-btn" onClick={onExplore}>
        Explore from here
      </button>
    </div>
  );
}

function LineCompleteCard({
  tree,
  session,
  slowMoveCount,
  onReplay,
  onNext,
  onEnd,
  onExplore,
}: {
  tree: OpeningTree;
  session: SessionState;
  /** First attempts that took >HESITATION_MS this run (DESIGN §5/§6 M5) — shown as a
   *  subtle note only, never mid-drill. */
  slowMoveCount: number;
  onReplay: () => void;
  onNext: () => void;
  onEnd: () => void;
  /** Opens the in-drill analysis overlay seeded at the line's final position — stays
   *  on /practice with drill state intact, unlike "Open in Explorer" below which
   *  navigates away. The line is already complete, so this never costs a hint. */
  onExplore: () => void;
}) {
  const { run } = session;
  const finalNode = nodeAt(tree, run.line, run.idx);
  const evalCp = finalNode.endOfTheory?.evalCp ?? finalNode.evalCp;
  const plans = finalNode.annotation?.plans;
  const total = run.results.length;
  const firstTryCount = run.results.filter((r) => r.firstTry).length;
  const runAccuracy = total > 0 ? Math.round((firstTryCount / total) * 100) : 100;
  // "Open in Explorer" navigates away to a fresh Explorer session (deep-linked with
  // this line's moves); "Explore from here" (above it) opens the in-drill overlay
  // instead, keeping the session live underneath.
  const lineMoves = run.line.nodeIds
    .map((id) => tree.nodes[id]?.uci)
    .filter((uci): uci is string => !!uci);

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
      {slowMoveCount > 0 && (
        <p className="text-dim practice-slow-moves">
          {slowMoveCount} slow move{slowMoveCount === 1 ? "" : "s"}
        </p>
      )}
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
        <button type="button" className="practice-explore-btn" onClick={onExplore}>
          Explore from here
        </button>
        {lineMoves.length > 0 && (
          <Link to="/explorer" state={{ moves: lineMoves }} className="practice-analyze-link">
            Open in Explorer
          </Link>
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
