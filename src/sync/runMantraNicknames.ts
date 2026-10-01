import "dotenv/config";
import { getDb } from "../db/index.js";
import { syncMantraManagerNicknames } from "./syncMantraManagers.js";

async function main() {
  getDb();
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) || undefined : undefined;
  const idsArg = args.find((a) => a.startsWith("--ids="));
  const ids = idsArg
    ? idsArg
        .slice("--ids=".length)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isSafeInteger(n) && n > 0)
    : undefined;
  const n = await syncMantraManagerNicknames({ limit, force, ids });
  console.log(`done (${n})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
