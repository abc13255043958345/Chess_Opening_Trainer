// Content loading + user-data persistence (DESIGN.md §2, §6 M1 scope).
//
// Shipped opening theory is static JSON under public/content/ (one catalog.json
// index + one file per ECO letter). It's fetched over HTTP, cached in IndexedDB so
// the app works offline after first load, and layered under any user customization
// (userTrees always wins over shipped content for a given openingId).

import { db } from "./db";
import type {
  Catalog,
  CatalogEntry,
  ContentSection,
  MasterySnapshot,
  OpeningTree,
  SrsCard,
  TrainingSetItem,
  UserTreeRecord,
} from "../types";

const CATALOG_META_KEY = "catalog-cache";

function contentUrl(relativePath: string): string {
  return `${import.meta.env.BASE_URL}${relativePath}`;
}

// Memoized in module scope: only fetch/parse the catalog once per page load.
let catalogPromise: Promise<Catalog> | undefined;

export function loadCatalog(): Promise<Catalog> {
  if (!catalogPromise) {
    catalogPromise = fetchCatalog().catch((err) => {
      // Don't memoize a failure — a later retry (e.g. after coming back online
      // with no cache yet) should try the network again.
      catalogPromise = undefined;
      throw err;
    });
  }
  return catalogPromise;
}

async function fetchCatalog(): Promise<Catalog> {
  try {
    const res = await fetch(contentUrl("content/catalog.json"));
    if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
    const catalog = (await res.json()) as Catalog;
    // Write-through cache so the app still works offline next time.
    await db.meta.put({ key: CATALOG_META_KEY, value: catalog });
    return catalog;
  } catch (err) {
    const cached = await db.meta.get(CATALOG_META_KEY);
    if (cached) return cached.value as Catalog;
    throw err;
  }
}

async function loadContentSection(
  entry: CatalogEntry,
  catalog: Catalog
): Promise<ContentSection | undefined> {
  // Sections are keyed by ECO *letter* ("C"), while entries carry full codes ("C50").
  const letter = entry.eco.charAt(0).toUpperCase();
  const latestGeneratedAt = catalog.sections?.[letter];
  const cached = await db.contentSections.get(letter);
  // Serve from cache unless the catalog says the pipeline regenerated this section
  // since we cached it (ISO timestamps compare lexicographically).
  if (cached && (!latestGeneratedAt || cached.generatedAt >= latestGeneratedAt)) {
    return cached;
  }
  try {
    const res = await fetch(contentUrl(entry.file));
    if (!res.ok) throw new Error(`content fetch failed: HTTP ${res.status}`);
    const section = (await res.json()) as ContentSection;
    await db.contentSections.put(section);
    return section;
  } catch {
    // Offline with a stale cache: stale content beats no content.
    return cached;
  }
}

/**
 * The tree to show/train for `openingId`: a user customization if one exists,
 * otherwise the shipped tree from the catalog's content files.
 */
export async function getTree(openingId: string): Promise<OpeningTree | undefined> {
  const userTree = await db.userTrees.get(openingId);
  if (userTree) return userTree.tree;

  const catalog = await loadCatalog();
  const entry = catalog.entries.find((e) => e.id === openingId);
  if (!entry) return undefined;

  const section = await loadContentSection(entry, catalog);
  return section?.trees[openingId];
}

export async function isInTrainingSet(openingId: string): Promise<boolean> {
  const item = await db.trainingSet.get(openingId);
  return item != null;
}

/** Flips membership; returns the new state (true = now in the training set). */
export async function toggleTrainingSet(openingId: string): Promise<boolean> {
  const existing = await db.trainingSet.get(openingId);
  if (existing) {
    await db.trainingSet.delete(openingId);
    return false;
  }
  const item: TrainingSetItem = { openingId, addedAt: new Date().toISOString() };
  await db.trainingSet.put(item);
  return true;
}

/** Catalog entries the user has added to their training set. */
export async function listTrainingSet(): Promise<CatalogEntry[]> {
  const [catalog, items] = await Promise.all([loadCatalog(), db.trainingSet.toArray()]);
  const ids = new Set(items.map((i) => i.openingId));
  return catalog.entries.filter((e) => ids.has(e.id));
}

// ---------- Backup / restore ----------

export interface ExportedUserData {
  version: 1;
  exportedAt: string;
  trainingSet: TrainingSetItem[];
  userTrees: UserTreeRecord[];
  srs: SrsCard[];
  snapshots: MasterySnapshot[];
}

export async function exportUserData(): Promise<Blob> {
  const [trainingSet, userTrees, srs, snapshots] = await Promise.all([
    db.trainingSet.toArray(),
    db.userTrees.toArray(),
    db.srs.toArray(),
    db.snapshots.toArray(),
  ]);
  const payload: ExportedUserData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    trainingSet,
    userTrees,
    srs,
    snapshots,
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
}

function isExportedUserData(value: unknown): value is ExportedUserData {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    Array.isArray(v.trainingSet) &&
    Array.isArray(v.userTrees) &&
    Array.isArray(v.srs) &&
    Array.isArray(v.snapshots)
  );
}

/** Parses + validates a backup file, then replaces matching keys (bulkPut semantics). */
export async function importUserData(file: File): Promise<void> {
  const text = await file.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!isExportedUserData(data)) {
    throw new Error("Unrecognized backup file format.");
  }

  await db.transaction(
    "rw",
    [db.trainingSet, db.userTrees, db.srs, db.snapshots],
    async () => {
      if (data.trainingSet.length) await db.trainingSet.bulkPut(data.trainingSet);
      if (data.userTrees.length) await db.userTrees.bulkPut(data.userTrees);
      if (data.srs.length) await db.srs.bulkPut(data.srs);
      if (data.snapshots.length) await db.snapshots.bulkPut(data.snapshots);
    }
  );
}
