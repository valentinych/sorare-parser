import * as tm from "../clients/transfermarkt.js";
import { getDb, setMeta } from "../db/index.js";
import { tmQueueStats } from "../lib/tmQueue.js";
import { parseDetailRole } from "../lib/roles.js";

type CountryMap = Map<number, string>;

function loadCountryMap(): CountryMap {
  const rows = getDb()
    .prepare(`SELECT id, name FROM tm_ref WHERE category = 'countries'`)
    .all() as Array<{ id: string; name: string | null }>;
  return new Map(rows.map((r) => [Number(r.id), r.name ?? ""]));
}

export async function syncTmAttributes(opts: { forceRefresh?: boolean } = {}): Promise<number> {
  const res = await tm.attributes(opts);
  const data = res?.data;
  if (!data) throw new Error("TM /attributes empty");

  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO tm_ref (category, id, name, raw_json)
     VALUES (@category, @id, @name, @raw_json)
     ON CONFLICT(category, id) DO UPDATE SET
       name = excluded.name,
       raw_json = excluded.raw_json`,
  );

  let n = 0;
  const tx = db.transaction(() => {
    for (const [category, value] of Object.entries(data)) {
      if (!Array.isArray(value)) {
        upsert.run({
          category,
          id: "_object",
          name: category,
          raw_json: JSON.stringify(value),
        });
        n++;
        continue;
      }
      for (const item of value) {
        const raw = item as Record<string, unknown>;
        const id = String(raw.id ?? raw.tactic ?? raw.name ?? n);
        const name = String(raw.name ?? raw.tactic ?? raw.shortName ?? id);
        upsert.run({
          category,
          id,
          name,
          raw_json: JSON.stringify(raw),
        });
        n++;
      }
    }
  });
  tx();
  setMeta("tm_attributes", String(n));
  console.log(`TM attributes: ${n} ref rows`);
  return n;
}

function upsertGameFromPayload(
  game: Record<string, unknown>,
  fallbackCompetitionId: string | null,
  now: string,
): void {
  const db = getDb();
  const id = String(game.id ?? "");
  if (!id) return;

  const base = (game.baseDetails ?? {}) as Record<string, unknown>;
  const season = (base.season ?? {}) as Record<string, unknown>;
  const date = (base.date ?? {}) as Record<string, unknown>;
  const score = (game.score ?? {}) as Record<string, unknown>;
  const home = (game.homeClub ?? {}) as Record<string, unknown>;
  const away = (game.awayClub ?? {}) as Record<string, unknown>;
  const homeTactic = ((home.tactic ?? {}) as { tactic?: string }).tactic ?? null;
  const awayTactic = ((away.tactic ?? {}) as { tactic?: string }).tactic ?? null;
  const competitionId = String(base.competitionId ?? fallbackCompetitionId ?? "");

  db.prepare(
    `INSERT INTO tm_games (
       id, competition_id, season_id, game_day, date_utc,
       home_club_id, away_club_id, home_score, away_score,
       is_finished, is_live, home_tactic, away_tactic, relative_url, raw_json, synced_at
     ) VALUES (
       @id, @competition_id, @season_id, @game_day, @date_utc,
       @home_club_id, @away_club_id, @home_score, @away_score,
       @is_finished, @is_live, @home_tactic, @away_tactic, @relative_url, @raw_json, @synced_at
     )
     ON CONFLICT(id) DO UPDATE SET
       competition_id = excluded.competition_id,
       season_id = excluded.season_id,
       game_day = excluded.game_day,
       date_utc = excluded.date_utc,
       home_club_id = excluded.home_club_id,
       away_club_id = excluded.away_club_id,
       home_score = excluded.home_score,
       away_score = excluded.away_score,
       is_finished = excluded.is_finished,
       is_live = excluded.is_live,
       home_tactic = excluded.home_tactic,
       away_tactic = excluded.away_tactic,
       relative_url = excluded.relative_url,
       raw_json = excluded.raw_json,
       synced_at = excluded.synced_at`,
  ).run({
    id,
    competition_id: competitionId || null,
    season_id: base.seasonId != null ? Number(base.seasonId) : season.id != null ? Number(season.id) : null,
    game_day: base.gameDay != null ? Number(base.gameDay) : null,
    date_utc: date.dateTimeUTC != null ? String(date.dateTimeUTC) : null,
    home_club_id: home.clubId != null ? String(home.clubId) : null,
    away_club_id: away.clubId != null ? String(away.clubId) : null,
    home_score: score.home != null ? Number(score.home) : null,
    away_score: score.away != null ? Number(score.away) : null,
    is_finished: Boolean(game.isFinished) || score.home != null ? 1 : 0,
    is_live: game.isLive ? 1 : 0,
    home_tactic: homeTactic,
    away_tactic: awayTactic,
    relative_url: game.relativeUrl != null ? String(game.relativeUrl) : null,
    raw_json: JSON.stringify(game),
    synced_at: now,
  });

  db.prepare(`DELETE FROM tm_game_lineup WHERE game_id = ?`).run(id);
  db.prepare(`DELETE FROM tm_game_events WHERE game_id = ?`).run(id);

  const upsertLineup = db.prepare(
    `INSERT OR REPLACE INTO tm_game_lineup (
       game_id, club_id, player_id, is_starter, shirt_number, is_captain,
       position_label, age_at_game, market_value_eur
     ) VALUES (
       @game_id, @club_id, @player_id, @is_starter, @shirt_number, @is_captain,
       @position_label, @age_at_game, @market_value_eur
     )`,
  );

  const upsertEvent = db.prepare(
    `INSERT INTO tm_game_events (
       game_id, club_id, event_type, minute, added_time, action, reason,
       active_player_id, passive_player_id, seq
     ) VALUES (
       @game_id, @club_id, @event_type, @minute, @added_time, @action, @reason,
       @active_player_id, @passive_player_id, @seq
     )`,
  );

  for (const side of [
    { club: home, clubId: home.clubId != null ? String(home.clubId) : null },
    { club: away, clubId: away.clubId != null ? String(away.clubId) : null },
  ]) {
    if (!side.clubId) continue;
    const lineup = (side.club.lineup ?? {}) as {
      players?: Array<Record<string, unknown>>;
      substitutes?: Array<Record<string, unknown>>;
    };
    for (const p of lineup.players ?? []) {
      const pos = (p.position ?? {}) as { shortName?: string; name?: string };
      const mv = (p.marketValue ?? {}) as { value?: number };
      upsertLineup.run({
        game_id: id,
        club_id: side.clubId,
        player_id: String(p.id),
        is_starter: 1,
        shirt_number: p.shirtNumber != null ? Number(p.shirtNumber) : null,
        is_captain: p.isCaptain ? 1 : 0,
        position_label: pos.shortName ?? pos.name ?? null,
        age_at_game: p.ageAtGameDate != null ? Number(p.ageAtGameDate) : null,
        market_value_eur: mv.value != null ? Number(mv.value) : null,
      });
    }
    for (const p of lineup.substitutes ?? []) {
      const mv = (p.marketValue ?? {}) as { value?: number };
      upsertLineup.run({
        game_id: id,
        club_id: side.clubId,
        player_id: String(p.id),
        is_starter: 0,
        shirt_number: p.shirtNumber != null ? Number(p.shirtNumber) : null,
        is_captain: p.isCaptain ? 1 : 0,
        position_label: null,
        age_at_game: p.ageAtGameDate != null ? Number(p.ageAtGameDate) : null,
        market_value_eur: mv.value != null ? Number(mv.value) : null,
      });
    }

    const actions = (side.club.actions ?? {}) as Record<string, Array<Record<string, unknown>>>;
    for (const [eventType, list] of Object.entries(actions)) {
      if (!Array.isArray(list)) continue;
      list.forEach((ev, seq) => {
        upsertEvent.run({
          game_id: id,
          club_id: side.clubId,
          event_type: eventType,
          minute: ev.minute != null ? Number(ev.minute) : null,
          added_time: ev.addedTime != null ? Number(ev.addedTime) : null,
          action: ev.action != null ? String(ev.action) : null,
          reason: ev.reason != null ? String(ev.reason) : null,
          active_player_id: ev.activePlayerId != null ? String(ev.activePlayerId) : null,
          passive_player_id: ev.passivePlayerId != null ? String(ev.passivePlayerId) : null,
          seq,
        });
      });
    }
  }
}

export async function syncTmFixturesAndGames(
  opts: { forceRefresh?: boolean; competitionId?: string } = {},
): Promise<{ fixtures: number; games: number }> {
  const competitionId = opts.competitionId ?? "PL1";
  const db = getDb();
  const clubs = db
    .prepare(`SELECT club_id AS id FROM tm_competition_clubs WHERE competition_id = ?`)
    .all(competitionId) as Array<{ id: string }>;

  const gameMeta = new Map<string, string | null>(); // gameId -> competition from fixtures list
  let fixtureGames = 0;
  const now = new Date().toISOString();

  for (const { id: clubId } of clubs) {
    const fx = await tm.clubFixtures(clubId, opts);
    const comps = fx?.data?.competitions ?? [];
    for (const comp of comps) {
      for (const g of comp.games ?? []) {
        const gid = String(g.gameId ?? g.id ?? "");
        if (!gid) continue;
        gameMeta.set(gid, String(comp.competitionId ?? ""));
        // store lightweight fixture row even before detail fetch
        upsertGameFromPayload(g as Record<string, unknown>, String(comp.competitionId), now);
        fixtureGames++;
      }
    }
    console.log(`  fixtures club ${clubId}: ${comps.reduce((n, c) => n + (c.games?.length ?? 0), 0)} games`);
  }

  const ids = [...gameMeta.keys()];
  console.log(`TM games detail fetch: ${ids.length} unique (queue ≤4/s, ≤100/min)…`);
  let detailed = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const games = await tm.gamesByIds(chunk, opts);
    for (const g of games) {
      const gid = String(g.id ?? "");
      upsertGameFromPayload(g, gameMeta.get(gid) ?? null, now);
      detailed++;
    }
    const q = tmQueueStats();
    console.log(`  games ${Math.min(i + chunk.length, ids.length)}/${ids.length} · queue min=${q.inLastMin}/${q.maxPerMin}`);
  }

  setMeta(`tm_games_${competitionId}`, `${ids.length}/${detailed}`);
  console.log(`TM fixtures/games: fixtureRows≈${fixtureGames}, unique=${ids.length}, detailed=${detailed}`);
  return { fixtures: fixtureGames, games: ids.length };
}

/** Fill enriched player columns from stored raw_json (no network). */
export function enrichTmPlayersFromRaw(): number {
  const db = getDb();
  const countries = loadCountryMap();
  const rows = db
    .prepare(`SELECT club_id, player_id, raw_json FROM tm_squad_players WHERE raw_json IS NOT NULL`)
    .all() as Array<{ club_id: string; player_id: string; raw_json: string }>;

  const upd = db.prepare(
    `UPDATE tm_squad_players SET
       market_value_previous = @market_value_previous,
       market_value_highest = @market_value_highest,
       place_of_birth = @place_of_birth,
       country_of_birth_id = @country_of_birth_id,
       nationality_id = @nationality_id,
       second_nationality_id = @second_nationality_id,
       nationality = @nationality,
       gender = @gender,
       agency_name = @agency_name,
       side_role = COALESCE(@side_role, side_role),
       detail_label = COALESCE(@detail_label, detail_label),
       detail_role = COALESCE(@detail_role, detail_role)
     WHERE club_id = @club_id AND player_id = @player_id`,
  );

  let n = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      let p: tm.TmPlayer;
      try {
        p = JSON.parse(row.raw_json) as tm.TmPlayer;
      } catch {
        continue;
      }
      const natId = p.nationalityDetails?.nationalities?.nationalityId ?? null;
      const secondId = p.nationalityDetails?.nationalities?.secondNationalityId || null;
      const mainLabel = p.attributes?.position?.shortName ?? p.attributes?.position?.name ?? null;
      const mainRole = parseDetailRole(
        p.attributes?.position?.shortName,
        p.attributes?.position?.name,
        p.attributes?.positionGroupName ?? p.attributes?.position?.category,
      );
      const extras = [p.attributes?.firstSidePosition, p.attributes?.secondSidePosition]
        .map((s) => parseDetailRole(s?.shortName, s?.name, s?.category))
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
        .filter((x) => x !== mainRole && x !== mainLabel);
      upd.run({
        club_id: row.club_id,
        player_id: row.player_id,
        market_value_previous: p.marketValueDetails?.previous?.value ?? null,
        market_value_highest: p.marketValueDetails?.highest?.value ?? null,
        place_of_birth: p.birthPlaceDetails?.placeOfBirth ?? null,
        country_of_birth_id: p.birthPlaceDetails?.countryOfBirthId ?? null,
        nationality_id: natId,
        second_nationality_id: secondId && secondId > 0 ? secondId : null,
        nationality: natId != null ? countries.get(natId) ?? null : null,
        gender: p.birthPlaceDetails?.gender ?? null,
        agency_name: p.attributes?.consultantAgency?.name ?? null,
        side_role: extras.length ? extras.join(", ") : null,
        detail_label: mainLabel,
        detail_role: mainRole,
      });
      n++;
    }
  });
  tx();
  setMeta("tm_players_enriched", String(n));
  console.log(`TM players enriched from raw: ${n}`);
  return n;
}
