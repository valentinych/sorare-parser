import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  collectMantraAuction,
  validateNumericId,
} from "../clients/mantraAuction.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new Error("Usage: npm run collect:mantra-auction -- <league-id> <auction-id>");
  }
  const leagueId = validateNumericId(args[0]!, "league ID");
  const auctionId = validateNumericId(args[1]!, "auction ID");
  const artifact = await collectMantraAuction(leagueId, auctionId);
  const directory = resolve("data/mantra/auctions");
  const output = resolve(directory, `league-${leagueId}-auction-${auctionId}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Saved ${output}`);
  console.log(JSON.stringify(artifact.totals));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
