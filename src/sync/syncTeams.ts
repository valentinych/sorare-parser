import * as af from "../clients/apiFootball.js";
import { getDb, setMeta } from "../db/index.js";

export async function syncTeamsForSeason(leagueId: number, season: number): Promise<number> {
  const { response } = await af.teams(leagueId, season);
  const db = getDb();
  const upsertTeam = db.prepare(
    `INSERT INTO teams (id, name, code, logo) VALUES (@id, @name, @code, @logo)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, code = excluded.code, logo = excluded.logo`,
  );
  const upsertSeason = db.prepare(
    `INSERT INTO season_teams (season, team_id, name, code, logo, league_id)
     VALUES (@season, @id, @name, @code, @logo, @league_id)
     ON CONFLICT(season, team_id) DO UPDATE SET
       name = excluded.name, code = excluded.code, logo = excluded.logo,
       league_id = excluded.league_id`,
  );

  const tx = db.transaction((rows: af.AfTeam[]) => {
    for (const row of rows) {
      const payload = {
        season,
        id: row.team.id,
        name: row.team.name,
        code: row.team.code,
        logo: row.team.logo,
        league_id: leagueId,
      };
      upsertTeam.run(payload);
      upsertSeason.run(payload);
    }
  });
  tx(response);
  setMeta(`teams_${leagueId}_${season}`, String(response.length));
  return response.length;
}
