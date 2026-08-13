// Builds one OpeningTree per catalog entry: a fixed "defining line" prefix
// (the catalog's own move order, unconditionally built) followed by a
// breadth-first expansion driven by the Lichess Explorer API (theory
// popularity/mistake detection) and evals.mjs (evalCp - Lichess cloud-eval
// opportunistically, local Stockfish as the reliable fallback behind a
// circuit breaker; see evals.mjs and DESIGN.md §2, §4.2 and build-content.mjs's
// header comment for the overall pipeline contract).
//
// Underspecified areas, resolved and documented inline where the code makes
// the call (also summarized in the final build report):
//   - "the position's best" baseline for the mistake eval-drop check is the
//     opponent-to-move node's own evalCp (already stamped from cloud-eval when
//     that node was created) - it already reflects best play into that position.
//   - the mastersGamesFloor "theory has run out" stop applies symmetrically to
//     both user-to-move and opponent-to-move frontier nodes (the spec states it
//     explicitly only for the user-to-move case, but a branch with no masters
//     data has nothing to prepare for either way).
//   - punish-line nodes past the first reply don't get a fresh cloud-eval /
//     endOfTheory stamp (only the mistake node and the first punish reply do) -
//     bounds API calls on a line whose length is already hard-capped.

import { Chess } from "chess.js";
import { nodeIdForPath, ROOT_ID } from "../shared/id.mjs";
import { CONFIG } from "./config.mjs";
import { fetchMasters, fetchLichessPool } from "./explorer.mjs";
import { getEval } from "./evals.mjs";
import { explainMainlineMove, explainMistake } from "./explain.mjs";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Lichess's own UCI move strings (both Explorer `uci` fields and cloud-eval PV
// moves) encode castling as king-takes-own-rook ("e1h1" = O-O, "e1a1" = O-O-O),
// not the standard-chess "king moves two squares" form chess.js expects
// ("e1g1"/"e1c1"). Discovered empirically while wiring up the punish-line PV
// (chess.js threw "Invalid move" on a real cloud-eval PV containing "e1h1").
const CASTLING_UCI_FIX = { e1h1: "e1g1", e1a1: "e1c1", e8h8: "e8g8", e8a8: "e8c8" };

/**
 * Applies one UCI move to a FEN using chess.js.
 * @param {string} fen
 * @param {string} uci - e.g. "e2e4" or "e7e8q" (or a Lichess-style castling move, see above)
 * @returns {{san: string, fen: string, color: "w" | "b"}}
 */
function applyUci(fen, uci) {
  const normalized = CASTLING_UCI_FIX[uci] ?? uci;
  const chess = new Chess(fen);
  const from = normalized.slice(0, 2);
  const to = normalized.slice(2, 4);
  const promotion = normalized.length > 4 ? normalized.slice(4) : undefined;
  const move = chess.move({ from, to, promotion });
  return { san: move.san, fen: chess.fen(), color: move.color };
}

/**
 * Eval swing toward the user's side, given a white-positive before/after cp pair.
 * @param {"white" | "black"} perspective
 * @param {number} beforeCp
 * @param {number} afterCp
 * @returns {number}
 */
function swingTowardUser(perspective, beforeCp, afterCp) {
  const delta = afterCp - beforeCp;
  return perspective === "white" ? delta : -delta;
}

/**
 * Builds one OpeningTree for a catalog entry.
 * @param {{id: string, eco: string, name: string, perspective: "white"|"black", uciPath: string[]}} entry
 * @returns {Promise<{tree: import("../src/types.js").OpeningTree, stats: {punishLineMissing: number}}>}
 */
export async function buildOpeningTree(entry) {
  const perspectiveColor = entry.perspective === "white" ? "w" : "b";
  /** @type {Record<string, any>} */
  const nodes = {};
  let nodeCount = 0;
  const stats = { punishLineMissing: 0 };

  /** @param {any} node */
  function addNode(node) {
    nodes[node.id] = node;
    nodeCount++;
  }

  async function stampEval(node) {
    // Only node.evalCp is ever read for these stamps (no PV needed), so
    // request just the top line - cheaper if this falls through to the
    // local engine (see evals.mjs).
    const evalResult = await getEval(node.fen, { multiPv: 1 });
    if (evalResult) node.evalCp = evalResult.cp;
    return evalResult;
  }

  // --- Root ---
  const root = {
    id: ROOT_ID,
    fen: START_FEN,
    san: "",
    uci: "",
    parentId: null,
    children: [],
    mover: "opponent",
    moveKind: "mainline",
  };
  addNode(root);
  await stampEval(root);

  // --- Defining-line prefix: a single unconditional chain, no branching ---
  let current = root;
  let uciPath = [];
  for (const uci of entry.uciPath) {
    const { san, fen, color } = applyUci(current.fen, uci);
    uciPath = [...uciPath, uci];
    const mover = color === perspectiveColor ? "user" : "opponent";
    const node = {
      id: nodeIdForPath(uciPath),
      fen,
      san,
      uci,
      parentId: current.id,
      children: [],
      mover,
      moveKind: "mainline",
      ...(mover === "opponent" ? { weight: 1 } : {}),
    };
    addNode(node);
    current.children.push(node.id);
    await stampEval(node);
    current = node;
  }

  /** @type {Array<{node: any, uciPath: string[]}>} */
  const frontier = [];

  /**
   * Applies the winning/maxPly stop checks to a freshly-stamped node; queues
   * it for expansion if neither fires.
   */
  function finalizeOrQueue(node, path) {
    if (typeof node.evalCp === "number" && Math.abs(node.evalCp) >= CONFIG.endOfTheoryEvalCp) {
      node.endOfTheory = { reason: "winning", evalCp: node.evalCp };
      return;
    }
    if (path.length >= CONFIG.maxPly) {
      node.endOfTheory = { reason: "clear_plan", ...(typeof node.evalCp === "number" ? { evalCp: node.evalCp } : {}) };
      return;
    }
    frontier.push({ node, uciPath: path });
  }

  finalizeOrQueue(current, uciPath);

  // --- Breadth-first expansion ---
  while (frontier.length > 0) {
    if (nodeCount >= CONFIG.maxNodesPerOpening) break;
    const { node, uciPath: path } = frontier.shift();

    const turnColor = new Chess(node.fen).turn();
    const isUserToMove = turnColor === perspectiveColor;

    const masters = await fetchMasters(node.fen);
    const theoryRanOut = !masters || masters.totalGames < CONFIG.mastersGamesFloor || masters.moves.length === 0;
    if (theoryRanOut) {
      node.endOfTheory = { reason: "clear_plan", ...(typeof node.evalCp === "number" ? { evalCp: node.evalCp } : {}) };
      continue;
    }

    if (isUserToMove) {
      const top = [...masters.moves].sort((a, b) => b.share - a.share)[0];
      if (nodeCount >= CONFIG.maxNodesPerOpening) break;
      const { san, fen, color } = applyUci(node.fen, top.uci);
      const childPath = [...path, top.uci];
      const child = {
        id: nodeIdForPath(childPath),
        fen,
        san,
        uci: top.uci,
        parentId: node.id,
        children: [],
        mover: color === perspectiveColor ? "user" : "opponent",
        moveKind: "mainline",
      };
      addNode(child);
      node.children.push(child.id);
      await stampEval(child);
      child.annotation = {
        explanation: explainMainlineMove({ san: child.san, share: top.share, evalCp: child.evalCp }),
      };
      finalizeOrQueue(child, childPath);
      continue;
    }

    // Opponent to move: theory children first, then curated mistake children.
    const theoryMoves = masters.moves
      .filter((m) => m.share >= CONFIG.popularityThreshold)
      .sort((a, b) => b.share - a.share)
      .slice(0, CONFIG.maxTheoryRepliesPerNode);

    const theoryUcis = new Set(theoryMoves.map((m) => m.uci));

    for (const m of theoryMoves) {
      if (nodeCount >= CONFIG.maxNodesPerOpening) break;
      const { san, fen, color } = applyUci(node.fen, m.uci);
      const childPath = [...path, m.uci];
      const child = {
        id: nodeIdForPath(childPath),
        fen,
        san,
        uci: m.uci,
        parentId: node.id,
        children: [],
        mover: color === perspectiveColor ? "user" : "opponent",
        moveKind: "mainline",
        weight: m.share,
      };
      addNode(child);
      node.children.push(child.id);
      await stampEval(child);
      finalizeOrQueue(child, childPath);
    }

    if (nodeCount >= CONFIG.maxNodesPerOpening) break;

    const pool = await fetchLichessPool(node.fen);
    if (!pool) continue;

    const mastersShareByUci = new Map(masters.moves.map((m) => [m.uci, m.share]));
    const poolCandidates = pool.moves
      .filter((m) => !theoryUcis.has(m.uci) && m.share >= CONFIG.mistakePopularityThreshold)
      .sort((a, b) => b.share - a.share)
      // Consider a bounded surplus beyond maxMistakesPerNode so rejected
      // candidates (failed eval-drop check) don't starve the slot count.
      .slice(0, CONFIG.maxMistakesPerNode + 4);

    let mistakesAdded = 0;
    for (const m of poolCandidates) {
      if (mistakesAdded >= CONFIG.maxMistakesPerNode) break;
      if (nodeCount >= CONFIG.maxNodesPerOpening) break;

      const mastersShare = mastersShareByUci.get(m.uci) ?? 0;
      const isRareInMasters = mastersShare < CONFIG.mistakeMastersRarity;

      const { san, fen } = applyUci(node.fen, m.uci);
      // This eval's top PV feeds the punish line below - only the top line
      // matters (multiPv 1), and if it comes from the local engine it should
      // be searched deeper than a routine stamp (the line needs to hold up).
      const resultEval = await getEval(fen, { multiPv: 1, localDepth: CONFIG.localPunishDepth });

      let evalDropCp;
      let evalDropTriggered = false;
      if (resultEval && typeof node.evalCp === "number") {
        evalDropCp = swingTowardUser(entry.perspective, node.evalCp, resultEval.cp);
        evalDropTriggered = evalDropCp >= CONFIG.mistakeEvalCutoffCp;
      }

      if (!isRareInMasters && !evalDropTriggered) continue;

      const mistakePath = [...path, m.uci];
      const mistakeNode = {
        id: nodeIdForPath(mistakePath),
        fen,
        san,
        uci: m.uci,
        parentId: node.id,
        children: [],
        mover: "opponent",
        moveKind: "opponent_mistake",
        weight: m.share,
      };
      if (resultEval) mistakeNode.evalCp = resultEval.cp;

      const punishSan = await buildPunishLine(mistakeNode, mistakePath, resultEval, entry, addNode, stats);

      mistakeNode.annotation = {
        explanation: explainMistake({
          san: mistakeNode.san,
          poolShare: m.share,
          isRareInMasters,
          evalDropCp,
          evalDropTriggered,
          punishSan,
        }),
      };

      addNode(mistakeNode);
      node.children.push(mistakeNode.id);
      mistakesAdded++;
    }
  }

  // Any node left in the frontier when the node cap fired has no children and
  // no endOfTheory - stamp it as a safety-cap cutoff so every leaf is marked.
  for (const { node } of frontier) {
    if (node.children.length === 0 && !node.endOfTheory) {
      node.endOfTheory = { reason: "clear_plan", ...(typeof node.evalCp === "number" ? { evalCp: node.evalCp } : {}) };
    }
  }

  const tree = {
    id: entry.id,
    eco: entry.eco,
    name: entry.name,
    perspective: entry.perspective,
    rootId: ROOT_ID,
    nodes,
  };

  return { tree, stats };
}

/**
 * Extends a single chain from the cloud-eval PV of a mistake position, up to
 * CONFIG.punishLineMaxPlies plies. Mutates `nodes` via addNode. The first
 * punish move (the user's reply) gets an annotation.explanation; deeper nodes
 * don't (see module header comment on API-call bounding).
 * @returns {Promise<string | undefined>} the first punish move's SAN, for the mistake node's own explanation text.
 */
async function buildPunishLine(mistakeNode, mistakePath, resultEval, entry, addNode, stats) {
  const pv = resultEval?.pvs?.[0];
  if (!pv || !pv.moves) {
    stats.punishLineMissing++;
    return undefined;
  }

  const uciMoves = pv.moves.split(" ").filter(Boolean).slice(0, CONFIG.punishLineMaxPlies);
  if (uciMoves.length === 0) {
    stats.punishLineMissing++;
    return undefined;
  }

  const perspectiveColor = entry.perspective === "white" ? "w" : "b";

  // Precompute the whole chain's SAN/fen up front so the first node's
  // "Play continues ..." preview can reference later moves in the line.
  const steps = [];
  let fen = mistakeNode.fen;
  for (const uci of uciMoves) {
    const { san, fen: nextFen, color } = applyUci(fen, uci);
    steps.push({ uci, san, fen: nextFen, color });
    fen = nextFen;
  }

  let parent = mistakeNode;
  let path = mistakePath;
  let firstPunishSan;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    path = [...path, step.uci];
    const node = {
      id: nodeIdForPath(path),
      fen: step.fen,
      san: step.san,
      uci: step.uci,
      parentId: parent.id,
      children: [],
      mover: step.color === perspectiveColor ? "user" : "opponent",
      moveKind: "mainline",
    };

    if (i === 0) {
      firstPunishSan = step.san;
      // One extra eval call to get an accurate "after" number for the
      // explanation text (deeper punish nodes skip this - see header comment).
      const evalAfter = await getEval(step.fen, { multiPv: 1 });
      if (evalAfter) node.evalCp = evalAfter.cp;
      node.annotation = {
        explanation: explainMainlineMove({
          san: step.san,
          share: 1,
          parentIsMistake: true,
          parentMistakeSan: mistakeNode.san,
          evalBeforeCp: mistakeNode.evalCp,
          evalAfterCp: node.evalCp,
          punishSanPreview: steps.slice(1, 5).map((s) => s.san),
        }),
      };
    }

    addNode(node);
    parent.children.push(node.id);
    parent = node;
  }

  return firstPunishSan;
}
