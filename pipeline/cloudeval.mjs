// Lichess cloud-eval API client - the pre-computed Stockfish evals Lichess
// already has cached for positions that have been analyzed enough times.
//
// SIGN CONVENTION (verified empirically, see below): cp is already
// WHITE-POSITIVE. It is NOT relative to the side to move.
//   - fen after "1. e4 e5 2. Nf3 f6" (White to move, ...f6?? hangs e5): cp=+162.
//     White is to move and clearly better - consistent either way.
//   - fen after "1. e4" alone (BLACK to move): cp=+22. Theory says White has a
//     small edge after 1.e4; if cp were side-to-move-relative it would have
//     printed a small NEGATIVE number here (Black, who is worse, is to move).
//     It printed positive, so cp is white-positive regardless of whose turn
//     it is. No sign flip is applied below.
//
// A 404 means the position isn't in Lichess's cloud DB (cached as a miss,
// same as any other response) and callers get `null` back.
//
// RATE-LIMIT POSTURE: this endpoint is the one that has twice put this
// machine's IP into an extended 429 cooldown (see evals.mjs's circuit
// breaker, which is what actually makes the pipeline rate-limit-proof - this
// module just needs to fail fast instead of eating http.mjs's default
// multi-minute retry ladder). Every call here passes max429Retries: 1 to
// httpGet, so a persistent ban surfaces (and gets caught by evals.mjs) after
// one retry/one ~65s wait instead of five.

import { httpGet } from "./http.mjs";

const CLOUD_EVAL_URL = "https://lichess.org/api/cloud-eval";

/** Tracks cloud-eval misses (position not in the cloud DB) for the final report. */
export const missCounter = { count: 0 };

const MATE_SCORE_BASE = 3000;
const MATE_SCORE_PER_PLY = 10;

/**
 * Converts a signed "moves to mate" value (white-positive: positive = White
 * mates) into a clamped centipawn-equivalent score, per DESIGN's mate
 * convention. Lichess reports mate in moves; we approximate plies as
 * `movesToMate * 2` (an upper bound - the actual mating side may deliver mate
 * on their own move, one ply sooner, which this formula's clamp absorbs).
 * @param {number} mateInMoves
 * @returns {number}
 */
export function mateToCp(mateInMoves) {
  const sign = mateInMoves >= 0 ? 1 : -1;
  const pliesToMate = Math.abs(mateInMoves) * 2;
  const score = MATE_SCORE_BASE - pliesToMate * MATE_SCORE_PER_PLY;
  return sign * Math.max(0, Math.min(MATE_SCORE_BASE, score));
}

/**
 * @typedef {{ moves: string, cp: number }} CloudEvalPv
 * @typedef {{ cp: number, pvs: CloudEvalPv[] }} CloudEval
 */

/**
 * Fetches the cloud eval for a position.
 * @param {string} fen
 * @param {number} [multiPv]
 * @returns {Promise<CloudEval | null>} null if the position isn't in the cloud DB.
 */
export async function fetchCloudEval(fen, multiPv = 3) {
  const url = `${CLOUD_EVAL_URL}?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`;
  const { status, body } = await httpGet(url, { max429Retries: 1 });
  if (status === 404) {
    missCounter.count++;
    return null;
  }
  if (status !== 200) {
    console.warn(`[cloudeval] fetch failed (HTTP ${status}) for fen=${fen}`);
    missCounter.count++;
    return null;
  }
  const json = JSON.parse(body);
  const pvs = (json.pvs ?? []).map((pv) => ({
    moves: pv.moves,
    cp: typeof pv.cp === "number" ? pv.cp : mateToCp(pv.mate),
  }));
  if (pvs.length === 0) {
    missCounter.count++;
    return null;
  }
  return { cp: pvs[0].cp, pvs };
}
