// Unified eval entry point - the ONLY module treegen.mjs calls into for
// evalCp. Lichess cloud-eval is tried first opportunistically (it's free,
// often already has the position cached, and can be deeper than our local
// search); a circuit breaker keeps a rate-limit ban from ever taking the run
// down: the first persistent-429 permanently disables cloud-eval for the rest
// of the run and every subsequent call goes straight to the local engine
// (engine.mjs). That's what makes the pipeline rate-limit-proof - at most one
// or two live lichess.org/api/cloud-eval requests happen per run, no matter
// how many thousands of nodes need an eval.
//
// A cloud MISS (HTTP 404 - position genuinely isn't in Lichess's DB) is not a
// failure and does not touch the breaker: it falls through to local exactly
// like a breaker-open skip, just counted separately (cloudeval.mjs's own
// missCounter, unchanged from before this rework).

import { fetchCloudEval } from "./cloudeval.mjs";
import { localEval } from "./engine.mjs";
import { CONFIG } from "./config.mjs";

/** Circuit-breaker counters, read by build-content.mjs for the final report. */
export const counters = {
  // Calls that skipped cloud-eval entirely because the breaker was already
  // open (does NOT include the one call whose persistent-429 opened it).
  cloudSkippedBreakerOpen: 0,
  // Whether the breaker tripped at all this run - a one-shot flag, not a count.
  breakerOpened: false,
};

// LICHESS_NO_CLOUD=1 starts the run with the breaker already open: bulk
// generation runs (many cold positions) shouldn't pay a throttled live
// cloud-eval attempt per node when the local engine answers in milliseconds.
// Cloud-eval stays worthwhile for small/incremental runs where positions are
// likely already in Lichess's cache — leave the flag unset there.
let breakerOpen = process.env.LICHESS_NO_CLOUD === "1";

/**
 * @param {string} fen
 * @param {{multiPv?: number, localDepth?: number}} [opts]
 *   multiPv: how many PVs to request (cloud-eval's own default is 3; pass 1
 *   when only the top line matters, cheaper for a local-engine fallback).
 *   localDepth: search depth IF this call falls through to the local engine
 *   (see engine.mjs's localEvalDepth/localPunishDepth in config.mjs - a
 *   punish-line PV needs to be deeper than a routine evalCp stamp).
 * @returns {Promise<{cp: number, pvs: {moves: string, cp: number}[]}>}
 */
export async function getEval(fen, { multiPv = 3, localDepth = CONFIG.localEvalDepth } = {}) {
  if (!breakerOpen) {
    try {
      const cloud = await fetchCloudEval(fen, multiPv);
      if (cloud) return cloud;
      // 404 miss, or a non-200/non-404 already logged by cloudeval.mjs and
      // treated as a miss there - either way, fall through to local below.
    } catch (err) {
      if (err.persistentRateLimit) {
        breakerOpen = true;
        counters.breakerOpened = true;
        console.warn(
          "[evals] persistent HTTP 429 from Lichess cloud-eval - opening the circuit " +
            "breaker. Every eval for the rest of this run comes from the local engine.",
        );
      } else {
        // Some other cloud failure (network error, etc.) - don't trip the
        // breaker for it (may be transient or position-specific); just fall
        // through to local for this one call and keep trying cloud-eval on
        // the next.
        console.warn(`[evals] cloud-eval failed for fen=${fen}: ${err.message}`);
      }
    }
  } else {
    counters.cloudSkippedBreakerOpen++;
  }
  return localEval(fen, { depth: localDepth, multiPv });
}
