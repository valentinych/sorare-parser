/**
 * Division league table as if every manager posted their Ideal XI.
 * Pairings come from archived Mantra tours; W/D/L/POINTS compare fantasy goals
 * converted from Ideal XI TS (72 for 1 goal, then +7) — same table as live
 * Mantra scorelines, not player goal/pen events. Equal converted goals is a draw
 * even if Ideal TS differs. GF/GA are those converted goals; GA is the opponent's GF.
 * Ideal TS is still summed on the row but does not decide the result.
 */
import type Database from "better-sqlite3";
import type { MantraTourRound } from "../clients/mantraAuth.js";
import {
  liveLeagueBySlug,
  type MantraDivisionDef,
} from "../lib/liveLeagues.js";
import {
  listComputedKeys,
  peekComputed,
  peekComputedPersisted,
  writeComputed,
  isComputedCacheEnqueueEnabled,
} from "../lib/computedCache.js";
import {
  computeIdealVsRealStandings,
  finishedRoundsAlignedToGames,
  idealRoundSetEquals,
  isFailedIdealPick,
  listScoredFotmobRounds,
  type IdealVsRealPlayer,
  type IdealVsRealStandings,
  type ScoredFotmobRound,
} from "./mantraIdealVsReal.js";
import {
  DEFAULT_STANDINGS_SLUG,
  STANDINGS_TTL_MS,
  divisionLabel,
  normalizeMantraCrestUrl,
  peekPlayedGames,
  peekRoundScoresByTeam,
  resolveStandingsLeague,
  standingsDivisionOptions,
  type StandingsDivisionOption,
} from "./mantraStandings.js";
import { getMantraToursForRound } from "../sync/syncMantraTours.js";
import { fantasyGoalsFromTeamScore } from "../lib/mantraScoring.js";

export { STANDINGS_TTL_MS as IDEAL_TABLE_TTL_MS };

/** Writes go here. Reads fall back to any `mantra-ideal-table:*` until a new GW. */
export const IDEAL_TABLE_CACHE_PREFIX = "mantra-ideal-table:v4-pen:";
export const IDEAL_TABLE_CACHE_FALLBACK_PREFIXES = [
  "mantra-ideal-table:v3:",
  "mantra-ideal-table:v2:",
  "mantra-ideal-table:v1:",
  "mantra-ideal-table:",
] as const;

export type IdealTableForm = "W" | "D" | "L";
export type IdealMatchOutcome = "H" | "D" | "A";

export type IdealTableXiPlayer = Pick<
  IdealVsRealPlayer,
  | "name"
  | "displayName"
  | "clubName"
  | "positions"
  | "slotLabel"
  | "baseScore"
  | "totalScore"
  | "events"
>;

export type IdealTableSide = {
  teamId: number | null;
  teamName: string;
  teamLogo: string | null;
  ts: number | null;
  /** Goals scored by this Ideal XI — `fantasyGoalsFromTeamScore(ts)`, not player events. */
  goals: number | null;
  /** Official Mantra TS: results history, else finished tour `round-match-total-score`. */
  realTs: number | null;
  /** Official Mantra goals: results history `sg`, else finished tour host/guest goals. */
  realGoals: number | null;
  formation: string | null;
  playersTotal: number;
  defenceBonus: number;
  idealXi: IdealTableXiPlayer[];
};

export type IdealTableMatch = {
  matchId: number | null;
  outcome: IdealMatchOutcome;
  home: IdealTableSide;
  away: IdealTableSide;
};

export type IdealTableTour = {
  round: string;
  label: string;
  matches: IdealTableMatch[];
};

export type IdealTableRow = {
  rank: number;
  teamId: number;
  teamName: string;
  teamLogo: string | null;
  games: number;
  wins: number;
  draws: number;
  loses: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  ts: number;
  avgTs: number | null;
  form: IdealTableForm[];
};

/** GF/GA/GD/POINTS + Ideal TS from one team's Ideal division table row. */
export type IdealTableTeamStats = {
  rank: number;
  games: number;
  wins: number;
  draws: number;
  loses: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  ts: number;
  avgTs: number | null;
  form: IdealTableForm[];
};

export type IdealTableView = {
  ok: boolean;
  empty: boolean;
  reason: "select_division" | "invalid_division" | "no_data" | null;
  league: string;
  name: string;
  division: string | null;
  divisionLabel: string | null;
  cache: "hit" | "miss" | "stale" | "skip";
  fetchedAt: string;
  rounds: string[];
  missingTours: string[];
  rows: IdealTableRow[];
  tours: IdealTableTour[];
  divisions: StandingsDivisionOption[];
};

export type IdealRoundInput = {
  round: string;
  tours: MantraTourRound[];
  /** Set when the loaded tours belong to a different round (archive missing). */
  toursRound: string | number | null;
  /** Official Mantra TS/GF for this GW from results history (teamId → score). */
  officialByTeamId?: Map<number, { ts: number; goals: number }>;
  idealRows: Array<{
    teamId: number;
    teamName?: string;
    idealTotal?: number | null;
    formation?: string | null;
    idealPlayersTotal?: number | null;
    idealDefenceBonus?: number | null;
    realTotal?: number | null;
    realXiTotal?: number | null;
    idealXi?: IdealVsRealPlayer[] | IdealTableXiPlayer[] | null;
  }>;
};

export type IdealTableDeps = {
  now?: () => number;
  database?: Database.Database;
  serveStale?: boolean;
  schedule?: (work: () => void | Promise<void>) => void;
  listRounds?: (slug: string) => ScoredFotmobRound[];
  maxRounds?: number;
  toursForRound?: (
    round: string,
    slug: string,
  ) => { tours: MantraTourRound[]; round: number | null };
  idealForRound?: (
    round: string,
    slug: string,
    fullyFinished: boolean,
  ) => IdealVsRealStandings | null;
  officialByTeam?: Map<number, Map<number, { ts: number; goals: number }>>;
  /** Rebuild even when a scored snapshot already covers the finished window. */
  force?: boolean;
};

type CachedIdealTable = {
  fetchedAt: string;
  view: Omit<IdealTableView, "cache" | "divisions">;
};

const memory = new Map<string, CachedIdealTable>();
const inflight = new Map<string, Promise<CachedIdealTable>>();
const leagueWarm = new Set<string>();

let scheduleRebuild: (work: () => void | Promise<void>) => void = (work) => {
  setImmediate(() => {
    void Promise.resolve(work());
  });
};

export function setIdealTableScheduler(
  fn: (work: () => void | Promise<void>) => void,
): void {
  scheduleRebuild = fn;
}

export function resetIdealTableCacheForTests(): void {
  memory.clear();
  inflight.clear();
  leagueWarm.clear();
  scheduleRebuild = (work) => {
    setImmediate(() => {
      void Promise.resolve(work());
    });
  };
}

/** Drop in-memory snapshots only. Never DELETE sqlite — prefix bumps must keep i*. */
export function invalidateIdealTableCache(_options?: {
  database?: Database.Database;
  persist?: boolean;
}): void {
  memory.clear();
  inflight.clear();
  leagueWarm.clear();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Open-play goals + penalties from an Ideal XI. Own goals do not count as GF. */
export function xiFantasyGoals(
  players:
    | Array<{ events?: Array<{ key?: string; count?: number }> | null } | null | undefined>
    | null
    | undefined,
): number {
  let n = 0;
  for (const player of players || []) {
    for (const ev of player?.events || []) {
      if (ev?.key !== "goal" && ev?.key !== "pen") continue;
      const count = Number(ev.count);
      n += Number.isFinite(count) && count > 0 ? count : 1;
    }
  }
  return n;
}

export function idealMatchOutcome(homeGoals: number, awayGoals: number): IdealMatchOutcome {
  if (homeGoals > awayGoals) return "H";
  if (awayGoals > homeGoals) return "A";
  return "D";
}

function finiteGoal(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ideal purple goals vs Real Mantra score: red = opposite winners, yellow = win↔draw.
 * Missing real (or ideal) score → no highlight. Same winner / both draws → none.
 */
export function idealVsRealOutcomeHighlight(
  idealHomeGoals: unknown,
  idealAwayGoals: unknown,
  realHomeGoals: unknown,
  realAwayGoals: unknown,
): "red" | "yellow" | null {
  const idealHome = finiteGoal(idealHomeGoals);
  const idealAway = finiteGoal(idealAwayGoals);
  const realHome = finiteGoal(realHomeGoals);
  const realAway = finiteGoal(realAwayGoals);
  if (idealHome == null || idealAway == null || realHome == null || realAway == null) return null;
  const ideal = idealMatchOutcome(idealHome, idealAway);
  const real = idealMatchOutcome(realHome, realAway);
  if (ideal === real) return null;
  if ((ideal === "H" && real === "A") || (ideal === "A" && real === "H")) return "red";
  if (ideal === "D" || real === "D") return "yellow";
  return null;
}

export function toursMatchRequestedRound(
  requested: string,
  toursRound: string | number | null | undefined,
): boolean {
  if (toursRound == null || toursRound === "") return false;
  return String(toursRound) === String(requested);
}

export function resolveIdealDivision(
  slug: string,
  division: string | null | undefined,
): MantraDivisionDef | null {
  const league = liveLeagueBySlug(slug);
  if (!league) return null;
  const want = String(division || "").trim().toLowerCase();
  if (!want) return null;
  for (const def of league.mantraDivisions) {
    const code = divisionLabel(def).toLowerCase();
    const label = `${def.division} | ${def.name}`.toLowerCase();
    if (code === want || label === want || String(def.leagueId) === want) return def;
  }
  return null;
}

function tourBelongsToDivision(tour: MantraTourRound, def: MantraDivisionDef): boolean {
  if (tour.leagueId != null && Number(tour.leagueId) === def.leagueId) return true;
  const code = divisionLabel(def);
  const tourDiv = String(tour.division || "").trim();
  if (tourDiv && (tourDiv === def.division || tourDiv === code)) return true;
  return false;
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const MANTRA_XI_SCORED = 11;

function tourSideComplete(side: { scoredCount?: unknown } | null | undefined): boolean {
  const n = finiteOrNull(side?.scoredCount);
  return n != null && n >= MANTRA_XI_SCORED;
}

/**
 * Tour HTML is trustworthy only after both XIs have 11 scored players.
 * Live / mid-round snapshots print 0–0 (and partial TS) long before that —
 * treat that placeholder as unknown even if scoredCount already says 11.
 */
export function tourArchiveIsOfficial(
  home: { scoredCount?: unknown; goals?: unknown } | null | undefined,
  away: { scoredCount?: unknown; goals?: unknown } | null | undefined,
): boolean {
  if (!tourSideComplete(home) || !tourSideComplete(away)) return false;
  const homeGoals = finiteOrNull(home?.goals);
  const awayGoals = finiteOrNull(away?.goals);
  if (homeGoals === 0 && awayGoals === 0) return false;
  return true;
}

/**
 * Official Mantra TS: results-history for that GW, else a finished tour row.
 * Never use Live Real XI and never treat a placeholder 0 as a posted score.
 */
export function realTsForSide(
  tourScore: unknown,
  idealRow?: { realXiTotal?: number | null; realTotal?: number | null } | null,
  official?: { ts: number; goals: number } | null,
): number | null {
  void idealRow;
  if (official != null && Number.isFinite(official.ts)) return round2(official.ts);
  const fromTour = finiteOrNull(tourScore);
  if (fromTour == null || fromTour === 0) return null;
  return round2(fromTour);
}

export function realGoalsForSide(
  tourGoals: unknown,
  official?: { ts: number; goals: number } | null,
  archiveOfficial = false,
): number | null {
  if (official != null && Number.isFinite(official.goals)) return official.goals;
  if (!archiveOfficial) return null;
  const n = finiteOrNull(tourGoals);
  if (n == null || n === 0) return null;
  return n;
}

function slimXi(
  players: Array<IdealVsRealPlayer | IdealTableXiPlayer> | null | undefined,
): IdealTableXiPlayer[] {
  if (!players?.length) return [];
  return players.map((p) => ({
    name: p.name,
    displayName: p.displayName,
    clubName: p.clubName,
    positions: p.positions,
    slotLabel: p.slotLabel,
    baseScore: p.baseScore,
    totalScore: p.totalScore,
    events: p.events,
  }));
}

type TeamAcc = {
  teamId: number;
  teamName: string;
  teamLogo: string | null;
  games: number;
  wins: number;
  draws: number;
  loses: number;
  gf: number;
  ga: number;
  points: number;
  ts: number;
  form: IdealTableForm[];
};

function applyResult(
  acc: TeamAcc,
  ts: number,
  form: IdealTableForm,
  gf: number,
  ga: number,
): void {
  acc.games += 1;
  acc.ts = round2(acc.ts + ts);
  acc.gf += gf;
  acc.ga += ga;
  acc.form.push(form);
  if (form === "W") {
    acc.wins += 1;
    acc.points += 3;
  } else if (form === "D") {
    acc.draws += 1;
    acc.points += 1;
  } else {
    acc.loses += 1;
  }
}

function compareIdealRows(a: IdealTableRow, b: IdealTableRow): number {
  return (
    b.points - a.points ||
    b.gd - a.gd ||
    b.gf - a.gf ||
    b.ts - a.ts ||
    a.teamName.localeCompare(b.teamName, "en")
  );
}

/**
 * Rebuild one division's table from Ideal XI totals vs the opponent's Ideal XI.
 * Skips rounds whose tour archive is missing (wrong pairings).
 */
export function buildIdealDivisionTable(
  def: MantraDivisionDef,
  rounds: IdealRoundInput[],
): {
  rows: IdealTableRow[];
  tours: IdealTableTour[];
  rounds: string[];
  missingTours: string[];
} {
  const teams = new Map<number, TeamAcc>();
  const tours: IdealTableTour[] = [];
  const usedRounds: string[] = [];
  const missingTours: string[] = [];
  const label = def.division && def.name ? `${def.division} | ${def.name}` : divisionLabel(def);

  const team = (id: number, name: string, logo: string | null): TeamAcc => {
    const existing = teams.get(id);
    if (existing) {
      if (!existing.teamLogo && logo) existing.teamLogo = logo;
      if (name && existing.teamName !== name) existing.teamName = name;
      return existing;
    }
    const created: TeamAcc = {
      teamId: id,
      teamName: name,
      teamLogo: logo,
      games: 0,
      wins: 0,
      draws: 0,
      loses: 0,
      gf: 0,
      ga: 0,
      points: 0,
      ts: 0,
      form: [],
    };
    teams.set(id, created);
    return created;
  };

  for (const item of rounds) {
    const round = String(item.round);
    if (!toursMatchRequestedRound(round, item.toursRound)) {
      missingTours.push(round);
      continue;
    }
    const divisionTours = (item.tours || []).filter((tour) => tourBelongsToDivision(tour, def));
    if (!divisionTours.length) {
      missingTours.push(round);
      continue;
    }
    const byId = new Map(
      (item.idealRows || []).map((row) => [Number(row.teamId), row] as const),
    );
    const matches: IdealTableMatch[] = [];
    for (const tour of divisionTours) {
      for (const pair of tour.matches || []) {
        const homeId = pair.home.teamId;
        const awayId = pair.away.teamId;
        if (homeId == null || awayId == null) continue;
        const homeIdeal = byId.get(homeId);
        const awayIdeal = byId.get(awayId);
        const homeFailed = isFailedIdealPick(homeIdeal);
        const awayFailed = isFailedIdealPick(awayIdeal);
        const homeTs = homeFailed ? null : round2(Number(homeIdeal?.idealTotal) || 0);
        const awayTs = awayFailed ? null : round2(Number(awayIdeal?.idealTotal) || 0);
        const homeGoals = homeTs == null ? null : fantasyGoalsFromTeamScore(homeTs);
        const awayGoals = awayTs == null ? null : fantasyGoalsFromTeamScore(awayTs);
        const outcome =
          homeGoals != null && awayGoals != null
            ? idealMatchOutcome(homeGoals, awayGoals)
            : "D";
        const homeLogo = normalizeMantraCrestUrl(pair.home.logoUrl);
        const awayLogo = normalizeMantraCrestUrl(pair.away.logoUrl);
        const homeAcc = team(homeId, homeIdeal?.teamName || pair.home.teamName, homeLogo);
        const awayAcc = team(awayId, awayIdeal?.teamName || pair.away.teamName, awayLogo);
        if (homeTs != null && awayTs != null) {
          applyResult(
            homeAcc,
            homeTs,
            outcome === "H" ? "W" : outcome === "A" ? "L" : "D",
            homeGoals ?? 0,
            awayGoals ?? 0,
          );
          applyResult(
            awayAcc,
            awayTs,
            outcome === "A" ? "W" : outcome === "H" ? "L" : "D",
            awayGoals ?? 0,
            homeGoals ?? 0,
          );
        }
        const officialHome = item.officialByTeamId?.get(homeId) ?? null;
        const officialAway = item.officialByTeamId?.get(awayId) ?? null;
        // Once this GW has results-history, never fall back to a frozen tour HTML snapshot.
        const historyLoaded = Boolean(item.officialByTeamId?.size);
        const archiveOfficial =
          !historyLoaded && tourArchiveIsOfficial(pair.home, pair.away);
        matches.push({
          matchId: pair.matchId,
          outcome,
          home: {
            teamId: homeId,
            teamName: homeAcc.teamName,
            teamLogo: homeAcc.teamLogo,
            ts: homeTs,
            goals: homeGoals,
            realTs: realTsForSide(
              archiveOfficial ? pair.home.score : null,
              null,
              officialHome,
            ),
            realGoals: realGoalsForSide(pair.home.goals, officialHome, archiveOfficial),
            formation: homeIdeal?.formation ?? null,
            playersTotal: Number(homeIdeal?.idealPlayersTotal) || 0,
            defenceBonus: Number(homeIdeal?.idealDefenceBonus) || 0,
            idealXi: slimXi(homeIdeal?.idealXi),
          },
          away: {
            teamId: awayId,
            teamName: awayAcc.teamName,
            teamLogo: awayAcc.teamLogo,
            ts: awayTs,
            goals: awayGoals,
            realTs: realTsForSide(
              archiveOfficial ? pair.away.score : null,
              null,
              officialAway,
            ),
            realGoals: realGoalsForSide(pair.away.goals, officialAway, archiveOfficial),
            formation: awayIdeal?.formation ?? null,
            playersTotal: Number(awayIdeal?.idealPlayersTotal) || 0,
            defenceBonus: Number(awayIdeal?.idealDefenceBonus) || 0,
            idealXi: slimXi(awayIdeal?.idealXi),
          },
        });
      }
    }
    if (!matches.length) {
      missingTours.push(round);
      continue;
    }
    usedRounds.push(round);
    tours.push({ round, label, matches });
  }

  const rows = [...teams.values()]
    .map((acc) => ({
      rank: 0,
      teamId: acc.teamId,
      teamName: acc.teamName,
      teamLogo: acc.teamLogo,
      games: acc.games,
      wins: acc.wins,
      draws: acc.draws,
      loses: acc.loses,
      gf: acc.gf,
      ga: acc.ga,
      gd: acc.gf - acc.ga,
      points: acc.points,
      ts: acc.ts,
      avgTs: acc.games > 0 ? round2(acc.ts / acc.games) : null,
      form: acc.form.slice(-5),
    }))
    .sort(compareIdealRows)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return { rows, tours, rounds: usedRounds, missingTours };
}

function cacheKey(slug: string, code: string, prefix = IDEAL_TABLE_CACHE_PREFIX): string {
  return `${prefix}${slug}:${code}`;
}

function idealTableCacheKeys(slug: string, code: string): string[] {
  const keys = [cacheKey(slug, code)];
  for (const prefix of IDEAL_TABLE_CACHE_FALLBACK_PREFIXES) {
    const key = cacheKey(slug, code, prefix);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function keyMatchesDivision(key: string, slug: string, code: string): boolean {
  return key.endsWith(`:${slug}:${code}`);
}

function cachedRoundCoverage(cached: CachedIdealTable): number {
  let max = 0;
  for (const round of cached.view.rounds || []) {
    const n = Number(round);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return max;
}

/** Fallback when FotMob rounds are unknown: max cached GW vs Mantra GAMES. */
function idealTableBehindStandings(cached: CachedIdealTable, played: number): boolean {
  if (played <= 0) return false;
  return cachedRoundCoverage(cached) < played;
}

function wantedFinishedRounds(slug: string, deps: IdealTableDeps): string[] {
  const listRounds =
    deps.listRounds ??
    ((key: string) => {
      const league = liveLeagueBySlug(key);
      if (!league) return [];
      return listScoredFotmobRounds(league.fotmobLeagueId, deps.database);
    });
  return finishedRoundsAlignedToGames(
    listRounds(slug),
    deps.maxRounds ?? peekPlayedGames(slug, deps.database),
  ).map((item) => item.round);
}

function snapshotHasScoredIdeal(cached: CachedIdealTable): boolean {
  return (cached.view.rows || []).some((row) => Number(row.ts) > 0);
}

function snapshotMissesFinishedWindow(
  cached: CachedIdealTable | undefined,
  slug: string,
  deps: IdealTableDeps,
): boolean {
  if (!cached) return true;
  if (!snapshotHasScoredIdeal(cached)) return true;
  const wanted = wantedFinishedRounds(slug, deps);
  if (!wanted.length) {
    return idealTableBehindStandings(cached, peekPlayedGames(slug, deps.database));
  }
  return !idealRoundSetEquals(cached.view.rounds, wanted);
}

function readCached(key: string, database?: Database.Database): CachedIdealTable | undefined {
  const mem = memory.get(key);
  if (mem) return mem;
  const fromMemCache = peekComputed<CachedIdealTable>(key);
  if (fromMemCache?.fetchedAt && fromMemCache.view) {
    memory.set(key, fromMemCache);
    return fromMemCache;
  }
  const fromDb = peekComputedPersisted<CachedIdealTable>(key, { database });
  if (fromDb?.fetchedAt && fromDb.view) {
    memory.set(key, fromDb);
    return fromDb;
  }
  return undefined;
}

/** Current prefix, then previous prefixes, then any `mantra-ideal-table:*` for this division. */
function readCachedAny(
  slug: string,
  code: string,
  database?: Database.Database,
): CachedIdealTable | undefined {
  const currentKey = cacheKey(slug, code);
  const current = readCached(currentKey, database);
  if (current) return current;
  for (const key of idealTableCacheKeys(slug, code).slice(1)) {
    const hit = readCached(key, database);
    if (hit) {
      storeCached(currentKey, hit, database);
      return hit;
    }
  }
  for (const key of listComputedKeys("mantra-ideal-table:", { database })) {
    if (!keyMatchesDivision(key, slug, code)) continue;
    const hit = readCached(key, database);
    if (hit) {
      storeCached(currentKey, hit, database);
      return hit;
    }
  }
  return undefined;
}

function storeCached(
  key: string,
  cached: CachedIdealTable,
  database?: Database.Database,
): void {
  memory.set(key, cached);
  writeComputed(key, "v1", cached, { database });
}

function snapshotCoversGames(
  cached: CachedIdealTable | undefined,
  slug: string,
  deps: IdealTableDeps,
): cached is CachedIdealTable {
  if (!cached) return false;
  return !snapshotMissesFinishedWindow(cached, slug, deps);
}

function withDivisions(
  cached: CachedIdealTable,
  cache: IdealTableView["cache"],
): IdealTableView {
  return {
    ...cached.view,
    cache,
    divisions: standingsDivisionOptions(cached.view.league),
  };
}

function emptySelectView(slug: string, name: string): IdealTableView {
  return {
    ok: true,
    empty: true,
    reason: "select_division",
    league: slug,
    name,
    division: null,
    divisionLabel: null,
    cache: "skip",
    fetchedAt: "",
    rounds: [],
    missingTours: [],
    rows: [],
    tours: [],
    divisions: standingsDivisionOptions(slug),
  };
}

function defaultToursForRound(round: string, slug: string) {
  return getMantraToursForRound(round, slug);
}

function defaultIdealForRound(
  round: string,
  slug: string,
  fullyFinished: boolean,
): IdealVsRealStandings | null {
  return computeIdealVsRealStandings(round, slug, {
    // HTTP must not CPU-block: worker writes matching versions into sqlite.
    serveStale: true,
    blockOnMiss: false,
    useLockedSquad: fullyFinished,
  });
}

function officialForRound(
  officialByTeam: Map<number, Map<number, { ts: number; goals: number }>> | undefined,
  round: string,
): Map<number, { ts: number; goals: number }> | undefined {
  if (!officialByTeam?.size) return undefined;
  const want = Number(round);
  const out = new Map<number, { ts: number; goals: number }>();
  for (const [teamId, byRound] of officialByTeam) {
    const hit = byRound.get(want);
    if (hit) out.set(teamId, hit);
  }
  return out.size ? out : undefined;
}

function gatherRounds(slug: string, deps: IdealTableDeps): IdealRoundInput[] {
  const listRounds =
    deps.listRounds ??
    ((key: string) => {
      const league = liveLeagueBySlug(key);
      if (!league) return [];
      return listScoredFotmobRounds(league.fotmobLeagueId, deps.database);
    });
  const toursForRound = deps.toursForRound ?? defaultToursForRound;
  const idealForRound = deps.idealForRound ?? defaultIdealForRound;
  const officialByTeam =
    deps.officialByTeam ?? peekRoundScoresByTeam(slug, deps.database);
  const scored = listRounds(slug);
  const maxRounds =
    deps.maxRounds ?? peekPlayedGames(slug, deps.database);
  const finished = finishedRoundsAlignedToGames(
    scored,
    maxRounds > 0 ? maxRounds : undefined,
  );
  const out: IdealRoundInput[] = [];
  for (const item of finished) {
    const tours = toursForRound(item.round, slug);
    const ideal = idealForRound(item.round, slug, true);
    out.push({
      round: item.round,
      tours: tours.tours || [],
      toursRound: tours.round,
      officialByTeamId: officialForRound(officialByTeam, item.round),
      idealRows: ideal?.rows ?? [],
    });
  }
  return out;
}

async function fetchDivisionTable(
  slug: string,
  def: MantraDivisionDef,
  deps: IdealTableDeps,
): Promise<CachedIdealTable> {
  const league = liveLeagueBySlug(slug)!;
  const built = buildIdealDivisionTable(def, gatherRounds(slug, deps));
  const fetchedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
  const code = divisionLabel(def);
  const label = def.division && def.name ? `${def.division} | ${def.name}` : code;
  return {
    fetchedAt,
    view: {
      ok: true,
      empty: built.rows.length === 0,
      reason: built.rows.length === 0 ? "no_data" : null,
      league: league.slug,
      name: league.name,
      division: code,
      divisionLabel: label,
      fetchedAt,
      rounds: built.rounds,
      missingTours: built.missingTours,
      rows: built.rows,
      tours: built.tours,
    },
  };
}

function enqueueRebuild(
  key: string,
  slug: string,
  def: MantraDivisionDef,
  deps: IdealTableDeps,
): void {
  if (!isComputedCacheEnqueueEnabled()) return;
  if (inflight.has(key)) return;
  const schedule = deps.schedule ?? scheduleRebuild;
  schedule(async () => {
    if (inflight.has(key)) return;
    const pending = fetchDivisionTable(slug, def, deps).then((cached) => {
      storeCached(key, cached, deps.database);
      return cached;
    });
    inflight.set(key, pending);
    try {
      await pending;
    } catch (error) {
      console.warn(
        `ideal table ${slug}/${divisionLabel(def)} failed:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      inflight.delete(key);
    }
  });
}

export async function getIdealDivisionTable(
  slug: string | null | undefined,
  division: string | null | undefined,
  deps: IdealTableDeps = {},
): Promise<IdealTableView> {
  const league = resolveStandingsLeague(slug) ?? liveLeagueBySlug(DEFAULT_STANDINGS_SLUG);
  if (!league) {
    const requested = String(slug || "").trim();
    return {
      ...emptySelectView(requested, requested),
      ok: false,
      reason: "invalid_division",
      cache: "miss",
      divisions: [],
    };
  }
  const want = String(division || "").trim();
  if (!want) return emptySelectView(league.slug, league.name);
  const def = resolveIdealDivision(league.slug, want);
  if (!def) {
    return {
      ...emptySelectView(league.slug, league.name),
      ok: false,
      reason: "invalid_division",
      cache: "miss",
    };
  }

  const key = cacheKey(league.slug, divisionLabel(def));
  const cached = readCachedAny(league.slug, divisionLabel(def), deps.database);
  if (!deps.force && snapshotCoversGames(cached, league.slug, deps)) {
    return withDivisions(cached, "hit");
  }

  const serveStale = deps.serveStale !== false;
  if (cached && serveStale) {
    enqueueRebuild(key, league.slug, def, deps);
    return withDivisions(cached, "stale");
  }

  const existing = inflight.get(key);
  if (existing) return withDivisions(await existing, cached ? "stale" : "miss");

  const pending = fetchDivisionTable(league.slug, def, deps).then((next) => {
    storeCached(key, next, deps.database);
    return next;
  });
  inflight.set(key, pending);
  try {
    return withDivisions(await pending, "miss");
  } finally {
    inflight.delete(key);
  }
}

function mergeIdealStats(
  out: Map<number, IdealTableTeamStats>,
  rounds: Set<string>,
  cached: CachedIdealTable | undefined,
  overwrite: boolean,
): void {
  if (!cached) return;
  for (const round of cached.view.rounds || []) {
    if (round != null && String(round).trim()) rounds.add(String(round));
  }
  for (const row of cached.view.rows || []) {
    if (!overwrite && out.has(row.teamId)) continue;
    const ts = Number(row.ts);
    out.set(row.teamId, {
      rank: row.rank,
      games: row.games,
      wins: row.wins,
      draws: row.draws,
      loses: row.loses,
      gf: row.gf,
      ga: row.ga,
      gd: row.gd,
      points: row.points,
      ts: Number.isFinite(ts) ? ts : 0,
      avgTs: row.avgTs,
      form: row.form || [],
    });
  }
}

export type IdealTableOverlay = {
  stats: Map<number, IdealTableTeamStats>;
  byTeamId: Map<number, number>;
  rounds: string[];
};

/** Sync read of cached Ideal-table i* + TS. Missing division → omit team (UI —). */
export function peekIdealTableOverlay(
  slug: string,
  database?: Database.Database,
): IdealTableOverlay {
  const league = liveLeagueBySlug(slug);
  const stats = new Map<number, IdealTableTeamStats>();
  const rounds = new Set<string>();
  if (!league) return { stats, byTeamId: new Map(), rounds: [] };
  for (const def of league.mantraDivisions) {
    mergeIdealStats(
      stats,
      rounds,
      readCachedAny(league.slug, divisionLabel(def), database),
      false,
    );
  }
  const needle = `:${slug}:`;
  for (const key of listComputedKeys("mantra-ideal-table:", { database })) {
    if (!key.includes(needle)) continue;
    mergeIdealStats(stats, rounds, readCached(key, database), false);
  }
  const byTeamId = new Map<number, number>();
  for (const [id, row] of stats) {
    if (row.ts > 0) byTeamId.set(id, row.ts);
  }
  return {
    stats,
    byTeamId,
    rounds: [...rounds].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)),
  };
}

/** Sync read of cached Ideal-table GF/GA/GD/POINTS. Missing division → omit team (UI —). */
export function peekIdealTableStats(
  slug: string,
  database?: Database.Database,
): Map<number, IdealTableTeamStats> {
  return peekIdealTableOverlay(slug, database).stats;
}

/**
 * Background sequential warm of stale/missing Ideal tables for a championship.
 * Does not block; HTTP should peek cache and return.
 */
export function warmIdealTables(slug: string, deps: IdealTableDeps = {}): void {
  if (!isComputedCacheEnqueueEnabled()) return;
  const league = liveLeagueBySlug(slug);
  if (!league || leagueWarm.has(league.slug)) return;
  const played = peekPlayedGames(league.slug, deps.database);
  const needsWarm = league.mantraDivisions.some((def) => {
    const cached = readCachedAny(league.slug, divisionLabel(def), deps.database);
    if (!cached) return played > 0;
    return snapshotMissesFinishedWindow(cached, league.slug, deps);
  });
  if (!needsWarm) return;
  leagueWarm.add(league.slug);
  const schedule = deps.schedule ?? scheduleRebuild;
  schedule(async () => {
    try {
      for (const def of league.mantraDivisions) {
        const key = cacheKey(league.slug, divisionLabel(def));
        const cached = readCachedAny(league.slug, divisionLabel(def), deps.database);
        if (cached && !snapshotMissesFinishedWindow(cached, league.slug, deps)) continue;
        const existing = inflight.get(key);
        if (existing) {
          try {
            await existing;
          } catch {
            /* rebuild logs its own failure */
          }
          continue;
        }
        const pending = fetchDivisionTable(league.slug, def, deps).then((next) => {
          storeCached(key, next, deps.database);
          return next;
        });
        inflight.set(key, pending);
        try {
          await pending;
        } catch (error) {
          console.warn(
            `ideal table ${league.slug}/${divisionLabel(def)} failed:`,
            error instanceof Error ? error.message : error,
          );
        } finally {
          inflight.delete(key);
        }
      }
    } finally {
      leagueWarm.delete(league.slug);
    }
  });
}
