/**
 * Premium «Отчёт по составу»: minutes, FotMob rating, Mantra TS, overlays, subs.
 * SofaScore is not in this repo — rating is FotMob, labeled as such.
 */
import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import {
  getComputed,
  invalidateComputed,
} from "../lib/computedCache.js";
import { withTimeout } from "../lib/withTimeout.js";
import { footmopsByPlayer } from "./footmops.js";
import { FORM_SCORE_VERSION, premiumFormScore } from "./premiumFormScore.js";
import {
  auctionPricesForTeam,
  computeSeasonPlayerStats,
  fotmobLeagueIdForTournament,
  leagueByTournament,
  loadFotmobSeasonBundle,
  loadMantraPlayersByIds,
  parseNumberArray,
  type SeasonMinutesCell,
  type SeasonSubNote,
  deriveClubCode,
  parseFotmobTour,
  reportSurname,
} from "./premiumSeasonStats.js";

export { deriveClubCode, parseFotmobTour, reportSurname };

export const PREMIUM_SQUAD_REPORT_TTL_MS = 60 * 60 * 1000;
export const PREMIUM_SQUAD_REPORT_CACHE_PREFIX = "premium:squad-report:";
/** Injuries overlay must not stall the report (minutes stay in the sqlite cache). */
export const SQUAD_REPORT_INJURY_BUDGET_MS = 8_000;

export type SquadReportMinutesCell = SeasonMinutesCell;
export type SquadReportSubNote = SeasonSubNote;

export type SquadReportInjury = {
  label: string;
  expectedReturn: string | null;
  source?: "fotmob" | "api-football" | "footmops" | "expected11";
  detail?: string | null;
};

export type SquadReportPlayer = {
  mantraPlayerId: number;
  displayName: string;
  surname: string;
  clubCode: string | null;
  positions: string[];
  position: string | null;
  clubName: string | null;
  fotmobPlayerId: number | null;
  fotmobTeamId: number | null;
  minutesByTour: SquadReportMinutesCell[];
  ratingAvg: number | null;
  ratingSource: "fotmob";
  mantraTsAvg: number | null;
  formScore: number;
  auctionPrice: number | null;
  status: string;
  reason: string | null;
  injury: SquadReportInjury | null;
  subNotes: SquadReportSubNote[];
};

export type PremiumSquadReportView = {
  ok: boolean;
  teamId: number | null;
  teamName: string | null;
  tours: number[];
  players: SquadReportPlayer[];
  ratingSource: "fotmob";
  sofaScore: false;
  cachedAt: string | null;
  message: string | null;
  gaps: {
    sofaScore: true;
    fotmobInjuryReturn: boolean;
    apiFootballKey?: boolean;
    injuriesTimedOut?: boolean;
  };
  injuryMeta?: {
    apiFootball: string;
    apiFootballCount: number;
    fotmob: string;
    fotmobTeams: number;
    fotmobHits: number;
  };
};

type Actor = { mantraManagerId: number | null };

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(name),
  );
}

function expected11OutIds(
  database: Database.Database,
  playerIds: number[],
): Set<number> {
  const out = new Set<number>();
  if (!playerIds.length || !tableExists(database, "expected11_predictions")) {
    return out;
  }
  const rows = database
    .prepare(
      `SELECT p.mantra_player_id AS id, p.lineup_group AS lineupGroup,
              m.extracted_at AS extractedAt
       FROM expected11_predictions p
       JOIN expected11_matches m ON m.id = p.match_id
       WHERE p.link_status = 'linked'
         AND p.mantra_player_id IN (${playerIds.map(() => "?").join(",")})
       ORDER BY m.extracted_at DESC`,
    )
    .all(...playerIds) as Array<{
    id: number;
    lineupGroup: string;
    extractedAt: string;
  }>;
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.lineupGroup === "out") out.add(row.id);
  }
  return out;
}

export function squadReportStatus(input: {
  clubTours: number;
  starts: number;
  subApps: number;
  dnpTours: number;
  lastStreakZero: number;
  lastRed: boolean;
  missedAfterRed: boolean;
  footmopsOut: boolean;
  expected11Out: boolean;
  repeatedOffFor: string | null;
  repeatedOnFor: string | null;
}): { status: string; reason: string | null; injury: SquadReportPlayer["injury"] } {
  if (input.footmopsOut) {
    return {
      status: "OUT",
      reason: "футмопс",
      injury: { label: "OUT", expectedReturn: null, source: "footmops", detail: "OUT · футмопс" },
    };
  }
  if (input.expected11Out) {
    return {
      status: "OUT",
      reason: "Expected11",
      injury: { label: "OUT", expectedReturn: null, source: "expected11", detail: "OUT · Expected11" },
    };
  }
  if (input.lastRed && input.missedAfterRed) {
    return {
      status: "дискв.",
      reason: "КК в прошлом туре",
      injury: null,
    };
  }
  if (input.repeatedOnFor) {
    return {
      status: "ротация",
      reason: `выходит вместо ${input.repeatedOnFor}`,
      injury: null,
    };
  }
  if (input.repeatedOffFor) {
    return {
      status: "ротация",
      reason: `заменяют на ${input.repeatedOffFor}`,
      injury: null,
    };
  }
  const startRate = input.clubTours > 0 ? input.starts / input.clubTours : 1;
  if (input.clubTours >= 3 && startRate <= 0.4 && input.subApps >= 2) {
    return {
      status: "ротация",
      reason: "мало стартов, выходы на замену",
      injury: null,
    };
  }
  return { status: "—", reason: null, injury: null };
}

function mostFrequent(names: string[]): string | null {
  if (names.length < 2) return null;
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [name, count] of counts) {
    if (count > n) {
      best = name;
      n = count;
    }
  }
  return n >= 2 ? best : null;
}

function emptyView(
  message: string,
  teamId: number | null = null,
  teamName: string | null = null,
): PremiumSquadReportView {
  return {
    ok: false,
    teamId,
    teamName,
    tours: [],
    players: [],
    ratingSource: "fotmob",
    sofaScore: false,
    cachedAt: null,
    message,
    gaps: { sofaScore: true, fotmobInjuryReturn: true },
  };
}

function formUnavailable(status: string): boolean {
  return (
    status === "OUT" ||
    status === "травма" ||
    status === "дисквал" ||
    status === "дискв." ||
    status === "сомнителен"
  );
}

function rescorePlayer(player: SquadReportPlayer): SquadReportPlayer {
  const known = player.minutesByTour.filter((cell) => cell.minutes != null);
  const totalMinutes = known.reduce((sum, cell) => sum + (cell.minutes || 0), 0);
  return {
    ...player,
    formScore: premiumFormScore({
      totalMinutes,
      clubTours: known.length,
      minutesByTour: player.minutesByTour,
      ratingAvg: player.ratingAvg,
      mantraTsAvg: player.mantraTsAvg,
      unavailable: formUnavailable(player.status),
    }),
  };
}

function computeSquadReport(
  database: Database.Database,
  team: {
    id: number;
    name: string;
    league_id: number | null;
    tournament_id: number | null;
    players_json: string | null;
  },
  now: Date,
): PremiumSquadReportView {
  const fotmobLeagueId = fotmobLeagueIdForTournament(team.tournament_id);
  const playerIds = parseNumberArray(team.players_json);
  if (!playerIds.length) {
    return emptyView("В составе нет игроков.", team.id, team.name);
  }
  const players = loadMantraPlayersByIds(database, playerIds);
  const byId = new Map(players.map((row) => [row.id, row]));
  const fotmobIds = players
    .map((row) => row.fotmob_player_id)
    .filter((id): id is number => id != null && Number.isSafeInteger(id) && id > 0);
  const footmops = footmopsByPlayer(database);
  const e11Out = expected11OutIds(database, playerIds);
  const prices = auctionPricesForTeam(database, team.league_id ?? 0, team.id);
  const bundle = loadFotmobSeasonBundle(database, fotmobLeagueId, fotmobIds, now);

  const result: SquadReportPlayer[] = [];
  for (const playerId of playerIds) {
    const player = byId.get(playerId);
    if (!player) continue;
    const stats = computeSeasonPlayerStats(player, bundle, { subNotes: true });
    const overlays = squadReportStatus({
      clubTours: stats.clubTours,
      starts: stats.starts,
      subApps: stats.subApps,
      dnpTours: 0,
      lastStreakZero: stats.lastStreakZero,
      lastRed: stats.lastRed,
      missedAfterRed: stats.missedAfterRed,
      footmopsOut: footmops.get(playerId)?.lineupGroup === "out",
      expected11Out: e11Out.has(playerId),
      repeatedOffFor: mostFrequent(stats.offFor),
      repeatedOnFor: mostFrequent(stats.onFor),
    });
    const formScore = premiumFormScore({
      totalMinutes: stats.totalMinutes,
      clubTours: stats.clubTours,
      minutesByTour: stats.minutesByTour,
      ratingAvg: stats.ratingAvg,
      mantraTsAvg: stats.mantraTsAvg,
      lastStreakZero: stats.lastStreakZero,
      unavailable: formUnavailable(overlays.status),
    });
    result.push({
      mantraPlayerId: playerId,
      displayName: stats.displayName,
      surname: stats.surname,
      clubCode: stats.clubCode,
      positions: stats.positions,
      position: stats.position,
      clubName: stats.clubName,
      fotmobPlayerId: stats.fotmobPlayerId,
      fotmobTeamId: stats.fotmobTeamId,
      minutesByTour: stats.minutesByTour,
      ratingAvg: stats.ratingAvg,
      ratingSource: "fotmob",
      mantraTsAvg: stats.mantraTsAvg,
      formScore,
      auctionPrice: prices.get(playerId) ?? null,
      status: overlays.status,
      reason: overlays.reason,
      injury: overlays.injury,
      subNotes: stats.subNotes,
    });
  }

  const positionRank = (pos: string | null) => {
    const order = ["GK", "RB", "CB", "LB", "WB", "DM", "CM", "W", "AM", "FW", "ST"];
    const i = pos ? order.indexOf(pos) : -1;
    return i < 0 ? 99 : i;
  };
  result.sort(
    (a, b) =>
      positionRank(a.position) - positionRank(b.position) ||
      a.displayName.localeCompare(b.displayName) ||
      a.mantraPlayerId - b.mantraPlayerId,
  );

  return {
    ok: true,
    teamId: team.id,
    teamName: team.name,
    tours: bundle.tours,
    players: result,
    ratingSource: "fotmob",
    sofaScore: false,
    cachedAt: new Date().toISOString(),
    message: result.length ? null : "В составе нет игроков.",
    gaps: { sofaScore: true, fotmobInjuryReturn: true },
  };
}

function squadFingerprint(playerIds: number[]): string {
  return [...playerIds].sort((a, b) => a - b).join(",");
}

export async function getPremiumSquadReport(
  options: {
    teamId: number;
    fresh?: boolean;
    now?: Date;
    injuries?: boolean;
  },
  actor: Actor,
  database: Database.Database = getDb(),
): Promise<PremiumSquadReportView> {
  const managerId = actor.mantraManagerId;
  if (!managerId) {
    return emptyView("Укажи Mantra Manager ID в аккаунте.");
  }
  if (!Number.isSafeInteger(options.teamId) || options.teamId <= 0) {
    return emptyView("Выбери команду.");
  }
  const team = database
    .prepare(
      `SELECT id, name, league_id, tournament_id, players_json, user_id
       FROM mantra_fantasy_teams
       WHERE id = ? AND user_id = ?`,
    )
    .get(options.teamId, managerId) as
    | {
        id: number;
        name: string;
        league_id: number | null;
        tournament_id: number | null;
        players_json: string | null;
        user_id: number;
      }
    | undefined;
  if (!team) {
    return emptyView("Команда не найдена в составах менеджера.", options.teamId);
  }
  const now = options.now ?? new Date();
  const bucket = Math.floor(now.getTime() / PREMIUM_SQUAD_REPORT_TTL_MS);
  const version = `ttl:${bucket}|squad:${squadFingerprint(parseNumberArray(team.players_json))}|${FORM_SCORE_VERSION}|v:4`;
  const cacheKey = `${PREMIUM_SQUAD_REPORT_CACHE_PREFIX}${team.id}`;
  if (options.fresh) {
    invalidateComputed(cacheKey, { database, persist: true });
  }
  const cached = getComputed<PremiumSquadReportView>(
    cacheKey,
    version,
    () => computeSquadReport(database, team, now),
    { database, serveStale: false },
  );
  const view = {
    ...cached.value,
    cachedAt: cached.builtAt || cached.value.cachedAt,
  };
  if (!options.injuries) return view;
  const { overlaySquadInjuries } = await import("./premiumSquadInjuries.js");
  try {
    const overlay = await withTimeout(
      overlaySquadInjuries(view, {
        now,
        fresh: options.fresh,
        afLeagueId: leagueByTournament(team.tournament_id)?.id ?? null,
        database,
        budgetMs: SQUAD_REPORT_INJURY_BUDGET_MS,
      }),
      SQUAD_REPORT_INJURY_BUDGET_MS,
      "injuries overlay timeout",
    );
    return {
      ...overlay,
      players: overlay.players.map((player) => rescorePlayer(player)),
    };
  } catch {
    return {
      ...view,
      gaps: {
        ...view.gaps,
        fotmobInjuryReturn: true,
        injuriesTimedOut: true,
      },
      injuryMeta: {
        apiFootball: view.injuryMeta?.apiFootball || "error",
        apiFootballCount: view.injuryMeta?.apiFootballCount || 0,
        fotmob: "error",
        fotmobTeams: 0,
        fotmobHits: 0,
      },
    };
  }
}
