// Tunable parameters for the build-time content pipeline (see DESIGN.md §2, §8).
// Everything that controls tree shape, popularity/mistake thresholds, or API
// politeness lives here so re-runs can be tuned from one place.

/** @typedef {{
 *   popularityThreshold: number,
 *   maxTheoryRepliesPerNode: number,
 *   mistakePopularityThreshold: number,
 *   mistakeMastersRarity: number,
 *   mistakeEvalCutoffCp: number,
 *   maxMistakesPerNode: number,
 *   punishLineMaxPlies: number,
 *   endOfTheoryEvalCp: number,
 *   maxPly: number,
 *   mastersGamesFloor: number,
 *   poolGamesFloor: number,
 *   thinMastersUserMoveDepth: number,
 *   maxNodesPerOpening: number,
 *   lichessSpeeds: string[],
 *   lichessRatings: number[],
 *   requestDelayMs: number,
 *   perHostDelayMs: Record<string, number>,
 *   localEvalDepth: number,
 *   localPunishDepth: number,
 * }} PipelineConfig
 */

/** @type {PipelineConfig} */
export const CONFIG = {
  // Minimum share of games (masters) an opponent reply needs to be included
  // as a theory child at all.
  popularityThreshold: 0.02,
  // Safety cap on how many masters theory replies we keep per opponent node.
  maxTheoryRepliesPerNode: 6,
  // Minimum share of games (lichess pool, 1600-2000) for a move to be worth
  // flagging as a common club-level mistake.
  mistakePopularityThreshold: 0.03,
  // A masters share below this counts as "rare in masters" for mistake detection.
  mistakeMastersRarity: 0.005,
  // Eval drop (centipawns) vs. the position's best move that qualifies a move
  // as a mistake even if it isn't rare in masters.
  mistakeEvalCutoffCp: 70,
  // Safety cap on how many opponent_mistake children we keep per opponent node.
  maxMistakesPerNode: 2,
  // Max plies to extend a punish line under an opponent_mistake node.
  punishLineMaxPlies: 6,
  // |evalCp| at or above this stamps endOfTheory reason "winning".
  endOfTheoryEvalCp: 150,
  // Absolute max ply (half-moves from the start position) a branch can reach.
  maxPly: 24,
  // Below this many total masters games at a position, masters theory is too
  // thin to drive expansion (see poolGamesFloor: this alone does NOT stop the
  // branch - the lichess pool is tried first).
  mastersGamesFloor: 100,
  // Below this many total lichess-pool games (club-level: see lichessSpeeds/
  // lichessRatings) at a position, the pool itself is too thin to fall back
  // on - the line is genuinely out of play at both master and club level.
  // Only when masters AND pool are both below their floors does a branch end
  // for lack of data (see treegen.mjs).
  poolGamesFloor: 200,
  // Local-engine search depth used to pick OUR (the user's) mainline move
  // when masters is thin but the pool covers the position (see
  // poolGamesFloor). Deeper than localEvalDepth's routine stamp - a club
  // player's most popular move here can be a blunder, so this can't come from
  // raw pool popularity the way the masters-driven mainline choice does.
  thinMastersUserMoveDepth: 18,
  // Hard safety cap on total nodes generated per opening (prevents runaway trees).
  maxNodesPerOpening: 400,
  // Lichess pool speeds used for the "club level" mistake-popularity query.
  lichessSpeeds: ["blitz", "rapid", "classical"],
  // Lichess pool rating band (inclusive lower bounds passed to the Explorer API).
  lichessRatings: [1600, 1800],
  // Minimum delay (ms) between two live requests to the same host. Fallback
  // for any host not listed in perHostDelayMs.
  requestDelayMs: 750,
  // Per-host base delay (ms), overriding requestDelayMs where set. The
  // adaptive multiplier (delayMultiplierByHost, see http.mjs) still layers on
  // top of whichever base applies. lichess.org (cloud-eval) gets a longer
  // base delay than the explorer host since it's the one that's actually
  // banned this IP - see cloudeval.mjs / evals.mjs circuit breaker.
  perHostDelayMs: {
    "explorer.lichess.ovh": 1000,
    "lichess.org": 2500,
  },
  // Search depth for a routine evalCp stamp when the local Stockfish engine
  // is doing the work (see engine.mjs / evals.mjs). Cloud-eval, when
  // reachable, is already deeper than this - this only bounds local cost.
  localEvalDepth: 14,
  // Search depth for the local engine specifically when the eval's PV is
  // about to become a punish line (deeper - the line needs to hold up).
  localPunishDepth: 18,
};
