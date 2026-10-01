import type { FastifyInstance, FastifyRequest } from "fastify";
import { getLiveMatch, listLiveRound } from "../domain/liveMatches.js";
import { listFantasyTeams } from "../domain/managerTeam.js";
import { wantsHtmlPage } from "../lib/wantsHtmlPage.js";
import { isSpaReady, sendSpaPage } from "./spaPages.js";
import { currentUser } from "./account.js";
import { syncAllLiveRounds, type LiveSyncResult } from "../sync/syncLive.js";
import {
  fotmobRoundHasKickedOff,
  getMantraToursCached,
  getMantraToursForRound,
  syncMantraTours,
  type MantraToursSyncResult,
} from "../sync/syncMantraTours.js";
import { mantraCredentialsConfigured } from "../clients/mantraAuth.js";
import {
  computeMantraMatch,
  computeMantraMatchMap,
  invalidateMantraLiveScoreCache,
  slimMantraMatchMapForCards,
} from "../domain/mantraLiveScore.js";
import {
  computeDreamTeamOfRound,
  invalidateDreamTeamCache,
} from "../domain/dreamTeamRound.js";
import {
  computeIdealVsRealStandings,
  invalidateIdealVsRealCache,
} from "../domain/mantraIdealVsReal.js";
import {
  findMantraMatchInLineups,
  loadMantraLineups,
  syncMantraLineups,
} from "../sync/syncMantraLineups.js";
import { syncAllLiveMantraFotmobIds } from "../lib/mantraFotmobIds.js";
import { warmPremiumOddsJoin } from "../domain/expected11Premium.js";
import {
  allLiveLeagues,
  DEFAULT_LIVE_SLUG,
  liveRoundMetaKey,
  liveSyncedMetaKey,
  mantraToursHaveActiveDeadline,
  resolveLiveLeague,
} from "../lib/liveLeagues.js";
import { getDb } from "../db/index.js";

export const POLL_MS = 5 * 60 * 1000;
/** Cap a Mantra cycle so a hung fetch cannot hold the lock forever (prod incident). */
export const MANTRA_POLL_TIMEOUT_MS = 4 * 60 * 1000;

export type ExclusiveLock = { running: boolean };

const LIVE_COMPUTE = { blockOnMiss: false as const };

/** In-process FotMob kick from HTTP — off when workers own polling (LIVE_POLLER=0). */
function httpMayKickFotmob(): boolean {
  if (process.env.LIVE_HTTP_REFRESH === "1") return true;
  if (process.env.LIVE_HTTP_REFRESH === "0") return false;
  return process.env.LIVE_POLLER !== "0";
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let computeTimer: ReturnType<typeof setInterval> | null = null;
const fotmobLock: ExclusiveLock = { running: false };
const mantraLock: ExclusiveLock = { running: false };
const computeLock: ExclusiveLock = { running: false };
let lastSyncBySlug: Record<string, LiveSyncResult> = {};
let lastMantraSyncBySlug: Record<string, MantraToursSyncResult> = {};
let lastError: string | null = null;
let syncFotmobAll: () => Promise<LiveSyncResult[]> = syncAllLiveRounds;

function peekLiveRoundFromMeta(slug: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(liveRoundMetaKey(slug)) as { value: string } | undefined;
  const v = row?.value?.trim();
  return v || null;
}

function peekLiveSyncedFromMeta(slug: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(liveSyncedMetaKey(slug)) as { value: string } | undefined;
  return row?.value ?? null;
}

function pollStatusForSlug(slug: string) {
  const mem = lastSyncBySlug[slug];
  if (mem) return mem;
  const syncedAt = peekLiveSyncedFromMeta(slug);
  if (!syncedAt) return null;
  return {
    slug,
    fotmobLeagueId: resolveLiveLeague(slug).fotmobLeagueId,
    round: peekLiveRoundFromMeta(slug),
    listed: 0,
    refreshed: 0,
    live: 0,
    finished: 0,
    upcoming: 0,
    syncedAt,
  } satisfies LiveSyncResult;
}

export function setLiveFotmobSyncForTests(
  fn: (() => Promise<LiveSyncResult[]>) | null,
): void {
  syncFotmobAll = fn ?? syncAllLiveRounds;
}

export function resetLivePollerStateForTests(): void {
  fotmobLock.running = false;
  mantraLock.running = false;
  computeLock.running = false;
  lastSyncBySlug = {};
  lastMantraSyncBySlug = {};
  lastError = null;
  syncFotmobAll = syncAllLiveRounds;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (computeTimer) {
    clearInterval(computeTimer);
    computeTimer = null;
  }
}

/** Reject if `work` does not settle — used so exclusive locks cannot stick forever. */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Live ${label} poll timed out after ${ms}ms`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Independent locks so a hung Mantra cycle cannot skip the next FotMob pull. */
export async function withExclusiveLock<T>(
  lock: ExclusiveLock,
  work: () => Promise<T>,
  skipped: T,
  label?: string,
): Promise<{ value: T; skipped: boolean }> {
  if (lock.running) {
    if (label) console.log(`Live ${label} poll skipped (lock held)`);
    return { value: skipped, skipped: true };
  }
  lock.running = true;
  try {
    return { value: await work(), skipped: false };
  } finally {
    lock.running = false;
  }
}

function parseRoundQuery(q: unknown): string | null {
  if (q == null || q === "") return null;
  if (typeof q === "string" || typeof q === "number") return String(q);
  return null;
}

function parseLeagueQuery(q: unknown): string {
  if (typeof q === "string" && q.trim()) return resolveLiveLeague(q.trim()).slug;
  return DEFAULT_LIVE_SLUG;
}

export async function runFotmobPoll(reason: string): Promise<LiveSyncResult[]> {
  const { value, skipped } = await withExclusiveLock(
    fotmobLock,
    async () => {
      console.log(`Live FotMob poll (${reason})…`);
      const fotmobResults = await syncFotmobAll();
      for (const r of fotmobResults) lastSyncBySlug[r.slug] = r;
      invalidateMantraLiveScoreCache();
      invalidateDreamTeamCache();
      invalidateIdealVsRealCache();
      lastError = null;
      return fotmobResults;
    },
    Object.values(lastSyncBySlug),
    "FotMob",
  );
  if (!skipped) {
    // DB-only, after the FotMob lock. Do not await — GET /live must stay unblocked.
    void syncAllLiveMantraFotmobIds()
      .then(() => {
        invalidateMantraLiveScoreCache();
        invalidateDreamTeamCache();
        invalidateIdealVsRealCache();
      })
      .catch((err) => {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn("Live FotMob ID link failed:", lastError);
      });
  }
  return value;
}

export function kickFotmobRefresh(reason: string): void {
  if (!httpMayKickFotmob()) {
    console.log(`Live FotMob kick skipped (${reason}; workers own polling)`);
    return;
  }
  setImmediate(() => {
    void runFotmobPoll(reason).catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn("Live FotMob kick failed:", lastError);
    });
  });
}

function kickFotmobRefreshIfStale(slug: string): void {
  if (!httpMayKickFotmob()) return;
  const last = pollStatusForSlug(slug);
  const ts = last?.syncedAt ? Date.parse(last.syncedAt) : NaN;
  const stale = !Number.isFinite(ts) || Date.now() - ts >= POLL_MS;
  if (!stale) return;
  kickFotmobRefresh("get-stale");
}

async function runMantraPollBody(reason: string): Promise<MantraToursSyncResult[]> {
  console.log(`Live Mantra poll (${reason})…`);
  const mantraResults: MantraToursSyncResult[] = [];
  // Kickoff leagues first so a hung Serie A scrape cannot starve PL Live.
  const leagues = [...allLiveLeagues()].sort((a, b) => {
    const aLive = fotmobRoundHasKickedOff(a.slug, lastSyncBySlug[a.slug]?.round) ? 0 : 1;
    const bLive = fotmobRoundHasKickedOff(b.slug, lastSyncBySlug[b.slug]?.round) ? 0 : 1;
    return aLive - bLive;
  });
  for (const league of leagues) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    console.log(`Live Mantra [${league.slug}] …`);
    try {
      if (mantraCredentialsConfigured()) {
        const m = await syncMantraTours(league.slug);
        lastMantraSyncBySlug[league.slug] = m;
        mantraResults.push(m);
        if (m.error) lastError = m.error;
        // First FotMob kickoff of the tour — collect locked Real XI (≤4 req/s).
        // Do not wait for a global "open tour". GET /live never awaits this.
        if (fotmobRoundHasKickedOff(league.slug, lastSyncBySlug[league.slug]?.round)) {
          const xi = await syncMantraLineups({
            league: league.slug,
            requireKickoff: true,
          });
          if (xi.error) lastError = xi.error;
          console.log(
            `Live Mantra XI [${league.slug}]: ${xi.matches} matches${xi.error ? ` (${xi.error})` : ""}`,
          );
        }
      } else {
        const m: MantraToursSyncResult = {
          ok: false,
          slug: league.slug,
          divisions: 0,
          matches: 0,
          live: 0,
          syncedAt: null,
          error: "MANTRA_EMAIL / MANTRA_PASSWORD not set",
        };
        lastMantraSyncBySlug[league.slug] = m;
        mantraResults.push(m);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      console.warn(`Live Mantra [${league.slug}] failed:`, msg);
      const failed: MantraToursSyncResult = {
        ok: false,
        slug: league.slug,
        divisions: 0,
        matches: 0,
        live: 0,
        syncedAt: lastMantraSyncBySlug[league.slug]?.syncedAt ?? null,
        error: msg,
      };
      lastMantraSyncBySlug[league.slug] = failed;
      mantraResults.push(failed);
    }
  }
  for (const m of mantraResults) {
    if (m.error) lastError = m.error;
  }
  return mantraResults;
}

/** ID link only — never hold mantraLock; compute lives in the compute worker. */
async function afterMantraPollDataWork(): Promise<void> {
  await syncAllLiveMantraFotmobIds();
  invalidateMantraLiveScoreCache();
  invalidateDreamTeamCache();
  invalidateIdealVsRealCache();
}

/** Score / Ideal / Dream rebuilds — own process so HTTP / Mantra abort timers stay healthy. */
export async function runLiveComputeWarmup(reason: string): Promise<void> {
  console.log(`Live compute warmup (${reason})…`);
  await syncAllLiveMantraFotmobIds();
  invalidateMantraLiveScoreCache();
  invalidateDreamTeamCache();
  invalidateIdealVsRealCache();
  for (const league of allLiveLeagues()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const lineups = loadMantraLineups(null, league.slug);
    const round =
      lastSyncBySlug[league.slug]?.round ??
      peekLiveRoundFromMeta(league.slug) ??
      (lineups?.round != null ? String(lineups.round) : null);
    if (!round || !fotmobRoundHasKickedOff(league.slug, round)) continue;
    console.log(`Live compute [${league.slug}] round=${round}`);
    // blockOnMiss true: write computed_cache now (web only peeks).
    computeMantraMatchMap(round, league.slug, { blockOnMiss: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    computeDreamTeamOfRound(round, league.slug, { blockOnMiss: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    computeIdealVsRealStandings(round, league.slug, { blockOnMiss: true });
  }
  try {
    warmPremiumOddsJoin();
    console.log("premium odds-join cache ready");
  } catch (error) {
    console.warn(
      "premium odds-join warmup failed:",
      error instanceof Error ? error.message : error,
    );
  }
  console.log(`Live compute warmup (${reason}) done`);
}

async function runMantraPoll(reason: string): Promise<MantraToursSyncResult[]> {
  const { value, skipped } = await withExclusiveLock(
    mantraLock,
    () =>
      withTimeout(runMantraPollBody(reason), MANTRA_POLL_TIMEOUT_MS, "Mantra"),
    Object.values(lastMantraSyncBySlug),
    "Mantra",
  );
  if (!skipped) {
    void afterMantraPollDataWork().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn("Live Mantra post-work failed:", lastError);
    });
  }
  return value;
}

async function runPoll(reason: string): Promise<{
  fotmob: LiveSyncResult[];
  mantra: MantraToursSyncResult[];
}> {
  try {
    const fotmob = await runFotmobPoll(reason);
    // Never block the next FotMob cycle on Mantra (65 divisions / unreachable host).
    void runMantraPoll(reason).catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn("Live Mantra poll failed:", lastError);
    });
    return { fotmob, mantra: Object.values(lastMantraSyncBySlug) };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn("Live poll failed:", lastError);
    return {
      fotmob: Object.values(lastSyncBySlug),
      mantra: Object.values(lastMantraSyncBySlug),
    };
  }
}

export function startLivePoller(): void {
  if (pollTimer) return;
  setTimeout(() => {
    void runPoll("boot");
  }, 3_000);
  pollTimer = setInterval(() => {
    void runPoll("interval-5m");
  }, POLL_MS);
  console.log(
    `Live data poller every ${POLL_MS / 1000}s (FotMob + Mantra × ${allLiveLeagues().length} leagues)`,
  );
}

export function startLiveComputeWorker(): void {
  if (computeTimer) return;
  setTimeout(() => {
    void withExclusiveLock(
      computeLock,
      () => runLiveComputeWarmup("boot"),
      undefined,
      "compute",
    ).then(({ skipped }) => {
      if (skipped) console.log("Live compute boot skipped (lock held)");
    });
  }, 8_000);
  computeTimer = setInterval(() => {
    void withExclusiveLock(
      computeLock,
      () => runLiveComputeWarmup("interval-5m"),
      undefined,
      "compute",
    ).then(({ skipped }) => {
      if (skipped) console.log("Live compute interval skipped (lock held)");
    });
  }, POLL_MS);
  console.log(`Live compute worker every ${POLL_MS / 1000}s (scores / Ideal / Dream Team)`);
}

/** Mantra tour pages keep a LIVE badge for the whole scoring window; use FotMob instead. */
function withFotmobLiveFlags<T extends { live: boolean }>(
  tours: T[],
  fotmobMatches: { phase: string }[],
): T[] {
  const anyLive = fotmobMatches.some((m) => m.phase === "live");
  return tours.map((t) => ({ ...t, live: anyLive }));
}

/** Active lineup-deadline tours stay on Live even if the URL still holds the finished round. */
function mantraToursForLivePage(round: string | null, slug: string) {
  const live = getMantraToursCached(slug);
  const forRound = getMantraToursForRound(round, slug);
  if (live.tours.length && mantraToursHaveActiveDeadline(live.tours)) {
    return live;
  }
  return forRound;
}

function emptyMatchFromTourPair(
  matchId: number,
  pair: {
    url: string | null;
    home: {
      teamId: number | null;
      teamName: string;
      score: number | null;
      goals: number | null;
      scoredCount: number | null;
    };
    away: {
      teamId: number | null;
      teamName: string;
      score: number | null;
      goals: number | null;
      scoredCount: number | null;
    };
  },
) {
  const side = (s: (typeof pair)["home"]) => ({
    teamId: s.teamId,
    teamName: s.teamName,
    module: null,
    defenseBonus: null,
    fantasyScore: s.score,
    goals: s.goals,
    scoredCount: s.scoredCount,
    lineup: [],
    squad: [],
    substitutes: [],
    notInSquad: [],
  });
  return {
    id: matchId,
    url: pair.url ?? `https://mantrafootball.org/matches/${matchId}`,
    home: side(pair.home),
    away: side(pair.away),
  };
}

function findMantraTourPair(
  matchId: number,
  round?: string | null,
  league?: string | null,
): { pair: Parameters<typeof emptyMatchFromTourPair>[1]; slug: string; round: number | null } | null {
  const preferred = league ? resolveLiveLeague(league).slug : null;
  const slugs = [
    ...(preferred ? [preferred] : []),
    ...allLiveLeagues()
      .map((l) => l.slug)
      .filter((s) => s !== preferred),
  ];
  for (const slug of slugs) {
    const { tours } = getMantraToursForRound(round, slug);
    for (const t of tours) {
      const m = t.matches.find((x) => x.matchId === matchId);
      if (m) return { pair: m, slug, round: t.round };
    }
  }
  return null;
}

function liveAccountContext(
  req: FastifyRequest | null | undefined,
  leagueSlug: string,
): { pinMyLeagues: boolean; myLeagueIds: number[] } | null {
  try {
    if (!req) return null;
    const user = currentUser(req);
    if (!user) return null;
    const tournamentId = resolveLiveLeague(leagueSlug).mantraTournamentId;
    const myLeagueIds =
      user.mantra_manager_id != null && tournamentId != null
        ? [
            ...new Set(
              listFantasyTeams({
                managerId: user.mantra_manager_id,
                tournamentId,
              }).map((t) => t.leagueId),
            ),
          ]
        : [];
    return {
      pinMyLeagues: Boolean(user.pin_my_leagues),
      myLeagueIds,
    };
  } catch (err) {
    console.warn(
      "Live account context failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function emptyLivePayload(leagueSlug: string, message: string, requestedRound?: string | null) {
  const slug = resolveLiveLeague(leagueSlug).slug;
  return {
    round: requestedRound ?? null,
    currentRound: requestedRound ?? null,
    rounds: [],
    matches: [],
    league: slug,
    leagueName: slug,
    account: null,
    mantra: {
      tours: [],
      syncedAt: null,
      error: message,
      configured: mantraCredentialsConfigured(),
      lineupsSyncedAt: null,
      lineupsCount: 0,
      lineupsRound: null,
      computed: {},
      dreamTeam: null,
      idealStandings: null,
    },
    poll: {
      intervalSec: POLL_MS / 1000,
      running: fotmobLock.running || mantraLock.running || computeLock.running,
      lastSync: pollStatusForSlug(slug),
      lastMantraSync: lastMantraSyncBySlug[slug] ?? null,
      lastError: message,
    },
  };
}

function safeLivePayload(
  requestedRound?: string | null,
  leagueSlug?: string | null,
  req?: FastifyRequest | null,
) {
  try {
    return buildLivePayload(requestedRound, leagueSlug, req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastError = message;
    console.warn("GET /live payload failed:", message);
    return emptyLivePayload(leagueSlug ?? DEFAULT_LIVE_SLUG, message, requestedRound);
  }
}

function buildLivePayload(
  requestedRound?: string | null,
  leagueSlug?: string | null,
  req?: FastifyRequest | null,
) {
  const slug = resolveLiveLeague(leagueSlug).slug;
  const data = listLiveRound(requestedRound, slug);
  const mantraLive = getMantraToursCached(slug);
  const mantraForRound = mantraToursForLivePage(data.round, slug);
  const lineups = loadMantraLineups(data.round, slug);
  const computed = slimMantraMatchMapForCards(
    computeMantraMatchMap(data.round, slug, LIVE_COMPUTE),
  );
  const dreamTeam = computeDreamTeamOfRound(data.round, slug, LIVE_COMPUTE);
  const tours = withFotmobLiveFlags(mantraForRound.tours, data.matches);
  return {
    ...data,
    account: liveAccountContext(req, slug),
    mantra: {
      tours,
      syncedAt: mantraForRound.syncedAt ?? mantraLive.syncedAt,
      error: mantraLive.error,
      configured: mantraCredentialsConfigured(),
      lineupsSyncedAt: lineups?.syncedAt ?? null,
      lineupsCount: lineups ? Object.keys(lineups.matches).length : 0,
      lineupsRound: lineups?.round ?? null,
      computed,
      dreamTeam,
      idealStandings: null,
    },
    poll: {
      intervalSec: POLL_MS / 1000,
      running: fotmobLock.running || mantraLock.running || computeLock.running,
      lastSync: pollStatusForSlug(slug),
      lastMantraSync:
        lastMantraSyncBySlug[slug] ??
        (mantraLive.syncedAt
          ? {
              ok: true,
              slug,
              divisions: mantraLive.tours.length,
              matches: 0,
              live: 0,
              syncedAt: mantraLive.syncedAt,
              error: mantraLive.error,
            }
          : null),
      lastError,
    },
  };
}

export async function liveRoutes(app: FastifyInstance) {
  app.get("/live/leagues", async () => ({
    leagues: allLiveLeagues().map((l) => ({
      slug: l.slug,
      name: l.name,
      afId: l.id,
      tmCompetition: l.tmCompetition,
      fotmobLeagueId: l.fotmobLeagueId,
      mantraTournamentId: l.mantraTournamentId,
      divisions: l.mantraDivisions.length,
    })),
    default: DEFAULT_LIVE_SLUG,
  }));

  app.get("/live", async (req, reply) => {
    const q = req.query as { round?: string; league?: string; format?: string };
    const forceJson = q.format === "json";
    if (!forceJson && wantsHtmlPage(req) && isSpaReady()) {
      return sendSpaPage(reply, "live");
    }
    reply.header("Cache-Control", "no-store");
    reply.header("Vary", "Accept, Sec-Fetch-Dest");
    const round = parseRoundQuery(q.round);
    const league = parseLeagueQuery(q.league);
    kickFotmobRefreshIfStale(league);
    return safeLivePayload(round, league, req);
  });

  app.get("/live/mantra", async (req) => {
    const q = req.query as { round?: string; league?: string };
    const round = parseRoundQuery(q.round);
    const league = parseLeagueQuery(q.league);
    const data = listLiveRound(round, league);
    const mantraLive = getMantraToursCached(league);
    const mantraForRound = mantraToursForLivePage(data.round, league);
    const lineups = loadMantraLineups(data.round, league);
    const computed = slimMantraMatchMapForCards(
      computeMantraMatchMap(data.round, league, LIVE_COMPUTE),
    );
    const dreamTeam = computeDreamTeamOfRound(data.round, league, LIVE_COMPUTE);
    return {
      ...mantraForRound,
      tours: withFotmobLiveFlags(mantraForRound.tours, data.matches),
      configured: mantraCredentialsConfigured(),
      lineupsSyncedAt: lineups?.syncedAt ?? null,
      lineupsCount: lineups ? Object.keys(lineups.matches).length : 0,
      lineupsRound: lineups?.round ?? null,
      computed,
      dreamTeam,
      idealStandings: null,
      round: data.round,
      currentRound: data.currentRound,
      rounds: data.rounds,
      league: data.league,
      leagueName: data.leagueName,
      poll: {
        intervalSec: POLL_MS / 1000,
        lastMantraSync:
          lastMantraSyncBySlug[league] ??
          (mantraLive.syncedAt
            ? {
                ok: true,
                slug: league,
                divisions: mantraLive.tours.length,
                matches: 0,
                live: 0,
                syncedAt: mantraLive.syncedAt,
                error: mantraLive.error,
              }
            : null),
      },
      error: mantraLive.error,
    };
  });

  app.get("/live/dream-team", async (req) => {
    const q = req.query as { round?: string; league?: string };
    return {
      dreamTeam: computeDreamTeamOfRound(
        parseRoundQuery(q.round),
        parseLeagueQuery(q.league),
        LIVE_COMPUTE,
      ),
    };
  });

  app.get("/live/ideal-standings", async (req) => {
    const q = req.query as { round?: string; league?: string };
    return {
      idealStandings: computeIdealVsRealStandings(
        parseRoundQuery(q.round),
        parseLeagueQuery(q.league),
        { blockOnMiss: false },
      ),
    };
  });

  app.get("/live/mantra/match/:matchId", async (req, reply) => {
    const matchId = Number((req.params as { matchId: string }).matchId);
    if (!Number.isFinite(matchId)) return reply.code(400).send({ error: "bad matchId" });
    const q = req.query as { round?: string; league?: string };
    const requested = parseRoundQuery(q.round);
    const league = parseLeagueQuery(q.league);
    const found = findMantraMatchInLineups(matchId, { round: requested, league });
    if (found) {
      const round =
        requested ??
        (found.file.round != null ? String(found.file.round) : null);
      const computed = computeMantraMatch(matchId, round, found.slug);
      const emptyXi =
        !(found.match.home?.lineup?.length || found.match.away?.lineup?.length);
      return {
        matchId,
        match: found.match,
        computed,
        pendingXi: emptyXi,
        lineupsSyncedAt: found.file.syncedAt ?? null,
        round: found.file.round ?? null,
        league: found.slug,
      };
    }
    const tourHit = findMantraTourPair(matchId, requested, league);
    if (tourHit) {
      return {
        matchId,
        match: emptyMatchFromTourPair(matchId, tourHit.pair),
        computed: null,
        pendingXi: true,
        lineupsSyncedAt: null,
        round: tourHit.round,
        league: tourHit.slug,
      };
    }
    return reply.code(404).send({
      error: "XI ещё не выставлен — пара тура есть, составы появятся после лока",
      matchId,
      league,
      pendingXi: true,
    });
  });

  app.get("/live/:matchId", async (req, reply) => {
    const matchId = Number((req.params as { matchId: string }).matchId);
    if (!Number.isFinite(matchId)) return reply.code(400).send({ error: "bad matchId" });
    const match = getLiveMatch(matchId);
    if (!match) return reply.code(404).send({ error: "Match not found — wait for live sync" });
    return match;
  });

  app.post("/live/refresh", async (req) => {
    const q = req.query as { round?: string; league?: string };
    const round = parseRoundQuery(q.round);
    const league = parseLeagueQuery(q.league);
    const refreshing = httpMayKickFotmob();
    if (refreshing) kickFotmobRefresh("manual");
    const payload = safeLivePayload(round, league, req);
    return {
      ok: true,
      refreshing,
      workerOwned: !refreshing,
      result: {
        fotmob: Object.values(lastSyncBySlug),
        mantra: Object.values(lastMantraSyncBySlug),
      },
      error: lastError,
      ...payload,
    };
  });
}
