import { getDb } from "../db/index.js";
import { syncLeagueOne } from "../domain/leagueOne.js";

async function main() {
  getDb();
  const args = new Set(process.argv.slice(2));
  const forceRefresh = args.has("--refresh") || args.has("--refresh-tm");
  const skipTm = args.has("--skip-tm") || args.has("--fotmob-only");
  console.log(
    `League One sync (TM GB3 + FotMob 108)${forceRefresh ? " refresh" : ""}${skipTm ? " skip-tm" : ""}…`,
  );
  const snapshot = await syncLeagueOne({ forceRefresh, skipTm });
  console.log("counts", snapshot.counts);
  console.log("wrote data/league-one.json at", snapshot.syncedAt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
