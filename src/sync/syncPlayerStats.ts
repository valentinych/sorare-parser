import * as af from "../clients/apiFootball.js";
import { config } from "../config.js";
import { getDb, setMeta } from "../db/index.js";

export async function syncPlayerStats(): Promise<number> {
  const rows = await af.allPlayers(config.leagueId, config.season);
  const db = getDb();

  const upsertPlayer = db.prepare(
    `INSERT INTO players (id, name, age, nationality, photo, position, team_id)
     VALUES (@id, @name, @age, @nationality, @photo, @position, @team_id)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       age = excluded.age,
       nationality = excluded.nationality,
       photo = excluded.photo,
       position = COALESCE(excluded.position, players.position),
       team_id = COALESCE(excluded.team_id, players.team_id)`,
  );

  const upsertStats = db.prepare(
    `INSERT INTO player_season_stats
       (player_id, team_id, position, appearances, lineups, minutes, goals, assists, rating)
     VALUES (@player_id, @team_id, @position, @appearances, @lineups, @minutes, @goals, @assists, @rating)
     ON CONFLICT(player_id, team_id) DO UPDATE SET
       position = excluded.position,
       appearances = excluded.appearances,
       lineups = excluded.lineups,
       minutes = excluded.minutes,
       goals = excluded.goals,
       assists = excluded.assists,
       rating = excluded.rating`,
  );

  const tx = db.transaction((players: af.AfPlayerRow[]) => {
    for (const row of players) {
      const stats = row.statistics?.[0];
      if (!stats) continue;
      const position = normalizePos(stats.games.position);
      upsertPlayer.run({
        id: row.player.id,
        name: row.player.name,
        age: row.player.age,
        nationality: row.player.nationality,
        photo: row.player.photo,
        position,
        team_id: stats.team.id,
      });
      upsertStats.run({
        player_id: row.player.id,
        team_id: stats.team.id,
        position,
        appearances: stats.games.appearences ?? 0,
        lineups: stats.games.lineups ?? 0,
        minutes: stats.games.minutes ?? 0,
        goals: stats.goals.total ?? 0,
        assists: stats.goals.assists ?? 0,
        rating: stats.games.rating ? Number(stats.games.rating) : null,
      });
    }
  });
  tx(rows);
  setMeta("players", String(rows.length));
  return rows.length;
}

function normalizePos(pos: string | null): string | null {
  if (!pos) return null;
  const p = pos.toLowerCase();
  if (p.includes("goalkeeper")) return "GK";
  if (p.includes("defender")) return "DEF";
  if (p.includes("midfield")) return "MID";
  if (p.includes("attack") || p.includes("forward")) return "ATT";
  return pos.toUpperCase();
}
