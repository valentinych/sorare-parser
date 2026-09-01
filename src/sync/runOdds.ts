import { getDb } from "../db/index.js";
import { syncLeagueFixturesAndOdds } from "./syncOdds.js";
import { config } from "../config.js";

async function main() {
  getDb();
  const args = process.argv.slice(2);
  const leagueArg = args.find((a) => a.startsWith("--league="));
  const seasonArg = args.find((a) => a.startsWith("--season="));
  const leagueIds = leagueArg
    ? leagueArg
        .slice("--league=".length)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [config.leagueId];
  const season = seasonArg ? Number(seasonArg.slice("--season=".length)) : config.predictSeason;
  if (!leagueIds.length) {
    throw new Error("Pass --league=39 or comma-separated AF league ids");
  }
  for (const leagueId of leagueIds) {
    const r = await syncLeagueFixturesAndOdds(leagueId, season);
    console.log(`done league=${leagueId}`, r);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
