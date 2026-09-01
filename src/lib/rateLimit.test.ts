import assert from "node:assert/strict";
import test from "node:test";
import {
  createRequestStartScheduler,
  REQUEST_START_GAP_MS,
  type SchedulerClock,
} from "./rateLimit.js";

test("serializes request starts at least 260ms apart", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const clock: SchedulerClock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  const schedule = createRequestStartScheduler(REQUEST_START_GAP_MS, clock);

  await Promise.all(Array.from({ length: 6 }, () => schedule()));

  assert.deepEqual(sleeps, [260, 260, 260, 260, 260]);
  const starts = [0, 260, 520, 780, 1040, 1300];
  assert.deepEqual(starts, [0, 260, 520, 780, 1040, 1300]);
  for (let i = 0; i < starts.length; i++) {
    const rollingWindow = starts.filter(
      (started) => started <= starts[i]! && started > starts[i]! - 1000,
    );
    assert.ok(rollingWindow.length <= 4);
  }
});
