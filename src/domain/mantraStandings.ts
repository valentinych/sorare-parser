/**
 * Combined Mantra standings across all fantasy divisions of one championship.
 * Source: GET https://mantrafootball.org/api/leagues/:id/results
 * Cache: 1 hour, memory + sqlite computed_cache, stale-while-revalidate.
 */
import type Database from "better-sqlite3";
import { fetchLeagueResults } from "../clients/mantra.js";
import {
  listComputedKeys,
  peekComputed,
  peekComputedPersisted,
  writeComputed,
} from "../lib/computedCache.js";
import {
  allTablesLeagues,
  isTablesExtraSlug,
  liveLeagueBySlug,
  type MantraDivisionDef,
} from "../lib/liveLeagues.js";
import { writeTablesJobProgress } from "./tablesProgress.js";

export const STANDINGS_TTL_MS = 60 * 60 * 1000;
/** v3: keep per-round TS/GF from results history for official match scores. */
export const STANDINGS_CACHE_PREFIX = "mantra-standings:v3:";
/** Read these if the current prefix is empty. Never wipe them on deploy. */
export const STANDINGS_CACHE_FALLBACK_PREFIXES = [
  "mantra-standings:v2:",
  "mantra-standings:v1:",
  "mantra-standings:",
] as const;
export const DEFAULT_STANDINGS_SLUG = "championship";
const DIVISION_FETCH_ATTEMPTS = 2;

const MANTRA_IMAGE_HOSTS = new Set([
  "mantrafootball.s3.eu-west-1.amazonaws.com",
  "mantrafootball.org",
]);

type Json = Record<string, unknown>;

export type StandingsForm = "W" | "D" | "L";

export type StandingsRow = {
  rank: number;
  divisionRank: number;
  movement: number;
  teamId: number;
  teamName: string;
  teamLogo: string | null;
  division: string;
  leagueId: number;
  leagueName: string;
  games: number;
  wins: number;
  draws: number;
  loses: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  ts: number;
  form: StandingsForm[];
  nextTeamId: number | null;
  nextTeamName: string | null;
  nextTeamLogo: string | null;
  /** Sum of Ideal XI over the same finished tours that count in Mantra GAMES. */
  idealTs: number | null;
  /** Mantra standings TS / Ideal TS × 100. */
  idealPct: number | null;
  /** Ideal division table GF/GA/GD/POINTS (null = cache miss, not 0). */
  iGf: number | null;
  iGa: number | null;
  iGd: number | null;
  iPts: number | null;
};

export type StandingsLeagueInfo = {
  slug: string;
  name: string;
  divisions: number;
};

export type StandingsView = {
  ok: boolean;
  empty: boolean;
  league: string;
  name: string;
  cache: "hit" | "miss" | "stale";
  fetchedAt: string;
  divisions: number;
  teams: number;
  failedDivisions: Array<{ leagueId: number; division: string; error: string }>;
  rows: StandingsRow[];
  /** Mantra GWs included in Ideal TS (empty if none cached/computed). */
  idealRounds: string[];
  leagues: StandingsLeagueInfo[];
  divisionOptions: StandingsDivisionOption[];
};

export type StandingsDeps = {
  fetchResults?: (leagueId: number) => Promise<unknown>;
  now?: () => number;
  database?: Database.Database;
  serveStale?: boolean;
  schedule?: (work: () => void | Promise<void>) => void;
};

/** One Mantra GW from `/leagues/:id/results` history diffs (index = round). */
export type MantraRoundScore = {
  round: number;
  ts: number;
  gf: number;
  ga: number;
};

type CachedStandings = {
  fetchedAt: string;
  view: Omit<StandingsView, "cache" | "leagues" | "divisionOptions">;
  /** teamId → official per-round TS/GF. Not sent to the tables SPA. */
  roundScoresByTeam?: Record<string, MantraRoundScore[]>;
};

const memory = new Map<string, CachedStandings>();
const inflight = new Map<string, Promise<CachedStandings>>();

let scheduleRebuild: (work: () => void | Promise<void>) => void = (work) => {
  setImmediate(() => {
    void Promise.resolve(work());
  });
};

export function setStandingsScheduler(fn: (work: () => void | Promise<void>) => void): void {
  scheduleRebuild = fn;
}

export function resetMantraStandingsCacheForTests(): void {
  memory.clear();
  inflight.clear();
  scheduleRebuild = (work) => {
    setImmediate(() => {
      void Promise.resolve(work());
    });
  };
}

export function standingsLeagues(): StandingsLeagueInfo[] {
  return [
    ...allTablesLeagues().map((league) => ({
      slug: league.slug,
      name: league.name,
      divisions: league.mantraDivisions.length,
    })),
    { slug: "managers", name: "Менеджеры", divisions: 0 },
  ];
}

export function resolveStandingsLeague(slug: string | null | undefined) {
  const key = String(slug || "").trim().toLowerCase();
  if (!key) return liveLeagueBySlug(DEFAULT_STANDINGS_SLUG)!;
  return liveLeagueBySlug(key);
}

function cacheKey(slug: string, prefix = STANDINGS_CACHE_PREFIX): string {
  return `${prefix}${slug}`;
}

function standingsCacheKeys(slug: string): string[] {
  const keys = [cacheKey(slug)];
  for (const prefix of STANDINGS_CACHE_FALLBACK_PREFIXES) {
    const key = cacheKey(slug, prefix);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function readStandingsCached(
  slug: string,
  database?: Database.Database,
): CachedStandings | undefined {
  for (const key of standingsCacheKeys(slug)) {
    const hit = readCached(key, database);
    if (hit) return hit;
  }
  const suffix = `:${slug}`;
  for (const key of listComputedKeys("mantra-standings:", { database })) {
    if (key.endsWith(suffix) || key === `mantra-standings:${slug}`) {
      const hit = readCached(key, database);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Cached championship snapshot only. Never fetches Mantra or enqueues rebuild.
 * Null when this slug has no standings cache.
 */
export function peekChampionshipStandings(
  slug: string,
  database?: Database.Database,
): StandingsView | null {
  const league = liveLeagueBySlug(slug);
  if (!league) return null;
  const cached = readStandingsCached(league.slug, database);
  if (!cached) return null;
  const nowMs = Date.now();
  return withCatalog(cached, isFresh(cached, nowMs) ? "hit" : "stale");
}

/** Max Mantra GAMES, else max results-history round (0 if none). */
export function peekPlayedGames(slug: string, database?: Database.Database): number {
  const cached = readStandingsCached(slug, database);
  const rows = cached?.view?.rows ?? [];
  let max = rows.reduce((m, row) => Math.max(m, row.games || 0), 0);
  for (const scores of Object.values(cached?.roundScoresByTeam ?? {})) {
    for (const row of scores || []) {
      const round = Number(row.round);
      if (Number.isFinite(round)) max = Math.max(max, round);
    }
  }
  return max;
}

function asRecord(value: unknown): Json | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeMantraCrestUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    if (!MANTRA_IMAGE_HOSTS.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseForm(value: unknown): StandingsForm[] {
  if (!Array.isArray(value)) return [];
  const out: StandingsForm[] = [];
  for (const item of value) {
    const token = String(item || "").trim().toUpperCase();
    if (token === "W" || token === "D" || token === "L") out.push(token);
  }
  return out;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Mantra `/leagues/:id/results` history is cumulative per GW.
 * Index is the Mantra round number; null slots are skipped GWs with no official result.
 * Round N TS/GF/GA = history[N] minus the previous non-null cumulative.
 */
export function roundScoresFromHistory(history: unknown): MantraRoundScore[] {
  if (!Array.isArray(history)) return [];
  const out: MantraRoundScore[] = [];
  let prevTs = 0;
  let prevGf = 0;
  let prevGa = 0;
  for (let round = 0; round < history.length; round++) {
    const rec = asRecord(history[round]);
    if (!rec) continue;
    const ts = num(rec.ts);
    const gf = num(rec.sg ?? rec.scored_goals);
    const ga = num(rec.mg ?? rec.missed_goals);
    out.push({
      round,
      ts: round2(ts - prevTs),
      gf: gf - prevGf,
      ga: ga - prevGa,
    });
    prevTs = ts;
    prevGf = gf;
    prevGa = ga;
  }
  return out;
}

/** Official Mantra TS + GF for one team in one GW, or null if that round is missing. */
export function officialRoundScore(
  scores: Iterable<MantraRoundScore> | null | undefined,
  round: string | number | null | undefined,
): { ts: number; goals: number } | null {
  const want = Number(round);
  if (!Number.isInteger(want) || want < 1) return null;
  for (const row of scores || []) {
    if (row.round === want) return { ts: row.ts, goals: row.gf };
  }
  return null;
}

export function parseDivisionRoundScores(
  raw: unknown,
): Record<string, MantraRoundScore[]> {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(asRecord(raw)?.data)
      ? (asRecord(raw)!.data as unknown[])
      : [];
  const out: Record<string, MantraRoundScore[]> = {};
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    const team = asRecord(rec.team) ?? {};
    const teamId = numOrNull(team.id);
    if (teamId == null) continue;
    const scores = roundScoresFromHistory(rec.history);
    if (scores.length) out[String(teamId)] = scores;
  }
  return out;
}

/** Cached official per-round scores from the standings snapshot (empty if none). */
export function peekRoundScoresByTeam(
  slug: string,
  database?: Database.Database,
): Map<number, Map<number, { ts: number; goals: number }>> {
  const cached = readStandingsCached(slug, database);
  const out = new Map<number, Map<number, { ts: number; goals: number }>>();
  for (const [id, scores] of Object.entries(cached?.roundScoresByTeam ?? {})) {
    const teamId = Number(id);
    if (!Number.isFinite(teamId)) continue;
    const byRound = new Map<number, { ts: number; goals: number }>();
    for (const row of scores || []) {
      byRound.set(row.round, { ts: row.ts, goals: row.gf });
    }
    if (byRound.size) out.set(teamId, byRound);
  }
  return out;
}

/** Last history pos minus previous: + up, − down, 0 stable. */
export function movementFromHistory(history: unknown): number {
  if (!Array.isArray(history)) return 0;
  const positions: number[] = [];
  for (const item of history) {
    const row = asRecord(item);
    const pos = numOrNull(row?.pos);
    if (pos != null) positions.push(pos);
  }
  if (positions.length < 2) return 0;
  return positions[positions.length - 2]! - positions[positions.length - 1]!;
}

export function divisionLabel(def: MantraDivisionDef): string {
  const code = String(def.division || "").trim();
  if (code) return code;
  return def.name || String(def.leagueId);
}

export type StandingsDivisionOption = {
  code: string;
  name: string;
  leagueId: number;
  label: string;
};

export function standingsDivisionOptions(slug: string): StandingsDivisionOption[] {
  const league = liveLeagueBySlug(slug);
  if (!league) return [];
  return league.mantraDivisions.map((def) => {
    const code = divisionLabel(def);
    const label =
      def.division && def.name ? `${def.division} | ${def.name}` : code;
    return { code, name: def.name, leagueId: def.leagueId, label };
  });
}

type DivisionTeam = Omit<
  StandingsRow,
  "rank" | "nextTeamName" | "nextTeamLogo"
> & {
  nextTeamId: number | null;
};

export function parseDivisionResults(
  raw: unknown,
  def: MantraDivisionDef,
): DivisionTeam[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(asRecord(raw)?.data)
      ? (asRecord(raw)!.data as unknown[])
      : [];
  const rows: DivisionTeam[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    const team = asRecord(rec.team) ?? {};
    const teamId = numOrNull(team.id);
    const teamName = String(team.human_name ?? team.name ?? "").trim();
    if (teamId == null || !teamName) continue;
    rows.push({
      divisionRank: 0,
      movement: movementFromHistory(rec.history),
      teamId,
      teamName,
      teamLogo: normalizeMantraCrestUrl(team.logo_path),
      division: divisionLabel(def),
      leagueId: def.leagueId,
      leagueName: def.name,
      games: num(rec.matches_played),
      wins: num(rec.wins),
      draws: num(rec.draws),
      loses: num(rec.loses),
      gf: num(rec.scored_goals),
      ga: num(rec.missed_goals),
      gd: num(rec.goals_difference),
      points: num(rec.points),
      ts: num(rec.total_score),
      form: parseForm(rec.form),
      nextTeamId: numOrNull(rec.next_opponent_id),
      idealTs: null,
      idealPct: null,
      iGf: null,
      iGa: null,
      iGd: null,
      iPts: null,
    });
  }
  return rows.map((row, index) => ({ ...row, divisionRank: index + 1 }));
}

function compareStandings(a: StandingsRow, b: StandingsRow): number {
  return (
    b.points - a.points ||
    b.ts - a.ts ||
    a.division.localeCompare(b.division, "en") ||
    a.divisionRank - b.divisionRank ||
    a.teamName.localeCompare(b.teamName, "en")
  );
}

/** TS / Ideal TS × 100, rounded to hundredths. Null when Ideal is 0/missing. */
export function realOverIdealPct(real: number, ideal: number): number | null {
  if (!Number.isFinite(real) || !Number.isFinite(ideal) || ideal <= 0) return null;
  return Math.round((real / ideal) * 10000) / 100;
}

export function formatStandingsIdealPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return `${pct.toFixed(2)}%`;
}

export const STANDINGS_SORT_KEYS = new Set([
  "wins",
  "draws",
  "loses",
  "gf",
  "ga",
  "gd",
  "points",
  "iGf",
  "iGa",
  "iGd",
  "iPts",
  "ts",
  "idealTs",
  "idealPct",
]);

function sortNum(row: StandingsRow, key: string): number | null {
  const raw = (row as unknown as Record<string, unknown>)[key];
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Click-sort: first click desc. Tiebreak POINTS then TS. Missing Ideal sorts last. */
export function sortStandingsRows(
  rows: StandingsRow[],
  key: string,
  dir: "asc" | "desc",
): StandingsRow[] {
  const sortKey = STANDINGS_SORT_KEYS.has(key) ? key : "points";
  const sign = dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (sortKey !== "points") {
      const av = sortNum(a, sortKey);
      const bv = sortNum(b, sortKey);
      if (av == null && bv != null) return 1;
      if (bv == null && av != null) return -1;
      if (av != null && bv != null) {
        const primary = sign * (av - bv);
        if (primary) return primary;
      }
    }
    if (sortKey === "iPts") {
      const gd = sign * ((a.iGd ?? 0) - (b.iGd ?? 0));
      if (gd) return gd;
      const gf = sign * ((a.iGf ?? 0) - (b.iGf ?? 0));
      if (gf) return gf;
    }
    const pointsDir = sortKey === "points" ? sign : -1;
    const points = pointsDir * (a.points - b.points);
    if (points) return points;
    const tsDir = sortKey === "points" || sortKey === "ts" ? sign : -1;
    const ts = tsDir * (a.ts - b.ts);
    if (ts) return ts;
    return a.teamName.localeCompare(b.teamName, "en");
  });
}

/** Season-ideal (live 6) wins; extra leagues fall back to mantra-ideal-table TS. */
export function mergeIdealTsSources(
  season: {
    byTeamId: Map<number, number>;
    realByTeamId?: Map<number, number>;
    rounds: string[];
  },
  table: { byTeamId: Map<number, number>; rounds: string[] },
): {
  byTeamId: Map<number, number>;
  realByTeamId?: Map<number, number>;
  rounds: string[];
} {
  const byTeamId = new Map(table.byTeamId);
  for (const [id, ts] of season.byTeamId) byTeamId.set(id, ts);
  return {
    byTeamId,
    realByTeamId: season.realByTeamId,
    rounds: season.rounds.length ? season.rounds : table.rounds,
  };
}

export function withIdealTs(
  view: StandingsView,
  ideal: {
    byTeamId: Map<number, number>;
    realByTeamId?: Map<number, number>;
    rounds: string[];
  },
): StandingsView {
  return {
    ...view,
    idealRounds: [...ideal.rounds],
    rows: view.rows.map((row) => {
      const idealTs = ideal.byTeamId.get(row.teamId);
      // 0 is a failed Ideal pick (no legal XI), not a scored 0.00 — UI must show —.
      const hasIdeal = idealTs != null && Number.isFinite(idealTs) && idealTs > 0;
      return {
        ...row,
        idealTs: hasIdeal ? idealTs! : null,
        // Mantra standings TS column / season Ideal TS — not Live Real XI / Ideal XI.
        idealPct: hasIdeal ? realOverIdealPct(row.ts, idealTs!) : null,
      };
    }),
  };
}

export type IdealTableStats = {
  gf: number;
  ga: number;
  gd: number;
  points: number;
};

/** Join Ideal division GF/GA/GD/POINTS onto combined rows. Missing → null, not 0. */
export function withIdealTableStats(
  view: StandingsView,
  byTeamId: Map<number, IdealTableStats>,
): StandingsView {
  return {
    ...view,
    rows: view.rows.map((row) => {
      const stats = byTeamId.get(row.teamId);
      if (!stats) {
        return { ...row, iGf: null, iGa: null, iGd: null, iPts: null };
      }
      return {
        ...row,
        iGf: stats.gf,
        iGa: stats.ga,
        iGd: stats.gd,
        iPts: stats.points,
      };
    }),
  };
}

export function mergeDivisionStandings(
  divisions: Array<{ def: MantraDivisionDef; raw: unknown }>,
): StandingsRow[] {
  const merged: StandingsRow[] = [];
  for (const { def, raw } of divisions) {
    const parsed = parseDivisionResults(raw, def);
    const byId = new Map(parsed.map((row) => [row.teamId, row]));
    for (const row of parsed) {
      const next = row.nextTeamId != null ? byId.get(row.nextTeamId) : undefined;
      merged.push({
        ...row,
        rank: 0,
        nextTeamName: next?.teamName ?? null,
        nextTeamLogo: next?.teamLogo ?? null,
      });
    }
  }
  merged.sort(compareStandings);
  return merged.map((row, index) => ({ ...row, rank: index + 1 }));
}

function readCached(key: string, database?: Database.Database): CachedStandings | undefined {
  const mem = memory.get(key);
  if (mem) return mem;
  const fromMemCache = peekComputed<CachedStandings>(key);
  if (fromMemCache?.fetchedAt && fromMemCache.view) {
    memory.set(key, fromMemCache);
    return fromMemCache;
  }
  const fromDb = peekComputedPersisted<CachedStandings>(key, { database });
  if (fromDb?.fetchedAt && fromDb.view) {
    memory.set(key, fromDb);
    return fromDb;
  }
  return undefined;
}

function storeCached(
  key: string,
  cached: CachedStandings,
  database?: Database.Database,
): void {
  memory.set(key, cached);
  writeComputed(key, "v1", cached, { database });
}

function snapshotIsComplete(cached: CachedStandings): boolean {
  if (cached.view.failedDivisions?.length) return false;
  const league = liveLeagueBySlug(cached.view.league);
  if (!league) return false;
  const present = new Set(cached.view.rows.map((row) => row.division));
  return league.mantraDivisions.every((def) => present.has(divisionLabel(def)));
}

function isFresh(cached: CachedStandings, nowMs: number): boolean {
  if (!snapshotIsComplete(cached)) return false;
  const t = Date.parse(cached.fetchedAt);
  return Number.isFinite(t) && nowMs - t < STANDINGS_TTL_MS;
}

function withCatalog(
  cached: CachedStandings,
  cache: StandingsView["cache"],
): StandingsView {
  return {
    ...cached.view,
    cache,
    idealRounds: cached.view.idealRounds ?? [],
    leagues: standingsLeagues(),
    divisionOptions: standingsDivisionOptions(cached.view.league),
  };
}

async function fetchDivisionResults(
  def: MantraDivisionDef,
  fetchResults: (leagueId: number) => Promise<unknown>,
): Promise<{ raw: unknown } | { error: string }> {
  let lastError = "empty_results";
  for (let attempt = 1; attempt <= DIVISION_FETCH_ATTEMPTS; attempt++) {
    try {
      const raw = await fetchResults(def.leagueId);
      if (parseDivisionResults(raw, def).length > 0) return { raw };
      lastError = "empty_results";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { error: lastError };
}

async function fetchChampionship(
  slug: string,
  deps: StandingsDeps,
): Promise<CachedStandings> {
  const league = liveLeagueBySlug(slug);
  if (!league) throw new Error(`unknown_standings_league:${slug}`);
  const fetchResults = deps.fetchResults ?? fetchLeagueResults;
  const failedDivisions: StandingsView["failedDivisions"] = [];
  const packed: Array<{ def: MantraDivisionDef; raw: unknown }> = [];
  const key = cacheKey(league.slug);
  const extra = isTablesExtraSlug(league.slug);

  const snapshot = (lastDivisionId: number | null): CachedStandings => {
    const rows = mergeDivisionStandings(packed);
    const roundScoresByTeam: Record<string, MantraRoundScore[]> = {};
    for (const { raw } of packed) {
      Object.assign(roundScoresByTeam, parseDivisionRoundScores(raw));
    }
    const fetchedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
    const cached: CachedStandings = {
      fetchedAt,
      roundScoresByTeam,
      view: {
        ok: rows.length > 0 || failedDivisions.length === 0,
        empty: rows.length === 0,
        league: league.slug,
        name: league.name,
        fetchedAt,
        divisions: league.mantraDivisions.length,
        teams: rows.length,
        failedDivisions: [...failedDivisions],
        rows,
        idealRounds: [],
      },
    };
    if (extra) {
      storeCached(key, cached, deps.database);
      writeTablesJobProgress(league.slug, {
        status: "running",
        phase: "results",
        lastDivisionId,
      });
    }
    return cached;
  };

  for (const def of league.mantraDivisions) {
    const result = await fetchDivisionResults(def, fetchResults);
    if ("raw" in result) packed.push({ def, raw: result.raw });
    else {
      failedDivisions.push({
        leagueId: def.leagueId,
        division: divisionLabel(def),
        error: result.error,
      });
    }
    if (extra) snapshot(def.leagueId);
  }
  return snapshot(packed.at(-1)?.def.leagueId ?? null);
}

function emptyCatalogView(
  league: NonNullable<ReturnType<typeof liveLeagueBySlug>>,
  cache: StandingsView["cache"],
): StandingsView {
  return {
    ok: true,
    empty: true,
    league: league.slug,
    name: league.name,
    cache,
    fetchedAt: "",
    divisions: league.mantraDivisions.length,
    teams: 0,
    failedDivisions: [],
    rows: [],
    idealRounds: [],
    leagues: standingsLeagues(),
    divisionOptions: standingsDivisionOptions(league.slug),
  };
}

function enqueueRebuild(key: string, slug: string, deps: StandingsDeps): void {
  if (inflight.has(key)) return;
  const schedule = deps.schedule ?? scheduleRebuild;
  schedule(async () => {
    if (inflight.has(key)) return;
    const pending = fetchChampionship(slug, deps).then((cached) => {
      storeCached(key, cached, deps.database);
      return cached;
    });
    inflight.set(key, pending);
    try {
      await pending;
    } catch (error) {
      console.warn(
        `standings rebuild ${slug} failed:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      inflight.delete(key);
    }
  });
}

export async function getChampionshipStandings(
  slug: string | null | undefined,
  deps: StandingsDeps = {},
): Promise<StandingsView> {
  const league = resolveStandingsLeague(slug);
  if (!league) {
    const requested = String(slug || "").trim();
    return {
      ok: false,
      empty: true,
      league: requested,
      name: requested,
      cache: "miss",
      fetchedAt: "",
      divisions: 0,
      teams: 0,
      failedDivisions: [],
      rows: [],
      idealRounds: [],
      leagues: standingsLeagues(),
      divisionOptions: [],
    };
  }
  const nowMs = deps.now?.() ?? Date.now();
  const key = cacheKey(league.slug);
  const cached = readStandingsCached(league.slug, deps.database);
  if (cached && isFresh(cached, nowMs)) {
    return withCatalog(cached, "hit");
  }

  const serveStale = deps.serveStale !== false;
  if (cached && serveStale) {
    enqueueRebuild(key, league.slug, deps);
    return withCatalog(cached, "stale");
  }

  const waitOnMiss = deps.fetchResults != null || !isTablesExtraSlug(league.slug);
  const existing = inflight.get(key);
  if (existing) {
    if (!waitOnMiss) {
      return cached ? withCatalog(cached, "stale") : emptyCatalogView(league, "miss");
    }
    return withCatalog(await existing, cached ? "stale" : "miss");
  }

  if (!waitOnMiss) {
    return cached ? withCatalog(cached, "stale") : emptyCatalogView(league, "miss");
  }

  const pending = fetchChampionship(league.slug, deps).then((next) => {
    storeCached(key, next, deps.database);
    return next;
  });
  inflight.set(key, pending);
  try {
    return withCatalog(await pending, "miss");
  } finally {
    inflight.delete(key);
  }
}
