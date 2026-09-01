import assert from "node:assert/strict";
import test from "node:test";
import { withTimeout } from "./withTimeout.js";

test("withTimeout resolves when work finishes first", async () => {
  const value = await withTimeout(Promise.resolve("ok"), 50, "slow");
  assert.equal(value, "ok");
});

test("withTimeout rejects so a hung FotMob fetch cannot stall the poller", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 20, "FotMob /matchDetails timed out"),
    /FotMob \/matchDetails timed out/,
  );
});
