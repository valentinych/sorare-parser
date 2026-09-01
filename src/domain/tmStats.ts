import * as af from "../clients/apiFootball.js";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { AF_LEAGUES, isUiTmCompetition, uiLeagues } from "../lib/afLeagues.js";
import { afLeagueToCompCode, competitionLabel } from "../lib/competitionLabels.js";
import { namesMatch, normName } from "../lib/names.js";

export type TmCompetitionView = {
  id: string;
  name: string;
  shortName: string | null;
  seasonId: number | null;
  totalMarketValue: number | null;
  gameDayCount: number | null;
  closestGameDay: number | null;
  isOngoing: boolean;
  logoUrl: string | null;
  relativeUrl: string | null;
  syncedAt: string | null;
  clubCount: number;
  playerCount: number;
  /** True when registered in AF_LEAGUES but TM table not synced yet. */
  pending?: boolean;
};

export type TmClubView = {
  id: string;
  name: string;
  shortName: string | null;
  abbreviation: string | null;
  city: string | null;
  crestUrl: string | null;
  relativeUrl: string | null;
  squadSize: number | null;
  averageAge: number | null;
  marketValue: number | null;
  averageMarketValue: number | null;
  acquisitionValue: number | null;
  top18MarketValue: number | null;
  ranking: number | null;
  points: number | null;
  played: number | null;
  wins: number | null;
  draws: number | null;
  losses: number | null;
  goalsFor: number | null;
  goalsAgainst: number | null;
  goalDiff: number | null;
  syncedAt: string | null;
};

export type TmSquadPlayerView = {
  clubId: string;
  clubName: string;
  playerId: string;
  name: string;
  shirtNumber: number | null;
  isCaptain: boolean;
  age: number | null;
  dateOfBirth: string | null;
  height: number | null;
  preferredFoot: string | null;
  position: string | null;
  detailRole: string | null;
  detailLabel: string | null;
  sideRole: string | null;
  sideRole2: string | null;
  marketValueEur: number | null;
  marketValuePrevious: number | null;
  marketValueHighest: number | null;
  contractUntil: string | null;
  placeOfBirth: string | null;
  nationality: string | null;
  nationalityId: number | null;
  agencyName: string | null;
  gender: string | null;
  portraitUrl: string | null;
  relativeUrl: string | null;
  /** AF season (starting year), e.g. 2025 = 2025/26. */
  season?: number;
  afPlayerId?: number | null;
  /** Domestic AF league for the selected TM competition. */
  domesticLeagueId?: number | null;
  domesticLeague?: string | null;
  /** Clubs played for this season (AF). */
  clubsPlayed?: string[];
  /** Aggregated season totals across competitions (see competitionFilter). */
  seasonTotals?: PlayerSeasonTotals | null;
  /** Per-competition lines for the season. */
  competitions?: PlayerCompStatLine[];
  /** Mantra classic positions (e.g. ["DM","AM"]), null when no Mantra link. */
  mantraPositions?: string[] | null;
};

export type PlayerSeasonTotals = {
  appearances: number;
  lineups: number;
  minutes: number;
  goals: number;
  assists: number;
  rating: number | null;
  yellowCards: number;
  redCards: number;
  goalsConceded: number;
  cleanSheets: number;
  shotsTotal: number | null;
  shotsOn: number | null;
  passesTotal: number | null;
  keyPasses: number | null;
  passAccuracy: number | null;
  tacklesTotal: number | null;
  blocks: number | null;
  interceptions: number | null;
  dribblesAttempts: number | null;
  dribblesSuccess: number | null;
  foulsDrawn: number | null;
  foulsCommitted: number | null;
  penScored: number | null;
  penMissed: number | null;
  saves: number | null;
  /** AF does not provide xG/xA — always null. */
  xg: null;
  xa: null;
};

export type PlayerCompStatLine = PlayerSeasonTotals & {
  leagueId: number;
  leagueName: string;
  leagueCode: string;
  teamId: number;
  teamName: string;
  isDomestic: boolean;
};

export type TmGameView = {
  id: string;
  competitionId: string | null;
  /** Human-readable tournament name (decoded from code / AF league). */
  competitionName: string | null;
  seasonId: number | null;
  gameDay: number | null;
  dateUtc: string | null;
  homeClubId: string | null;
  awayClubId: string | null;
  homeClubName: string | null;
  awayClubName: string | null;
  homeScore: number | null;
  awayScore: number | null;
  isFinished: boolean;
  isLive: boolean;
  homeTactic: string | null;
  awayTactic: string | null;
  relativeUrl: string | null;
  /** tm = Transfermarkt game; af = API Football preseason/friendly. */
  source?: "tm" | "af";
};

export type TmRefCategory = {
  category: string;
  count: number;
};

function money(n: unknown): number | null {
  return n == null ? null : Number(n);
}

function pendingCompetitionStub(tmId: string): TmCompetitionView | null {
  const league = Object.values(AF_LEAGUES).find((l) => l.tmCompetition === tmId);
  if (!league) return null;
  return {
    id: tmId,
    name: league.name,
    shortName: tmId,
    seasonId: config.predictSeason,
    totalMarketValue: null,
    gameDayCount: null,
    closestGameDay: null,
    isOngoing: false,
    logoUrl: null,
    relativeUrl: null,
    syncedAt: null,
    clubCount: 0,
    playerCount: 0,
    pending: true,
  };
}

export function listCompetitions(): TmCompetitionView[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, short_name, season_id, total_market_value, game_day_count,
              closest_game_day, is_ongoing, logo_url, relative_url, synced_at
       FROM tm_competitions
       ORDER BY name`,
    )
    .all() as Array<{
    id: string;
    name: string;
    short_name: string | null;
    season_id: number | null;
    total_market_value: number | null;
    game_day_count: number | null;
    closest_game_day: number | null;
    is_ongoing: number | null;
    logo_url: string | null;
    relative_url: string | null;
    synced_at: string | null;
  }>;

  const byId = new Map<string, TmCompetitionView>();
  for (const row of rows) {
    if (!isUiTmCompetition(row.id)) continue;
    const clubCount = (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM tm_competition_clubs WHERE competition_id = ?`)
        .get(row.id) as { n: number }
    ).n;
    const playerCount = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM tm_squad_players sp
           JOIN tm_competition_clubs cc ON cc.club_id = sp.club_id
           WHERE cc.competition_id = ?`,
        )
        .get(row.id) as { n: number }
    ).n;
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      shortName: row.short_name,
      seasonId: row.season_id,
      totalMarketValue: money(row.total_market_value),
      gameDayCount: row.game_day_count,
      closestGameDay: row.closest_game_day,
      isOngoing: Boolean(row.is_ongoing),
      logoUrl: row.logo_url,
      relativeUrl: row.relative_url,
      syncedAt: row.synced_at,
      clubCount,
      playerCount,
      pending: false,
    });
  }

  // Visible AF leagues only — hidden championships stay reachable via ?league= / getCompetition.
  for (const league of uiLeagues()) {
    if (byId.has(league.tmCompetition)) continue;
    const stub = pendingCompetitionStub(league.tmCompetition);
    if (stub) byId.set(stub.id, stub);
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export function getCompetition(competitionId = "PL1"): TmCompetitionView | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, name, short_name, season_id, total_market_value, game_day_count,
              closest_game_day, is_ongoing, logo_url, relative_url, synced_at
       FROM tm_competitions WHERE id = ?`,
    )
    .get(competitionId) as
    | {
        id: string;
        name: string;
        short_name: string | null;
        season_id: number | null;
        total_market_value: number | null;
        game_day_count: number | null;
        closest_game_day: number | null;
        is_ongoing: number | null;
        logo_url: string | null;
        relative_url: string | null;
        synced_at: string | null;
      }
    | undefined;
  if (!row) return pendingCompetitionStub(competitionId);

  const clubCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM tm_competition_clubs WHERE competition_id = ?`).get(competitionId) as {
      n: number;
    }
  ).n;
  const playerCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tm_squad_players sp
         JOIN tm_competition_clubs cc ON cc.club_id = sp.club_id
         WHERE cc.competition_id = ?`,
      )
      .get(competitionId) as { n: number }
  ).n;

  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    seasonId: row.season_id,
    totalMarketValue: money(row.total_market_value),
    gameDayCount: row.game_day_count,
    closestGameDay: row.closest_game_day,
    isOngoing: Boolean(row.is_ongoing),
    logoUrl: row.logo_url,
    relativeUrl: row.relative_url,
    syncedAt: row.synced_at,
    clubCount,
    playerCount,
  };
}

export function listCompetitionClubs(competitionId = "PL1"): TmClubView[] {
  const rows = getDb()
    .prepare(
      `SELECT
         cl.id, cl.name, cl.short_name, cl.abbreviation, cl.city, cl.crest_url, cl.relative_url,
         cl.squad_size, cl.average_age, cl.market_value, cl.average_market_value,
         cl.acquisition_value, cl.top18_market_value, cl.synced_at,
         cc.ranking, cc.points, cc.played, cc.wins, cc.draws, cc.losses,
         cc.goals_for, cc.goals_against, cc.goal_diff
       FROM tm_competition_clubs cc
       JOIN tm_clubs cl ON cl.id = cc.club_id
       WHERE cc.competition_id = ?
       ORDER BY COALESCE(cl.market_value, 0) DESC, cl.name`,
    )
    .all(competitionId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    shortName: (r.short_name as string) ?? null,
    abbreviation: (r.abbreviation as string) ?? null,
    city: (r.city as string) ?? null,
    crestUrl: (r.crest_url as string) ?? null,
    relativeUrl: (r.relative_url as string) ?? null,
    squadSize: r.squad_size == null ? null : Number(r.squad_size),
    averageAge: r.average_age == null ? null : Number(r.average_age),
    marketValue: money(r.market_value),
    averageMarketValue: money(r.average_market_value),
    acquisitionValue: money(r.acquisition_value),
    top18MarketValue: money(r.top18_market_value),
    ranking: r.ranking == null ? null : Number(r.ranking),
    points: r.points == null ? null : Number(r.points),
    played: r.played == null ? null : Number(r.played),
    wins: r.wins == null ? null : Number(r.wins),
    draws: r.draws == null ? null : Number(r.draws),
    losses: r.losses == null ? null : Number(r.losses),
    goalsFor: r.goals_for == null ? null : Number(r.goals_for),
    goalsAgainst: r.goals_against == null ? null : Number(r.goals_against),
    goalDiff: r.goal_diff == null ? null : Number(r.goal_diff),
    syncedAt: (r.synced_at as string) ?? null,
  }));
}

export function getClub(clubId: string, competitionId?: string): TmClubView | null {
  const compId = competitionId ?? null;
  const r = getDb()
    .prepare(
      `SELECT
         cl.id, cl.name, cl.short_name, cl.abbreviation, cl.city, cl.crest_url, cl.relative_url,
         cl.squad_size, cl.average_age, cl.market_value, cl.average_market_value,
         cl.acquisition_value, cl.top18_market_value, cl.synced_at,
         cc.ranking, cc.points, cc.played, cc.wins, cc.draws, cc.losses,
         cc.goals_for, cc.goals_against, cc.goal_diff
       FROM tm_clubs cl
       LEFT JOIN tm_competition_clubs cc
         ON cc.club_id = cl.id
         AND cc.competition_id = COALESCE(?, (
           SELECT competition_id FROM tm_competition_clubs WHERE club_id = cl.id LIMIT 1
         ))
       WHERE cl.id = ?`,
    )
    .get(compId, clubId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: String(r.id),
    name: String(r.name),
    shortName: (r.short_name as string) ?? null,
    abbreviation: (r.abbreviation as string) ?? null,
    city: (r.city as string) ?? null,
    crestUrl: (r.crest_url as string) ?? null,
    relativeUrl: (r.relative_url as string) ?? null,
    squadSize: r.squad_size == null ? null : Number(r.squad_size),
    averageAge: r.average_age == null ? null : Number(r.average_age),
    marketValue: money(r.market_value),
    averageMarketValue: money(r.average_market_value),
    acquisitionValue: money(r.acquisition_value),
    top18MarketValue: money(r.top18_market_value),
    ranking: r.ranking == null ? null : Number(r.ranking),
    points: r.points == null ? null : Number(r.points),
    played: r.played == null ? null : Number(r.played),
    wins: r.wins == null ? null : Number(r.wins),
    draws: r.draws == null ? null : Number(r.draws),
    losses: r.losses == null ? null : Number(r.losses),
    goalsFor: r.goals_for == null ? null : Number(r.goals_for),
    goalsAgainst: r.goals_against == null ? null : Number(r.goals_against),
    goalDiff: r.goal_diff == null ? null : Number(r.goal_diff),
    syncedAt: (r.synced_at as string) ?? null,
  };
}

export function listClubSquad(clubId: string): TmSquadPlayerView[] {
  const club = getDb().prepare(`SELECT name FROM tm_clubs WHERE id = ?`).get(clubId) as
    | { name: string }
    | undefined;
  const clubName = club?.name ?? "";
  const rows = getDb()
    .prepare(
      `SELECT club_id, player_id, shirt_number, is_captain, name, age, date_of_birth, height,
              preferred_foot, position, detail_role, detail_label, side_role,
              market_value_eur, market_value_previous, market_value_highest, contract_until,
              place_of_birth, nationality, nationality_id, agency_name, gender,
              portrait_url, relative_url
       FROM tm_squad_players
       WHERE club_id = ?
       ORDER BY
         CASE position WHEN 'GK' THEN 0 WHEN 'DEF' THEN 1 WHEN 'MID' THEN 2 WHEN 'ATT' THEN 3 ELSE 4 END,
         COALESCE(market_value_eur, 0) DESC,
         name`,
    )
    .all(clubId) as Array<Record<string, unknown>>;

  return rows.map((r) => mapPlayer(r, clubName));
}

function parseMantraPositionsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
  } catch {
    return [];
  }
}

function tmIdFromMantraUrl(tmUrl: string | null): string | null {
  if (!tmUrl) return null;
  const m = /\/spieler\/(\d+)/i.exec(tmUrl);
  return m?.[1] ?? null;
}

type MantraPosSource = {
  positions: string[];
  tmId: string | null;
  fullName: string;
  surname: string;
  firstName: string | null;
  clubName: string | null;
};

function loadMantraPosSources(tournamentId: number): MantraPosSource[] {
  const rows = getDb()
    .prepare(
      `SELECT full_name, name, first_name, club_name, positions_json, tm_url
       FROM mantra_players
       WHERE tournament_id = ? OR (tournament_id IS NULL AND ? = 18)`,
    )
    .all(tournamentId, tournamentId) as Array<{
    full_name: string | null;
    name: string | null;
    first_name: string | null;
    club_name: string | null;
    positions_json: string | null;
    tm_url: string | null;
  }>;

  return rows
    .map((r) => {
      const positions = parseMantraPositionsJson(r.positions_json);
      if (!positions.length) return null;
      return {
        positions,
        tmId: tmIdFromMantraUrl(r.tm_url),
        fullName: r.full_name || [r.first_name, r.name].filter(Boolean).join(" "),
        surname: r.name || "",
        firstName: r.first_name,
        clubName: r.club_name,
      } satisfies MantraPosSource;
    })
    .filter((x): x is MantraPosSource => x != null);
}

function clubsLooselyMatch(tmClub: string, mantraClub: string): boolean {
  const a = normName(tmClub);
  const b = normName(mantraClub);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const stop = new Set(["krakow", "warszawa", "lodz", "wroclaw", "fc", "ks"]);
  const ta = a.split(" ").filter((t) => t.length > 2 && !stop.has(t));
  const tb = b.split(" ").filter((t) => t.length > 2 && !stop.has(t));
  return ta.some((t) => tb.includes(t));
}

function matchMantraPositionsByName(
  tmName: string,
  tmClub: string,
  sources: MantraPosSource[],
): string[] | null {
  const afTokens = normName(tmName).split(" ").filter(Boolean);
  const afLast = afTokens[afTokens.length - 1] ?? "";
  const scored: Array<{ positions: string[]; score: number; clubHit: number }> = [];

  for (const m of sources) {
    const full = m.fullName;
    const reversed = [m.surname, m.firstName].filter(Boolean).join(" ");
    let score = 0;
    if (namesMatch(tmName, full) || namesMatch(tmName, reversed)) {
      const na = normName(tmName);
      const nb = normName(full);
      const ta = na.split(" ").filter((t) => t.length > 1);
      const tb = nb.split(" ").filter((t) => t.length > 1);
      const inter = ta.filter((t) => tb.includes(t));
      const lastA = ta[ta.length - 1] ?? "";
      const lastB = tb[tb.length - 1] ?? "";
      score = inter.length * 10 + Math.min(na.length, nb.length);
      if (lastA && lastA === lastB) score += 20;
      if (tb.length >= 2 && inter.length >= 2) score += 15;
      if (na === nb) score = Math.max(score, 100);
    }
    const manSurname = normName(m.surname || "")
      .split(" ")
      .filter(Boolean)
      .pop();
    if (manSurname && afLast && manSurname === afLast && manSurname.length >= 4) {
      score = Math.max(score, 8);
    }
    if (score > 0) {
      scored.push({
        positions: m.positions,
        score,
        clubHit: m.clubName && clubsLooselyMatch(tmClub, m.clubName) ? 1 : 0,
      });
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.clubHit - a.clubHit || b.score - a.score);
  return scored[0]!.positions;
}

/** Resolve Mantra classic positions for TM squad players (tm_url id, then name+club). */
function resolveMantraPositionsMap(
  players: Array<{ playerId: string; name: string; clubName: string }>,
  tournamentId: number | null,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (tournamentId == null) return out;

  const sources = loadMantraPosSources(tournamentId);
  const byTmId = new Map<string, string[]>();
  for (const s of sources) {
    if (s.tmId) byTmId.set(s.tmId, s.positions);
  }

  for (const p of players) {
    const viaUrl = byTmId.get(p.playerId);
    if (viaUrl?.length) {
      out.set(p.playerId, viaUrl);
      continue;
    }
    const viaName = matchMantraPositionsByName(p.name, p.clubName, sources);
    if (viaName?.length) out.set(p.playerId, viaName);
  }
  return out;
}

export function listAllPlayers(competitionId = "PL1"): TmSquadPlayerView[] {
  const season = config.season;
  const afLeague = Object.values(AF_LEAGUES).find((l) => l.tmCompetition === competitionId);
  const domesticLeagueId = afLeague?.id ?? null;
  const domesticLeague = afLeague?.name ?? null;
  const mantraTournamentId = afLeague?.mantraTournamentId ?? null;

  const rows = getDb()
    .prepare(
      `SELECT sp.club_id, cl.name AS club_name, sp.player_id, sp.shirt_number, sp.is_captain,
              sp.name, sp.age, sp.date_of_birth, sp.height, sp.preferred_foot, sp.position,
              sp.detail_role, sp.detail_label, sp.side_role, sp.market_value_eur,
              sp.market_value_previous, sp.market_value_highest, sp.contract_until,
              sp.place_of_birth, sp.nationality, sp.nationality_id, sp.agency_name, sp.gender,
              sp.portrait_url, sp.relative_url,
              pv.af_player_id AS af_player_id
       FROM tm_squad_players sp
       JOIN tm_competition_clubs cc ON cc.club_id = sp.club_id AND cc.competition_id = ?
       JOIN tm_clubs cl ON cl.id = sp.club_id
       LEFT JOIN player_values pv ON pv.tm_player_id = sp.player_id
       ORDER BY COALESCE(sp.market_value_eur, 0) DESC, sp.name`,
    )
    .all(competitionId) as Array<Record<string, unknown>>;

  const afIds = [
    ...new Set(
      rows
        .map((r) => (r.af_player_id == null ? null : Number(r.af_player_id)))
        .filter((id): id is number => id != null && Number.isFinite(id)),
    ),
  ];
  const statsByAf = loadCompStatsByAfPlayer(afIds, season, domesticLeagueId);
  const mantraByTm = resolveMantraPositionsMap(
    rows.map((r) => ({
      playerId: String(r.player_id),
      name: String(r.name ?? ""),
      clubName: String(r.club_name ?? ""),
    })),
    mantraTournamentId,
  );

  return rows.map((r) => {
    const base = mapPlayer(r, String(r.club_name ?? ""));
    const afId = r.af_player_id == null ? null : Number(r.af_player_id);
    const packed = afId != null ? statsByAf.get(afId) : undefined;
    const mantraPositions = mantraByTm.get(base.playerId) ?? null;
    return {
      ...base,
      season,
      afPlayerId: afId,
      domesticLeagueId,
      domesticLeague,
      clubsPlayed: packed?.clubsPlayed ?? [],
      seasonTotals: packed?.totals ?? null,
      competitions: packed?.competitions ?? [],
      mantraPositions,
    };
  });
}

type CompStatRow = {
  player_id: number;
  team_id: number;
  league_id: number;
  league_name: string | null;
  team_name: string | null;
  appearances: number | null;
  lineups: number | null;
  minutes: number | null;
  goals: number | null;
  assists: number | null;
  rating: number | null;
  yellow_cards: number | null;
  red_cards: number | null;
  goals_conceded: number | null;
  clean_sheets: number | null;
  shots_total: number | null;
  shots_on: number | null;
  passes_total: number | null;
  key_passes: number | null;
  pass_accuracy: number | null;
  tackles_total: number | null;
  blocks: number | null;
  interceptions: number | null;
  dribbles_attempts: number | null;
  dribbles_success: number | null;
  fouls_drawn: number | null;
  fouls_committed: number | null;
  pen_scored: number | null;
  pen_missed: number | null;
  saves: number | null;
};

function emptyTotals(): PlayerSeasonTotals {
  return {
    appearances: 0,
    lineups: 0,
    minutes: 0,
    goals: 0,
    assists: 0,
    rating: null,
    yellowCards: 0,
    redCards: 0,
    goalsConceded: 0,
    cleanSheets: 0,
    shotsTotal: null,
    shotsOn: null,
    passesTotal: null,
    keyPasses: null,
    passAccuracy: null,
    tacklesTotal: null,
    blocks: null,
    interceptions: null,
    dribblesAttempts: null,
    dribblesSuccess: null,
    foulsDrawn: null,
    foulsCommitted: null,
    penScored: null,
    penMissed: null,
    saves: null,
    xg: null,
    xa: null,
  };
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function accumulateTotals(acc: PlayerSeasonTotals, row: CompStatRow): void {
  acc.appearances += Number(row.appearances ?? 0) || 0;
  acc.lineups += Number(row.lineups ?? 0) || 0;
  acc.minutes += Number(row.minutes ?? 0) || 0;
  acc.goals += Number(row.goals ?? 0) || 0;
  acc.assists += Number(row.assists ?? 0) || 0;
  acc.yellowCards += Number(row.yellow_cards ?? 0) || 0;
  acc.redCards += Number(row.red_cards ?? 0) || 0;
  acc.goalsConceded += Number(row.goals_conceded ?? 0) || 0;
  acc.cleanSheets += Number(row.clean_sheets ?? 0) || 0;
  acc.shotsTotal = addNullable(acc.shotsTotal, row.shots_total == null ? null : Number(row.shots_total));
  acc.shotsOn = addNullable(acc.shotsOn, row.shots_on == null ? null : Number(row.shots_on));
  acc.passesTotal = addNullable(acc.passesTotal, row.passes_total == null ? null : Number(row.passes_total));
  acc.keyPasses = addNullable(acc.keyPasses, row.key_passes == null ? null : Number(row.key_passes));
  acc.tacklesTotal = addNullable(acc.tacklesTotal, row.tackles_total == null ? null : Number(row.tackles_total));
  acc.blocks = addNullable(acc.blocks, row.blocks == null ? null : Number(row.blocks));
  acc.interceptions = addNullable(acc.interceptions, row.interceptions == null ? null : Number(row.interceptions));
  acc.dribblesAttempts = addNullable(
    acc.dribblesAttempts,
    row.dribbles_attempts == null ? null : Number(row.dribbles_attempts),
  );
  acc.dribblesSuccess = addNullable(
    acc.dribblesSuccess,
    row.dribbles_success == null ? null : Number(row.dribbles_success),
  );
  acc.foulsDrawn = addNullable(acc.foulsDrawn, row.fouls_drawn == null ? null : Number(row.fouls_drawn));
  acc.foulsCommitted = addNullable(
    acc.foulsCommitted,
    row.fouls_committed == null ? null : Number(row.fouls_committed),
  );
  acc.penScored = addNullable(acc.penScored, row.pen_scored == null ? null : Number(row.pen_scored));
  acc.penMissed = addNullable(acc.penMissed, row.pen_missed == null ? null : Number(row.pen_missed));
  acc.saves = addNullable(acc.saves, row.saves == null ? null : Number(row.saves));
}

function weightedRating(rows: CompStatRow[]): number | null {
  let sum = 0;
  let mins = 0;
  for (const r of rows) {
    if (r.rating == null) continue;
    const m = Number(r.minutes ?? 0) || 0;
    const w = m > 0 ? m : 1;
    sum += Number(r.rating) * w;
    mins += w;
  }
  if (!mins) return null;
  return Number((sum / mins).toFixed(2));
}

function weightedPassAccuracy(rows: CompStatRow[]): number | null {
  let sum = 0;
  let weight = 0;
  for (const r of rows) {
    if (r.pass_accuracy == null) continue;
    const passes = Number(r.passes_total ?? 0) || 0;
    const w = passes > 0 ? passes : 1;
    sum += Number(r.pass_accuracy) * w;
    weight += w;
  }
  if (!weight) return null;
  return Math.round(sum / weight);
}

function rowToCompLine(row: CompStatRow, domesticLeagueId: number | null): PlayerCompStatLine {
  const code = afLeagueToCompCode(row.league_id, row.league_name);
  const totals = emptyTotals();
  accumulateTotals(totals, row);
  totals.rating = row.rating == null ? null : Number(row.rating);
  totals.passAccuracy = row.pass_accuracy == null ? null : Number(row.pass_accuracy);
  const afName = row.league_name?.trim() || null;
  return {
    ...totals,
    leagueId: row.league_id,
    // Prefer AF league name — codes like CLQ are fixture-oriented and mislabel UCL season stats.
    leagueName: afName || competitionLabel(code, null),
    leagueCode: code,
    teamId: row.team_id,
    teamName: row.team_name || "—",
    isDomestic: domesticLeagueId != null && row.league_id === domesticLeagueId,
  };
}

function loadCompStatsByAfPlayer(
  afIds: number[],
  season: number,
  domesticLeagueId: number | null,
): Map<number, { totals: PlayerSeasonTotals; competitions: PlayerCompStatLine[]; clubsPlayed: string[] }> {
  const out = new Map<
    number,
    { totals: PlayerSeasonTotals; competitions: PlayerCompStatLine[]; clubsPlayed: string[] }
  >();
  if (!afIds.length) return out;

  const placeholders = afIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT player_id, team_id, league_id, league_name, team_name,
              appearances, lineups, minutes, goals, assists, rating,
              yellow_cards, red_cards, goals_conceded, clean_sheets,
              shots_total, shots_on, passes_total, key_passes, pass_accuracy,
              tackles_total, blocks, interceptions, dribbles_attempts, dribbles_success,
              fouls_drawn, fouls_committed, pen_scored, pen_missed, saves
       FROM player_comp_stats
       WHERE season = ? AND player_id IN (${placeholders})
       ORDER BY appearances DESC, goals DESC`,
    )
    .all(season, ...afIds) as CompStatRow[];

  const byPlayer = new Map<number, CompStatRow[]>();
  for (const r of rows) {
    const list = byPlayer.get(r.player_id) ?? [];
    list.push(r);
    byPlayer.set(r.player_id, list);
  }

  for (const [playerId, list] of byPlayer) {
    // Club comps for totals; keep national/friendly lines in competitions[].
    const clubRows = list.filter((r) => {
      const name = (r.league_name || "").toLowerCase();
      if (r.league_id === 10) return false;
      if (name.includes("friendlies") && !name.includes("clubs")) return false;
      return true;
    });
    const forTotals = clubRows.length ? clubRows : list;
    const totals = emptyTotals();
    for (const r of forTotals) accumulateTotals(totals, r);
    totals.rating = weightedRating(forTotals);
    totals.passAccuracy = weightedPassAccuracy(forTotals);

    const clubs = [
      ...new Set(forTotals.map((r) => r.team_name).filter((n): n is string => Boolean(n))),
    ].sort((a, b) => a.localeCompare(b));

    out.set(playerId, {
      totals,
      competitions: list.map((r) => rowToCompLine(r, domesticLeagueId)),
      clubsPlayed: clubs,
    });
  }
  return out;
}

function tmCompNameMap(): Map<string, string> {
  const rows = getDb()
    .prepare(`SELECT id, name, short_name FROM tm_competitions`)
    .all() as Array<{ id: string; name: string; short_name: string | null }>;
  return new Map(rows.map((r) => [r.id, r.short_name || r.name]));
}

function mapTmGameRow(r: Record<string, unknown>, names: Map<string, string>): TmGameView {
  const competitionId = (r.competition_id as string) ?? null;
  return {
    id: String(r.id),
    competitionId,
    competitionName: competitionLabel(competitionId, names.get(competitionId ?? "") ?? null),
    seasonId: r.season_id == null ? null : Number(r.season_id),
    gameDay: r.game_day == null ? null : Number(r.game_day),
    dateUtc: (r.date_utc as string) ?? null,
    homeClubId: (r.home_club_id as string) ?? null,
    awayClubId: (r.away_club_id as string) ?? null,
    homeClubName: (r.home_name as string) ?? null,
    awayClubName: (r.away_name as string) ?? null,
    homeScore: r.home_score == null ? null : Number(r.home_score),
    awayScore: r.away_score == null ? null : Number(r.away_score),
    isFinished: Boolean(r.is_finished),
    isLive: Boolean(r.is_live),
    homeTactic: (r.home_tactic as string) ?? null,
    awayTactic: (r.away_tactic as string) ?? null,
    relativeUrl: (r.relative_url as string) ?? null,
    source: "tm",
  };
}

/** AF preseason/friendlies for clubs in a TM competition (via tm_club_map). */
export function listAfPreseasonGames(opts: {
  competitionId: string;
  clubId?: string;
  season?: number;
}): TmGameView[] {
  const season = opts.season ?? config.predictSeason;
  const afLeague = Object.values(AF_LEAGUES).find((l) => l.tmCompetition === opts.competitionId);
  if (!afLeague) return [];

  const db = getDb();
  const mapRows = db
    .prepare(
      `SELECT m.af_team_id, m.tm_club_id, COALESCE(c.name, m.tm_name, t.name) AS name
       FROM tm_club_map m
       JOIN season_teams st ON st.team_id = m.af_team_id AND st.season = ? AND st.league_id = ?
       LEFT JOIN tm_clubs c ON c.id = m.tm_club_id
       LEFT JOIN teams t ON t.id = m.af_team_id`,
    )
    .all(season, afLeague.id) as Array<{ af_team_id: number; tm_club_id: string; name: string }>;

  if (mapRows.length === 0) return [];

  const afToTm = new Map(mapRows.map((r) => [r.af_team_id, r.tm_club_id]));
  const afToName = new Map(mapRows.map((r) => [r.af_team_id, r.name]));
  const afIds = mapRows.map((r) => r.af_team_id);
  const placeholders = afIds.map(() => "?").join(",");
  const teamNameStmt = db.prepare(`SELECT name FROM teams WHERE id = ?`);

  let sql = `
    SELECT f.id, f.date, f.round, f.status, f.league_id, f.home_team_id, f.away_team_id,
           f.home_goals, f.away_goals, f.season
    FROM fixtures f
    WHERE f.is_preseason = 1 AND f.season = ?
      AND (f.home_team_id IN (${placeholders}) OR f.away_team_id IN (${placeholders}))
  `;
  const params: unknown[] = [season, ...afIds, ...afIds];

  if (opts.clubId) {
    const afClub = mapRows.find((r) => r.tm_club_id === opts.clubId)?.af_team_id;
    if (afClub == null) return [];
    sql += ` AND (f.home_team_id = ? OR f.away_team_id = ?)`;
    params.push(afClub, afClub);
  }

  sql += ` ORDER BY COALESCE(f.date, '') ASC`;

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    date: string | null;
    round: string | null;
    status: string | null;
    league_id: number | null;
    home_team_id: number;
    away_team_id: number;
    home_goals: number | null;
    away_goals: number | null;
    season: number | null;
  }>;

  const done = new Set(["FT", "AET", "PEN"]);
  const live = new Set(["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "INT"]);

  return rows.map((r) => {
    const code = afLeagueToCompCode(r.league_id, r.round);
    const homeTm = afToTm.get(r.home_team_id) ?? `af-${r.home_team_id}`;
    const awayTm = afToTm.get(r.away_team_id) ?? `af-${r.away_team_id}`;
    const homeName =
      afToName.get(r.home_team_id) ??
      (teamNameStmt.get(r.home_team_id) as { name?: string } | undefined)?.name ??
      String(r.home_team_id);
    const awayName =
      afToName.get(r.away_team_id) ??
      (teamNameStmt.get(r.away_team_id) as { name?: string } | undefined)?.name ??
      String(r.away_team_id);
    const st = r.status ?? "";
    return {
      id: `af-${r.id}`,
      competitionId: code,
      competitionName: competitionLabel(code, r.round),
      seasonId: r.season,
      gameDay: null,
      dateUtc: r.date,
      homeClubId: homeTm,
      awayClubId: awayTm,
      homeClubName: homeName,
      awayClubName: awayName,
      homeScore: r.home_goals,
      awayScore: r.away_goals,
      isFinished: done.has(st),
      isLive: live.has(st),
      homeTactic: null,
      awayTactic: null,
      relativeUrl: null,
      source: "af" as const,
    };
  });
}

export function listGames(opts: { competitionId?: string; clubId?: string } = {}): TmGameView[] {
  const competitionId = opts.competitionId ?? "PL1";
  const names = tmCompNameMap();
  const params: unknown[] = [competitionId];
  let sql = `
    SELECT g.id, g.competition_id, g.season_id, g.game_day, g.date_utc,
           g.home_club_id, g.away_club_id, g.home_score, g.away_score,
           g.is_finished, g.is_live, g.home_tactic, g.away_tactic, g.relative_url,
           h.name AS home_name, a.name AS away_name
    FROM tm_games g
    LEFT JOIN tm_clubs h ON h.id = g.home_club_id
    LEFT JOIN tm_clubs a ON a.id = g.away_club_id
    WHERE (
      g.competition_id = ?
      OR g.home_club_id IN (SELECT club_id FROM tm_competition_clubs WHERE competition_id = ?)
      OR g.away_club_id IN (SELECT club_id FROM tm_competition_clubs WHERE competition_id = ?)
    )
  `;
  params.push(competitionId, competitionId);
  if (opts.clubId) {
    sql += ` AND (g.home_club_id = ? OR g.away_club_id = ?)`;
    params.push(opts.clubId, opts.clubId);
  }
  sql += ` ORDER BY COALESCE(g.date_utc, '') ASC, g.game_day ASC`;

  const tmRows = getDb()
    .prepare(sql)
    .all(...params)
    .map((r) => mapTmGameRow(r as Record<string, unknown>, names));

  const afRows = listAfPreseasonGames({
    competitionId,
    clubId: opts.clubId,
  });

  const merged = [...tmRows, ...afRows];
  merged.sort((a, b) => String(a.dateUtc ?? "").localeCompare(String(b.dateUtc ?? "")));
  return merged;
}

export async function getAfPreseasonGameDetail(gameId: string) {
  if (!gameId.startsWith("af-")) return null;
  const fixtureId = Number(gameId.slice(3));
  if (!Number.isFinite(fixtureId)) return null;

  const db = getDb();
  const f = db
    .prepare(
      `SELECT f.*, ht.name AS home_name, at.name AS away_name
       FROM fixtures f
       LEFT JOIN teams ht ON ht.id = f.home_team_id
       LEFT JOIN teams at ON at.id = f.away_team_id
       WHERE f.id = ?`,
    )
    .get(fixtureId) as
    | {
        id: number;
        date: string | null;
        round: string | null;
        status: string | null;
        league_id: number | null;
        season: number | null;
        home_team_id: number;
        away_team_id: number;
        home_goals: number | null;
        away_goals: number | null;
        home_name: string | null;
        away_name: string | null;
        is_preseason: number;
      }
    | undefined;
  if (!f) return null;

  const mapClub = (afId: number) =>
    db
      .prepare(`SELECT tm_club_id, tm_name FROM tm_club_map WHERE af_team_id = ?`)
      .get(afId) as { tm_club_id: string; tm_name: string | null } | undefined;

  const homeMap = mapClub(f.home_team_id);
  const awayMap = mapClub(f.away_team_id);
  const clubIdFor = (afTeamId: number) => {
    if (afTeamId === f.home_team_id) return homeMap?.tm_club_id ?? `af-${afTeamId}`;
    if (afTeamId === f.away_team_id) return awayMap?.tm_club_id ?? `af-${afTeamId}`;
    return mapClub(afTeamId)?.tm_club_id ?? `af-${afTeamId}`;
  };
  const clubNameFor = (afTeamId: number, fallback?: string | null) => {
    if (afTeamId === f.home_team_id) return homeMap?.tm_name ?? f.home_name ?? fallback ?? String(afTeamId);
    if (afTeamId === f.away_team_id) return awayMap?.tm_name ?? f.away_name ?? fallback ?? String(afTeamId);
    return mapClub(afTeamId)?.tm_name ?? fallback ?? String(afTeamId);
  };

  const code = afLeagueToCompCode(f.league_id, f.round);
  const done = new Set(["FT", "AET", "PEN"]);
  const st = f.status ?? "";

  // Lazy-fetch from API Football (friendlies often have events but empty lineups).
  let lineup: Array<{
    clubId: string;
    playerId: string;
    playerName: string;
    isStarter: boolean;
    shirtNumber: number | null;
    isCaptain: boolean;
    positionLabel: string | null;
  }> = [];
  let events: GameEventView[] = [];
  let homeTactic: string | null = null;
  let awayTactic: string | null = null;
  let lineupNote: string | null = null;

  try {
    const [luRes, evRes] = await Promise.all([
      af.lineups(fixtureId),
      af.fixtureEvents(fixtureId),
    ]);

    for (const lu of luRes.response ?? []) {
      const clubId = clubIdFor(lu.team.id);
      if (lu.team.id === f.home_team_id) homeTactic = lu.formation ?? null;
      if (lu.team.id === f.away_team_id) awayTactic = lu.formation ?? null;
      for (const slot of lu.startXI ?? []) {
        const p = slot.player;
        if (!p?.id) continue;
        lineup.push({
          clubId,
          playerId: String(p.id),
          playerName: p.name,
          isStarter: true,
          shirtNumber: null,
          isCaptain: false,
          positionLabel: p.pos ?? null,
        });
      }
      for (const slot of lu.substitutes ?? []) {
        const p = slot.player;
        if (!p?.id) continue;
        lineup.push({
          clubId,
          playerId: String(p.id),
          playerName: p.name,
          isStarter: false,
          shirtNumber: null,
          isCaptain: false,
          positionLabel: p.pos ?? null,
        });
      }
    }
    if (lineup.length === 0) {
      lineupNote = "API Football не отдаёт составы для этого матча (типично для товарищеских)";
    }

    events = (evRes.response ?? []).map((e) => mapAfEvent(e, clubIdFor, clubNameFor));
  } catch (err) {
    lineupNote = `Не удалось загрузить детали из API Football: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    game: {
      id: gameId,
      competitionId: code,
      competitionName: competitionLabel(code, f.round),
      seasonId: f.season,
      gameDay: null,
      dateUtc: f.date,
      homeClubId: homeMap?.tm_club_id ?? `af-${f.home_team_id}`,
      awayClubId: awayMap?.tm_club_id ?? `af-${f.away_team_id}`,
      homeClubName: homeMap?.tm_name ?? f.home_name,
      awayClubName: awayMap?.tm_name ?? f.away_name,
      homeScore: f.home_goals,
      awayScore: f.away_goals,
      isFinished: done.has(st),
      isLive: false,
      homeTactic,
      awayTactic,
      relativeUrl: null,
      source: "af" as const,
      status: st,
      lineupNote,
    },
    lineup,
    events,
  };
}

function mapAfEvent(
  e: af.AfFixtureEvent,
  clubIdFor: (afTeamId: number) => string,
  clubNameFor: (afTeamId: number, fallback?: string | null) => string,
): GameEventView {
  const type = (e.type || "").toLowerCase();
  const detail = e.detail || "";
  let eventType = "other";
  let eventLabel = detail || e.type || "Событие";
  let icon = "•";

  if (type === "goal") {
    eventType = "goals";
    icon = "⚽";
    if (/own/i.test(detail)) {
      eventLabel = "Автогол";
      icon = "🥅";
    } else if (/penalty/i.test(detail)) {
      eventLabel = "Гол (пенальти)";
    } else if (/free.?kick/i.test(detail)) {
      eventLabel = "Гол (штрафной)";
    } else {
      eventLabel = "Гол";
    }
  } else if (type === "card") {
    eventType = "cards";
    if (/red/i.test(detail)) {
      eventLabel = "Красная";
      icon = "🟥";
    } else if (/second.*yellow|yellow.*red/i.test(detail)) {
      eventLabel = "Вторая жёлтая";
      icon = "🟨🟥";
    } else {
      eventLabel = "Жёлтая";
      icon = "🟨";
    }
  } else if (type === "subst") {
    eventType = "substitutes";
    eventLabel = "Замена";
    icon = "🔄";
  }

  const minute = e.time?.elapsed ?? null;
  const added = e.time?.extra ?? null;
  const minuteLabel =
    minute == null ? "?" : added != null && added > 0 ? `${minute}+${added}` : String(minute);

  const playerId = e.player?.id != null ? String(e.player.id) : null;
  const assistId = e.assist?.id != null ? String(e.assist.id) : null;

  // For subst AF: player = in, assist = out
  const activePlayerId = eventType === "substitutes" ? assistId : playerId;
  const passivePlayerId = eventType === "substitutes" ? playerId : assistId;
  const activePlayerName =
    eventType === "substitutes" ? (e.assist?.name ?? null) : (e.player?.name ?? null);
  const passivePlayerName =
    eventType === "substitutes" ? (e.player?.name ?? null) : (e.assist?.name ?? null);

  return {
    clubId: clubIdFor(e.team.id),
    clubName: clubNameFor(e.team.id, e.team.name),
    eventType,
    eventLabel,
    minute,
    addedTime: added,
    minuteLabel,
    action: e.type,
    reason: detail,
    reasonLabel: detail && detail !== eventLabel ? detail : null,
    activePlayerId,
    passivePlayerId,
    activePlayerName,
    passivePlayerName,
    summary: [eventLabel, activePlayerName, passivePlayerName ? `(${passivePlayerName})` : null]
      .filter(Boolean)
      .join(" "),
    icon,
  };
}

export async function getGameDetail(gameId: string) {
  if (gameId.startsWith("af-")) return getAfPreseasonGameDetail(gameId);

  const game = getDb()
    .prepare(
      `SELECT g.*, h.name AS home_name, a.name AS away_name
       FROM tm_games g
       LEFT JOIN tm_clubs h ON h.id = g.home_club_id
       LEFT JOIN tm_clubs a ON a.id = g.away_club_id
       WHERE g.id = ?`,
    )
    .get(gameId) as Record<string, unknown> | undefined;
  if (!game) return null;

  const lineup = getDb()
    .prepare(
      `SELECT l.*,
              COALESCE(
                (SELECT sp.name FROM tm_squad_players sp WHERE sp.player_id = l.player_id LIMIT 1),
                l.player_id
              ) AS player_name
       FROM tm_game_lineup l
       WHERE l.game_id = ?
       ORDER BY l.club_id, l.is_starter DESC, l.shirt_number`,
    )
    .all(gameId) as Array<Record<string, unknown>>;

  const nameById = new Map<string, string>();
  for (const row of lineup) {
    nameById.set(String(row.player_id), String(row.player_name));
  }

  let raw: Record<string, unknown> = {};
  try {
    raw = game.raw_json ? (JSON.parse(String(game.raw_json)) as Record<string, unknown>) : {};
  } catch {
    /* ignore */
  }

  const richEvents = buildRichEventsFromRaw(raw, {
    homeClubId: game.home_club_id != null ? String(game.home_club_id) : null,
    awayClubId: game.away_club_id != null ? String(game.away_club_id) : null,
    homeClubName: (game.home_name as string) ?? null,
    awayClubName: (game.away_name as string) ?? null,
    nameById,
  });

  const events =
    richEvents.length > 0
      ? richEvents
      : (
          getDb()
            .prepare(
              `SELECT * FROM tm_game_events WHERE game_id = ?
               ORDER BY COALESCE(minute, 0), seq`,
            )
            .all(gameId) as Array<Record<string, unknown>>
        ).map((r) => formatStoredEvent(r, nameById, game));

  return {
    game: {
      id: String(game.id),
      competitionId: (game.competition_id as string) ?? null,
      competitionName: competitionLabel(
        (game.competition_id as string) ?? null,
        tmCompNameMap().get(String(game.competition_id ?? "")) ?? null,
      ),
      seasonId: game.season_id == null ? null : Number(game.season_id),
      gameDay: game.game_day == null ? null : Number(game.game_day),
      dateUtc: (game.date_utc as string) ?? null,
      homeClubId: (game.home_club_id as string) ?? null,
      awayClubId: (game.away_club_id as string) ?? null,
      homeClubName: (game.home_name as string) ?? null,
      awayClubName: (game.away_name as string) ?? null,
      homeScore: game.home_score == null ? null : Number(game.home_score),
      awayScore: game.away_score == null ? null : Number(game.away_score),
      isFinished: Boolean(game.is_finished),
      isLive: Boolean(game.is_live),
      homeTactic: (game.home_tactic as string) ?? null,
      awayTactic: (game.away_tactic as string) ?? null,
      relativeUrl: (game.relative_url as string) ?? null,
      source: "tm" as const,
    },
    lineup: lineup.map((r) => ({
      clubId: String(r.club_id),
      playerId: String(r.player_id),
      playerName: (r.player_name as string) ?? String(r.player_id),
      isStarter: Boolean(r.is_starter),
      shirtNumber: r.shirt_number == null ? null : Number(r.shirt_number),
      isCaptain: Boolean(r.is_captain),
      positionLabel: (r.position_label as string) ?? null,
      ageAtGame: r.age_at_game == null ? null : Number(r.age_at_game),
      marketValueEur: money(r.market_value_eur),
    })),
    events,
  };
}

type GameEventView = {
  clubId: string | null;
  clubName: string | null;
  eventType: string;
  eventLabel: string;
  minute: number | null;
  addedTime: number | null;
  minuteLabel: string;
  action: string | null;
  reason: string | null;
  reasonLabel: string | null;
  activePlayerId: string | null;
  passivePlayerId: string | null;
  activePlayerName: string | null;
  passivePlayerName: string | null;
  summary: string;
  icon: string;
};

function resolvePlayerName(
  id: string | null | undefined,
  embedded: Record<string, unknown> | null | undefined,
  nameById: Map<string, string>,
): string | null {
  if (!id) return null;
  const short = embedded?.shortName != null ? String(embedded.shortName) : null;
  const full = embedded?.name != null ? String(embedded.name) : null;
  if (short) return short;
  if (full) return full;
  if (nameById.has(id)) return nameById.get(id)!;
  const row = getDb()
    .prepare(`SELECT name FROM tm_squad_players WHERE player_id = ? LIMIT 1`)
    .get(id) as { name: string } | undefined;
  return row?.name ?? id;
}

function reasonLabel(reasonId: unknown, reasonText: string | null): string | null {
  const fromRef = refLookup("reasons", reasonId != null ? Number(reasonId) : null);
  const refName = fromRef?.raw?.reason != null ? String(fromRef.raw.reason) : fromRef?.name ?? null;
  if (refName && refName !== "Not reported") return refName;
  if (reasonText && reasonText !== "Not reported" && reasonText !== "") return reasonText;
  return null;
}

function buildRichEventsFromRaw(
  raw: Record<string, unknown>,
  ctx: {
    homeClubId: string | null;
    awayClubId: string | null;
    homeClubName: string | null;
    awayClubName: string | null;
    nameById: Map<string, string>;
  },
): GameEventView[] {
  const out: GameEventView[] = [];
  const sides: Array<{ clubId: string | null; clubName: string | null; club: Record<string, unknown> }> = [
    {
      clubId: ctx.homeClubId,
      clubName: ctx.homeClubName,
      club: (raw.homeClub ?? {}) as Record<string, unknown>,
    },
    {
      clubId: ctx.awayClubId,
      clubName: ctx.awayClubName,
      club: (raw.awayClub ?? {}) as Record<string, unknown>,
    },
  ];

  for (const side of sides) {
    const actions = (side.club.actions ?? {}) as Record<string, Array<Record<string, unknown>>>;
    for (const [eventType, list] of Object.entries(actions)) {
      if (!Array.isArray(list)) continue;
      list.forEach((ev, seq) => {
        out.push(
          toEventView({
            clubId: side.clubId,
            clubName: side.clubName,
            eventType,
            minute: ev.minute != null ? Number(ev.minute) : null,
            addedTime: ev.addedTime != null ? Number(ev.addedTime) : null,
            action: ev.action != null ? String(ev.action) : null,
            reason: ev.reason != null ? String(ev.reason) : null,
            reasonId: ev.reasonId,
            actionId: ev.actionId,
            activePlayerId: ev.activePlayerId != null ? String(ev.activePlayerId) : null,
            passivePlayerId: ev.passivePlayerId != null ? String(ev.passivePlayerId) : null,
            activePlayer: (ev.activePlayer ?? null) as Record<string, unknown> | null,
            passivePlayer: (ev.passivePlayer ?? null) as Record<string, unknown> | null,
            nameById: ctx.nameById,
            seq,
          }),
        );
      });
    }
  }

  out.sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0) || (a.addedTime ?? 0) - (b.addedTime ?? 0));
  return out;
}

function formatStoredEvent(
  r: Record<string, unknown>,
  nameById: Map<string, string>,
  game: Record<string, unknown>,
): GameEventView {
  const clubId = r.club_id != null ? String(r.club_id) : null;
  const clubName =
    clubId && clubId === String(game.home_club_id)
      ? ((game.home_name as string) ?? null)
      : clubId && clubId === String(game.away_club_id)
        ? ((game.away_name as string) ?? null)
        : null;
  return toEventView({
    clubId,
    clubName,
    eventType: String(r.event_type),
    minute: r.minute == null ? null : Number(r.minute),
    addedTime: r.added_time == null ? null : Number(r.added_time),
    action: (r.action as string) ?? null,
    reason: (r.reason as string) ?? null,
    reasonId: null,
    actionId: null,
    activePlayerId: (r.active_player_id as string) ?? null,
    passivePlayerId: (r.passive_player_id as string) ?? null,
    activePlayer: null,
    passivePlayer: null,
    nameById,
    seq: Number(r.seq ?? 0),
  });
}

function toEventView(input: {
  clubId: string | null;
  clubName: string | null;
  eventType: string;
  minute: number | null;
  addedTime: number | null;
  action: string | null;
  reason: string | null;
  reasonId: unknown;
  actionId: unknown;
  activePlayerId: string | null;
  passivePlayerId: string | null;
  activePlayer: Record<string, unknown> | null;
  passivePlayer: Record<string, unknown> | null;
  nameById: Map<string, string>;
  seq: number;
}): GameEventView {
  const activeName = resolvePlayerName(input.activePlayerId, input.activePlayer, input.nameById);
  const passiveName = resolvePlayerName(input.passivePlayerId, input.passivePlayer, input.nameById);
  const rLabel = reasonLabel(input.reasonId, input.reason);
  const minuteLabel =
    input.minute == null
      ? "?"
      : input.addedTime && input.addedTime > 0
        ? `${input.minute}+${input.addedTime}`
        : `${input.minute}`;

  let eventLabel = input.eventType;
  let icon = "•";
  let summary = "";

  if (input.eventType === "goals") {
    eventLabel = "Гол";
    icon = "⚽";
    summary = activeName || input.activePlayerId || "неизвестно";
    if (passiveName) summary += ` (п.а. ${passiveName})`;
    if (rLabel) summary += ` · ${rLabel}`;
  } else if (input.eventType === "cards") {
    const isRed =
      (input.action || "").toLowerCase().includes("red") ||
      (input.action || "").toLowerCase().includes("second yellow");
    eventLabel = isRed ? "Красная" : "Жёлтая";
    icon = isRed ? "🟥" : "🟨";
    summary = activeName || input.activePlayerId || "неизвестно";
    if (rLabel) summary += ` · ${rLabel}`;
  } else if (input.eventType === "substitutes") {
    eventLabel = "Замена";
    icon = "🔄";
    // TM: active = уходит, passive = выходит
    const outName = activeName || input.activePlayerId || "?";
    const inName = passiveName || input.passivePlayerId || "?";
    summary = `${inName} ↑ · ${outName} ↓`;
  } else {
    eventLabel = input.eventType;
    summary = [input.action, activeName, passiveName ? `↔ ${passiveName}` : null, rLabel]
      .filter((x) => x && x !== "Not reported")
      .join(" · ");
  }

  if (input.clubName) summary += ` · ${input.clubName}`;

  return {
    clubId: input.clubId,
    clubName: input.clubName,
    eventType: input.eventType,
    eventLabel,
    minute: input.minute,
    addedTime: input.addedTime,
    minuteLabel,
    action: input.action,
    reason: input.reason,
    reasonLabel: rLabel,
    activePlayerId: input.activePlayerId,
    passivePlayerId: input.passivePlayerId,
    activePlayerName: activeName,
    passivePlayerName: passiveName,
    summary,
    icon,
  };
}

export function listRefCategories(): TmRefCategory[] {
  return getDb()
    .prepare(`SELECT category, COUNT(*) AS count FROM tm_ref GROUP BY category ORDER BY category`)
    .all() as TmRefCategory[];
}

export function listRef(category: string) {
  return getDb()
    .prepare(`SELECT category, id, name, raw_json FROM tm_ref WHERE category = ? ORDER BY name`)
    .all(category) as Array<{ category: string; id: string; name: string | null; raw_json: string | null }>;
}

/** What each TM /attributes catalog is for (used in UI + player card resolution). */
export const REF_CATEGORY_META: Record<string, { title: string; purpose: string; usedInPlayerCard: boolean }> = {
  positions: {
    title: "Позиции",
    purpose: "Игровые роли (GK, CB, AM…). id из attributes.positionId / sidePositionId.",
    usedInPlayerCard: true,
  },
  countries: {
    title: "Страны",
    purpose: "Гражданство и страна рождения: имя, FIFA-код, флаг, confederationId.",
    usedInPlayerCard: true,
  },
  confederations: {
    title: "Конфедерации",
    purpose: "UEFA/CAF/… — привязка страны к континентальной федерации.",
    usedInPlayerCard: true,
  },
  outfitters: {
    title: "Экипировщики",
    purpose: "Бренд бутс/формы игрока (outfitterId в профиле).",
    usedInPlayerCard: true,
  },
  tactics: {
    title: "Тактики",
    purpose: "Схемы матча (4-2-3-1…). В карточке — через матчи с участием игрока.",
    usedInPlayerCard: true,
  },
  actions: {
    title: "Типы событий матча",
    purpose: "Kick Off, гол, карточка, замена… Коды actionId в протоколах.",
    usedInPlayerCard: false,
  },
  reasons: {
    title: "Причины событий",
    purpose: "Уточнение гола/карточки (Corner, Header, Foul…).",
    usedInPlayerCard: false,
  },
  absences: {
    title: "Причины отсутствия",
    purpose: "Дисквалификации, сборная, отпуск. В API профиля PL1 пока нет истории.",
    usedInPlayerCard: false,
  },
  injuries: {
    title: "Травмы",
    purpose: "Справочник типов травм. История травм отдельным endpoint’ом не отдаётся.",
    usedInPlayerCard: false,
  },
  roles: {
    title: "Роли staff",
    purpose: "Должности тренерского штаба (Manager, Scout…), не полевые позиции.",
    usedInPlayerCard: false,
  },
  contracts: {
    title: "Опции контракта",
    purpose: "Типы опций (продление клубом, Kaufoption…). В профиле игрока редко заполнены.",
    usedInPlayerCard: false,
  },
  competitionTypes: {
    title: "Типы турниров",
    purpose: "First Tier, Cup, Youth… для классификации соревнований.",
    usedInPlayerCard: false,
  },
  competitionGroups: {
    title: "Группы турниров",
    purpose: "Группы/стадии внутри турнира.",
    usedInPlayerCard: false,
  },
  competitionGroupQualifier: {
    title: "Квалификаторы групп",
    purpose: "Метки квалификации/выхода из группы.",
    usedInPlayerCard: false,
  },
  contexts: {
    title: "Домены TM",
    purpose: "Локали сайта transfermarkt (.de, .com, …).",
    usedInPlayerCard: false,
  },
  locales: {
    title: "Локали UI",
    purpose: "Языки/регионы интерфейса TM.",
    usedInPlayerCard: false,
  },
  topLevelDomains: {
    title: "TLD",
    purpose: "Доменные зоны TM.",
    usedInPlayerCard: false,
  },
};

function refLookup(category: string, id: number | string | null | undefined) {
  if (id == null || id === "" || id === 0 || id === "0") return null;
  const row = getDb()
    .prepare(`SELECT id, name, raw_json FROM tm_ref WHERE category = ? AND id = ?`)
    .get(category, String(id)) as { id: string; name: string | null; raw_json: string | null } | undefined;
  if (!row) return null;
  let raw: Record<string, unknown> = {};
  try {
    raw = row.raw_json ? (JSON.parse(row.raw_json) as Record<string, unknown>) : {};
  } catch {
    /* ignore */
  }
  return { id: row.id, name: row.name, raw };
}

export function getPlayerDetail(playerId: string) {
  const rows = getDb()
    .prepare(
      `SELECT sp.*, cl.name AS club_name, cl.crest_url AS club_crest, cl.city AS club_city
       FROM tm_squad_players sp
       LEFT JOIN tm_clubs cl ON cl.id = sp.club_id
       WHERE sp.player_id = ?
       ORDER BY sp.synced_at DESC`,
    )
    .all(playerId) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;

  const primary = rows[0]!;
  let raw: Record<string, unknown> = {};
  try {
    raw = primary.raw_json ? (JSON.parse(String(primary.raw_json)) as Record<string, unknown>) : {};
  } catch {
    /* ignore */
  }
  const attrs = (raw.attributes ?? {}) as Record<string, unknown>;
  const life = (raw.lifeDates ?? {}) as Record<string, unknown>;
  const birth = (raw.birthPlaceDetails ?? {}) as Record<string, unknown>;
  const nat = ((raw.nationalityDetails as Record<string, unknown> | undefined)?.nationalities ??
    {}) as Record<string, unknown>;
  const mv = (raw.marketValueDetails ?? {}) as Record<string, unknown>;
  const mvCurrent = (mv.current ?? {}) as Record<string, unknown>;
  const mvPrev = (mv.previous ?? {}) as Record<string, unknown>;
  const mvHigh = (mv.highest ?? {}) as Record<string, unknown>;
  const mvDelta = (mv.delta ?? {}) as Record<string, unknown>;
  const agency = (attrs.consultantAgency ?? {}) as Record<string, unknown>;
  const foot = (attrs.preferredFoot ?? {}) as Record<string, unknown>;
  const pos = (attrs.position ?? {}) as Record<string, unknown>;
  const side1 = (attrs.firstSidePosition ?? {}) as Record<string, unknown>;
  const side2 = (attrs.secondSidePosition ?? {}) as Record<string, unknown>;

  const nationalityId = nat.nationalityId != null ? Number(nat.nationalityId) : null;
  const secondNatId =
    nat.secondNationalityId && Number(nat.secondNationalityId) > 0 ? Number(nat.secondNationalityId) : null;
  const birthCountryId = birth.countryOfBirthId != null ? Number(birth.countryOfBirthId) : null;
  const outfitterId = attrs.outfitterId != null ? Number(attrs.outfitterId) : null;

  const nationality = refLookup("countries", nationalityId);
  const secondNationality = refLookup("countries", secondNatId);
  const birthCountry = refLookup("countries", birthCountryId);
  const confederation = refLookup(
    "confederations",
    nationality?.raw?.confederationId != null ? Number(nationality.raw.confederationId) : null,
  );
  const outfitter = refLookup("outfitters", outfitterId);
  const mainPosition = refLookup("positions", attrs.positionId != null ? Number(attrs.positionId) : null);
  const sidePos1 = refLookup("positions", attrs.firstSidePositionId != null ? Number(attrs.firstSidePositionId) : null);
  const sidePos2 = refLookup(
    "positions",
    attrs.secondSidePositionId != null ? Number(attrs.secondSidePositionId) : null,
  );

  const clubs = rows.map((r) => ({
    clubId: String(r.club_id),
    clubName: (r.club_name as string) ?? null,
    clubCrest: (r.club_crest as string) ?? null,
    clubCity: (r.club_city as string) ?? null,
    shirtNumber: r.shirt_number == null ? null : Number(r.shirt_number),
    isCaptain: Boolean(r.is_captain),
  }));

  const assignments = Array.isArray(raw.clubAssignments) ? raw.clubAssignments : [];

  const lineupRows = getDb()
    .prepare(
      `SELECT l.game_id, l.club_id, l.is_starter, l.shirt_number, l.is_captain, l.position_label,
              l.age_at_game, l.market_value_eur,
              g.date_utc, g.competition_id, g.game_day, g.home_club_id, g.away_club_id,
              g.home_score, g.away_score, g.home_tactic, g.away_tactic,
              h.name AS home_name, a.name AS away_name
       FROM tm_game_lineup l
       JOIN tm_games g ON g.id = l.game_id
       LEFT JOIN tm_clubs h ON h.id = g.home_club_id
       LEFT JOIN tm_clubs a ON a.id = g.away_club_id
       WHERE l.player_id = ?
       ORDER BY COALESCE(g.date_utc, '') DESC`,
    )
    .all(playerId) as Array<Record<string, unknown>>;

  const eventRows = getDb()
    .prepare(
      `SELECT e.*, g.date_utc, g.competition_id, g.home_club_id, g.away_club_id,
              h.name AS home_name, a.name AS away_name
       FROM tm_game_events e
       JOIN tm_games g ON g.id = e.game_id
       LEFT JOIN tm_clubs h ON h.id = g.home_club_id
       LEFT JOIN tm_clubs a ON a.id = g.away_club_id
       WHERE e.active_player_id = ? OR e.passive_player_id = ?
       ORDER BY COALESCE(g.date_utc, '') DESC, COALESCE(e.minute, 0)`,
    )
    .all(playerId, playerId) as Array<Record<string, unknown>>;

  return {
    playerId: String(primary.player_id),
    name: String(primary.name ?? raw.name ?? ""),
    shortName: (raw.shortName as string) ?? null,
    portraitUrl: (primary.portrait_url as string) ?? (raw.portraitUrl as string) ?? null,
    portraitSource: (raw.portraitUrlSource as string) ?? null,
    relativeUrl: (primary.relative_url as string) ?? (raw.relativeUrl as string) ?? null,
    age: primary.age == null ? (life.age != null ? Number(life.age) : null) : Number(primary.age),
    dateOfBirth: (primary.date_of_birth as string) ?? (life.dateOfBirth as string) ?? null,
    height: primary.height == null ? (attrs.height != null ? Number(attrs.height) : null) : Number(primary.height),
    gender: (primary.gender as string) ?? (birth.gender as string) ?? null,
    preferredFoot: (primary.preferred_foot as string) ?? (foot.name as string) ?? null,
    preferredFootId: foot.id != null ? Number(foot.id) : attrs.preferredFootId != null ? Number(attrs.preferredFootId) : null,
    contractUntil: (primary.contract_until as string) ?? (attrs.contractUntil as string) ?? null,
    formerClubsNote: (attrs.formerClubsNote as string) || null,
    placeOfBirth: (primary.place_of_birth as string) ?? (birth.placeOfBirth as string) ?? null,
    agency: {
      id: agency.id != null ? Number(agency.id) : null,
      name: (primary.agency_name as string) ?? (agency.name as string) ?? null,
      verified: (agency.verificationStatus as string) ?? null,
    },
    marketValue: {
      current: money(mvCurrent.value) ?? money(primary.market_value_eur),
      previous: money(mvPrev.value) ?? money(primary.market_value_previous),
      highest: money(mvHigh.value) ?? money(primary.market_value_highest),
      currentDetermined: (mvCurrent.determined as string) ?? null,
      previousDetermined: (mvPrev.determined as string) ?? null,
      highestDetermined: (mvHigh.determined as string) ?? null,
      deltaValue: (mvDelta.value as string) ?? null,
      deltaType: (mvDelta.type as string) ?? null,
    },
    positions: {
      main: {
        id: attrs.positionId != null ? Number(attrs.positionId) : null,
        label: (pos.shortName as string) ?? (primary.detail_label as string) ?? null,
        name: (pos.name as string) ?? (mainPosition?.name as string) ?? null,
        category: (pos.category as string) ?? (mainPosition?.raw?.category as string) ?? null,
        group: (attrs.positionGroupName as string) ?? null,
        ref: mainPosition,
      },
      extras: [
        side1.shortName || sidePos1
          ? {
              id: attrs.firstSidePositionId != null ? Number(attrs.firstSidePositionId) : null,
              label: (side1.shortName as string) ?? sidePos1?.name ?? null,
              name: (side1.name as string) ?? sidePos1?.name ?? null,
              ref: sidePos1,
            }
          : null,
        side2.shortName || sidePos2
          ? {
              id: attrs.secondSidePositionId != null ? Number(attrs.secondSidePositionId) : null,
              label: (side2.shortName as string) ?? sidePos2?.name ?? null,
              name: (side2.name as string) ?? sidePos2?.name ?? null,
              ref: sidePos2,
            }
          : null,
      ].filter(Boolean),
    },
    nationality: {
      id: nationalityId,
      name: (primary.nationality as string) ?? nationality?.name ?? null,
      fifaCode: (nationality?.raw?.fifaCode as string) ?? null,
      flagUrl: (nationality?.raw?.flagUrl as string) ?? null,
      confederation: confederation
        ? { id: confederation.id, name: confederation.name }
        : null,
      second: secondNationality
        ? {
            id: secondNatId,
            name: secondNationality.name,
            fifaCode: (secondNationality.raw?.fifaCode as string) ?? null,
            flagUrl: (secondNationality.raw?.flagUrl as string) ?? null,
          }
        : null,
    },
    birthCountry: birthCountry
      ? {
          id: birthCountryId,
          name: birthCountry.name,
          flagUrl: (birthCountry.raw?.flagUrl as string) ?? null,
        }
      : null,
    outfitter: outfitter ? { id: outfitter.id, name: outfitter.name } : null,
    clubs,
    assignments,
    matches: lineupRows.map((r) => ({
      gameId: String(r.game_id),
      dateUtc: (r.date_utc as string) ?? null,
      competitionId: (r.competition_id as string) ?? null,
      gameDay: r.game_day == null ? null : Number(r.game_day),
      homeClubName: (r.home_name as string) ?? null,
      awayClubName: (r.away_name as string) ?? null,
      homeScore: r.home_score == null ? null : Number(r.home_score),
      awayScore: r.away_score == null ? null : Number(r.away_score),
      isStarter: Boolean(r.is_starter),
      shirtNumber: r.shirt_number == null ? null : Number(r.shirt_number),
      positionLabel: (r.position_label as string) ?? null,
      homeTactic: (r.home_tactic as string) ?? null,
      awayTactic: (r.away_tactic as string) ?? null,
    })),
    events: eventRows.map((r) => {
      const activePlayerId = (r.active_player_id as string) ?? null;
      const passivePlayerId = (r.passive_player_id as string) ?? null;
      const role = activePlayerId === playerId ? "active" : "passive";
      const nameById = new Map<string, string>();
      const activePlayerName = resolvePlayerName(activePlayerId, null, nameById);
      const passivePlayerName = resolvePlayerName(passivePlayerId, null, nameById);
      const eventType = String(r.event_type);
      let eventLabel = eventType;
      let icon = "•";
      let summary = "";
      let roleLabel = role === "active" ? "участник" : "связан";

      if (eventType === "goals") {
        eventLabel = "Гол";
        icon = "⚽";
        if (role === "active") {
          summary = "забил";
          roleLabel = "автор";
          if (passivePlayerName) summary += ` (п.а. ${passivePlayerName})`;
        } else {
          summary = `голевая передача → ${activePlayerName || activePlayerId || "?"}`;
          roleLabel = "ассист";
        }
      } else if (eventType === "cards") {
        const isRed =
          String(r.action || "")
            .toLowerCase()
            .includes("red") ||
          String(r.action || "")
            .toLowerCase()
            .includes("second yellow");
        eventLabel = isRed ? "Красная" : "Жёлтая";
        icon = isRed ? "🟥" : "🟨";
        summary = eventLabel.toLowerCase();
        roleLabel = "получил";
      } else if (eventType === "substitutes") {
        eventLabel = "Замена";
        icon = "🔄";
        // TM: active = уходит, passive = выходит
        if (role === "passive") {
          summary = `${passivePlayerName || playerId} ↑`;
          if (activePlayerName) summary += ` · ${activePlayerName} ↓`;
          roleLabel = "вышел";
        } else {
          summary = `${activePlayerName || playerId} ↓`;
          if (passivePlayerName) summary += ` · ${passivePlayerName} ↑`;
          roleLabel = "ушёл";
        }
      } else {
        summary =
          (r.action as string) && r.action !== "Not reported"
            ? String(r.action)
            : eventType;
      }

      return {
        gameId: String(r.game_id),
        dateUtc: (r.date_utc as string) ?? null,
        competitionId: (r.competition_id as string) ?? null,
        eventType,
        eventLabel,
        icon,
        minute: r.minute == null ? null : Number(r.minute),
        action: (r.action as string) ?? null,
        reason: (r.reason as string) ?? null,
        role,
        roleLabel,
        summary,
        activePlayerId,
        passivePlayerId,
        activePlayerName,
        passivePlayerName,
        homeClubName: (r.home_name as string) ?? null,
        awayClubName: (r.away_name as string) ?? null,
      };
    }),
    refMeta: REF_CATEGORY_META,
  };
}

function mapPlayer(r: Record<string, unknown>, clubName: string): TmSquadPlayerView {
  return {
    clubId: String(r.club_id),
    clubName,
    playerId: String(r.player_id),
    name: String(r.name ?? ""),
    shirtNumber: r.shirt_number == null ? null : Number(r.shirt_number),
    isCaptain: Boolean(r.is_captain),
    age: r.age == null ? null : Number(r.age),
    dateOfBirth: (r.date_of_birth as string) ?? null,
    height: r.height == null ? null : Number(r.height),
    preferredFoot: (r.preferred_foot as string) ?? null,
    position: (r.position as string) ?? null,
    detailRole: (r.detail_role as string) ?? null,
    detailLabel: (r.detail_label as string) ?? null,
    sideRole: (r.side_role as string) ?? null,
    sideRole2: null,
    marketValueEur: money(r.market_value_eur),
    marketValuePrevious: money(r.market_value_previous),
    marketValueHighest: money(r.market_value_highest),
    contractUntil: (r.contract_until as string) ?? null,
    placeOfBirth: (r.place_of_birth as string) ?? null,
    nationality: (r.nationality as string) ?? null,
    nationalityId: r.nationality_id == null ? null : Number(r.nationality_id),
    agencyName: (r.agency_name as string) ?? null,
    gender: (r.gender as string) ?? null,
    portraitUrl: (r.portrait_url as string) ?? null,
    relativeUrl: (r.relative_url as string) ?? null,
  };
}
