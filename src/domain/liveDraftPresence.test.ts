import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_DRAFT_ONLINE_MS,
  liveDraftPresence,
  parsePingMs,
  recordLiveDraftHeartbeat,
  resetLiveDraftPresence,
} from "./liveDraftPresence.js";

test("heartbeat marks a manager online with ping until they go stale", () => {
  resetLiveDraftPresence();
  const t0 = 1_000_000;
  recordLiveDraftHeartbeat("Owner@example.com", 42.6, t0);
  assert.deepEqual(liveDraftPresence("owner@example.com", t0), {
    online: true,
    pingMs: 43,
  });
  assert.deepEqual(
    liveDraftPresence("owner@example.com", t0 + LIVE_DRAFT_ONLINE_MS),
    { online: true, pingMs: 43 },
  );
  assert.deepEqual(
    liveDraftPresence("owner@example.com", t0 + LIVE_DRAFT_ONLINE_MS + 1),
    { online: false, pingMs: null },
  );
  assert.deepEqual(liveDraftPresence("other@example.com", t0), {
    online: false,
    pingMs: null,
  });
});

test("invalid ping is ignored but still keeps the page open", () => {
  resetLiveDraftPresence();
  const t0 = 5_000;
  recordLiveDraftHeartbeat("a@example.com", "nope", t0);
  assert.deepEqual(liveDraftPresence("a@example.com", t0), {
    online: true,
    pingMs: null,
  });
  recordLiveDraftHeartbeat("a@example.com", 12, t0 + 5_000);
  recordLiveDraftHeartbeat("a@example.com", -1, t0 + 10_000);
  assert.deepEqual(liveDraftPresence("a@example.com", t0 + 10_000), {
    online: true,
    pingMs: 12,
  });
});

test("parsePingMs rejects out-of-range values", () => {
  assert.equal(parsePingMs(0), 0);
  assert.equal(parsePingMs(81.2), 81);
  assert.equal(parsePingMs(-1), null);
  assert.equal(parsePingMs(120_001), null);
});
