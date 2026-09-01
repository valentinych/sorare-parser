/**
 * Live data-poll worker: FotMob + Mantra (+ light API-Football) every ~5 min.
 * Does NOT compute Ideal/scores — that is liveCompute.ts.
 *
 *   npm run worker:live-poll
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/index.js";
import { config } from "../config.js";
import { allLiveLeagues } from "../lib/liveLeagues.js";
import { createTaskQueue } from "../lib/taskQueue.js";
import { REQUEST_START_GAP_MS } from "../lib/rateLimit.js";
import {
  POLL_MS,
  startLivePoller,
  withExclusiveLock,
  withTimeout,
  type ExclusiveLock,
} from "../routes/live.js";
import { syncLeagueFixturesAndOdds } from "../sync/syncOdds.js";
import { startSorarePoller } from "../sync/syncSorare.js";

/** Cap one AF league tick so a hung HTTP call cannot stick afLock forever. */
export const AF_POLL_TIMEOUT_MS = 2 * 60 * 1000;

const afLock: ExclusiveLock = { running: false };
const afQueue = createTaskQueue({
  name: "api-football",
  concurrency: 1,
  minStartGapMs: REQUEST_START_GAP_MS,
});

let afCursor = 0;

/** One live AF league per tick — keeps 5m cadence without burning the whole quota. */
export async function runAfPollTick(reason: string): Promise<void> {
  if (process.env.AF_POLL === "0") return;
  if (!config.apiFootballKey) {
    console.log("AF poll skipped (API_FOOTBALL_KEY unset)");
    return;
  }
  const leagues = allLiveLeagues();
  if (!leagues.length) return;
  const league = leagues[afCursor % leagues.length]!;
  afCursor += 1;
  await afQueue.enqueue(`af:${league.id}`, async () => {
    console.log(`AF poll (${reason}) league=${league.slug} id=${league.id}…`);
    const r = await syncLeagueFixturesAndOdds(league.id, config.predictSeason);
    console.log(`AF poll done [${league.slug}]`, r);
  });
}

async function runAfPollGuarded(reason: string): Promise<void> {
  const { skipped } = await withExclusiveLock(
    afLock,
    () => withTimeout(runAfPollTick(reason), AF_POLL_TIMEOUT_MS, "AF"),
    undefined,
    "AF",
  );
  if (skipped) console.log(`AF ${reason} skipped (lock held)`);
}

async function main(): Promise<void> {
  getDb();
  console.log("worker:live-poll starting (FotMob + Mantra + AF round-robin)");
  startLivePoller();
  if (process.env.SORARE_POLLER !== "0") startSorarePoller();

  // AF runs on the same 5m cadence, outside FotMob/Mantra locks.
  setTimeout(() => {
    void runAfPollGuarded("boot").catch((err) => {
      console.warn("AF boot failed:", err instanceof Error ? err.message : err);
    });
  }, 15_000);
  setInterval(() => {
    void runAfPollGuarded("interval-5m").catch((err) => {
      console.warn("AF interval failed:", err instanceof Error ? err.message : err);
    });
  }, POLL_MS);
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
