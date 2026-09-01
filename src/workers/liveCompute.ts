/**
 * Live compute worker: Ideal vs Real / Dream Team / score maps every ~5 min.
 * Reads DB + Mantra lineup JSON written by liveDataPoll — never hits Mantra/FotMob HTTP.
 *
 *   npm run worker:live-compute
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/index.js";
import { setComputedCacheEnqueueEnabled } from "../lib/computedCache.js";
import {
  POLL_MS,
  runLiveComputeWarmup,
  startLiveComputeWorker,
} from "../routes/live.js";
import { warmupXiCaches } from "../domain/xiWarmup.js";

async function main(): Promise<void> {
  getDb();
  // This process owns writes; always allow getComputed rebuilds.
  setComputedCacheEnqueueEnabled(true);
  console.log(`worker:live-compute starting (every ${POLL_MS / 1000}s)`);
  startLiveComputeWorker();

  if (process.env.XI_CACHE_WARMUP !== "0") {
    setTimeout(() => {
      void warmupXiCaches().catch((err) => {
        console.warn("XI warmup failed:", err instanceof Error ? err.message : err);
      });
    }, 30_000);
  }

  // One immediate tick if COMPUTE_ONCE=1 (deploy smoke).
  if (process.env.COMPUTE_ONCE === "1") {
    await runLiveComputeWarmup("once");
    process.exit(0);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
