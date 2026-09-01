/**
 * Sync AF player stats for historySeason + 2 prior years (cards/CS fields included).
 *
 *   npm run sync:stats
 *   npm run sync:stats -- --league=106,39
 *   npm run sync:stats -- --comps          # full multi-comp via /players?id= (current season)
 *   npm run sync:stats -- --comps --competition=GB1
 *   npm run sync:stats -- --uefa           # CL/EL/UECL into player_comp_stats
 *   npm run sync:stats -- --skip-history   # only comps / uefa, skip domestic history
 */
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { AF_LEAGUES, allLeagueIds } from "../lib/afLeagues.js";
import {
  linkedAfPlayerIds,
  syncPlayerCompStatsByIds,
  syncPlayerCompStatsSeason,
  syncPlayerStatsHistory,
  UEFA_COMP_LEAGUE_IDS,
} from "./syncSquads.js";
import { syncTmPerfFromGames } from "./syncTmPerf.js";

async function main() {
  getDb();
  const args = process.argv.slice(2);
  const leagueArg = args.find((a) => a.startsWith("--league="));
  const competitionArg = args.find((a) => a.startsWith("--competition="));
  const leagueIds = leagueArg
    ? leagueArg
        .slice("--league=".length)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    : allLeagueIds();
  const competitionId = competitionArg?.slice("--competition=".length) || undefined;
  const doComps = args.includes("--comps");
  const doUefa = args.includes("--uefa") || doComps;
  const skipHistory = args.includes("--skip-history") || (doComps && !leagueArg);

  if (!skipHistory) {
    for (const id of leagueIds) {
      if (!AF_LEAGUES[id]) throw new Error(`Unknown league ${id}`);
      console.log(`\n═══ Stats ${AF_LEAGUES[id]!.name} (${id}) ═══`);
      const hist = await syncPlayerStatsHistory(id, config.season);
      console.log("  done", hist);
    }
  }

  if (doUefa) {
    console.log(`\n═══ UEFA comps → player_comp_stats ${config.season} ═══`);
    for (const id of UEFA_COMP_LEAGUE_IDS) {
      console.log(`  league ${id}…`);
      const n = await syncPlayerCompStatsSeason(id, config.season);
      console.log(`  → ${n} blocks`);
    }
  }

  if (doComps) {
    const ids = linkedAfPlayerIds(competitionId);
    console.log(
      `\n═══ Full comp stats by player id (${ids.length} players, season ${config.season}${
        competitionId ? `, ${competitionId}` : ""
      }) ═══`,
    );
    const n = await syncPlayerCompStatsByIds(ids, config.season, {
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) {
          console.log(`  ${done}/${total}`);
        }
      },
    });
    console.log(`  → ${n} blocks`);
  }

  if (!args.includes("--skip-tm-perf") && !skipHistory) {
    const n = syncTmPerfFromGames(config.season);
    console.log(`\ntm perf aggregate ${config.season}: ${n}`);
  }
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
