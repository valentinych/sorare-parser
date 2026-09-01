/**
 * Ideal XI vs Real XI for each Mantra fantasy team in the live tour.
 * Ideal: best Mantra-legal formation (native + OoP with malus) from the
 * manager's ~26-player squad, scored like live / Dream Team, ranked by
 * playersTotal + defenceBonus (CB/RB/LB bases). Assignment is max-weight
 * bitmask DP over a trimmed candidate pool (≤22).
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
import { getMantraToursForRound } from "../sync/syncMantraTours.js";
import { getComputed, invalidateComputed } from "../lib/computedCache.js";
import { overlayPenaltiesFromStoredEvents } from "./fotmobPenaltyOverlay.js";
import { loadCleanSheetEventsByMatch } from "./fotmobCleanSheetEvents.js";
import {
  computeMantraMatchMap,
  type ComputedPlayerScore,
  type ComputedSide,
} from "./mantraLiveScore.js";
import {
  liveRoundMetaKey,
  resolveLiveLeague,
} from "../lib/liveLeagues.js";
import { liveRoundDataVersion } from "./liveMatches.js";

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
  realPlayersTotal: number;
  realDefenceBonus: number;
  realDefenceBonusReady: boolean;
  /** realTotal / idealTotal * 100; null if ideal is 0. */
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

type ScoredSquadPlayer = {
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
): ScoredSquadPlayer | null {
  const positions = parsePositions(mantra.positions_json);
  if (!positions.length) return null;
  const display =
    mantra.full_name ||
    [mantra.first_name, mantra.name].filter(Boolean).join(" ") ||
    mantra.name;
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

/** Score as if playing the formation slot — CS uses slot.accepted; OoP via positionMalus. */
function scoreForSlot(p: ScoredSquadPlayer, slot: FormationSlot): ScoreBreakdown {
  if (!p.stats) return zeroBreakdown();
  if (!slotLegal(p.positions, slot)) return zeroBreakdown();
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

type Tentative = {
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
 */
function fillFormation(formation: string, pool: ScoredSquadPlayer[]): Tentative | null {
  const slots = FORMATION_SLOTS[formation];
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

function pickIdeal(pool: ScoredSquadPlayer[]): Tentative | null {
  let best: Tentative | null = null;
  for (const f of ALL_FORMATIONS) {
    const cand = fillFormation(f, pool);
    if (!cand) continue;
    if (!best || cand.totalScore > best.totalScore) best = cand;
  }
  return best;
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

function idealVsRealCacheKey(slug: string, round: string): string {
  return `ideal-vs-real:${slug}:${round}`;
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
  options?: { serveStale?: boolean; blockOnMiss?: boolean },
): IdealVsRealStandings | null {
  const def = resolveLiveLeague(league);
  const round = loadRound(requestedRound, def.slug);
  if (!round) return null;
  const blockOnMiss = options?.blockOnMiss;
  return (
    getComputed(
      idealVsRealCacheKey(def.slug, round),
      idealVsRealCacheVersion(def.slug, round),
      () =>
        blockOnMiss === false
          ? computeIdealVsRealStandingsUncachedAsync(round, def.slug)
          : computeIdealVsRealStandingsUncached(round, def.slug),
      { serveStale: options?.serveStale, blockOnMiss },
    ).value ?? null
  );
}

function computeIdealVsRealStandingsUncached(
  round: string,
  slug: string,
): IdealVsRealStandings | null {
  const tours = getMantraToursForRound(round, slug).tours;
  if (!tours.length) return null;

  const fotmobRows = loadFotmobPool(round, slug);
  const eventsByMatch = loadCleanSheetEventsByMatch(fotmobRows.map((row) => row.match_id));
  const { byId: fotmobById } = buildFotmobIndex(fotmobRows);
  const computed = computeMantraMatchMap(round, slug);

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

  const allSquadIds = new Set<number>();
  const squadByTeam = new Map<number, number[]>();
  for (const teamId of teams.keys()) {
    const ids = loadFantasySquadIds(teamId);
    squadByTeam.set(teamId, ids);
    for (const id of ids) allSquadIds.add(id);
  }
  const mantraById = loadMantraPlayersByIds([...allSquadIds]);

  const rows: IdealVsRealRow[] = [];
  for (const ref of teams.values()) {
    rows.push(
      buildIdealVsRealRow(ref, squadByTeam, mantraById, fotmobById, eventsByMatch, computed),
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
): Promise<IdealVsRealStandings | null> {
  const tours = getMantraToursForRound(round, slug).tours;
  if (!tours.length) return null;

  const fotmobRows = loadFotmobPool(round, slug);
  const eventsByMatch = loadCleanSheetEventsByMatch(fotmobRows.map((row) => row.match_id));
  const { byId: fotmobById } = buildFotmobIndex(fotmobRows);
  const computed = computeMantraMatchMap(round, slug);

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

  const allSquadIds = new Set<number>();
  const squadByTeam = new Map<number, number[]>();
  for (const teamId of teams.keys()) {
    const ids = loadFantasySquadIds(teamId);
    squadByTeam.set(teamId, ids);
    for (const id of ids) allSquadIds.add(id);
  }
  const mantraById = loadMantraPlayersByIds([...allSquadIds]);

  const rows: IdealVsRealRow[] = [];
  let n = 0;
  for (const ref of teams.values()) {
    rows.push(
      buildIdealVsRealRow(ref, squadByTeam, mantraById, fotmobById, eventsByMatch, computed),
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
    );
    if (scored) pool.push(scored);
  }

  const ideal = pickIdeal(pool);
  const realHit = findRealSide(ref.teamId, computed);
  const realSide = realHit?.side ?? null;
  const idealTotal = ideal?.totalScore ?? 0;
  const realTotal = realSide?.total ?? 0;
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
    realPlayersTotal: realSide?.playersTotal ?? 0,
    realDefenceBonus: realSide?.defenceBonus ?? 0,
    realDefenceBonusReady: realSide?.defenceBonusReady ?? false,
    idealPct,
    squadSize: squadIds.length,
    scoredPoolSize: pool.filter((p) => p.fotmobPlayerId != null).length,
    idealXi: ideal?.starters.map(toIdealPlayer) ?? [],
    realXi: realSide ? buildRealXi(realSide) : [],
    realModule: realSide?.module ?? null,
  };
}
