/**
 * Fetch Mantra division tours for Live leagues → data/mantra-tours[-{slug}].json
 *
 *   npm run sync:mantra-tours
 *   npm run sync:mantra-tours -- --league=championship
 *   npm run sync:mantra-tours -- --all
 */
import "dotenv/config";
import { syncAllMantraTours, syncMantraTours } from "./syncMantraTours.js";
import { DEFAULT_LIVE_SLUG } from "../lib/liveLeagues.js";

const args = process.argv.slice(2);
const all = args.includes("--all");
const leagueArg = args.find((a) => a.startsWith("--league="))?.split("=")[1];

if (all) {
  const results = await syncAllMantraTours();
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.ok)) process.exit(1);
} else {
  const result = await syncMantraTours(leagueArg || DEFAULT_LIVE_SLUG);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
