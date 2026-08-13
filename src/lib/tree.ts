// Tree utilities over the OpeningTree structure. Pure functions; no UI, no IO.

import type { Color, MoveKind, Mover, OpeningTree, RepertoireNode } from "../types";
import { nodeIdForPath, ROOT_ID } from "../../shared/id.mjs";

export const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export { ROOT_ID, nodeIdForPath };

export function createEmptyTree(
  id: string,
  eco: string,
  name: string,
  perspective: Color
): OpeningTree {
  const root: RepertoireNode = {
    id: ROOT_ID,
    fen: START_FEN,
    san: "",
    uci: "",
    parentId: null,
    children: [],
    mover: "opponent",
    moveKind: "mainline",
  };
  return { id, eco, name, perspective, rootId: ROOT_ID, nodes: { [ROOT_ID]: root } };
}

export function getNode(tree: OpeningTree, id: string): RepertoireNode {
  const n = tree.nodes[id];
  if (!n) throw new Error(`node ${id} not in tree ${tree.id}`);
  return n;
}

/** Nodes from root (inclusive) to the given node (inclusive). */
export function pathToNode(tree: OpeningTree, nodeId: string): RepertoireNode[] {
  const path: RepertoireNode[] = [];
  let cur: RepertoireNode | undefined = tree.nodes[nodeId];
  while (cur) {
    path.push(cur);
    cur = cur.parentId != null ? tree.nodes[cur.parentId] : undefined;
  }
  return path.reverse();
}

/** UCI moves from the start position to this node. */
export function uciPath(tree: OpeningTree, nodeId: string): string[] {
  return pathToNode(tree, nodeId)
    .filter((n) => n.uci !== "")
    .map((n) => n.uci);
}

/** Side to move in a FEN. */
export function sideToMove(fen: string): Color {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

/** Is the trainee to move in this node's position? */
export function isUserTurn(tree: OpeningTree, node: RepertoireNode): boolean {
  return sideToMove(node.fen) === tree.perspective;
}

/**
 * Numbered SAN for moves starting at a given half-move index (0 = white's first move).
 * e.g. startPly=0 → "1. e4 e5 2. Nf3"; startPly=5 → "3... Nc6 4. d4".
 */
export function numberedSan(sans: string[], startPly = 0): string {
  const out: string[] = [];
  sans.forEach((san, i) => {
    const ply = startPly + i;
    const moveNo = Math.floor(ply / 2) + 1;
    if (ply % 2 === 0) out.push(`${moveNo}. ${san}`);
    else if (i === 0) out.push(`${moveNo}... ${san}`);
    else out.push(san);
  });
  return out.join(" ");
}

/** Numbered SAN line from root to a node. */
export function sanLineTo(tree: OpeningTree, nodeId: string): string {
  const sans = pathToNode(tree, nodeId)
    .filter((n) => n.san !== "")
    .map((n) => n.san);
  return numberedSan(sans, 0);
}

export interface NewMove {
  san: string;
  uci: string;
  fen: string; // position after the move
  moveKind?: MoveKind;
  weight?: number;
}

/**
 * Add a move under parentId (idempotent: returns the existing child if the same
 * uci is already there). Mover is derived from the parent position's side to move.
 */
export function addMove(tree: OpeningTree, parentId: string, mv: NewMove): RepertoireNode {
  const parent = getNode(tree, parentId);
  for (const cid of parent.children) {
    const c = tree.nodes[cid];
    if (c && c.uci === mv.uci) return c;
  }
  const path = [...uciPath(tree, parentId), mv.uci];
  const id = nodeIdForPath(path);
  const mover: Mover =
    sideToMove(parent.fen) === tree.perspective ? "user" : "opponent";
  const node: RepertoireNode = {
    id,
    fen: mv.fen,
    san: mv.san,
    uci: mv.uci,
    parentId,
    children: [],
    mover,
    moveKind: mv.moveKind ?? "mainline",
    ...(mv.weight != null ? { weight: mv.weight } : {}),
  };
  tree.nodes[id] = node;
  parent.children.push(id);
  return node;
}

/** Delete a node and its whole subtree. */
export function deleteSubtree(tree: OpeningTree, nodeId: string): void {
  if (nodeId === tree.rootId) throw new Error("cannot delete root");
  const node = getNode(tree, nodeId);
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = tree.nodes[id];
    if (!n) continue;
    stack.push(...n.children);
    delete tree.nodes[id];
  }
  if (node.parentId) {
    const p = tree.nodes[node.parentId];
    if (p) p.children = p.children.filter((c) => c !== nodeId);
  }
}

/**
 * The single correct continuation at a user-to-move node: its mainline child.
 * Returns undefined at end of theory.
 */
export function mainlineChild(
  tree: OpeningTree,
  node: RepertoireNode
): RepertoireNode | undefined {
  for (const cid of node.children) {
    const c = tree.nodes[cid];
    if (c && c.moveKind === "mainline") return c;
  }
  return undefined;
}

/** All user-move nodes (the future SRS cards). */
export function userMoveNodes(tree: OpeningTree): RepertoireNode[] {
  return Object.values(tree.nodes).filter((n) => n.mover === "user" && n.san !== "");
}

/** Depth (half-moves from start) of a node. */
export function nodeDepth(tree: OpeningTree, nodeId: string): number {
  return uciPath(tree, nodeId).length;
}

export interface TreeProblem {
  nodeId: string;
  problem: string;
}

/** Structural invariant checks (see DESIGN.md §2). */
export function validateTree(tree: OpeningTree): TreeProblem[] {
  const problems: TreeProblem[] = [];
  const root = tree.nodes[tree.rootId];
  if (!root) return [{ nodeId: tree.rootId, problem: "missing root" }];
  for (const n of Object.values(tree.nodes)) {
    for (const cid of n.children) {
      const c = tree.nodes[cid];
      if (!c) problems.push({ nodeId: n.id, problem: `dangling child ${cid}` });
      else if (c.parentId !== n.id)
        problems.push({ nodeId: cid, problem: "parentId mismatch" });
    }
    // A position where the trainee is to move must have at most one mainline
    // continuation (the repertoire choice).
    if (n.san === "" || n.mover === "opponent") {
      const isUsersTurn = sideToMove(n.fen) === tree.perspective;
      if (isUsersTurn) {
        const mains = n.children.filter(
          (cid) => tree.nodes[cid]?.moveKind === "mainline"
        );
        if (mains.length > 1)
          problems.push({
            nodeId: n.id,
            problem: `user-to-move node has ${mains.length} mainline children`,
          });
      }
    }
  }
  return problems;
}
