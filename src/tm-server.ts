import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { getDb } from "./db/index.js";
import { accountRoutes } from "./routes/account.js";
import { ekstraklasaRoutes } from "./routes/ekstraklasa.js";
import { tmStatsRoutes } from "./routes/tmStats.js";
import { liveRoutes, startLivePoller, startLiveComputeWorker } from "./routes/live.js";
import { sorareRoutes } from "./routes/sorare.js";
import { sorareImportRoutes } from "./routes/sorareImport.js";
import { expected11Routes } from "./routes/expected11.js";
import { expected11PremiumRoutes } from "./routes/expected11Premium.js";
import { leagueOneRoutes } from "./routes/leagueOne.js";
import { footmopsRoutes } from "./routes/footmops.js";
import { liveDraftRoutes } from "./routes/liveDraft.js";
import { liveDraftPageRoutes } from "./routes/liveDraftPage.js";
import { spaPageRoutes } from "./routes/spaPages.js";
import { mantraAuctionRoutes } from "./routes/mantraAuctions.js";
import { startSorarePoller } from "./sync/syncSorare.js";
import { ensureFootmopsImported } from "./domain/footmops.js";
import { warmupXiCaches } from "./domain/xiWarmup.js";
import { setComputedCacheEnqueueEnabled } from "./lib/computedCache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public-tm");
const port = Number(process.env.TM_PORT ?? 3001);

async function main() {
  getDb();
  // Separate compute worker owns rebuilds — HTTP only peeks computed_cache / SQLite.
  if (process.env.COMPUTE_ENQUEUE === "0") {
    setComputedCacheEnqueueEnabled(false);
    console.log("computed_cache enqueue disabled (web serves DB only)");
  }
  try {
    const imported = ensureFootmopsImported();
    if (imported) {
      console.log(
        `footmops imported ${imported.league} t${imported.tour}: linked=${imported.linked} unmatched=${imported.unmatched}`,
      );
    }
  } catch (error) {
    console.warn("footmops import failed", error);
  }
  const app = Fastify({ logger: true, trustProxy: true });

  await app.register(accountRoutes);
  await app.register(tmStatsRoutes);
  await app.register(ekstraklasaRoutes);
  await app.register(liveRoutes);
  await app.register(sorareRoutes);
  await app.register(sorareImportRoutes);
  await app.register(expected11Routes);
  await app.register(expected11PremiumRoutes);
  await app.register(leagueOneRoutes);
  await app.register(footmopsRoutes);
  await app.register(liveDraftRoutes);
  await app.register(liveDraftPageRoutes, { publicDir });
  await app.register(spaPageRoutes, { publicDir });
  await app.register(mantraAuctionRoutes);
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    index: false,
  });

  await app.listen({ port, host: "0.0.0.0" });
  console.log(`TM stats UI → http://127.0.0.1:${port}`);
  // Prod compose sets LIVE_POLLER=0 — data-poll + compute workers own the cadence.
  if (process.env.LIVE_POLLER !== "0") {
    startLivePoller();
    // Single-process fallback: also compute in-web unless an external worker is used.
    if (process.env.LIVE_COMPUTE_INPROCESS !== "0") startLiveComputeWorker();
  }
  if (process.env.SORARE_POLLER !== "0") startSorarePoller();
  if (process.env.XI_CACHE_WARMUP !== "0" && process.env.LIVE_POLLER !== "0") {
    // After Live boot poll has headroom — only when pollers still live in-web.
    setTimeout(() => {
      void warmupXiCaches();
    }, 120_000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
