// Lichess Explorer API client (masters database + the 1600-2000 lichess pool).
//
// FLAGGED DEVIATION: as of this build, explorer.lichess.ovh requires an
// authenticated (OAuth2) request for /masters, /lichess and /player - see the
// note in http.mjs. This module sends `Authorization: Bearer <LICHESS_TOKEN>`
// when that env var is set (a personal API access token from
// https://lichess.org/account/oauth/token works; no scope is required). Without
// a token every call below returns null and logs a one-time warning, since the
// endpoints reject anonymous requests outright (no graceful "no data" response
// to fall back on).
//
// FLAGGED DEVIATION (added during the eval-layer rework, see evals.mjs):
// explorer.lichess.ovh 429s occasionally too, not just lichess.org's
// cloud-eval - and a persistent 429 makes http.mjs throw. That must not take
// the whole multi-hour build down either, so any thrown error here (429
// exhausted, network error exhausted, etc.) is caught and treated as "no
// data" (see safeExplorerGet below), same graceful contract as the no-token
// 401 case already had. There's no local fallback for Explorer data the way
// evals.mjs has the local engine for evalCp, so this module's breaker is
// simpler: on the FIRST persistent 429 it stops attempting live requests
// entirely for the rest of the run (cache hits still work fine) rather than
// re-paying http.mjs's up-to-5-retry/65s-each ladder on every single
// uncached position - a real extended ban would otherwise turn "some
// branches stop expanding" into "the run takes hours retrying a dead host."

import { httpGet } from "./http.mjs";
import { CONFIG } from "./config.mjs";

const MASTERS_URL = "https://explorer.lichess.ovh/masters";
const LICHESS_POOL_URL = "https://explorer.lichess.ovh/lichess";

let warnedNoToken = false;
let warnedRateLimit = false;
/** Tripped by the first persistent 429; see module header comment. */
let breakerOpen = false;

/**
 * Runs an Explorer httpGet, converting ANY thrown error (persistent 429 after
 * http.mjs's retries, a network error after its retries, etc.) into a null
 * result instead of letting it propagate - same "graceful degradation, never
 * crash the run" contract this module already has for a 401 (no token). The
 * caller treats null exactly like "theory ran out" / "no mistake pool data"
 * (see treegen.mjs), which is the correct behavior either way: an Explorer
 * outage means we have nothing to expand this branch with, not that the
 * whole multi-hour build should die.
 * @returns {Promise<{status: number, body: string} | null>}
 */
async function safeExplorerGet(url, headers) {
  try {
    // Once the breaker is open, a cache miss returns null immediately
    // instead of ever touching the network (a cache HIT still returns real
    // data either way - see http.mjs's skipNetworkIfMiss).
    return await httpGet(url, { headers, skipNetworkIfMiss: breakerOpen });
  } catch (err) {
    if (err.persistentRateLimit) breakerOpen = true;
    if (!warnedRateLimit) {
      console.warn(
        `[explorer] request failed (${err.message}) - Explorer data will be treated as ` +
          `unavailable for the rest of this run${breakerOpen ? " (circuit breaker open - no more live requests)" : ""}. ` +
          `Branches simply stop expanding early (endOfTheory) instead of the build crashing.`,
      );
      warnedRateLimit = true;
    }
    return null;
  }
}

function authHeaders() {
  const token = process.env.LICHESS_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * @typedef {{
 *   uci: string,
 *   san: string,
 *   white: number,
 *   draws: number,
 *   black: number,
 *   share: number,
 * }} ExplorerMove
 */

/**
 * @typedef {{
 *   totalGames: number,
 *   moves: ExplorerMove[],
 * }} ExplorerResult
 */

/**
 * @param {any} json
 * @returns {ExplorerResult}
 */
function toResult(json) {
  const white = json.white ?? 0;
  const draws = json.draws ?? 0;
  const black = json.black ?? 0;
  const totalGames = white + draws + black;
  const moves = (json.moves ?? []).map((m) => {
    const moveGames = (m.white ?? 0) + (m.draws ?? 0) + (m.black ?? 0);
    return {
      uci: m.uci,
      san: m.san,
      white: m.white ?? 0,
      draws: m.draws ?? 0,
      black: m.black ?? 0,
      share: totalGames > 0 ? moveGames / totalGames : 0,
    };
  });
  return { totalGames, moves };
}

/**
 * Fetches masters-database stats for a position.
 * @param {string} fen
 * @returns {Promise<ExplorerResult | null>} null if the Explorer API rejected the request (e.g. no auth token).
 */
export async function fetchMasters(fen) {
  const url = `${MASTERS_URL}?fen=${encodeURIComponent(fen)}&topGames=0&moves=12`;
  const result = await safeExplorerGet(url, authHeaders());
  if (!result) return null;
  const { status, body } = result;
  if (status === 401) {
    if (!warnedNoToken) {
      console.warn(
        "[explorer] 401 from Lichess Explorer API - it now requires auth. " +
          "Set LICHESS_TOKEN (a personal access token) to enable tree expansion.",
      );
      warnedNoToken = true;
    }
    return null;
  }
  if (status !== 200) {
    console.warn(`[explorer] masters fetch failed (HTTP ${status}) for fen=${fen}`);
    return null;
  }
  return toResult(JSON.parse(body));
}

/**
 * Fetches lichess-pool stats (club-level speeds, 1600-2000 rating band) for a position.
 * @param {string} fen
 * @returns {Promise<ExplorerResult | null>} null if the Explorer API rejected the request (e.g. no auth token).
 */
export async function fetchLichessPool(fen) {
  const speeds = CONFIG.lichessSpeeds.join(",");
  const ratings = CONFIG.lichessRatings.join(",");
  const url =
    `${LICHESS_POOL_URL}?variant=standard&speeds=${speeds}&ratings=${ratings}` +
    `&fen=${encodeURIComponent(fen)}&topGames=0&recentGames=0&moves=12`;
  const result = await safeExplorerGet(url, authHeaders());
  if (!result) return null;
  const { status, body } = result;
  if (status === 401) {
    if (!warnedNoToken) {
      console.warn(
        "[explorer] 401 from Lichess Explorer API - it now requires auth. " +
          "Set LICHESS_TOKEN (a personal access token) to enable tree expansion.",
      );
      warnedNoToken = true;
    }
    return null;
  }
  if (status !== 200) {
    console.warn(`[explorer] lichess-pool fetch failed (HTTP ${status}) for fen=${fen}`);
    return null;
  }
  return toResult(JSON.parse(body));
}
