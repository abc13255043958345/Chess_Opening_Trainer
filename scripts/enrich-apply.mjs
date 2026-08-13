// M5 explanation enrichment, step 2 of 2 (see enrich-extract.mjs).
//
// Reads scripts/enrichment/enriched-*.json files — arrays of
//   { openingId, nodeId, kind: "mistake"|"punish"|"plans", text }
// — and merges the texts back into public/content/eco-*.json:
//   mistake/punish -> node.annotation.explanation
//   plans          -> node.annotation.plans
//
// Safety rules: a node that no longer exists is skipped (counted); empty or
// suspiciously long texts (> 400 chars) are rejected; section generatedAt is
// bumped so installed apps re-download changed sections (freshness check in
// src/lib/content.ts); catalog.json's sections map is updated to match.
//
//   node scripts/enrich-apply.mjs

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.join(__dirname, "..", "public", "content");
const IN_DIR = path.join(__dirname, "enrichment");

const edits = [];
for (const f of (await readdir(IN_DIR)).filter((f) => /^enriched-.*\.json$/.test(f))) {
  const batch = JSON.parse(await readFile(path.join(IN_DIR, f), "utf8"));
  if (!Array.isArray(batch)) throw new Error(`${f}: expected a JSON array`);
  edits.push(...batch);
}
console.log(`${edits.length} enrichment edits loaded`);

const byOpening = new Map();
for (const e of edits) {
  if (!byOpening.has(e.openingId)) byOpening.set(e.openingId, []);
  byOpening.get(e.openingId).push(e);
}

const stats = { applied: 0, missingNode: 0, missingOpening: 0, rejected: 0 };
const sectionFiles = (await readdir(CONTENT_DIR)).filter((f) => /^eco-[A-E]\.json$/.test(f));
const touchedSections = new Map(); // file -> section object

for (const file of sectionFiles) {
  const section = JSON.parse(await readFile(path.join(CONTENT_DIR, file), "utf8"));
  let touched = false;
  for (const [openingId, openingEdits] of byOpening) {
    const tree = section.trees[openingId];
    if (!tree) continue;
    byOpening.delete(openingId);
    for (const e of openingEdits) {
      const node = tree.nodes[e.nodeId];
      if (!node) {
        stats.missingNode++;
        continue;
      }
      const text = (e.text ?? "").trim();
      if (text.length === 0 || text.length > 400) {
        stats.rejected++;
        continue;
      }
      node.annotation = node.annotation ?? { explanation: "" };
      if (e.kind === "plans") node.annotation.plans = text;
      else node.annotation.explanation = text;
      stats.applied++;
      touched = true;
    }
  }
  if (touched) {
    section.generatedAt = new Date().toISOString();
    touchedSections.set(file, section);
  }
}

stats.missingOpening = [...byOpening.values()].reduce((n, arr) => n + arr.length, 0);

for (const [file, section] of touchedSections) {
  await writeFile(path.join(CONTENT_DIR, file), JSON.stringify(section, null, 2), "utf8");
  console.log(`wrote ${file} (generatedAt ${section.generatedAt})`);
}

// Keep catalog.json's freshness stamps in sync so installed apps re-fetch.
if (touchedSections.size > 0) {
  const catalogPath = path.join(CONTENT_DIR, "catalog.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  catalog.sections = catalog.sections ?? {};
  for (const [file, section] of touchedSections) {
    catalog.sections[section.eco] = section.generatedAt;
  }
  catalog.generatedAt = new Date().toISOString();
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2), "utf8");
  console.log("catalog.json freshness stamps updated");
}

console.log(stats);
if (stats.applied === 0) process.exitCode = 1;
