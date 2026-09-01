import { getDb } from "../db/index.js";
import { syncTmLeague } from "./syncTmLeague.js";
import { enrichTmPlayersFromRaw, syncTmAttributes, syncTmFixturesAndGames } from "./syncTmDeep.js";
import { tmQueueStats } from "../lib/tmQueue.js";

async function main() {
  getDb();
  const args = new Set(process.argv.slice(2));
  const forceRefresh = args.has("--refresh") || args.has("--refresh-tm");
  const skipDeep = args.has("--league-only");
  const deepOnly = args.has("--deep-only");
  const code = process.env.TM_COMPETITION ?? "PL1";

  if (!deepOnly) {
    await syncTmLeague(code, { forceRefresh });
  }

  if (!skipDeep) {
    console.log("TM attributes…");
    await syncTmAttributes({ forceRefresh });
    enrichTmPlayersFromRaw();
    console.log("TM fixtures + games…");
    await syncTmFixturesAndGames({ forceRefresh, competitionId: code });
    enrichTmPlayersFromRaw();
  }

  console.log("queue stats", tmQueueStats());
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
