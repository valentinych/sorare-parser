/**
 * Compute Mantra fantasy match results from stored lineups + FotMob stats.
 */
import { getDb } from "../db/index.js";
import {
  getComputed,
  invalidateComputed,
  peekComputed,
  peekComputedPersisted,
} from "../lib/computedCache.js";
import { canonicalClubName } from "../lib/mantraFotmobIds.js";
import { FORMATION_SLOTS } from "../lib/mantraFormations.js";
import { overlayPenaltiesFromStoredEvents } from "./fotmobPenaltyOverlay.js";
import { loadCleanSheetEventsByMatch } from "./fotmobCleanSheetEvents.js";
import { liveRoundDataVersion } from "./liveMatches.js";
import { onPitchCleanSheet, type CleanSheetEvent } from "../lib/playerCleanSheet.js";
import {
  defenceBonusFromBaseScores,
  fantasyGoalsFromTeamScore,
  positionMalus,
  scorePlayer,
  type PlayerMatchStats,
  type ScoreBreakdown,
} from "../lib/mantraScoring.js";
import { loadMantraLineups } from "../sync/syncMantraLineups.js";
import type { MantraMatch, MantraMatchSlot, MantraMatchSquadPlayer } from "../clients/mantraAuth.js";
import {
  liveRoundMetaKey,
  resolveLiveLeague,
} from "../lib/liveLeagues.js";

export type ComputedPlayerScore = {
  playerId: number | null;
  name: string;
  clubName: string | null;
  slotLabel: string;
  native: string[];
  fotmobMatchId: number | null;
  fotmobPlayerId: number | null;
  clubPhase: "finished" | "live" | "upcoming" | "unknown";
  appeared: boolean;
  /** Confirmed in FotMob starting XI (incl. published pre-match lineup). */
  inStartingXi: boolean;
  /** Starter FT but DNP — smart-sub out (red ↓). */
  substitutedOut: boolean;
  /** Bench player covering a DNP slot (green ↑). */
  substitutedIn: boolean;
  /** XI slot this bench player covers, if substitutedIn. */
  coversSlot: string | null;
  breakdown: ScoreBreakdown | null;
};

export type SlotMismatch = {
  index: number;
  playerName: string;
  expected: string;
  html: string;
};

export type ComputedSide = {
  teamId: number | null;
  teamName: string;
  module: string | null;
  /** Formation index labels used for slots (from FORMATION_SLOTS). */
  formationIndex: string[];
  /** HTML pitch badge ≠ formation index at that lineup row. */
  slotMismatches: SlotMismatch[];
  playersTotal: number;
  /** Defence bonus points (0–5). Applied to total only when defenceBonusReady. */
  defenceBonus: number;
  defenceAvg: number;
  /** All CB/RB/LB real matches finished — DB is final and included in total. */
  defenceBonusReady: boolean;
  total: number;
  goals: number;
  scoredCount: number;
  pendingCount: number;
  players: ComputedPlayerScore[];
  bench: ComputedPlayerScore[];
};

export type ComputedMantraMatch = {
  matchId: number;
  home: ComputedSide;
  away: ComputedSide;
};

type ClubPhase = ComputedPlayerScore["clubPhase"];

/** City / place tokens — must not alone link two different clubs. */
const CITY_TOKENS = new Set([
  "krakow",
  "plock",
  "lodz",
  "wroclaw",
  "poznan",
  "warszawa",
  "gliwice",
  "zabrze",
  "katowice",
  "lublin",
  "szczecin",
  "radom",
  "lubin",
  "bialystok",
  "czestochowa",
  "kielce",
]);

function norm(s: string): string {
  return canonicalClubName(s);
}

function clubTokens(s: string): string[] {
  return norm(s)
    .split(" ")
    .filter((t) => t.length > 1);
}

/**
 * Token match only (no substring). Avoids "rakow" ⊂ "krakow" and
 * Wisła Kraków ↔ Wieczysta Kraków via shared city token.
 */
function clubsMatch(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;

  const xt = clubTokens(x);
  const yt = clubTokens(y);
  if (!xt.length || !yt.length) return false;

  const xCities = xt.filter((t) => CITY_TOKENS.has(t));
  const yCities = yt.filter((t) => CITY_TOKENS.has(t));
  if (xCities.length && yCities.length && !xCities.some((c) => yCities.includes(c))) {
    return false;
  }

  const xBrand = xt.filter((t) => !CITY_TOKENS.has(t));
  const yBrand = yt.filter((t) => !CITY_TOKENS.has(t));
  if (!xBrand.length || !yBrand.length) return false;

  const [shorter, longer] =
    xBrand.length <= yBrand.length ? [xBrand, yBrand] : [yBrand, xBrand];
  return shorter.every((t) => longer.includes(t));
}

function loadMantraFotmobIds(tournamentId: number): Map<number, number> {
  const rows = getDb()
    .prepare(
      `SELECT id, fotmob_player_id FROM mantra_players
       WHERE fotmob_player_id IS NOT NULL
         AND (tournament_id = ? OR (? = 18 AND tournament_id IS NULL))`,
    )
    .all(tournamentId, tournamentId) as Array<{
    id: number;
    fotmob_player_id: number;
  }>;
  return new Map(rows.map((row) => [row.id, row.fotmob_player_id]));
}

type FotmobRow = {
  match_id: number;
  player_id: number;
  name: string;
  team_name: string;
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
  starter: number;
  phase: string;
  score_home: number | null;
  score_away: number | null;
  is_home: number;
};

type ClubMatchPhase = { name: string; phase: ClubPhase; prefer: number };

function phaseRank(p: ClubPhase): number {
  if (p === "live") return 3;
  if (p === "finished") return 2;
  if (p === "upcoming") return 1;
  return 0;
}

function asClubPhase(phase: string): ClubPhase {
  if (phase === "live" || phase === "finished" || phase === "upcoming") return phase;
  return "unknown";
}

function loadFotmobIndex(round?: string | null, league?: string | null): FotmobRow[] {
  const def = resolveLiveLeague(league);
  const fotmobId = def.fotmobLeagueId;
  // Never pull finished rows from other tours — findFotmob() takes the first
  // name hit, so an unscoped finished OR would score Round N with Round 1 pts.
  const roundFilter =
    round != null && round !== ""
      ? `m.league_id = ? AND m.round = ?`
      : `m.league_id = ? AND (
           m.round = (SELECT value FROM sync_meta WHERE key = ?)
           OR m.phase = 'live'
         )`;
  const params =
    round != null && round !== ""
      ? [fotmobId, String(round)]
      : [fotmobId, liveRoundMetaKey(def.slug)];
  const rows = getDb()
    .prepare(
      `SELECT p.match_id, p.player_id, p.name, p.team_name, p.rating, p.minutes,
              p.goals, p.assists, p.yellow_cards, p.red_cards, p.own_goals,
              p.saves, p.goals_conceded, p.starter, p.is_home,
              p.penalties_won, p.penalties_conceded, p.penalties_scored,
              p.penalties_missed, p.penalties_saved,
              m.phase, m.score_home, m.score_away
       FROM fotmob_match_players p
       JOIN fotmob_matches m ON m.id = p.match_id
       WHERE ${roundFilter}`,
    )
    .all(...params) as FotmobRow[];

  // Overlay cards from events — playerStats often miss YC/RC.
  const cardRows = getDb()
    .prepare(
      `SELECT e.match_id, e.player_id, lower(e.card) AS card, COUNT(*) AS n
       FROM fotmob_match_events e
       JOIN fotmob_matches m ON m.id = e.match_id
       WHERE m.league_id = ?
         AND e.player_id IS NOT NULL AND lower(e.card) IN ('yellow', 'red')
       GROUP BY e.match_id, e.player_id, lower(e.card)`,
    )
    .all(fotmobId) as Array<{ match_id: number; player_id: number; card: string; n: number }>;
  const byKey = new Map<string, { y: number; r: number }>();
  for (const c of cardRows) {
    const k = `${c.match_id}:${c.player_id}`;
    const cur = byKey.get(k) ?? { y: 0, r: 0 };
    if (c.card === "yellow") cur.y = c.n;
    if (c.card === "red") cur.r = c.n;
    byKey.set(k, cur);
  }
  for (const row of rows) {
    const cur = byKey.get(`${row.match_id}:${row.player_id}`);
    if (!cur) continue;
    row.yellow_cards = cur.y;
    row.red_cards = cur.r;
  }
  overlayPenaltiesFromStoredEvents(rows, fotmobId);
  return rows;
}

function eventsForIndex(index: FotmobRow[]): Map<number, CleanSheetEvent[]> {
  return loadCleanSheetEventsByMatch(index.map((row) => row.match_id));
}

/** Prefer selected-round fixture phase over leftover finished rows from other rounds. */
function loadClubMatchPhases(round?: string | null, league?: string | null): ClubMatchPhase[] {
  const def = resolveLiveLeague(league);
  const fotmobId = def.fotmobLeagueId;
  const scoped = round != null && round !== "";
  const rows = (
    scoped
      ? getDb()
          .prepare(
            `SELECT home_name, away_name, phase, round, ? AS live_round
             FROM fotmob_matches
             WHERE league_id = ? AND round = ?`,
          )
          .all(String(round), fotmobId, String(round))
      : getDb()
          .prepare(
            `SELECT home_name, away_name, phase, round,
                    (SELECT value FROM sync_meta WHERE key = ?) AS live_round
             FROM fotmob_matches
             WHERE league_id = ?
               AND (
                 round = (SELECT value FROM sync_meta WHERE key = ?)
                 OR phase = 'live'
               )`,
          )
          .all(liveRoundMetaKey(def.slug), fotmobId, liveRoundMetaKey(def.slug))
  ) as {
    home_name: string;
    away_name: string;
    phase: string;
    round: string;
    live_round: string | null;
  }[];

  const out: ClubMatchPhase[] = [];
  for (const r of rows) {
    const phase = asClubPhase(r.phase);
    const roundBoost = r.live_round != null && r.round === r.live_round ? 10 : 0;
    const prefer = roundBoost + phaseRank(phase);
    out.push({ name: r.home_name, phase, prefer });
    out.push({ name: r.away_name, phase, prefer });
  }
  return out;
}

function slotAccepted(module: string | null, slot: MantraMatchSlot, index: number): string[] {
  // Formation index is source of truth for accepted positions.
  if (module && FORMATION_SLOTS[module]?.[index]) {
    return [...FORMATION_SLOTS[module]![index]!.accepted];
  }
  if (slot.positions?.length) return slot.positions.map((p) => p.toUpperCase());
  return slot.positions?.map((p) => p.toUpperCase()) ?? [];
}

function toStats(row: FotmobRow | null): PlayerMatchStats | null {
  if (!row) return null;
  const mins = row.minutes;
  // starter alone ≠ appeared — upcoming published XIs must not inflate averages
  const appeared =
    (mins != null && mins > 0) ||
    row.rating != null ||
    (row.goals ?? 0) > 0;
  return {
    rating: row.rating,
    minutes: mins,
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
    appeared,
  };
}

function findFotmob(
  index: FotmobRow[],
  fotmobIds: Map<number, number>,
  mantraPlayerId: number | null,
): FotmobRow | null {
  if (mantraPlayerId == null) return null;
  const fotmobPlayerId = fotmobIds.get(mantraPlayerId);
  if (fotmobPlayerId == null) return null;
  return index.find((row) => row.player_id === fotmobPlayerId) ?? null;
}

function resolveClubPhase(
  clubName: string | null,
  row: FotmobRow | null,
  matchPhases: ClubMatchPhase[],
): ClubPhase {
  if (row) {
    const fromRow = asClubPhase(row.phase);
    if (fromRow !== "unknown") return fromRow;
  }
  if (!clubName) return "unknown";
  let best: ClubPhase = "unknown";
  let bestPrefer = -1;
  for (const m of matchPhases) {
    if (!clubsMatch(clubName, m.name)) continue;
    if (m.prefer > bestPrefer) {
      best = m.phase;
      bestPrefer = m.prefer;
    }
  }
  return best;
}

function teamCleanSheet(
  row: FotmobRow | null,
  events: CleanSheetEvent[],
  native: string[],
): boolean {
  if (!row) return false;
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

function scoreOne(opts: {
  name: string;
  playerId: number | null;
  clubName: string | null;
  slotLabel: string;
  native: string[];
  slotAcceptedPos: string[];
  index: FotmobRow[];
  eventsByMatch: Map<number, CleanSheetEvent[]>;
  matchPhases: ClubMatchPhase[];
  fotmobIds: Map<number, number>;
}): ComputedPlayerScore {
  const row = findFotmob(
    opts.index,
    opts.fotmobIds,
    opts.playerId,
  );
  const stats = toStats(row);
  const phase = resolveClubPhase(opts.clubName, row, opts.matchPhases);
  const inStartingXi = Boolean(row?.starter);
  // live/FT: starter counts as appeared even before minutes land
  const appeared =
    Boolean(stats?.appeared) ||
    (inStartingXi && (phase === "live" || phase === "finished"));
  const breakdown =
    appeared && stats && (phase === "live" || phase === "finished")
      ? scorePlayer({
          native: opts.native,
          slotAccepted: opts.slotAcceptedPos,
          stats: { ...stats, appeared: true },
          teamCleanSheet: teamCleanSheet(
            row,
            row ? (opts.eventsByMatch.get(row.match_id) ?? []) : [],
            opts.native,
          ),
        })
      : null;

  return {
    playerId: opts.playerId,
    name: opts.name,
    clubName: opts.clubName,
    slotLabel: opts.slotLabel,
    native: opts.native,
    fotmobMatchId: row?.match_id ?? null,
    fotmobPlayerId: row?.player_id ?? null,
    clubPhase: phase,
    appeared,
    inStartingXi,
    substitutedOut: false,
    substitutedIn: false,
    coversSlot: null,
    breakdown,
  };
}

/**
 * Smart sub: prefer in-position (malus 0) over OoP; within that, prefer who appeared;
 * then bench order.
 */
function findSmartSubIndex(
  bench: ComputedPlayerScore[],
  slotAcceptedPos: string[],
  used: Set<number>,
): number | null {
  type Cand = { idx: number; malus: number; appeared: boolean };
  const cands: Cand[] = [];
  for (let i = 0; i < bench.length; i++) {
    if (used.has(i)) continue;
    const malus = positionMalus(bench[i]!.native, slotAcceptedPos);
    if (malus == null) continue;
    cands.push({ idx: i, malus, appeared: bench[i]!.appeared });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => {
    // 0 malus first, then less negative OoP
    if (a.malus !== b.malus) return b.malus - a.malus;
    if (a.appeared !== b.appeared) return a.appeared ? -1 : 1;
    return a.idx - b.idx;
  });
  return cands[0]!.idx;
}

function computeSide(
  side: MantraMatch["home"],
  index: FotmobRow[],
  eventsByMatch: Map<number, CleanSheetEvent[]>,
  matchPhases: ClubMatchPhase[],
  fotmobIds: Map<number, number>,
): ComputedSide {
  const module = side.module;
  const formationSlots = module ? FORMATION_SLOTS[module] : null;
  const formationIndex = formationSlots?.map((s) => s.label) ?? [];
  const players: ComputedPlayerScore[] = [];
  const slotAcceptedList: string[][] = [];
  const slotMismatches: SlotMismatch[] = [];

  side.lineup.forEach((slot, idx) => {
    const accepted = slotAccepted(module, slot, idx);
    slotAcceptedList.push(accepted);
    const native = (slot.nativePositions ?? slot.positions).map((p) => p.toUpperCase());
    const expected = formationSlots?.[idx]?.label ?? null;
    const htmlLabel = slot.positions?.length ? slot.positions.join("/") : "";
    const slotLabel = expected || htmlLabel || slot.slot || "?";
    if (expected && htmlLabel && expected !== htmlLabel) {
      slotMismatches.push({
        index: idx,
        playerName: slot.playerName,
        expected,
        html: htmlLabel,
      });
    }

    players.push(
      scoreOne({
        name: slot.playerName,
        playerId: slot.playerId ?? null,
        clubName: slot.clubName ?? null,
        slotLabel,
        native,
        slotAcceptedPos: accepted,
        index,
        eventsByMatch,
        matchPhases,
        fotmobIds,
      }),
    );
  });

  const bench: ComputedPlayerScore[] = (side.substitutes ?? []).map(
    (p: MantraMatchSquadPlayer) => {
      const native = (p.nativePositions ?? p.positions).map((x) => x.toUpperCase());
      return scoreOne({
        name: p.name,
        playerId: p.playerId ?? null,
        clubName: p.clubName ?? null,
        slotLabel: "bench",
        native,
        slotAcceptedPos: native,
        index,
        eventsByMatch,
        matchPhases,
        fotmobIds,
      });
    },
  );

  // Smart subs: FT DNP starter → red ↓; first suitable bench → green ↑ (+ pts if played).
  const usedBench = new Set<number>();
  players.forEach((p, idx) => {
    if (p.clubPhase !== "finished" || p.appeared) return;
    p.substitutedOut = true;
    const accepted = slotAcceptedList[idx] ?? p.native;
    const subIdx = findSmartSubIndex(bench, accepted, usedBench);
    if (subIdx == null) return;
    usedBench.add(subIdx);
    const raw = side.substitutes![subIdx]!;
    const native = (raw.nativePositions ?? raw.positions).map((x) => x.toUpperCase());
    const intoSlot = scoreOne({
      name: raw.name,
      playerId: raw.playerId ?? null,
      clubName: raw.clubName ?? null,
      slotLabel: p.slotLabel,
      native,
      slotAcceptedPos: accepted,
      index,
      eventsByMatch,
      matchPhases,
      fotmobIds,
    });
    bench[subIdx] = {
      ...intoSlot,
      slotLabel: "bench",
      substitutedIn: true,
      coversSlot: p.slotLabel,
    };
  });

  const defSlots = players.filter((p) => {
    const first = String(p.slotLabel || "")
      .split("/")[0]
      ?.trim()
      .toUpperCase();
    return first === "CB" || first === "RB" || first === "LB";
  });
  const defenceBonusReady =
    defSlots.length > 0 && defSlots.every((p) => p.clubPhase === "finished");

  const defBases: number[] = [];
  defSlots.forEach((p) => {
    if (p.breakdown) {
      defBases.push(p.breakdown.base);
      return;
    }
    const sub = bench.find((b) => b.substitutedIn && b.coversSlot === p.slotLabel);
    if (sub?.breakdown) {
      defBases.push(sub.breakdown.base);
      return;
    }
    // Mantra: DNP defender still counts as 0 in the DB average once FT
    if (p.clubPhase === "finished") defBases.push(0);
  });

  const xiScored = players.filter((p) => p.breakdown);
  const subScored = bench.filter((b) => b.substitutedIn && b.breakdown);
  const playersTotal =
    xiScored.reduce((s, p) => s + (p.breakdown?.total ?? 0), 0) +
    subScored.reduce((s, p) => s + (p.breakdown?.total ?? 0), 0);
  const { avg, bonus } = defenceBonusFromBaseScores(defBases);
  const total = defenceBonusReady ? playersTotal + bonus : playersTotal;
  const pendingCount = players.filter(
    (p) =>
      p.clubPhase === "upcoming" ||
      p.clubPhase === "unknown" ||
      (p.clubPhase === "live" && !p.appeared),
  ).length;

  return {
    teamId: side.teamId,
    teamName: side.teamName,
    module,
    formationIndex,
    slotMismatches,
    playersTotal: Math.round(playersTotal * 100) / 100,
    defenceBonus: bonus,
    defenceAvg: Math.round(avg * 100) / 100,
    defenceBonusReady,
    total: Math.round(total * 100) / 100,
    goals: fantasyGoalsFromTeamScore(total),
    scoredCount: xiScored.length + subScored.length,
    pendingCount,
    players,
    bench,
  };
}

export function computeAllMantraMatches(
  round?: string | null,
  league?: string | null,
): ComputedMantraMatch[] {
  const def = resolveLiveLeague(league);
  const file = loadMantraLineups(round, def.slug);
  if (!file) return [];
  const index = loadFotmobIndex(round, def.slug);
  const eventsByMatch = eventsForIndex(index);
  const matchPhases = loadClubMatchPhases(round, def.slug);
  const fotmobIds = loadMantraFotmobIds(def.mantraTournamentId!);
  const out: ComputedMantraMatch[] = [];
  for (const [id, match] of Object.entries(file.matches)) {
    out.push({
      matchId: Number(id),
      home: computeSide(match.home, index, eventsByMatch, matchPhases, fotmobIds),
      away: computeSide(match.away, index, eventsByMatch, matchPhases, fotmobIds),
    });
  }
  return out;
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Background rebuild path — yields so Mantra/FotMob polls are not starved. */
export async function computeAllMantraMatchesAsync(
  round?: string | null,
  league?: string | null,
): Promise<ComputedMantraMatch[]> {
  const def = resolveLiveLeague(league);
  const file = loadMantraLineups(round, def.slug);
  if (!file) return [];
  const index = loadFotmobIndex(round, def.slug);
  const eventsByMatch = eventsForIndex(index);
  const matchPhases = loadClubMatchPhases(round, def.slug);
  const fotmobIds = loadMantraFotmobIds(def.mantraTournamentId!);
  const out: ComputedMantraMatch[] = [];
  let i = 0;
  for (const [id, match] of Object.entries(file.matches)) {
    out.push({
      matchId: Number(id),
      home: computeSide(match.home, index, eventsByMatch, matchPhases, fotmobIds),
      away: computeSide(match.away, index, eventsByMatch, matchPhases, fotmobIds),
    });
    if (++i % 8 === 0) await yieldEventLoop();
  }
  return out;
}

export function invalidateMantraLiveScoreCache(): void {
  invalidateComputed("mantra-scores:");
}

function scoreCacheKey(slug: string, round: string): string {
  return `mantra-scores:${slug}:${round}`;
}

function computeMantraMatchMapUncached(
  round?: string | null,
  league?: string | null,
): Record<string, ComputedMantraMatch> {
  const map: Record<string, ComputedMantraMatch> = {};
  for (const m of computeAllMantraMatches(round, league)) map[String(m.matchId)] = m;
  return map;
}

async function computeMantraMatchMapUncachedAsync(
  round?: string | null,
  league?: string | null,
): Promise<Record<string, ComputedMantraMatch>> {
  const map: Record<string, ComputedMantraMatch> = {};
  for (const m of await computeAllMantraMatchesAsync(round, league)) {
    map[String(m.matchId)] = m;
  }
  return map;
}

export function computeMantraMatchMap(
  round?: string | null,
  league?: string | null,
  options?: { blockOnMiss?: boolean },
): Record<string, ComputedMantraMatch> {
  const slug = resolveLiveLeague(league).slug;
  const r = round != null && round !== "" ? String(round) : "_";
  const blockOnMiss = options?.blockOnMiss;
  return (
    getComputed(
      scoreCacheKey(slug, r),
      r === "_" ? `${slug}|_` : liveRoundDataVersion(slug, r),
      () =>
        blockOnMiss === false
          ? computeMantraMatchMapUncachedAsync(round, league)
          : computeMantraMatchMapUncached(round, league),
      { blockOnMiss },
    ).value ?? {}
  );
}

export function warmupMantraLiveScores(
  round?: string | null,
  league?: string | null,
): void {
  computeMantraMatchMap(round, league, { blockOnMiss: false });
}

export function computeMantraMatch(
  matchId: number,
  round?: string | null,
  league?: string | null,
): ComputedMantraMatch | null {
  const def = resolveLiveLeague(league);
  const r = round != null && round !== "" ? String(round) : "_";
  const key = scoreCacheKey(def.slug, r);
  const cachedMap =
    peekComputed<Record<string, ComputedMantraMatch>>(key) ??
    peekComputedPersisted<Record<string, ComputedMantraMatch>>(key);
  const cached = cachedMap?.[String(matchId)];
  if (cached) return cached;

  // Enqueue full-map rebuild; never compute every match on the click path.
  computeMantraMatchMap(round, league, { blockOnMiss: false });

  const file = loadMantraLineups(round, def.slug);
  const match = file?.matches?.[String(matchId)];
  if (!match) return null;
  const index = loadFotmobIndex(round, def.slug);
  const eventsByMatch = eventsForIndex(index);
  const matchPhases = loadClubMatchPhases(round, def.slug);
  const fotmobIds = loadMantraFotmobIds(def.mantraTournamentId!);
  return {
    matchId,
    home: computeSide(match.home, index, eventsByMatch, matchPhases, fotmobIds),
    away: computeSide(match.away, index, eventsByMatch, matchPhases, fotmobIds),
  };
}

/** Card payload without heavy breakdown.events / formation debug. */
function slimPlayer(p: ComputedPlayerScore) {
  return {
    name: p.name,
    clubName: p.clubName,
    slotLabel: p.slotLabel,
    native: p.native,
    fotmobPlayerId: p.fotmobPlayerId,
    clubPhase: p.clubPhase,
    appeared: p.appeared,
    inStartingXi: p.inStartingXi,
    substitutedOut: p.substitutedOut,
    substitutedIn: p.substitutedIn,
    coversSlot: p.coversSlot,
    breakdown: p.breakdown
      ? { total: p.breakdown.total, base: p.breakdown.base }
      : null,
  };
}

function slimSide(s: ComputedSide) {
  return {
    teamId: s.teamId,
    teamName: s.teamName,
    total: s.total,
    goals: s.goals,
    scoredCount: s.scoredCount,
    defenceBonus: s.defenceBonus,
    defenceAvg: s.defenceAvg,
    defenceBonusReady: s.defenceBonusReady,
    players: s.players.map(slimPlayer),
    bench: s.bench.map(slimPlayer),
  };
}

export function slimMantraMatchMapForCards(
  map: Record<string, ComputedMantraMatch>,
): Record<string, { matchId: number; home: ReturnType<typeof slimSide>; away: ReturnType<typeof slimSide> }> {
  const out: Record<
    string,
    { matchId: number; home: ReturnType<typeof slimSide>; away: ReturnType<typeof slimSide> }
  > = {};
  for (const [id, m] of Object.entries(map)) {
    out[id] = {
      matchId: m.matchId,
      home: slimSide(m.home),
      away: slimSide(m.away),
    };
  }
  return out;
}
