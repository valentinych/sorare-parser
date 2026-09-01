/**
 * League One Mantra BS/TS reports for finished tours.
 * Scores linked players with assigned Mantra positions (primary = first assigned).
 */
import { getDb } from "../db/index.js";
import { onPitchCleanSheet } from "../lib/playerCleanSheet.js";
import {
  scorePlayer,
  type PlayerMatchStats,
  type ScoreEvent,
} from "../lib/mantraScoring.js";
import { overlayPenaltiesFromStoredEvents } from "./fotmobPenaltyOverlay.js";
import { loadCleanSheetEventsByMatch } from "./fotmobCleanSheetEvents.js";
import {
  LEAGUE_ONE_FOTMOB_ID,
  loadLeagueOneMantraPositions,
  loadLeagueOnePlayerMappings,
  readLeagueOneSnapshot,
  type LeagueOneSnapshot,
} from "./leagueOne.js";
import { LEAGUE_ONE_MATCHES_SYNCED_META } from "../sync/syncLeagueOneMatches.js";

function readMeta(key: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export type LeagueOneRoundScore = {
  bs: number;
  ts: number;
  minutes: number | null;
  rating: number | null;
  events: ScoreEvent[];
};

export type LeagueOneReportPlayer = {
  tmPlayerId: string;
  name: string;
  clubId: string;
  clubName: string;
  fotmobPlayerId: number;
  mantraPositions: string[];
  /** First assigned Mantra position — used as scoring slot. */
  primaryPosition: string;
  byRound: Record<string, LeagueOneRoundScore | null>;
};

export type LeagueOneReportsView = {
  ok: boolean;
  syncedAt: string | null;
  fotmobLeagueId: number;
  rounds: string[];
  players: LeagueOneReportPlayer[];
  matchesFinished: number;
  matchesWithStats: number;
  playersWithPositions: number;
};

type FotmobPoolRow = {
  match_id: number;
  round: string;
  player_id: number;
  name: string;
  team_name: string;
  is_home: number;
  starter: number;
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
  phase: string;
  score_home: number | null;
  score_away: number | null;
};

function toStats(row: FotmobPoolRow): PlayerMatchStats {
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
    appeared: true,
  };
}

/** Score as if occupying the primary Mantra slot (native = all assigned). */
export function scoreLeagueOnePlayerRound(opts: {
  mantraPositions: string[];
  stats: PlayerMatchStats;
  teamCleanSheet: boolean;
}): LeagueOneRoundScore | null {
  const positions = opts.mantraPositions.map((p) => p.toUpperCase()).filter(Boolean);
  if (!positions.length) return null;
  const primary = positions[0]!;
  const breakdown = scorePlayer({
    native: positions,
    slotAccepted: [primary],
    stats: opts.stats,
    teamCleanSheet: opts.teamCleanSheet,
  });
  if (!breakdown) return null;
  return {
    bs: Math.round(breakdown.base * 100) / 100,
    ts: Math.round(breakdown.total * 100) / 100,
    minutes: opts.stats.minutes,
    rating: opts.stats.rating,
    events: breakdown.events,
  };
}

function loadFinishedPool(): FotmobPoolRow[] {
  const rows = getDb()
    .prepare(
      `SELECT p.match_id, m.round, p.player_id, p.name, p.team_name, p.is_home, p.starter,
              p.rating, p.minutes, p.goals, p.assists, p.yellow_cards, p.red_cards,
              p.own_goals, p.saves, p.goals_conceded,
              p.penalties_won, p.penalties_conceded, p.penalties_scored,
              p.penalties_missed, p.penalties_saved,
              m.phase, m.score_home, m.score_away
       FROM fotmob_match_players p
       JOIN fotmob_matches m ON m.id = p.match_id
       WHERE m.league_id = ?
         AND m.phase = 'finished'
         AND m.round IS NOT NULL
         AND (
           (p.minutes IS NOT NULL AND p.minutes > 0)
           OR p.rating IS NOT NULL
           OR COALESCE(p.goals, 0) > 0
         )`,
    )
    .all(LEAGUE_ONE_FOTMOB_ID) as FotmobPoolRow[];
  overlayPenaltiesFromStoredEvents(rows, LEAGUE_ONE_FOTMOB_ID);
  return rows;
}

function finishedRoundsFromDb(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT round FROM fotmob_matches
       WHERE league_id = ? AND phase = 'finished' AND round IS NOT NULL
       ORDER BY CAST(round AS INTEGER), round`,
    )
    .all(LEAGUE_ONE_FOTMOB_ID) as Array<{ round: string }>;
  return rows.map((r) => String(r.round));
}

function matchCounts(): { finished: number; withStats: number } {
  const db = getDb();
  const finished = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM fotmob_matches
         WHERE league_id = ? AND phase = 'finished'`,
      )
      .get(LEAGUE_ONE_FOTMOB_ID) as { n: number }
  ).n;
  const withStats = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT m.id) AS n
         FROM fotmob_matches m
         JOIN fotmob_match_players p ON p.match_id = m.id
         WHERE m.league_id = ? AND m.phase = 'finished'
           AND p.minutes IS NOT NULL`,
      )
      .get(LEAGUE_ONE_FOTMOB_ID) as { n: number }
  ).n;
  return { finished, withStats };
}

function resolveLinkedPlayers(
  snapshot: LeagueOneSnapshot | null,
): LeagueOnePlayerRow[] {
  if (!snapshot) return [];
  const mappings = new Map(
    loadLeagueOnePlayerMappings().map((m) => [m.tmPlayerId, m.fotmobPlayerId]),
  );
  const positions = loadLeagueOneMantraPositions();
  return snapshot.players
    .map((p) => {
      const fotmobId = mappings.get(p.tmPlayerId) ?? p.fotmobPlayerId;
      const mantra = positions.get(p.tmPlayerId) ?? p.mantraPositions ?? [];
      return {
        ...p,
        fotmobPlayerId: fotmobId,
        mantraPositions: mantra,
      };
    })
    .filter(
      (p) =>
        p.fotmobPlayerId != null &&
        Number.isFinite(p.fotmobPlayerId) &&
        (p.mantraPositions?.length ?? 0) > 0,
    ) as Array<LeagueOnePlayerRow & { fotmobPlayerId: number; mantraPositions: string[] }>;
}

export async function getLeagueOneReports(): Promise<LeagueOneReportsView> {
  const snapshot = await readLeagueOneSnapshot();
  const linked = resolveLinkedPlayers(snapshot);
  const rounds = finishedRoundsFromDb();
  const pool = loadFinishedPool();
  const eventsByMatch = loadCleanSheetEventsByMatch(pool.map((r) => r.match_id));
  const { finished, withStats } = matchCounts();

  // fotmobPlayerId → rows (one per match appearance; prefer highest minutes if dup)
  const byFotmob = new Map<number, FotmobPoolRow[]>();
  for (const row of pool) {
    const list = byFotmob.get(row.player_id) ?? [];
    list.push(row);
    byFotmob.set(row.player_id, list);
  }

  const players: LeagueOneReportPlayer[] = [];
  for (const p of linked) {
    const fotmobId = p.fotmobPlayerId!;
    const mantraPositions = (p.mantraPositions || []).map((x) => x.toUpperCase());
    if (!mantraPositions.length) continue;
    const primaryPosition = mantraPositions[0]!;
    const appearances = byFotmob.get(fotmobId) ?? [];
    const byRound: Record<string, LeagueOneRoundScore | null> = {};
    for (const round of rounds) byRound[round] = null;

    // Best appearance per round (max minutes, then rating)
    const bestByRound = new Map<string, FotmobPoolRow>();
    for (const row of appearances) {
      const round = String(row.round);
      const prev = bestByRound.get(round);
      if (!prev) {
        bestByRound.set(round, row);
        continue;
      }
      const prevMins = prev.minutes ?? -1;
      const nextMins = row.minutes ?? -1;
      if (nextMins > prevMins) bestByRound.set(round, row);
      else if (nextMins === prevMins && (row.rating ?? 0) > (prev.rating ?? 0)) {
        bestByRound.set(round, row);
      }
    }

    for (const [round, row] of bestByRound) {
      const stats = toStats(row);
      const teamCleanSheet = onPitchCleanSheet({
        phase: row.phase,
        isHome: Boolean(row.is_home),
        playerId: row.player_id,
        starter: Boolean(row.starter),
        minutes: row.minutes,
        redCards: row.red_cards ?? 0,
        isGk: mantraPositions.some((pos) => pos === "GK"),
        concededFt: row.is_home ? row.score_away : row.score_home,
        events: eventsByMatch.get(row.match_id) ?? [],
      });
      byRound[round] = scoreLeagueOnePlayerRound({
        mantraPositions,
        stats,
        teamCleanSheet,
      });
    }

    players.push({
      tmPlayerId: p.tmPlayerId,
      name: p.tmName,
      clubId: p.tmClubId,
      clubName: p.tmClubName,
      fotmobPlayerId: fotmobId,
      mantraPositions,
      primaryPosition,
      byRound,
    });
  }

  players.sort(
    (a, b) =>
      a.clubName.localeCompare(b.clubName) || a.name.localeCompare(b.name),
  );

  return {
    ok: true,
    syncedAt: readMeta(LEAGUE_ONE_MATCHES_SYNCED_META),
    fotmobLeagueId: LEAGUE_ONE_FOTMOB_ID,
    rounds,
    players,
    matchesFinished: finished,
    matchesWithStats: withStats,
    playersWithPositions: players.length,
  };
}
