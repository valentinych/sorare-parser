/**
 * Queued multi-league expansion sync.
 *
 * Respects:
 *   - API Football via rateLimit4perSec in clients/apiFootball.ts
 *   - Transfermarkt via tmQueue (≤4/s, ≤100/min, jitter)
 *   - MantraFootball via rateLimit4perSec in clients/mantra.ts
 *
 * Phases (sequential — never parallel across providers that share a budget):
 *   1. AF predict pipeline per league (teams/squads/preseason/stats/TM MV map)
 *   2. TM deep sync per competition (table, attributes, fixtures/games)
 *   3. Mantra list (+ optional profiles) per tournament
 *   4. Manager formations per league
 *
 * Examples:
 *   npm run sync:expand
 *   npm run sync:expand -- --skip-mantra-profiles
 *   npm run sync:expand -- --league=40,78 --skip-managers
 */
import { config } from "../config.js";
import { getDb, setMeta } from "../db/index.js";
import {
  AF_LEAGUES,
  NEW_LEAGUE_IDS,
  leagueById,
  uniqueMantraTournaments,
  uniqueTmCompetitions,
} from "../lib/afLeagues.js";
import {
  activateQueueItem,
  beginExpandSync,
  completeQueueItem,
  finishExpandSync,
  updateQueueStep,
} from "../lib/syncProgress.js";
import { tmQueueStats } from "../lib/tmQueue.js";
import { syncTmLeague } from "./syncTmLeague.js";
import { enrichTmPlayersFromRaw, syncTmAttributes, syncTmFixturesAndGames } from "./syncTmDeep.js";
import { syncMantraTournament } from "./syncMantra.js";
import { syncManagerFormationsForTeam, managerIdentityStale } from "./syncManagerFormations.js";
import { syncLeagueFixtures } from "./syncFixtures.js";
import { syncPreseason } from "./syncPreseason.js";
import { syncPlayerStatsHistory, syncSquads } from "./syncSquads.js";
import { syncTmPerfFromGames } from "./syncTmPerf.js";
import { syncMarketValues, syncTmClubMap } from "./syncMarketValues.js";
import { syncTeamsForSeason } from "./syncTeams.js";

function parseIds(args: string[], flag: string): number[] | null {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  if (!hit) return null;
  return hit
    .slice(flag.length + 1)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

async function syncAfPredictLeague(leagueId: number, args: Set<string>): Promise<void> {
  const def = leagueById(leagueId);
  if (!def) throw new Error(`Unknown AF league ${leagueId}`);
  const key = `af:${leagueId}`;
  const predictSeason = config.predictSeason;
  const historySeason = config.season;
  console.log(`\n═══ AF ${def.name} (${leagueId} / TM ${def.tmCompetition}) ═══`);
  activateQueueItem(key, `teams ${historySeason}`);

  const nHistTeams = await syncTeamsForSeason(leagueId, historySeason);
  console.log(`  teams ${historySeason}: ${nHistTeams}`);
  if (!args.has("--skip-history-fixtures")) {
    updateQueueStep(key, `fixtures ${historySeason}`);
    const nFx = await syncLeagueFixtures(leagueId, historySeason);
    console.log(`  fixtures ${historySeason}: ${nFx}`);
  }

  updateQueueStep(key, `teams ${predictSeason}`);
  const nTeams = await syncTeamsForSeason(leagueId, predictSeason);
  console.log(`  teams ${predictSeason}: ${nTeams}`);
  if (!args.has("--skip-squads")) {
    updateQueueStep(key, "squads 0/?");
    const nSquads = await syncSquads(predictSeason, leagueId, {
      onTeam: (done, total) => updateQueueStep(key, `squads ${done}/${total}`),
    });
    console.log(`  squads: ${nSquads}`);
  }
  if (!args.has("--skip-preseason")) {
    updateQueueStep(key, "preseason 0/?");
    const nPre = await syncPreseason(predictSeason, leagueId, {
      onTeam: (done, total, name) => updateQueueStep(key, `preseason ${done}/${total} ${name}`),
    });
    console.log(`  preseason: ${nPre}`);
  }
  if (!args.has("--skip-history-stats")) {
    updateQueueStep(key, `player stats ${historySeason}…`);
    const hist = await syncPlayerStatsHistory(leagueId, historySeason);
    console.log(`  player stats history:`, hist);
  }
  if (!args.has("--skip-tm-map")) {
    const tmOpts = {
      forceRefresh: args.has("--refresh-tm") || args.has("--refresh"),
      leagueId,
      tmCompetition: def.tmCompetition,
    };
    updateQueueStep(key, "tm club map");
    const nMap = await syncTmClubMap(predictSeason, tmOpts);
    console.log(`  tm club map: ${nMap}`);
    updateQueueStep(key, "tm market values");
    const nVal = await syncMarketValues(predictSeason, tmOpts);
    console.log(`  tm market values: ${nVal}`);
  }
  completeQueueItem(key);
}

async function syncTmCompetition(code: string, args: Set<string>): Promise<void> {
  const key = `tm:${code}`;
  console.log(`\n═══ TM competition ${code} ═══`);
  activateQueueItem(key, "league table");
  const forceRefresh = args.has("--refresh") || args.has("--refresh-tm");
  await syncTmLeague(code, { forceRefresh });
  if (!args.has("--league-only")) {
    updateQueueStep(key, "attributes");
    console.log("  TM attributes…");
    await syncTmAttributes({ forceRefresh });
    enrichTmPlayersFromRaw();
    updateQueueStep(key, "fixtures + games");
    console.log("  TM fixtures + games…");
    await syncTmFixturesAndGames({ forceRefresh, competitionId: code });
    enrichTmPlayersFromRaw();
  }
  console.log("  queue", tmQueueStats());
  const nPerf = syncTmPerfFromGames(config.season);
  console.log(`  tm perf aggregate ${config.season}: ${nPerf}`);
  completeQueueItem(key);
}

async function syncManagersForLeague(leagueId: number, sampleSize: number, force: boolean): Promise<void> {
  const def = leagueById(leagueId);
  const key = `managers:${leagueId}`;
  const season = config.predictSeason;
  const teams = getDb()
    .prepare(
      `SELECT team_id AS id, name FROM season_teams
       WHERE season = ? AND league_id = ?
       ORDER BY name`,
    )
    .all(season, leagueId) as Array<{ id: number; name: string }>;
  console.log(`\n═══ Managers ${def?.name ?? leagueId} (${teams.length} teams) ═══`);
  activateQueueItem(key, `0/${teams.length}`);
  for (let i = 0; i < teams.length; i++) {
    const t = teams[i]!;
    updateQueueStep(key, `${i + 1}/${teams.length} ${t.name}`);
    if (!force) {
      const existing = getDb()
        .prepare(`SELECT sample_size, coach_name, source FROM manager_formation_summary WHERE team_id = ?`)
        .get(t.id) as
        | { sample_size: number; coach_name: string | null; source: string | null }
        | undefined;
      if (existing) {
        const stale = await managerIdentityStale(t.id);
        if (!stale && existing.sample_size >= 3) {
          console.log(`  [${i + 1}/${teams.length}] skip ${t.name}`);
          continue;
        }
        if (stale) console.log(`  [${i + 1}/${teams.length}] refresh ${t.name} (was ${existing.coach_name})`);
      }
    }
    console.log(`  [${i + 1}/${teams.length}] ${t.name}…`);
    try {
      await syncManagerFormationsForTeam(t.id, { sampleSize, predictSeason: season });
    } catch (err) {
      console.warn(`  failed ${t.name}:`, err instanceof Error ? err.message : err);
    }
  }
  completeQueueItem(key);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  getDb();

  const fromArg = parseIds(argv, "--league");
  const leagueIds = fromArg?.length ? fromArg : [...NEW_LEAGUE_IDS];
  for (const id of leagueIds) {
    if (!AF_LEAGUES[id]) throw new Error(`Unknown league id ${id}`);
  }

  const sampleSize = Number(argv.find((a) => a.startsWith("--sample="))?.slice(8) ?? 80) || 80;
  const profileLimit =
    Number(argv.find((a) => a.startsWith("--mantra-profile-limit="))?.slice(22) ?? 0) || undefined;

  const tmCompetitions = uniqueTmCompetitions(leagueIds);
  const mantraTournaments = uniqueMantraTournaments(leagueIds);

  console.log(
    `Expand sync leagues=${leagueIds.join(",")} predict=${config.predictSeason} history=${config.season}`,
  );
  console.log(`TM comps=${tmCompetitions.join(",")} mantra=${mantraTournaments.join(",")}`);

  beginExpandSync({
    leagueIds,
    tmCompetitions,
    mantraTournaments,
    skipAf: args.has("--skip-af"),
    skipTm: args.has("--skip-tm"),
    skipMantra: args.has("--skip-mantra"),
    skipManagers: args.has("--skip-managers"),
  });

  try {
    if (!args.has("--skip-af")) {
      for (const id of leagueIds) {
        await syncAfPredictLeague(id, args);
      }
    }

    if (!args.has("--skip-tm")) {
      for (const code of tmCompetitions) {
        await syncTmCompetition(code, args);
      }
    }

    if (!args.has("--skip-mantra")) {
      for (const tid of mantraTournaments) {
        const key = `mantra:${tid}`;
        activateQueueItem(key, args.has("--skip-mantra-profiles") ? "list" : "list + profiles");
        await syncMantraTournament(tid, {
          profileLimit,
          forceProfiles: args.has("--refresh-mantra") || args.has("--refresh"),
          skipProfiles: args.has("--skip-mantra-profiles"),
        });
        completeQueueItem(key);
      }
    }

    if (!args.has("--skip-managers")) {
      for (const id of leagueIds) {
        await syncManagersForLeague(
          id,
          sampleSize,
          args.has("--force-managers") || args.has("--force"),
        );
      }
    }

    setMeta("expand_sync_at", new Date().toISOString());
    setMeta("expand_sync_leagues", leagueIds.join(","));
    finishExpandSync();
    console.log("\ndone. queue", tmQueueStats());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishExpandSync(msg);
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
