/**
 * Optional gap-fill: aggregate TM match lineups/events into player_tm_perf.
 * No minutes on TM lineups — used only when AF season stats are missing.
 * Does not hit the network (uses already-synced tm_game_* tables).
 */
import { getDb, setMeta } from "../db/index.js";

export function syncTmPerfFromGames(season: number): number {
  const db = getDb();
  const seasonId = season;

  const apps = db
    .prepare(
      `SELECT gl.player_id AS tmPlayerId, pv.af_player_id AS afPlayerId,
              COUNT(*) AS appearances,
              SUM(CASE WHEN gl.is_starter = 1 THEN 1 ELSE 0 END) AS lineups
       FROM tm_game_lineup gl
       JOIN tm_games g ON g.id = gl.game_id
       LEFT JOIN player_values pv ON pv.tm_player_id = gl.player_id
       WHERE g.season_id = ? OR CAST(g.season_id AS TEXT) = ?
       GROUP BY gl.player_id`,
    )
    .all(seasonId, String(seasonId)) as Array<{
    tmPlayerId: string;
    afPlayerId: number | null;
    appearances: number;
    lineups: number;
  }>;

  const goals = db
    .prepare(
      `SELECT ge.active_player_id AS tmPlayerId, COUNT(*) AS goals
       FROM tm_game_events ge
       JOIN tm_games g ON g.id = ge.game_id
       WHERE (g.season_id = ? OR CAST(g.season_id AS TEXT) = ?)
         AND ge.event_type = 'goals'
         AND ge.active_player_id IS NOT NULL
       GROUP BY ge.active_player_id`,
    )
    .all(seasonId, String(seasonId)) as Array<{ tmPlayerId: string; goals: number }>;

  const assists = db
    .prepare(
      `SELECT ge.passive_player_id AS tmPlayerId, COUNT(*) AS assists
       FROM tm_game_events ge
       JOIN tm_games g ON g.id = ge.game_id
       WHERE (g.season_id = ? OR CAST(g.season_id AS TEXT) = ?)
         AND ge.event_type = 'goals'
         AND ge.passive_player_id IS NOT NULL
       GROUP BY ge.passive_player_id`,
    )
    .all(seasonId, String(seasonId)) as Array<{ tmPlayerId: string; assists: number }>;

  const cards = db
    .prepare(
      `SELECT ge.active_player_id AS tmPlayerId,
              SUM(CASE WHEN lower(coalesce(ge.action,'')) LIKE '%yellow%'
                        OR lower(coalesce(ge.reason,'')) LIKE '%yellow%' THEN 1 ELSE 0 END) AS yellow,
              SUM(CASE WHEN lower(coalesce(ge.action,'')) LIKE '%red%'
                        OR lower(coalesce(ge.reason,'')) LIKE '%red%' THEN 1 ELSE 0 END) AS red
       FROM tm_game_events ge
       JOIN tm_games g ON g.id = ge.game_id
       WHERE (g.season_id = ? OR CAST(g.season_id AS TEXT) = ?)
         AND ge.event_type = 'cards'
         AND ge.active_player_id IS NOT NULL
       GROUP BY ge.active_player_id`,
    )
    .all(seasonId, String(seasonId)) as Array<{
    tmPlayerId: string;
    yellow: number;
    red: number;
  }>;

  const goalMap = new Map(goals.map((g) => [g.tmPlayerId, g.goals]));
  const assistMap = new Map(assists.map((a) => [a.tmPlayerId, a.assists]));
  const cardMap = new Map(cards.map((c) => [c.tmPlayerId, c]));

  const upsert = db.prepare(
    `INSERT INTO player_tm_perf (
       season, tm_player_id, af_player_id, appearances, lineups,
       goals, assists, yellow_cards, red_cards, clean_sheets, source, synced_at
     ) VALUES (
       @season, @tm_player_id, @af_player_id, @appearances, @lineups,
       @goals, @assists, @yellow_cards, @red_cards, 0, 'tm_games', @synced_at
     )
     ON CONFLICT(season, tm_player_id) DO UPDATE SET
       af_player_id = excluded.af_player_id,
       appearances = excluded.appearances,
       lineups = excluded.lineups,
       goals = excluded.goals,
       assists = excluded.assists,
       yellow_cards = excluded.yellow_cards,
       red_cards = excluded.red_cards,
       synced_at = excluded.synced_at`,
  );

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const a of apps) {
      const c = cardMap.get(a.tmPlayerId);
      upsert.run({
        season,
        tm_player_id: a.tmPlayerId,
        af_player_id: a.afPlayerId,
        appearances: a.appearances,
        lineups: a.lineups,
        goals: goalMap.get(a.tmPlayerId) ?? 0,
        assists: assistMap.get(a.tmPlayerId) ?? 0,
        yellow_cards: c?.yellow ?? 0,
        red_cards: c?.red ?? 0,
        synced_at: now,
      });
    }
  });
  tx();
  setMeta(`tm_perf_${season}`, String(apps.length));
  return apps.length;
}
