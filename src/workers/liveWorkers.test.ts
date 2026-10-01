import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { AF_POLL_TIMEOUT_MS, runAfPollTick } from "./liveDataPoll.js";
import {
  isComputedCacheEnqueueEnabled,
  setComputedCacheEnqueueEnabled,
} from "../lib/computedCache.js";

test("AF poll timeout is under the 5m poll interval so locks cannot stick a full cycle", () => {
  assert.ok(AF_POLL_TIMEOUT_MS > 0);
  assert.ok(AF_POLL_TIMEOUT_MS < 5 * 60 * 1000);
});

test("runAfPollTick no-ops when AF_POLL=0 (does not hang or hit network)", async () => {
  const prev = process.env.AF_POLL;
  process.env.AF_POLL = "0";
  try {
    const t0 = Date.now();
    await runAfPollTick("test");
    assert.ok(Date.now() - t0 < 500);
  } finally {
    if (prev === undefined) delete process.env.AF_POLL;
    else process.env.AF_POLL = prev;
  }
});

test("liveCompute module does not auto-start on import (argv guard)", async () => {
  setComputedCacheEnqueueEnabled(false);
  assert.equal(isComputedCacheEnqueueEnabled(), false);
  const mod = await import("./liveCompute.js");
  assert.ok(mod);
  // Worker main is not auto-run on import — enqueue stays as the test left it.
  assert.equal(isComputedCacheEnqueueEnabled(), false);
  setComputedCacheEnqueueEnabled(true);
  assert.equal(isComputedCacheEnqueueEnabled(), true);
});

test("liveCompute skips finished-tour rebuilds until Mantra GAMES grows", async () => {
  const src = await readFile(fileURLToPath(new URL("./liveCompute.ts", import.meta.url)), "utf8");
  assert.match(src, /cachedSeasonIdealCovers/);
  assert.match(src, /games=\$\{playedGames\} cached — skip/);
  assert.match(src, /warmIdealTables\(league\.slug\)/);
  assert.doesNotMatch(src, /invalidateIdealTableCache/);
});
