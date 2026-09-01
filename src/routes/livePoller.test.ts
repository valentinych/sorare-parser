import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  POLL_MS,
  withExclusiveLock,
  withTimeout,
  resetLivePollerStateForTests,
  startLivePoller,
  setLiveFotmobSyncForTests,
  type ExclusiveLock,
} from "./live.js";

test("live poller interval is 5 minutes", () => {
  assert.equal(POLL_MS, 5 * 60 * 1000);
});

test("FotMob lock can run while Mantra lock is held", async () => {
  const fotmob: ExclusiveLock = { running: false };
  const mantra: ExclusiveLock = { running: false };
  let fotmobRan = false;

  const hold = new Promise<void>((resolve) => {
    void withExclusiveLock(
      mantra,
      () =>
        new Promise<string>((inner) => {
          void withExclusiveLock(fotmob, async () => {
            fotmobRan = true;
            return "fotmob";
          }, "skip").then(() => inner("mantra"));
        }),
      "skip",
    ).then(() => resolve());
  });

  await hold;
  assert.equal(fotmobRan, true);
  assert.equal(fotmob.running, false);
  assert.equal(mantra.running, false);
});

test("withTimeout rejects when work never settles", async () => {
  const { MANTRA_POLL_TIMEOUT_MS } = await import("./live.js");
  assert.equal(MANTRA_POLL_TIMEOUT_MS, 4 * 60 * 1000);
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 20, "Mantra"),
    /Live Mantra poll timed out after 20ms/,
  );
});

test("Mantra poll wraps body in withTimeout so lock cannot stick", async () => {
  const src = await readFile(new URL("./live.ts", import.meta.url), "utf8");
  assert.match(src, /MANTRA_POLL_TIMEOUT_MS/);
  assert.match(src, /withTimeout\(runMantraPollBody\(reason\), MANTRA_POLL_TIMEOUT_MS/);
  assert.match(src, /afterMantraPollDataWork/);
  assert.match(src, /runLiveComputeWarmup/);
});

test("same lock skips a second FotMob cycle instead of stacking", async () => {
  const lock: ExclusiveLock = { running: false };
  let starts = 0;
  let release!: () => void;
  const first = withExclusiveLock(
    lock,
    () =>
      new Promise<string>((resolve) => {
        starts += 1;
        release = () => resolve("one");
      }),
    "skip",
  );
  const second = await withExclusiveLock(lock, async () => {
    starts += 1;
    return "two";
  }, "skip");
  assert.equal(second.skipped, true);
  assert.equal(second.value, "skip");
  release();
  const done = await first;
  assert.equal(done.skipped, false);
  assert.equal(done.value, "one");
  assert.equal(starts, 1);
});

test("workers and web compose keep poll/compute off the HTTP process", async () => {
  const [compose, poll, compute, server, pkg] = await Promise.all([
    readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../workers/liveDataPoll.ts", import.meta.url), "utf8"),
    readFile(new URL("../workers/liveCompute.ts", import.meta.url), "utf8"),
    readFile(new URL("../tm-server.ts", import.meta.url), "utf8"),
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(compose, /LIVE_POLLER:\s*"0"/);
  assert.match(compose, /COMPUTE_ENQUEUE:\s*"0"/);
  assert.match(compose, /LIVE_COMPUTE_INPROCESS:\s*"0"/);
  assert.match(compose, /live-poll:/);
  assert.match(compose, /live-compute:/);
  assert.match(compose, /src\/workers\/liveDataPoll\.ts/);
  assert.match(compose, /src\/workers\/liveCompute\.ts/);
  assert.match(compose, /COMPUTE_ENQUEUE:\s*"1"/);
  assert.match(poll, /startLivePoller/);
  assert.match(poll, /syncLeagueFixturesAndOdds/);
  assert.match(poll, /createTaskQueue/);
  assert.match(poll, /AF_POLL_TIMEOUT_MS|withTimeout\(runAfPollTick/);
  assert.doesNotMatch(poll, /startLiveComputeWorker|runLiveComputeWarmup/);
  assert.match(compute, /startLiveComputeWorker/);
  assert.match(compute, /setComputedCacheEnqueueEnabled\(true\)/);
  assert.doesNotMatch(compute, /startLivePoller|syncAllLiveRounds|syncMantraTours/);
  assert.match(server, /COMPUTE_ENQUEUE/);
  assert.match(server, /setComputedCacheEnqueueEnabled\(false\)/);
  assert.match(server, /LIVE_POLLER !== "0"/);
  assert.match(pkg, /"worker:live-poll"/);
  assert.match(pkg, /"worker:live-compute"/);
});

test("startLivePoller schedules without blocking the caller forever", () => {
  resetLivePollerStateForTests();
  let syncStarted = 0;
  setLiveFotmobSyncForTests(async () => {
    syncStarted += 1;
    await new Promise(() => {});
    return [];
  });
  const t0 = Date.now();
  startLivePoller();
  assert.ok(Date.now() - t0 < 200, "startLivePoller must return immediately");
  resetLivePollerStateForTests();
  void syncStarted;
});

test("compute exclusive lock skips a second tick while first is held", async () => {
  const lock: ExclusiveLock = { running: false };
  let starts = 0;
  let release!: () => void;
  const first = withExclusiveLock(
    lock,
    () =>
      new Promise<void>((resolve) => {
        starts += 1;
        release = resolve;
      }),
    undefined,
    "compute",
  );
  const second = await withExclusiveLock(
    lock,
    async () => {
      starts += 1;
    },
    undefined,
    "compute",
  );
  assert.equal(second.skipped, true);
  assert.equal(starts, 1);
  release();
  await first;
  assert.equal(lock.running, false);
});

test("withExclusiveLock releases after timeout so Mantra cannot stick forever", async () => {
  const lock: ExclusiveLock = { running: false };
  await assert.rejects(
    () =>
      withExclusiveLock(
        lock,
        () => withTimeout(new Promise(() => {}), 25, "Mantra"),
        undefined,
        "Mantra",
      ),
    /Live Mantra poll timed out after 25ms/,
  );
  assert.equal(lock.running, false);
  const next = await withExclusiveLock(lock, async () => "ok", "skip", "Mantra");
  assert.equal(next.skipped, false);
  assert.equal(next.value, "ok");
});
