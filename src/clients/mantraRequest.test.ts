import assert from "node:assert/strict";
import test from "node:test";
import { mantraFetchWithRetry, retryAfterMs } from "./mantraRequest.js";

test("parses Retry-After seconds and HTTP dates", () => {
  assert.equal(retryAfterMs("2", 0), 2000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:03 GMT", 1000), 2000);
  assert.equal(retryAfterMs("invalid", 0), null);
});

test("schedules a 429 retry and honors Retry-After", async () => {
  const waits: number[] = [];
  let starts = 0;
  let calls = 0;
  const response = await mantraFetchWithRetry(
    "https://mantrafootball.org/api/example",
    {},
    {
      schedule: async () => {
        starts++;
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async () => {
        calls++;
        return calls === 1
          ? new Response("", { status: 429, headers: { "Retry-After": "3" } })
          : Response.json({ ok: true });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(starts, 2);
  assert.deepEqual(waits, [3000]);
});
