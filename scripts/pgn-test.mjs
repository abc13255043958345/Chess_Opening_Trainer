#!/usr/bin/env node
// Unit tests for PGN import/export (src/lib/pgn.ts, DESIGN.md §4.5, §6 M5).
//
// Same transpile trick as scripts/practice-engine-test.mjs / scripts/srs-test.mjs:
// pgn.ts (+ tree.ts, types.ts, their only deps) has zero React/DOM imports, so it's
// compiled standalone (no vite/vitest) and imported directly by plain node. pgn.ts
// itself imports the real `chess.js` npm package — untouched, resolved normally by
// Node's own module resolution from scratch-test/ (which lives under the repo root, so
// the walk-up to node_modules/ works exactly like it would for the compiled app code).
//
// This script:
//   1. Compiles src/lib/pgn.ts, src/lib/tree.ts, src/types.ts to scratch-test/ with
//      `tsc` (module esnext, moduleResolution bundler — same shape the app uses).
//   2. Patches the emitted bare "./tree" specifier tsc doesn't rewrite under
//      esnext/bundler (same issue the other two test scripts hit).
//   3. Round-trips the real c50-italian-game content tree through treeToPgn/pgnToTree
//      and asserts node count / san / uci / moveKind / annotations / endOfTheory all
//      survive exactly.
//   4. Parses a hand-written Lichess-study-style PGN snippet (nested variations,
//      comments, a `?!` mistake move) and asserts it doesn't throw and produces a
//      sane tree.
//   5. Deletes scratch-test/ when done, pass or fail.
//
// Usage: node scripts/pgn-test.mjs   (requires `tsc` reachable via npx)

import { execSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const scratchDir = path.join(root, "scratch-test");

async function cleanup() {
  await rm(scratchDir, { recursive: true, force: true });
}

async function patchBareSpecifier(filePath, from, to) {
  let src = await readFile(filePath, "utf8");
  const patched = src.replaceAll(from, to);
  if (patched === src) {
    throw new Error(`expected to patch ${from} → ${to} in ${filePath}`);
  }
  await writeFile(filePath, patched);
}

async function compilePgnLib() {
  await cleanup();
  console.log("Compiling src/lib/pgn.ts (+ tree.ts, types.ts) to scratch-test/ …");
  execSync(
    [
      "npx tsc",
      "src/lib/pgn.ts src/lib/tree.ts src/types.ts",
      "--outDir scratch-test",
      "--module esnext",
      "--target es2022",
      "--moduleResolution bundler",
      "--skipLibCheck",
      // This repo has a root tsconfig.json; passing files on the command line makes
      // tsc refuse to also load it (TS5112) unless told explicitly it's intentional.
      "--ignoreConfig",
    ].join(" "),
    { cwd: root, stdio: "inherit" }
  );

  const pgnJsPath = path.join(scratchDir, "lib", "pgn.js");
  await patchBareSpecifier(pgnJsPath, 'from "./tree"', 'from "./tree.js"');

  return import(pathToFileURL(pgnJsPath).href);
}

async function loadItalianGameTree() {
  const contentPath = path.join(root, "public", "content", "eco-C.json");
  const content = JSON.parse(await readFile(contentPath, "utf8"));
  const tree = content.trees["c50-italian-game"];
  assert.ok(tree, 'c50-italian-game tree not found in public/content/eco-C.json');
  return tree;
}

// ---------- Scenarios ----------

// FLAGGED PRE-EXISTING DATA BUG (found while writing this test, filed separately —
// not fixed here since pipeline/ and public/content/ are out of scope for this task):
// pipeline/treegen.mjs's applyUci() documents that every stored `uci` must be
// chess.js's canonical lan form for castling ("e1g1"/"e1c1"/"e8g8"/"e8c8"), never the
// Lichess/UCI-protocol "king-takes-own-rook" form ("e1h1" etc.) — but ~half the
// castling nodes in the real shipped content (121 of 238 across both ECO files) are
// stored in the wrong raw form anyway (verified directly against the JSON; even two
// sibling "O-O" nodes in the same tree can differ). pgn.ts always ROUND-TRIPS a
// castling move to the canonical form (via chess.js's own `mv.lan`, same as every
// other consumer in this app, e.g. src/screens/Practice.tsx's move matching) —
// correctly, per pipeline/treegen.mjs's own contract — so a node that shipped with the
// wrong raw uci will legitimately change on round-trip. This projection normalizes
// castling uci on both sides before comparing so the test asserts the meaningful
// invariant (same move) instead of failing on a content bug that isn't pgn.ts's to fix.
const CASTLING_UCI_FIX = { e1h1: "e1g1", e1a1: "e1c1", e8h8: "e8g8", e8a8: "e8c8" };
function canonicalUci(uci) {
  return CASTLING_UCI_FIX[uci] ?? uci;
}

/** Deep-comparable projection of a tree's nodes, keyed by their uci PATH from root
 *  (not by id) — pgnToTree recomputes ids the same way addMove always does (a hash of
 *  the uci path), so ids should actually match too, but keying by path makes the
 *  assertion failure messages far more legible if anything ever doesn't. */
function projectByPath(tree) {
  const byId = tree.nodes;
  const out = new Map();
  function pathFor(id) {
    const parts = [];
    let cur = byId[id];
    while (cur && cur.parentId != null) {
      parts.push(canonicalUci(cur.uci));
      cur = byId[cur.parentId];
    }
    return parts.reverse().join(" ");
  }
  for (const node of Object.values(byId)) {
    out.set(pathFor(node.id), {
      san: node.san,
      uci: canonicalUci(node.uci),
      moveKind: node.moveKind,
      annotation: node.annotation ?? null,
      endOfTheory: node.endOfTheory ?? null,
    });
  }
  return out;
}

function testRoundTripPreservesEverything(pgnLib, tree) {
  const { treeToPgn, pgnToTree } = pgnLib;

  const pgn = treeToPgn(tree);
  assert.ok(pgn.includes("[Event"), "expected PGN headers in the export");

  const meta = { id: tree.id, eco: tree.eco, name: tree.name, perspective: tree.perspective };
  const roundTripped = pgnToTree(pgn, meta);

  const originalCount = Object.keys(tree.nodes).length;
  const roundTrippedCount = Object.keys(roundTripped.nodes).length;
  assert.equal(roundTrippedCount, originalCount, "node count changed across the round trip");

  const before = projectByPath(tree);
  const after = projectByPath(roundTripped);
  assert.equal(after.size, before.size, "distinct move-paths changed across the round trip");

  let checked = 0;
  for (const [pathKey, expected] of before) {
    const actual = after.get(pathKey);
    assert.ok(actual, `path "${pathKey}" missing after round trip`);
    assert.equal(actual.san, expected.san, `san mismatch at "${pathKey}"`);
    assert.equal(actual.uci, expected.uci, `uci mismatch at "${pathKey}"`);
    assert.equal(actual.moveKind, expected.moveKind, `moveKind mismatch at "${pathKey}"`);
    assert.deepEqual(actual.annotation, expected.annotation, `annotation mismatch at "${pathKey}"`);
    assert.deepEqual(actual.endOfTheory, expected.endOfTheory, `endOfTheory mismatch at "${pathKey}"`);
    checked++;
  }
  assert.ok(checked > 100, `expected to check >100 nodes, only checked ${checked}`);

  // Sanity: the tree actually has annotations/endOfTheory/mistakes worth testing, so a
  // trivially-empty tree couldn't make this test pass by accident.
  const mistakeCount = [...before.values()].filter((n) => n.moveKind === "opponent_mistake").length;
  const annotatedCount = [...before.values()].filter((n) => n.annotation).length;
  const endOfTheoryCount = [...before.values()].filter((n) => n.endOfTheory).length;
  assert.ok(mistakeCount > 0, "expected ≥1 opponent_mistake node in the fixture tree");
  assert.ok(annotatedCount > 0, "expected ≥1 annotated node in the fixture tree");
  assert.ok(endOfTheoryCount > 0, "expected ≥1 endOfTheory node in the fixture tree");
}

function testReplayCheckPassesOnRoundTrip(pgnLib, tree) {
  const { treeToPgn, pgnToTree, replayCheck } = pgnLib;
  const meta = { id: tree.id, eco: tree.eco, name: tree.name, perspective: tree.perspective };
  const roundTripped = pgnToTree(treeToPgn(tree), meta);
  const problems = replayCheck(roundTripped);
  assert.deepEqual(problems, [], "replayCheck found problems in a tree pgnToTree itself produced");
}

const LICHESS_STUDY_SNIPPET = `[Event "Study: Ruy Lopez vs Italian"]
[Site "https://lichess.org/study/abc123"]
[Date "2024.01.15"]
[Round "1"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 (1... c5 2. Nf3 {The Sicilian Defense — sharper, more theoretical.} d6)
2. Nf3 Nc6 3. Bb5 {The Ruy Lopez — White pins the knight defending e5.}
(3. Bc4 Bc5 {The Italian Game.} 4. c3 Nf6?! {Dubious — invites d4 immediately.} 5. d4 exd4)
3... a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 *
`;

function testParsesRealLichessSnippetWithoutErrors(pgnLib) {
  const { pgnToTree } = pgnLib;
  // Trainee plays White here, so the "?!"-suffixed 4... Nf6?! (Black's move) is the
  // opponent's mistake to test — DESIGN §4.5's mapping only ever applies to opponent
  // moves (a "?!" on the trainee's own move can't become moveKind "opponent_mistake",
  // src/lib/pgn.ts's parseSequence gates on mover === "opponent").
  const meta = { id: "test-ruy-lopez", eco: "C60", name: "Test Ruy Lopez", perspective: "white" };

  const tree = pgnToTree(LICHESS_STUDY_SNIPPET, meta);
  const nodeCount = Object.keys(tree.nodes).length;
  assert.ok(nodeCount > 10, `expected a substantial parsed tree, got ${nodeCount} nodes`);

  const nodes = Object.values(tree.nodes);
  assert.ok(nodes.some((n) => n.san === "O-O"), "expected castling (O-O) to parse");
  assert.ok(
    nodes.some((n) => n.moveKind === "opponent_mistake" && n.san === "Nf6" && n.mover === "opponent"),
    'expected the "?!"-suffixed 4... Nf6 (an opponent/Black move here) to import as opponent_mistake'
  );
  assert.ok(
    nodes.some((n) => n.annotation?.explanation?.includes("Ruy Lopez")),
    "expected the Ruy Lopez comment to become an annotation"
  );
  assert.ok(
    nodes.some((n) => n.san === "c5" && n.mover === "opponent"),
    'expected the 1... c5 sideline variation to import (as an opponent-turn node, since white is the trainee)'
  );
}

// ---------- Runner ----------

async function runTest(results, name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, error: err instanceof Error ? err.stack : String(err) });
  }
}

async function main() {
  let pgnLib;
  try {
    pgnLib = await compilePgnLib();
    const tree = await loadItalianGameTree();

    const results = [];
    await runTest(
      results,
      "tree → PGN → tree preserves node count / san / uci / moveKind / annotations / endOfTheory",
      () => testRoundTripPreservesEverything(pgnLib, tree)
    );
    await runTest(results, "replayCheck finds no problems in a round-tripped tree", () =>
      testReplayCheckPassesOnRoundTrip(pgnLib, tree)
    );
    await runTest(
      results,
      "parses a real Lichess-study-style PGN (nested variations + comments) without errors",
      () => testParsesRealLichessSnippetWithoutErrors(pgnLib)
    );

    console.log("");
    for (const r of results) {
      console.log(`${r.pass ? "PASS" : "FAIL"} — ${r.name}`);
    }

    const failed = results.filter((r) => !r.pass);
    if (failed.length > 0) {
      console.error("");
      for (const f of failed) console.error(`--- ${f.name} ---\n${f.error}\n`);
      process.exitCode = 1;
    } else {
      console.log(`\nAll ${results.length} tests passed.`);
    }
  } finally {
    await cleanup();
  }
}

main();
