// User customization persistence for repertoire trees (DESIGN.md §4.5, §6 M1).
//
// Copy-on-write: a shipped tree stays untouched in the content cache until the
// user makes their first edit, at which point the whole (customized) tree is
// written here as a UserTreeRecord keyed by openingId. getTree() (src/lib/content.ts)
// already prefers this record over the shipped tree.

import { db } from "./db";
import type { OpeningTree, UserTreeRecord } from "../types";

/** Upsert the user's customized copy of `tree` (openingId = tree.id). */
export async function saveUserTree(tree: OpeningTree): Promise<void> {
  const record: UserTreeRecord = {
    openingId: tree.id,
    tree,
    modifiedAt: new Date().toISOString(),
  };
  await db.userTrees.put(record);
}

/** Delete the user's customization so getTree() falls back to shipped content. */
export async function revertUserTree(openingId: string): Promise<void> {
  await db.userTrees.delete(openingId);
}

export async function hasUserTree(openingId: string): Promise<boolean> {
  const record = await db.userTrees.get(openingId);
  return record != null;
}
