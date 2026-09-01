import "dotenv/config";
import { syncAllLiveRounds, syncLiveRound } from "./syncLive.js";
import { DEFAULT_LIVE_SLUG } from "../lib/liveLeagues.js";

const args = process.argv.slice(2);
const all = args.includes("--all");
const leagueArg = args.find((a) => a.startsWith("--league="))?.split("=")[1];

if (all) {
  const results = await syncAllLiveRounds();
  console.log(JSON.stringify(results, null, 2));
} else {
  const result = await syncLiveRound(leagueArg || DEFAULT_LIVE_SLUG);
  console.log(JSON.stringify(result, null, 2));
}
