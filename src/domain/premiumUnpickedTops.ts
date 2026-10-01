/**
 * Premium «Топ-5 свободных»: unpicked mantra_players in this league, per position.
 * Picked = id appears in any mantra_fantasy_teams.players_json for the league.
 */
import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import {
  getComputed,
  invalidateComputed,
} from "../lib/computedCache.js";
import { ALL_POSITIONS, type MantraPosition } from "../lib/mantraFormations.js";
import { footmopsByPlayer } from "./footmops.js";
import { FORM_SCORE_VERSION, premiumFormScore } from "./premiumFormScore.js";
import {
  computeSeasonPlayerStats,
  fotmobLeagueIdForTournament,
  loadFotmobSeasonBundle,
  loadMantraPlayersByTournament,
  parseNumberArray,
  pickedPlayerIdsInLeague,
  type SeasonMinutesCell,
} from "./premiumSeasonStats.js";

export const PREMIUM_UNPICKED_TOPS_TTL_MS = 60 * 60 * 1000;
export const PREMIUM_UNPICKED_TOPS_CACHE_PREFIX = "premium:unpicked-tops:";
export const UNPICKED_TOP_PER_POS = 5;

export const UNPICKED_POSITIONS: readonly MantraPosition[] = ALL_POSITIONS;

export type UnpickedTopPlayer = {
  mantraPlayerId: number;
  displayName: string;
  surname: string;
  clubCode: string | null;
  clubName: string | null;
  positions: string[];
  position: string | null;
  minutesByTour: SeasonMinutesCell[];
  ratingAvg: number | null;
  ratingSource: "fotmob";
  mantraTsAvg: number | null;
  formScore: number;
};

export type UnpickedTopGroup = {
  position: MantraPosition;
  players: UnpickedTopPlayer[];
};

export type PremiumUnpickedTopsView = {
  ok: boolean;
  teamId: number | null;
  teamName: string | null;
  leagueId: number | null;
  tours: number[];
  groups: UnpickedTopGroup[];
  ratingSource: "fotmob";
  sofaScore: false;
  cachedAt: string | null;
  message: string | null;
};

type Actor = { mantraManagerId: number | null };

function emptyView(
  message: string,
  teamId: number | null = null,
  teamName: string | null = null,
): PremiumUnpickedTopsView {
  return {
    ok: false,
    teamId,
    teamName,
    leagueId: null,
    tours: [],
    groups: [],
    ratingSource: "fotmob",
    sofaScore: false,
    cachedAt: null,
    message,
  };
}

function toRow(
  stats: ReturnType<typeof computeSeasonPlayerStats>,
  unavailable: boolean,
): UnpickedTopPlayer {
  return {
    mantraPlayerId: stats.mantraPlayerId,
    displayName: stats.displayName,
    surname: stats.surname,
    clubCode: stats.clubCode,
    clubName: stats.clubName,
    positions: stats.positions,
    position: stats.position,
    minutesByTour: stats.minutesByTour,
    ratingAvg: stats.ratingAvg,
    ratingSource: "fotmob",
    mantraTsAvg: stats.mantraTsAvg,
    formScore: premiumFormScore({
      totalMinutes: stats.totalMinutes,
      clubTours: stats.clubTours,
      minutesByTour: stats.minutesByTour,
      ratingAvg: stats.ratingAvg,
      mantraTsAvg: stats.mantraTsAvg,
      lastStreakZero: stats.lastStreakZero,
      unavailable,
    }),
  };
}

function compareUnpicked(a: UnpickedTopPlayer, b: UnpickedTopPlayer): number {
  return (
    b.formScore - a.formScore ||
    (b.ratingAvg ?? -1) - (a.ratingAvg ?? -1) ||
    a.surname.localeCompare(b.surname) ||
    a.mantraPlayerId - b.mantraPlayerId
  );
}

export function topUnpickedByPosition(
  players: UnpickedTopPlayer[],
  perPos = UNPICKED_TOP_PER_POS,
): UnpickedTopGroup[] {
  return UNPICKED_POSITIONS.map((position) => ({
    position,
    players: players
      .filter((player) => player.positions.includes(position))
      .sort(compareUnpicked)
      .slice(0, perPos),
  }));
}

function computeUnpickedTops(
  database: Database.Database,
  team: {
    id: number;
    name: string;
    league_id: number | null;
    tournament_id: number | null;
  },
  now: Date,
): PremiumUnpickedTopsView {
  const leagueId = team.league_id;
  const tournamentId = team.tournament_id;
  if (leagueId == null || tournamentId == null) {
    return emptyView("У команды нет лиги Mantra.", team.id, team.name);
  }
  const universe = loadMantraPlayersByTournament(database, tournamentId);
  const picked = pickedPlayerIdsInLeague(database, leagueId);
  const unpickedRows = universe.filter((row) => !picked.has(row.id));
  if (!unpickedRows.length) {
    return {
      ok: true,
      teamId: team.id,
      teamName: team.name,
      leagueId,
      tours: [],
      groups: UNPICKED_POSITIONS.map((position) => ({ position, players: [] })),
      ratingSource: "fotmob",
      sofaScore: false,
      cachedAt: new Date().toISOString(),
      message: "Все игроки турнира уже взяты в этой лиге.",
    };
  }
  const fotmobIds = unpickedRows
    .map((row) => row.fotmob_player_id)
    .filter((id): id is number => id != null && Number.isSafeInteger(id) && id > 0);
  const bundle = loadFotmobSeasonBundle(
    database,
    fotmobLeagueIdForTournament(tournamentId),
    fotmobIds,
    now,
  );
  const footmops = footmopsByPlayer(database);
  const scored = unpickedRows.map((row) => {
    const stats = computeSeasonPlayerStats(row, bundle, { subNotes: false });
    return toRow(stats, footmops.get(row.id)?.lineupGroup === "out");
  });
  return {
    ok: true,
    teamId: team.id,
    teamName: team.name,
    leagueId,
    tours: bundle.tours,
    groups: topUnpickedByPosition(scored),
    ratingSource: "fotmob",
    sofaScore: false,
    cachedAt: new Date().toISOString(),
    message: null,
  };
}

function pickedFingerprint(ids: Set<number>): string {
  return [...ids].sort((a, b) => a - b).join(",");
}

export async function getPremiumUnpickedTops(
  options: {
    teamId: number;
    fresh?: boolean;
    now?: Date;
  },
  actor: Actor,
  database: Database.Database = getDb(),
): Promise<PremiumUnpickedTopsView> {
  const managerId = actor.mantraManagerId;
  if (!managerId) {
    return emptyView("Укажи Mantra Manager ID в аккаунте.");
  }
  if (!Number.isSafeInteger(options.teamId) || options.teamId <= 0) {
    return emptyView("Выбери команду.");
  }
  const team = database
    .prepare(
      `SELECT id, name, league_id, tournament_id, user_id
       FROM mantra_fantasy_teams
       WHERE id = ? AND user_id = ?`,
    )
    .get(options.teamId, managerId) as
    | {
        id: number;
        name: string;
        league_id: number | null;
        tournament_id: number | null;
        user_id: number;
      }
    | undefined;
  if (!team) {
    return emptyView("Команда не найдена в составах менеджера.", options.teamId);
  }
  const now = options.now ?? new Date();
  const leagueId = team.league_id ?? 0;
  const picked = pickedPlayerIdsInLeague(database, leagueId);
  const bucket = Math.floor(now.getTime() / PREMIUM_UNPICKED_TOPS_TTL_MS);
  const version = `ttl:${bucket}|picked:${pickedFingerprint(picked)}|${FORM_SCORE_VERSION}|v:1`;
  const cacheKey = `${PREMIUM_UNPICKED_TOPS_CACHE_PREFIX}${leagueId}`;
  if (options.fresh) {
    invalidateComputed(cacheKey, { database, persist: true });
  }
  const cached = getComputed<PremiumUnpickedTopsView>(
    cacheKey,
    version,
    () => computeUnpickedTops(database, team, now),
    { database, serveStale: false },
  );
  return {
    ...cached.value,
    teamId: team.id,
    teamName: team.name,
    cachedAt: cached.builtAt || cached.value.cachedAt,
  };
}

export function parsePickedIds(value: string | null): number[] {
  return parseNumberArray(value);
}
