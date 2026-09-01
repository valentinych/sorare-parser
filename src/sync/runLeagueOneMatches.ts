import "dotenv/config";
import { syncLeagueOneMatches } from "./syncLeagueOneMatches.js";

const forceAll = process.argv.includes("--all");

async function main() {
  // --all: keep pulling until pending is 0 or a pass refreshes nothing
  let pass = 0;
  for (;;) {
    pass += 1;
    const result = await syncLeagueOneMatches({
      maxDetails: forceAll ? 80 : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!forceAll || result.pendingDetails <= 0 || result.refreshed === 0) break;
    if (pass >= 20) {
      console.warn("Stopped after 20 passes; remaining pending:", result.pendingDetails);
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
