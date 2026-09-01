import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";

/** Live-draft managers from round 1 (Mantra squad ids on live_auction_team_names). */
export const LIVE_DRAFT_SQUAD_IDS = [
  1925, 1950, 2033, 2035, 2036, 3235, 5009, 5010,
] as const;

export type LiveDraftAward = {
  playerId: number;
  email: string;
  amount: number;
  teamName: string;
  squadId: number | null;
};

function hasTable(database: Database.Database, name: string): boolean {
  return Boolean(
    database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name),
  );
}

export function liveDraftAwardsVersion(database: Database.Database = getDb()): string {
  if (!hasTable(database, "live_auction_awards")) return "0";
  const row = database.prepare(`SELECT COUNT(*) AS n FROM live_auction_awards`).get() as {
    n: number;
  };
  return String(row.n);
}

export function loadLiveDraftAwards(
  database: Database.Database = getDb(),
): Map<number, LiveDraftAward> {
  const out = new Map<number, LiveDraftAward>();
  if (!hasTable(database, "live_auction_awards")) return out;
  const hasNames = hasTable(database, "live_auction_team_names");
  const rows = (
    hasNames
      ? database.prepare(
          `SELECT a.player_id AS playerId, a.email, a.amount,
                  COALESCE(NULLIF(TRIM(n.team_name), ''), a.email) AS teamName,
                  n.squad_id AS squadId
           FROM live_auction_awards a
           LEFT JOIN live_auction_team_names n ON lower(n.email) = lower(a.email)`,
        )
      : database.prepare(
          `SELECT player_id AS playerId, email, amount, email AS teamName,
                  NULL AS squadId
           FROM live_auction_awards`,
        )
  ).all() as Array<{
    playerId: number;
    email: string;
    amount: number;
    teamName: string;
    squadId: number | null;
  }>;
  for (const row of rows) {
    out.set(row.playerId, {
      playerId: row.playerId,
      email: row.email,
      amount: row.amount,
      teamName: row.teamName,
      squadId: row.squadId == null ? null : Number(row.squadId),
    });
  }
  return out;
}

export function listLiveDraftSquads(
  database: Database.Database = getDb(),
): Array<{ id: number; name: string; division: string; label: string }> {
  if (!hasTable(database, "live_auction_team_names")) return [];
  const rows = database
    .prepare(
      `SELECT squad_id AS id, team_name AS name
       FROM live_auction_team_names
       WHERE squad_id IS NOT NULL
       ORDER BY team_name COLLATE NOCASE`,
    )
    .all() as Array<{ id: number; name: string }>;
  const seen = new Set<number>();
  const out: Array<{ id: number; name: string; division: string; label: string }> = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    const name = String(row.name || "").trim() || `Squad ${id}`;
    out.push({
      id,
      name,
      division: "Live",
      label: `Live · ${name}`,
    });
  }
  return out;
}

/** Awarded players are gone from the shared 8-manager pool. */
export function applyLiveDraftTaken(
  takenLeagueIds: number[],
  award: LiveDraftAward | undefined,
  squadIds: readonly number[] = LIVE_DRAFT_SQUAD_IDS,
): number[] {
  if (!award) return takenLeagueIds;
  const next = new Set(takenLeagueIds);
  for (const id of squadIds) next.add(id);
  return [...next];
}
