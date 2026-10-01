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
import {
  listComputedKeys,
  peekComputedPersisted,
  setComputedCacheEnqueueEnabled,
} from "../lib/computedCache.js";
import { allLiveLeagues } from "../lib/liveLeagues.js";
import { getChampionshipStandings } from "../domain/mantraStandings.js";
import {
  finishedRoundsAlignedToGames,
  idealRoundSetEquals,
  listScoredFotmobRounds,
  loadSeasonIdealTotals,
} from "../domain/mantraIdealVsReal.js";
import { warmIdealTables } from "../domain/mantraIdealTables.js";
import {
  POLL_MS,
  runLiveComputeWarmup,
  startLiveComputeWorker,
} from "../routes/live.js";
import { warmupXiCaches } from "../domain/xiWarmup.js";

function cachedSeasonIdealCovers(slug: string, wanted: string[]): boolean {
  if (!wanted.length) return false;
  const keys = new Set([
    `season-ideal-finished:p15-gw:${slug}`,
    ...listComputedKeys("season-ideal-finished:").filter((key) => key.endsWith(`:${slug}`)),
  ]);
  for (const key of keys) {
    const cached = peekComputedPersisted<{ rounds?: string[] }>(key);
    if (idealRoundSetEquals(cached?.rounds, wanted)) return true;
  }
  return false;
}

async function warmupSeasonIdealTables(): Promise<void> {
  for (const league of allLiveLeagues()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const view = await getChampionshipStandings(league.slug, { serveStale: true });
      const playedGames = view.rows.reduce((max, row) => Math.max(max, row.games || 0), 0);
      const wanted = finishedRoundsAlignedToGames(
        listScoredFotmobRounds(league.fotmobLeagueId),
        playedGames > 0 ? playedGames : undefined,
      ).map((item) => item.round);
      if (cachedSeasonIdealCovers(league.slug, wanted)) {
        console.log(`Season Ideal TS [${league.slug}] games=${playedGames} cached — skip`);
      } else {
        loadSeasonIdealTotals(league.slug, {
          blockOnMiss: true,
          maxRounds: playedGames > 0 ? playedGames : undefined,
        });
        console.log(`Season Ideal TS [${league.slug}] games=${playedGames || "all"}`);
      }
      warmIdealTables(league.slug);
    } catch (error) {
      console.warn(
        `Season Ideal TS [${league.slug}] failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

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

  const runSeasonIdeal = () =>
    warmupSeasonIdealTables().catch((err) => {
      console.warn("Season Ideal warmup failed:", err instanceof Error ? err.message : err);
    });
  setTimeout(() => {
    void runSeasonIdeal();
  }, 20_000);
  setInterval(() => {
    void runSeasonIdeal();
  }, POLL_MS);

  // One immediate tick if COMPUTE_ONCE=1 (deploy smoke).
  if (process.env.COMPUTE_ONCE === "1") {
    await runLiveComputeWarmup("once");
    await warmupSeasonIdealTables();
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
