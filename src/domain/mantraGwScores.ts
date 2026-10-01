/**
 * Official Mantra player GW totals keyed by mantra player id.
 * Extra-league Ideal uses these instead of FotMob ratings (often 0 / missing).
 */
import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS mantra_gw_player_scores (
  slug TEXT NOT NULL,
  round TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  total REAL NOT NULL,
  base REAL,
  PRIMARY KEY (slug, round, player_id)
)`;

export type MantraGwPlayerScore = {
  playerId: number;
  total: number;
  base: number | null;
};

function dbFor(database?: Database.Database): Database.Database {
  const instance = database ?? getDb();
  instance.exec(CREATE_SQL);
  return instance;
}

/** True when FotMob stored a real match rating (minutes + positive rating). */
export function isNativeFotmobRating(
  rating: number | null | undefined,
  minutes: number | null | undefined,
): boolean {
  return (
    rating != null &&
    Number.isFinite(rating) &&
    rating > 0 &&
    minutes != null &&
    Number.isFinite(minutes) &&
    minutes > 0
  );
}

export function upsertMantraGwPlayerScores(
  slug: string,
  round: string | number,
  scores: Iterable<MantraGwPlayerScore>,
  database?: Database.Database,
): number {
  const db = dbFor(database);
  const stmt = db.prepare(
    `INSERT INTO mantra_gw_player_scores (slug, round, player_id, total, base)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(slug, round, player_id) DO UPDATE SET
       total = CASE WHEN excluded.total > total THEN excluded.total ELSE total END,
       base = CASE
         WHEN excluded.base IS NOT NULL AND (base IS NULL OR excluded.base > base)
         THEN excluded.base ELSE base END`,
  );
  let n = 0;
  const tx = db.transaction(() => {
    for (const row of scores) {
      const id = Number(row.playerId);
      const total = Number(row.total);
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(total) || total <= 0) {
        continue;
      }
      const base =
        row.base != null && Number.isFinite(row.base) && row.base > 0 ? row.base : null;
      stmt.run(slug, String(round), id, total, base);
      n += 1;
    }
  });
  tx();
  return n;
}

export function loadMantraGwPlayerScores(
  slug: string,
  round: string | number,
  database?: Database.Database,
): Map<number, MantraGwPlayerScore> {
  const db = dbFor(database);
  const rows = db
    .prepare(
      `SELECT player_id AS playerId, total, base
       FROM mantra_gw_player_scores
       WHERE slug = ? AND round = ?`,
    )
    .all(slug, String(round)) as Array<{ playerId: number; total: number; base: number | null }>;
  const out = new Map<number, MantraGwPlayerScore>();
  for (const row of rows) {
    const id = Number(row.playerId);
    const total = Number(row.total);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(total) || total <= 0) continue;
    out.set(id, {
      playerId: id,
      total,
      base: row.base != null && Number.isFinite(row.base) && row.base > 0 ? row.base : null,
    });
  }
  return out;
}
