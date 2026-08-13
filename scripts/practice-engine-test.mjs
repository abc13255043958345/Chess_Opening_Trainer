#!/usr/bin/env node
// Unit tests for the practice-mode session engine (src/lib/practice.ts), driven
// against the real shipped content (public/content/eco-C.json → "c50-italian-game",
// which has at least one genuine opponent_mistake branch with a punish line — see
// DESIGN.md §4.1/§4.2).
//
// practice.ts has zero React/DOM imports, so it's transpiled standalone (no vite/vitest
// needed) and imported directly by plain node. This script:
//   1. Compiles src/lib/practice.ts (+ tree.ts, types.ts, its only deps) to scratch-test/
//      with `tsc` (module esnext, moduleResolution bundler — same shape the app uses).
//   2. Patches the one emitted bare specifier Node's ESM loader can't resolve
//      ("./tree" → "./tree.js"; tsc doesn't rewrite extensions under esnext/bundler).
//   3. Loads the real c50-italian-game tree and runs four scenarios against it.
//   4. Deletes scratch-test/ when done, pass or fail.
//
// Usage: node scripts/practice-engine-test.mjs   (requires `tsc` reachable via npx)

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

async function compileEngine() {
  await cleanup();
  console.log("Compiling src/lib/practice.ts (+ tree.ts, types.ts) to scratch-test/ …");
  execSync(
    [
      "npx tsc",
      "src/lib/practice.ts src/lib/tree.ts src/types.ts",
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

  const practiceJsPath = path.join(scratchDir, "lib", "practice.js");
  let src = await readFile(practiceJsPath, "utf8");
  const patched = src.replace('from "./tree"', 'from "./tree.js"');
  if (patched === src) {
    throw new Error('expected to patch a bare "./tree" import in the compiled output');
  }
  await writeFile(practiceJsPath, patched);

  return import(pathToFileURL(practiceJsPath).href);
}

async function loadItalianGameTree() {
  const contentPath = path.join(root, "public", "content", "eco-C.json");
  const content = JSON.parse(await readFile(contentPath, "utf8"));
  const tree = content.trees["c50-italian-game"];
  assert.ok(tree, 'c50-italian-game tree not found in public/content/eco-C.json');
  return tree;
}

// ---------- Scenarios ----------

function testMistakesAlwaysPunish(engine, tree) {
  const { generateLine, mulberry32 } = engine;
  // Content-agnostic (the pipeline regenerates trees from live data, so specific
  // mistake moves change): assert the engine's INVARIANTS, not particular SANs.
  const mistakeNodes = Object.values(tree.nodes).filter(
    (n) => n.moveKind === "opponent_mistake"
  );
  assert.ok(mistakeNodes.length > 0, "expected ≥1 opponent_mistake node in c50-italian-game");

  let linesWithMistake = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const line = generateLine(tree, { openingIds: [tree.id], mix: "mistakes" }, mulberry32(seed * 97));
    for (let i = 0; i < line.nodeIds.length; i++) {
      const node = tree.nodes[line.nodeIds[i]];
      const nextId = line.nodeIds[i + 1];
      // Invariant 1: wherever the sampled path passes an opponent decision that
      // HAS a mistake child, mix="mistakes" must pick a mistake.
      if (nextId) {
        const next = tree.nodes[nextId];
        const opponentDecision = next.mover === "opponent" && node.children.length > 0;
        const mistakeChildren = node.children.filter(
          (cid) => tree.nodes[cid]?.moveKind === "opponent_mistake"
        );
        if (opponentDecision && mistakeChildren.length > 0) {
          assert.equal(
            next.moveKind,
            "opponent_mistake",
            `seed ${seed}: opponent had a mistake child available but played ${next.san} (${next.moveKind})`
          );
        }
        // Invariant 2: consecutive line nodes are parent→child (the punish chain
        // after a mistake is pinned, never skipped).
        assert.ok(
          node.children.includes(nextId),
          `seed ${seed}: line jumped from ${node.san || "root"} to non-child ${next.san}`
        );
      }
    }
    // Invariant 3: the line only stops at end-of-theory or a leaf.
    const last = tree.nodes[line.nodeIds[line.nodeIds.length - 1]];
    const canContinue =
      !last.endOfTheory &&
      last.children.some((cid) => tree.nodes[cid]?.moveKind !== "sideline");
    assert.ok(!canContinue, `seed ${seed}: line stopped early at ${last.san}`);
    if (line.nodeIds.some((id) => tree.nodes[id].moveKind === "opponent_mistake")) {
      linesWithMistake++;
    }
  }
  // Invariant 4: with mix="mistakes", at least one seed's path should actually
  // reach a mistake branch (they exist in this tree per the check above).
  assert.ok(linesWithMistake > 0, 'mix="mistakes" never reached any mistake branch across 8 seeds');
}

function testTheoryNeverSamplesMistake(engine, tree) {
  const { generateLine, mulberry32 } = engine;
  for (let seed = 1; seed <= 20; seed++) {
    const line = generateLine(tree, { openingIds: [tree.id], mix: "theory" }, mulberry32(seed * 131));
    for (const id of line.nodeIds) {
      assert.notEqual(
        tree.nodes[id].moveKind,
        "opponent_mistake",
        `seed ${seed}: mix="theory" line sampled a mistake node`
      );
    }
  }
}

function testReplayIsIdentical(engine, tree) {
  const { createSession, mulberry32, submitMove, replayLine, expectedMove } = engine;
  const trees = { [tree.id]: tree };
  let session = createSession(trees, [tree.id], "mistakes", mulberry32(7));
  const originalNodeIds = [...session.run.line.nodeIds];

  // Dirty the run with one deliberately wrong attempt, then replay.
  const expected = expectedMove(tree, session.run.line, session.run.idx);
  const wrongUci = expected.uci === "e2e4" ? "d2d4" : "e2e4";
  const attempt = submitMove(session, wrongUci, "wrong-san");
  assert.equal(attempt.outcome.kind, "wrong");
  session = attempt.state;
  assert.equal(session.run.clean, false, "expected the run to be dirty after a wrong attempt");

  session = replayLine(session);
  assert.deepEqual(session.run.line.nodeIds, originalNodeIds, "replay produced a different pinned line");
  assert.equal(session.run.idx, 0, "replay should reset position to the start");
  assert.equal(session.run.clean, true, "replay should reset the clean flag");
  assert.equal(session.run.results.length, 0, "replay should reset per-move results");
}

function testWrongThenCorrectAccounting(engine, tree) {
  const { createSession, mulberry32, submitMove, advanceOpponentMove, expectedMove, nextMover, isLineComplete, accuracy } =
    engine;
  const trees = { [tree.id]: tree };
  // Content-agnostic: find a seed whose pinned line actually passes through a
  // mistake branch (specific mistakes change whenever the pipeline regenerates).
  let session = null;
  for (let seed = 1; seed <= 30 && !session; seed++) {
    const candidate = createSession(trees, [tree.id], "mistakes", mulberry32(seed));
    const hasMistake = candidate.run.line.nodeIds.some(
      (id) => tree.nodes[id].moveKind === "opponent_mistake"
    );
    if (hasMistake) session = candidate;
  }
  assert.ok(session, "no seed in 1..30 produced a line through a mistake branch");

  let handledWrongAttempt = false;
  let guard = 0;
  while (!isLineComplete(session.run.line, session.run.idx)) {
    if (++guard > 200) throw new Error("test loop did not terminate — possible infinite loop");
    const mover = nextMover(tree, session.run.line, session.run.idx);
    const expected = expectedMove(tree, session.run.line, session.run.idx);

    if (mover === "opponent") {
      session = advanceOpponentMove(session);
      continue;
    }

    const parent = tree.nodes[expected.parentId];
    if (!handledWrongAttempt && parent && parent.moveKind === "opponent_mistake") {
      // This is the punish move (parent is a mistake) — play a wrong move first.
      const wrongUci = expected.uci === "e2e4" ? "d2d4" : "e2e4";
      const wrongAttempt = submitMove(session, wrongUci, "wrong-san");
      assert.equal(wrongAttempt.outcome.kind, "wrong");
      assert.equal(wrongAttempt.outcome.feedback.correctSan, expected.san);
      session = wrongAttempt.state;
      handledWrongAttempt = true;
    }

    const correctAttempt = submitMove(session, expected.uci, expected.san);
    assert.equal(correctAttempt.outcome.kind, "correct");
    session = correctAttempt.state;
  }

  assert.ok(handledWrongAttempt, "never reached the punish move to exercise a wrong attempt against");
  assert.equal(session.run.clean, false, "a run with any mistake should not be clean");

  const punishResult = session.run.results.find((r) => {
    const parent = tree.nodes[tree.nodes[r.nodeId].parentId];
    return parent && parent.moveKind === "opponent_mistake";
  });
  assert.ok(punishResult, "no MoveResult recorded for the punish move");
  assert.equal(punishResult.firstTry, false, "punish move should not be firstTry after a wrong attempt");
  assert.equal(punishResult.attempts, 2, "punish move should have taken exactly 2 attempts");

  const userMoveCount = session.run.results.length;
  const firstTryCount = session.run.results.filter((r) => r.firstTry).length;
  assert.equal(session.stats.userMovesTotal, userMoveCount, "userMovesTotal should track every resolved user move");
  assert.equal(
    session.stats.userMovesFirstTryCorrect,
    firstTryCount,
    "userMovesFirstTryCorrect should track only first-try correct moves"
  );
  assert.equal(
    accuracy(session.stats),
    firstTryCount / userMoveCount,
    "accuracy() should equal first-try correct / total user moves"
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
  let engine;
  try {
    engine = await compileEngine();
    const tree = await loadItalianGameTree();

    const results = [];
    await runTest(results, 'mix="mistakes" samples mistake branches and pins full punish lines', () =>
      testMistakesAlwaysPunish(engine, tree)
    );
    await runTest(results, 'mix="theory" never samples a mistake child', () =>
      testTheoryNeverSamplesMistake(engine, tree)
    );
    await runTest(results, "replay returns identical nodeIds (no re-sampling)", () =>
      testReplayIsIdentical(engine, tree)
    );
    await runTest(
      results,
      "wrong-then-correct on the punish move: firstTry=false, attempts=2, clean=false, accuracy checks out",
      () => testWrongThenCorrectAccounting(engine, tree)
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
