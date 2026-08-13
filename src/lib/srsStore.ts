// Thin IndexedDB IO over db.srs / db.snapshots / db.meta (DESIGN.md §5, §6 M3).
// Keeps src/lib/srs.ts pure; this is the only place that touches Dexie for SRS data,
// mirroring how src/lib/content.ts is the IO layer for content/training-set data.

import { db } from "./db";
import { subtreeMastery } from "./srs";
import type { CatalogEntry, MasterySnapshot, OpeningTree, SrsCard } from "../types";

const LAST_SNAPSHOT_DATE_KEY = "srs-last-snapshot-date";
const ACTIVE_DAYS_KEY = "srs-active-days";
const MAX_ACTIVE_DAYS_KEPT = 400;

/** Local (device) calendar date as "YYYY-MM-DD" — daily snapshots and streaks are
 *  about the user's day, not UTC's. */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- Cards ----------

/** Loads SRS cards, optionally restricted to a set of openingIds, keyed by their
 *  `${openingId}:${nodeId}` key (see SrsCard.key in src/types.ts). */
export async function loadCards(openingIds?: string[]): Promise<Map<string, SrsCard>> {
  const rows =
    openingIds && openingIds.length > 0
      ? await db.srs.where("openingId").anyOf(openingIds).toArray()
      : await db.srs.toArray();
  const map = new Map<string, SrsCard>();
  for (const row of rows) map.set(row.key, row);
  return map;
}

export async function saveCard(cardOrCards: SrsCard | SrsCard[]): Promise<void> {
  const cards = Array.isArray(cardOrCards) ? cardOrCards : [cardOrCards];
  if (cards.length === 0) return;
  await db.srs.bulkPut(cards);
}

// ---------- Snapshots ----------

/**
 * Writes one MasterySnapshot per opening for "today" (local date) — at most once per
 * calendar day, guarded by a meta row, so repeated calls (e.g. every Home mount) are
 * cheap no-ops after the first (DESIGN §5: "snapshot per-opening mastery daily (on
 * first open)").
 */
export async function recordDailySnapshot(
  catalogEntries: CatalogEntry[],
  trees: Record<string, OpeningTree>,
  cards: Map<string, SrsCard>,
  now: Date = new Date()
): Promise<void> {
  const today = localDateStr(now);
  const last = await db.meta.get(LAST_SNAPSHOT_DATE_KEY);
  if (last?.value === today) return;

  const rows: MasterySnapshot[] = [];
  for (const entry of catalogEntries) {
    const tree = trees[entry.id];
    if (!tree) continue;
    const mastery = subtreeMastery(tree, tree.rootId, cards, now);
    rows.push({ key: `${entry.id}:${today}`, openingId: entry.id, date: today, mastery });
  }
  if (rows.length > 0) await db.snapshots.bulkPut(rows);
  await db.meta.put({ key: LAST_SNAPSHOT_DATE_KEY, value: today });
}

export async function getSnapshots(openingId?: string): Promise<MasterySnapshot[]> {
  if (openingId) return db.snapshots.where("openingId").equals(openingId).toArray();
  return db.snapshots.toArray();
}

// ---------- Streaks ----------

async function loadActiveDays(): Promise<Set<string>> {
  const row = await db.meta.get(ACTIVE_DAYS_KEY);
  const arr = Array.isArray(row?.value) ? (row!.value as string[]) : [];
  return new Set(arr);
}

/** Marks "today" (local date) as an active day. Keeps only the most recent
 *  MAX_ACTIVE_DAYS_KEPT days so the meta row can't grow unbounded. */
export async function recordActivity(now: Date = new Date()): Promise<void> {
  const days = await loadActiveDays();
  days.add(localDateStr(now));
  const trimmed = [...days].sort().slice(-MAX_ACTIVE_DAYS_KEPT);
  await db.meta.put({ key: ACTIVE_DAYS_KEY, value: trimmed });
}

/** Consecutive active days ending today or yesterday — a streak survives until a
 *  full calendar day is missed entirely. 0 if neither today nor yesterday was active. */
export async function currentStreak(now: Date = new Date()): Promise<number> {
  const days = await loadActiveDays();
  const cursor = new Date(now);
  if (!days.has(localDateStr(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(localDateStr(cursor))) return 0;
  }
  let streak = 0;
  while (days.has(localDateStr(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
