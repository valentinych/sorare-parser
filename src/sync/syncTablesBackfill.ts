/**
 * Targeted /tables backfill for extra Mantra championships.
 * MantraFootball ≤4 req/s (shared mantraRequest). FotMob on its own 40 rps limiter.
 * Does not iterate LIVE_LEAGUES / --all tours for the original six.
 *
 *   npm run sync:tables
 *   npm run sync:tables -- --league=jupiler-pro-league
 *   npm run sync:tables -- --skip-tours --skip-fotmob
 *   npm run sync:tables -- --archives
 */
import { fetchLeagueResults } from "../clients/mantra.js";
import { fetchLeagueFixtures, fetchMatchDetails, matchPhase } from "../clients/fotmob.js";
import { mantraCredentialsConfigured } from "../clients/mantraAuth.js";
import { getDb } from "../db/index.js";
import { getIdealDivisionTable } from "../domain/mantraIdealTables.js";
import {
  computeIdealVsRealStandings,
  listScoredFotmobRounds,
  loadSeasonIdealTotals,
} from "../domain/mantraIdealVsReal.js";
import { getManagersStandings } from "../domain/mantraManagers.js";
import { divisionLabel, getChampionshipStandings } from "../domain/mantraStandings.js";
import { getTablesLeagueProgress, writeTablesJobProgress } from "../domain/tablesProgress.js";
import {
  isTablesExtraSlug,
  liveLeagueBySlug,
  TABLES_EXTRA_SLUGS,
  type LiveLeagueDef,
} from "../lib/liveLeagues.js";
import { syncMantraFotmobIds } from "../lib/mantraFotmobIds.js";
import { syncMantraFantasyTeams, syncMantraLeagues, syncMantraList } from "./syncMantra.js";
import { syncLiveRound, storeMatchDetails, upsertMatchList } from "./syncLive.js";
import { backfillMantraGwRatings } from "./syncMantraGwRatings.js";
import { archiveHistoricalMantraTours, syncMantraTours } from "./syncMantraTours.js";

export type TablesBackfillResult = {
  slug: string;
  ok: boolean;
  leagues: number;
  players: number;
  divisions: number;
  fotmobListed: number;
  fotmobSheets: number;
  tours: number;
  archivedRounds: number[];
  missingRounds: number[];
  toursFetched: number;
  idealRebuilt: number;
  error: string | null;
};

function emptyResult(
  slug: string,
  error: string,
  divisions = 0,
): TablesBackfillResult {
  return {
    slug,
    ok: false,
    leagues: 0,
    players: 0,
    divisions,
    fotmobListed: 0,
    fotmobSheets: 0,
    tours: 0,
    archivedRounds: [],
    missingRounds: [],
    toursFetched: 0,
    idealRebuilt: 0,
    error,
  };
}

function finishedFotmobRoundNumbers(slug: string): number[] {
  const league = liveLeagueBySlug(slug);
  if (!league) return [];
  return listScoredFotmobRounds(league.fotmobLeagueId)
    .filter((item) => item.fullyFinished)
    .map((item) => Number(item.round))
    .filter((n) => Number.isFinite(n) && n >= 1);
}

async function rebuildTablesIdealCache(slug: string): Promise<number> {
  const league = liveLeagueBySlug(slug);
  if (!league) return 0;
  let rebuilt = 0;
  for (const def of league.mantraDivisions) {
    await getIdealDivisionTable(slug, divisionLabel(def), {
      serveStale: false,
      force: true,
      idealForRound: (round, key, fullyFinished) =>
        computeIdealVsRealStandings(round, key, {
          serveStale: false,
          blockOnMiss: true,
          useLockedSquad: fullyFinished,
        }),
    });
    rebuilt += 1;
  }
  loadSeasonIdealTotals(slug, { blockOnMiss: true });
  getManagersStandings({ database: getDb() });
  return rebuilt;
}

function missingFantasyLeagueIds(slug: string): number[] {
  const league = liveLeagueBySlug(slug);
  if (!league) return [];
  const db = getDb();
  const missing: number[] = [];
  for (const def of league.mantraDivisions) {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM mantra_fantasy_teams WHERE league_id = ?`)
      .get(def.leagueId) as { n: number };
    if ((row?.n ?? 0) === 0) missing.push(def.leagueId);
  }
  return missing;
}

async function fillIdealInputs(slug: string): Promise<void> {
  const league = liveLeagueBySlug(slug);
  if (!league?.mantraTournamentId) return;
  const missing = missingFantasyLeagueIds(slug);
  if (missing.length) {
    console.log(`  fantasy teams [${slug}]: ${missing.length} leagues without squads`);
    await syncMantraFantasyTeams(league.mantraTournamentId, { leagueIds: missing });
  }
  syncMantraFotmobIds(league.mantraTournamentId, league.fotmobLeagueId);
  await backfillMantraGwRatings(slug);
}

function extraLeaguesFromArg(raw: string | undefined): LiveLeagueDef[] {
  if (!raw || raw === "all") {
    return TABLES_EXTRA_SLUGS.map((slug) => liveLeagueBySlug(slug)!);
  }
  const slugs = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: LiveLeagueDef[] = [];
  for (const slug of slugs) {
    const league = liveLeagueBySlug(slug);
    if (!league || !isTablesExtraSlug(league.slug)) {
      throw new Error(`not a tables extra league: ${slug}`);
    }
    out.push(league);
  }
  return out;
}

function pendingFinishedSheets(fotmobLeagueId: number): number[] {
  const db = getDb();
  try {
    return (
      db
        .prepare(
          `SELECT id FROM fotmob_matches
           WHERE league_id = ? AND phase = 'finished' AND details_synced_at IS NULL
           ORDER BY id`,
        )
        .all(fotmobLeagueId) as Array<{ id: number }>
    ).map((row) => row.id);
  } catch {
    return [];
  }
}

export async function syncTablesFotmobSheets(slug: string): Promise<{ listed: number; sheets: number }> {
  const league = liveLeagueBySlug(slug);
  if (!league) throw new Error(`unknown_tables_league:${slug}`);
  writeTablesJobProgress(slug, { status: "running", phase: "fotmob" });
  const now = new Date().toISOString();
  const { matches } = await fetchLeagueFixtures(league.fotmobLeagueId);
  upsertMatchList(matches, league.fotmobLeagueId, now);
  const finishedListed = matches.filter((m) => matchPhase(m) === "finished").length;
  const pending = pendingFinishedSheets(league.fotmobLeagueId);
  let sheets = 0;
  for (const matchId of pending) {
    try {
      const details = await fetchMatchDetails(matchId);
      if (!details.round) {
        const listed = matches.find((m) => m.id === matchId);
        if (listed?.round != null) details.round = String(listed.round);
      }
      storeMatchDetails(details, now);
      sheets += 1;
      writeTablesJobProgress(slug, {
        status: "running",
        phase: "fotmob",
        lastFotmobMatchId: matchId,
      });
    } catch (error) {
      console.warn(
        `  fotmob sheet ${matchId} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  console.log(
    `  fotmob [${slug}] listed=${matches.length} finished=${finishedListed} newSheets=${sheets}`,
  );
  return { listed: matches.length, sheets };
}

export async function backfillTablesLeague(
  slug: string,
  opts: {
    skipFotmob?: boolean;
    skipTours?: boolean;
    skipPlayers?: boolean;
    archivesOnly?: boolean;
  } = {},
): Promise<TablesBackfillResult> {
  const league = liveLeagueBySlug(slug);
  if (!league || !isTablesExtraSlug(league.slug)) {
    return emptyResult(slug, "not a tables extra league");
  }
  if (opts.archivesOnly) {
    try {
      writeTablesJobProgress(league.slug, { status: "running", phase: "tours", error: null });
      console.log(`\n═══ tables archives ${league.slug} ═══`);
      const wantedRounds = finishedFotmobRoundNumbers(league.slug);
      const archive = await archiveHistoricalMantraTours(league.slug, { wantedRounds });
      if (archive.error) console.warn(`  archives [${league.slug}]: ${archive.error}`);
      console.log(
        `  archives [${league.slug}] fetched=${archive.fetched} rounds=${archive.archivedRounds.join(",") || "-"} missing=${archive.missingRounds.join(",") || "-"}`,
      );
      writeTablesJobProgress(league.slug, { status: "running", phase: "done" });
      await fillIdealInputs(league.slug);
      const idealRebuilt = await rebuildTablesIdealCache(league.slug);
      writeTablesJobProgress(league.slug, { status: "done", phase: "done", error: null });
      return {
        slug: league.slug,
        ok: archive.error == null,
        leagues: 0,
        players: 0,
        divisions: league.mantraDivisions.length,
        fotmobListed: 0,
        fotmobSheets: 0,
        tours: archive.archivedRounds.length,
        archivedRounds: archive.archivedRounds,
        missingRounds: archive.missingRounds,
        toursFetched: archive.fetched,
        idealRebuilt,
        error: archive.error,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeTablesJobProgress(league.slug, { status: "error", error: message });
      return emptyResult(league.slug, message, league.mantraDivisions.length);
    }
  }
  const tournamentId = league.mantraTournamentId!;
  let leagues = 0;
  let players = 0;
  let fotmobListed = 0;
  let fotmobSheets = 0;
  let tours = 0;
  try {
    writeTablesJobProgress(league.slug, { status: "running", phase: "leagues", error: null });
    console.log(`\n═══ tables backfill ${league.slug} (t${tournamentId}) ═══`);
    const prior = getTablesLeagueProgress(league.slug);
    leagues = await syncMantraLeagues(tournamentId);
    console.log(`  mantra leagues: ${leagues}`);

    if (!opts.skipPlayers) {
      if (prior && prior.playersListed > 0) {
        players = prior.playersListed;
        console.log(`  mantra players: skip (already ${players})`);
      } else {
        writeTablesJobProgress(league.slug, { status: "running", phase: "players" });
        players = await syncMantraList(tournamentId);
        console.log(`  mantra players: ${players}`);
      }
    }

    writeTablesJobProgress(league.slug, { status: "running", phase: "results" });
    let teams = prior?.resultsDone ?? 0;
    let failed = 0;
    if (prior && prior.resultsDone >= prior.resultsTotal && prior.resultsTotal > 0) {
      console.log(`  standings: skip (already ${prior.resultsDone}/${prior.resultsTotal})`);
    } else {
      const standings = await getChampionshipStandings(league.slug, {
        fetchResults: fetchLeagueResults,
        serveStale: false,
      });
      teams = standings.teams;
      failed = standings.failedDivisions.length;
      console.log(`  standings: teams=${teams} failed=${failed}`);
    }

    if (!opts.skipFotmob) {
      try {
        await syncLiveRound(league.slug);
      } catch (error) {
        console.warn(
          `  live round [${league.slug}] failed:`,
          error instanceof Error ? error.message : error,
        );
      }
      const fotmob = await syncTablesFotmobSheets(league.slug);
      fotmobListed = fotmob.listed;
      fotmobSheets = fotmob.sheets;
      syncMantraFotmobIds(tournamentId, league.fotmobLeagueId);
    }

    if (!opts.skipPlayers) {
      const missing = missingFantasyLeagueIds(league.slug);
      if (missing.length) {
        writeTablesJobProgress(league.slug, { status: "running", phase: "players" });
        await syncMantraFantasyTeams(tournamentId, { leagueIds: missing });
      }
    }
    await backfillMantraGwRatings(league.slug);

    if (!opts.skipTours && mantraCredentialsConfigured()) {
      writeTablesJobProgress(league.slug, { status: "running", phase: "tours" });
      const tour = await syncMantraTours(league.slug);
      tours = tour.divisions;
      if (tour.error) console.warn(`  tours [${league.slug}]: ${tour.error}`);
    } else if (!opts.skipTours) {
      console.log(`  tours skipped (no MANTRA_EMAIL/PASSWORD)`);
    }

    writeTablesJobProgress(league.slug, { status: "running", phase: "ideal" });
    const idealRebuilt = await rebuildTablesIdealCache(league.slug);
    console.log(`  ideal tables [${league.slug}]: rebuilt=${idealRebuilt}`);

    writeTablesJobProgress(league.slug, { status: "done", phase: "done", error: null });
    return {
      slug: league.slug,
      ok: failed === 0 && (teams > 0 || (prior?.resultsDone ?? 0) > 0),
      leagues,
      players,
      divisions: league.mantraDivisions.length,
      fotmobListed,
      fotmobSheets,
      tours,
      archivedRounds: [],
      missingRounds: [],
      toursFetched: 0,
      idealRebuilt,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeTablesJobProgress(league.slug, { status: "error", error: message });
    console.warn(`tables backfill ${league.slug} failed:`, message);
    return {
      slug: league.slug,
      ok: false,
      leagues,
      players,
      divisions: league.mantraDivisions.length,
      fotmobListed,
      fotmobSheets,
      tours,
      archivedRounds: [],
      missingRounds: [],
      toursFetched: 0,
      idealRebuilt: 0,
      error: message,
    };
  }
}

export async function backfillTablesLeagues(
  leagueArg?: string,
  opts: {
    skipFotmob?: boolean;
    skipTours?: boolean;
    skipPlayers?: boolean;
    archivesOnly?: boolean;
  } = {},
): Promise<TablesBackfillResult[]> {
  const leagues = extraLeaguesFromArg(leagueArg);
  const out: TablesBackfillResult[] = [];
  for (const league of leagues) {
    out.push(await backfillTablesLeague(league.slug, opts));
  }
  return out;
}
