import { syncSorareAll, syncSorareLeague } from "./syncSorare.js";

const leagueArg = process.argv.find((arg) => arg.startsWith("--league="));
const leagueId = leagueArg ? Number(leagueArg.split("=")[1]) : null;

const result =
  leagueId != null && Number.isFinite(leagueId)
    ? [await syncSorareLeague(leagueId)]
    : await syncSorareAll();

console.log(JSON.stringify(result, null, 2));
