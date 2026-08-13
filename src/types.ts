// Core data model for the chess opening trainer.
// This file is the single source of truth for shared types (see DESIGN.md §2).

export type Color = "white" | "black";
export type Mover = "user" | "opponent";
export type MoveKind = "mainline" | "sideline" | "opponent_mistake";

export interface NodeAnnotation {
  /** Why this move / why the alternative fails. */
  explanation: string;
  /** Typical middlegame ideas from here. */
  plans?: string;
}

export interface EndOfTheory {
  /** "winning" = clearly winning; "clear_plan" = theory done, play chess. */
  reason: "winning" | "clear_plan";
  /** Cached engine eval in centipawns (white-positive) at line end. */
  evalCp?: number;
}

/**
 * A node represents the position reached after `san`/`uci` was played.
 * The root node of a tree is synthetic: san/uci are "", parentId is null,
 * mover is "opponent" (so the first child is interpreted correctly),
 * moveKind is "mainline".
 */
export interface RepertoireNode {
  /** Stable id: hash of the UCI move path from the root ("root" for the root). */
  id: string;
  /** Position after this move (full FEN). */
  fen: string;
  /** Move that led here in SAN, e.g. "Nf3". "" for root. */
  san: string;
  /** Move that led here in UCI, e.g. "g1f3". "" for root. */
  uci: string;
  parentId: string | null;
  /** Ids of continuations. */
  children: string[];
  /** Whose move produced this node, relative to the trainee. */
  mover: Mover;
  moveKind: MoveKind;
  /** For opponent_mistake nodes the children are the punish line. */
  annotation?: NodeAnnotation;
  endOfTheory?: EndOfTheory;
  /** Popularity weight for opponent move selection (games share, 0..1). */
  weight?: number;
  /** Cached engine eval in centipawns, white-positive. */
  evalCp?: number;
}

export interface OpeningTree {
  /** Catalog id, e.g. "c50-italian-game". */
  id: string;
  eco: string;
  name: string;
  /** The trainee's color for this tree. */
  perspective: Color;
  rootId: string;
  nodes: Record<string, RepertoireNode>;
}

/** One lazily-loaded content file per ECO letter (A–E). */
export interface ContentSection {
  eco: string; // "A".."E"
  generatedAt: string; // ISO timestamp
  trees: Record<string, OpeningTree>;
}

export interface CatalogEntry {
  id: string;
  eco: string;
  name: string;
  perspective: Color;
  /** SAN of the defining line, e.g. "1. e4 e5 2. Nf3 Nc6 3. Bc4". */
  line: string;
  /** Length of the defining line in half-moves. */
  ply: number;
  /** Total nodes in the generated tree. */
  nodeCount: number;
  /** Number of user-move nodes (future SRS cards). */
  userMoveCount: number;
  /** Number of opponent_mistake branches in the tree. */
  mistakeCount: number;
  /** Content file that holds the tree, e.g. "content/eco-C.json". */
  file: string;
}

export interface Catalog {
  version: number;
  generatedAt: string;
  /** Per-section content timestamps (ECO letter → generatedAt ISO), used by the
   *  app to refresh its cached copy of a section when the pipeline regenerated it. */
  sections?: Record<string, string>;
  entries: CatalogEntry[];
}

// ---------- User data (IndexedDB) ----------

/** An opening the user has toggled into their active training set. */
export interface TrainingSetItem {
  openingId: string;
  addedAt: string; // ISO
}

/**
 * Copy-on-write user customization of a shipped tree (or a from-scratch tree).
 * When present, it fully replaces the shipped tree with the same openingId.
 */
export interface UserTreeRecord {
  openingId: string;
  tree: OpeningTree;
  modifiedAt: string; // ISO
}

// ---------- SRS (M3; defined now so the schema is stable) ----------

export interface SrsCard {
  /** `${openingId}:${nodeId}` */
  key: string;
  openingId: string;
  nodeId: string;
  easeFactor: number;
  intervalDays: number;
  dueDate: string; // ISO date
  lapses: number;
  attempts: number;
  correctStreak: number;
  lastSeen: string; // ISO timestamp
}

export interface MasterySnapshot {
  /** `${openingId}:${date}` */
  key: string;
  openingId: string;
  date: string; // YYYY-MM-DD
  mastery: number; // 0..100
}
