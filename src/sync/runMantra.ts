import { getDb } from "../db/index.js";
import { syncMantraAll, syncMantraFantasyTeams, syncMantraLeagues } from "./syncMantra.js";
import { uniqueMantraTournaments } from "../lib/afLeagues.js";

async function main() {
  getDb();
  const args = process.argv.slice(2);
  const argSet = new Set(args);
  const profileLimit = Number(process.env.MANTRA_PROFILE_LIMIT ?? 0) || undefined;
  const forceProfiles = argSet.has("--refresh") || argSet.has("--refresh-profiles");
  const skipProfiles = argSet.has("--skip-profiles");
  const skipFantasyTeams = argSet.has("--skip-teams");
  const teamsOnly = argSet.has("--teams-only");
  const tournamentArg = args.find((a) => a.startsWith("--tournament="));
  const leagueArg = args.find((a) => a.startsWith("--league="));
  const tournamentIds = tournamentArg
    ? tournamentArg
        .slice("--tournament=".length)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    : uniqueMantraTournaments();
  const leagueIds = leagueArg
    ? leagueArg
        .slice("--league=".length)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isSafeInteger(n) && n > 0)
    : [];
  if (leagueIds.length && !tournamentArg) {
    throw new Error("--league= requires --tournament=");
  }

  if (teamsOnly || leagueIds.length) {
    for (const tid of tournamentIds) {
      console.log(`Mantra tournament ${tid}: leagues (refresh)…`);
      await syncMantraLeagues(tid);
      console.log(
        leagueIds.length
          ? `Mantra tournament ${tid}: fantasy teams (leagues ${leagueIds.join(",")})…`
          : `Mantra tournament ${tid}: fantasy teams…`,
      );
      const n = await syncMantraFantasyTeams(tid, { leagueIds });
      console.log(`  fantasy teams: ${n}`);
    }
    console.log("done");
    return;
  }

  await syncMantraAll({
    profileLimit,
    forceProfiles,
    skipProfiles,
    skipFantasyTeams,
    tournamentIds,
  });
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
