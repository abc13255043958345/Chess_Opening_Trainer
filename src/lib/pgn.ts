// PGN import/export for repertoire trees (DESIGN.md §4.5, §6 M5).
//
// chess.js's own PGN support only loads a single line (no variations), so this file
// writes AND reads PGN itself — a small recursive-descent parser over a hand-rolled
// tokenizer, plus a recursive writer. Encoding (DESIGN specifies mainline-as-primary,
// sidelines/mistakes-as-variations, explanation/plans-as-comments, opponent_mistake
// suffixed "?!", endOfTheory as a comment tag — the exact comment-tag grammar below is
// ours to define):
//   - moveKind "opponent_mistake": SAN gets a "?!" suffix, both written and read back —
//     including on a real external PGN's own "?!" moves (DESIGN §4.5's mapping applies
//     on import generally, not just our own round-trip).
//   - moveKind "sideline": a bare `{SIDELINE}` comment token right after the move.
//     "mainline" is the default for anything with neither a "?!" suffix nor this tag,
//     which is the only sane behavior for a real-world PGN that never emits it.
//   - annotation.explanation: the move's first plain (untagged) comment.
//   - annotation.plans: a `{PLANS: ...}` tagged comment.
//   - endOfTheory: a `{END: reason [+eval]}` tagged comment; eval is pawns to 2dp
//     (lossless for any integer centipawn value, unlike the editor's own 1dp field).
//   - Which sibling continues the *unparenthesized* primary line at a branch point is
//     purely cosmetic: every child's own moveKind/annotation/endOfTheory round-trips via
//     the per-move encoding above regardless of whether it ends up on the main line or
//     in a variation. We pick the first "mainline"-kind child as primary, falling back
//     to the first child of any kind (e.g. a node whose only children are mistakes).
//   - weight/evalCp are NOT round-tripped (not part of the DESIGN §6 M5 acceptance list,
//     and there's no sane PGN slot for a popularity weight) — an import simply leaves
//     them unset, same as a hand-authored line in the editor.

import { Chess } from "chess.js";
import type { Color, EndOfTheory, OpeningTree, RepertoireNode } from "../types";
import { addMove, createEmptyTree, sideToMove } from "./tree";
import type { TreeProblem } from "./tree";

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function escapeComment(text: string): string {
  // PGN has no escape mechanism for "}" inside a comment — strip any that sneak in
  // from hand-authored text rather than emit invalid PGN.
  return text.replace(/[{}]/g, "");
}

function formatEvalPawns(evalCp: number): string {
  const pawns = evalCp / 100;
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

function moveToken(node: RepertoireNode): string {
  return node.moveKind === "opponent_mistake" ? `${node.san}?!` : node.san;
}

function moveComments(node: RepertoireNode): string {
  const parts: string[] = [];
  if (node.annotation?.explanation) {
    parts.push(`{${escapeComment(node.annotation.explanation)}}`);
  }
  if (node.annotation?.plans) {
    parts.push(`{PLANS: ${escapeComment(node.annotation.plans)}}`);
  }
  if (node.moveKind === "sideline") {
    parts.push("{SIDELINE}");
  }
  if (node.endOfTheory) {
    const evalPart =
      typeof node.endOfTheory.evalCp === "number"
        ? ` ${formatEvalPawns(node.endOfTheory.evalCp)}`
        : "";
    parts.push(`{END: ${node.endOfTheory.reason}${evalPart}}`);
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

/** "N. " before a White move; "N... " before a Black move only when it opens a new
 *  sequence (a variation's first move) — otherwise Black's move just follows the
 *  previous token with a space, standard PGN style. */
function moveNumberPrefix(plyOfMove: number, atSeqStart: boolean): string {
  const moveNo = Math.ceil(plyOfMove / 2);
  const isWhiteMove = plyOfMove % 2 === 1;
  if (isWhiteMove) return `${moveNo}. `;
  return atSeqStart ? `${moveNo}... ` : "";
}

function renderMove(node: RepertoireNode, plyOfMove: number, atSeqStart: boolean): string {
  return `${moveNumberPrefix(plyOfMove, atSeqStart)}${moveToken(node)}${moveComments(node)}`;
}

/** Writes the continuation FROM `node` (i.e. node's own children onward): the primary
 *  child's move, each sibling as a fully-expanded `(...)` variation right after it, then
 *  the primary's own continuation. `plyBefore` = half-moves already played to reach
 *  `node` (0 at the tree root). */
function renderContinuation(tree: OpeningTree, node: RepertoireNode, plyBefore: number): string {
  const children = node.children
    .map((id) => tree.nodes[id])
    .filter((n): n is RepertoireNode => !!n);
  if (children.length === 0) return "";

  const primary = children.find((c) => c.moveKind === "mainline") ?? children[0];
  const alternatives = children.filter((c) => c !== primary);

  const parts: string[] = [renderMove(primary, plyBefore + 1, false)];
  for (const alt of alternatives) {
    const altHead = renderMove(alt, plyBefore + 1, true);
    const altTail = renderContinuation(tree, alt, plyBefore + 1);
    parts.push(`(${altHead}${altTail ? " " + altTail : ""})`);
  }
  const primaryTail = renderContinuation(tree, primary, plyBefore + 1);
  if (primaryTail) parts.push(primaryTail);

  return parts.join(" ");
}

function escapeHeader(text: string): string {
  return text.replace(/"/g, "'");
}

/** Full tree traversal → PGN text (DESIGN §4.5/§6 M5). Mainline is the primary,
 *  unparenthesized line; every sideline/mistake branch is a nested `(...)` variation. */
export function treeToPgn(tree: OpeningTree): string {
  const headers = [
    `[Event "${escapeHeader(tree.name)}"]`,
    `[Site "Chess Opening Trainer"]`,
    `[Date "????.??.??"]`,
    `[Round "-"]`,
    `[White "${tree.perspective === "white" ? "Repertoire" : "Opponent"}"]`,
    `[Black "${tree.perspective === "black" ? "Repertoire" : "Opponent"}"]`,
    `[Result "*"]`,
    `[ECO "${escapeHeader(tree.eco)}"]`,
  ];
  const root = tree.nodes[tree.rootId];
  const movetext = renderContinuation(tree, root, 0);
  return `${headers.join("\n")}\n\n${movetext ? movetext + " *" : "*"}\n`;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = "open" | "close" | "comment" | "movenum" | "result" | "move";
interface Token {
  type: TokenType;
  text: string;
}

const RESULT_RE = /^(1-0|0-1|1\/2-1\/2|\*)$/;
const MOVENUM_RE = /^\d+\.+$/;
// Group 2 must start with a non-dot character — otherwise a bare "3..." (nothing
// glued after it) backtracks into splitting off a trailing "." as its own bogus
// "move" token (e.g. "3.." + ".") instead of failing to match and falling through to
// MOVENUM_RE, which is the correct classification for a plain, nothing-glued marker.
const MOVENUM_GLUED_RE = /^(\d+\.+)([^.\s]\S*)$/;

function classifyWord(word: string, out: Token[]): void {
  const glued = MOVENUM_GLUED_RE.exec(word);
  if (glued) {
    out.push({ type: "movenum", text: glued[1] });
    if (glued[2]) classifyWord(glued[2], out);
    return;
  }
  if (RESULT_RE.test(word)) {
    out.push({ type: "result", text: word });
  } else if (MOVENUM_RE.test(word)) {
    out.push({ type: "movenum", text: word });
  } else {
    out.push({ type: "move", text: word });
  }
}

/** Turns PGN movetext (headers already stripped) into a flat token stream: `{...}`
 *  comments, `(`/`)`, move-number markers (kept only to be skipped — whose move it is
 *  is tracked by ply, not by re-parsing "12." / "12..."), the result marker, NAG codes
 *  ($1 etc., dropped), and move tokens (SAN + any trailing "!?" annotation glyphs). */
function tokenize(movetext: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = movetext.length;
  while (i < n) {
    const ch = movetext[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "{") {
      const end = movetext.indexOf("}", i + 1);
      const close = end === -1 ? n : end;
      tokens.push({ type: "comment", text: movetext.slice(i + 1, close).trim() });
      i = close + 1;
      continue;
    }
    if (ch === ";") {
      const nl = movetext.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "open", text: "(" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "close", text: ")" });
      i++;
      continue;
    }
    if (ch === "$") {
      let j = i + 1;
      while (j < n && /\d/.test(movetext[j])) j++;
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !/[\s(){};]/.test(movetext[j])) j++;
    classifyWord(movetext.slice(i, j), tokens);
    i = j;
  }
  return tokens;
}

function splitHeadersAndMovetext(pgn: string): string {
  const lines = pgn.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && /^\s*\[.*\]\s*$/.test(lines[i])) i++;
  return lines.slice(i).join("\n");
}

// ---------------------------------------------------------------------------
// Recursive-descent parser
// ---------------------------------------------------------------------------

const DUBIOUS_SUFFIX_RE = /^(.*?)([!?]*)$/;

function stripMoveSuffix(word: string): { san: string; isMistake: boolean } {
  const m = DUBIOUS_SUFFIX_RE.exec(word)!;
  return { san: m[1], isMistake: m[2] === "?!" };
}

function applyComments(node: RepertoireNode, comments: string[]): void {
  let explanation: string | undefined;
  let plans: string | undefined;
  for (const raw of comments) {
    const text = raw.trim();
    if (/^SIDELINE$/i.test(text)) {
      node.moveKind = "sideline";
      continue;
    }
    const plansMatch = /^PLANS:\s*([\s\S]*)$/i.exec(text);
    if (plansMatch) {
      plans = plansMatch[1].trim();
      continue;
    }
    const endMatch = /^END:\s*(winning|clear_plan)(?:\s+([+-]?\d+(?:\.\d+)?))?$/i.exec(text);
    if (endMatch) {
      const reason = endMatch[1].toLowerCase() as EndOfTheory["reason"];
      const endOfTheory: EndOfTheory = { reason };
      if (endMatch[2] != null) endOfTheory.evalCp = Math.round(parseFloat(endMatch[2]) * 100);
      node.endOfTheory = endOfTheory;
      continue;
    }
    if (text) explanation = explanation ? `${explanation} ${text}` : text;
  }
  if (explanation || plans) {
    node.annotation = { explanation: explanation ?? "", ...(plans ? { plans } : {}) };
  }
}

/**
 * Parses one movetext sequence starting at `tokens[idx]`, playing moves onto `chess`
 * (mutated) and hanging new nodes off `parentId` in `tree`, until a `)` / result /
 * end-of-tokens. Returns the index of the token that stopped it (the caller decides
 * whether that's a `)` to consume). A `(...)` right after a move is that move's
 * alternative — it branches from the position BEFORE that move, i.e. from the same
 * parent the move itself hung off, not from the move's own resulting position.
 */
function parseSequence(
  tokens: Token[],
  startIdx: number,
  chess: Chess,
  parentId: string,
  tree: OpeningTree
): number {
  let idx = startIdx;
  let currentParentId = parentId;

  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok.type === "close" || tok.type === "result") return idx;
    if (tok.type === "movenum" || tok.type === "comment") {
      idx++;
      continue;
    }
    if (tok.type === "open") {
      // A variation with no preceding move in this sequence — malformed PGN; skip it
      // defensively rather than throwing, so one bad spot doesn't sink the whole import.
      idx = skipBalanced(tokens, idx + 1);
      continue;
    }

    // tok.type === "move"
    const { san, isMistake } = stripMoveSuffix(tok.text);
    const beforeFen = chess.fen();
    let mv;
    try {
      mv = chess.move(san);
    } catch {
      throw new Error(`illegal or unparseable move "${tok.text}" after ${chess.pgn() || "start"}`);
    }
    idx++;

    const comments: string[] = [];
    while (tokens[idx]?.type === "comment") {
      comments.push(tokens[idx].text);
      idx++;
    }

    const mover = sideToMove(beforeFen) === tree.perspective ? "user" : "opponent";
    const node = addMove(tree, currentParentId, {
      san: mv.san,
      uci: mv.lan,
      fen: mv.after,
      moveKind: isMistake && mover === "opponent" ? "opponent_mistake" : "mainline",
    });
    applyComments(node, comments);

    // Every variation immediately following belongs to THIS move (an alternative to
    // it, branching from beforeFen/currentParentId).
    while (tokens[idx]?.type === "open") {
      idx++;
      const branchChess = new Chess(beforeFen);
      idx = parseSequence(tokens, idx, branchChess, currentParentId, tree);
      if (tokens[idx]?.type === "close") idx++;
    }

    currentParentId = node.id;
  }
  return idx;
}

/** Skips a `(...)` whose opening paren was already consumed, honoring nesting. */
function skipBalanced(tokens: Token[], startIdx: number): number {
  let depth = 1;
  let idx = startIdx;
  while (idx < tokens.length && depth > 0) {
    if (tokens[idx].type === "open") depth++;
    else if (tokens[idx].type === "close") depth--;
    idx++;
  }
  return idx;
}

export interface PgnTreeMeta {
  id: string;
  eco: string;
  name: string;
  perspective: Color;
}

/** PGN text → OpeningTree, rooted at the standard start position (repertoire trees
 *  never use a custom `[FEN]` setup — DESIGN.md §2's tree always starts at game start,
 *  so any `[FEN]`/`[SetUp]` header in the source PGN is ignored). Throws with a
 *  descriptive message on the first illegal/unparseable move; never partially commits
 *  a tree the caller didn't ask for (Editor validates + confirms before replacing). */
export function pgnToTree(pgn: string, meta: PgnTreeMeta): OpeningTree {
  const tree = createEmptyTree(meta.id, meta.eco, meta.name, meta.perspective);
  const movetext = splitHeadersAndMovetext(pgn);
  const tokens = tokenize(movetext);
  parseSequence(tokens, 0, new Chess(), tree.rootId, tree);
  return tree;
}

// ---------------------------------------------------------------------------
// Import safety net
// ---------------------------------------------------------------------------

function positionKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/**
 * Defense-in-depth for the editor's PGN import (DESIGN §4.5/§6 M5's "every fen legal
 * via chess.js replay"): independently replays every node's move from its parent's own
 * position and confirms the resulting position/uci match what pgnToTree stored. Every
 * fen pgnToTree writes already comes straight from chess.js's own move application, so
 * this should always pass on anything pgnToTree produced — it's a trust-but-verify gate
 * before the editor commits an imported tree, not a step pgnToTree relies on itself.
 */
export function replayCheck(tree: OpeningTree): TreeProblem[] {
  const problems: TreeProblem[] = [];

  function walk(node: RepertoireNode, chess: Chess): void {
    for (const cid of node.children) {
      const child = tree.nodes[cid];
      if (!child) continue;
      let mv;
      try {
        mv = chess.move(child.san);
      } catch {
        problems.push({
          nodeId: child.id,
          problem: `san "${child.san}" is illegal from its parent's position`,
        });
        continue;
      }
      if (positionKey(mv.after) !== positionKey(child.fen) || mv.lan !== child.uci) {
        problems.push({
          nodeId: child.id,
          problem: "replayed position/uci does not match the stored node",
        });
      }
      walk(child, new Chess(mv.after));
      chess.undo();
    }
  }

  const root = tree.nodes[tree.rootId];
  walk(root, new Chess(root.fen));
  return problems;
}
