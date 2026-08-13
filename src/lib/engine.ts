// In-app Stockfish engine client (DESIGN.md §4.3, §4.4, §6 M4). Runs the same
// "lite-single" single-threaded build the content pipeline uses (see
// pipeline/engine.mjs's header comment for why that variant was chosen — same
// reasoning applies here, plus: single-threaded is REQUIRED in the browser because
// GitHub Pages can't serve the COOP/COEP response headers the multi-threaded builds
// need for SharedArrayBuffer). The .js/.wasm pair is copied out of the `stockfish`
// npm package into public/engine/ by vite.config.ts (see its comment) so it ships as
// a plain static asset that resolves correctly under any base path.
//
// Boots lazily on the first evaluate() call (7MB wasm — not worth taxing initial
// load) and stays booted as a module-level singleton for the rest of the session.
//
// UCI protocol shape (confirmed by inspecting stockfish-18-lite-single.js directly:
// when it detects it's running as a dedicated Worker — no `window.document`, no
// Node `process` — it sets `listener: function(e){ postMessage(e) }`, i.e. every
// engine output line is postMessage'd back verbatim, one line per message, and it
// expects commands the same way: `worker.postMessage("uci")`, `"go depth 12"`, etc.
// This mirrors pipeline/engine.mjs's runSearch/localEval parsing/sign conventions
// exactly (same regexes, same white-positive cp flip, same mate→cp clamp) since it's
// the same engine build talking the same protocol - only the transport differs
// (Worker postMessage here vs. the `stockfish` npm package's Node listener there).
//
// Latest-wins cancellation: only one UCI "conversation" can be in flight at a time
// (it's one stateful engine process), so a newly-requested *different* position sends
// `stop` to abort whatever's running, marks that in-flight request `cancelled`, and
// queues the new one to start the moment the old search's `bestmove` drains. A
// request for the SAME position/depth/multiPv as one already running/queued just
// piggybacks on it instead of starting a redundant search.

import { Chess } from "chess.js";

const MATE_SCORE_BASE = 3000;
const MATE_SCORE_PER_PLY = 10;
const DEFAULT_DEPTH = 12;
const DEFAULT_MULTIPV = 1;
const BOOT_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;
/** How many PV moves to convert to SAN — plenty for any UI display (Explorer shows ~6). */
const MAX_PV_SAN_MOVES = 16;

function engineScriptUrl(): string {
  return `${import.meta.env.BASE_URL}engine/stockfish-18-lite-single.js`;
}

/** Same clamped "moves to mate" -> centipawn-equivalent convention as
 *  pipeline/engine.mjs's mateToCp. Input must already be white-positive. */
function mateToCp(mateInMovesWhitePositive: number): number {
  const sign = mateInMovesWhitePositive >= 0 ? 1 : -1;
  const pliesToMate = Math.abs(mateInMovesWhitePositive) * 2;
  const score = MATE_SCORE_BASE - pliesToMate * MATE_SCORE_PER_PLY;
  return sign * Math.max(0, Math.min(MATE_SCORE_BASE, score));
}

function sideToMove(fen: string): "w" | "b" {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}

/** UCI move list ("e2e4 e7e5 g1f3 …") -> SAN, replayed from `fen`. Stops early (rather
 *  than throwing) on the first illegal/unparseable move — defensive only; a PV the
 *  engine itself produced should always be legal from its own search position. */
function uciPvToSan(fen: string, pvUci: string, maxMoves = MAX_PV_SAN_MOVES): string[] {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return [];
  }
  const sans: string[] = [];
  for (const uci of pvUci.trim().split(/\s+/).filter(Boolean)) {
    if (sans.length >= maxMoves) break;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    let mv;
    try {
      mv = chess.move({ from, to, promotion });
    } catch {
      mv = null;
    }
    if (!mv) break;
    sans.push(mv.san);
  }
  return sans;
}

// ---------- Public types ----------

export interface EnginePv {
  sanLine: string[];
  /** White-positive centipawns (mate scores pre-clamped through mateToCp). */
  cp: number;
}

export interface EngineEvalResult {
  /** White-positive centipawns; null only when the engine produced no usable info
   *  at all (e.g. a position with no legal moves). */
  cp: number | null;
  /** White-positive "moves to mate" (positive = White mates, negative = White gets
   *  mated); null when the position isn't a forced mate at the searched depth. */
  mateIn: number | null;
  pvs: EnginePv[];
}

export interface EvaluateOptions {
  /** Search depth. Default 12 (DESIGN §4.3: 12–16, ~200ms — keeps the phone cool). */
  depth?: number;
  /** Number of principal variations. Default 1. */
  multiPv?: number;
  /** Aborting cancels just this caller's wait; it does not necessarily stop the
   *  underlying engine search if other callers are still waiting on the same one. */
  signal?: AbortSignal;
}

export interface EngineClient {
  evaluate(fen: string, opts?: EvaluateOptions): Promise<EngineEvalResult>;
}

/** Thrown when a request is superseded by a newer one for a different position
 *  before it produced a result, or when its own AbortSignal fires. Callers that only
 *  care about the latest position should catch-and-ignore this specific error. */
export class EngineCancelledError extends Error {
  constructor(message = "Engine request cancelled") {
    super(message);
    this.name = "EngineCancelledError";
  }
}

// ---------- Internal request bookkeeping ----------

interface Resolver {
  resolve: (r: EngineEvalResult) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface InternalRequest {
  fen: string;
  depth: number;
  multiPv: number;
  resolvers: Resolver[];
  /** Set once a newer, different-position request supersedes this one while it's
   *  still the active (in-flight) search — its eventual bestmove is discarded. */
  cancelled: boolean;
}

interface InfoLine {
  scoreType: "cp" | "mate";
  scoreValue: number;
  moves: string;
}

const INFO_MULTIPV_RE = /\bmultipv (\d+)/;
const INFO_SCORE_RE = /\bscore (cp|mate) (-?\d+)/;
const INFO_PV_RE = / pv (.+)$/;
const BESTMOVE_RE = /^bestmove\s+(\S+)/;

class EngineClientImpl implements EngineClient {
  private worker: Worker | null = null;
  private bootPromise: Promise<void> | null = null;
  private active: InternalRequest | null = null;
  private queued: InternalRequest | null = null;
  private infoByMultiPv = new Map<number, InfoLine>();
  private currentMultiPvOption = DEFAULT_MULTIPV;
  private stopSent = false;
  private searchTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  async evaluate(fen: string, opts: EvaluateOptions = {}): Promise<EngineEvalResult> {
    const depth = opts.depth ?? DEFAULT_DEPTH;
    const multiPv = Math.max(1, opts.multiPv ?? DEFAULT_MULTIPV);
    if (opts.signal?.aborted) throw new EngineCancelledError("aborted before start");

    await this.ensureBooted();

    return new Promise<EngineEvalResult>((resolve, reject) => {
      const resolver: Resolver = { resolve, reject, signal: opts.signal };

      const matches = (req: InternalRequest | null): boolean =>
        !!req && req.fen === fen && req.depth === depth && req.multiPv === multiPv;

      const activeReq = this.active;
      const queuedReq = this.queued;

      let target: InternalRequest;
      if (activeReq && matches(activeReq)) {
        target = activeReq;
        target.resolvers.push(resolver);
      } else if (queuedReq && matches(queuedReq)) {
        target = queuedReq;
        target.resolvers.push(resolver);
      } else {
        target = { fen, depth, multiPv, resolvers: [resolver], cancelled: false };
        if (!activeReq) {
          this.active = target;
          this.startSearch(target);
        } else {
          // Supersede whatever's currently running and whatever was queued behind it.
          activeReq.cancelled = true;
          if (queuedReq) this.rejectRequest(queuedReq, new EngineCancelledError("superseded"));
          this.queued = target;
          if (!this.stopSent) {
            this.stopSent = true;
            this.worker!.postMessage("stop");
          }
        }
      }

      if (opts.signal) {
        const onAbort = () => {
          const idx = target.resolvers.indexOf(resolver);
          if (idx >= 0) target.resolvers.splice(idx, 1);
          reject(new EngineCancelledError("aborted"));
        };
        resolver.onAbort = onAbort;
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private async ensureBooted(): Promise<void> {
    if (!this.bootPromise) {
      this.bootPromise = this.bootWorker().catch((err) => {
        // Allow a later evaluate() call to retry booting instead of being wedged.
        this.bootPromise = null;
        this.worker = null;
        throw err;
      });
    }
    await this.bootPromise;
  }

  private async bootWorker(): Promise<void> {
    const worker = new Worker(engineScriptUrl());

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Engine boot timed out waiting for uciok")),
        BOOT_TIMEOUT_MS
      );
      worker.onmessage = (ev) => {
        if (String(ev.data).trim() === "uciok") {
          clearTimeout(timer);
          resolve();
        }
      };
      worker.onerror = (ev) => {
        clearTimeout(timer);
        reject(new Error(`Engine worker failed to boot: ${ev.message}`));
      };
      worker.postMessage("uci");
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Engine boot timed out waiting for readyok")),
        BOOT_TIMEOUT_MS
      );
      worker.onmessage = (ev) => {
        if (String(ev.data).trim() === "readyok") {
          clearTimeout(timer);
          resolve();
        }
      };
      worker.postMessage("isready");
    });

    worker.onmessage = (ev) => this.handleLine(String(ev.data));
    worker.onerror = (ev) => this.handleWorkerError(new Error(`Engine worker error: ${ev.message}`));
    this.worker = worker;
  }

  private startSearch(req: InternalRequest): void {
    this.infoByMultiPv.clear();
    this.stopSent = false;
    if (this.currentMultiPvOption !== req.multiPv) {
      this.worker!.postMessage(`setoption name MultiPV value ${req.multiPv}`);
      this.currentMultiPvOption = req.multiPv;
    }
    this.worker!.postMessage(`position fen ${req.fen}`);
    this.worker!.postMessage(`go depth ${req.depth}`);

    if (this.searchTimeoutHandle) clearTimeout(this.searchTimeoutHandle);
    this.searchTimeoutHandle = setTimeout(() => {
      this.handleWorkerError(new Error(`Engine search timed out (fen=${req.fen}, depth=${req.depth})`));
    }, SEARCH_TIMEOUT_MS);
  }

  private handleLine(line: string): void {
    const bestmoveMatch = BESTMOVE_RE.exec(line);
    if (bestmoveMatch) {
      this.onBestmove();
      return;
    }
    if (!line.startsWith("info depth")) return;
    const multiPvMatch = INFO_MULTIPV_RE.exec(line);
    const scoreMatch = INFO_SCORE_RE.exec(line);
    const pvMatch = INFO_PV_RE.exec(line);
    if (!multiPvMatch || !scoreMatch || !pvMatch) return;
    this.infoByMultiPv.set(Number(multiPvMatch[1]), {
      scoreType: scoreMatch[1] as "cp" | "mate",
      scoreValue: Number(scoreMatch[2]),
      moves: pvMatch[1].trim(),
    });
  }

  private onBestmove(): void {
    if (this.searchTimeoutHandle) {
      clearTimeout(this.searchTimeoutHandle);
      this.searchTimeoutHandle = null;
    }
    const finished = this.active;
    this.active = null;
    if (finished) {
      if (finished.cancelled) {
        this.rejectRequest(finished, new EngineCancelledError("superseded"));
      } else {
        const result = this.buildResult(finished.fen);
        for (const r of finished.resolvers) {
          r.signal?.removeEventListener("abort", r.onAbort!);
          r.resolve(result);
        }
      }
    }
    if (this.queued) {
      const next = this.queued;
      this.queued = null;
      this.active = next;
      this.startSearch(next);
    }
  }

  private buildResult(fen: string): EngineEvalResult {
    const flip = sideToMove(fen) === "b" ? -1 : 1;
    const entries = [...this.infoByMultiPv.entries()].sort((a, b) => a[0] - b[0]);
    if (entries.length === 0) return { cp: null, mateIn: null, pvs: [] };

    const pvs: EnginePv[] = entries.map(([, info]) => {
      const whiteRelative = flip * info.scoreValue;
      const cp = info.scoreType === "cp" ? whiteRelative : mateToCp(whiteRelative);
      return { sanLine: uciPvToSan(fen, info.moves), cp };
    });

    const top = entries[0][1];
    const topWhiteRelative = flip * top.scoreValue;
    const mateIn = top.scoreType === "mate" ? topWhiteRelative : null;
    const cp = top.scoreType === "cp" ? topWhiteRelative : mateToCp(topWhiteRelative);
    return { cp, mateIn, pvs };
  }

  private rejectRequest(req: InternalRequest, err: unknown): void {
    for (const r of req.resolvers) {
      r.signal?.removeEventListener("abort", r.onAbort!);
      r.reject(err);
    }
  }

  /** Worker crashed, WASM failed to instantiate, or a search hung — tear down and
   *  let the next evaluate() call boot a fresh worker rather than staying wedged. */
  private handleWorkerError(err: Error): void {
    if (this.searchTimeoutHandle) {
      clearTimeout(this.searchTimeoutHandle);
      this.searchTimeoutHandle = null;
    }
    const active = this.active;
    const queued = this.queued;
    this.active = null;
    this.queued = null;
    if (active) this.rejectRequest(active, err);
    if (queued) this.rejectRequest(queued, err);
    try {
      this.worker?.terminate();
    } catch {
      // ignore
    }
    this.worker = null;
    this.bootPromise = null;
    this.stopSent = false;
  }
}

let singleton: EngineClientImpl | null = null;

/** The app-wide engine singleton. Boots lazily on first evaluate(). */
export function getEngine(): EngineClient {
  if (!singleton) singleton = new EngineClientImpl();
  return singleton;
}
