import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";

export type LiveDraftStatus = {
  enabled: boolean;
  entitled: boolean;
  configured: boolean;
};

export function ensureLiveDraftRow(
  database: Database.Database = getDb(),
): void {
  database.prepare(`INSERT OR IGNORE INTO live_draft (id) VALUES (1)`).run();
}

export function getLiveDraftStatus(
  entitled: boolean,
  database: Database.Database = getDb(),
): LiveDraftStatus {
  ensureLiveDraftRow(database);
  const row = database
    .prepare(`SELECT enabled, configured FROM live_draft WHERE id = 1`)
    .get() as { enabled: number; configured: number };
  return {
    enabled: Boolean(row.enabled),
    entitled,
    configured: Boolean(row.configured),
  };
}
