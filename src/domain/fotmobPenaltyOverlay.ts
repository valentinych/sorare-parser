import { classifyPenaltyEvent } from "../clients/fotmob.js";
import { getDb } from "../db/index.js";

type PenaltyRow = {
  match_id: number;
  player_id: number;
  penalties_scored: number | null;
  penalties_missed: number | null;
};

/** Apply stored FotMob events onto player pen columns (same idea as YC/RC overlay). */
export function overlayPenaltiesFromStoredEvents(
  rows: PenaltyRow[],
  fotmobLeagueId: number,
): void {
  if (!rows.length) return;
  const events = getDb()
    .prepare(
      `SELECT e.match_id, e.player_id, e.type, e.raw_json
       FROM fotmob_match_events e
       JOIN fotmob_matches m ON m.id = e.match_id
       WHERE m.league_id = ?
         AND e.player_id IS NOT NULL
         AND e.type IN ('MissedPenalty', 'Goal')`,
    )
    .all(fotmobLeagueId) as Array<{
    match_id: number;
    player_id: number;
    type: string;
    raw_json: string | null;
  }>;
  const counts = new Map<string, { scored: number; missed: number }>();
  for (const e of events) {
    let raw: unknown = {};
    if (e.raw_json) {
      try {
        raw = JSON.parse(e.raw_json);
      } catch {
        raw = {};
      }
    }
    const kind = classifyPenaltyEvent({
      type: e.type,
      playerId: e.player_id,
      ownGoal: Boolean((raw as { ownGoal?: unknown }).ownGoal),
      raw,
    });
    if (!kind) continue;
    const k = `${e.match_id}:${e.player_id}`;
    const cur = counts.get(k) ?? { scored: 0, missed: 0 };
    cur[kind] += 1;
    counts.set(k, cur);
  }
  for (const row of rows) {
    const adj = counts.get(`${row.match_id}:${row.player_id}`);
    if (!adj) continue;
    row.penalties_missed = Math.max(row.penalties_missed ?? 0, adj.missed);
    row.penalties_scored = Math.max(row.penalties_scored ?? 0, adj.scored);
  }
}
