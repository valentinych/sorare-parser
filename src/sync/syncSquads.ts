import * as af from "../clients/apiFootball.js";
import { config } from "../config.js";
import { getDb, setMeta } from "../db/index.js";
import { normalizePos } from "../lib/names.js";

export async function syncSquads(
  season: number,
  leagueId?: number,
  opts?: { onTeam?: (done: number, total: number, teamId: number) => void },
): Promise<number> {
  const db = getDb();
  const teams = leagueId
    ? (db
        .prepare(`SELECT team_id AS id FROM season_teams WHERE season = ? AND league_id = ?`)
        .all(season, leagueId) as Array<{ id: number }>)
    : (db.prepare(`SELECT team_id AS id FROM season_teams WHERE season = ?`).all(season) as Array<{
        id: number;
      }>);

  const upsertPlayer = db.prepare(
    `INSERT INTO players (id, name, age, photo, position, team_id)
     VALUES (@id, @name, @age, @photo, @position, @team_id)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       age = excluded.age,
       photo = excluded.photo,
       position = COALESCE(excluded.position, players.position),
       team_id = excluded.team_id`,
  );
  const upsertSquad = db.prepare(
    `INSERT INTO squad_players
       (season, team_id, player_id, name, age, number, position, photo)
     VALUES (@season, @team_id, @player_id, @name, @age, @number, @position, @photo)
     ON CONFLICT(season, team_id, player_id) DO UPDATE SET
       name = excluded.name,
       age = excluded.age,
       number = excluded.number,
       position = excluded.position,
       photo = excluded.photo`,
  );

  const delDeparted = db.prepare(
    `DELETE FROM squad_players
     WHERE season = ? AND team_id = ? AND player_id NOT IN (
       SELECT CAST(value AS INTEGER) FROM json_each(?)
     )`,
  );

  let total = 0;
  let i = 0;
  for (const { id } of teams) {
    i += 1;
    opts?.onTeam?.(i, teams.length, id);
    const players = await af.squad(id);
    const tx = db.transaction((rows: af.AfSquadPlayer[]) => {
      for (const p of rows) {
        const position = normalizePos(p.position);
        upsertPlayer.run({
          id: p.id,
          name: p.name,
          age: p.age,
          photo: p.photo,
          position,
          team_id: id,
        });
        upsertSquad.run({
          season,
          team_id: id,
          player_id: p.id,
          name: p.name,
          age: p.age,
          number: p.number,
          position,
          photo: p.photo,
        });
      }
      // Remove transfers — upsert alone keeps departed players on the old roster.
      // Skip when API returned empty (avoid wiping roster on a failed/empty response).
      if (rows.length > 0) {
        delDeparted.run(season, id, JSON.stringify(rows.map((p) => p.id)));
      }
    });
    tx(players);
    total += players.length;
    console.log(`  squad ${id}: ${players.length}`);
    await af.sleep(200);
  }

  setMeta(`squads_${leagueId ?? "all"}_${season}`, String(total));
  return total;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numOr0(v: unknown): number {
  return numOrNull(v) ?? 0;
}

/** Map one AF statistics block → player_comp_stats row. */
export function compStatsPayload(
  season: number,
  playerId: number,
  block: af.AfPlayerStatBlock,
): Record<string, unknown> | null {
  const leagueId = block.league?.id;
  const teamId = block.team?.id;
  if (leagueId == null || teamId == null) return null;
  const yellow = numOr0(block.cards?.yellow);
  const yellowRed = numOr0(block.cards?.yellowred);
  const red = numOr0(block.cards?.red) + yellowRed;
  return {
    season,
    player_id: playerId,
    team_id: teamId,
    league_id: leagueId,
    league_name: block.league?.name ?? null,
    team_name: block.team?.name ?? null,
    position: normalizePos(block.games.position),
    appearances: numOr0(block.games.appearences),
    lineups: numOr0(block.games.lineups),
    minutes: numOr0(block.games.minutes),
    goals: numOr0(block.goals.total),
    assists: numOr0(block.goals.assists),
    rating: block.games.rating ? Number(block.games.rating) : null,
    yellow_cards: yellow,
    red_cards: red,
    goals_conceded: numOr0(block.goals.conceded),
    clean_sheets: numOr0(block.clean_sheets),
    shots_total: numOrNull(block.shots?.total),
    shots_on: numOrNull(block.shots?.on),
    passes_total: numOrNull(block.passes?.total),
    key_passes: numOrNull(block.passes?.key),
    pass_accuracy: numOrNull(block.passes?.accuracy),
    tackles_total: numOrNull(block.tackles?.total),
    blocks: numOrNull(block.tackles?.blocks),
    interceptions: numOrNull(block.tackles?.interceptions),
    dribbles_attempts: numOrNull(block.dribbles?.attempts),
    dribbles_success: numOrNull(block.dribbles?.success),
    fouls_drawn: numOrNull(block.fouls?.drawn),
    fouls_committed: numOrNull(block.fouls?.committed),
    pen_scored: numOrNull(block.penalty?.scored),
    pen_missed: numOrNull(block.penalty?.missed),
    saves: numOrNull(block.goals.saves),
  };
}

function prepareCompStatsUpsert() {
  const db = getDb();
  return db.prepare(
    `INSERT INTO player_comp_stats
       (season, player_id, team_id, league_id, league_name, team_name, position,
        appearances, lineups, minutes, goals, assists, rating,
        yellow_cards, red_cards, goals_conceded, clean_sheets,
        shots_total, shots_on, passes_total, key_passes, pass_accuracy,
        tackles_total, blocks, interceptions, dribbles_attempts, dribbles_success,
        fouls_drawn, fouls_committed, pen_scored, pen_missed, saves)
     VALUES
       (@season, @player_id, @team_id, @league_id, @league_name, @team_name, @position,
        @appearances, @lineups, @minutes, @goals, @assists, @rating,
        @yellow_cards, @red_cards, @goals_conceded, @clean_sheets,
        @shots_total, @shots_on, @passes_total, @key_passes, @pass_accuracy,
        @tackles_total, @blocks, @interceptions, @dribbles_attempts, @dribbles_success,
        @fouls_drawn, @fouls_committed, @pen_scored, @pen_missed, @saves)
     ON CONFLICT(season, player_id, team_id, league_id) DO UPDATE SET
       league_name = excluded.league_name,
       team_name = excluded.team_name,
       position = excluded.position,
       appearances = excluded.appearances,
       lineups = excluded.lineups,
       minutes = excluded.minutes,
       goals = excluded.goals,
       assists = excluded.assists,
       rating = excluded.rating,
       yellow_cards = excluded.yellow_cards,
       red_cards = excluded.red_cards,
       goals_conceded = excluded.goals_conceded,
       clean_sheets = excluded.clean_sheets,
       shots_total = excluded.shots_total,
       shots_on = excluded.shots_on,
       passes_total = excluded.passes_total,
       key_passes = excluded.key_passes,
       pass_accuracy = excluded.pass_accuracy,
       tackles_total = excluded.tackles_total,
       blocks = excluded.blocks,
       interceptions = excluded.interceptions,
       dribbles_attempts = excluded.dribbles_attempts,
       dribbles_success = excluded.dribbles_success,
       fouls_drawn = excluded.fouls_drawn,
       fouls_committed = excluded.fouls_committed,
       pen_scored = excluded.pen_scored,
       pen_missed = excluded.pen_missed,
       saves = excluded.saves`,
  );
}

function upsertCompBlocks(
  upsertComp: ReturnType<typeof prepareCompStatsUpsert>,
  season: number,
  row: af.AfPlayerRow,
  onlyLeagueId?: number,
): number {
  let n = 0;
  for (const block of row.statistics ?? []) {
    if (onlyLeagueId != null && block.league?.id !== onlyLeagueId) continue;
    const payload = compStatsPayload(season, row.player.id, block);
    if (!payload) continue;
    upsertComp.run(payload);
    n += 1;
  }
  return n;
}

export async function syncPlayerStatsSeason(leagueId: number, season: number): Promise<number> {
  const rows = await af.allPlayers(leagueId, season);
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

  const upsertTeam = db.prepare(
    `INSERT INTO teams (id, name) VALUES (@team_id, @team_name)
     ON CONFLICT(id) DO NOTHING`,
  );

  const upsertStats = db.prepare(
    `INSERT INTO player_stats
       (season, player_id, team_id, position, appearances, lineups, minutes, goals, assists, rating,
        yellow_cards, red_cards, goals_conceded, clean_sheets)
     VALUES (@season, @player_id, @team_id, @position, @appearances, @lineups, @minutes, @goals, @assists, @rating,
        @yellow_cards, @red_cards, @goals_conceded, @clean_sheets)
     ON CONFLICT(season, player_id, team_id) DO UPDATE SET
       position = excluded.position,
       appearances = excluded.appearances,
       lineups = excluded.lineups,
       minutes = excluded.minutes,
       goals = excluded.goals,
       assists = excluded.assists,
       rating = excluded.rating,
       yellow_cards = excluded.yellow_cards,
       red_cards = excluded.red_cards,
       goals_conceded = excluded.goals_conceded,
       clean_sheets = excluded.clean_sheets`,
  );

  // legacy table for old endpoints
  const upsertLegacy = db.prepare(
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

  const upsertComp = prepareCompStatsUpsert();

  const tx = db.transaction((players: af.AfPlayerRow[]) => {
    for (const row of players) {
      // Store every competition block returned (usually just the queried league).
      upsertCompBlocks(upsertComp, season, row);

      const stats =
        row.statistics.find((s) => s.league?.id === leagueId) ??
        row.statistics.find((s) => s.team?.id) ??
        row.statistics[0];
      if (!stats) continue;
      const position = normalizePos(stats.games.position);
      const yellow = Number(stats.cards?.yellow ?? 0) || 0;
      const yellowRed = Number(stats.cards?.yellowred ?? 0) || 0;
      const red = (Number(stats.cards?.red ?? 0) || 0) + yellowRed;
      const payload = {
        season,
        id: row.player.id,
        name: row.player.name,
        age: row.player.age,
        nationality: row.player.nationality,
        photo: row.player.photo,
        position,
        team_id: stats.team.id,
        team_name: stats.team.name,
        player_id: row.player.id,
        appearances: stats.games.appearences ?? 0,
        lineups: stats.games.lineups ?? 0,
        minutes: stats.games.minutes ?? 0,
        goals: stats.goals.total ?? 0,
        assists: stats.goals.assists ?? 0,
        rating: stats.games.rating ? Number(stats.games.rating) : null,
        yellow_cards: yellow,
        red_cards: red,
        goals_conceded: Number(stats.goals.conceded ?? 0) || 0,
        clean_sheets: Number(stats.clean_sheets ?? 0) || 0,
      };
      upsertTeam.run(payload);
      upsertPlayer.run(payload);
      upsertStats.run(payload);
      if (season === config.season) upsertLegacy.run(payload);
    }
  });
  tx(rows);
  setMeta(`player_stats_${leagueId}_${season}`, String(rows.length));
  return rows.length;
}

/**
 * Sync cup / European competition into player_comp_stats only
 * (does not overwrite domestic player_stats used for ratings).
 */
export async function syncPlayerCompStatsSeason(leagueId: number, season: number): Promise<number> {
  const rows = await af.allPlayers(leagueId, season);
  const db = getDb();
  const upsertTeam = db.prepare(
    `INSERT INTO teams (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`,
  );
  const upsertComp = prepareCompStatsUpsert();
  let blocks = 0;
  const tx = db.transaction((players: af.AfPlayerRow[]) => {
    for (const row of players) {
      for (const block of row.statistics ?? []) {
        if (block.league?.id !== leagueId) continue;
        if (block.team?.id) upsertTeam.run(block.team.id, block.team.name);
      }
      blocks += upsertCompBlocks(upsertComp, season, row, leagueId);
    }
  });
  tx(rows);
  setMeta(`player_comp_stats_${leagueId}_${season}`, String(blocks));
  return blocks;
}

/**
 * Fetch /players?id=&season= for each AF id — full multi-competition season lines.
 * Rate-limited (~4/s). Prefer for season=config.season only.
 */
export async function syncPlayerCompStatsByIds(
  playerIds: number[],
  season: number,
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<number> {
  const upsertComp = prepareCompStatsUpsert();
  const upsertTeam = getDb().prepare(
    `INSERT INTO teams (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`,
  );
  let blocks = 0;
  const total = playerIds.length;
  for (let i = 0; i < playerIds.length; i++) {
    const id = playerIds[i]!;
    opts?.onProgress?.(i + 1, total);
    try {
      const row = await af.playerById(id, season);
      if (!row) continue;
      getDb().transaction(() => {
        for (const block of row.statistics ?? []) {
          if (block.team?.id) upsertTeam.run(block.team.id, block.team.name);
        }
        blocks += upsertCompBlocks(upsertComp, season, row);
      })();
    } catch (err) {
      console.warn(`  comp-stats player ${id}:`, err instanceof Error ? err.message : err);
    }
    await af.sleep(260);
  }
  setMeta(`player_comp_stats_ids_${season}`, String(blocks));
  return blocks;
}

/** AF-linked TM squad players (optionally scoped to one TM competition). */
export function linkedAfPlayerIds(competitionId?: string): number[] {
  const db = getDb();
  if (competitionId) {
    return (
      db
        .prepare(
          `SELECT DISTINCT pv.af_player_id AS id
           FROM tm_squad_players sp
           JOIN tm_competition_clubs cc ON cc.club_id = sp.club_id AND cc.competition_id = ?
           JOIN player_values pv ON pv.tm_player_id = sp.player_id
           WHERE pv.af_player_id IS NOT NULL`,
        )
        .all(competitionId) as Array<{ id: number }>
    ).map((r) => r.id);
  }
  return (
    db
      .prepare(
        `SELECT DISTINCT pv.af_player_id AS id
         FROM tm_squad_players sp
         JOIN tm_competition_clubs cc ON cc.club_id = sp.club_id
         JOIN player_values pv ON pv.tm_player_id = sp.player_id
         WHERE pv.af_player_id IS NOT NULL`,
      )
      .all() as Array<{ id: number }>
  ).map((r) => r.id);
}

/** UEFA club competitions commonly needed for “all tournaments” season view. */
export const UEFA_COMP_LEAGUE_IDS = [2, 3, 848] as const;

/** Sync AF player stats for historySeason and the two prior seasons (weights 50/30/20 in rating). */
export async function syncPlayerStatsHistory(
  leagueId: number,
  historySeason = config.season,
): Promise<Record<number, number>> {
  const seasons = [historySeason, historySeason - 1, historySeason - 2];
  const out: Record<number, number> = {};
  for (const s of seasons) {
    console.log(`  player stats ${s}…`);
    out[s] = await syncPlayerStatsSeason(leagueId, s);
  }
  return out;
}
