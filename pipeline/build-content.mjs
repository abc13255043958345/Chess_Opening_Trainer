#!/usr/bin/env node
// CLI entry point for the build-time content pipeline.
//
//   node pipeline/build-content.mjs --eco C [--limit N] [--match substring] [--opening id]
//
// Builds OpeningTrees for the filtered catalog slice and merges them into
// public/content/eco-<X>.json + public/content/catalog.json (replacing only
// the rebuilt entries, keeping everything else untouched). Writes a run
// report to pipeline/reports/eco-<X>-report.json.
//
// See http.mjs / explorer.mjs for a flagged deviation: the Lichess Opening
// Explorer now requires an authenticated request (set LICHESS_TOKEN to a
// personal API access token to get real tree expansion beyond the catalog's
// defining line). This CLI still runs and produces valid output without a
// token - branches simply end at the defining line with endOfTheory
// {reason: "clear_plan"} instead of expanding.
//
// EVALS: evalCp comes from evals.mjs, which tries Lichess cloud-eval first
// (opportunistic - it's free and often already cached) behind a circuit
// breaker, and falls back to a local Stockfish (WASM, see engine.mjs) that
// never rate-limits. A run that hits a cloud-eval ban degrades to
// local-only evals instead of crashing; see the report's localEvals /
// cloudSkippedBreakerOpen / breakerOpened fields.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.mjs";
import { buildOpeningTree } from "./treegen.mjs";
import { counters as httpCounters } from "./http.mjs";
import { missCounter as cloudEvalMissCounter } from "./cloudeval.mjs";
import { counters as evalCounters } from "./evals.mjs";
import { counters as engineCounters, shutdownEngine } from "./engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const CONTENT_DIR = path.join(REPO_ROOT, "public", "content");
const REPORTS_DIR = path.join(__dirname, "reports");

// Load pipeline/.env (gitignored) so LICHESS_TOKEN doesn't have to be exported
// manually per shell. Real env vars win over the file.
try {
  const envText = await readFile(path.join(__dirname, ".env"), "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  // No .env file — fine, rely on the environment.
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--eco") args.eco = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--match") args.match = argv[++i];
    else if (arg === "--opening") args.opening = argv[++i];
    else if (arg === "--perspective") args.perspective = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.eco) throw new Error("--eco <letter> is required");
  if (args.perspective && !["white", "black"].includes(args.perspective)) {
    throw new Error(`--perspective must be "white" or "black", got: ${args.perspective}`);
  }
  if (args.perspective && !args.opening) {
    // The trainee-color heuristic (color of the defining line's last move) is right
    // for almost every opening; a blanket override only makes sense for one id at a
    // time (e.g. training the Wayward Queen Attack as the DEFENDING side).
    throw new Error("--perspective requires --opening <id> (it overrides one opening's trainee color)");
  }
  return args;
}

/** Returns a shallow copy of `record` with keys sorted ascending. */
function sortByKey(record) {
  const sorted = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}

/** Numbers a SAN move list, e.g. ["e4","e5","Nf3"] -> "1. e4 e5 2. Nf3". */
function formatDefiningLine(sanPath) {
  const parts = [];
  for (let i = 0; i < sanPath.length; i += 2) {
    const moveNumber = i / 2 + 1;
    const white = sanPath[i];
    const black = sanPath[i + 1];
    parts.push(black ? `${moveNumber}. ${white} ${black}` : `${moveNumber}. ${white}`);
  }
  return parts.join(" ");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const ecoLetter = args.eco.toUpperCase();

  if (!process.env.LICHESS_TOKEN) {
    console.warn(
      "[build-content] LICHESS_TOKEN is not set - the Lichess Opening Explorer now " +
        "requires auth (see explorer.mjs). Trees will only contain the catalog's " +
        "defining line; theory/mistake expansion will be skipped for every branch.",
    );
  }

  console.log(`[build-content] loading catalog...`);
  const catalog = await loadCatalog();

  let filtered = catalog.filter((e) => e.eco.startsWith(ecoLetter));
  if (args.opening) filtered = filtered.filter((e) => e.id === args.opening);
  if (args.match) {
    const needle = args.match.toLowerCase();
    filtered = filtered.filter((e) => e.name.toLowerCase().includes(needle));
  }
  filtered.sort((a, b) => a.id.localeCompare(b.id));
  if (Number.isFinite(args.limit)) filtered = filtered.slice(0, args.limit);

  if (args.perspective) {
    // Explicit trainee-color override (validated in parseArgs to be a single
    // --opening selection): e.g. train the Wayward Queen Attack as the side
    // DEFENDING against 2.Qh5 rather than the side playing it.
    filtered = filtered.map((e) =>
      e.perspective === args.perspective ? e : { ...e, perspective: args.perspective }
    );
    for (const e of filtered) {
      console.log(`[build-content] perspective override: ${e.id} -> ${args.perspective}`);
    }
  }

  console.log(`[build-content] ${filtered.length} openings selected for ECO ${ecoLetter}`);

  const builtTrees = [];
  const perOpeningStats = [];

  for (const entry of filtered) {
    const openingStartedAt = Date.now();
    const { tree, stats } = await buildOpeningTree(entry);
    const openingDurationSec = (Date.now() - openingStartedAt) / 1000;
    tree.nodes = sortByKey(tree.nodes);
    builtTrees.push({ entry, tree });

    const nodeValues = Object.values(tree.nodes);
    const nodeCount = nodeValues.length;
    const userMoveCount = nodeValues.filter((n) => n.mover === "user").length;
    const mistakeCount = nodeValues.filter((n) => n.moveKind === "opponent_mistake").length;
    perOpeningStats.push({
      id: entry.id,
      nodeCount,
      userMoveCount,
      mistakeCount,
      punishLineMissing: stats.punishLineMissing,
      thinMastersNodes: stats.thinMastersNodes,
      durationSec: openingDurationSec,
    });

    console.log(
      `[build-content] ${entry.name} (${entry.id}): ${nodeCount} nodes, ${userMoveCount} user moves, ` +
        `${mistakeCount} mistakes, ${stats.thinMastersNodes} thin-masters-fallback nodes in ${openingDurationSec.toFixed(1)}s | ` +
        `live=${httpCounters.liveRequests} cacheHits=${httpCounters.cacheHits} ` +
        `cloudEvalMisses=${cloudEvalMissCounter.count} localEvals=${engineCounters.localEvals} ` +
        `cloudSkippedBreakerOpen=${evalCounters.cloudSkippedBreakerOpen}` +
        `${evalCounters.breakerOpened ? " [breaker OPEN]" : ""}`,
    );
  }

  await mkdir(CONTENT_DIR, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });

  // --- Merge into public/content/eco-<X>.json ---
  const sectionPath = path.join(CONTENT_DIR, `eco-${ecoLetter}.json`);
  const existingSection = await readJsonIfExists(sectionPath);
  const section = existingSection ?? { eco: ecoLetter, generatedAt: new Date().toISOString(), trees: {} };
  section.eco = ecoLetter;
  section.generatedAt = new Date().toISOString();
  for (const { tree } of builtTrees) section.trees[tree.id] = tree;
  section.trees = sortByKey(section.trees);
  const sectionJson = JSON.stringify(section, null, 2);
  await writeFile(sectionPath, sectionJson, "utf8");

  // --- Merge into public/content/catalog.json ---
  const catalogPath = path.join(CONTENT_DIR, "catalog.json");
  const existingCatalog = await readJsonIfExists(catalogPath);
  const entryById = new Map((existingCatalog?.entries ?? []).map((e) => [e.id, e]));
  for (const { entry, tree } of builtTrees) {
    const nodeValues = Object.values(tree.nodes);
    entryById.set(entry.id, {
      id: entry.id,
      eco: entry.eco,
      name: entry.name,
      perspective: entry.perspective,
      line: formatDefiningLine(entry.sanPath),
      ply: entry.uciPath.length,
      nodeCount: nodeValues.length,
      userMoveCount: nodeValues.filter((n) => n.mover === "user").length,
      mistakeCount: nodeValues.filter((n) => n.moveKind === "opponent_mistake").length,
      file: `content/eco-${entry.eco.charAt(0).toUpperCase()}.json`,
    });
  }
  const catalogOut = {
    version: 1,
    generatedAt: new Date().toISOString(),
    // Per-section timestamps let the app detect that a cached section is stale
    // and re-download just that file (see src/lib/content.ts).
    sections: sortByKey({ ...(existingCatalog?.sections ?? {}), [ecoLetter]: section.generatedAt }),
    entries: [...entryById.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const catalogJson = JSON.stringify(catalogOut, null, 2);
  await writeFile(catalogPath, catalogJson, "utf8");

  // --- Report ---
  const totalNodes = perOpeningStats.reduce((sum, s) => sum + s.nodeCount, 0);
  const totalUserMoves = perOpeningStats.reduce((sum, s) => sum + s.userMoveCount, 0);
  const totalMistakes = perOpeningStats.reduce((sum, s) => sum + s.mistakeCount, 0);
  const punishLineMissing = perOpeningStats.reduce((sum, s) => sum + s.punishLineMissing, 0);
  const thinMastersNodes = perOpeningStats.reduce((sum, s) => sum + s.thinMastersNodes, 0);
  const bytesWritten = Buffer.byteLength(sectionJson, "utf8") + Buffer.byteLength(catalogJson, "utf8");

  const report = {
    openings: perOpeningStats.length,
    totalNodes,
    totalUserMoves,
    totalMistakes,
    liveRequests: httpCounters.liveRequests,
    cacheHits: httpCounters.cacheHits,
    cloudEvalMisses: cloudEvalMissCounter.count,
    // Local Stockfish (engine.mjs) / circuit-breaker stats (evals.mjs) - see
    // the eval-layer rework: cloud-eval is now opportunistic-first, local is
    // the reliable fallback, so these numbers show how much of the run
    // actually needed the fallback.
    localEvals: engineCounters.localEvals,
    cloudSkippedBreakerOpen: evalCounters.cloudSkippedBreakerOpen,
    breakerOpened: evalCounters.breakerOpened,
    punishLineMissing,
    // Nodes whose theory-reply source (opponent-to-move) or mainline pick
    // (user-to-move) fell back to the lichess pool / local engine because
    // masters data was too thin (< CONFIG.mastersGamesFloor) - see treegen.mjs.
    thinMastersNodes,
    durationSec: (Date.now() - startedAt) / 1000,
    bytesWritten,
  };

  const reportPath = path.join(REPORTS_DIR, `eco-${ecoLetter}-report.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`[build-content] wrote ${sectionPath}`);
  console.log(`[build-content] wrote ${catalogPath}`);
  console.log(`[build-content] wrote ${reportPath}`);
  console.log(`[build-content] report:`, report);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Shut down the local Stockfish engine (if it was ever booted) so the
    // process has nothing left holding the event loop open - without this,
    // a run that fell through to the local engine would hang after printing
    // the report instead of exiting.
    await shutdownEngine();
  });
