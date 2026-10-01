/**
 *   npm run sync:tables
 *   npm run sync:tables -- --league=jupiler-pro-league,ligue-1
 *   npm run sync:tables -- --skip-tours
 *   npm run sync:tables -- --archives
 */
import "dotenv/config";
import { getDb } from "../db/index.js";
import { backfillTablesLeagues } from "./syncTablesBackfill.js";

getDb();
const args = process.argv.slice(2);
const leagueArg = args.find((a) => a.startsWith("--league="))?.slice("--league=".length);
const results = await backfillTablesLeagues(leagueArg, {
  skipFotmob: args.includes("--skip-fotmob"),
  skipTours: args.includes("--skip-tours"),
  skipPlayers: args.includes("--skip-players"),
  archivesOnly: args.includes("--archives"),
});
console.log(JSON.stringify(results, null, 2));
if (results.some((row) => !row.ok)) process.exit(1);
