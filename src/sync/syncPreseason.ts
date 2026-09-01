import * as af from "../clients/apiFootball.js";
import { config } from "../config.js";
import { getDb, setMeta } from "../db/index.js";

function isFriendlyLeague(league: { id: number; name: string }): boolean {
  const name = league.name.toLowerCase();
  return league.id === 667 || name.includes("friendly");
}

function inPreseasonWindow(isoDate: string, from: string, to: string): boolean {
  const day = isoDate.slice(0, 10);
  return day >= from && day <= to;
}

/**
 * Sync club friendlies (+ other non-domestic games in the preseason window)
 * for every team in season_teams for the given league.
 *
 * Source: API Football only. Fetches team season fixtures without from/to
 * (AF often returns empty when from/to is combined with season), then filters
 * client-side to the configured preseason window.
 */
export async function syncPreseason(
  season: number,
  leagueId = config.leagueId,
  opts?: { onTeam?: (done: number, total: number, teamName: string) => void },
): Promise<number> {
  const db = getDb();
  const from = config.preseasonFrom;
  const to = config.preseasonTo;

  const teams = db
    .prepare(
      `SELECT team_id AS id, name FROM season_teams
       WHERE season = ? AND (league_id = ? OR league_id IS NULL)
       ORDER BY name`,
    )
    .all(season, leagueId) as Array<{ id: number; name: string }>;

  const upsertTeam = db.prepare(
    `INSERT INTO teams (id, name) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
  );

  const upsertFixture = db.prepare(
    `INSERT INTO fixtures
       (id, date, round, home_team_id, away_team_id, status, league_id, season, is_preseason, home_goals, away_goals)
     VALUES (@id, @date, @round, @home, @away, @status, @league_id, @season, 1, @home_goals, @away_goals)
     ON CONFLICT(id) DO UPDATE SET
       date = excluded.date,
       round = excluded.round,
       status = excluded.status,
       is_preseason = 1,
       home_goals = excluded.home_goals,
       away_goals = excluded.away_goals,
       league_id = excluded.league_id,
       season = excluded.season`,
  );

  let n = 0;
  const seen = new Set<number>();
  const existingForm = db.prepare(
    `SELECT played FROM preseason_team_form WHERE season = ? AND team_id = ?`,
  );

  let i = 0;
  for (const { id, name } of teams) {
    i += 1;
    opts?.onTeam?.(i, teams.length, name);

    const prior = existingForm.get(season, id) as { played: number } | undefined;
    if (prior && prior.played > 0) {
      console.log(`  preseason ${name} (${id}): skip (form played=${prior.played})`);
      continue;
    }

    try {
      // No from/to — AF requires season and often returns [] when dates are also set.
      const { response } = await af.teamFixtures({ team: id, season });

      let kept = 0;
      let friendlies = 0;
      for (const row of response) {
        const friendly = isFriendlyLeague(row.league);
        if (!inPreseasonWindow(row.fixture.date, from, to)) continue;
        // Drop domestic league games; keep friendlies and other competitions in window.
        if (!friendly && row.league.id === leagueId) continue;
        if (seen.has(row.fixture.id)) continue;
        seen.add(row.fixture.id);

        upsertTeam.run(row.teams.home.id, row.teams.home.name);
        upsertTeam.run(row.teams.away.id, row.teams.away.name);
        upsertFixture.run({
          id: row.fixture.id,
          date: row.fixture.date,
          round: row.league.round ?? row.league.name,
          home: row.teams.home.id,
          away: row.teams.away.id,
          status: row.fixture.status.short,
          league_id: row.league.id,
          season,
          home_goals: row.goals.home,
          away_goals: row.goals.away,
        });
        n++;
        kept++;
        if (friendly) friendlies++;
      }

      console.log(`  preseason ${name} (${id}): +${kept} (${friendlies} friendlies) in ${from}…${to}`);
    } catch (err) {
      console.warn(
        `  preseason ${name} (${id}) FAILED:`,
        err instanceof Error ? err.message : err,
      );
    }
    await af.sleep(200);
  }

  // compute form per team from finished preseason fixtures
  const formUpsert = db.prepare(
    `INSERT INTO preseason_team_form
       (season, team_id, played, wins, draws, losses, gf, ga, form_score)
     VALUES (@season, @team_id, @played, @wins, @draws, @losses, @gf, @ga, @form_score)
     ON CONFLICT(season, team_id) DO UPDATE SET
       played = excluded.played,
       wins = excluded.wins,
       draws = excluded.draws,
       losses = excluded.losses,
       gf = excluded.gf,
       ga = excluded.ga,
       form_score = excluded.form_score`,
  );

  for (const { id } of teams) {
    const rows = db
      .prepare(
        `SELECT home_team_id, away_team_id, home_goals, away_goals, status
         FROM fixtures
         WHERE is_preseason = 1 AND season = ? AND status IN ('FT', 'AET', 'PEN')
           AND (home_team_id = ? OR away_team_id = ?)
           AND home_goals IS NOT NULL AND away_goals IS NOT NULL`,
      )
      .all(season, id, id) as Array<{
      home_team_id: number;
      away_team_id: number;
      home_goals: number;
      away_goals: number;
    }>;

    let played = 0;
    let wins = 0;
    let draws = 0;
    let losses = 0;
    let gf = 0;
    let ga = 0;

    for (const r of rows) {
      const home = r.home_team_id === id;
      const forGoals = home ? r.home_goals : r.away_goals;
      const against = home ? r.away_goals : r.home_goals;
      played++;
      gf += forGoals;
      ga += against;
      if (forGoals > against) wins++;
      else if (forGoals === against) draws++;
      else losses++;
    }

    const points = wins * 3 + draws;
    const maxPoints = Math.max(played * 3, 1);
    const gd = gf - ga;
    const form_score = Number(
      Math.max(
        0,
        Math.min(1, (points / maxPoints) * 0.75 + (Math.tanh(gd / 6) * 0.5 + 0.5) * 0.25),
      ).toFixed(3),
    );

    formUpsert.run({ season, team_id: id, played, wins, draws, losses, gf, ga, form_score });
  }

  setMeta(`preseason_${leagueId}_${season}`, String(n));
  return n;
}
