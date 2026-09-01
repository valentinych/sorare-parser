import * as tm from "../clients/transfermarkt.js";
import { getDb, setMeta } from "../db/index.js";
import { normalizePos } from "../lib/names.js";
import { parseDetailRole } from "../lib/roles.js";

function money(v?: { value?: number } | null): number | null {
  return v?.value != null ? Number(v.value) : null;
}

function detailFromTm(p: tm.TmPlayer): { role: string | null; label: string | null; side: string | null } {
  const pos = p.attributes?.position;
  const side = p.attributes?.firstSidePosition;
  const side2 = p.attributes?.secondSidePosition;
  const role = parseDetailRole(pos?.shortName, pos?.name, p.attributes?.positionGroupName ?? pos?.category);
  const extras = [side, side2]
    .map((s) => parseDetailRole(s?.shortName, s?.name, s?.category))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  // de-dupe vs main role label
  const mainLabel = pos?.shortName ?? pos?.name ?? null;
  const unique = extras.filter((x) => x !== role && x !== mainLabel);
  return {
    role,
    label: mainLabel,
    side: unique.length ? unique.join(", ") : null,
  };
}

/** Full PL1 (Ekstraklasa) pull: competition + clubs + squads + players. */
export async function syncTmLeague(
  competitionId = "PL1",
  opts: { forceRefresh?: boolean } = {},
): Promise<{ clubs: number; players: number }> {
  const db = getDb();
  const now = new Date().toISOString();
  const force = Boolean(opts.forceRefresh);

  console.log(`TM competition ${competitionId}${force ? " (refresh)" : ""}…`);
  const compRes = await tm.competition(competitionId, opts);
  const comp = compRes?.data;
  if (!comp) throw new Error(`TM competition ${competitionId} empty`);

  db.prepare(
    `INSERT INTO tm_competitions (
       id, name, short_name, season_id, country_id, total_market_value,
       game_day_count, closest_game_day, is_ongoing, logo_url, relative_url, raw_json, synced_at
     ) VALUES (
       @id, @name, @short_name, @season_id, @country_id, @total_market_value,
       @game_day_count, @closest_game_day, @is_ongoing, @logo_url, @relative_url, @raw_json, @synced_at
     )
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       short_name = excluded.short_name,
       season_id = excluded.season_id,
       country_id = excluded.country_id,
       total_market_value = excluded.total_market_value,
       game_day_count = excluded.game_day_count,
       closest_game_day = excluded.closest_game_day,
       is_ongoing = excluded.is_ongoing,
       logo_url = excluded.logo_url,
       relative_url = excluded.relative_url,
       raw_json = excluded.raw_json,
       synced_at = excluded.synced_at`,
  ).run({
    id: comp.id,
    name: comp.name,
    short_name: comp.shortName ?? comp.baseDetails?.shortName ?? null,
    season_id: comp.currentSeasonId ?? null,
    country_id: comp.originDetails?.countryId ?? null,
    total_market_value: money(comp.totalMarketValue),
    game_day_count: comp.baseDetails?.gameDayCount ?? null,
    closest_game_day: comp.baseDetails?.closestGameDay ?? null,
    is_ongoing: comp.baseDetails?.isOngoing ? 1 : 0,
    logo_url: comp.logoUrl ?? null,
    relative_url: comp.relativeUrl ?? null,
    raw_json: JSON.stringify(comp),
    synced_at: now,
  });

  const table = await tm.competitionTable(competitionId, opts);
  const tableClubs = table?.data?.tables?.[0]?.clubs ?? [];
  if (tableClubs.length === 0) throw new Error(`TM table ${competitionId} empty`);

  const upsertClub = db.prepare(
    `INSERT INTO tm_clubs (
       id, name, short_name, abbreviation, country_id, primary_competition_id,
       city, crest_url, relative_url, squad_size, average_age,
       market_value, average_market_value, acquisition_value, top18_market_value,
       raw_json, synced_at
     ) VALUES (
       @id, @name, @short_name, @abbreviation, @country_id, @primary_competition_id,
       @city, @crest_url, @relative_url, @squad_size, @average_age,
       @market_value, @average_market_value, @acquisition_value, @top18_market_value,
       @raw_json, @synced_at
     )
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       short_name = excluded.short_name,
       abbreviation = excluded.abbreviation,
       country_id = excluded.country_id,
       primary_competition_id = excluded.primary_competition_id,
       city = excluded.city,
       crest_url = excluded.crest_url,
       relative_url = excluded.relative_url,
       squad_size = excluded.squad_size,
       average_age = excluded.average_age,
       market_value = excluded.market_value,
       average_market_value = excluded.average_market_value,
       acquisition_value = excluded.acquisition_value,
       top18_market_value = excluded.top18_market_value,
       raw_json = excluded.raw_json,
       synced_at = excluded.synced_at`,
  );

  const upsertStanding = db.prepare(
    `INSERT INTO tm_competition_clubs (
       competition_id, club_id, ranking, points, played, wins, draws, losses,
       goals_for, goals_against, goal_diff
     ) VALUES (
       @competition_id, @club_id, @ranking, @points, @played, @wins, @draws, @losses,
       @goals_for, @goals_against, @goal_diff
     )
     ON CONFLICT(competition_id, club_id) DO UPDATE SET
       ranking = excluded.ranking,
       points = excluded.points,
       played = excluded.played,
       wins = excluded.wins,
       draws = excluded.draws,
       losses = excluded.losses,
       goals_for = excluded.goals_for,
       goals_against = excluded.goals_against,
       goal_diff = excluded.goal_diff`,
  );

  const upsertSquad = db.prepare(
    `INSERT INTO tm_squad_players (
       club_id, player_id, shirt_number, is_captain, assignment_type,
       name, age, date_of_birth, height, preferred_foot,
       position, detail_role, detail_label, side_role,
       market_value_eur, market_value_previous, market_value_highest,
       contract_until, place_of_birth, country_of_birth_id,
       nationality_id, second_nationality_id, gender, agency_name,
       portrait_url, relative_url, raw_json, synced_at
     ) VALUES (
       @club_id, @player_id, @shirt_number, @is_captain, @assignment_type,
       @name, @age, @date_of_birth, @height, @preferred_foot,
       @position, @detail_role, @detail_label, @side_role,
       @market_value_eur, @market_value_previous, @market_value_highest,
       @contract_until, @place_of_birth, @country_of_birth_id,
       @nationality_id, @second_nationality_id, @gender, @agency_name,
       @portrait_url, @relative_url, @raw_json, @synced_at
     )
     ON CONFLICT(club_id, player_id) DO UPDATE SET
       shirt_number = excluded.shirt_number,
       is_captain = excluded.is_captain,
       assignment_type = excluded.assignment_type,
       name = excluded.name,
       age = excluded.age,
       date_of_birth = excluded.date_of_birth,
       height = excluded.height,
       preferred_foot = excluded.preferred_foot,
       position = excluded.position,
       detail_role = excluded.detail_role,
       detail_label = excluded.detail_label,
       side_role = excluded.side_role,
       market_value_eur = excluded.market_value_eur,
       market_value_previous = excluded.market_value_previous,
       market_value_highest = excluded.market_value_highest,
       contract_until = excluded.contract_until,
       place_of_birth = excluded.place_of_birth,
       country_of_birth_id = excluded.country_of_birth_id,
       nationality_id = excluded.nationality_id,
       second_nationality_id = excluded.second_nationality_id,
       gender = excluded.gender,
       agency_name = excluded.agency_name,
       portrait_url = excluded.portrait_url,
       relative_url = excluded.relative_url,
       raw_json = excluded.raw_json,
       synced_at = excluded.synced_at`,
  );

  let playerCount = 0;

  for (const row of tableClubs) {
    const clubId = String(row.clubId);
    upsertStanding.run({
      competition_id: competitionId,
      club_id: clubId,
      ranking: row.ranking?.current ?? null,
      points: row.game?.points ?? null,
      played: row.game?.totalCount ?? null,
      wins: row.game?.winCount ?? null,
      draws: row.game?.drawCount ?? null,
      losses: row.game?.lossCount ?? null,
      goals_for: row.goal?.totalCount ?? null,
      goals_against: row.goal?.concededCount ?? null,
      goal_diff: row.goal?.differenceCount ?? null,
    });

    const info = await tm.clubInfo(clubId, opts);
    const club = info?.data;
    if (!club) {
      console.warn(`  club ${clubId}: empty`);
      continue;
    }

    upsertClub.run({
      id: String(club.id ?? clubId),
      name: club.name,
      short_name: club.baseDetails?.shortName ?? null,
      abbreviation: club.baseDetails?.abbreviation ?? null,
      country_id: club.baseDetails?.countryId ?? null,
      primary_competition_id: club.baseDetails?.primaryCompetitionId ?? competitionId,
      city: club.baseDetails?.superiorClub?.location?.city ?? null,
      crest_url: club.crestUrl ?? null,
      relative_url: club.relativeUrl ?? null,
      squad_size: club.squadDetails?.squadSize ?? null,
      average_age: club.squadDetails?.averageAge ?? null,
      market_value: money(club.squadDetails?.currentMarketValue),
      average_market_value: money(club.squadDetails?.averageMarketValue),
      acquisition_value: money(club.squadDetails?.acquisitionValue),
      top18_market_value: money(club.squadDetails?.top18PlayersMarketValue),
      raw_json: JSON.stringify(club),
      synced_at: now,
    });

    const squadRes = await tm.clubSquad(clubId, opts);
    const squad = squadRes?.data;
    const memberMeta = new Map(
      (squad?.squad ?? []).map((m) => [
        String(m.playerId),
        {
          shirt: m.shirtNumber ?? null,
          captain: m.isCaptain ? 1 : 0,
          type: m.type ?? "current",
        },
      ]),
    );
    const ids = squad?.playerIds ?? [...memberMeta.keys()];
    const players = await tm.playersByIds(ids, opts);
    const keepIds = new Set(players.map((p) => String(p.id)));

    for (const p of players) {
      const detail = detailFromTm(p);
      const position =
        normalizePos(p.attributes?.position?.category) ??
        normalizePos(p.attributes?.positionGroupName) ??
        normalizePos(p.attributes?.position?.name);
      const meta = memberMeta.get(String(p.id));
      upsertSquad.run({
        club_id: clubId,
        player_id: String(p.id),
        shirt_number: meta?.shirt ?? null,
        is_captain: meta?.captain ?? 0,
        assignment_type: meta?.type ?? "current",
        name: p.name,
        age: p.lifeDates?.age ?? null,
        date_of_birth: p.lifeDates?.dateOfBirth ?? null,
        height: p.attributes?.height ?? null,
        preferred_foot: p.attributes?.preferredFoot?.name ?? null,
        position,
        detail_role: detail.role,
        detail_label: detail.label,
        side_role: detail.side,
        market_value_eur: p.marketValueDetails?.current?.value ?? null,
        market_value_previous: p.marketValueDetails?.previous?.value ?? null,
        market_value_highest: p.marketValueDetails?.highest?.value ?? null,
        contract_until: p.attributes?.contractUntil ?? null,
        place_of_birth: p.birthPlaceDetails?.placeOfBirth ?? null,
        country_of_birth_id: p.birthPlaceDetails?.countryOfBirthId ?? null,
        nationality_id: p.nationalityDetails?.nationalities?.nationalityId ?? null,
        second_nationality_id:
          p.nationalityDetails?.nationalities?.secondNationalityId &&
          p.nationalityDetails.nationalities.secondNationalityId > 0
            ? p.nationalityDetails.nationalities.secondNationalityId
            : null,
        gender: p.birthPlaceDetails?.gender ?? null,
        agency_name: p.attributes?.consultantAgency?.name ?? null,
        portrait_url: p.portraitUrl ?? null,
        relative_url: p.relativeUrl ?? null,
        raw_json: JSON.stringify(p),
        synced_at: now,
      });
      playerCount++;
    }

    // Drop departed players — upsert alone leaves transfers on the old club roster.
    // Skip when squad fetch was empty (avoid wiping on a failed/empty response).
    let removed = 0;
    if (keepIds.size > 0) {
      const existing = db
        .prepare(`SELECT player_id AS id FROM tm_squad_players WHERE club_id = ?`)
        .all(clubId) as Array<{ id: string }>;
      const delSquad = db.prepare(
        `DELETE FROM tm_squad_players WHERE club_id = ? AND player_id = ?`,
      );
      for (const row of existing) {
        if (keepIds.has(row.id)) continue;
        delSquad.run(clubId, row.id);
        removed++;
      }
    }

    console.log(
      `  ${club.name}: squad ${players.length}` +
        (removed ? ` (−${removed} left)` : "") +
        `, MV €${Math.round((money(club.squadDetails?.currentMarketValue) ?? 0) / 1e6)}M`,
    );
  }

  setMeta(`tm_league_${competitionId}`, `${tableClubs.length}/${playerCount}`);
  console.log(`TM ${competitionId}: ${tableClubs.length} clubs, ${playerCount} squad players`);
  return { clubs: tableClubs.length, players: playerCount };
}
