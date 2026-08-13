// Loads the Lichess `chess-openings` dataset (CC0) and parses each entry's
// defining line (SAN with move numbers) into a UCI move path + final FEN.

import { Chess } from "chess.js";
import { httpGet } from "./http.mjs";

const BASE_URL = "https://raw.githubusercontent.com/lichess-org/chess-openings/master";
const ECO_LETTERS = ["a", "b", "c", "d", "e"];

/**
 * @typedef {{
 *   id: string,
 *   eco: string,
 *   name: string,
 *   perspective: "white" | "black",
 *   uciPath: string[],
 *   sanPath: string[],
 *   fen: string,
 * }} CatalogSourceEntry
 */

/**
 * Slugifies `${eco}-${name}` into a stable, lowercase, hyphenated id.
 * @param {string} eco
 * @param {string} name
 * @returns {string}
 */
export function slugify(eco, name) {
  return `${eco}-${name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Parses one TSV blob (columns: eco, name, pgn) into row objects.
 * @param {string} text
 * @returns {Array<{eco: string, name: string, pgn: string}>}
 */
function parseTsv(text) {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const columns = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    /** @type {Record<string, string>} */
    const row = {};
    columns.forEach((col, i) => {
      row[col] = cells[i] ?? "";
    });
    return /** @type {{eco: string, name: string, pgn: string}} */ (row);
  });
}

/**
 * Parses a numbered SAN line ("1. e4 e5 2. Nf3") into UCI/SAN move paths and
 * the resulting FEN, using chess.js for legality + notation conversion.
 * @param {string} pgn
 * @returns {{uciPath: string[], sanPath: string[], fen: string, lastMoverColor: "w" | "b"}}
 */
function parseDefiningLine(pgn) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const moves = chess.history({ verbose: true });
  return {
    uciPath: moves.map((m) => m.lan),
    sanPath: moves.map((m) => m.san),
    fen: chess.fen(),
    lastMoverColor: moves.length > 0 ? moves[moves.length - 1].color : "w",
  };
}

/**
 * Loads and parses the full Lichess chess-openings catalog (ECO letters a-e).
 * Duplicate slug ids keep the first entry seen and skip (and log) later ones.
 * @returns {Promise<CatalogSourceEntry[]>}
 */
export async function loadCatalog() {
  /** @type {Map<string, CatalogSourceEntry>} */
  const byId = new Map();
  const skipped = [];

  for (const letter of ECO_LETTERS) {
    const url = `${BASE_URL}/${letter}.tsv`;
    const { status, body } = await httpGet(url);
    if (status !== 200) {
      throw new Error(`Failed to fetch chess-openings dataset ${url}: HTTP ${status}`);
    }
    for (const row of parseTsv(body)) {
      const { eco, name, pgn } = row;
      if (!eco || !name || !pgn) continue;
      const id = slugify(eco, name);
      if (byId.has(id)) {
        skipped.push({ id, eco, name, reason: "duplicate id" });
        continue;
      }
      let parsed;
      try {
        parsed = parseDefiningLine(pgn);
      } catch (err) {
        skipped.push({ id, eco, name, reason: `parse error: ${err.message}` });
        continue;
      }
      byId.set(id, {
        id,
        eco,
        name,
        perspective: parsed.lastMoverColor === "w" ? "white" : "black",
        uciPath: parsed.uciPath,
        sanPath: parsed.sanPath,
        fen: parsed.fen,
      });
    }
  }

  if (skipped.length > 0) {
    console.warn(`[catalog] skipped ${skipped.length} entries:`);
    for (const s of skipped.slice(0, 25)) {
      console.warn(`  - ${s.id} (${s.eco} ${s.name}): ${s.reason}`);
    }
    if (skipped.length > 25) console.warn(`  ... and ${skipped.length - 25} more`);
  }

  return [...byId.values()];
}
