#!/usr/bin/env node
// Unit tests for the SRS/mastery engine (src/lib/srs.ts) and the grading-event/replay
// plumbing it depends on in src/lib/practice.ts (DESIGN.md §5, §7).
//
// Same transpile trick as scripts/practice-engine-test.mjs: srs.ts and practice.ts
// have zero React/DOM/IO imports, so they're compiled standalone (no vite/vitest) and
// imported directly by plain node. This script:
//   1. Compiles src/lib/srs.ts, src/lib/practice.ts (+ tree.ts, types.ts, their only
//      deps) to scratch-test/ with `tsc` (module esnext, moduleResolution bundler —
//      same shape the app uses).
//   2. Patches the emitted bare specifiers Node's ESM loader can't resolve (tsc
//      doesn't rewrite extensions under esnext/bundler).
//   3. Runs five scenarios: (a) monotonicity, (b) decay, (c) lapse, (d) subtreeMastery
//      path-probability weighting, (e) the replay/isFirstRun grading-event rule.
//   4. Deletes scratch-test/ when done, pass or fail.
//
// Usage: node scripts/srs-test.mjs   (requires `tsc` reachable via npx)

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

async function compileEngines() {
  await cleanup();
  console.log("Compiling src/lib/srs.ts + src/lib/practice.ts (+ tree.ts, types.ts) to scratch-test/ …");
  execSync(
    [
      "npx tsc",
      "src/lib/srs.ts src/lib/practice.ts src/lib/tree.ts src/types.ts",
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

  const libDir = path.join(scratchDir, "lib");
  await patchBareSpecifier(path.join(libDir, "srs.js"), 'from "./tree"', 'from "./tree.js"');
  await patchBareSpecifier(path.join(libDir, "practice.js"), 'from "./tree"', 'from "./tree.js"');

  const srs = await import(pathToFileURL(path.join(libDir, "srs.js")).href);
  const practice = await import(pathToFileURL(path.join(libDir, "practice.js")).href);
  const tree = await import(pathToFileURL(path.join(libDir, "tree.js")).href);
  return { srs, practice, tree };
}

async function loadItalianGameTree() {
  const contentPath = path.join(root, "public", "content", "eco-C.json");
  const content = JSON.parse(await readFile(contentPath, "utf8"));
  const t = content.trees["c50-italian-game"];
  assert.ok(t, 'c50-italian-game tree not found in public/content/eco-C.json');
  return t;
}

// ---------- Scenarios ----------

// (a) Monotonicity: repeated firstTry successes → strictly growing intervals and score.
function testMonotonicity({ srs }) {
  const { gradeCard, nodeScore } = srs;
  const key = "test:node1";
  let card = null;
  let t = new Date("2026-01-01T00:00:00.000Z");
  const intervals = [];
  const scores = [];

  for (let i = 0; i < 5; i++) {
    card = gradeCard(card, { firstTry: true, hesitated: false, now: t, key, openingId: "test", nodeId: "node1" });
    intervals.push(card.intervalDays);
    // Score right at the moment of grading (daysSince == 0): retrievability is 1, so
    // this isolates the accuracy term, which strictly increases with correctStreak.
    scores.push(nodeScore(card, t));
    t = new Date(t.getTime() + card.intervalDays * 86_400_000);
  }

  for (let i = 1; i < intervals.length; i++) {
    assert.ok(
      intervals[i] > intervals[i - 1],
      `interval did not grow: ${intervals[i - 1]} -> ${intervals[i]} (streak ${i})`
    );
    assert.ok(
      scores[i] > scores[i - 1],
      `score did not grow: ${scores[i - 1]} -> ${scores[i]} (streak ${i})`
    );
  }
}

// (b) Decay: the same card scored later has a lower nodeScore.
function testDecay({ srs }) {
  const { gradeCard, nodeScore } = srs;
  const now = new Date("2026-01-01T00:00:00.000Z");
  const card = gradeCard(
    gradeCard(null, { firstTry: true, now, key: "test:node2", openingId: "test", nodeId: "node2" }),
    { firstTry: true, now: new Date(now.getTime() + 1 * 86_400_000), key: "test:node2", openingId: "test", nodeId: "node2" }
  );
  const immediate = nodeScore(card, new Date(card.lastSeen));
  const later = nodeScore(card, new Date(new Date(card.lastSeen).getTime() + card.intervalDays * 0.5 * 86_400_000));
  const muchLater = nodeScore(card, new Date(new Date(card.lastSeen).getTime() + card.intervalDays * 5 * 86_400_000));
  assert.ok(later < immediate, `expected decay: ${later} should be < ${immediate}`);
  assert.ok(muchLater < later, `expected further decay: ${muchLater} should be < ${later}`);
}

// (c) Lapse: a wrong answer resets streak/interval and drops the score.
function testLapse({ srs }) {
  const { gradeCard, nodeScore } = srs;
  const key = "test:node3";
  let t = new Date("2026-01-01T00:00:00.000Z");
  let card = gradeCard(null, { firstTry: true, now: t, key, openingId: "test", nodeId: "node3" });
  t = new Date(t.getTime() + card.intervalDays * 86_400_000);
  card = gradeCard(card, { firstTry: true, now: t, key, openingId: "test", nodeId: "node3" });
  t = new Date(t.getTime() + card.intervalDays * 86_400_000);
  card = gradeCard(card, { firstTry: true, now: t, key, openingId: "test", nodeId: "node3" });

  const scoreBeforeLapse = nodeScore(card, new Date(card.lastSeen));
  const easeBeforeLapse = card.easeFactor;
  const streakBeforeLapse = card.correctStreak;
  assert.ok(streakBeforeLapse >= 3, "expected a multi-success streak before lapsing");

  const lapsed = gradeCard(card, { firstTry: false, now: t, key, openingId: "test", nodeId: "node3" });
  assert.equal(lapsed.correctStreak, 0, "lapse should reset correctStreak to 0");
  assert.equal(lapsed.intervalDays, 1, "lapse should reset intervalDays to 1 (due tomorrow)");
  assert.equal(lapsed.lapses, (card.lapses ?? 0) + 1, "lapse should increment lapses");
  assert.ok(lapsed.easeFactor < easeBeforeLapse, "lapse should drop easeFactor");

  const scoreAfterLapse = nodeScore(lapsed, new Date(lapsed.lastSeen));
  assert.ok(
    scoreAfterLapse < scoreBeforeLapse,
    `lapse should drop the score: ${scoreBeforeLapse} -> ${scoreAfterLapse}`
  );
  assert.equal(scoreAfterLapse, 0, "score should be exactly 0 right after a lapse (streak reset to 0)");
}

// (d) subtreeMastery: a popular-but-weak branch drags the whole subtree down more
// than an equally-weak unpopular branch does (path-probability weighting works).
function testSubtreeMastery({ srs, tree }) {
  const { subtreeMastery, gradeCard } = srs;
  const { createEmptyTree, addMove } = tree;

  function buildTree(id, popularWeight, unpopularWeight) {
    const t = createEmptyTree(id, "X99", "Test opening", "black");
    // Root: white (opponent) to move, two candidate replies.
    const e4 = addMove(t, t.rootId, {
      san: "e4",
      uci: "e2e4",
      fen: "8/8/8/8/8/8/8/8 b - - 0 1",
      moveKind: "mainline",
      weight: popularWeight,
    });
    const d4 = addMove(t, t.rootId, {
      san: "d4",
      uci: "d2d4",
      fen: "8/8/8/8/8/8/8/8 b - - 0 1",
      moveKind: "mainline",
      weight: unpopularWeight,
    });
    // Black (user) to move under each — exactly one mainline continuation, per node.
    addMove(t, e4.id, { san: "e5", uci: "e7e5", fen: "8/8/8/8/8/8/8/8 w - - 0 1", moveKind: "mainline" });
    addMove(t, d4.id, { san: "d5", uci: "d7d5", fen: "8/8/8/8/8/8/8/8 w - - 0 1", moveKind: "mainline" });
    return t;
  }

  const now = new Date("2026-01-01T00:00:00.000Z");
  // A strong card: several clean successes. Evaluated (below) right at its own
  // lastSeen, so retrievability is 1 and the score isolates the accuracy term.
  let strongCard = null;
  let t = now;
  for (let i = 0; i < 6; i++) {
    strongCard = gradeCard(strongCard, {
      firstTry: true,
      now: t,
      key: "k",
      openingId: "k",
      nodeId: "k",
    });
    t = new Date(t.getTime() + strongCard.intervalDays * 86_400_000);
  }
  const evalAt = new Date(strongCard.lastSeen);

  // Tree A: the POPULAR branch (e4, 90%) is weak (never seen); the unpopular one (d4,
  // 10%) is strong.
  const treeA = buildTree("tree-a", 0.9, 0.1);
  const e5A = treeA.nodes[Object.values(treeA.nodes).find((n) => n.san === "e5").id];
  const d5A = treeA.nodes[Object.values(treeA.nodes).find((n) => n.san === "d5").id];
  const cardsA = new Map([[`tree-a:${d5A.id}`, { ...strongCard, key: `tree-a:${d5A.id}`, openingId: "tree-a", nodeId: d5A.id }]]);
  const masteryA = subtreeMastery(treeA, treeA.rootId, cardsA, evalAt);

  // Tree B: same shape, weights swapped — the UNPOPULAR branch (e4, 10%) is now the
  // weak one, and the popular one (d4, 90%) is strong.
  const treeB = buildTree("tree-b", 0.1, 0.9);
  const d5B = treeB.nodes[Object.values(treeB.nodes).find((n) => n.san === "d5").id];
  const cardsB = new Map([[`tree-b:${d5B.id}`, { ...strongCard, key: `tree-b:${d5B.id}`, openingId: "tree-b", nodeId: d5B.id }]]);
  const masteryB = subtreeMastery(treeB, treeB.rootId, cardsB, evalAt);

  assert.ok(
    masteryA < masteryB,
    `expected the popular-branch-is-weak tree to score lower: A=${masteryA} should be < B=${masteryB}`
  );
  assert.ok(masteryA < 50, `expected tree A (popular branch weak) well below 50: got ${masteryA}`);
  assert.ok(masteryB > 50, `expected tree B (only unpopular branch weak) well above 50: got ${masteryB}`);

  void e5A; // referenced only to document which node is the (unscored) weak one
}

// (e) Replay rule: the grading-event stream from a line run marks isFirstRun
// correctly across replayLine (DESIGN §4.1.5/§7).
function testReplayGradingEvents({ practice }, italianTree) {
  const { createSession, mulberry32, submitMove, advanceOpponentMove, replayLine, nextMover, isLineComplete, expectedMove } =
    practice;
  const trees = { [italianTree.id]: italianTree };
  let session = createSession(trees, [italianTree.id], "theory", mulberry32(11));

  const events = [];
  function driveToFirstUserMove() {
    while (nextMover(italianTree, session.run.line, session.run.idx) === "opponent") {
      session = advanceOpponentMove(session);
    }
  }

  driveToFirstUserMove();
  assert.ok(!isLineComplete(session.run.line, session.run.idx), "expected a pending user move");
  let expected = expectedMove(italianTree, session.run.line, session.run.idx);

  // First run, deliberately wrong then correct: only the correct attempt emits a
  // grading event, and it must be firstTry=false, isFirstRun=true.
  const wrongUci = expected.uci === "e2e4" ? "d2d4" : "e2e4";
  const wrongAttempt = submitMove(session, wrongUci, "wrong-san");
  assert.equal(wrongAttempt.outcome.kind, "wrong", "expected the deliberately-wrong attempt to be rejected");
  session = wrongAttempt.state;

  const correctAttempt = submitMove(session, expected.uci, expected.san);
  assert.equal(correctAttempt.outcome.kind, "correct");
  events.push(correctAttempt.outcome.gradingEvent);
  session = correctAttempt.state;

  assert.equal(events[0].isFirstRun, true, "first run's grading event should have isFirstRun=true");
  assert.equal(events[0].firstTry, false, "the wrong attempt before it should make firstTry=false");
  assert.equal(events[0].nodeId, expected.id);

  // Replay: same pinned line, fresh run one level deeper. This time play correctly
  // immediately — the grading event must now say isFirstRun=false (a touch, not a
  // grade), even though firstTry=true this time.
  session = replayLine(session);
  assert.equal(session.run.runIndex, 1, "replayLine should increment runIndex");
  driveToFirstUserMove();
  expected = expectedMove(italianTree, session.run.line, session.run.idx);
  const replayAttempt = submitMove(session, expected.uci, expected.san);
  assert.equal(replayAttempt.outcome.kind, "correct");
  events.push(replayAttempt.outcome.gradingEvent);

  assert.equal(events[1].isFirstRun, false, "a replay's grading event should have isFirstRun=false");
  assert.equal(events[1].firstTry, true, "a clean replay attempt should still report firstTry=true");
  assert.equal(events[1].nodeId, expected.id, "replay should re-visit the same pinned node");
  assert.equal(events[1].key, events[0].key, "replay should regrade/touch the same card key");
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
  let engines;
  try {
    engines = await compileEngines();
    const italianTree = await loadItalianGameTree();

    const results = [];
    await runTest(results, "(a) monotonicity: repeated firstTry successes grow interval and score strictly", () =>
      testMonotonicity(engines)
    );
    await runTest(results, "(b) decay: nodeScore drops as time since lastSeen grows", () => testDecay(engines));
    await runTest(results, "(c) lapse: wrong answer resets streak/interval and drops score to 0", () =>
      testLapse(engines)
    );
    await runTest(
      results,
      "(d) subtreeMastery: a weak popular branch scores lower than an equally-weak unpopular one",
      () => testSubtreeMastery(engines)
    );
    await runTest(
      results,
      "(e) replay rule: grading-event stream marks isFirstRun correctly across replayLine",
      () => testReplayGradingEvents(engines, italianTree)
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
