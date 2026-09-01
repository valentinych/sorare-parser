/**
 * Sync Mantra fantasy match lineups for Live leagues.
 *
 *   npm run sync:mantra-lineups
 *   npm run sync:mantra-lineups -- --league=championship
 *   npm run sync:mantra-lineups -- --all
 *   npm run sync:mantra-lineups -- --force --all
 */
import "dotenv/config";
import { syncAllMantraLineups, syncMantraLineups } from "./syncMantraLineups.js";
import { DEFAULT_LIVE_SLUG } from "../lib/liveLeagues.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const all = args.includes("--all");
const leagueArg = args.find((a) => a.startsWith("--league="))?.split("=")[1];

if (all) {
  const results = await syncAllMantraLineups({ force });
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.ok)) process.exit(1);
} else {
  const result = await syncMantraLineups({
    force,
    league: leagueArg || DEFAULT_LIVE_SLUG,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
