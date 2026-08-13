// Mechanical (non-LLM) explanation text generation. Short, factual English,
// 1-2 sentences, evals formatted as "+1.1" / "-0.6" pawns (see DESIGN.md §2 step 5;
// M5's Claude-enriched pass is a later milestone, not this one).

/**
 * Formats a white-positive centipawn value as signed pawns, e.g. 162 -> "+1.6".
 * @param {number} evalCp
 * @returns {string}
 */
export function formatEvalPawns(evalCp) {
  const pawns = evalCp / 100;
  const sign = pawns >= 0 ? "+" : "";
  return `${sign}${pawns.toFixed(1)}`;
}

/**
 * Formats a share (0..1) as a rounded percentage, e.g. 0.734 -> "73%".
 * @param {number} share
 * @returns {string}
 */
export function formatPercent(share) {
  return `${Math.round(share * 100)}%`;
}

/**
 * Explanation for a user mainline move (masters' most popular reply). When the
 * parent node is an opponent_mistake, this instead explains the punish: the
 * eval swing from just after the mistake (evalBefore) to just after this
 * reply (evalAfter).
 * @param {{
 *   san: string,
 *   share: number,
 *   evalCp?: number,
 *   parentIsMistake?: boolean,
 *   parentMistakeSan?: string,
 *   evalBeforeCp?: number,
 *   evalAfterCp?: number,
 *   punishSanPreview?: string[],
 * }} args
 * @returns {string}
 */
export function explainMainlineMove({
  san,
  share,
  evalCp,
  parentIsMistake,
  parentMistakeSan,
  evalBeforeCp,
  evalAfterCp,
  punishSanPreview,
}) {
  if (parentIsMistake) {
    let text = `Punishes ${parentMistakeSan}: ${san} wins the advantage`;
    if (typeof evalBeforeCp === "number" && typeof evalAfterCp === "number") {
      text += ` (${formatEvalPawns(evalBeforeCp)} → ${formatEvalPawns(evalAfterCp)}).`;
    } else {
      text += ".";
    }
    if (punishSanPreview && punishSanPreview.length > 0) {
      text += ` Play continues ${punishSanPreview.join(" ")}.`;
    }
    return text;
  }

  let text = `Main line: ${san}, played in ${formatPercent(share)} of master games here.`;
  if (typeof evalCp === "number") {
    text += ` Eval ${formatEvalPawns(evalCp)}.`;
  }
  return text;
}

/**
 * Explanation for an opponent_mistake node.
 * @param {{
 *   san: string,
 *   poolShare: number,
 *   mastersShare: number,
 *   isRareInMasters: boolean,
 *   evalDropCp?: number,
 *   evalDropTriggered: boolean,
 *   punishSan?: string,
 * }} args
 * @returns {string}
 */
export function explainMistake({ san, poolShare, isRareInMasters, evalDropCp, evalDropTriggered, punishSan }) {
  const clauses = [];
  if (isRareInMasters) clauses.push("rare in master play");
  if (evalDropTriggered && typeof evalDropCp === "number") {
    clauses.push(`concedes ${(evalDropCp / 100).toFixed(1)} pawns`);
  }
  const why = clauses.length > 0 ? clauses.join(" and it ") : "isn't the theoretical choice here";

  let text = `${san}? is popular at club level (${formatPercent(poolShare)} of games) but ${why}.`;
  if (punishSan) {
    text += ` Meet it with ${punishSan}.`;
  }
  return text;
}

/**
 * Builds the `annotation.plans` text for an endOfTheory node.
 * @param {{ reason: "winning" | "clear_plan", evalCp?: number }} args
 * @returns {string}
 */
export function explainEndOfTheory({ reason, evalCp }) {
  let text = "Theory ends here";
  if (typeof evalCp === "number") {
    text += ` at ${formatEvalPawns(evalCp)}.`;
  } else {
    text += ".";
  }
  if (reason === "winning") {
    text += " The position is clearly better - convert the advantage.";
  }
  return text;
}
