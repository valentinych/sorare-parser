import * as mantra from "../clients/mantra.js";
import { getDb, setMeta } from "../db/index.js";
import { uniqueMantraTournaments } from "../lib/afLeagues.js";

/**
 * Mantra sync — one tournament at a time.
 * Client uses rateLimit4perSec (≤4 req/s) — do not raise concurrency.
 */
function fullName(first: string | null, last: string): string {
  return [first, last].filter(Boolean).join(" ").trim();
}

export async function syncMantraLeagues(tournamentId: number): Promise<number> {
  const leagues = await mantra.fetchMantraLeagues(tournamentId);
  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO mantra_leagues (id, name, division, division_id, season_id, status, tournament_id, synced_at)
     VALUES (@id, @name, @division, @division_id, @season_id, @status, @tournament_id, @synced_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       division = excluded.division,
       division_id = excluded.division_id,
       season_id = excluded.season_id,
       status = excluded.status,
       tournament_id = excluded.tournament_id,
       synced_at = excluded.synced_at`,
  );
  const tx = db.transaction((rows: mantra.MantraLeague[]) => {
    for (const l of rows) {
      upsert.run({
        id: l.id,
        name: l.name,
        division: l.division,
        division_id: l.divisionId,
        season_id: l.seasonId,
        status: l.status,
        tournament_id: tournamentId,
        synced_at: now,
      });
    }
  });
  tx(leagues);
  setMeta(`mantra_leagues_${tournamentId}`, String(leagues.length));
  return leagues.length;
}

export async function syncMantraList(tournamentId: number): Promise<number> {
  const players = await mantra.fetchAllMantraPlayers(tournamentId);
  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO mantra_players (
       id, name, first_name, full_name, positions_json, positions_ital_json,
       club_id, club_name, club_code, club_logo, club_tm_url, avatar_path,
       base_score, total_score, appearances, average_price, teams_count, leagues_json,
       tournament_id, list_synced_at
     ) VALUES (
       @id, @name, @first_name, @full_name, @positions_json, @positions_ital_json,
       @club_id, @club_name, @club_code, @club_logo, @club_tm_url, @avatar_path,
       @base_score, @total_score, @appearances, @average_price, @teams_count, @leagues_json,
       @tournament_id, @list_synced_at
     )
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       first_name = excluded.first_name,
       full_name = excluded.full_name,
       positions_json = excluded.positions_json,
       positions_ital_json = excluded.positions_ital_json,
       club_id = excluded.club_id,
       club_name = excluded.club_name,
       club_code = excluded.club_code,
       club_logo = excluded.club_logo,
       club_tm_url = excluded.club_tm_url,
       avatar_path = excluded.avatar_path,
       base_score = excluded.base_score,
       total_score = excluded.total_score,
       appearances = excluded.appearances,
       average_price = excluded.average_price,
       teams_count = excluded.teams_count,
       leagues_json = excluded.leagues_json,
       tournament_id = excluded.tournament_id,
       list_synced_at = excluded.list_synced_at`,
  );

  const tx = db.transaction((rows: mantra.MantraListPlayer[]) => {
    for (const p of rows) {
      upsert.run({
        id: p.id,
        name: p.name,
        first_name: p.firstName,
        full_name: fullName(p.firstName, p.name),
        positions_json: JSON.stringify(p.positions),
        positions_ital_json: JSON.stringify(p.positionsItal),
        club_id: p.clubId,
        club_name: p.clubName,
        club_code: p.clubCode,
        club_logo: p.clubLogo,
        club_tm_url: p.clubTmUrl,
        avatar_path: p.avatarPath,
        base_score: p.baseScore,
        total_score: p.totalScore,
        appearances: p.appearances,
        average_price: p.averagePrice,
        teams_count: p.teamsCount,
        leagues_json: JSON.stringify(p.leagues),
        tournament_id: tournamentId,
        list_synced_at: now,
      });
    }
  });
  tx(players);
  setMeta(`mantra_list_${tournamentId}`, String(players.length));
  return players.length;
}

/** Fetch full profiles for players missing profile_synced_at (cached afterwards). */
export async function syncMantraProfiles(
  opts: { limit?: number; force?: boolean; tournamentId?: number } = {},
): Promise<number> {
  const db = getDb();
  const pending = (
    opts.force
      ? opts.tournamentId != null
        ? db
            .prepare(`SELECT id FROM mantra_players WHERE tournament_id = ? ORDER BY id`)
            .all(opts.tournamentId)
        : db.prepare(`SELECT id FROM mantra_players ORDER BY id`).all()
      : opts.tournamentId != null
        ? db
            .prepare(
              `SELECT id FROM mantra_players
               WHERE tournament_id = ?
                 AND (profile_synced_at IS NULL OR tm_url IS NULL)
               ORDER BY id`,
            )
            .all(opts.tournamentId)
        : db
            .prepare(
              `SELECT id FROM mantra_players
               WHERE profile_synced_at IS NULL OR tm_url IS NULL
               ORDER BY id`,
            )
            .all()
  ) as Array<{ id: number }>;

  const slice = opts.limit ? pending.slice(0, opts.limit) : pending;
  const upsert = db.prepare(
    `UPDATE mantra_players SET
       name = @name,
       first_name = @first_name,
       full_name = @full_name,
       positions_json = @positions_json,
       positions_ital_json = @positions_ital_json,
       club_id = @club_id,
       club_name = @club_name,
       club_code = @club_code,
       club_logo = @club_logo,
       club_tm_url = @club_tm_url,
       avatar_path = @avatar_path,
       base_score = @base_score,
       total_score = @total_score,
       appearances = @appearances,
       average_price = @average_price,
       teams_count = @teams_count,
       leagues_json = @leagues_json,
       tm_url = @tm_url,
       tm_price = @tm_price,
       birth_date = @birth_date,
       age = @age,
       height = @height,
       nationality = @nationality,
       shirt_number = @shirt_number,
       profile_synced_at = @profile_synced_at,
       raw_json = @raw_json
     WHERE id = @id`,
  );

  let n = 0;
  for (const { id } of slice) {
    try {
      const p = await mantra.fetchMantraProfile(id);
      const now = new Date().toISOString();
      upsert.run({
        id: p.id,
        name: p.name,
        first_name: p.firstName,
        full_name: fullName(p.firstName, p.name),
        positions_json: JSON.stringify(p.positions),
        positions_ital_json: JSON.stringify(p.positionsItal),
        club_id: p.clubId,
        club_name: p.clubName,
        club_code: p.clubCode,
        club_logo: p.clubLogo,
        club_tm_url: p.clubTmUrl,
        avatar_path: p.avatarPath,
        base_score: p.baseScore,
        total_score: p.totalScore,
        appearances: p.appearances,
        average_price: p.averagePrice,
        teams_count: p.teamsCount,
        leagues_json: JSON.stringify(p.leagues),
        tm_url: p.tmUrl,
        tm_price: p.tmPrice,
        birth_date: p.birthDate,
        age: p.age,
        height: p.height,
        nationality: p.nationality,
        shirt_number: p.number,
        profile_synced_at: now,
        raw_json: JSON.stringify(p),
      });
      n++;
      if (n % 25 === 0) console.log(`  mantra profiles ${n}/${slice.length}`);
    } catch (err) {
      console.warn(`  mantra profile ${id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  setMeta("mantra_profiles", String(n));
  return n;
}

/** Fantasy teams + rosters for active leagues of a tournament (≤4 req/s via client). */
export async function syncMantraFantasyTeams(
  tournamentId: number,
  opts: { leagueIds?: number[] } = {},
): Promise<number> {
  const db = getDb();
  const requested = (opts.leagueIds ?? []).filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  const leagues = requested.length
    ? requested.map((id) => ({ id }))
    : (db
        .prepare(
          `SELECT id FROM mantra_leagues
           WHERE (tournament_id = ? OR (tournament_id IS NULL AND ? = 18))
             AND (status = 'active' OR status IS NULL)
           ORDER BY id`,
        )
        .all(tournamentId, tournamentId) as Array<{ id: number }>);

  if (!leagues.length) {
    console.log(`  fantasy teams: no leagues for tournament ${tournamentId}`);
    return 0;
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO mantra_fantasy_teams (
       id, league_id, tournament_id, name, code, logo_path, user_id, budget, players_json, synced_at
     ) VALUES (
       @id, @league_id, @tournament_id, @name, @code, @logo_path, @user_id, @budget, @players_json, @synced_at
     )
     ON CONFLICT(id) DO UPDATE SET
       league_id = excluded.league_id,
       tournament_id = excluded.tournament_id,
       name = excluded.name,
       code = excluded.code,
       logo_path = excluded.logo_path,
       user_id = excluded.user_id,
       budget = excluded.budget,
       players_json = excluded.players_json,
       synced_at = excluded.synced_at`,
  );

  let n = 0;
  for (const { id: leagueId } of leagues) {
    const summaries = await mantra.fetchLeagueTeams(leagueId);
    console.log(`  fantasy league ${leagueId}: ${summaries.length} teams`);
    for (const s of summaries) {
      try {
        const team = await mantra.fetchFantasyTeam(s.id);
        upsert.run({
          id: team.id,
          league_id: team.leagueId || leagueId,
          tournament_id: tournamentId,
          name: team.name || s.name,
          code: team.code,
          logo_path: team.logoPath ?? s.logoPath,
          user_id: team.userId,
          budget: team.budget,
          players_json: JSON.stringify(team.playerIds),
          synced_at: now,
        });
        n++;
      } catch (err) {
        console.warn(
          `  fantasy team ${s.id} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  if (!requested.length) {
    setMeta(`mantra_fantasy_teams_${tournamentId}`, String(n));
  }
  return n;
}

export async function syncMantraTournament(
  tournamentId: number,
  opts: {
    profileLimit?: number;
    forceProfiles?: boolean;
    skipProfiles?: boolean;
    skipFantasyTeams?: boolean;
  } = {},
): Promise<void> {
  console.log(`Mantra tournament ${tournamentId}: leagues…`);
  const leagues = await syncMantraLeagues(tournamentId);
  console.log(`  leagues: ${leagues}`);
  console.log(`Mantra tournament ${tournamentId}: player list…`);
  const listed = await syncMantraList(tournamentId);
  console.log(`  list: ${listed}`);
  if (!opts.skipFantasyTeams) {
    console.log(`Mantra tournament ${tournamentId}: fantasy teams…`);
    const teams = await syncMantraFantasyTeams(tournamentId);
    console.log(`  fantasy teams: ${teams}`);
  }
  if (opts.skipProfiles) {
    console.log(`  profiles skipped`);
    return;
  }
  console.log(
    opts.forceProfiles
      ? `Mantra tournament ${tournamentId}: profiles (force)…`
      : `Mantra tournament ${tournamentId}: profiles (missing only)…`,
  );
  const profiles = await syncMantraProfiles({
    limit: opts.profileLimit,
    force: opts.forceProfiles,
    tournamentId,
  });
  console.log(`  profiles updated: ${profiles}`);
}

export async function syncMantraAll(
  opts: {
    profileLimit?: number;
    forceProfiles?: boolean;
    skipProfiles?: boolean;
    skipFantasyTeams?: boolean;
    tournamentIds?: number[];
  } = {},
): Promise<void> {
  const ids = opts.tournamentIds?.length ? opts.tournamentIds : uniqueMantraTournaments();
  for (const tid of ids) {
    await syncMantraTournament(tid, opts);
  }
}
