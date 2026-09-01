/**
 * Dream Team of the Round — best Mantra XI from all Ekstraklasa players
 * who appeared this tour (FotMob stats + Mantra positions).
 */
import { getDb } from "../db/index.js";
import { getComputed, invalidateComputed } from "../lib/computedCache.js";
import {
  ALL_FORMATIONS,
  FORMATION_SLOTS,
  playerFitsSlot,
  type FormationSlot,
} from "../lib/mantraFormations.js";
import { overlayPenaltiesFromStoredEvents } from "./fotmobPenaltyOverlay.js";
import { loadCleanSheetEventsByMatch } from "./fotmobCleanSheetEvents.js";
import { liveRoundDataVersion } from "./liveMatches.js";
import {
  defenceBonusFromBaseScores,
  fantasyGoalsFromTeamScore,
  scorePlayer,
  type PlayerMatchStats,
  type ScoreBreakdown,
  type ScoreEvent,
} from "../lib/mantraScoring.js";
import { onPitchCleanSheet, type CleanSheetEvent } from "../lib/playerCleanSheet.js";
import {
  liveRoundMetaKey,
  resolveLiveLeague,
} from "../lib/liveLeagues.js";

export type DreamTeamStarter = {
  fotmobPlayerId: number;
  mantraPlayerId: number | null;
  name: string;
  displayName: string;
  clubName: string;
  positions: string[];
  slotLabel: string;
  baseScore: number;
  totalScore: number;
  goals: number;
  events: ScoreEvent[];
  minutes: number | null;
  rating: number | null;
};

export type DreamTeamOfRound = {
  round: string;
  formation: string;
  playersTotal: number;
  defenceBonus: number;
  defenceAvg: number;
  totalScore: number;
  /** Mantra fantasy goals from totalScore (same thresholds as match scoreline). */
  goals: number;
  avgBase: number;
  starters: DreamTeamStarter[];
  poolSize: number;
  matchedCount: number;
};

type FotmobPoolRow = {
  match_id: number;
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

type MantraRow = {
  id: number;
  fotmob_player_id: number | null;
  name: string;
  first_name: string | null;
  full_name: string | null;
  club_name: string | null;
  positions_json: string | null;
};

/** Match stats kept so fillDreamTeamFormation can re-score for the Dream Team slot. */
export type DreamTeamPoolPlayer = {
  fotmobPlayerId: number;
  mantraPlayerId: number | null;
  name: string;
  displayName: string;
  clubName: string;
  positions: string[];
  stats: PlayerMatchStats;
  teamCleanSheet: boolean;
  goals: number;
  minutes: number | null;
  rating: number | null;
};

/** Bump when DT slot scoring changes independently of MANTRA_SCORE_RULES_VERSION. */
const DREAM_TEAM_SCORE_VERSION = "slot-accepted";

const DEFENCE_LABELS = new Set(["CB", "RB", "LB"]);

function parsePositions(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.map((p) => String(p).toUpperCase()).filter(Boolean);
  } catch {
    return [];
  }
}

function loadRound(requested?: string | null, league?: string | null): string | null {
  if (requested != null && requested !== "") return String(requested);
  const def = resolveLiveLeague(league);
  const row = getDb()
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(liveRoundMetaKey(def.slug)) as { value: string } | undefined;
  return row?.value || null;
}

function loadPool(round: string, league?: string | null): FotmobPoolRow[] {
  const def = resolveLiveLeague(league);
  const rows = getDb()
    .prepare(
      `SELECT p.match_id, p.player_id, p.name, p.team_name, p.is_home, p.starter,
              p.rating, p.minutes, p.goals, p.assists, p.yellow_cards, p.red_cards,
              p.own_goals, p.saves, p.goals_conceded,
              p.penalties_won, p.penalties_conceded, p.penalties_scored,
              p.penalties_missed, p.penalties_saved,
              m.phase, m.score_home, m.score_away
       FROM fotmob_match_players p
       JOIN fotmob_matches m ON m.id = p.match_id
       WHERE m.league_id = ?
         AND m.round = ?
         AND m.phase IN ('live', 'finished')
         AND (
           (p.minutes IS NOT NULL AND p.minutes > 0)
           OR p.rating IS NOT NULL
           OR COALESCE(p.goals, 0) > 0
         )`,
    )
    .all(def.fotmobLeagueId, round) as FotmobPoolRow[];
  overlayPenaltiesFromStoredEvents(rows, def.fotmobLeagueId);
  return rows;
}

function loadMantraPlayers(tournamentId: number): MantraRow[] {
  return getDb()
    .prepare(
      `SELECT id, fotmob_player_id, name, first_name, full_name, club_name, positions_json
       FROM mantra_players
       WHERE tournament_id = ? OR (? = 18 AND tournament_id IS NULL)`,
    )
    .all(tournamentId, tournamentId) as MantraRow[];
}

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

function teamCleanSheet(row: FotmobPoolRow, events: CleanSheetEvent[], native: string[]): boolean {
  return onPitchCleanSheet({
    phase: row.phase,
    isHome: Boolean(row.is_home),
    playerId: row.player_id,
    starter: Boolean(row.starter),
    minutes: row.minutes,
    redCards: row.red_cards ?? 0,
    isGk: native.some((p) => p.toUpperCase() === "GK"),
    concededFt: row.is_home ? row.score_away : row.score_home,
    events,
  });
}

function buildScoredPool(rows: FotmobPoolRow[], mantra: MantraRow[]): DreamTeamPoolPlayer[] {
  const eventsByMatch = loadCleanSheetEventsByMatch(rows.map((row) => row.match_id));
  const out: DreamTeamPoolPlayer[] = [];
  const seen = new Set<number>();
  const mantraByFotmobId = new Map(
    mantra
      .filter((player) => player.fotmob_player_id != null)
      .map((player) => [player.fotmob_player_id!, player]),
  );
  for (const row of rows) {
    if (seen.has(row.player_id)) continue;
    seen.add(row.player_id);
    const m = mantraByFotmobId.get(row.player_id) ?? null;
    const positions = parsePositions(m?.positions_json ?? null);
    if (!positions.length) continue;
    const stats = toStats(row);
    const display =
      m?.full_name ||
      [m?.first_name, m?.name].filter(Boolean).join(" ") ||
      row.name;
    out.push({
      fotmobPlayerId: row.player_id,
      mantraPlayerId: m?.id ?? null,
      name: m?.name || row.name,
      displayName: display,
      clubName: m?.club_name || row.team_name,
      positions,
      stats,
      teamCleanSheet: teamCleanSheet(
        row,
        eventsByMatch.get(row.match_id) ?? [],
        positions,
      ),
      goals: row.goals ?? 0,
      minutes: row.minutes,
      rating: row.rating,
    });
  }
  return out;
}

type DreamTeamStarterScored = DreamTeamPoolPlayer & {
  slotLabel: string;
  breakdown: ScoreBreakdown;
};

type Tentative = {
  formation: string;
  starters: DreamTeamStarterScored[];
  playersTotal: number;
  defenceBonus: number;
  defenceAvg: number;
  totalScore: number;
};

/** Score as if occupying this Dream Team slot (CS + malus use slot.accepted). */
export function scoreForDreamTeamSlot(
  p: DreamTeamPoolPlayer,
  slot: FormationSlot,
): ScoreBreakdown | null {
  return scorePlayer({
    native: p.positions,
    slotAccepted: [...slot.accepted],
    stats: p.stats,
    teamCleanSheet: p.teamCleanSheet,
  });
}

export function fillDreamTeamFormation(
  formation: string,
  pool: DreamTeamPoolPlayer[],
): Tentative | null {
  const slots = FORMATION_SLOTS[formation];
  if (!slots?.length) return null;

  const used = new Set<number>();
  const byIndex = new Map<number, DreamTeamStarterScored>();

  const order = slots
    .map((slot, i) => {
      const n = pool.filter((p) => playerFitsSlot(p.positions, slot).native).length;
      return { i, n, slot };
    })
    .sort((a, b) => a.n - b.n || a.i - b.i);

  for (const { i, slot } of order) {
    let best: DreamTeamStarterScored | null = null;
    for (const p of pool) {
      if (used.has(p.fotmobPlayerId)) continue;
      if (!playerFitsSlot(p.positions, slot).native) continue;
      const breakdown = scoreForDreamTeamSlot(p, slot);
      if (!breakdown) continue;
      if (!best || breakdown.total > best.breakdown.total) {
        best = { ...p, slotLabel: slot.label, breakdown };
      }
    }
    if (!best) return null;
    used.add(best.fotmobPlayerId);
    byIndex.set(i, best);
  }

  const starters: DreamTeamStarterScored[] = [];
  for (let i = 0; i < slots.length; i++) {
    const row = byIndex.get(i);
    if (!row) return null;
    starters.push(row);
  }

  const playersTotal = starters.reduce((s, p) => s + p.breakdown.total, 0);
  const defBases = starters
    .filter((p) => DEFENCE_LABELS.has(p.slotLabel))
    .map((p) => p.breakdown.base);
  const { avg, bonus } = defenceBonusFromBaseScores(defBases);
  return {
    formation,
    starters,
    playersTotal: Math.round(playersTotal * 100) / 100,
    defenceBonus: bonus,
    defenceAvg: Math.round(avg * 100) / 100,
    totalScore: Math.round((playersTotal + bonus) * 100) / 100,
  };
}

export function invalidateDreamTeamCache(): void {
  invalidateComputed("dream-team:");
}

function computeDreamTeamUncached(round: string, slug: string): DreamTeamOfRound | null {
  const def = resolveLiveLeague(slug);
  const rows = loadPool(round, def.slug);
  const mantra = loadMantraPlayers(def.mantraTournamentId!);
  const pool = buildScoredPool(rows, mantra);

  let best: Tentative | null = null;
  for (const f of ALL_FORMATIONS) {
    const cand = fillDreamTeamFormation(f, pool);
    if (!cand) continue;
    if (!best || cand.totalScore > best.totalScore) best = cand;
  }

  return best
    ? {
        round,
        formation: best.formation,
        playersTotal: best.playersTotal,
        defenceBonus: best.defenceBonus,
        defenceAvg: best.defenceAvg,
        totalScore: best.totalScore,
        goals: fantasyGoalsFromTeamScore(best.totalScore),
        avgBase:
          Math.round(
            (best.starters.reduce((s, p) => s + p.breakdown.base, 0) / best.starters.length) *
              100,
          ) / 100,
        starters: best.starters.map((p) => ({
          fotmobPlayerId: p.fotmobPlayerId,
          mantraPlayerId: p.mantraPlayerId,
          name: p.name,
          displayName: p.displayName,
          clubName: p.clubName,
          positions: p.positions,
          slotLabel: p.slotLabel,
          baseScore: p.breakdown.base,
          totalScore: p.breakdown.total,
          goals: p.goals,
          events: p.breakdown.events,
          minutes: p.minutes,
          rating: p.rating,
        })),
        poolSize: rows.length,
        matchedCount: pool.length,
      }
    : null;
}

export function computeDreamTeamOfRound(
  requestedRound?: string | null,
  league?: string | null,
  options?: { blockOnMiss?: boolean },
): DreamTeamOfRound | null {
  const def = resolveLiveLeague(league);
  const round = loadRound(requestedRound, def.slug);
  if (!round) return null;
  return (
    getComputed(
      `dream-team:${def.slug}:${round}`,
      `${liveRoundDataVersion(def.slug, round)}|${DREAM_TEAM_SCORE_VERSION}`,
      () => computeDreamTeamUncached(round, def.slug),
      { blockOnMiss: options?.blockOnMiss },
    ).value ?? null
  );
}
