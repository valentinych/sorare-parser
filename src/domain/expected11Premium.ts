import type Database from "better-sqlite3";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { AF_LEAGUES, isUiLeagueSlug, leagueBySlug, uiLeagues, type AfLeagueDef } from "../lib/afLeagues.js";
import {
  getComputed,
  invalidateComputed,
  PREMIUM_ODDS_JOIN_CACHE_KEY,
} from "../lib/computedCache.js";
import {
  ALL_FORMATIONS,
  ALL_POSITIONS,
  FORMATION_SLOTS,
} from "../lib/mantraFormations.js";
import { namesMatch, normName } from "../lib/names.js";
import { withStartingXiFallbackPercentage } from "./expected11.js";
import { getExpected11IngestView, listExpected11Leagues } from "./expected11Ingest.js";
import {
  expected11ProfilePlayerId,
  getExpected11View,
  relinkUnmatchedExpected11Teams,
  resolveExpected11Player,
} from "./expected11Import.js";
import { parseAfRoundNum } from "./matchWinProb.js";
import {
  footmopsByPlayer,
  footmopsHasSourcePlayer,
  footmopsSnapshotVersion,
  listUnmatchedFootmopsPlayers,
  relinkFootmopsFromManualMappings,
} from "./footmops.js";

type Actor = { id: number; email: string; mantraManagerId: number | null };

export class Expected11MappingError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function mantraFormationsPayload() {
  return {
    positionOrder: [...ALL_POSITIONS],
    formations: ALL_FORMATIONS.map((name) => ({
      name,
      slots: FORMATION_SLOTS[name]!.map((slot) => ({
        label: slot.label,
        accepted: [...slot.accepted],
      })),
    })),
  };
}

function parseNumberArray(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .map(Number)
          .filter((item) => Number.isSafeInteger(item) && item > 0)
      : [];
  } catch {
    return [];
  }
}

function fullName(row: {
  name: string;
  first_name: string | null;
  full_name: string | null;
}): string {
  return (
    row.full_name ||
    [row.first_name, row.name].filter(Boolean).join(" ") ||
    row.name
  );
}

function snapshotCounts(database: Database.Database) {
  const row = database
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN link_status = 'linked' THEN 1 ELSE 0 END) AS linked,
         SUM(CASE WHEN link_status = 'unmatched' THEN 1 ELSE 0 END) AS unmatched,
         SUM(CASE WHEN link_status = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous
       FROM expected11_predictions`,
    )
    .get() as {
    total: number;
    linked: number | null;
    unmatched: number | null;
    ambiguous: number | null;
  };
  return {
    total: row.total,
    linked: row.linked ?? 0,
    unmatched: row.unmatched ?? 0,
    ambiguous: row.ambiguous ?? 0,
  };
}

export function relinkExpected11Snapshot(
  database: Database.Database = getDb(),
  scope?: { mantraClubId: number; sourceKey: string },
): ReturnType<typeof snapshotCounts> {
  const predictions = database
    .prepare(
      `SELECT p.match_id, p.team_side, p.lineup_group, p.sort_order,
              p.source_name, t.mantra_club_id, t.mantra_club_name
       FROM expected11_predictions p
       JOIN expected11_teams t
         ON t.match_id = p.match_id AND t.side = p.team_side
       WHERE t.link_status = 'linked' AND t.mantra_club_id IS NOT NULL
         ${scope ? "AND t.mantra_club_id = ?" : ""}`,
    )
    .all(...(scope ? [scope.mantraClubId] : [])) as Array<{
    match_id: string;
    team_side: "home" | "away";
    lineup_group: "starting" | "bench" | "out";
    sort_order: number;
    source_name: string;
    mantra_club_id: number;
    mantra_club_name: string;
  }>;
  const update = database.prepare(
    `UPDATE expected11_predictions
     SET mantra_player_id = ?, link_status = ?
     WHERE match_id = ? AND team_side = ? AND lineup_group = ? AND sort_order = ?`,
  );
  for (const prediction of predictions) {
    if (scope && normName(prediction.source_name) !== scope.sourceKey) continue;
    const resolved = resolveExpected11Player(
      database,
      {
        id: prediction.mantra_club_id,
        name: prediction.mantra_club_name,
      },
      prediction.source_name,
    );
    update.run(
      resolved.player?.id ?? null,
      resolved.status,
      prediction.match_id,
      prediction.team_side,
      prediction.lineup_group,
      prediction.sort_order,
    );
  }
  return snapshotCounts(database);
}

export function saveExpected11ManualMapping(
  input: {
    sourceName: string;
    mantraClubId: number;
    mantraPlayerId: number;
  },
  actor: Actor,
  database: Database.Database = getDb(),
) {
  const sourceName = String(input.sourceName ?? "").trim();
  const sourceKey = normName(sourceName);
  if (!sourceKey) throw new Expected11MappingError("invalid_source_name");
  if (
    !Number.isSafeInteger(input.mantraClubId) ||
    input.mantraClubId <= 0 ||
    !Number.isSafeInteger(input.mantraPlayerId) ||
    input.mantraPlayerId <= 0
  ) {
    throw new Expected11MappingError("invalid_mapping_target");
  }

  const result = database.transaction(() => {
    const sourceRows = database
      .prepare(
        `SELECT DISTINCT p.source_name
         FROM expected11_predictions p
         JOIN expected11_teams t
           ON t.match_id = p.match_id AND t.side = p.team_side
         WHERE t.mantra_club_id = ? AND t.link_status = 'linked'`,
      )
      .all(input.mantraClubId) as Array<{ source_name: string }>;
    if (!sourceRows.some((row) => normName(row.source_name) === sourceKey)) {
      if (!footmopsHasSourcePlayer(database, input.mantraClubId, sourceKey)) {
        throw new Expected11MappingError("expected11_player_not_found", 404);
      }
    }

    const target = database
      .prepare(
        `SELECT id, name, first_name, full_name, club_id, club_name, tournament_id
         FROM mantra_players WHERE id = ? AND club_id = ?`,
      )
      .get(input.mantraPlayerId, input.mantraClubId) as
      | {
          id: number;
          name: string;
          first_name: string | null;
          full_name: string | null;
          club_id: number;
          club_name: string;
          tournament_id: number | null;
        }
      | undefined;
    if (!target) {
      throw new Expected11MappingError("mapping_target_wrong_club", 400);
    }

    database
      .prepare(
        `INSERT INTO expected11_manual_mappings
           (source_name_normalized, mantra_club_id, mantra_player_id,
            mapped_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(source_name_normalized, mantra_club_id) DO UPDATE SET
           mantra_player_id = excluded.mantra_player_id,
           mapped_by_user_id = excluded.mapped_by_user_id,
           updated_at = datetime('now')`,
      )
      .run(sourceKey, input.mantraClubId, input.mantraPlayerId, actor.id);
    const saved = database
      .prepare(
        `SELECT updated_at AS updatedAt
         FROM expected11_manual_mappings
         WHERE source_name_normalized = ? AND mantra_club_id = ?`,
      )
      .get(sourceKey, input.mantraClubId) as { updatedAt: string };
    const counts = relinkExpected11Snapshot(database, {
      mantraClubId: input.mantraClubId,
      sourceKey,
    });
    relinkFootmopsFromManualMappings(database, {
      mantraClubId: input.mantraClubId,
      sourceKey,
    });
    return {
      mapping: {
        sourceName,
        normalizedSourceName: sourceKey,
        mantraClubId: input.mantraClubId,
        mantraPlayerId: target.id,
        mantraPlayerName: fullName(target),
        mappedBy: actor.email,
        updatedAt: saved.updatedAt,
        ...leagueFields(leagueByTournament(target.tournament_id)),
      },
      counts,
    };
  })();
  invalidatePremiumOddsJoinCache(database);
  return result;
}

export function removeExpected11ManualMapping(
  input: { sourceName: string; mantraClubId: number },
  database: Database.Database = getDb(),
) {
  const sourceKey = normName(String(input.sourceName ?? "").trim());
  if (!sourceKey || !Number.isSafeInteger(input.mantraClubId)) {
    throw new Expected11MappingError("invalid_mapping_key");
  }
  const result = database.transaction(() => {
    const removed = database
      .prepare(
        `DELETE FROM expected11_manual_mappings
         WHERE source_name_normalized = ? AND mantra_club_id = ?`,
      )
      .run(sourceKey, input.mantraClubId);
    if (removed.changes === 0) {
      throw new Expected11MappingError("manual_mapping_not_found", 404);
    }
    return {
      ok: true,
      counts: relinkExpected11Snapshot(database, {
        mantraClubId: input.mantraClubId,
        sourceKey,
      }),
    };
  })();
  relinkFootmopsFromManualMappings(database, {
    mantraClubId: input.mantraClubId,
    sourceKey,
  });
  invalidatePremiumOddsJoinCache(database);
  return result;
}

export function getExpected11MappingView(
  database: Database.Database = getDb(),
) {
  relinkUnmatchedExpected11Teams(database);
  const rows = database
    .prepare(
      `SELECT p.match_id, p.team_side, p.lineup_group, p.sort_order,
              p.source_name, p.displayed_percentage, p.player_path,
              p.link_status, m.title, m.source_url, m.extracted_at,
              t.source_name AS club_source_name, t.mantra_club_id,
              t.mantra_club_name
       FROM expected11_predictions p
       JOIN expected11_matches m ON m.id = p.match_id
       JOIN expected11_teams t
         ON t.match_id = p.match_id AND t.side = p.team_side
       WHERE p.link_status <> 'linked'
         AND t.link_status = 'linked' AND t.mantra_club_id IS NOT NULL
       ORDER BY datetime(m.extracted_at) DESC, CAST(m.id AS INTEGER) DESC,
                t.mantra_club_name, p.lineup_group, p.sort_order`,
    )
    .all() as Array<{
    match_id: string;
    team_side: "home" | "away";
    lineup_group: "starting" | "bench" | "out";
    sort_order: number;
    source_name: string;
    displayed_percentage: number | null;
    player_path: string | null;
    link_status: "unmatched" | "ambiguous";
    title: string;
    source_url: string;
    extracted_at: string;
    club_source_name: string;
    mantra_club_id: number;
    mantra_club_name: string;
  }>;
  const candidateQuery = database.prepare(
    `SELECT id, name, first_name, full_name, positions_json
     FROM mantra_players WHERE club_id = ?
     ORDER BY full_name, first_name, name, id`,
  );
  const candidates = new Map<
    number,
    Array<{ id: number; fullName: string; position: string | null; positions: string[] }>
  >();
  for (const clubId of new Set(rows.map((row) => row.mantra_club_id))) {
    const clubRows = candidateQuery.all(clubId) as Array<{
      id: number;
      name: string;
      first_name: string | null;
      full_name: string | null;
      positions_json: string | null;
    }>;
    candidates.set(
      clubId,
      clubRows.map((row) => {
        const positions = parseStringArray(row.positions_json);
        return {
          id: row.id,
          fullName: fullName(row),
          position: positions[0] ?? null,
          positions,
        };
      }),
    );
  }

  const footmopsUnmatched = listUnmatchedFootmopsPlayers(database);
  for (const clubId of new Set(footmopsUnmatched.map((row) => row.mantraClubId))) {
    if (candidates.has(clubId)) continue;
    const clubRows = candidateQuery.all(clubId) as Array<{
      id: number;
      name: string;
      first_name: string | null;
      full_name: string | null;
      positions_json: string | null;
    }>;
    candidates.set(
      clubId,
      clubRows.map((row) => {
        const positions = parseStringArray(row.positions_json);
        return {
          id: row.id,
          fullName: fullName(row),
          position: positions[0] ?? null,
          positions,
        };
      }),
    );
  }

  const groups = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const key = `${row.match_id}:${row.team_side}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const mappings = database
    .prepare(
      `SELECT mm.source_name_normalized AS normalizedSourceName,
              mm.mantra_club_id AS mantraClubId,
              mm.mantra_player_id AS mantraPlayerId,
              mp.full_name AS mantraPlayerName,
              mp.name AS mantraSurname,
              mp.tournament_id AS tournamentId,
              u.email AS mappedBy,
              mm.created_at AS createdAt, mm.updated_at AS updatedAt
       FROM expected11_manual_mappings mm
       JOIN mantra_players mp ON mp.id = mm.mantra_player_id
       JOIN app_users u ON u.id = mm.mapped_by_user_id
       ORDER BY datetime(mm.updated_at) DESC`,
    )
    .all() as Array<{
    normalizedSourceName: string;
    mantraClubId: number;
    mantraPlayerId: number;
    mantraPlayerName: string | null;
    mantraSurname: string | null;
    tournamentId: number | null;
    mappedBy: string;
    createdAt: string;
    updatedAt: string;
  }>;
  const matchLeagues = ingestMatchLeagues(database);
  const clubLeagues = clubLeaguesById(database, [
    ...new Set([
      ...rows.map((row) => row.mantra_club_id),
      ...footmopsUnmatched.map((row) => row.mantraClubId),
      ...mappings.map((row) => row.mantraClubId),
    ]),
  ]);

  const expected11Groups = Array.from(groups.values()).map((group) => {
      const first = group[0]!;
      const league =
        matchLeagues.get(first.match_id) ?? clubLeagues.get(first.mantra_club_id);
      return {
        matchId: first.match_id,
        matchTitle: first.title,
        sourceUrl: first.source_url,
        extractedAt: first.extracted_at,
        side: first.team_side,
        sourceClubName: first.club_source_name,
        mantraClubId: first.mantra_club_id,
        mantraClubName: first.mantra_club_name,
        source: "expected11" as const,
        ...leagueFields(league),
        candidates: candidates.get(first.mantra_club_id) ?? [],
        players: group.map((row) => ({
          sourceName: row.source_name,
          lineupGroup: row.lineup_group,
          displayedPercentage: withStartingXiFallbackPercentage(
            row.lineup_group,
            row.displayed_percentage,
          ),
          playerPath: row.player_path,
          linkStatus: row.link_status,
        })),
      };
    });

  const footmopsByClub = new Map<number, typeof footmopsUnmatched>();
  for (const row of footmopsUnmatched) {
    const list = footmopsByClub.get(row.mantraClubId) ?? [];
    list.push(row);
    footmopsByClub.set(row.mantraClubId, list);
  }
  const footmopsGroups = Array.from(footmopsByClub.entries()).map(
    ([mantraClubId, players]) => {
      const first = players[0]!;
      const league = clubLeagues.get(mantraClubId);
      return {
        matchId: `footmops:${first.league}:${first.tour}:${mantraClubId}`,
        matchTitle: `SorareInside / footmops · ${first.league} tour ${first.tour}`,
        sourceUrl: "",
        extractedAt: "",
        side: "home" as const,
        sourceClubName: first.sourceClub,
        mantraClubId,
        mantraClubName: first.mantraClubName,
        source: "footmops" as const,
        ...leagueFields(league),
        candidates: candidates.get(mantraClubId) ?? [],
        players: players.map((row) => ({
          sourceName: row.sourcePlayer,
          lineupGroup:
            row.lineupGroup === "starting" ? ("starting" as const) : ("bench" as const),
          displayedPercentage: row.displayedPercentage,
          playerPath: null,
          linkStatus: row.linkStatus,
        })),
      };
    },
  );

  return {
    counts: snapshotCounts(database),
    leagues: listExpected11Leagues(),
    groups: [...expected11Groups, ...footmopsGroups],
    mappings: mappings.map((row) => {
      const { tournamentId, ...mapping } = row;
      return {
        ...mapping,
        ...leagueFields(
          leagueByTournament(tournamentId) ?? clubLeagues.get(row.mantraClubId),
        ),
      };
    }),
    ingest: getExpected11IngestView({ includeUrls: false }, database),
  };
}

export function normalizedImplied1x2(
  homeOdd: number | null,
  drawOdd: number | null,
  awayOdd: number | null,
): { home: number; draw: number; away: number } | null {
  if (
    ![homeOdd, drawOdd, awayOdd].every(
      (odd) => odd != null && Number.isFinite(odd) && odd > 1,
    )
  ) {
    return null;
  }
  const home = 1 / homeOdd!;
  const draw = 1 / drawOdd!;
  const away = 1 / awayOdd!;
  const total = home + draw + away;
  return {
    home: Number((home / total).toFixed(4)),
    draw: Number((draw / total).toFixed(4)),
    away: Number((away / total).toFixed(4)),
  };
}

export type FixtureRow = {
  id: number;
  kickoff: string | null;
  league_id: number | null;
  season: number | null;
  round: string | null;
  status: string | null;
  home_name: string | null;
  away_name: string | null;
  home_odd: number | null;
  draw_odd: number | null;
  away_odd: number | null;
  bookmaker: string | null;
  home_cs_prob: number | null;
  away_cs_prob: number | null;
  popular_score: string | null;
};

const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "CANC", "PST", "ABD"]);

function leagueByTournament(tournamentId: number | null | undefined) {
  if (tournamentId == null) return null;
  return (
    Object.values(AF_LEAGUES).find(
      (league) => league.mantraTournamentId === tournamentId,
    ) ?? null
  );
}

function leagueFields(league: AfLeagueDef | null | undefined) {
  return league
    ? {
        league: league.slug,
        leagueName: league.name,
        tmCompetition: league.tmCompetition,
      }
    : { league: null, leagueName: null, tmCompetition: null };
}

function parseMatchIdList(value: string): string[] {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

function ingestMatchLeagues(database: Database.Database): Map<string, AfLeagueDef> {
  const map = new Map<string, AfLeagueDef>();
  const rows = database
    .prepare(`SELECT league, match_ids_json FROM expected11_ingest_tours`)
    .all() as Array<{ league: string; match_ids_json: string }>;
  for (const row of rows) {
    const league = leagueBySlug(row.league);
    if (!league) continue;
    for (const id of parseMatchIdList(row.match_ids_json)) {
      if (!map.has(id)) map.set(id, league);
    }
  }
  return map;
}

function clubLeaguesById(
  database: Database.Database,
  clubIds: number[],
): Map<number, AfLeagueDef> {
  const map = new Map<number, AfLeagueDef>();
  if (!clubIds.length) return map;
  const placeholders = clubIds.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT club_id AS clubId, tournament_id AS tournamentId, COUNT(*) AS n
       FROM mantra_players
       WHERE club_id IN (${placeholders}) AND tournament_id IS NOT NULL
       GROUP BY club_id, tournament_id
       ORDER BY n DESC`,
    )
    .all(...clubIds) as Array<{ clubId: number; tournamentId: number }>;
  for (const row of rows) {
    if (map.has(row.clubId)) continue;
    const league = leagueByTournament(row.tournamentId);
    if (league) map.set(row.clubId, league);
  }
  return map;
}

export const PREMIUM_ODDS_TTL_MS = 4 * 60 * 60 * 1000;
export const PREMIUM_ODDS_CACHE_KEY = PREMIUM_ODDS_JOIN_CACHE_KEY;

export function invalidatePremiumOddsJoinCache(
  database?: Database.Database,
): void {
  invalidateComputed(PREMIUM_ODDS_JOIN_CACHE_KEY, { database, persist: true });
}

const LIVE_STATUSES = new Set(["1H", "HT", "2H", "LIVE", "ET", "P", "BT", "INT"]);
const STALE_NS_AFTER_MS = 150 * 60 * 1000;

function fixtureStillOpen(
  status: string | null,
  kickoff: string | null,
  nowMs: number,
): boolean {
  const code = (status || "").toUpperCase();
  if (FINISHED_STATUSES.has(code)) return false;
  if (LIVE_STATUSES.has(code)) return true;
  const kick = Date.parse(kickoff ?? "");
  if (!Number.isFinite(kick)) return true;
  return kick + STALE_NS_AFTER_MS > nowMs;
}

/** Smallest Regular Season round that still has an unfinished or upcoming fixture. */
export function nextUpcomingRound(
  database: Database.Database,
  leagueId: number,
  season: number,
  nowMs: number = Date.now(),
): number | null {
  const rows = database
    .prepare(
      `SELECT round, status, date FROM fixtures
       WHERE league_id = ? AND season = ?
         AND round LIKE 'Regular Season - %'`,
    )
    .all(leagueId, season) as Array<{
    round: string | null;
    status: string | null;
    date: string | null;
  }>;
  let next: number | null = null;
  for (const row of rows) {
    const round = parseAfRoundNum(row.round);
    if (round == null || !fixtureStillOpen(row.status, row.date, nowMs)) continue;
    if (next == null || round < next) next = round;
  }
  return next;
}

function premiumOddsCacheVersion(
  database: Database.Database,
  season: number,
  nowMs: number,
): string {
  const rounds = uiLeagues()
    .map((league) => `${league.slug}:${nextUpcomingRound(database, league.id, season, nowMs) ?? ""}`)
    .join(",");
  const bucket = Math.floor(nowMs / PREMIUM_ODDS_TTL_MS);
  const extractedAt = (
    database
      .prepare(`SELECT MAX(extracted_at) AS extractedAt FROM expected11_matches`)
      .get() as { extractedAt: string | null } | undefined
  )?.extractedAt;
  return `rounds:${rounds}|ttl:${bucket}|e11:${extractedAt ?? ""}|fm:${footmopsSnapshotVersion(database)}`;
}

function sortByKickoff(fixtures: FixtureRow[]): FixtureRow[] {
  return fixtures.slice().sort(
    (a, b) =>
      (Date.parse(a.kickoff ?? "") || 0) - (Date.parse(b.kickoff ?? "") || 0) ||
      a.id - b.id,
  );
}

function clubFixture(
  clubName: string,
  leagueId: number,
  roundNum: number | null,
  fixtures: FixtureRow[],
  nowMs: number,
): FixtureRow | null {
  const inLeague = fixtures.filter(
    (fixture) =>
      fixture.league_id === leagueId &&
      (clubMatches(clubName, fixture.home_name) ||
        clubMatches(clubName, fixture.away_name)) &&
      !FINISHED_STATUSES.has((fixture.status || "").toUpperCase()),
  );
  const inRound =
    roundNum != null
      ? inLeague.filter((fixture) => parseAfRoundNum(fixture.round) === roundNum)
      : [];
  const pool = inRound.length ? inRound : inLeague;
  const future = sortByKickoff(
    pool.filter((fixture) => (Date.parse(fixture.kickoff ?? "") || 0) > nowMs),
  );
  return future[0] ?? sortByKickoff(pool)[0] ?? null;
}

const CLUB_ALIASES: Record<string, string> = {
  "ac milan": "milan",
  "afc bournemouth": "bournemouth",
  "bolton wanderers": "bolton",
  "brighton hove albion": "brighton",
  "charlton athletic": "charlton",
  "derby county": "derby",
  "ipswich town": "ipswich",
  "leeds united": "leeds",
  "lincoln city": "lincoln",
  "newcastle united": "newcastle",
  "norwich city": "norwich",
  "queens park rangers": "qpr",
  "sheffield united": "sheffield utd",
  "tottenham hotspur": "tottenham",
  "west bromwich albion": "west brom",
  "west ham united": "west ham",
  "wolverhampton wanderers": "wolves",
  wolverhampton: "wolves",
  "coventry city": "coventry",
  "amed sk": "amed",
  "besiktas jk": "besiktas",
  "caykur rizespor": "rizespor",
  "corum fk": "corum",
  "erzurumspor fk": "erzurumspor",
  "fenerbahce sk": "fenerbahce",
  "galatasaray sk": "galatasaray",
  "gaziantep f k": "gaziantep",
  "gaziantep fk": "gaziantep",
  "istanbul basaksehir": "basaksehir",
  "kasimpasa sk": "kasimpasa",
  "vfb stuttgart": "stuttgart",
  "hamburger sv": "hamburger",
  "borussia monchengladbach": "borussia mbach",
  "fsv mainz 05": "mainz 05",
  "eintracht frankfurt": "eintracht",
  "tsg hoffenheim": "hoffenheim",
  "1899 hoffenheim": "hoffenheim",
  "bayer 04 leverkusen": "bayer leverkusen",
};

function clubMatches(source: string | null, candidate: string | null): boolean {
  if (!source || !candidate) return false;
  const sourceKey = CLUB_ALIASES[normName(source)] ?? normName(source);
  const candidateKey = CLUB_ALIASES[normName(candidate)] ?? normName(candidate);
  return (
    sourceKey === candidateKey ||
    namesMatch(sourceKey, candidateKey)
  );
}

export function fixtureForMatch(
  match: { homeTeam: string | null; awayTeam: string | null },
  fixtures: FixtureRow[],
  nowMs: number,
) {
  const matching = sortByKickoff(
    fixtures.filter(
      (fixture) =>
        clubMatches(match.homeTeam, fixture.home_name) &&
        clubMatches(match.awayTeam, fixture.away_name),
    ),
  );
  const unfinished = matching.filter(
    (fixture) => !FINISHED_STATUSES.has((fixture.status || "").toUpperCase()),
  );
  const future = unfinished.find(
    (fixture) => (Date.parse(fixture.kickoff ?? "") || 0) > nowMs,
  );
  const current = future ?? unfinished[0] ?? null;
  return {
    fixture: current,
    knownPast: !current && matching.length > 0,
  };
}

function notes(value: string): Record<
  string,
  { label: string; text: string } | null
> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, { label: string; text: string } | null>)
      : {};
  } catch {
    return {};
  }
}

type Expected11PlayerHint = {
  displayedPercentage: number | null;
  expected11Name: string;
  expected11PlayerUrl: string | null;
  expected11MatchUrl: string;
  lineupGroup: "starting" | "bench" | "out";
  opponent: string | null;
  sourceMatchTitle: string;
  sourceMatchId: string;
};

function expected11ByPlayer(
  database: Database.Database,
  tournamentIds: number[],
  fixtures: FixtureRow[],
  nowMs: number,
  nextRoundByLeague: Map<number, number | null> = new Map(),
): Map<number, Expected11PlayerHint> {
  if (tournamentIds.length === 0) return new Map();
  const placeholders = tournamentIds.map(() => "?").join(",");
  const predictionRows = database
    .prepare(
      `SELECT p.match_id, p.team_side, p.lineup_group, p.sort_order,
              p.source_name, p.displayed_percentage, p.player_path,
              p.mantra_player_id,
              m.source_url, m.title, m.home_team, m.away_team,
              m.extracted_at, m.imported_at,
              t.mantra_club_id
       FROM expected11_predictions p
       JOIN expected11_matches m ON m.id = p.match_id
       JOIN expected11_teams t
         ON t.match_id = p.match_id AND t.side = p.team_side
       JOIN mantra_players mp ON mp.id = p.mantra_player_id
       WHERE p.link_status = 'linked' AND mp.tournament_id IN (${placeholders})
       ORDER BY datetime(m.extracted_at) DESC, datetime(m.imported_at) DESC,
                CAST(m.id AS INTEGER) DESC, p.sort_order`,
    )
    .all(...tournamentIds) as Array<{
    match_id: string;
    team_side: "home" | "away";
    lineup_group: "starting" | "bench" | "out";
    sort_order: number;
    source_name: string;
    displayed_percentage: number | null;
    player_path: string | null;
    mantra_player_id: number;
    source_url: string;
    title: string;
    home_team: string | null;
    away_team: string | null;
    extracted_at: string;
    imported_at: string;
    mantra_club_id: number;
  }>;
  const matchContext = new Map<
    string,
    { fixture: FixtureRow | null; knownPast: boolean }
  >();
  for (const row of predictionRows) {
    if (!matchContext.has(row.match_id)) {
      matchContext.set(
        row.match_id,
        fixtureForMatch(
          { homeTeam: row.home_team, awayTeam: row.away_team },
          fixtures,
          nowMs,
        ),
      );
    }
  }
  const byClubMatch = new Map<string, typeof predictionRows>();
  for (const row of predictionRows) {
    const key = `${row.mantra_club_id}:${row.match_id}`;
    const values = byClubMatch.get(key) ?? [];
    values.push(row);
    byClubMatch.set(key, values);
  }
  const byClub = new Map<number, Array<typeof predictionRows>>();
  for (const values of byClubMatch.values()) {
    const clubId = values[0]!.mantra_club_id;
    const matches = byClub.get(clubId) ?? [];
    matches.push(values);
    byClub.set(clubId, matches);
  }
  const selected: typeof predictionRows = [];
  for (const matches of byClub.values()) {
    const withFixture = matches.filter(
      (rows) => matchContext.get(rows[0]!.match_id)?.fixture,
    );
    const inNextRound = withFixture.filter((rows) => {
      const fixture = matchContext.get(rows[0]!.match_id)?.fixture;
      if (!fixture?.league_id) return false;
      const want = nextRoundByLeague.get(fixture.league_id);
      return want != null && parseAfRoundNum(fixture.round) === want;
    });
    const future = (inNextRound.length ? inNextRound : withFixture).sort(
      (a, b) => {
        const aKickoff =
          Date.parse(matchContext.get(a[0]!.match_id)?.fixture?.kickoff ?? "") ||
          Number.MAX_SAFE_INTEGER;
        const bKickoff =
          Date.parse(matchContext.get(b[0]!.match_id)?.fixture?.kickoff ?? "") ||
          Number.MAX_SAFE_INTEGER;
        return (
          aKickoff - bKickoff || Number(a[0]!.match_id) - Number(b[0]!.match_id)
        );
      },
    );
    if (future[0]) {
      selected.push(...future[0]);
      continue;
    }
    const unknown = matches
      .filter((rows) => !matchContext.get(rows[0]!.match_id)?.knownPast)
      .sort(
        (a, b) =>
          Date.parse(b[0]!.extracted_at) - Date.parse(a[0]!.extracted_at) ||
          Date.parse(b[0]!.imported_at) - Date.parse(a[0]!.imported_at) ||
          Number(b[0]!.match_id) - Number(a[0]!.match_id),
      );
    if (unknown[0]) selected.push(...unknown[0]);
  }
  const groupRank = { starting: 0, bench: 1, out: 2 };
  const byPlayer = new Map<number, Expected11PlayerHint>();
  for (const row of selected) {
    const current = byPlayer.get(row.mantra_player_id);
    if (current && groupRank[current.lineupGroup] < groupRank[row.lineup_group]) {
      continue;
    }
    byPlayer.set(row.mantra_player_id, {
      displayedPercentage: withStartingXiFallbackPercentage(
        row.lineup_group,
        row.displayed_percentage,
      ),
      expected11Name: row.source_name,
      expected11PlayerUrl: row.player_path
        ? new URL(row.player_path, "https://expected11.com").toString()
        : null,
      expected11MatchUrl: row.source_url,
      lineupGroup: row.lineup_group,
      opponent: row.team_side === "home" ? row.away_team : row.home_team,
      sourceMatchTitle: row.title,
      sourceMatchId: row.match_id,
    });
  }
  return byPlayer;
}

type PremiumFantasyTeam = {
  id: number;
  name: string | null;
  league_id: number;
  tournament_id: number | null;
  players_json: string;
  mantra_league_name: string | null;
  mantra_league_division: string | null;
};

function mantraLeagueLabel(
  name: string | null | undefined,
  division: string | null | undefined,
): string | null {
  const label = [String(name || "").trim(), String(division || "").trim()]
    .filter(Boolean)
    .join(" ");
  return label || null;
}

function premiumTeamFilterLabel(input: {
  name: string;
  mantraLeagueName: string | null;
  competitionName: string | null;
}): string {
  const parts = [input.name];
  if (input.mantraLeagueName && input.mantraLeagueName !== input.name) {
    parts.push(input.mantraLeagueName);
  }
  if (
    !input.mantraLeagueName &&
    input.competitionName &&
    input.competitionName !== input.name
  ) {
    parts.push(input.competitionName);
  }
  return parts.join(" · ");
}

function mapPremiumTeamOptions(teams: PremiumFantasyTeam[]) {
  return teams.map((team) => {
    const name = team.name || `Команда #${team.id}`;
    const competitionName = leagueByTournament(team.tournament_id)?.name ?? null;
    const mantraLeagueName = mantraLeagueLabel(
      team.mantra_league_name,
      team.mantra_league_division,
    );
    return {
      id: team.id,
      name,
      tournamentId: team.tournament_id,
      leagueName: mantraLeagueName ?? competitionName,
      mantraLeagueName,
      competitionName,
      label: premiumTeamFilterLabel({ name, mantraLeagueName, competitionName }),
    };
  });
}

function clubsInManagerLeagues(
  database: Database.Database,
  tournamentIds: number[],
  extra: Array<{ id: number; name: string; tournamentId: number | null }>,
) {
  const map = new Map<
    number,
    { id: number; name: string; tournamentId: number | null }
  >();
  const put = (club: { id: number; name: string; tournamentId: number | null }) => {
    if (!Number.isSafeInteger(club.id) || club.id <= 0) return;
    const current = map.get(club.id);
    if (!current) {
      map.set(club.id, club);
      return;
    }
    if (!current.name && club.name) current.name = club.name;
    if (current.tournamentId == null && club.tournamentId != null) {
      current.tournamentId = club.tournamentId;
    }
  };
  if (tournamentIds.length) {
    const rows = database
      .prepare(
        `SELECT club_id AS id,
                MAX(club_name) AS name,
                tournament_id AS tournamentId
         FROM mantra_players
         WHERE tournament_id IN (${tournamentIds.map(() => "?").join(",")})
           AND club_id IS NOT NULL
         GROUP BY club_id, tournament_id`,
      )
      .all(...tournamentIds) as Array<{
      id: number;
      name: string | null;
      tournamentId: number | null;
    }>;
    for (const row of rows) {
      put({
        id: row.id,
        name: row.name || `#${row.id}`,
        tournamentId: row.tournamentId,
      });
    }
  }
  for (const club of extra) put(club);
  return [...map.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "ru"),
  );
}

type PremiumOddsJoin = {
  fixtures: FixtureRow[];
  expected11: Array<[number, Expected11PlayerHint]>;
  rounds: Array<[number, number | null]>;
};

function loadPremiumFixtures(database: Database.Database): FixtureRow[] {
  return database
    .prepare(
      `SELECT f.id, COALESCE(o.kickoff, f.date) AS kickoff,
              f.league_id, f.season, f.round, f.status,
              (SELECT st.name FROM season_teams st
               WHERE st.team_id = f.home_team_id AND st.season = f.season
                 AND (st.league_id = f.league_id OR st.league_id IS NULL)
               LIMIT 1) AS home_name,
              (SELECT st.name FROM season_teams st
               WHERE st.team_id = f.away_team_id AND st.season = f.season
                 AND (st.league_id = f.league_id OR st.league_id IS NULL)
               LIMIT 1) AS away_name,
              o.home_odd, o.draw_odd, o.away_odd, o.bookmaker,
              o.home_cs_prob, o.away_cs_prob, o.popular_score
       FROM fixtures f
       LEFT JOIN fixture_odds o ON o.fixture_id = f.id
       WHERE f.date IS NOT NULL`,
    )
    .all() as FixtureRow[];
}

function getPremiumOddsJoin(
  database: Database.Database,
  season: number,
  nowMs: number,
): {
  fixtures: FixtureRow[];
  expected11: Map<number, Expected11PlayerHint>;
  rounds: Map<number, number | null>;
} {
  const cached = getComputed<PremiumOddsJoin>(
    PREMIUM_ODDS_CACHE_KEY,
    premiumOddsCacheVersion(database, season, nowMs),
    () => {
      const fixtures = loadPremiumFixtures(database);
      const rounds = new Map(
        uiLeagues().map((league) => [
          league.id,
          nextUpcomingRound(database, league.id, season, nowMs),
        ]),
      );
      const tournamentIds = [
        ...new Set(
          uiLeagues()
            .map((league) => league.mantraTournamentId)
            .filter((id): id is number => id != null),
        ),
      ];
      return {
        fixtures,
        expected11: [
          ...expected11ByPlayer(database, tournamentIds, fixtures, nowMs, rounds),
        ],
        rounds: [...rounds.entries()],
      };
    },
    { database, serveStale: false },
  ).value;
  return {
    fixtures: cached.fixtures,
    expected11: new Map(cached.expected11),
    rounds: new Map(cached.rounds),
  };
}

export function getExpected11PremiumView(
  options: {
    tournamentId?: number;
    ownedOnly?: boolean;
    now?: Date;
  },
  actor: Actor,
  database: Database.Database = getDb(),
) {
  const nowMs = (options.now ?? new Date()).getTime();
  const season = config.predictSeason;
  const managerId = actor.mantraManagerId;
  const teamRows = managerId
    ? (database
        .prepare(
          `SELECT t.id, t.name, t.league_id, t.tournament_id, t.players_json,
                  l.name AS mantra_league_name, l.division AS mantra_league_division
           FROM mantra_fantasy_teams t
           LEFT JOIN mantra_leagues l ON l.id = t.league_id
           WHERE t.user_id = ?
           ORDER BY t.name, t.id`,
        )
        .all(managerId) as PremiumFantasyTeam[])
    : [];
  const filteredTeams = teamRows.filter((team) => {
    if (options.tournamentId != null) return team.tournament_id === options.tournamentId;
    const league = leagueByTournament(team.tournament_id);
    return league != null && isUiLeagueSlug(league.slug);
  });
  const leagues = Array.from(
    new Map(
      filteredTeams.flatMap((team) => {
        const league = leagueByTournament(team.tournament_id);
        return league
          ? [
              [
                league.mantraTournamentId ?? league.id,
                {
                  tournamentId: team.tournament_id,
                  afLeagueId: league.id,
                  id: league.slug,
                  name: league.name,
                },
              ] as const,
            ]
          : [];
      }),
    ).values(),
  );
  const empty = (message: string) => ({
    leagues,
    selectedTournamentId: options.tournamentId ?? filteredTeams[0]?.tournament_id ?? null,
    rows: [] as Array<Record<string, unknown>>,
    teams: mapPremiumTeamOptions(filteredTeams),
    clubs: [] as Array<{ id: number; name: string; tournamentId: number | null }>,
    managerIdConfigured: Boolean(managerId),
    selectionLogic:
      "Составы менеджера — сезонная заявка до кнопки «Обновить состав моей команды». Матч, P(win), CS и счёт — следующий незавершённый тур чемпионата. Expected11 % — из сохранённого разбора этого тура.",
    gaps: {
      popularScore: false,
      gkCleanSheetDistinct: false,
    },
      counts: { rows: 0, teams: filteredTeams.length, odds: 0, expected11: 0, footmops: 0, cleanSheets: 0 },
    sourceAggregate: getExpected11View(database).aggregate,
    ...mantraFormationsPayload(),
    message,
  });
  if (!managerId) {
    return empty("Укажи Mantra Manager ID в аккаунте — таблица строится по твоим составам.");
  }
  if (filteredTeams.length === 0) {
    return empty("Нет составов Mantra. Нужен синк команд менеджера.");
  }

  const playerIds = [
    ...new Set(filteredTeams.flatMap((team) => parseNumberArray(team.players_json))),
  ];
  const players = playerIds.length
    ? (database
        .prepare(
          `SELECT id, name, first_name, full_name, positions_json, tm_url,
                  club_id, club_name, tournament_id
           FROM mantra_players
           WHERE id IN (${playerIds.map(() => "?").join(",")})`,
        )
        .all(...playerIds) as Array<{
        id: number;
        name: string;
        first_name: string | null;
        full_name: string | null;
        positions_json: string | null;
        tm_url: string | null;
        club_id: number | null;
        club_name: string | null;
        tournament_id: number | null;
      }>)
    : [];
  const playerById = new Map(players.map((player) => [player.id, player]));
  const oddsJoin = getPremiumOddsJoin(database, season, nowMs);
  const fixtures = oddsJoin.fixtures;
  const expected11 = oddsJoin.expected11;
  const footmops = footmopsByPlayer(database);
  const championshipTournamentId =
    leagueBySlug("championship")?.mantraTournamentId ?? 11;
  const tournamentIds = [
    ...new Set(
      filteredTeams
        .map((team) => team.tournament_id)
        .filter((id): id is number => id != null),
    ),
  ];
  const roundByLeague = new Map(oddsJoin.rounds);
  const resultRows = [];
  for (const team of filteredTeams) {
    const league = leagueByTournament(team.tournament_id);
    const leagueId = league?.id ?? null;
    if (leagueId != null && !roundByLeague.has(leagueId)) {
      roundByLeague.set(leagueId, nextUpcomingRound(database, leagueId, season, nowMs));
    }
    const round = leagueId != null ? roundByLeague.get(leagueId) ?? null : null;
    const teamName = team.name || `Команда #${team.id}`;
    const leagueName = league?.name ?? null;
    const managerLeagueName =
      mantraLeagueLabel(team.mantra_league_name, team.mantra_league_division) ??
      leagueName;
    for (const playerId of parseNumberArray(team.players_json)) {
      const player = playerById.get(playerId);
      if (!player) continue;
      const positions = parseStringArray(player.positions_json);
      const hint = expected11.get(player.id);
      const footmopsHint =
        team.tournament_id === championshipTournamentId ||
        player.tournament_id === championshipTournamentId
          ? footmops.get(player.id)
          : undefined;
      const fixture =
        leagueId != null && player.club_name
          ? clubFixture(player.club_name, leagueId, round ?? null, fixtures, nowMs)
          : null;
      const isHome = fixture
        ? clubMatches(player.club_name, fixture.home_name)
        : false;
      const probabilities = fixture
        ? normalizedImplied1x2(
            fixture.home_odd,
            fixture.draw_odd,
            fixture.away_odd,
          )
        : null;
      const profilePlayerId = expected11ProfilePlayerId(player.tm_url);
      const opponent = fixture
        ? isHome
          ? fixture.away_name
          : fixture.home_name
        : hint?.opponent ?? null;
      resultRows.push({
        mantraPlayerId: player.id,
        displayName: fullName(player),
        surname: player.name,
        positions,
        position: positions[0] ?? null,
        clubId: player.club_id,
        clubName: player.club_name,
        managerTeamId: team.id,
        managerTeamName: teamName,
        managerLeagueName,
        tournamentId: team.tournament_id,
        leagueName,
        round,
        roundLabel: round != null ? `Тур ${round}` : null,
        profilePlayerId,
        mantraProfileUrl: profilePlayerId
          ? `/player.html?id=${profilePlayerId}`
          : null,
        expected11Name: hint?.expected11Name ?? null,
        expected11PlayerUrl: hint?.expected11PlayerUrl ?? null,
        expected11MatchUrl: hint?.expected11MatchUrl ?? null,
        lineupGroup: hint?.lineupGroup ?? null,
        displayedPercentage: hint?.displayedPercentage ?? null,
        footmopsPercentage: footmopsHint?.displayedPercentage ?? null,
        footmopsGroup: footmopsHint?.lineupGroup ?? null,
        opponent,
        kickoff: fixture?.kickoff ?? null,
        kickoffKnown: Boolean(fixture?.kickoff),
        matchLabel: opponent
          ? `${isHome ? "Д" : fixture ? "Г" : "—"} vs ${opponent}`
          : null,
        winProbability:
          probabilities == null
            ? null
            : isHome
              ? probabilities.home
              : probabilities.away,
        cleanSheetProbability: fixture
          ? isHome
            ? fixture.home_cs_prob
            : fixture.away_cs_prob
          : null,
        opponentCleanSheetProbability: fixture
          ? isHome
            ? fixture.away_cs_prob
            : fixture.home_cs_prob
          : null,
        popularScore: fixture?.popular_score ?? null,
        bookmaker: probabilities || fixture?.home_cs_prob != null
          ? fixture?.bookmaker ?? null
          : null,
        owned: true,
      });
    }
  }
  resultRows.sort(
    (a, b) =>
      (a.leagueName || "").localeCompare(b.leagueName || "") ||
      a.managerTeamName.localeCompare(b.managerTeamName) ||
      (a.position || "").localeCompare(b.position || "") ||
      a.displayName.localeCompare(b.displayName) ||
      a.mantraPlayerId - b.mantraPlayerId,
  );
  return {
    leagues,
    selectedTournamentId:
      options.tournamentId ?? filteredTeams[0]?.tournament_id ?? null,
    rows: resultRows,
    teams: mapPremiumTeamOptions(filteredTeams),
    clubs: clubsInManagerLeagues(
      database,
      tournamentIds,
      resultRows.flatMap((row) =>
        row.clubId != null
          ? [
              {
                id: row.clubId,
                name: row.clubName || `#${row.clubId}`,
                tournamentId: row.tournamentId,
              },
            ]
          : [],
      ),
    ),
    managerIdConfigured: true,
    selectionLogic:
      "Составы менеджера — сезонная заявка до кнопки «Обновить состав моей команды». Матч, P(win), CS клуба/соперника и счёт — следующий незавершённый тур чемпионата (1X2, CS Yes/No, Exact Score). Expected11 % — из сохранённого разбора этого тура.",
    gaps: {
      popularScore: false,
      gkCleanSheetDistinct: false,
    },
    counts: {
      rows: resultRows.length,
      teams: filteredTeams.length,
      odds: resultRows.filter((row) => row.winProbability != null).length,
      expected11: resultRows.filter((row) => row.displayedPercentage != null).length,
      footmops: resultRows.filter((row) => row.footmopsPercentage != null).length,
      cleanSheets: resultRows.filter((row) => row.cleanSheetProbability != null)
        .length,
    },
    sourceAggregate: getExpected11View(database).aggregate,
    ...mantraFormationsPayload(),
    message: resultRows.length
      ? null
      : "В составах нет игроков на ближайший тур.",
  };
}

