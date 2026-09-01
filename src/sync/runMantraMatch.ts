/**
 * Smoke: Mantra login + fetch fantasy match lineups.
 * Usage: npx tsx src/sync/runMantraMatch.ts [matchId]
 * Requires MANTRA_EMAIL / MANTRA_PASSWORD in .env
 */
import "dotenv/config";
import {
  fetchMantraMatch,
  mantraCredentialsConfigured,
  mantraLogin,
} from "../clients/mantraAuth.js";

const matchId = Number(process.argv[2] ?? 71647);
if (!mantraCredentialsConfigured()) {
  console.error("Missing MANTRA_EMAIL / MANTRA_PASSWORD in .env");
  process.exit(1);
}

await mantraLogin();
const match = await fetchMantraMatch(matchId);
console.log(
  `${match.home.teamName} (${match.home.module}) ${match.home.fantasyScore} — ${match.away.fantasyScore} ${match.away.teamName} (${match.away.module})`,
);
console.log(
  "home XI:",
  match.home.lineup.map((p) => `${p.positions.join("/") || "?"}:${p.playerName}`).join(", "),
);
console.log(
  "away XI:",
  match.away.lineup.map((p) => `${p.positions.join("/") || "?"}:${p.playerName}`).join(", "),
);
console.log(
  "sizes XI/sub/out",
  `${match.home.squad.length}/${match.home.substitutes.length}/${match.home.notInSquad.length}`,
  `${match.away.squad.length}/${match.away.substitutes.length}/${match.away.notInSquad.length}`,
);
