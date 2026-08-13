// Practice mode session engine (DESIGN.md §4.1, §4.2, §7). PURE LOGIC — no React, no
// DOM, no IO — so it's unit-testable head-on (see scripts/practice-engine-test.mjs) and
// so the UI (src/screens/Practice.tsx) can drive it as a plain reducer.
//
// Vocabulary, matching the tree model in src/types.ts / src/lib/tree.ts:
// - At a node where the TRAINEE is to move ("user" turn), there is exactly one correct
//   continuation: `mainlineChild`. The engine always plays that.
// - At a node where the OPPONENT is to move, the node's own children ARE the opponent's
//   candidate replies (theory moves and, sometimes, a curated mistake). The engine
//   samples one, biased by `mix` and each child's `weight`.
// - A "line" is generated once, root → end, with every opponent choice already resolved
//   (pinned). Replaying a line replays that exact same pinned sequence (DESIGN §4.1.5) —
//   nothing is re-sampled.

import type { Mover, OpeningTree, RepertoireNode } from "../types";
import { isUserTurn, mainlineChild } from "./tree";

// ---------- RNG ----------

/** mulberry32: tiny, fast, seedable PRNG. Deterministic for a given seed, so tests and
 *  retries can reproduce exact sequences. The UI seeds from Date.now(). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sampleWeighted<T>(
  items: T[],
  weightOf: (item: T) => number,
  rng: () => number
): T | undefined {
  if (items.length === 0) return undefined;
  const weights = items.map((it) => {
    const w = weightOf(it);
    return w > 0 ? w : DEFAULT_WEIGHT;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

const DEFAULT_WEIGHT = 0.01;

/** DESIGN §5: a FIRST attempt slower than this counts as "hesitated" and scales the
 *  card's interval growth by 0.75 (src/lib/srs.ts's gradeCard). practice.ts itself has
 *  no wall-clock/DOM access, so the actual timing lives in src/screens/Practice.tsx
 *  (from when a fresh pending move appears to the first attempt at it) — this constant
 *  is exported from here per DESIGN §6 M5 so it has one home next to the rest of the
 *  session-tuning constants, and so a future test can import it instead of duplicating
 *  the number. Hesitation on a *retry* run (DESIGN §4.1.5/§7) is never measured — those
 *  moves don't feed scheduling anyway. */
export const HESITATION_MS = 10_000;

// ---------- Session config ----------

export type MixMode = "theory" | "mix" | "mistakes";

export interface SessionConfig {
  openingIds: string[];
  mix: MixMode;
  /** Optional low-mastery interleaving bias (DESIGN §4.2): multiplies each opponent
   *  candidate child's sampling weight before it's normalized. Optional — and only
   *  ever read here, never required — so existing callers/tests that never set it see
   *  identical behavior (multiplier 1 everywhere). src/screens/Practice.tsx derives
   *  one from src/lib/srs.ts's subtreeMastery + dueSubtreeSet; the engine itself has
   *  no SRS/mastery knowledge. */
  biasFn?: (tree: OpeningTree, node: RepertoireNode) => number;
}

/** Fraction of opponent-move samples that should come from the mistake pool, when both
 *  a theory pool and a mistake pool exist at a node. */
function mistakeRatio(mix: MixMode): number {
  switch (mix) {
    case "theory":
      return 0;
    case "mistakes":
      return 1;
    case "mix":
      return 0.2;
  }
}

/**
 * Sample the opponent's reply at an opponent-to-move node: decide theory-vs-mistake by
 * the configured mix ratio (falling back to whichever pool actually exists when the
 * other is empty at this node), then sample within that pool proportional to `weight`
 * (default 0.01 when missing). Sideline children are never sampled — the opponent only
 * ever plays a theory move or a curated mistake (DESIGN §4.2).
 */
function sampleOpponentChild(
  tree: OpeningTree,
  node: RepertoireNode,
  config: SessionConfig,
  rng: () => number
): RepertoireNode | undefined {
  const children = node.children
    .map((id) => tree.nodes[id])
    .filter((n): n is RepertoireNode => !!n && n.moveKind !== "sideline");
  const theoryChildren = children.filter((n) => n.moveKind === "mainline");
  const mistakeChildren = children.filter((n) => n.moveKind === "opponent_mistake");

  let pool: RepertoireNode[];
  if (theoryChildren.length === 0 && mistakeChildren.length === 0) return undefined;
  if (theoryChildren.length === 0) pool = mistakeChildren;
  else if (mistakeChildren.length === 0) pool = theoryChildren;
  else pool = rng() < mistakeRatio(config.mix) ? mistakeChildren : theoryChildren;

  return sampleWeighted(
    pool,
    (n) => (n.weight ?? DEFAULT_WEIGHT) * (config.biasFn ? config.biasFn(tree, n) : 1),
    rng
  );
}

// ---------- Line generation ----------

/** A fully pinned root→end sequence of node ids. Opponent choices are frozen at
 *  generation time; a retry replays exactly this (DESIGN §4.1.5). */
export interface PracticeLine {
  openingId: string;
  nodeIds: string[];
}

/**
 * Walk from the tree's root, following `mainlineChild` at user-to-move nodes and
 * sampling at opponent-to-move nodes, stopping at a node with `endOfTheory` or with no
 * eligible continuation.
 */
export function generateLine(
  tree: OpeningTree,
  config: SessionConfig,
  rng: () => number
): PracticeLine {
  const nodeIds: string[] = [tree.rootId];
  let current: RepertoireNode | undefined = tree.nodes[tree.rootId];
  while (current && !current.endOfTheory) {
    const next: RepertoireNode | undefined = isUserTurn(tree, current)
      ? mainlineChild(tree, current)
      : sampleOpponentChild(tree, current, config, rng);
    if (!next) break;
    nodeIds.push(next.id);
    current = next;
  }
  return { openingId: tree.id, nodeIds };
}

// ---------- Line-relative helpers ----------

/** The node at a given position in the line (idx 0 = root). */
export function nodeAt(tree: OpeningTree, line: PracticeLine, idx: number): RepertoireNode {
  return tree.nodes[line.nodeIds[idx]];
}

/** True once there is no move left to play after `idx` (the line has run out). */
export function isLineComplete(line: PracticeLine, idx: number): boolean {
  return idx >= line.nodeIds.length - 1;
}

/** Whose move is next (undefined if the line is already complete at `idx`). */
export function nextMover(
  tree: OpeningTree,
  line: PracticeLine,
  idx: number
): Mover | undefined {
  const nextId = line.nodeIds[idx + 1];
  return nextId ? tree.nodes[nextId].mover : undefined;
}

/** The node the trainee (or opponent) is expected to reach next, if any. */
export function expectedMove(
  tree: OpeningTree,
  line: PracticeLine,
  idx: number
): RepertoireNode | undefined {
  const nextId = line.nodeIds[idx + 1];
  return nextId ? tree.nodes[nextId] : undefined;
}

/** SAN of every move played so far in this line, root exclusive, up to and including `idx`. */
export function playedSoFarSans(tree: OpeningTree, line: PracticeLine, idx: number): string[] {
  return line.nodeIds.slice(1, idx + 1).map((id) => tree.nodes[id].san);
}

/**
 * Best-effort "theory" continuation walk from a node, independent of any particular
 * pinned line: `mainlineChild` at user-to-move positions, the heaviest-weighted theory
 * (never a mistake) child at opponent-to-move positions. Used to build the feedback
 * panel's "play continues …" preview, and as a general-purpose preview helper.
 */
export function previewSansAfterNode(
  tree: OpeningTree,
  nodeId: string,
  n = 5
): string[] {
  const sans: string[] = [];
  let node: RepertoireNode | undefined = tree.nodes[nodeId];
  while (node && sans.length < n) {
    let next: RepertoireNode | undefined;
    if (isUserTurn(tree, node)) {
      next = mainlineChild(tree, node);
    } else {
      const children = node.children
        .map((id) => tree.nodes[id])
        .filter((c): c is RepertoireNode => !!c && c.moveKind !== "sideline");
      const theory = children.filter((c) => c.moveKind === "mainline");
      const pool = theory.length > 0 ? theory : children;
      next = pool.reduce<RepertoireNode | undefined>((best, c) => {
        if (!best) return c;
        return (c.weight ?? DEFAULT_WEIGHT) > (best.weight ?? DEFAULT_WEIGHT) ? c : best;
      }, undefined);
    }
    if (!next) break;
    sans.push(next.san);
    node = next;
  }
  return sans;
}

// ---------- Deviation feedback ----------

export interface DeviationFeedback {
  attemptedSan: string;
  correctSan: string;
  explanation: string;
  previewSans: string[];
  /** expected.evalCp - attemptedChild.evalCp, in centipawns; null if either eval is
   *  unavailable or the attempted move isn't a known tree child. */
  evalDeltaCp: number | null;
}

/**
 * Build the feedback panel payload for a wrong attempt (DESIGN §4.1.3.2): what was
 * played, what the correct move was, why, a short preview of what follows, and — when
 * the attempted move happens to also be a tree child with a cached eval — how much it
 * cost.
 */
export function buildDeviationFeedback(
  tree: OpeningTree,
  expected: RepertoireNode,
  attemptedSan: string
): DeviationFeedback {
  const explanation =
    expected.annotation?.explanation ?? `**${expected.san}** is the repertoire move here.`;
  const previewSans = previewSansAfterNode(tree, expected.id, 5);

  let evalDeltaCp: number | null = null;
  if (typeof expected.evalCp === "number" && expected.parentId) {
    const parent = tree.nodes[expected.parentId];
    const attemptedChild = parent?.children
      .map((cid) => tree.nodes[cid])
      .find((n) => n && n.san === attemptedSan);
    if (attemptedChild && typeof attemptedChild.evalCp === "number") {
      evalDeltaCp = expected.evalCp - attemptedChild.evalCp;
    }
  }

  return { attemptedSan, correctSan: expected.san, explanation, previewSans, evalDeltaCp };
}

/** "+1.8" / "-0.4" / "0.0" style pawns formatting for a centipawn eval. */
export function formatEvalPawns(evalCp: number): string {
  const pawns = evalCp / 100;
  const sign = pawns > 0 ? "+" : "";
  return `${sign}${pawns.toFixed(1)}`;
}

// ---------- Per-line attempt tracking ----------

export interface MoveResult {
  nodeId: string;
  /** Correct on the very first attempt at this node in this run. */
  firstTry: boolean;
  /** Total attempts (wrong + the final correct one) at this node in this run. */
  attempts: number;
}

/**
 * Emitted whenever a user move resolves correctly (DESIGN §4.1.5, §7: "only first
 * attempts feed SRS scheduling"). `isFirstRun` says whether this happened on a line's
 * first run (runIndex 0) — the SRS consumer (src/screens/Practice.tsx) grades the
 * card on a first run and just touches it (bumps attempts/lastSeen, no schedule
 * change) on a replay.
 */
export interface GradingEvent {
  /** `${openingId}:${nodeId}` — matches SrsCard.key in src/types.ts. */
  key: string;
  openingId: string;
  nodeId: string;
  firstTry: boolean;
  isFirstRun: boolean;
}

export interface LineRun {
  line: PracticeLine;
  /** Position reached so far: line.nodeIds[idx] is the last move actually played. */
  idx: number;
  results: MoveResult[];
  /** No mistakes and no reveals so far this run. */
  clean: boolean;
  /** Wrong attempts already made at the currently-pending user move (0 = none yet). */
  wrongAttemptsAtCurrent: number;
  /** 0 = this line's first run; replayLine increments it (DESIGN §4.1.5/§7). */
  runIndex: number;
}

export function createLineRun(line: PracticeLine, runIndex = 0): LineRun {
  return { line, idx: 0, results: [], clean: true, wrongAttemptsAtCurrent: 0, runIndex };
}

export type AttemptOutcome =
  | { kind: "correct"; gradingEvent: GradingEvent }
  | { kind: "wrong"; feedback: DeviationFeedback }
  | { kind: "no-pending-move" };

/** Lichess "king takes rook" castling UCI -> chess.js canonical king-destination UCI.
 *  Some shipped/cached content (esp. stale copies on installed phones) stores castling
 *  moves this way; the board (chess.js) only ever produces the canonical form. Keyed by
 *  the Lichess encoding so a lookup miss just means "not one of the four castling
 *  squares" — the caller still has to confirm via `san` before trusting a hit. */
const CASTLING_UCI_LICHESS_TO_CANONICAL: Record<string, string> = {
  e1h1: "e1g1", // White kingside
  e1a1: "e1c1", // White queenside
  e8h8: "e8g8", // Black kingside
  e8a8: "e8c8", // Black queenside
};

/**
 * Normalize a possibly-Lichess-encoded castling `uci` to chess.js canonical form, but
 * ONLY when `san` confirms the move actually IS a castle ("O-O" or "O-O-O") — an
 * "e1h1" uci on a non-castling san (e.g. a rook move to h1) must never be rewritten.
 * Returns `uci` unchanged in every other case.
 */
function normalizeCastlingUci(uci: string, san: string): string {
  if (!san.startsWith("O-O")) return uci;
  return CASTLING_UCI_LICHESS_TO_CANONICAL[uci] ?? uci;
}

/**
 * The trainee attempts a move. `attemptedUci` is compared against the expected node's
 * `uci` (the dests offered to the board are ALL legal moves, not just tree moves — the
 * user must be able to play a wrong move). On a match the run advances; on a mismatch
 * the run is marked dirty and stays put — the same pending move must be played again
 * (DESIGN §4.1.3.2: no skip button, the board stays live).
 *
 * Castling robustness: the board (chess.js) always submits the canonical uci
 * ("e1g1"), but some cached/stale content stores castling moves in Lichess's "king
 * takes rook" form ("e1h1" etc. — see normalizeCastlingUci). A match also succeeds
 * when the expected node's uci normalizes to the attempted one, so a stale cache never
 * strands the user on a castle they in fact played correctly.
 */
export function attemptUserMove(
  tree: OpeningTree,
  run: LineRun,
  attemptedUci: string,
  attemptedSan: string
): { run: LineRun; outcome: AttemptOutcome } {
  const expected = expectedMove(tree, run.line, run.idx);
  if (!expected || expected.mover !== "user") {
    return { run, outcome: { kind: "no-pending-move" } };
  }

  const expectedUciNormalized = normalizeCastlingUci(expected.uci, expected.san);
  if (attemptedUci === expected.uci || attemptedUci === expectedUciNormalized) {
    const result: MoveResult = {
      nodeId: expected.id,
      firstTry: run.wrongAttemptsAtCurrent === 0,
      attempts: run.wrongAttemptsAtCurrent + 1,
    };
    const nextRun: LineRun = {
      ...run,
      idx: run.idx + 1,
      results: [...run.results, result],
      wrongAttemptsAtCurrent: 0,
    };
    const gradingEvent: GradingEvent = {
      key: `${tree.id}:${expected.id}`,
      openingId: tree.id,
      nodeId: expected.id,
      firstTry: result.firstTry,
      isFirstRun: run.runIndex === 0,
    };
    return { run: nextRun, outcome: { kind: "correct", gradingEvent } };
  }

  const feedback = buildDeviationFeedback(tree, expected, attemptedSan);
  const nextRun: LineRun = {
    ...run,
    clean: false,
    wrongAttemptsAtCurrent: run.wrongAttemptsAtCurrent + 1,
  };
  return { run: nextRun, outcome: { kind: "wrong", feedback } };
}

/** Advance past a forced opponent move (no attempt to check — the opponent's move for
 *  this run was pinned at line-generation time). No-op if it isn't the opponent's turn. */
export function playOpponentMove(tree: OpeningTree, run: LineRun): LineRun {
  const expected = expectedMove(tree, run.line, run.idx);
  if (!expected || expected.mover !== "opponent") return run;
  return { ...run, idx: run.idx + 1 };
}

/**
 * In-drill analysis mode's "counts as a hint" rule: entering analysis while a user
 * move is pending and not yet failed marks the run dirty — same consequence as a
 * wrong attempt (the line will replay) — WITHOUT recording a phantom wrong attempt.
 * `results` and `wrongAttemptsAtCurrent` are left untouched on purpose: stats must
 * only ever reflect moves the trainee actually attempted on the board. Callers decide
 * *whether* this penalty applies (only for the pending-and-unfailed case, per DESIGN);
 * this function itself is unconditional once called.
 */
export function markHintUsed(run: LineRun): LineRun {
  return { ...run, clean: false };
}

// ---------- Session ----------

export interface SessionStats {
  linesCompleted: number;
  cleanPasses: number;
  userMovesTotal: number;
  userMovesFirstTryCorrect: number;
}

export interface OpeningStats {
  linesCompleted: number;
  cleanPasses: number;
}

export interface SessionState {
  trees: Record<string, OpeningTree>;
  config: SessionConfig;
  rng: () => number;
  /** Remaining opening ids in the current round-robin cycle (already shuffled). */
  queue: string[];
  run: LineRun;
  stats: SessionStats;
  perOpening: Record<string, OpeningStats>;
}

function freshPerOpeningStats(openingIds: string[]): Record<string, OpeningStats> {
  const out: Record<string, OpeningStats> = {};
  for (const id of openingIds) out[id] = { linesCompleted: 0, cleanPasses: 0 };
  return out;
}

/**
 * Start a session: openingIds appear once per cycle, in random order (DESIGN §4.1/§4.2).
 * Requires at least one opening with a loaded tree.
 */
export function createSession(
  trees: Record<string, OpeningTree>,
  openingIds: string[],
  mix: MixMode,
  rng: () => number,
  biasFn?: (tree: OpeningTree, node: RepertoireNode) => number
): SessionState {
  if (openingIds.length === 0) {
    throw new Error("createSession requires at least one opening");
  }
  const config: SessionConfig = { openingIds, mix, ...(biasFn ? { biasFn } : {}) };
  const queue = shuffle(openingIds, rng);
  const firstId = queue.shift()!;
  const line = generateLine(trees[firstId], config, rng);
  return {
    trees,
    config,
    rng,
    queue,
    run: createLineRun(line),
    stats: { linesCompleted: 0, cleanPasses: 0, userMovesTotal: 0, userMovesFirstTryCorrect: 0 },
    perOpening: freshPerOpeningStats(openingIds),
  };
}

function currentTree(state: SessionState): OpeningTree {
  return state.trees[state.run.line.openingId];
}

/** Submit a trainee move attempt against the pending user move. Wraps attemptUserMove,
 *  additionally folding a correct result into the session-wide accuracy counters. */
export function submitMove(
  state: SessionState,
  attemptedUci: string,
  attemptedSan: string
): { state: SessionState; outcome: AttemptOutcome } {
  const { run, outcome } = attemptUserMove(currentTree(state), state.run, attemptedUci, attemptedSan);
  let stats = state.stats;
  if (outcome.kind === "correct") {
    const result = run.results[run.results.length - 1];
    stats = {
      ...stats,
      userMovesTotal: stats.userMovesTotal + 1,
      userMovesFirstTryCorrect: stats.userMovesFirstTryCorrect + (result.firstTry ? 1 : 0),
    };
  }
  return { state: { ...state, run, stats }, outcome };
}

/** Advance past the opponent's pinned reply (see playOpponentMove). */
export function advanceOpponentMove(state: SessionState): SessionState {
  return { ...state, run: playOpponentMove(currentTree(state), state.run) };
}

function pullNextOpeningId(state: SessionState): { id: string; queue: string[] } {
  const queue = state.queue.length > 0 ? state.queue : shuffle(state.config.openingIds, state.rng);
  return { id: queue[0], queue: queue.slice(1) };
}

function advanceToNextLine(state: SessionState, opts: { clean: boolean }): SessionState {
  const openingId = state.run.line.openingId;
  const prevOpeningStats = state.perOpening[openingId] ?? { linesCompleted: 0, cleanPasses: 0 };
  const perOpening = {
    ...state.perOpening,
    [openingId]: {
      linesCompleted: prevOpeningStats.linesCompleted + 1,
      cleanPasses: prevOpeningStats.cleanPasses + (opts.clean ? 1 : 0),
    },
  };
  const stats: SessionStats = {
    ...state.stats,
    linesCompleted: state.stats.linesCompleted + 1,
    cleanPasses: state.stats.cleanPasses + (opts.clean ? 1 : 0),
  };
  const { id, queue } = pullNextOpeningId(state);
  const line = generateLine(state.trees[id], state.config, state.rng);
  return { ...state, queue, run: createLineRun(line), stats, perOpening };
}

/** "Next line" — only valid once the line is complete AND clean (DESIGN §4.1.5: only a
 *  clean pass advances the session). */
export function nextLine(state: SessionState): SessionState {
  if (!isLineComplete(state.run.line, state.run.idx)) {
    throw new Error("cannot advance: the current line hasn't finished");
  }
  if (!state.run.clean) {
    throw new Error("cannot advance on a dirty run: replay or skip it first");
  }
  return advanceToNextLine(state, { clean: true });
}

/** Replay-until-clean: same pinned line, fresh run (DESIGN §4.1.5), one run deeper
 *  (runIndex + 1) so grading events on this pass are marked as a replay, not a
 *  first-run first attempt (DESIGN §7). */
export function replayLine(state: SessionState): SessionState {
  return { ...state, run: createLineRun(state.run.line, state.run.runIndex + 1) };
}

/** The buried escape hatch: mark the current line failed and move on regardless of
 *  whether it's complete or clean (DESIGN §4.1.5). */
export function skipLine(state: SessionState): SessionState {
  return advanceToNextLine(state, { clean: false });
}

export function accuracy(stats: SessionStats): number {
  return stats.userMovesTotal === 0 ? 0 : stats.userMovesFirstTryCorrect / stats.userMovesTotal;
}

export interface OpeningSummary extends OpeningStats {
  openingId: string;
}

export interface SessionSummary {
  stats: SessionStats;
  accuracy: number;
  perOpening: OpeningSummary[];
}

export function sessionSummary(state: SessionState): SessionSummary {
  return {
    stats: state.stats,
    accuracy: accuracy(state.stats),
    perOpening: Object.entries(state.perOpening).map(([openingId, s]) => ({
      openingId,
      ...s,
    })),
  };
}
