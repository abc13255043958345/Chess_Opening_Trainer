// Local Stockfish (WASM) engine wrapper - the rate-limit-immune eval source
// that Lichess cloud-eval now backs up instead of the other way around (see
// evals.mjs and DESIGN.md §2 step 4, whose original spec was exactly this:
// desktop Stockfish stamping evalCp at build time).
//
// VARIANT CHOSEN: "lite-single" - stockfish-18-lite-single.js/.wasm from the
// `stockfish` npm package (nmrugg/stockfish.js, currently Stockfish 18).
// Verified empirically with a throwaway probe script before wiring this in:
//   - `uci` reports `option name Threads type spin default 1 min 1 max 1` -
//     this build is hard-locked to a single thread, so it boots and searches
//     under plain Node with no worker_threads, no special V8 flags, and none
//     of the SharedArrayBuffer/COOP-COEP requirements the multi-threaded
//     builds need in a browser (irrelevant here anyway).
//   - ~7MB wasm (vs. ~113MB for the full NNUE build) and boots in well under a
//     second - the full build's size is aimed at a browser's one-time asset
//     fetch, not a build-time CLI tool invoked once per run.
//   - Empirically sane cp values: start position ~+0.3 to +0.45, clearly
//     losing lines (e.g. 1.e4 e5 2.Nf3 f6??, which hangs e5) > +1.0 by depth
//     14, and a scripted mate-in-1 position (Scholar's-mate setup) correctly
//     reports `score mate 1`.
//   - MultiPV works via the standard `setoption name MultiPV value N` + one
//     `info ... multipv N ...` line per requested line at the final depth.
// The full ("single", non-lite) single-threaded build was the fallback plan
// if "lite" proved too weak for punish-line quality, but wasn't needed -
// "lite" already finds Nxe5 immediately in the f6?? test above.
//
// The `stockfish` package's index.js expects the returned `engine` object's
// `.listener` property to receive every line the engine prints (UCI protocol
// is line-based text over what would be stdio in a native build) - there is
// no event-emitter API, just that one mutable callback slot.

import initEngine from "stockfish";
import { CONFIG } from "./config.mjs";

/** Tracks local-engine evals for the final report (see build-content.mjs). */
export const counters = { localEvals: 0 };

const MATE_SCORE_BASE = 3000;
const MATE_SCORE_PER_PLY = 10;

/**
 * Same clamped "moves to mate" -> centipawn-equivalent convention as
 * cloudeval.mjs's mateToCp (kept as an independent copy rather than a shared
 * import - it's a three-line formula, not worth coupling the two modules
 * over). Input must already be white-positive (positive = White mates).
 * @param {number} mateInMovesWhitePositive
 * @returns {number}
 */
function mateToCp(mateInMovesWhitePositive) {
  const sign = mateInMovesWhitePositive >= 0 ? 1 : -1;
  const pliesToMate = Math.abs(mateInMovesWhitePositive) * 2;
  const score = MATE_SCORE_BASE - pliesToMate * MATE_SCORE_PER_PLY;
  return sign * Math.max(0, Math.min(MATE_SCORE_BASE, score));
}

/** @param {string} fen @returns {"w" | "b"} */
function sideToMove(fen) {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}

const BOOT_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 60_000;

/** @type {Promise<any> | null} */
let enginePromise = null;
/** MultiPV currently set on the live engine, so we only send `setoption` on change. */
let currentMultiPv = 1;

/**
 * Waits for a specific engine output line (trimmed exact match), rejecting on
 * timeout. Temporarily owns `engine.listener` for the duration of the wait.
 */
function waitForLine(engine, expected, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      engine.listener = undefined;
      reject(new Error(`Local engine: timed out waiting for "${expected}"`));
    }, timeoutMs);
    engine.listener = (line) => {
      if (line.trim() === expected) {
        clearTimeout(timer);
        engine.listener = undefined;
        resolve();
      }
    };
  });
}

async function bootEngine() {
  // FLAGGED DEVIATION (real bug, worked around here rather than upstream):
  // the compiled Emscripten bundle detects Node (`global.process` present)
  // and, purely because native `fetch` already exists, unconditionally runs
  // `fetch = null` as part of its "am I in a worker/Node" setup shim (dead
  // code left over from supporting older Node versions that needed an
  // XMLHttpRequest-over-fs.readFile polyfill for asset loading). That nukes
  // Node's global fetch for the rest of the process - which would silently
  // break every future httpGet() call in http.mjs (used by explorer.mjs and
  // cloudeval.mjs) the first time the local engine boots. Save and restore it.
  const savedFetch = globalThis.fetch;
  const engine = await initEngine("lite-single");
  if (typeof globalThis.fetch !== "function") globalThis.fetch = savedFetch;

  const uciok = waitForLine(engine, "uciok", BOOT_TIMEOUT_MS);
  engine.sendCommand("uci");
  await uciok;
  const readyok = waitForLine(engine, "readyok", BOOT_TIMEOUT_MS);
  engine.sendCommand("isready");
  await readyok;
  return engine;
}

/** Lazily boots the singleton engine instance, reused for the whole run. */
function getEngine() {
  if (!enginePromise) enginePromise = bootEngine();
  return enginePromise;
}

// Internal promise queue: exactly one search in flight at a time. The engine
// is a single stateful UCI conversation (one `position` + `go` at a time);
// concurrent callers would otherwise race each other's `position`/`go`/output.
let queue = Promise.resolve();
function serialize(task) {
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

const INFO_MULTIPV_RE = /\bmultipv (\d+)/;
const INFO_SCORE_RE = /\bscore (cp|mate) (-?\d+)/;
const INFO_PV_RE = / pv (.+)$/;
const BESTMOVE_RE = /^bestmove\s+(\S+)/;

/**
 * Runs one `go depth D` search on `fen` at the given MultiPV. Resolves with
 * the deepest `info` line seen per multipv slot (the engine reprints all
 * slots at every completed depth, so "last seen per slot" == "final depth's
 * line" once `bestmove` arrives).
 * @returns {Promise<Map<number, {scoreType: "cp"|"mate", scoreValue: number, moves: string}>>}
 */
function runSearch(engine, fen, depth, multiPv) {
  return new Promise((resolve, reject) => {
    const infoByMultiPv = new Map();
    const timer = setTimeout(() => {
      engine.listener = undefined;
      reject(new Error(`Local engine search timed out (fen=${fen}, depth=${depth})`));
    }, SEARCH_TIMEOUT_MS);

    engine.listener = (line) => {
      const bestmoveMatch = BESTMOVE_RE.exec(line);
      if (bestmoveMatch) {
        clearTimeout(timer);
        engine.listener = undefined;
        resolve(infoByMultiPv);
        return;
      }
      if (!line.startsWith("info depth")) return;
      const multiPvMatch = INFO_MULTIPV_RE.exec(line);
      const scoreMatch = INFO_SCORE_RE.exec(line);
      const pvMatch = INFO_PV_RE.exec(line);
      if (!multiPvMatch || !scoreMatch || !pvMatch) return;
      infoByMultiPv.set(Number(multiPvMatch[1]), {
        scoreType: scoreMatch[1],
        scoreValue: Number(scoreMatch[2]),
        moves: pvMatch[1].trim(),
      });
    };

    if (currentMultiPv !== multiPv) {
      engine.sendCommand(`setoption name MultiPV value ${multiPv}`);
      currentMultiPv = multiPv;
    }
    engine.sendCommand(`position fen ${fen}`);
    engine.sendCommand(`go depth ${depth}`);
  });
}

/**
 * Local-engine eval. Same return shape as cloudeval.mjs's fetchCloudEval so
 * evals.mjs can use either interchangeably: cp is WHITE-POSITIVE (UCI's
 * `score cp`/`score mate` are relative to the side to move - flipped here),
 * mate scores go through the same clamped ±(3000 - pliesToMate*10) convention
 * as cloud-eval.
 * @param {string} fen
 * @param {{depth?: number, multiPv?: number}} [opts]
 * @returns {Promise<{cp: number, pvs: {moves: string, cp: number}[]}>}
 */
export async function localEval(fen, { depth = CONFIG.localEvalDepth, multiPv = 1 } = {}) {
  const engine = await getEngine();
  const infoByMultiPv = await serialize(() => runSearch(engine, fen, depth, multiPv));
  counters.localEvals++;

  const flip = sideToMove(fen) === "b" ? -1 : 1;
  const pvs = [...infoByMultiPv.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, info]) => {
      const whiteRelative = flip * info.scoreValue;
      const cp = info.scoreType === "cp" ? whiteRelative : mateToCp(whiteRelative);
      return { moves: info.moves, cp };
    });

  if (pvs.length === 0) {
    throw new Error(`Local engine produced no usable info lines for fen=${fen}`);
  }

  return { cp: pvs[0].cp, pvs };
}

/**
 * Sends `quit` to the engine (if it was ever booted) so the Node process has
 * nothing left holding it open. Safe to call even if localEval was never
 * called. Call once, at the very end of the run (see build-content.mjs).
 */
export async function shutdownEngine() {
  if (!enginePromise) return;
  const engine = await enginePromise.catch(() => null);
  if (!engine) return;
  engine.listener = undefined;
  engine.sendCommand("quit");
  enginePromise = null;
}
