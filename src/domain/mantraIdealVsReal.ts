/**
 * Ideal XI vs Real XI for each Mantra fantasy team in the live tour.
 * Ideal: best Mantra-legal formation (native + OoP with malus) from the
 * manager's ~26-player squad, scored like live / Dream Team, ranked by
 * playersTotal + defenceBonus (CB/RB/LB bases). Assignment is max-weight
 * bitmask DP over a trimmed candidate pool (≤22).
 *
 * Prefer a legal 11. If that is impossible (no GK, or one field slot empty),
 * still pick the best 10 placeable players — empty slot contributes 0, not a
 * failed pick. Live % = Real / Ideal on the slots Ideal filled that tour.
 *
 * Finished-tour season Ideal (tables): pick from that GW's locked XI + bench,
 * not today's transfer-shrunken roster. Per tour Ideal = max(picked, Real XI)
 * so a hole never scores below the posted XI. Tables % is Mantra TS / Ideal TS.
 */
import { getDb } from "../db/index.js";
import {
  ALL_FORMATIONS,
  FORMATION_SLOTS,
  type FormationSlot,
} from "../lib/mantraFormations.js";
import {
  defenceBonusFromBaseScores,
  positionMalus,
  scorePlayer,
  type PlayerMatchStats,
  type ScoreBreakdown,
  type ScoreEvent,
} from "../lib/mantraScoring.js";
import { onPitchCleanSheet, type CleanSheetEvent } from "../lib/playerCleanSheet.js";
import type { MantraMatchSide } from "../clients/mantraAuth.js";
import { getMantraToursForRound } from "../sync/syncMantraTours.js";
import { loadMantraLineups } from "../sync/syncMantraLineups.js";
import type Database from "better-sqlite3";
import { getComputed, invalidateComputed } from "../lib/computedCache.js";
import { overlayPenaltiesFromStoredEvents } from "./fotmobPenaltyOverlay.js";
import { loadCleanSheetEventsByMatch } from "./fotmobCleanSheetEvents.js";
import {
  computeMantraMatchMap,
  type ComputedPlayerScore,
  type ComputedSide,
} from "./mantraLiveScore.js";
import {
  isTablesExtraSlug,
  liveLeagueBySlug,
  liveRoundMetaKey,
  resolveLiveLeague,
} from "../lib/liveLeagues.js";
import { liveRoundDataVersion } from "./liveMatches.js";
import { loadMantraGwPlayerScores } from "./mantraGwScores.js";
import { peekRoundScoresByTeam } from "./mantraStandings.js";

export type IdealVsRealPlayer = {
  mantraPlayerId: number | null;
  fotmobPlayerId: number | null;
  name: string;
  displayName: string;
  clubName: string;
  positions: string[];
  slotLabel: string;
  baseScore: number;
  totalScore: number;
  events: ScoreEvent[];
  minutes: number | null;
  rating: number | null;
  /** Real XI only: smart-sub markers. */
  substitutedOut?: boolean;
  substitutedIn?: boolean;
  coversSlot?: string | null;
  appeared?: boolean;
};

export type IdealVsRealRow = {
  teamId: number;
  teamName: string;
  divisionLabel: string;
  tourId: number | null;
  matchId: number | null;
  formation: string | null;
  idealTotal: number;
  idealPlayersTotal: number;
  idealDefenceBonus: number;
  realTotal: number;
  /** Unaligned Real XI total (full 11), used to floor season Ideal per tour. */
  realXiTotal: number;
  realPlayersTotal: number;
  realDefenceBonus: number;
  realDefenceBonusReady: boolean;
  /**
   * realTotal / idealTotal * 100; null if ideal is 0.
   * realTotal is aligned to Ideal's filled slots when Ideal has 10 players.
   */
  idealPct: number | null;
  squadSize: number;
  scoredPoolSize: number;
  idealXi: IdealVsRealPlayer[];
  realXi: IdealVsRealPlayer[];
  realModule: string | null;
};

export type IdealVsRealStandings = {
  round: string;
  rows: IdealVsRealRow[];
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

type MantraPlayerRow = {
  id: number;
  fotmob_player_id: number | null;
  name: string;
  first_name: string | null;
  full_name: string | null;
  club_name: string | null;
  positions_json: string | null;
};

export type ScoredSquadPlayer = {
  mantraPlayerId: number;
  fotmobPlayerId: number | null;
  name: string;
  displayName: string;
  clubName: string;
  positions: string[];
  /** Match stats for slot-aware re-scoring (CS depends on assigned slot). */
  stats: PlayerMatchStats | null;
  teamCleanSheet: boolean;
  minutes: number | null;
  rating: number | null;
  /** Extra-league posted Mantra GW total (already includes bonuses). */
  mantraGwTotal?: number | null;
  /** Extra-league Mantra base rating for defence bonus. */
  mantraGwBase?: number | null;
};

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

function parseIdArray(raw: string | null): number[] {
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as unknown[])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n));
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

function loadFotmobPool(round: string, league?: string | null): FotmobPoolRow[] {
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

function loadMantraPlayersByIds(ids: number[]): Map<number, MantraPlayerRow> {
  const map = new Map<number, MantraPlayerRow>();
  if (!ids.length) return map;
  const uniq = [...new Set(ids)];
  const placeholders = uniq.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT id, fotmob_player_id, name, first_name, full_name, club_name, positions_json
       FROM mantra_players
       WHERE id IN (${placeholders})`,
    )
    .all(...uniq) as MantraPlayerRow[];
  for (const r of rows) map.set(r.id, r);
  return map;
}

function loadFantasySquadIds(teamId: number): number[] {
  const row = getDb()
    .prepare(`SELECT players_json FROM mantra_fantasy_teams WHERE id = ?`)
    .get(teamId) as { players_json: string } | undefined;
  return parseIdArray(row?.players_json ?? null);
}

/** Locked GW pool: starting XI + bench. Ignores not-in-squad and today's roster. */
export function lockedTourSquadIds(side: {
  lineup?: Array<{ playerId?: number | null }>;
  squad?: Array<{ playerId?: number | null }>;
  substitutes?: Array<{ playerId?: number | null }>;
}): number[] {
  const ids = new Set<number>();
  for (const p of [...(side.squad ?? []), ...(side.substitutes ?? []), ...(side.lineup ?? [])]) {
    const id = Number(p.playerId);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

/** Finished tours use the locked XI+bench; live / missing archive keep the current roster. */
export function resolveTourSquadIds(
  currentSquadIds: number[],
  lockedIds: number[] | null | undefined,
  useLockedSquad: boolean,
): number[] {
  if (useLockedSquad && lockedIds && lockedIds.length) return lockedIds;
  return currentSquadIds;
}

function collectLockedSquads(round: string, slug: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const file = loadMantraLineups(round, slug);
  if (!file || file.round == null || String(file.round) !== String(round)) return out;
  for (const match of Object.values(file.matches)) {
    for (const side of [match.home, match.away] as MantraMatchSide[]) {
      if (side.teamId == null) continue;
      const ids = lockedTourSquadIds(side);
      if (ids.length) out.set(side.teamId, ids);
    }
  }
  return out;
}

function loadSquadsForTeams(
  teamIds: Iterable<number>,
  round: string,
  slug: string,
  useLockedSquad: boolean,
): Map<number, number[]> {
  const locked = useLockedSquad ? collectLockedSquads(round, slug) : null;
  const squadByTeam = new Map<number, number[]>();
  for (const teamId of teamIds) {
    squadByTeam.set(
      teamId,
      resolveTourSquadIds(
        loadFantasySquadIds(teamId),
        locked?.get(teamId),
        useLockedSquad,
      ),
    );
  }
  return squadByTeam;
}

/** Per-tour Ideal cannot be below the posted Real XI (10-man hole vs 11-man actual). */
export function floorIdealAtActual(pickedIdeal: number, actualXi: number): number {
  const a = Number.isFinite(pickedIdeal) ? pickedIdeal : 0;
  const b = Number.isFinite(actualXi) ? actualXi : 0;
  return Math.round(Math.max(a, b) * 100) / 100;
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

function teamCleanSheet(
  row: FotmobPoolRow,
  events: CleanSheetEvent[],
  native: string[],
): boolean {
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

/** FotMob rows keyed for matching: by normalized name+club, and by name alone. */
function buildFotmobIndex(rows: FotmobPoolRow[]): {
  byId: Map<number, FotmobPoolRow>;
  list: FotmobPoolRow[];
} {
  const byId = new Map<number, FotmobPoolRow>();
  for (const row of rows) {
    if (!byId.has(row.player_id)) byId.set(row.player_id, row);
  }
  return { byId, list: [...byId.values()] };
}

function zeroBreakdown(): ScoreBreakdown {
  return {
    base: 0,
    bonuses: 0,
    maluses: 0,
    positionMalus: 0,
    total: 0,
    parts: [],
    events: [],
  };
}

function scoreSquadPlayer(
  mantra: MantraPlayerRow,
  fotmob: FotmobPoolRow | null,
  events: CleanSheetEvent[],
  gw?: { total: number; base: number | null } | null,
  extra = false,
): ScoredSquadPlayer | null {
  const positions = parsePositions(mantra.positions_json);
  if (!positions.length) return null;
  const display =
    mantra.full_name ||
    [mantra.first_name, mantra.name].filter(Boolean).join(" ") ||
    mantra.name;
  if (extra) {
    const total = gw != null && Number.isFinite(gw.total) && gw.total > 0 ? gw.total : null;
    return {
      mantraPlayerId: mantra.id,
      fotmobPlayerId: fotmob?.player_id ?? mantra.fotmob_player_id ?? null,
      name: mantra.name,
      displayName: display,
      clubName: mantra.club_name || fotmob?.team_name || "",
      positions,
      stats: null,
      teamCleanSheet: false,
      minutes: total != null ? 90 : null,
      rating: total,
      mantraGwTotal: total,
      mantraGwBase: total != null ? gw?.base ?? total : null,
    };
  }
  if (!fotmob) {
    return {
      mantraPlayerId: mantra.id,
      fotmobPlayerId: null,
      name: mantra.name,
      displayName: display,
      clubName: mantra.club_name || "",
      positions,
      stats: null,
      teamCleanSheet: false,
      minutes: null,
      rating: null,
    };
  }
  return {
    mantraPlayerId: mantra.id,
    fotmobPlayerId: fotmob.player_id,
    name: mantra.name,
    displayName: display,
    clubName: mantra.club_name || fotmob.team_name,
    positions,
    stats: toStats(fotmob),
    teamCleanSheet: teamCleanSheet(fotmob, events, positions),
    minutes: fotmob.minutes,
    rating: fotmob.rating,
  };
}

/** Mantra-legal slot (native or OoP). Uses scoring malus table, not POSITION_COMPAT. */
function slotLegal(positions: string[], slot: FormationSlot): boolean {
  return positionMalus(positions, [...slot.accepted]) != null;
}

function slotNative(positions: string[], slot: FormationSlot): boolean {
  return slot.accepted.some((a) => positions.includes(a));
}

/** Posted Mantra GW total is already complete — do not re-apply FotMob events. */
export function breakdownFromMantraGwTotal(
  total: number,
  base?: number | null,
): ScoreBreakdown {
  const n = Number.isFinite(total) ? total : 0;
  const b = base != null && Number.isFinite(base) ? base : n;
  return {
    base: b,
    bonuses: 0,
    maluses: 0,
    positionMalus: 0,
    total: n,
    parts: [`mantra ${n.toFixed(2)}`],
    events: [],
  };
}

/** Score as if playing the formation slot — CS uses slot.accepted; OoP via positionMalus. */
function scoreForSlot(p: ScoredSquadPlayer, slot: FormationSlot): ScoreBreakdown {
  if (!slotLegal(p.positions, slot)) return zeroBreakdown();
  if (p.mantraGwTotal != null && Number.isFinite(p.mantraGwTotal) && p.mantraGwTotal > 0) {
    return breakdownFromMantraGwTotal(p.mantraGwTotal, p.mantraGwBase);
  }
  if (!p.stats) return zeroBreakdown();
  return (
    scorePlayer({
      native: p.positions,
      slotAccepted: [...slot.accepted],
      stats: p.stats,
      teamCleanSheet: p.teamCleanSheet,
    }) ?? zeroBreakdown()
  );
}

type IdealStarter = ScoredSquadPlayer & {
  slotLabel: string;
  breakdown: ScoreBreakdown;
};

export type Tentative = {
  formation: string;
  starters: IdealStarter[];
  playersTotal: number;
  defenceBonus: number;
  totalScore: number;
};

/** Bitmask DP pool cap — sparse DP over ≤18 candidates is fast for all teams. */
const IDEAL_DP_MAX_POOL = 18;

/**
 * Max-weight assignment of pool → formation slots (Mantra-legal incl. OoP).
 * Trims to IDEAL_DP_MAX_POOL by slot coverage + max slot TS, then sparse DP.
 * `slots` may be a formation minus one empty slot (10-player Ideal).
 */
function assignSlots(
  formation: string,
  slots: readonly FormationSlot[],
  pool: ScoredSquadPlayer[],
): Tentative | null {
  if (!slots?.length) return null;

  const ranked = pool
    .map((p) => {
      let max = -Infinity;
      for (const slot of slots) {
        if (!slotLegal(p.positions, slot)) continue;
        max = Math.max(max, scoreForSlot(p, slot).total);
      }
      return { p, max };
    })
    .filter((x) => Number.isFinite(x.max))
    .sort((a, b) => b.max - a.max || a.p.mantraPlayerId - b.p.mantraPlayerId);

  if (ranked.length < slots.length) return null;

  const kept: ScoredSquadPlayer[] = [];
  const keptIds = new Set<number>();
  const push = (p: ScoredSquadPlayer) => {
    if (kept.length >= IDEAL_DP_MAX_POOL || keptIds.has(p.mantraPlayerId)) return;
    kept.push(p);
    keptIds.add(p.mantraPlayerId);
  };
  // Force top covers for each slot so rare positions survive the trim.
  for (const slot of slots) {
    const fits = ranked.filter((x) => slotLegal(x.p.positions, slot)).slice(0, 2);
    for (const x of fits) push(x.p);
  }
  for (const x of ranked) push(x.p);
  if (kept.length < slots.length) return null;

  const N = kept.length;
  const S = slots.length;
  const M = 1 << N;
  const NEG = -1e100;
  const contrib: Float64Array[] = slots.map((slot) => {
    const arr = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const p = kept[i]!;
      if (!slotLegal(p.positions, slot)) {
        arr[i] = -Infinity;
        continue;
      }
      const bd = scoreForSlot(p, slot);
      const nativeBoost = slotNative(p.positions, slot) ? 1e-4 : 0;
      arr[i] = bd.total + nativeBoost + bd.base * 1e-6;
    }
    return arr;
  });

  // Sparse DP: only expand reached masks (popcount == slot index).
  const dp = new Float64Array((S + 1) * M).fill(NEG);
  const parent = new Int16Array((S + 1) * M).fill(-1);
  const seen = new Uint8Array((S + 1) * M);
  dp[0] = 0;
  seen[0] = 1;
  for (let s = 0; s < S; s++) {
    const rowBase = s * M;
    const nextBase = (s + 1) * M;
    const contribS = contrib[s]!;
    for (let mask = 0; mask < M; mask++) {
      if (!seen[rowBase + mask]) continue;
      const base = dp[rowBase + mask]!;
      for (let pi = 0; pi < N; pi++) {
        const c = contribS[pi]!;
        if (!Number.isFinite(c)) continue;
        const bit = 1 << pi;
        if (mask & bit) continue;
        const nm = mask | bit;
        const cand = base + c;
        const idx = nextBase + nm;
        if (!seen[idx] || cand > dp[idx]!) {
          seen[idx] = 1;
          dp[idx] = cand;
          parent[idx] = pi;
        }
      }
    }
  }

  let bestMask = -1;
  let bestVal = NEG;
  const finalBase = S * M;
  for (let mask = 0; mask < M; mask++) {
    if (!seen[finalBase + mask]) continue;
    const v = dp[finalBase + mask]!;
    if (v > bestVal) {
      bestVal = v;
      bestMask = mask;
    }
  }
  if (bestMask < 0) return null;

  const starterIdx = new Array<number>(S);
  let mask = bestMask;
  for (let s = S; s > 0; s--) {
    const pi = parent[s * M + mask]!;
    starterIdx[s - 1] = pi;
    mask ^= 1 << pi;
  }

  const starters: IdealStarter[] = starterIdx.map((pi, si) => {
    const p = kept[pi]!;
    const slot = slots[si]!;
    return { ...p, slotLabel: slot.label, breakdown: scoreForSlot(p, slot) };
  });

  // Local 1-swap polish over full pool (DP may miss players outside the trim).
  improveBySwaps(starters, slots, pool);

  const playersTotal = starters.reduce((s, p) => s + p.breakdown.total, 0);
  const defBases = starters
    .filter((p) => DEFENCE_LABELS.has(p.slotLabel))
    .map((p) => p.breakdown.base);
  const { bonus } = defenceBonusFromBaseScores(defBases);
  return {
    formation,
    starters,
    playersTotal: Math.round(playersTotal * 100) / 100,
    defenceBonus: bonus,
    totalScore: Math.round((playersTotal + bonus) * 100) / 100,
  };
}

/** Greedy 1-swap (+ light 2-swap) including defence bonus in the objective. */
function improveBySwaps(
  starters: IdealStarter[],
  slots: readonly FormationSlot[],
  pool: ScoredSquadPlayer[],
): void {
  const used = new Set(starters.map((p) => p.mantraPlayerId));

  const lineupScore = (): number => {
    let playersTotal = 0;
    const defBases: number[] = [];
    for (let i = 0; i < starters.length; i++) {
      const st = starters[i]!;
      playersTotal += st.breakdown.total;
      if (DEFENCE_LABELS.has(st.slotLabel)) defBases.push(st.breakdown.base);
    }
    return playersTotal + defenceBonusFromBaseScores(defBases).bonus;
  };

  for (let iter = 0; iter < 6; iter++) {
    let improved = false;
    const baseline = lineupScore();
    for (let si = 0; si < starters.length; si++) {
      const slot = slots[si]!;
      const old = starters[si]!;
      let best: IdealStarter | null = null;
      let bestScore = baseline;
      for (const p of pool) {
        if (p.mantraPlayerId === old.mantraPlayerId) continue;
        if (used.has(p.mantraPlayerId)) continue;
        if (!slotLegal(p.positions, slot)) continue;
        const breakdown = scoreForSlot(p, slot);
        starters[si] = { ...p, slotLabel: slot.label, breakdown };
        const trial = lineupScore();
        starters[si] = old;
        if (
          trial > bestScore + 1e-9 ||
          (Math.abs(trial - bestScore) < 1e-9 &&
            breakdown.total === old.breakdown.total &&
            slotNative(p.positions, slot) &&
            !slotNative(old.positions, slot))
        ) {
          bestScore = trial;
          best = { ...p, slotLabel: slot.label, breakdown };
        }
      }
      if (best && bestScore > baseline + 1e-9) {
        used.delete(old.mantraPlayerId);
        used.add(best.mantraPlayerId);
        starters[si] = best;
        improved = true;
      }
    }
    if (!improved) break;
  }
}

function fillFormation(formation: string, pool: ScoredSquadPlayer[]): Tentative | null {
  const slots = FORMATION_SLOTS[formation];
  if (!slots?.length) return null;
  return assignSlots(formation, slots, pool);
}

/** Best assignment that leaves exactly one slot empty. Empty slot = 0, not a fail. */
function fillFormationAllowOneEmpty(
  formation: string,
  pool: ScoredSquadPlayer[],
): Tentative | null {
  const slots = FORMATION_SLOTS[formation];
  if (!slots?.length) return null;
  const uncovered: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    if (!pool.some((p) => slotLegal(p.positions, slots[i]!))) uncovered.push(i);
  }
  // Two+ empty slots cannot be saved by skipping one.
  if (uncovered.length > 1) return null;
  const skipIndices = uncovered.length === 1 ? uncovered : slots.map((_, i) => i);
  let best: Tentative | null = null;
  for (const skip of skipIndices) {
    const reduced = slots.filter((_, i) => i !== skip);
    const cand = assignSlots(formation, reduced, pool);
    if (!cand) continue;
    if (!best || cand.totalScore > best.totalScore) best = cand;
  }
  return best;
}

/**
 * Best legal XI. Prefer a full 11; if none exists, best 10 (one missing slot).
 * No GK → 10 outfield. GK + one field hole → 1 GK + 9 field.
 * 10-player search runs only when every formation fails a legal 11.
 */
export function pickIdeal(pool: ScoredSquadPlayer[]): Tentative | null {
  let best11: Tentative | null = null;
  for (const f of ALL_FORMATIONS) {
    const full = fillFormation(f, pool);
    if (full && (!best11 || full.totalScore > best11.totalScore)) best11 = full;
  }
  if (best11) return best11;
  let best10: Tentative | null = null;
  for (const f of ALL_FORMATIONS) {
    const partial = fillFormationAllowOneEmpty(f, pool);
    if (partial && (!best10 || partial.totalScore > best10.totalScore)) best10 = partial;
  }
  return best10;
}

function toIdealPlayer(p: IdealStarter): IdealVsRealPlayer {
  return {
    mantraPlayerId: p.mantraPlayerId,
    fotmobPlayerId: p.fotmobPlayerId,
    name: p.name,
    displayName: p.displayName,
    clubName: p.clubName,
    positions: p.positions,
    slotLabel: p.slotLabel,
    baseScore: p.breakdown.base,
    totalScore: p.breakdown.total,
    events: p.breakdown.events,
    minutes: p.minutes,
    rating: p.rating,
  };
}

function toRealPlayer(p: ComputedPlayerScore): IdealVsRealPlayer {
  return {
    mantraPlayerId: p.playerId,
    fotmobPlayerId: p.fotmobPlayerId,
    name: p.name,
    displayName: p.name,
    clubName: p.clubName || "",
    positions: p.native,
    slotLabel: p.coversSlot || p.slotLabel,
    baseScore: p.breakdown?.base ?? 0,
    totalScore: p.breakdown?.total ?? 0,
    events: p.breakdown?.events ?? [],
    minutes: null,
    rating: null,
    substitutedOut: p.substitutedOut,
    substitutedIn: p.substitutedIn,
    coversSlot: p.coversSlot,
    appeared: p.appeared,
  };
}

/** Real XI for dialog: locked slots, with smart-sub cover replacing DNP when present. */
function buildRealXi(side: ComputedSide): IdealVsRealPlayer[] {
  const out: IdealVsRealPlayer[] = [];
  for (const p of side.players) {
    if (p.substitutedOut) {
      const sub = side.bench.find(
        (b) => b.substitutedIn && b.coversSlot === p.slotLabel,
      );
      if (sub) {
        out.push({
          ...toRealPlayer(sub),
          slotLabel: p.slotLabel,
          substitutedIn: true,
          coversSlot: p.slotLabel,
        });
        continue;
      }
    }
    out.push(toRealPlayer(p));
  }
  return out;
}

function findRealSide(
  teamId: number,
  computed: Record<string, { matchId: number; home: ComputedSide; away: ComputedSide }>,
): { matchId: number; side: ComputedSide } | null {
  for (const m of Object.values(computed)) {
    if (m.home.teamId === teamId) return { matchId: m.matchId, side: m.home };
    if (m.away.teamId === teamId) return { matchId: m.matchId, side: m.away };
  }
  return null;
}

function missingSlotLabels(formation: string, filledLabels: string[]): string[] {
  const slots = FORMATION_SLOTS[formation];
  if (!slots?.length) return [];
  const remaining = filledLabels.slice();
  const missing: string[] = [];
  for (const slot of slots) {
    const idx = remaining.indexOf(slot.label);
    if (idx >= 0) remaining.splice(idx, 1);
    else missing.push(slot.label);
  }
  return missing;
}

/**
 * % uses Real scores on the slots Ideal actually filled.
 * A 10-man Ideal drops the empty slot from Real (not 11-man Real / 10-man Ideal).
 * Missing slot labels are excluded from Real by multiplicity; leftover extras
 * are dropped from the end of Real XI until counts match.
 */
export function alignRealToIdealSlots(
  ideal: { formation: string; starters: Array<{ slotLabel: string }> } | null,
  realXi: Array<Pick<IdealVsRealPlayer, "slotLabel" | "totalScore" | "baseScore">>,
  fallback: { total: number; playersTotal: number; defenceBonus: number },
): { total: number; playersTotal: number; defenceBonus: number } {
  const nIdeal = ideal?.starters.length ?? 0;
  if (!ideal || nIdeal >= 11 || nIdeal === 0) return fallback;

  const skip = new Set<number>();
  for (const label of missingSlotLabels(
    ideal.formation,
    ideal.starters.map((p) => p.slotLabel),
  )) {
    const idx = realXi.findIndex((p, i) => !skip.has(i) && p.slotLabel === label);
    if (idx >= 0) skip.add(idx);
  }
  for (let i = realXi.length - 1; i >= 0 && realXi.length - skip.size > nIdeal; i--) {
    if (!skip.has(i)) skip.add(i);
  }
  const matched = realXi.filter((_, i) => !skip.has(i));
  const playersTotal = matched.reduce((s, p) => s + p.totalScore, 0);
  const defBases = matched
    .filter((p) => DEFENCE_LABELS.has(p.slotLabel))
    .map((p) => p.baseScore);
  const { bonus } = defenceBonusFromBaseScores(defBases);
  return {
    playersTotal: Math.round(playersTotal * 100) / 100,
    defenceBonus: bonus,
    total: Math.round((playersTotal + bonus) * 100) / 100,
  };
}

export const SEASON_IDEAL_CACHE_PREFIX = "season-ideal-finished:p15-gw:";

function idealVsRealCacheKey(slug: string, round: string, useLockedSquad: boolean): string {
  return `ideal-vs-real:${slug}:${round}:${useLockedSquad ? "p12-gw" : "p10"}`;
}

function idealVsRealCacheVersion(slug: string, round: string): string {
  return liveRoundDataVersion(slug, round);
}

export function invalidateIdealVsRealCache(): void {
  invalidateComputed("ideal-vs-real:");
}

export function computeIdealVsRealStandings(
  requestedRound?: string | null,
  league?: string | null,
  options?: { serveStale?: boolean; blockOnMiss?: boolean; useLockedSquad?: boolean },
): IdealVsRealStandings | null {
  const def = resolveLiveLeague(league);
  const round = loadRound(requestedRound, def.slug);
  if (!round) return null;
  const blockOnMiss = options?.blockOnMiss;
  const useLockedSquad = Boolean(options?.useLockedSquad);
  return (
    getComputed(
      idealVsRealCacheKey(def.slug, round, useLockedSquad),
      idealVsRealCacheVersion(def.slug, round),
      () =>
        blockOnMiss === false
          ? computeIdealVsRealStandingsUncachedAsync(round, def.slug, useLockedSquad)
          : computeIdealVsRealStandingsUncached(round, def.slug, useLockedSquad),
      { serveStale: options?.serveStale, blockOnMiss },
    ).value ?? null
  );
}

function extraLeagueContext(
  slug: string,
  round: string,
): {
  extra: boolean;
  gwScores: Map<number, { total: number; base: number | null }>;
  officialTs: Map<number, number>;
} {
  const extra = isTablesExtraSlug(slug);
  if (!extra) {
    return { extra: false, gwScores: new Map(), officialTs: new Map() };
  }
  const gwScores = new Map<number, { total: number; base: number | null }>();
  for (const row of loadMantraGwPlayerScores(slug, round).values()) {
    gwScores.set(row.playerId, { total: row.total, base: row.base });
  }
  const officialTs = new Map<number, number>();
  try {
    for (const [id, byRound] of peekRoundScoresByTeam(slug)) {
      const hit = byRound.get(Number(round));
      if (hit && Number.isFinite(hit.ts) && hit.ts > 0) officialTs.set(id, hit.ts);
    }
  } catch {
    /* standings snapshot missing in unit tests */
  }
  return { extra, gwScores, officialTs };
}

function computeIdealVsRealStandingsUncached(
  round: string,
  slug: string,
  useLockedSquad = false,
): IdealVsRealStandings | null {
  const tours = getMantraToursForRound(round, slug).tours;
  if (!tours.length) return null;

  const fotmobRows = loadFotmobPool(round, slug);
  const eventsByMatch = loadCleanSheetEventsByMatch(fotmobRows.map((row) => row.match_id));
  const { byId: fotmobById } = buildFotmobIndex(fotmobRows);
  const computed = computeMantraMatchMap(round, slug);
  const extraCtx = extraLeagueContext(slug, round);

  type TeamRef = {
    teamId: number;
    teamName: string;
    divisionLabel: string;
    tourId: number | null;
  };
  const teams = new Map<number, TeamRef>();
  for (const t of tours) {
    for (const m of t.matches) {
      for (const side of [m.home, m.away]) {
        if (side.teamId == null) continue;
        if (teams.has(side.teamId)) continue;
        teams.set(side.teamId, {
          teamId: side.teamId,
          teamName: side.teamName,
          divisionLabel: t.label,
          tourId: t.tourId,
        });
      }
    }
  }

  const squadByTeam = loadSquadsForTeams(teams.keys(), round, slug, useLockedSquad);
  const allSquadIds = new Set<number>();
  for (const ids of squadByTeam.values()) {
    for (const id of ids) allSquadIds.add(id);
  }
  const mantraById = loadMantraPlayersByIds([...allSquadIds]);

  const rows: IdealVsRealRow[] = [];
  for (const ref of teams.values()) {
    rows.push(
      buildIdealVsRealRow(
        ref,
        squadByTeam,
        mantraById,
        fotmobById,
        eventsByMatch,
        computed,
        extraCtx,
      ),
    );
  }

  rows.sort(
    (a, b) =>
      a.divisionLabel.localeCompare(b.divisionLabel) ||
      (b.idealPct ?? -1) - (a.idealPct ?? -1) ||
      b.idealTotal - a.idealTotal ||
      a.teamName.localeCompare(b.teamName),
  );

  return { round, rows };
}

/** Background rebuild — yield so Live Mantra poll abort timers can fire. */
async function computeIdealVsRealStandingsUncachedAsync(
  round: string,
  slug: string,
  useLockedSquad = false,
): Promise<IdealVsRealStandings | null> {
  const tours = getMantraToursForRound(round, slug).tours;
  if (!tours.length) return null;

  const fotmobRows = loadFotmobPool(round, slug);
  const eventsByMatch = loadCleanSheetEventsByMatch(fotmobRows.map((row) => row.match_id));
  const { byId: fotmobById } = buildFotmobIndex(fotmobRows);
  const computed = computeMantraMatchMap(round, slug);
  const extraCtx = extraLeagueContext(slug, round);

  type TeamRef = {
    teamId: number;
    teamName: string;
    divisionLabel: string;
    tourId: number | null;
  };
  const teams = new Map<number, TeamRef>();
  for (const t of tours) {
    for (const m of t.matches) {
      for (const side of [m.home, m.away]) {
        if (side.teamId == null) continue;
        if (teams.has(side.teamId)) continue;
        teams.set(side.teamId, {
          teamId: side.teamId,
          teamName: side.teamName,
          divisionLabel: t.label,
          tourId: t.tourId,
        });
      }
    }
  }

  const squadByTeam = loadSquadsForTeams(teams.keys(), round, slug, useLockedSquad);
  const allSquadIds = new Set<number>();
  for (const ids of squadByTeam.values()) {
    for (const id of ids) allSquadIds.add(id);
  }
  const mantraById = loadMantraPlayersByIds([...allSquadIds]);

  const rows: IdealVsRealRow[] = [];
  let n = 0;
  for (const ref of teams.values()) {
    rows.push(
      buildIdealVsRealRow(
        ref,
        squadByTeam,
        mantraById,
        fotmobById,
        eventsByMatch,
        computed,
        extraCtx,
      ),
    );
    if (++n % 4 === 0) await new Promise<void>((r) => setImmediate(r));
  }

  rows.sort(
    (a, b) =>
      a.divisionLabel.localeCompare(b.divisionLabel) ||
      (b.idealPct ?? -1) - (a.idealPct ?? -1) ||
      b.idealTotal - a.idealTotal ||
      a.teamName.localeCompare(b.teamName),
  );

  return { round, rows };
}

function buildIdealVsRealRow(
  ref: {
    teamId: number;
    teamName: string;
    divisionLabel: string;
    tourId: number | null;
  },
  squadByTeam: Map<number, number[]>,
  mantraById: ReturnType<typeof loadMantraPlayersByIds>,
  fotmobById: Map<number, FotmobPoolRow>,
  eventsByMatch: Map<number, CleanSheetEvent[]>,
  computed: ReturnType<typeof computeMantraMatchMap>,
  extraCtx: ReturnType<typeof extraLeagueContext>,
): IdealVsRealRow {
  const squadIds = squadByTeam.get(ref.teamId) ?? [];
  const pool: ScoredSquadPlayer[] = [];
  for (const id of squadIds) {
    const mantra = mantraById.get(id);
    if (!mantra) continue;
    const fotmob =
      mantra.fotmob_player_id != null
        ? fotmobById.get(mantra.fotmob_player_id) ?? null
        : null;
    const scored = scoreSquadPlayer(
      mantra,
      fotmob,
      fotmob ? (eventsByMatch.get(fotmob.match_id) ?? []) : [],
      extraCtx.gwScores.get(id) ?? null,
      extraCtx.extra,
    );
    if (scored) pool.push(scored);
  }

  const ideal = pickIdeal(pool);
  const realHit = findRealSide(ref.teamId, computed);
  const realSide = realHit?.side ?? null;
  const realXi = realSide ? buildRealXi(realSide) : [];
  const aligned = alignRealToIdealSlots(ideal, realXi, {
    total: realSide?.total ?? 0,
    playersTotal: realSide?.playersTotal ?? 0,
    defenceBonus: realSide?.defenceBonus ?? 0,
  });
  const official = extraCtx.officialTs.get(ref.teamId) ?? 0;
  const actualXi = Math.max(realSide?.total ?? 0, official);
  const picked = ideal?.totalScore ?? 0;
  const idealTotal = floorIdealAtActual(picked, actualXi);
  const realTotal = aligned.total;
  const idealPct =
    idealTotal > 0 ? Math.round((realTotal / idealTotal) * 1000) / 10 : null;

  return {
    teamId: ref.teamId,
    teamName: ref.teamName,
    divisionLabel: ref.divisionLabel,
    tourId: ref.tourId,
    matchId: realHit?.matchId ?? null,
    formation: ideal?.formation ?? null,
    idealTotal,
    idealPlayersTotal: ideal?.playersTotal ?? 0,
    idealDefenceBonus: ideal?.defenceBonus ?? 0,
    realTotal,
    realXiTotal: actualXi,
    realPlayersTotal: aligned.playersTotal,
    realDefenceBonus: aligned.defenceBonus,
    realDefenceBonusReady: realSide?.defenceBonusReady ?? false,
    idealPct,
    squadSize: squadIds.length,
    scoredPoolSize: pool.filter(
      (p) =>
        p.fotmobPlayerId != null ||
        (p.mantraGwTotal != null && p.mantraGwTotal > 0),
    ).length,
    idealXi: ideal?.starters.map(toIdealPlayer) ?? [],
    realXi,
    realModule: realSide?.module ?? null,
  };
}

export type ScoredFotmobRound = {
  round: string;
  fullyFinished: boolean;
};

export type SeasonIdealTotals = {
  byTeamId: Map<number, number>;
  /** Real XI totals for the same finished tours as `byTeamId`. */
  realByTeamId: Map<number, number>;
  rounds: string[];
};

/** Rounds that already have live/finished FotMob matches — source for season Ideal TS. */
export function listScoredFotmobRounds(
  fotmobLeagueId: number,
  database?: Database.Database,
): ScoredFotmobRound[] {
  try {
    const db = database ?? getDb();
    const rows = db
      .prepare(
        `SELECT round AS round,
                COUNT(*) AS n,
                SUM(CASE WHEN phase = 'finished' THEN 1 ELSE 0 END) AS finished,
                SUM(CASE WHEN phase IN ('live', 'finished') THEN 1 ELSE 0 END) AS scored
         FROM fotmob_matches
         WHERE league_id = ? AND round IS NOT NULL AND TRIM(round) != ''
         GROUP BY round
         HAVING scored > 0
         ORDER BY CAST(round AS INTEGER), round`,
      )
      .all(fotmobLeagueId) as Array<{
      round: string;
      n: number;
      finished: number;
      scored: number;
    }>;
    return rows.map((row) => ({
      round: String(row.round),
      fullyFinished: Number(row.finished) === Number(row.n) && Number(row.n) > 0,
    }));
  } catch {
    return [];
  }
}

/** True when pickIdeal could not fill 10 or 11 slots (empty / too thin squad) — not a 0–0 score. */
export function isFailedIdealPick(row?: {
  formation?: string | null;
  idealXi?: unknown[] | null;
  idealTotal?: number | null;
} | null): boolean {
  if (!row) return true;
  if (row.formation) return false;
  if (Array.isArray(row.idealXi) && row.idealXi.length > 0) return false;
  const n = Number(row.idealTotal);
  return !Number.isFinite(n) || n <= 0;
}

export function sumTotalsByTeam(
  rounds: Array<{
    rows: Array<{
      teamId: number;
      formation?: string | null;
      idealXi?: unknown[] | null;
      idealTotal?: number | null;
      realTotal?: number | null;
    }>;
  }>,
  field: "idealTotal" | "realTotal",
): Map<number, number> {
  const out = new Map<number, number>();
  for (const round of rounds) {
    for (const row of round.rows) {
      const teamId = Number(row.teamId);
      const n = Number(row[field]);
      if (!Number.isSafeInteger(teamId) || teamId <= 0 || !Number.isFinite(n)) continue;
      // % is Real/Ideal on the same tours — skip both sides when Ideal could not be placed.
      if (isFailedIdealPick(row)) continue;
      out.set(teamId, Math.round(((out.get(teamId) ?? 0) + n) * 100) / 100);
    }
  }
  return out;
}

export function sumIdealTotalsByTeam(
  rounds: Array<{ rows: Array<{ teamId: number; idealTotal?: number | null }> }>,
): Map<number, number> {
  return sumTotalsByTeam(rounds, "idealTotal");
}

type SeasonIdealRow = {
  teamId: number;
  formation?: string | null;
  idealXi?: unknown[] | null;
  idealTotal?: number | null;
  realTotal?: number | null;
  realXiTotal?: number | null;
};

/** Season Ideal: max(picked Ideal, full Real XI) per finished tour, then sum. */
export function sumSeasonIdealByTeam(
  rounds: Array<{ rows: SeasonIdealRow[] }>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const round of rounds) {
    for (const row of round.rows) {
      const teamId = Number(row.teamId);
      if (!Number.isSafeInteger(teamId) || teamId <= 0) continue;
      const actual = Number(row.realXiTotal ?? row.realTotal);
      const failed = isFailedIdealPick(row);
      if (failed && !(Number.isFinite(actual) && actual > 0)) continue;
      const picked = failed ? 0 : Number(row.idealTotal);
      const n = floorIdealAtActual(picked, actual);
      if (!Number.isFinite(n) || n <= 0) continue;
      out.set(teamId, Math.round(((out.get(teamId) ?? 0) + n) * 100) / 100);
    }
  }
  return out;
}

function emptySeasonIdeal(): SeasonIdealTotals {
  return { byTeamId: new Map(), realByTeamId: new Map(), rounds: [] };
}

/** Season Ideal TS / % only count fully finished FotMob gameweeks. */
export function finishedFotmobRounds(scored: ScoredFotmobRound[]): ScoredFotmobRound[] {
  return scored.filter((item) => item.fullyFinished);
}

/**
 * Ideal window = fully finished FotMob gameweeks only.
 * Delayed GWs (one match still not FT) stay out; later FT tours stay in even
 * if Mantra GAMES is lower because of those holes. `games` is unused — 1..N
 * would pull unfinished 3–4 and skip 8–9.
 */
export function finishedRoundsAlignedToGames(
  scored: ScoredFotmobRound[],
  _games?: number | null,
): ScoredFotmobRound[] {
  return finishedFotmobRounds(scored);
}

/** True when cached Ideal rounds are exactly the finished-tour window. */
export function idealRoundSetEquals(
  have: Array<string | number> | null | undefined,
  wanted: Array<string | number>,
): boolean {
  const a = [...new Set((have || []).map((round) => String(round)))].sort();
  const b = [...new Set(wanted.map((round) => String(round)))].sort();
  return a.length === b.length && a.every((round, i) => round === b[i]);
}

function gatherSeasonIdeal(
  slug: string,
  finished: ScoredFotmobRound[],
  compute: (
    round: string,
    slug: string,
    fullyFinished: boolean,
  ) => IdealVsRealStandings | null,
): SeasonIdealTotals {
  const packed: IdealVsRealStandings[] = [];
  const rounds: string[] = [];
  for (const item of finished) {
    const data = compute(item.round, slug, true);
    if (!data?.rows?.length) continue;
    packed.push(data);
    rounds.push(item.round);
  }
  return {
    byTeamId: sumSeasonIdealByTeam(packed),
    realByTeamId: sumTotalsByTeam(packed, "realTotal"),
    rounds,
  };
}

function defaultRoundCompute(
  round: string,
  slug: string,
  fullyFinished: boolean,
): IdealVsRealStandings | null {
  // Finished tours: locked XI+bench pool, compute once from sqlite, cache.
  // Current live tour: peek the live-compute worker cache only (full roster).
  return computeIdealVsRealStandings(round, slug, {
    serveStale: !fullyFinished,
    blockOnMiss: fullyFinished,
    useLockedSquad: fullyFinished,
  });
}

function seasonIdealVersion(
  slug: string,
  scored: ScoredFotmobRound[],
  maxRounds?: number,
): string {
  const cap = maxRounds != null && Number.isFinite(maxRounds) ? String(maxRounds) : "all";
  return `${cap}|${scored
    .map((item) => {
      try {
        return `${item.round}:${liveRoundDataVersion(slug, item.round)}`;
      } catch {
        return `${item.round}:na`;
      }
    })
    .join("|")}`;
}

function mapTotals(raw: Record<string, unknown> | undefined): Map<number, number> {
  const byTeamId = new Map<number, number>();
  if (!raw) return byTeamId;
  for (const [id, total] of Object.entries(raw)) {
    const teamId = Number(id);
    const n = Number(total);
    if (Number.isSafeInteger(teamId) && teamId > 0 && Number.isFinite(n)) {
      byTeamId.set(teamId, n);
    }
  }
  return byTeamId;
}

/**
 * Sum of Ideal XI across the same GWs that count in Mantra GAMES.
 * Per tour Ideal is max(picked from that GW's locked XI+bench, actual Real XI).
 * Tables % is Mantra TS / this Ideal TS, not Live Real/Ideal.
 */
export function loadSeasonIdealTotals(
  slug: string,
  options?: {
    database?: Database.Database;
    maxRounds?: number;
    /** Web peeks SQLite (false). Compute worker writes with true. */
    blockOnMiss?: boolean;
    computeRound?: (
      round: string,
      slug: string,
      fullyFinished: boolean,
    ) => IdealVsRealStandings | null;
  },
): SeasonIdealTotals {
  const def = liveLeagueBySlug(slug);
  if (!def) return emptySeasonIdeal();
  const scored = listScoredFotmobRounds(def.fotmobLeagueId, options?.database);
  const finished = finishedRoundsAlignedToGames(scored, options?.maxRounds);
  if (!finished.length) return emptySeasonIdeal();

  if (options?.computeRound) {
    return gatherSeasonIdeal(slug, finished, options.computeRound);
  }

  const wantedRounds = finished.map((item) => item.round);
  const blockOnMiss = options?.blockOnMiss === true;
  try {
    const cached = getComputed(
      `season-ideal-finished:p15-gw:${slug}`,
      seasonIdealVersion(slug, finished, options?.maxRounds),
      () => {
        const gathered = gatherSeasonIdeal(slug, finished, defaultRoundCompute);
        return {
          rounds: gathered.rounds,
          totals: Object.fromEntries(
            [...gathered.byTeamId.entries()].map(([id, total]) => [String(id), total]),
          ),
          realTotals: Object.fromEntries(
            [...gathered.realByTeamId.entries()].map(([id, total]) => [String(id), total]),
          ),
        };
      },
      {
        database: options?.database,
        // Worker must rebuild when GAMES increments; web never blocks HTTP.
        serveStale: !blockOnMiss,
        blockOnMiss,
      },
    ).value;
    if (!cached?.totals) return emptySeasonIdeal();
    const rounds = Array.isArray(cached.rounds) ? cached.rounds.map(String) : [];
    // Stale 1–4 while GAMES=5 would show ~110% for everyone — hide until worker writes.
    if (!blockOnMiss && rounds.join("|") !== wantedRounds.join("|")) {
      return emptySeasonIdeal();
    }
    return {
      byTeamId: mapTotals(cached.totals as Record<string, unknown>),
      realByTeamId: mapTotals(cached.realTotals as Record<string, unknown> | undefined),
      rounds,
    };
  } catch (error) {
    console.warn(
      `season ideal ts [${slug}] failed:`,
      error instanceof Error ? error.message : error,
    );
    return emptySeasonIdeal();
  }
}
