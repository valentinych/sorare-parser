import * as af from "../clients/apiFootball.js";
import { getDb, setMeta } from "../db/index.js";

export async function syncLeagueFixtures(leagueId: number, season: number): Promise<number> {
  const { response } = await af.fixtures(leagueId, season);
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO fixtures
       (id, date, round, home_team_id, away_team_id, status, league_id, season, is_preseason, home_goals, away_goals)
     VALUES (@id, @date, @round, @home, @away, @status, @league_id, @season, 0, @home_goals, @away_goals)
     ON CONFLICT(id) DO UPDATE SET
       date = excluded.date,
       round = excluded.round,
       home_team_id = excluded.home_team_id,
       away_team_id = excluded.away_team_id,
       status = excluded.status,
       league_id = excluded.league_id,
       season = excluded.season,
       home_goals = excluded.home_goals,
       away_goals = excluded.away_goals`,
  );

  const tx = db.transaction((rows: af.AfFixture[]) => {
    for (const row of rows) {
      upsert.run({
        id: row.fixture.id,
        date: row.fixture.date,
        round: row.league.round,
        home: row.teams.home.id,
        away: row.teams.away.id,
        status: row.fixture.status.short,
        league_id: row.league.id,
        season,
        home_goals: row.goals.home,
        away_goals: row.goals.away,
      });
    }
  });
  tx(response);
  setMeta(`fixtures_${season}`, String(response.length));
  return response.length;
}

/** Keep old name working for 2025 sync. */
export async function syncFixtures(): Promise<number> {
  const { config } = await import("../config.js");
  return syncLeagueFixtures(config.leagueId, config.season);
}
