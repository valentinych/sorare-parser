import { getDb } from "../db/index.js";

/** Persistent JSON cache for external API responses. */
export function getCachedJson<T>(key: string): T | null {
  const row = getDb().prepare(`SELECT body_json FROM api_cache WHERE key = ?`).get(key) as
    | { body_json: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.body_json) as T;
  } catch {
    return null;
  }
}

export function setCachedJson(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO api_cache (key, body_json, fetched_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         body_json = excluded.body_json,
         fetched_at = excluded.fetched_at`,
    )
    .run(key, JSON.stringify(value));
}

export function hasCached(key: string): boolean {
  const row = getDb().prepare(`SELECT 1 AS ok FROM api_cache WHERE key = ?`).get(key) as
    | { ok: number }
    | undefined;
  return Boolean(row);
}
