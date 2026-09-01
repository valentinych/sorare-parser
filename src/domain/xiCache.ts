import type Database from "better-sqlite3";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { leagueById } from "../lib/afLeagues.js";
import {
  EXPECTED11_XI_LEAGUE_ID,
  expected11SnapshotVersion,
} from "./expected11Xi.js";
import {
  SERIE_A_XI_LEAGUE_ID,
  serieALineupSnapshotVersion,
} from "./serieALineup.js";
import { liveDraftAwardsVersion } from "./liveDraftOwnership.js";

export function xiPredictionsCacheKey(season: number, leagueId: number): string {
  return `xi:${season}:${leagueId}`;
}

export function xiBoardCacheKey(season: number, leagueId: number): string {
  return `board:${season}:${leagueId}`;
}

/** Hour bucket is a safety net for time-dependent Sorare/Expected11 freshness. */
function hourBucket(now = new Date()): string {
  return now.toISOString().slice(0, 13);
}

export function xiCacheVersion(
  season: number,
  leagueId: number,
  database: Database.Database = getDb(),
  now = new Date(),
): string {
  const tournamentId = leagueById(leagueId)?.mantraTournamentId ?? -1;
  const expected11 =
    leagueId === EXPECTED11_XI_LEAGUE_ID
      ? expected11SnapshotVersion(database) ?? ""
      : "";
  const serieALineup =
    leagueId === SERIE_A_XI_LEAGUE_ID
      ? serieALineupSnapshotVersion(database) ?? ""
      : "";
  const row = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM squad_players sp
          JOIN season_teams st ON st.season = sp.season AND st.team_id = sp.team_id
          WHERE sp.season = ? AND (st.league_id = ? OR (st.league_id IS NULL AND ? = 106))) AS squads,
         (SELECT COUNT(*) FROM player_values pv
          JOIN season_teams st ON st.season = ? AND st.team_id = pv.team_id
          WHERE st.league_id = ? OR (st.league_id IS NULL AND ? = 106)) AS vals,
         (SELECT COUNT(*) FROM player_stats ps
          JOIN season_teams st ON st.team_id = ps.team_id AND st.season = ?
          WHERE ps.season = ? AND (st.league_id = ? OR (st.league_id IS NULL AND ? = 106))) AS stats,
         (SELECT COUNT(*) || ':' || COALESCE(MAX(synced_at), '')
          FROM manager_formation_summary mfs
          JOIN season_teams st ON st.team_id = mfs.team_id AND st.season = ?
          WHERE st.league_id = ? OR (st.league_id IS NULL AND ? = 106)) AS formations,
         (SELECT COUNT(*) FROM sorare_player_predictions
          WHERE league_id = ?
            AND datetime(kickoff) >= datetime('now', '-2 hours')
            AND datetime(fetched_at) >= datetime('now', '-12 hours')) AS sorareLive,
         (SELECT COUNT(*) || ':' || COALESCE(MAX(profile_synced_at), '')
          FROM mantra_players
          WHERE tournament_id = ? OR (tournament_id IS NULL AND ? = 18)) AS mantra`,
    )
    .get(
      season,
      leagueId,
      leagueId,
      season,
      leagueId,
      leagueId,
      season,
      config.season,
      leagueId,
      leagueId,
      season,
      leagueId,
      leagueId,
      leagueId,
      tournamentId,
      tournamentId,
    ) as {
    squads: number;
    vals: number;
    stats: number;
    formations: string;
    sorareLive: number;
    mantra: string;
  };

  return [
    season,
    leagueId,
    hourBucket(now),
    expected11,
    serieALineup,
    row.squads,
    row.vals,
    row.stats,
    row.formations,
    row.sorareLive,
    row.mantra,
    liveDraftAwardsVersion(database),
  ].join("|");
}
