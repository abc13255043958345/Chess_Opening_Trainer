// Spaced repetition (SM-2 variant) + mastery math (DESIGN.md §5, §7, §6 M3).
// PURE LOGIC — no React, no DOM, no IO — mirroring src/lib/practice.ts, so this is
// unit-testable head-on (see scripts/srs-test.mjs) and src/lib/srsStore.ts can drive
// it as plain functions over data it loads/saves.
//
// ---------- Constants (ours to choose — DESIGN §5/§7 only requires the
// monotonicity/decay/lapse properties documented on gradeCard/nodeScore below, not
// these exact numbers) ----------
//   - easeFactor starts at 2.5, +0.05 per smooth (non-hesitated, first-try) success,
//     -0.2 per lapse, floored at 1.3 (the classic SM-2 floor), soft-capped at 3.5.
//   - Interval schedule: 1st-ever success → 1 day, 2nd → 3 days, 3rd+ → previous
//     interval × the just-updated easeFactor.
//   - Hesitation (the DESIGN §5 signal — wired in M5; callers pass `hesitated: false`
//     until then) scales the *growth* of the interval (newInterval − prevInterval) by
//     0.75 rather than the whole interval, so even a hesitant first success still
//     schedules meaningfully forward instead of collapsing toward 0.
//   - A lapse (firstTry: false) resets correctStreak to 0 and the interval to 1 day
//     (due tomorrow — "due immediately" would be indistinguishable from just marking
//     it done, so tomorrow is the practical floor), and increments lapses.

import type { OpeningTree, RepertoireNode, SrsCard } from "../types";
import { getNode, isUserTurn, nodeDepth, numberedSan } from "./tree";

const STARTING_EASE = 2.5;
const EASE_SUCCESS_DELTA = 0.05;
const EASE_LAPSE_DELTA = 0.2;
const EASE_FLOOR = 1.3;
const EASE_CEILING = 3.5;
const HESITATION_GROWTH_SCALE = 0.75;
const LAPSE_INTERVAL_DAYS = 1;
const MS_PER_DAY = 86_400_000;

function clampEase(v: number): number {
  return Math.min(EASE_CEILING, Math.max(EASE_FLOOR, v));
}

// ---------- Grading ----------

export interface GradeOptions {
  /** Was the *first* attempt at this node in this run correct (no lapse)? */
  firstTry: boolean;
  /** Hesitation signal (>10s per DESIGN §5); wired in M5. Callers pass `false` now. */
  hesitated?: boolean;
  now: Date;
  key: string;
  openingId: string;
  nodeId: string;
}

/**
 * SM-2-style scheduling update for one card (DESIGN §5, §7). `prev` is null on a
 * node's first-ever grading. Always called on a *resolved* user move — practice mode
 * forces the correct move to eventually be played — so `firstTry` (not "was this
 * attempt correct") is what actually distinguishes a smooth success from a lapse.
 *
 * Monotonicity: for a fixed `hesitated`, each successive smooth success strictly
 * grows the interval (prevInterval + positive growth, since easeFactor ≥ 1.3 > 1
 * makes prevInterval × easeFactor > prevInterval once correctStreak ≥ 3, and the
 * streak-1/streak-2 steps 1 and 3 are themselves increasing). A lapse always drops
 * the interval back to LAPSE_INTERVAL_DAYS and correctStreak to 0.
 */
export function gradeCard(prev: SrsCard | null, opts: GradeOptions): SrsCard {
  const { firstTry, hesitated = false, now, key, openingId, nodeId } = opts;
  const attempts = (prev?.attempts ?? 0) + 1;
  const lastSeen = now.toISOString();

  if (!firstTry) {
    const easeFactor = clampEase((prev?.easeFactor ?? STARTING_EASE) - EASE_LAPSE_DELTA);
    const intervalDays = LAPSE_INTERVAL_DAYS;
    const dueDate = new Date(now.getTime() + intervalDays * MS_PER_DAY).toISOString();
    return {
      key,
      openingId,
      nodeId,
      easeFactor,
      intervalDays,
      dueDate,
      lapses: (prev?.lapses ?? 0) + 1,
      attempts,
      correctStreak: 0,
      lastSeen,
    };
  }

  const correctStreak = (prev?.correctStreak ?? 0) + 1;
  const easeFactor = clampEase((prev?.easeFactor ?? STARTING_EASE) + EASE_SUCCESS_DELTA);
  const prevInterval = prev?.intervalDays ?? 0;
  const rawInterval =
    correctStreak === 1 ? 1 : correctStreak === 2 ? 3 : prevInterval * easeFactor;
  const growth = rawInterval - prevInterval;
  const scaledGrowth = hesitated ? growth * HESITATION_GROWTH_SCALE : growth;
  const intervalDays = prevInterval + scaledGrowth;
  const dueDate = new Date(now.getTime() + intervalDays * MS_PER_DAY).toISOString();

  return {
    key,
    openingId,
    nodeId,
    easeFactor,
    intervalDays,
    dueDate,
    lapses: prev?.lapses ?? 0,
    attempts,
    correctStreak,
    lastSeen,
  };
}

/**
 * Bump attempts/lastSeen without touching the schedule — replay runs (DESIGN §4.1.5,
 * §7: only the first run's first attempts feed scheduling). If `prev` is null (a node
 * touched before it was ever graded — shouldn't normally happen, since a node reached
 * on replay was necessarily graded on the run before) this creates an unscheduled
 * card due immediately, so the attempt isn't silently dropped.
 */
export function touchCard(
  prev: SrsCard | null,
  opts: { now: Date; key: string; openingId: string; nodeId: string }
): SrsCard {
  const { now, key, openingId, nodeId } = opts;
  if (!prev) {
    return {
      key,
      openingId,
      nodeId,
      easeFactor: STARTING_EASE,
      intervalDays: 0,
      dueDate: now.toISOString(),
      lapses: 0,
      attempts: 1,
      correctStreak: 0,
      lastSeen: now.toISOString(),
    };
  }
  return { ...prev, attempts: prev.attempts + 1, lastSeen: now.toISOString() };
}

/**
 * Node score ∈ [0,1] = retrievability × accuracy. Never-seen (`card` undefined) is 0.
 *  - retrievability = exp(-daysSinceLastSeen / max(intervalDays, 0.5)): an exponential
 *    forgetting curve scaled to the card's own interval, so a card exactly at its due
 *    date (daysSinceLastSeen == intervalDays) sits at e⁻¹ ≈ 0.37. Strictly decreasing
 *    in daysSinceLastSeen for fixed intervalDays — "decays with time since review".
 *  - accuracy = correctStreak / (correctStreak + lapses + 1): strictly increasing in
 *    correctStreak, strictly decreasing in lapses, and exactly 0 right after a lapse
 *    (streak resets to 0) — "monotonic in streak" and makes a lapse visibly cut the
 *    score, not just the schedule.
 */
export function nodeScore(card: SrsCard | undefined, now: Date): number {
  if (!card) return 0;
  const daysSince = Math.max(
    0,
    (now.getTime() - new Date(card.lastSeen).getTime()) / MS_PER_DAY
  );
  const effectiveInterval = Math.max(card.intervalDays, 0.5);
  const retrievability = Math.exp(-daysSince / effectiveInterval);
  const accuracy = card.correctStreak / (card.correctStreak + card.lapses + 1);
  return retrievability * accuracy;
}

// ---------- Mastery bands ----------

export type MasteryBand = "learning" | "familiar" | "solid" | "mastered";

export function masteryBand(score0to100: number): MasteryBand {
  if (score0to100 >= 90) return "mastered";
  if (score0to100 >= 70) return "solid";
  if (score0to100 >= 40) return "familiar";
  return "learning";
}

/** CSS var() string for a band, matching src/index.css's palette. */
export function bandColor(band: MasteryBand): string {
  switch (band) {
    case "learning":
      return "var(--red)";
    case "familiar":
      return "var(--amber)";
    case "solid":
      return "var(--accent)";
    case "mastered":
      return "var(--green)";
  }
}

// ---------- Subtree / opening mastery ----------

const DEPTH_DECAY = 0.97;

function eligibleChildren(tree: OpeningTree, node: RepertoireNode): RepertoireNode[] {
  return node.children
    .map((id) => tree.nodes[id])
    .filter((n): n is RepertoireNode => !!n && n.moveKind !== "sideline");
}

/**
 * Weighted mean nodeScore (0–100) over every user-move node in the subtree rooted at
 * `nodeId`. Weight = pathProbability × depthDecay:
 *  - pathProbability: the product, from the subtree root down to a node, of each
 *    opponent-move edge's share (its `weight`, or a uniform 1/n share when unset) —
 *    a user-move edge is deterministic (the one mainline child) and never dilutes
 *    probability. This is DESIGN §5's "opening mastery = popularity-weighted
 *    branches": call this at `tree.rootId` for the whole opening, or at any node for
 *    that branch alone.
 *  - depthDecay = 0.97^depth, depth measured from `nodeId` (0 at the subtree root):
 *    DESIGN §5's "branch mastery = depth-weighted" — a weak node 14 plies deep counts
 *    for less than an equally weak node 2 plies deep.
 * Returns 0 for a subtree with no user-move nodes (guards the empty-weight divide).
 */
export function subtreeMastery(
  tree: OpeningTree,
  nodeId: string,
  cards: Map<string, SrsCard>,
  now: Date
): number {
  let scoreWeightSum = 0;
  let weightSum = 0;

  function walk(node: RepertoireNode, pathProbability: number, depth: number): void {
    if (node.mover === "user" && node.san !== "") {
      const key = `${tree.id}:${node.id}`;
      const weight = pathProbability * Math.pow(DEPTH_DECAY, depth);
      scoreWeightSum += nodeScore(cards.get(key), now) * weight;
      weightSum += weight;
    }

    const children = eligibleChildren(tree, node);
    if (children.length === 0) return;

    if (isUserTurn(tree, node)) {
      // Deterministic: only the single mainline child is ever actually played.
      for (const child of children) {
        if (child.moveKind === "mainline") walk(child, pathProbability, depth + 1);
      }
    } else {
      const rawWeights = children.map((c) => c.weight ?? 1 / children.length);
      const total = rawWeights.reduce((a, b) => a + b, 0) || 1;
      children.forEach((child, i) => {
        walk(child, pathProbability * (rawWeights[i] / total), depth + 1);
      });
    }
  }

  walk(getNode(tree, nodeId), 1, 0);
  if (weightSum === 0) return 0;
  return (scoreWeightSum / weightSum) * 100;
}

/** Count of due user-move cards within the subtree rooted at `nodeId` (used by the
 *  branch heat-map view to show "N due" per branch). */
export function dueCountInSubtree(
  tree: OpeningTree,
  nodeId: string,
  cards: Map<string, SrsCard>,
  now: Date
): number {
  let count = 0;
  const stack = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = tree.nodes[id];
    if (!node) continue;
    if (node.mover === "user" && node.san !== "") {
      const card = cards.get(`${tree.id}:${node.id}`);
      if (card && new Date(card.dueDate).getTime() <= now.getTime()) count += 1;
    }
    stack.push(...node.children);
  }
  return count;
}

// ---------- Due cards ----------

export interface DueSummary {
  due: SrsCard[];
  perOpeningDueCount: Record<string, number>;
}

/** Cards due (dueDate <= now), optionally restricted to `openingIds`. */
export function dueCards(
  cards: Map<string, SrsCard>,
  openingIds: string[] | undefined,
  now: Date
): DueSummary {
  const allow = openingIds ? new Set(openingIds) : undefined;
  const due: SrsCard[] = [];
  const perOpeningDueCount: Record<string, number> = {};
  for (const card of cards.values()) {
    if (allow && !allow.has(card.openingId)) continue;
    if (new Date(card.dueDate).getTime() > now.getTime()) continue;
    due.push(card);
    perOpeningDueCount[card.openingId] = (perOpeningDueCount[card.openingId] ?? 0) + 1;
  }
  return { due, perOpeningDueCount };
}

/**
 * The closure of node ids that are themselves due or have a due descendant — every
 * ancestor (inclusive) of every node id in `dueNodeIds`. Used to bias practice line
 * generation toward branches that actually contain something due (DESIGN §4.2).
 */
export function dueSubtreeSet(tree: OpeningTree, dueNodeIds: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const nodeId of dueNodeIds) {
    let cur: RepertoireNode | undefined = tree.nodes[nodeId];
    while (cur && !result.has(cur.id)) {
      result.add(cur.id);
      cur = cur.parentId != null ? tree.nodes[cur.parentId] : undefined;
    }
  }
  return result;
}

// ---------- Weakest branches (DESIGN §6 M5: Home's "weakest lines" section) ----------

export interface WeakBranchRow {
  openingId: string;
  branchNodeId: string;
  /** The branch's own numbered SAN, e.g. "3...Nd4" (DESIGN §6 M5's row label). */
  sanLabel: string;
  mastery: number;
}

/** True if any user-move node in the subtree rooted at `nodeId` has ever been graded
 *  — i.e. this branch has actually been drilled, not just generated by the content
 *  pipeline. Traversal shape mirrors dueCountInSubtree above. */
function subtreeEverPracticed(
  tree: OpeningTree,
  nodeId: string,
  cards: Map<string, SrsCard>
): boolean {
  const stack = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = tree.nodes[id];
    if (!node) continue;
    if (node.mover === "user" && node.san !== "" && cards.has(`${tree.id}:${node.id}`)) {
      return true;
    }
    stack.push(...node.children);
  }
  return false;
}

/**
 * The `limit` lowest-mastery branches across `trees` that have actually been
 * practiced (DESIGN §6 M5). A "branch" is a child of a branch point — an
 * opponent-to-move node with ≥2 eligible (non-sideline) children — at depth
 * ≤ `maxDepthPly` half-moves from the root; never-practiced branches are excluded
 * (every subtree would otherwise show mastery 0, drowning out genuinely weak ones).
 * Pure/synchronous — the caller (src/screens/Home.tsx) computes this once per mount
 * from trees/cards it already loaded for the dashboard, same as subtreeMastery.
 */
export function weakestPracticedBranches(
  trees: Record<string, OpeningTree>,
  cards: Map<string, SrsCard>,
  now: Date,
  opts: { maxDepthPly?: number; limit?: number } = {}
): WeakBranchRow[] {
  const maxDepthPly = opts.maxDepthPly ?? 6;
  const limit = opts.limit ?? 5;
  const rows: WeakBranchRow[] = [];

  for (const tree of Object.values(trees)) {
    for (const node of Object.values(tree.nodes)) {
      // "Opponent node" means opponent-TO-MOVE (the position where the branch
      // actually happens) — i.e. NOT the user's turn at this node — which is not the
      // same thing as node.mover (who played the move that produced this node; the
      // two are only equal by coincidence for a root with a black perspective).
      if (isUserTurn(tree, node)) continue;
      if (nodeDepth(tree, node.id) > maxDepthPly) continue;
      const children = eligibleChildren(tree, node);
      if (children.length < 2) continue;
      for (const child of children) {
        if (!subtreeEverPracticed(tree, child.id, cards)) continue;
        rows.push({
          openingId: tree.id,
          branchNodeId: child.id,
          sanLabel: numberedSan([child.san], nodeDepth(tree, child.id) - 1),
          mastery: subtreeMastery(tree, child.id, cards, now),
        });
      }
    }
  }

  return rows.sort((a, b) => a.mastery - b.mastery).slice(0, limit);
}
