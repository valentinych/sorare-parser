/**
 * Sync Mantra division tours (realtime fantasy scores) per Live league.
 * Requires MANTRA_EMAIL / MANTRA_PASSWORD when fetching live.
 * Also reads/writes data/mantra-tours[-{slug}].json as fallback (e.g. prod can't reach Mantra).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  fetchMantraTour,
  fetchMantraToursForDivisions,
  mantraCredentialsConfigured,
  type MantraTourRound,
} from "../clients/mantraAuth.js";
import { getDb, setMeta } from "../db/index.js";
import {
  DEFAULT_LIVE_SLUG,
  isTablesExtraSlug,
  liveLeagueBySlug,
  liveRoundMetaKey,
  mantraFileSuffix,
  mantraToursMetaKey,
  mantraToursSyncedMetaKey,
  mantraToursAreLocked,
  mantraToursHaveActiveDeadline,
  preferMantraMatchRound,
  resolveLiveLeague,
  tourHasFirstKickoff,
  type LiveLeagueDef,
} from "../lib/liveLeagues.js";

export type MantraToursSyncResult = {
  ok: boolean;
  slug: string;
  divisions: number;
  matches: number;
  live: number;
  syncedAt: string | null;
  error: string | null;
  source?: "live" | "file" | "db" | "none";
};

type LeagueCache = {
  tours: MantraTourRound[] | null;
  syncedAt: string | null;
  lastError: string | null;
};

const caches = new Map<string, LeagueCache>();

function cacheFor(slug: string): LeagueCache {
  let c = caches.get(slug);
  if (!c) {
    c = { tours: null, syncedAt: null, lastError: null };
    caches.set(slug, c);
  }
  return c;
}

function dataDir(): string {
  const dbPath = process.env.DB_PATH ?? "data/app.db";
  return path.dirname(path.resolve(dbPath));
}

function toursFilePath(slug: string): string {
  return path.join(dataDir(), `mantra-tours${mantraFileSuffix(slug)}.json`);
}

function toursArchivePath(slug: string, round: string | number): string {
  return path.join(dataDir(), `mantra-tours${mantraFileSuffix(slug)}-r${round}.json`);
}

function tourRoundOf(tours: MantraTourRound[]): number | null {
  return tours.find((t) => t.round != null)?.round ?? null;
}

function archiveTours(
  slug: string,
  tours: MantraTourRound[],
  syncedAt: string | null,
): void {
  const round = tourRoundOf(tours);
  if (round == null) return;
  try {
    const dest = toursArchivePath(slug, round);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify({ syncedAt, tours, round, slug }, null, 2));
  } catch (err) {
    console.warn(
      "Could not archive Mantra tours:",
      err instanceof Error ? err.message : err,
    );
  }
}

function isNotFoundTourError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /→ 404\b/.test(msg);
}

function readToursArchive(
  slug: string,
  round: string | number,
): MantraTourRound[] | null {
  try {
    const raw = readFileSync(toursArchivePath(slug, round), "utf8");
    const parsed = JSON.parse(raw) as { tours?: MantraTourRound[] };
    if (Array.isArray(parsed.tours) && parsed.tours.length) return parsed.tours;
  } catch {
    /* missing */
  }
  return null;
}

function archiveHasDivision(
  slug: string,
  round: number,
  leagueId: number,
): boolean {
  const tours = readToursArchive(slug, round);
  if (!tours) return false;
  return tours.some(
    (tour) => tour.leagueId === leagueId && Number(tour.round) === Number(round),
  );
}

/** Merge division pages into per-round archive files. Does not touch the live tours file. */
function mergeToursArchives(
  slug: string,
  tours: MantraTourRound[],
  syncedAt: string | null,
): number[] {
  const byRound = new Map<number, MantraTourRound[]>();
  for (const tour of tours) {
    if (tour.round == null) continue;
    const list = byRound.get(tour.round) ?? [];
    list.push(tour);
    byRound.set(tour.round, list);
  }
  const written: number[] = [];
  for (const [round, group] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    const existing = readToursArchive(slug, round) ?? [];
    const byLeagueId = new Map<number, MantraTourRound>();
    for (const tour of existing) {
      if (tour.leagueId != null) byLeagueId.set(tour.leagueId, tour);
    }
    for (const tour of group) {
      if (tour.leagueId != null) byLeagueId.set(tour.leagueId, tour);
    }
    const merged = byLeagueId.size
      ? [...byLeagueId.values()]
      : group;
    archiveTours(slug, merged, syncedAt);
    written.push(round);
  }
  return written;
}

export type HistoricalTourFetch = (
  tourId: number,
  meta: { leagueId?: number; division?: string; name?: string },
) => Promise<MantraTourRound>;

export type HistoricalToursArchiveResult = {
  slug: string;
  currentRound: number | null;
  archivedRounds: number[];
  skippedExisting: number[];
  missingRounds: number[];
  fetched: number;
  error: string | null;
};

/**
 * Walk tourId backwards (ids increment by 1 per GW) for /tables extra leagues.
 * Writes mantra-tours-{slug}-rN.json only — never the live file or original six.
 */
export async function archiveHistoricalMantraTours(
  slug: string,
  opts: {
    wantedRounds?: number[];
    fetchTour?: HistoricalTourFetch;
  } = {},
): Promise<HistoricalToursArchiveResult> {
  const empty = (
    error: string,
    currentRound: number | null = null,
  ): HistoricalToursArchiveResult => ({
    slug,
    currentRound,
    archivedRounds: [],
    skippedExisting: [],
    missingRounds: [...new Set(opts.wantedRounds ?? [])].sort((a, b) => a - b),
    fetched: 0,
    error,
  });
  if (!isTablesExtraSlug(slug)) return empty("not a tables extra league");
  const def = liveLeagueBySlug(slug);
  if (!def) return empty("unknown league");

  const live = getMantraToursCached(slug);
  const currentRound = tourRoundOf(live.tours);
  if (!live.tours.length || currentRound == null) {
    return empty("no current tours", currentRound);
  }

  const archived = new Set<number>();
  const skipped = new Set<number>();
  let fetched = 0;

  const fromLive = mergeToursArchives(slug, live.tours, live.syncedAt);
  for (const round of fromLive) archived.add(round);

  const byLeagueId = new Map<number, MantraTourRound>();
  for (const tour of live.tours) {
    if (tour.leagueId != null) byLeagueId.set(tour.leagueId, tour);
  }

  const fetchTour = opts.fetchTour ?? fetchMantraTour;
  const wanted = [
    ...new Set(
      (opts.wantedRounds ??
        Array.from({ length: Math.max(0, currentRound - 1) }, (_, i) => i + 1)
      )
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 1),
    ),
  ].sort((a, b) => a - b);

  for (const round of wanted) {
    const pages: MantraTourRound[] = [];
    for (const division of def.mantraDivisions) {
      const current = byLeagueId.get(division.leagueId);
      if (!current || current.round == null) continue;
      if (Number(current.round) === Number(round)) continue;
      if (archiveHasDivision(slug, round, division.leagueId)) {
        skipped.add(round);
        continue;
      }
      const offset = Number(current.round) - Number(round);
      if (offset <= 0) continue;
      const tourId = current.tourId - offset;
      if (tourId <= 0) continue;
      try {
        const page = await fetchTour(tourId, {
          leagueId: division.leagueId,
          division: division.division,
          name: division.name,
        });
        fetched += 1;
        pages.push(page);
      } catch (err) {
        if (isNotFoundTourError(err)) continue;
        console.warn(
          `historical tour ${slug} ${division.division || division.name} ${tourId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (pages.length) {
      for (const written of mergeToursArchives(slug, pages, new Date().toISOString())) {
        archived.add(written);
        console.log(
          `Archived Mantra tours ${slug} round ${written} (${readToursArchive(slug, written)?.length ?? 0} divisions)`,
        );
      }
    }
  }

  const missingRounds = wanted.filter((round) => !readToursArchive(slug, round));
  return {
    slug,
    currentRound,
    archivedRounds: [...archived].sort((a, b) => a - b),
    skippedExisting: [...skipped].sort((a, b) => a - b),
    missingRounds,
    fetched,
    error: null,
  };
}

/** True when FotMob shows the first match of this (or current Live) round has kicked off. */
export function fotmobRoundHasKickedOff(
  league?: string | null,
  round?: string | number | null,
): boolean {
  const def = resolveLiveLeague(league);
  const db = getDb();
  let want =
    round != null && String(round).trim() !== "" ? String(round) : null;
  if (!want) {
    const meta = db
      .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
      .get(liveRoundMetaKey(def.slug)) as { value: string } | undefined;
    want = meta?.value?.trim() ? meta.value : null;
  }
  if (!want) return false;
  try {
    const rows = db
      .prepare(
        `SELECT phase, kickoff, status_short FROM fotmob_matches
         WHERE league_id = ? AND round = ?`,
      )
      .all(def.fotmobLeagueId, want) as Array<{
      phase: string | null;
      kickoff: string | null;
      status_short: string | null;
    }>;
    return tourHasFirstKickoff(rows);
  } catch {
    return false;
  }
}

function applyMantraLiveRound(slug: string, tours: MantraTourRound[]): void {
  const row = getDb()
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(liveRoundMetaKey(slug)) as { value: string } | undefined;
  const mantraRound = tourRoundOf(tours);
  const next = preferMantraMatchRound(
    row?.value ?? null,
    mantraRound,
    mantraToursAreLocked(tours) || fotmobRoundHasKickedOff(slug, mantraRound),
    mantraToursHaveActiveDeadline(tours),
  );
  if (next && next !== (row?.value ?? null)) {
    setMeta(liveRoundMetaKey(slug), next);
    console.log(`Live round [${slug}] → ${next} (Mantra match tour)`);
  }
}

function persistTours(slug: string, tours: MantraTourRound[], syncedAt: string): void {
  const prev = loadFromFile(slug);
  const prevRound = prev ? tourRoundOf(prev.tours) : null;
  const nextRound = tourRoundOf(tours);
  if (
    prev?.tours?.length &&
    prevRound != null &&
    nextRound != null &&
    String(prevRound) !== String(nextRound)
  ) {
    archiveTours(slug, prev.tours, prev.syncedAt);
    console.log(
      `Archived Mantra tours ${slug} round ${prevRound} before syncing round ${nextRound}`,
    );
  }

  const c = cacheFor(slug);
  c.tours = tours;
  c.syncedAt = syncedAt;
  setMeta(mantraToursMetaKey(slug), JSON.stringify(tours));
  setMeta(mantraToursSyncedMetaKey(slug), syncedAt);
  try {
    const file = toursFilePath(slug);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ syncedAt, tours, slug }, null, 2));
    archiveTours(slug, tours, syncedAt);
  } catch (err) {
    console.warn(
      `Could not write mantra-tours${mantraFileSuffix(slug)}.json:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function loadFromFile(
  slug: string,
): { tours: MantraTourRound[]; syncedAt: string | null } | null {
  try {
    const raw = readFileSync(toursFilePath(slug), "utf8");
    const parsed = JSON.parse(raw) as { syncedAt?: string; tours?: MantraTourRound[] };
    if (!Array.isArray(parsed.tours)) return null;
    return { tours: parsed.tours, syncedAt: parsed.syncedAt ?? null };
  } catch {
    return null;
  }
}

function loadFromDb(
  slug: string,
): { tours: MantraTourRound[]; syncedAt: string | null } | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(mantraToursMetaKey(slug)) as { value: string } | undefined;
  const synced = db
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(mantraToursSyncedMetaKey(slug)) as { value: string } | undefined;
  if (!row?.value) return null;
  try {
    const tours = JSON.parse(row.value) as MantraTourRound[];
    if (!Array.isArray(tours)) return null;
    return { tours, syncedAt: synced?.value ?? null };
  } catch {
    return null;
  }
}

function summary(
  slug: string,
  tours: MantraTourRound[],
  syncedAt: string | null,
  ok: boolean,
  error: string | null,
  source: MantraToursSyncResult["source"],
): MantraToursSyncResult {
  return {
    ok,
    slug,
    divisions: tours.length,
    matches: tours.reduce((n, t) => n + t.matches.length, 0),
    live: tours.filter((t) => t.live).length,
    syncedAt,
    error,
    source,
  };
}

function resolveSlug(league?: string | LiveLeagueDef | null): string {
  if (league && typeof league === "object") return league.slug;
  return resolveLiveLeague(league).slug;
}

function peekToursSyncedAt(slug: string): string | null {
  try {
    const row = getDb()
      .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
      .get(mantraToursSyncedMetaKey(slug)) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * In-process cache must refresh when live-poll writes a newer file/DB stamp.
 * Web (LIVE_POLLER=0) never calls syncMantraTours — without this, GET /live
 * serves forever-stale tour card scores after the first load.
 */
export function getMantraToursCached(league?: string | null): {
  tours: MantraTourRound[];
  syncedAt: string | null;
  error: string | null;
  slug: string;
} {
  const slug = resolveSlug(league);
  const c = cacheFor(slug);
  const diskSynced = peekToursSyncedAt(slug);
  if (
    c.tours &&
    c.syncedAt &&
    diskSynced &&
    c.syncedAt === diskSynced
  ) {
    return { tours: c.tours, syncedAt: c.syncedAt, error: c.lastError, slug };
  }

  const fromFile = loadFromFile(slug);
  if (fromFile?.tours.length) {
    // Prefer file when memory is empty, older than disk, or meta is ahead of memory.
    const fileNewer =
      !c.tours ||
      !c.syncedAt ||
      (fromFile.syncedAt != null && fromFile.syncedAt > c.syncedAt) ||
      (diskSynced != null && (!c.syncedAt || diskSynced > c.syncedAt));
    if (fileNewer) {
      c.tours = fromFile.tours;
      c.syncedAt = fromFile.syncedAt;
    }
    if (c.tours) {
      return { tours: c.tours, syncedAt: c.syncedAt, error: c.lastError, slug };
    }
  }

  if (c.tours) {
    return { tours: c.tours, syncedAt: c.syncedAt, error: c.lastError, slug };
  }

  const fromDb = loadFromDb(slug);
  if (fromDb) {
    c.tours = fromDb.tours;
    c.syncedAt = fromDb.syncedAt;
  }
  return { tours: c.tours ?? [], syncedAt: c.syncedAt, error: c.lastError, slug };
}

/** Test helper: drop in-process tours cache (multi-process freshness tests). */
export function resetMantraToursCacheForTests(): void {
  caches.clear();
}

/** Load tours for a specific Mantra/FotMob round (archive if not the live file). */
export function getMantraToursForRound(
  round?: string | number | null,
  league?: string | null,
): {
  tours: MantraTourRound[];
  syncedAt: string | null;
  error: string | null;
  round: number | null;
  slug: string;
} {
  const live = getMantraToursCached(league);
  const liveRound = tourRoundOf(live.tours);
  if (round == null || round === "") {
    return { ...live, round: liveRound };
  }
  const want = String(round);
  if (liveRound != null && String(liveRound) === want) {
    return { ...live, round: liveRound };
  }
  try {
    const raw = readFileSync(toursArchivePath(live.slug, want), "utf8");
    const parsed = JSON.parse(raw) as {
      syncedAt?: string;
      tours?: MantraTourRound[];
    };
    if (Array.isArray(parsed.tours) && parsed.tours.length) {
      return {
        tours: parsed.tours,
        syncedAt: parsed.syncedAt ?? null,
        error: live.error,
        round: tourRoundOf(parsed.tours),
        slug: live.slug,
      };
    }
  } catch {
    /* fall through */
  }
  // Same fantasy teams across tours — use live list for Ideal team roster if archive missing.
  return { ...live, round: liveRound };
}

/** Prefer live Mantra fetch; on network failure keep/reload file or DB cache. */
export async function syncMantraTours(
  league?: string | null,
): Promise<MantraToursSyncResult> {
  const def = resolveLiveLeague(league);
  const slug = def.slug;
  const c = cacheFor(slug);

  if (mantraCredentialsConfigured()) {
    try {
      const tours = await fetchMantraToursForDivisions(def.mantraDivisions, {
        kickedOffRound: (round) => fotmobRoundHasKickedOff(slug, round),
      });
      const syncedAt = new Date().toISOString();
      c.lastError = null;
      persistTours(slug, tours, syncedAt);
      applyMantraLiveRound(slug, tours);
      console.log(
        `Mantra tours [${slug}]: ${tours.length} divisions, ${tours.reduce((n, t) => n + t.matches.length, 0)} matches (live fetch)`,
      );
      return summary(slug, tours, syncedAt, true, null, "live");
    } catch (err) {
      c.lastError = err instanceof Error ? err.message : String(err);
      console.warn(`Mantra tours [${slug}] live fetch failed:`, c.lastError);
    }
  } else {
    c.lastError = "MANTRA_EMAIL / MANTRA_PASSWORD not set";
  }

  const fromFile = loadFromFile(slug);
  if (fromFile?.tours.length) {
    c.tours = fromFile.tours;
    c.syncedAt = fromFile.syncedAt;
    applyMantraLiveRound(slug, fromFile.tours);
    console.log(
      `Mantra tours [${slug}]: loaded ${fromFile.tours.length} divisions from file cache`,
    );
    return summary(slug, fromFile.tours, fromFile.syncedAt, true, c.lastError, "file");
  }

  const fromDb = loadFromDb(slug);
  if (fromDb?.tours.length) {
    c.tours = fromDb.tours;
    c.syncedAt = fromDb.syncedAt;
    applyMantraLiveRound(slug, fromDb.tours);
    console.log(
      `Mantra tours [${slug}]: loaded ${fromDb.tours.length} divisions from DB cache`,
    );
    return summary(slug, fromDb.tours, fromDb.syncedAt, true, c.lastError, "db");
  }

  return summary(slug, [], null, false, c.lastError, "none");
}

/** Sync all Live leagues' Mantra tours (used by deploy + poller). */
export async function syncAllMantraTours(): Promise<MantraToursSyncResult[]> {
  const { allLiveLeagues } = await import("../lib/liveLeagues.js");
  const out: MantraToursSyncResult[] = [];
  for (const league of allLiveLeagues()) {
    out.push(await syncMantraTours(league.slug));
  }
  return out;
}

/** Default slug helper for callers that still omit league. */
export function defaultMantraToursSlug(): string {
  return DEFAULT_LIVE_SLUG;
}
