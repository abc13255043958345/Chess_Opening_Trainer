// IndexedDB persistence layer (Dexie 4). See DESIGN.md §2 for the data model this
// mirrors; src/types.ts is the source of truth for the record shapes.

import Dexie, { type Table } from "dexie";
import type {
  ContentSection,
  MasterySnapshot,
  SrsCard,
  TrainingSetItem,
  UserTreeRecord,
} from "../types";

/** Generic key/value row used for small app state (e.g. a cached catalog). */
export interface MetaRecord {
  key: string;
  value: unknown;
}

export class ChessOpenerDB extends Dexie {
  trainingSet!: Table<TrainingSetItem, string>;
  userTrees!: Table<UserTreeRecord, string>;
  contentSections!: Table<ContentSection, string>;
  srs!: Table<SrsCard, string>;
  snapshots!: Table<MasterySnapshot, string>;
  meta!: Table<MetaRecord, string>;

  constructor() {
    super("chess-opener");
    this.version(1).stores({
      trainingSet: "openingId",
      userTrees: "openingId",
      contentSections: "eco",
      srs: "key, openingId, dueDate",
      snapshots: "key, openingId",
      meta: "key",
    });
  }
}

export const db = new ChessOpenerDB();

// Typed table accessors — prefer importing these over reaching into `db` directly.
export const trainingSetTable = db.trainingSet;
export const userTreesTable = db.userTrees;
export const contentSectionsTable = db.contentSections;
export const srsTable = db.srs;
export const snapshotsTable = db.snapshots;
export const metaTable = db.meta;
