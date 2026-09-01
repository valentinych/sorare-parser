import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { syncLeagueFixtures } from "./syncFixtures.js";
import { syncLineups } from "./syncLineups.js";
import { syncMarketValues, syncTmClubMap } from "./syncMarketValues.js";
import { syncPreseason } from "./syncPreseason.js";
import { syncPlayerStatsHistory, syncSquads } from "./syncSquads.js";
import { syncTeamsForSeason } from "./syncTeams.js";
import { leagueById } from "../lib/afLeagues.js";

function parseLeagueIds(args: Set<string>): number[] {
  const fromArg = [...args].find((a) => a.startsWith("--league="));
  if (fromArg) {
    return fromArg
      .slice("--league=".length)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
  if (process.env.LEAGUE_IDS) {
    return process.env.LEAGUE_IDS.split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
  return [config.leagueId];
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const predictSeason = config.predictSeason;
  const historySeason = config.season;
  const lineupLimit = Number(process.env.LINEUP_LIMIT ?? 0) || undefined;
  const leagueIds = parseLeagueIds(args);

  console.log(
    `Sync history=${historySeason} predict=${predictSeason} leagues=${leagueIds.join(",")}`,
  );
  getDb();

  for (const leagueId of leagueIds) {
    const def = leagueById(leagueId) ?? {
      id: leagueId,
      slug: String(leagueId),
      name: `League ${leagueId}`,
      tmCompetition: "PL1",
    };
    console.log(`\n=== ${def.name} (${leagueId} / TM ${def.tmCompetition}) ===`);

    if (args.has("--preseason-only")) {
      const nTeams = await syncTeamsForSeason(leagueId, predictSeason);
      console.log(`teams ${predictSeason}: ${nTeams}`);
      const nPre = await syncPreseason(predictSeason, leagueId);
      console.log(`preseason fixtures: ${nPre}`);
      continue;
    }

    if (args.has("--predict-only")) {
      await runPredictPipeline(leagueId, def.tmCompetition, predictSeason, historySeason, args);
      continue;
    }

    if (!args.has("--lineups-only") && !args.has("--stats-only") && !args.has("--skip-history")) {
      const nTeams = await syncTeamsForSeason(leagueId, historySeason);
      console.log(`teams ${historySeason}: ${nTeams}`);
      const nFixtures = await syncLeagueFixtures(leagueId, historySeason);
      console.log(`fixtures ${historySeason}: ${nFixtures}`);
    }

    if (!args.has("--stats-only") && !args.has("--skip-lineups") && !args.has("--predict-only")) {
      const nLineups = await syncLineups({
        onlyMissing: !args.has("--relayout"),
        limit: lineupLimit,
        leagueId,
      });
      console.log(`lineups synced: ${nLineups}`);
    }

    if (!args.has("--lineups-only") && !args.has("--skip-stats")) {
      const hist = await syncPlayerStatsHistory(leagueId, historySeason);
      console.log(`player stats history:`, hist);
    }

    if (!args.has("--history-only")) {
      await runPredictPipeline(leagueId, def.tmCompetition, predictSeason, historySeason, args);
    }
  }

  console.log("done");
}

async function runPredictPipeline(
  leagueId: number,
  tmCompetition: string,
  predictSeason: number,
  historySeason: number,
  args: Set<string>,
) {
  const nTeams = await syncTeamsForSeason(leagueId, predictSeason);
  console.log(`teams ${predictSeason}: ${nTeams}`);

  if (!args.has("--skip-squads")) {
    const nSquads = await syncSquads(predictSeason, leagueId);
    console.log(`squads ${predictSeason}: ${nSquads}`);
  }

  if (!args.has("--skip-preseason")) {
    const nPre = await syncPreseason(predictSeason, leagueId);
    console.log(`preseason fixtures: ${nPre}`);
  }

  // Historical strength for predict season (multi-year AF stats)
  if (!args.has("--skip-history-stats")) {
    console.log(`player stats history ${historySeason}…`);
    const hist = await syncPlayerStatsHistory(leagueId, historySeason);
    console.log(`player stats history:`, hist);
  }

  if (!args.has("--skip-tm")) {
    const tmOpts = {
      forceRefresh: args.has("--refresh-tm") || args.has("--refresh"),
      leagueId,
      tmCompetition,
    };
    if (tmOpts.forceRefresh) console.log("tm: force refresh (bypass cache)");
    const nMap = await syncTmClubMap(predictSeason, tmOpts);
    console.log(`tm club map: ${nMap}`);
    const nVal = await syncMarketValues(predictSeason, tmOpts);
    console.log(`tm market values: ${nVal}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
