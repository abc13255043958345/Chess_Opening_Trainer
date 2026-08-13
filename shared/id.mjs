// Stable node-id hashing shared by the app (src/) and the content pipeline (pipeline/).
// A node's id is a hash of the UCI move path from the start position, so ids are
// stable across pipeline re-runs and across app/editor sessions.

export const ROOT_ID = "root";

/**
 * FNV-1a 64-bit hash, returned as 16 hex chars.
 * @param {string} str
 * @returns {string}
 */
export function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * Node id for a move path.
 * @param {string[]} uciPath - UCI moves from the start position, e.g. ["e2e4","e7e5"]
 * @returns {string}
 */
export function nodeIdForPath(uciPath) {
  if (uciPath.length === 0) return ROOT_ID;
  return fnv1a64(uciPath.join(" "));
}
