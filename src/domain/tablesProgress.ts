/**
 * Honest /tables load progress: Mantra results, player list, FotMob sheets, tours.
 * Job meta is a checkpoint; GET recomputes from DB so a restart cannot claim 100%.
 */
import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import { peekComputedPersisted } from "../lib/computedCache.js";
import {
  isTablesExtraSlug,
  liveLeagueBySlug,
  type LiveLeagueDef,
} from "../lib/liveLeagues.js";

const STANDINGS_CACHE_PREFIX = "mantra-standings:v3:";

export const TABLES_PROGRESS_META_PREFIX = "tables_backfill:";

export type TablesProgressPhase =
  | "idle"
  | "leagues"
  | "players"
  | "results"
  | "fotmob"
  | "tours"
  | "done";

export type TablesProgressCounts = {
  divisionsDone: number;
  divisionsTotal: number;
  resultsDone: number;
  resultsTotal: number;
  playersListed: number;
  fotmobMatches: number;
  fotmobFinished: number;
  fotmobSheets: number;
  toursDivisions: number;
};

export type TablesLeagueProgress = {
  slug: string;
  name: string;
  percent: number;
  complete: boolean;
  status: "idle" | "running" | "done" | "error";
  phase: TablesProgressPhase;
  label: string;
  error: string | null;
  updatedAt: string;
  lastDivisionId: number | null;
  lastFotmobMatchId: number | null;
} & TablesProgressCounts;

export type TablesJobCheckpoint = {
  status: "idle" | "running" | "done" | "error";
  phase: TablesProgressPhase;
  label?: string;
  error?: string | null;
  lastDivisionId?: number | null;
  lastFotmobMatchId?: number | null;
  updatedAt?: string;
};

type StandingsPeek = {
  view?: { rows?: Array<{ division?: string; leagueId?: number }> };
};

function nowIso(): string {
  return new Date().toISOString();
}

function metaKey(slug: string): string {
  return `${TABLES_PROGRESS_META_PREFIX}${slug}`;
}

function readMeta(key: string, database?: Database.Database): string | null {
  const row = (database ?? getDb())
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function readTablesJobCheckpoint(
  slug: string,
  database?: Database.Database,
): TablesJobCheckpoint | null {
  const raw = readMeta(metaKey(slug), database);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TablesJobCheckpoint;
  } catch {
    return null;
  }
}

export function writeTablesJobProgress(
  slug: string,
  patch: TablesJobCheckpoint,
  database?: Database.Database,
): TablesJobCheckpoint {
  const prev = readTablesJobCheckpoint(slug, database) ?? {
    status: "idle" as const,
    phase: "idle" as const,
  };
  const next: TablesJobCheckpoint = {
    ...prev,
    ...patch,
    updatedAt: nowIso(),
  };
  try {
    const db = database ?? getDb();
    db.prepare(
      `INSERT INTO sync_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(metaKey(slug), JSON.stringify(next));
  } catch {
    // Progress is best-effort; standings fetch must not fail if sync_meta is missing.
  }
  return next;
}

function tableExists(database: Database.Database, name: string): boolean {
  const row = database
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function countQuery(
  database: Database.Database,
  sql: string,
  params: unknown[],
): number {
  try {
    const row = database.prepare(sql).get(...params) as { n: number } | undefined;
    return Number(row?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}

function standingsDivisionsDone(slug: string, league: LiveLeagueDef, database?: Database.Database): number {
  const cached = peekComputedPersisted<StandingsPeek>(`${STANDINGS_CACHE_PREFIX}${slug}`, {
    database,
  });
  const rows = cached?.view?.rows ?? [];
  const wanted = new Set(
    league.mantraDivisions.map((def) =>
      def.division && def.name ? `${def.division} | ${def.name}` : def.division || def.name || String(def.leagueId),
    ),
  );
  // Rows store divisionLabel (code or name) plus leagueId.
  const present = new Set<number>();
  for (const row of rows) {
    const id = Number(row.leagueId);
    if (Number.isSafeInteger(id) && id > 0) present.add(id);
  }
  if (present.size) {
    return league.mantraDivisions.filter((def) => present.has(def.leagueId)).length;
  }
  const labels = new Set(rows.map((row) => String(row.division || "")));
  return league.mantraDivisions.filter((def) => {
    const code = String(def.division || "").trim() || def.name || String(def.leagueId);
    return labels.has(code) || wanted.has(code);
  }).length;
}

function countToursDivisions(slug: string, database?: Database.Database): number {
  const db = database ?? getDb();
  const key = slug === "ekstraklasa" ? "mantra_tours_json" : `mantra_tours_json:${slug}`;
  const raw = readMeta(key, db);
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { tours?: unknown[] } | unknown[];
    const tours = Array.isArray(parsed) ? parsed : parsed.tours;
    return Array.isArray(tours) ? tours.length : 0;
  } catch {
    return 0;
  }
}

export function measureTablesProgress(
  slug: string,
  database?: Database.Database,
): TablesProgressCounts | null {
  const league = liveLeagueBySlug(slug);
  if (!league) return null;
  const db = database ?? getDb();
  const divisionsTotal = league.mantraDivisions.length;
  const resultsDone = standingsDivisionsDone(slug, league, db);
  const tournamentId = league.mantraTournamentId;
  const playersListed =
    tournamentId != null && tableExists(db, "mantra_players")
      ? countQuery(
          db,
          `SELECT COUNT(*) AS n FROM mantra_players
           WHERE tournament_id = ? OR (? = 18 AND tournament_id IS NULL)`,
          [tournamentId, tournamentId],
        )
      : 0;
  const fotmobId = league.fotmobLeagueId;
  const hasMatches = tableExists(db, "fotmob_matches");
  const fotmobMatches = hasMatches
    ? countQuery(db, `SELECT COUNT(*) AS n FROM fotmob_matches WHERE league_id = ?`, [fotmobId])
    : 0;
  const fotmobFinished = hasMatches
    ? countQuery(
        db,
        `SELECT COUNT(*) AS n FROM fotmob_matches WHERE league_id = ? AND phase = 'finished'`,
        [fotmobId],
      )
    : 0;
  const fotmobSheets = hasMatches
    ? countQuery(
        db,
        `SELECT COUNT(*) AS n FROM fotmob_matches
         WHERE league_id = ? AND phase = 'finished' AND details_synced_at IS NOT NULL`,
        [fotmobId],
      )
    : 0;
  return {
    divisionsDone: resultsDone,
    divisionsTotal,
    resultsDone,
    resultsTotal: divisionsTotal,
    playersListed,
    fotmobMatches,
    fotmobFinished,
    fotmobSheets,
    toursDivisions: countToursDivisions(slug, db),
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function percentFromCounts(counts: TablesProgressCounts): number {
  const results =
    counts.resultsTotal > 0 ? counts.resultsDone / counts.resultsTotal : 0;
  const players = counts.playersListed > 0 ? 1 : 0;
  const fixtures = counts.fotmobMatches > 0 ? 1 : 0;
  const sheets =
    counts.fotmobFinished > 0 ? counts.fotmobSheets / counts.fotmobFinished : fixtures;
  const tours =
    counts.divisionsTotal > 0
      ? Math.min(1, counts.toursDivisions / counts.divisionsTotal)
      : 0;
  return clampPercent(100 * (0.45 * results + 0.15 * players + 0.15 * fixtures + 0.15 * sheets + 0.1 * tours));
}

function progressLabel(counts: TablesProgressCounts, job: TablesJobCheckpoint | null): string {
  const parts = [
    `дивизионы ${counts.resultsDone}/${counts.resultsTotal}`,
    `игроки ${counts.playersListed}`,
    `матчи ${counts.fotmobSheets}/${counts.fotmobFinished || counts.fotmobMatches}`,
    `туры ${counts.toursDivisions}/${counts.divisionsTotal}`,
  ];
  if (job?.phase && job.phase !== "idle" && job.phase !== "done") {
    return `${job.phase} · ${parts.join(" · ")}`;
  }
  return parts.join(" · ");
}

export function getTablesLeagueProgress(
  slug: string,
  database?: Database.Database,
): TablesLeagueProgress | null {
  const league = liveLeagueBySlug(slug);
  if (!league) return null;
  const counts = measureTablesProgress(slug, database);
  if (!counts) return null;
  const job = readTablesJobCheckpoint(slug, database);
  const percent = percentFromCounts(counts);
  const resultsComplete = counts.resultsTotal > 0 && counts.resultsDone >= counts.resultsTotal;
  const sheetsComplete = counts.fotmobFinished === 0 || counts.fotmobSheets >= counts.fotmobFinished;
  const complete =
    resultsComplete && counts.playersListed > 0 && counts.fotmobMatches > 0 && sheetsComplete;
  const status = job?.status ?? (complete ? "done" : "idle");
  return {
    slug: league.slug,
    name: league.name,
    percent: complete ? 100 : percent,
    complete,
    status: complete && status === "running" ? "running" : status,
    phase: job?.phase ?? (complete ? "done" : "idle"),
    label: progressLabel(counts, job),
    error: job?.error ?? null,
    updatedAt: job?.updatedAt ?? nowIso(),
    lastDivisionId: job?.lastDivisionId ?? null,
    lastFotmobMatchId: job?.lastFotmobMatchId ?? null,
    ...counts,
  };
}

export function tablesProgressPayload(
  slug: string | null | undefined,
  database?: Database.Database,
): { league: string | null; progress: TablesLeagueProgress | null; extra: boolean } {
  const key = String(slug || "").trim().toLowerCase();
  if (!key) return { league: null, progress: null, extra: false };
  return {
    league: key,
    progress: getTablesLeagueProgress(key, database),
    extra: isTablesExtraSlug(key),
  };
}
