/**
 * Shared FotMob season minutes / rating / Mantra TS for Premium reports.
 */
import type Database from "better-sqlite3";
import { AF_LEAGUES } from "../lib/afLeagues.js";
import { liveLeagueBySlug } from "../lib/liveLeagues.js";
import { clubsMatch } from "../lib/mantraFotmobIds.js";
import {
  scorePlayer,
  type PlayerMatchStats,
} from "../lib/mantraScoring.js";
import {
  onPitchCleanSheet,
  parseCleanSheetEvent,
  type CleanSheetEvent,
} from "../lib/playerCleanSheet.js";
import { seasonStartIso } from "./expected11Premium.js";

const SQLITE_IN_CHUNK = 400;

export type SeasonPlayerRow = {
  id: number;
  name: string;
  first_name: string | null;
  full_name: string | null;
  positions_json: string | null;
  club_name: string | null;
  club_code: string | null;
  fotmob_player_id: number | null;
};

export type SeasonMinutesCell = {
  tour: number;
  minutes: number | null;
  starter: boolean | null;
};

export type SeasonSubNote = {
  tour: number | null;
  kind: "off" | "on";
  otherName: string;
  label: string;
  title: string;
};

/** Mantra `name` is the surname; else last token of a display name. */
export function reportSurname(
  full: string | null | undefined,
  mantraName?: string | null,
): string {
  const mantra = String(mantraName || "").trim();
  if (mantra) return mantra;
  const parts = String(full || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts[parts.length - 1] || String(full || "").trim() || "—";
}

const CLUB_NOISE =
  /\b(fc|cf|afc|sc|sk|fk|town|city|united|hotspur|wanderers|athletic|rovers|albion|county)\b/gi;

export function deriveClubCode(
  clubCode: string | null | undefined,
  clubName: string | null | undefined,
): string | null {
  const stored = String(clubCode || "")
    .replace(/[^a-zA-Z]/g, "")
    .slice(0, 4)
    .toUpperCase();
  if (stored.length >= 2) return stored.slice(0, 3);
  const raw = String(clubName || "").trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(CLUB_NOISE, " ")
    .replace(/[^a-zA-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length >= 2) {
    const initials = tokens
      .slice(0, 3)
      .map((token) => token[0] || "")
      .join("")
      .toUpperCase();
    if (initials.length >= 3) return initials.slice(0, 3);
    return (initials + tokens[0]!.slice(1)).toUpperCase().slice(0, 3);
  }
  const word = tokens[0] || raw;
  return word.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase() || null;
}

export function parseFotmobTour(round: string | null | undefined): number | null {
  if (round == null || round === "") return null;
  const match = String(round).match(/(\d+)\s*$/) ?? String(round).match(/(\d+)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export type SeasonPlayerStats = {
  mantraPlayerId: number;
  displayName: string;
  surname: string;
  clubCode: string | null;
  positions: string[];
  position: string | null;
  clubName: string | null;
  fotmobPlayerId: number | null;
  fotmobTeamId: number | null;
  minutesByTour: SeasonMinutesCell[];
  ratingAvg: number | null;
  mantraTsAvg: number | null;
  totalMinutes: number;
  clubTours: number;
  starts: number;
  subApps: number;
  lastStreakZero: number;
  lastRed: boolean;
  missedAfterRed: boolean;
  subNotes: SeasonSubNote[];
  offFor: string[];
  onFor: string[];
};

type MatchRow = {
  id: number;
  round: string | null;
  kickoff: string | null;
  home_id: number | null;
  home_name: string | null;
  away_id: number | null;
  away_name: string | null;
  score_home: number | null;
  score_away: number | null;
  phase: string | null;
};

type PlayerStatRow = {
  match_id: number;
  player_id: number;
  name: string | null;
  team_id: number | null;
  team_name: string | null;
  is_home: number | null;
  starter: number | null;
  position_id: number | null;
  rating: number | null;
  minutes: number | null;
  goals: number | null;
  assists: number | null;
  yellow_cards: number | null;
  red_cards: number | null;
  own_goals: number | null;
  saves: number | null;
  goals_conceded: number | null;
  penalties_won: number | null;
  penalties_conceded: number | null;
  penalties_scored: number | null;
  penalties_missed: number | null;
  penalties_saved: number | null;
};

type EventRow = {
  match_id: number;
  event_idx: number;
  type: string;
  time: number | null;
  overload_time: number | null;
  is_home: number | null;
  raw_json: string | null;
};

export function parseStringArray(value: string | null): string[] {
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

export function parseNumberArray(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .map(Number)
          .filter((item): item is number => Number.isSafeInteger(item) && item > 0)
      : [];
  } catch {
    return [];
  }
}

export function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(name),
  );
}

function columnExists(database: Database.Database, table: string, column: string): boolean {
  if (!/^[a-z0-9_]+$/i.test(table) || !tableExists(database, table)) return false;
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((col) => col.name === column);
}

export function fullName(row: {
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

export function mean(values: number[], digits = 1): number | null {
  if (!values.length) return null;
  const factor = 10 ** digits;
  return (
    Math.round(
      (values.reduce((sum, value) => sum + value, 0) / values.length) * factor,
    ) / factor
  );
}

export function leagueByTournament(tournamentId: number | null | undefined) {
  if (tournamentId == null) return null;
  return (
    Object.values(AF_LEAGUES).find(
      (league) => league.mantraTournamentId === tournamentId,
    ) ?? null
  );
}

export function fotmobLeagueIdForTournament(
  tournamentId: number | null | undefined,
): number | null {
  const league = leagueByTournament(tournamentId);
  return liveLeagueBySlug(league?.slug)?.fotmobLeagueId ?? null;
}

function toStats(row: PlayerStatRow): PlayerMatchStats {
  return {
    rating: row.rating,
    minutes: row.minutes,
    goals: row.goals ?? 0,
    assists: row.assists ?? 0,
    yellowCards: row.yellow_cards ?? 0,
    redCards: row.red_cards ?? 0,
    ownGoals: row.own_goals ?? 0,
    saves: row.saves ?? 0,
    goalsConceded: row.goals_conceded ?? 0,
    penaltiesScored: row.penalties_scored ?? 0,
    penaltiesMissed: row.penalties_missed ?? 0,
    penaltiesSaved: row.penalties_saved ?? 0,
    penaltiesWon: row.penalties_won ?? 0,
    penaltiesConceded: row.penalties_conceded ?? 0,
    appeared: (row.minutes ?? 0) > 0 || row.rating != null,
  };
}

function parseSwap(rawJson: string | null): {
  onId: number | null;
  onName: string | null;
  offId: number | null;
  offName: string | null;
} {
  const empty = { onId: null, onName: null, offId: null, offName: null };
  if (!rawJson) return empty;
  try {
    const raw = JSON.parse(rawJson) as { swap?: Array<Record<string, unknown>> };
    const swap = Array.isArray(raw.swap) ? raw.swap : [];
    const on = swap[0] ?? null;
    const off = swap[1] ?? null;
    return {
      onId: on?.id != null ? Number(on.id) : null,
      onName: on?.name != null ? String(on.name) : null,
      offId: off?.id != null ? Number(off.id) : null,
      offName: off?.name != null ? String(off.name) : null,
    };
  } catch {
    return empty;
  }
}

function inChunks<T>(ids: number[], fn: (chunk: number[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += SQLITE_IN_CHUNK) {
    out.push(...fn(ids.slice(i, i + SQLITE_IN_CHUNK)));
  }
  return out;
}

function loadEvents(database: Database.Database, matchIds: number[]): EventRow[] {
  const ids = [...new Set(matchIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length || !tableExists(database, "fotmob_match_events")) return [];
  return inChunks(ids, (chunk) =>
    database
      .prepare(
        `SELECT match_id, event_idx, type, time, overload_time, is_home, raw_json
         FROM fotmob_match_events
         WHERE match_id IN (${chunk.map(() => "?").join(",")})
           AND type IN ('Goal', 'Substitution')
         ORDER BY match_id, event_idx`,
      )
      .all(...chunk),
  ) as EventRow[];
}

function eventsByMatch(rows: EventRow[]): Map<number, CleanSheetEvent[]> {
  const out = new Map<number, CleanSheetEvent[]>();
  for (const row of rows) {
    const ev = parseCleanSheetEvent(row, row.event_idx);
    const list = out.get(row.match_id);
    if (list) list.push(ev);
    else out.set(row.match_id, [ev]);
  }
  return out;
}

function clubPlayedMatch(
  match: MatchRow,
  teamId: number | null,
  clubName: string | null,
): boolean {
  if (teamId != null) {
    return match.home_id === teamId || match.away_id === teamId;
  }
  if (!clubName) return false;
  return (
    clubsMatch(clubName, match.home_name || "") ||
    clubsMatch(clubName, match.away_name || "")
  );
}

function playerIsHome(
  match: MatchRow,
  stats: PlayerStatRow | undefined,
  teamId: number | null,
  clubName: string | null,
): boolean {
  if (stats?.is_home != null) return Boolean(stats.is_home);
  if (teamId != null) return match.home_id === teamId;
  if (clubName) return clubsMatch(clubName, match.home_name || "");
  return true;
}

export function loadMantraPlayersByIds(
  database: Database.Database,
  playerIds: number[],
): SeasonPlayerRow[] {
  const ids = [...new Set(playerIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return [];
  return inChunks(ids, (chunk) =>
    database
      .prepare(
        `SELECT id, name, first_name, full_name, positions_json, club_name, club_code, fotmob_player_id
         FROM mantra_players
         WHERE id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk),
  ) as SeasonPlayerRow[];
}

export function loadMantraPlayersByTournament(
  database: Database.Database,
  tournamentId: number,
): SeasonPlayerRow[] {
  if (!Number.isSafeInteger(tournamentId) || tournamentId <= 0) return [];
  return database
    .prepare(
      `SELECT id, name, first_name, full_name, positions_json, club_name, club_code, fotmob_player_id
       FROM mantra_players
       WHERE tournament_id = ?`,
    )
    .all(tournamentId) as SeasonPlayerRow[];
}

export function pickedPlayerIdsInLeague(
  database: Database.Database,
  leagueId: number,
): Set<number> {
  const picked = new Set<number>();
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0) return picked;
  if (!tableExists(database, "mantra_fantasy_teams")) return picked;
  const rows = database
    .prepare(`SELECT players_json AS playersJson FROM mantra_fantasy_teams WHERE league_id = ?`)
    .all(leagueId) as Array<{ playersJson: string | null }>;
  for (const row of rows) {
    for (const id of parseNumberArray(row.playersJson)) picked.add(id);
  }
  return picked;
}

/**
 * Auction price this fantasy team paid in this Mantra league.
 * Source: mantra_auction_player_stages.winning_price where outcome=success
 * and winning_team_id = the Premium team's id. Latest auction/stage wins.
 */
export function auctionPricesForTeam(
  database: Database.Database,
  leagueId: number,
  teamId: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (
    !Number.isSafeInteger(leagueId) ||
    leagueId <= 0 ||
    !Number.isSafeInteger(teamId) ||
    teamId <= 0 ||
    !tableExists(database, "mantra_auction_player_stages") ||
    !tableExists(database, "mantra_auction_players")
  ) {
    return out;
  }
  const rows = database
    .prepare(
      `SELECT p.mantra_player_id AS playerId, ps.winning_price AS price
       FROM mantra_auction_player_stages ps
       JOIN mantra_auction_players p
         ON p.mantra_league_id = ps.mantra_league_id
        AND p.auction_id = ps.auction_id
        AND p.player_bid_id = ps.player_bid_id
       WHERE ps.mantra_league_id = ?
         AND ps.winning_team_id = ?
         AND ps.outcome = 'success'
         AND ps.winning_price IS NOT NULL
       ORDER BY ps.auction_id DESC, ps.stage DESC`,
    )
    .all(leagueId, teamId) as Array<{ playerId: number; price: number | null }>;
  for (const row of rows) {
    if (out.has(row.playerId)) continue;
    const price = Number(row.price);
    if (!Number.isFinite(price) || price < 1) continue;
    out.set(row.playerId, price);
  }
  return out;
}

export type FotmobSeasonBundle = {
  matches: MatchRow[];
  tours: number[];
  statsByPlayerMatch: Map<string, PlayerStatRow>;
  matchesWithStats: Set<number>;
  teamIdByPlayer: Map<number, number>;
  csEvents: Map<number, CleanSheetEvent[]>;
  subsByMatch: Map<number, EventRow[]>;
};

export function loadFotmobSeasonBundle(
  database: Database.Database,
  fotmobLeagueId: number | null,
  fotmobIds: number[],
  now: Date,
): FotmobSeasonBundle {
  const empty: FotmobSeasonBundle = {
    matches: [],
    tours: [],
    statsByPlayerMatch: new Map(),
    matchesWithStats: new Set(),
    teamIdByPlayer: new Map(),
    csEvents: new Map(),
    subsByMatch: new Map(),
  };
  if (
    fotmobLeagueId == null ||
    !tableExists(database, "fotmob_matches") ||
    !tableExists(database, "fotmob_match_players")
  ) {
    return empty;
  }
  const seasonStart = seasonStartIso(now);
  const matches = database
    .prepare(
      `SELECT id, round, kickoff, home_id, home_name, away_id, away_name,
              score_home, score_away, phase
       FROM fotmob_matches
       WHERE league_id = ? AND phase = 'finished'
         AND (kickoff IS NULL OR kickoff >= ?)
       ORDER BY kickoff, id`,
    )
    .all(fotmobLeagueId, seasonStart) as MatchRow[];
  const matchIds = matches.map((row) => row.id);
  const ids = [...new Set(fotmobIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const posExpr = columnExists(database, "fotmob_match_players", "position_id")
    ? "position_id"
    : "NULL AS position_id";
  let stats: PlayerStatRow[] = [];
  if (ids.length && matchIds.length) {
    stats = inChunks(matchIds, (matchChunk) =>
      inChunks(ids, (playerChunk) =>
        database
          .prepare(
            `SELECT match_id, player_id, name, team_id, team_name, is_home, starter,
                    ${posExpr}, rating, minutes, goals, assists, yellow_cards, red_cards, own_goals,
                    saves, goals_conceded, penalties_won, penalties_conceded,
                    penalties_scored, penalties_missed, penalties_saved
             FROM fotmob_match_players
             WHERE player_id IN (${playerChunk.map(() => "?").join(",")})
               AND match_id IN (${matchChunk.map(() => "?").join(",")})`,
          )
          .all(...playerChunk, ...matchChunk),
      ),
    ) as PlayerStatRow[];
  }

  const statsByPlayerMatch = new Map<string, PlayerStatRow>();
  const statsByPlayer = new Map<number, PlayerStatRow[]>();
  for (const row of stats) {
    statsByPlayerMatch.set(`${row.player_id}:${row.match_id}`, row);
    const list = statsByPlayer.get(row.player_id) ?? [];
    list.push(row);
    statsByPlayer.set(row.player_id, list);
  }
  const matchesWithStats = new Set<number>();
  if (matchIds.length) {
    const scored = inChunks(matchIds, (chunk) =>
      database
        .prepare(
          `SELECT DISTINCT match_id AS id FROM fotmob_match_players
           WHERE match_id IN (${chunk.map(() => "?").join(",")})
             AND minutes IS NOT NULL`,
        )
        .all(...chunk),
    ) as Array<{ id: number }>;
    for (const row of scored) matchesWithStats.add(row.id);
  }
  const teamIdByPlayer = new Map<number, number>();
  for (const [playerId, rows] of statsByPlayer) {
    const counts = new Map<number, number>();
    for (const row of rows) {
      if (row.team_id == null) continue;
      counts.set(row.team_id, (counts.get(row.team_id) ?? 0) + 1);
    }
    let best: number | null = null;
    let n = 0;
    for (const [id, count] of counts) {
      if (count > n) {
        best = id;
        n = count;
      }
    }
    if (best != null) teamIdByPlayer.set(playerId, best);
  }

  const tours = [
    ...new Set(
      matches
        .map((match) => parseFotmobTour(match.round))
        .filter((tour): tour is number => tour != null),
    ),
  ].sort((a, b) => a - b);
  const rawEvents = loadEvents(database, matchIds);
  const csEvents = eventsByMatch(rawEvents);
  const subsByMatch = new Map<number, EventRow[]>();
  for (const row of rawEvents) {
    if (row.type !== "Substitution") continue;
    const list = subsByMatch.get(row.match_id);
    if (list) list.push(row);
    else subsByMatch.set(row.match_id, [row]);
  }

  return {
    matches,
    tours,
    statsByPlayerMatch,
    matchesWithStats,
    teamIdByPlayer,
    csEvents,
    subsByMatch,
  };
}

export function computeSeasonPlayerStats(
  player: SeasonPlayerRow,
  bundle: FotmobSeasonBundle,
  options: { subNotes?: boolean } = {},
): SeasonPlayerStats {
  const positions = parseStringArray(player.positions_json).map((pos) => pos.toUpperCase());
  const fotmobId = player.fotmob_player_id;
  const teamId = fotmobId != null ? bundle.teamIdByPlayer.get(fotmobId) ?? null : null;
  const clubMatches = bundle.matches.filter((match) =>
    clubPlayedMatch(match, teamId, player.club_name),
  );
  const minutesByTour: SeasonMinutesCell[] = [];
  const ratings: number[] = [];
  const tsScores: number[] = [];
  const subNotes: SeasonSubNote[] = [];
  const offFor: string[] = [];
  const onFor: string[] = [];
  let starts = 0;
  let subApps = 0;
  let totalMinutes = 0;
  let clubTours = 0;

  const orderedClub = [...clubMatches].sort((a, b) => {
    const ta = parseFotmobTour(a.round) ?? 0;
    const tb = parseFotmobTour(b.round) ?? 0;
    return ta - tb || a.id - b.id;
  });

  for (const tour of bundle.tours) {
    const match = orderedClub.find((row) => parseFotmobTour(row.round) === tour);
    if (!match || fotmobId == null) {
      minutesByTour.push({ tour, minutes: null, starter: null });
      continue;
    }
    const row = bundle.statsByPlayerMatch.get(`${fotmobId}:${match.id}`);
    const hasSheet = bundle.matchesWithStats.has(match.id);
    if (!row) {
      minutesByTour.push({
        tour,
        minutes: hasSheet ? 0 : null,
        starter: hasSheet ? false : null,
      });
      if (hasSheet) clubTours += 1;
      continue;
    }
    const minutes = row.minutes ?? 0;
    const starter = Boolean(row.starter);
    minutesByTour.push({ tour, minutes, starter });
    if (hasSheet) clubTours += 1;
    if (minutes > 0) totalMinutes += minutes;
    if (row && (minutes > 0 || row.rating != null)) {
      if (starter) starts += 1;
      else if (minutes > 0) subApps += 1;
      if (row.rating != null && Number.isFinite(row.rating)) {
        ratings.push(Number(row.rating));
      }
      if (minutes > 0 && positions.length) {
        const statsRow = toStats(row);
        const cs = onPitchCleanSheet({
          phase: match.phase || "finished",
          isHome: playerIsHome(match, row, teamId, player.club_name),
          playerId: fotmobId,
          starter,
          minutes,
          redCards: row.red_cards ?? 0,
          isGk: positions.includes("GK"),
          concededFt: playerIsHome(match, row, teamId, player.club_name)
            ? match.score_away
            : match.score_home,
          events: bundle.csEvents.get(match.id) ?? [],
        });
        const scored = scorePlayer({
          native: positions,
          slotAccepted: [positions[0]!],
          stats: statsRow,
          teamCleanSheet: cs,
        });
        if (scored) tsScores.push(scored.total);
      }
    }

    if (options.subNotes) {
      for (const ev of bundle.subsByMatch.get(match.id) ?? []) {
        const swap = parseSwap(ev.raw_json);
        if (swap.offId === fotmobId && swap.onName) {
          offFor.push(swap.onName);
          const other = reportSurname(swap.onName);
          subNotes.push({
            tour,
            kind: "off",
            otherName: swap.onName,
            label: `T${tour} ↓ ${other}`,
            title: `Т${tour}: заменён на ${swap.onName}`,
          });
        } else if (swap.onId === fotmobId && swap.offName) {
          onFor.push(swap.offName);
          const other = reportSurname(swap.offName);
          subNotes.push({
            tour,
            kind: "on",
            otherName: swap.offName,
            label: `T${tour} ↑ ${other}`,
            title: `Т${tour}: вышел вместо ${swap.offName}`,
          });
        }
      }
    }
  }

  let lastRed = false;
  let missedAfterRed = false;
  if (orderedClub.length) {
    const last = orderedClub[orderedClub.length - 1]!;
    const prev = orderedClub[orderedClub.length - 2];
    const lastStats =
      fotmobId != null ? bundle.statsByPlayerMatch.get(`${fotmobId}:${last.id}`) : undefined;
    const prevStats =
      prev && fotmobId != null
        ? bundle.statsByPlayerMatch.get(`${fotmobId}:${prev.id}`)
        : undefined;
    lastRed = Boolean(prevStats && (prevStats.red_cards ?? 0) > 0);
    missedAfterRed = lastRed && (!lastStats || (lastStats.minutes ?? 0) === 0);
    if (!lastRed && lastStats && (lastStats.red_cards ?? 0) > 0) {
      lastRed = true;
      missedAfterRed = false;
    }
  }

  let lastStreakZero = 0;
  for (let i = minutesByTour.length - 1; i >= 0; i--) {
    const cell = minutesByTour[i];
    if (cell == null || cell.minutes == null) continue;
    if (cell.minutes === 0) lastStreakZero += 1;
    else break;
  }

  const display = fullName(player);
  return {
    mantraPlayerId: player.id,
    displayName: display,
    surname: reportSurname(display, player.name),
    clubCode: deriveClubCode(player.club_code, player.club_name),
    positions,
    position: positions[0] ?? null,
    clubName: player.club_name,
    fotmobPlayerId: fotmobId,
    fotmobTeamId: teamId,
    minutesByTour,
    ratingAvg: mean(ratings),
    mantraTsAvg: mean(tsScores),
    totalMinutes,
    clubTours,
    starts,
    subApps,
    lastStreakZero,
    lastRed,
    missedAfterRed,
    subNotes: subNotes.slice(-4),
    offFor,
    onFor,
  };
}
