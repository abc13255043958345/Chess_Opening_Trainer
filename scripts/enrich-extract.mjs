// M5 explanation enrichment, step 1 of 2 (see enrich-apply.mjs).
//
// Extracts every node whose explanation text is worth upgrading from mechanical
// to human-quality — opponent mistakes, the punish replies to them, and
// end-of-theory plans — into a reviewable worklist JSON. The worklist carries
// everything a writer (the orchestrating model) needs to produce a grounded
// 1–2 sentence explanation without inventing chess facts: the position, the
// move, eval before/after, and the engine PV continuation.
//
//   node scripts/enrich-extract.mjs            -> scripts/enrichment/worklist.json
//   node scripts/enrich-extract.mjs --eco C    -> only that section
//
// Step 2 (enrich-apply.mjs) merges edited texts back into public/content/.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.join(__dirname, "..", "public", "content");
const OUT_DIR = path.join(__dirname, "enrichment");

const ecoArg = process.argv.includes("--eco")
  ? process.argv[process.argv.indexOf("--eco") + 1].toUpperCase()
  : null;

function sanPathTo(tree, nodeId) {
  const sans = [];
  let cur = tree.nodes[nodeId];
  while (cur && cur.parentId != null) {
    sans.push(cur.san);
    cur = tree.nodes[cur.parentId];
  }
  sans.reverse();
  // Numbered SAN, e.g. "1. e4 e5 2. Qh5"
  const parts = [];
  for (let i = 0; i < sans.length; i += 2) {
    const n = i / 2 + 1;
    parts.push(sans[i + 1] ? `${n}. ${sans[i]} ${sans[i + 1]}` : `${n}. ${sans[i]}`);
  }
  return parts.join(" ");
}

/** First few SANs of the continuation below a node (mainline walk). */
function continuationSans(tree, nodeId, max = 6) {
  const sans = [];
  let node = tree.nodes[nodeId];
  while (node && sans.length < max) {
    const next = node.children.map((c) => tree.nodes[c]).find((c) => c && c.moveKind === "mainline");
    if (!next) break;
    sans.push(next.san);
    node = next;
  }
  return sans;
}

const files = (await readdir(CONTENT_DIR)).filter(
  (f) => /^eco-[A-E]\.json$/.test(f) && (!ecoArg || f === `eco-${ecoArg}.json`)
);

const items = [];
for (const file of files) {
  const section = JSON.parse(await readFile(path.join(CONTENT_DIR, file), "utf8"));
  for (const tree of Object.values(section.trees)) {
    for (const node of Object.values(tree.nodes)) {
      const parent = node.parentId != null ? tree.nodes[node.parentId] : null;
      const base = {
        openingId: tree.id,
        openingName: tree.name,
        perspective: tree.perspective,
        nodeId: node.id,
        san: node.san,
        lineToHere: sanPathTo(tree, node.id),
        fenAfter: node.fen,
        evalAfterCp: node.evalCp ?? null,
        evalBeforeCp: parent?.evalCp ?? null,
        continuation: continuationSans(tree, node.id),
      };
      if (node.moveKind === "opponent_mistake" && node.annotation?.explanation) {
        items.push({ ...base, kind: "mistake", currentText: node.annotation.explanation });
      } else if (
        parent?.moveKind === "opponent_mistake" &&
        node.mover === "user" &&
        node.annotation?.explanation
      ) {
        items.push({ ...base, kind: "punish", currentText: node.annotation.explanation });
      } else if (node.endOfTheory && node.annotation?.plans) {
        items.push({
          ...base,
          kind: "plans",
          endReason: node.endOfTheory.reason,
          currentText: node.annotation.plans,
        });
      }
    }
  }
}

await mkdir(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "worklist.json");
await writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2));
console.log(`${items.length} enrichment items -> ${outPath}`);
const byKind = {};
for (const i of items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
console.log(byKind);
