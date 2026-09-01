import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { fotmobHttpCalls, resetFotmobHttpCallsForTests } from "../clients/fotmob.js";
import type { LiveSyncResult } from "../sync/syncLive.js";
import {
  kickFotmobRefresh,
  liveRoutes,
  resetLivePollerStateForTests,
  runFotmobPoll,
  setLiveFotmobSyncForTests,
} from "./live.js";

function sampleSync(syncedAt: string): LiveSyncResult {
  return {
    slug: "ekstraklasa",
    fotmobLeagueId: 196,
    round: "4",
    listed: 9,
    refreshed: 0,
    live: 0,
    finished: 9,
    upcoming: 0,
    syncedAt,
  };
}

test.beforeEach(() => {
  resetLivePollerStateForTests();
  resetFotmobHttpCallsForTests();
  setLiveFotmobSyncForTests(async () => []);
});

test.afterEach(() => {
  resetLivePollerStateForTests();
  setLiveFotmobSyncForTests(async () => []);
});

test("GET /live does not call FotMob HTTP and returns without waiting on a hung sync", async () => {
  setLiveFotmobSyncForTests(async () => [sampleSync("2020-01-01T00:00:00.000Z")]);
  await runFotmobPoll("seed");
  setLiveFotmobSyncForTests(async () => {
    await new Promise(() => {});
    return [];
  });
  const app = Fastify();
  await app.register(liveRoutes);
  const t0 = Date.now();
  const res = await app.inject({
    method: "GET",
    url: "/live?league=ekstraklasa&round=4",
  });
  const ms = Date.now() - t0;
  assert.equal(res.statusCode, 200);
  assert.ok(ms < 2000, `GET /live took ${ms}ms`);
  assert.equal(fotmobHttpCalls, 0);
  const body = res.json();
  assert.ok(Array.isArray(body.matches));
  assert.equal(body.mantra.idealStandings, null);
  assert.equal(body.account, null);
  await app.close();
});

test("GET /live cache hit is fast and POST /live/refresh does not await FotMob", async () => {
  let syncStarted = 0;
  let release!: () => void;
  setLiveFotmobSyncForTests(async () => {
    syncStarted += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return [sampleSync(new Date().toISOString())];
  });
  const app = Fastify();
  await app.register(liveRoutes);
  const first = await app.inject({
    method: "GET",
    url: "/live?league=ekstraklasa&round=4",
  });
  const t0 = Date.now();
  const second = await app.inject({
    method: "GET",
    url: "/live?league=ekstraklasa&round=4",
  });
  const hitMs = Date.now() - t0;
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.ok(hitMs < 1500, `cache-hit GET /live took ${hitMs}ms`);

  const t1 = Date.now();
  const refresh = await app.inject({
    method: "POST",
    url: "/live/refresh?league=ekstraklasa&round=4",
  });
  const refreshMs = Date.now() - t1;
  assert.equal(refresh.statusCode, 200);
  assert.equal(refresh.json().refreshing, true);
  assert.ok(refreshMs < 2000, `POST /live/refresh took ${refreshMs}ms`);
  assert.equal(fotmobHttpCalls, 0);
  await app.close();
  release?.();
  void syncStarted;
});

test("poller still updates lastSync that GET /live returns", async () => {
  const syncedAt = "2026-08-16T19:40:00.000Z";
  setLiveFotmobSyncForTests(async () => [sampleSync(syncedAt)]);
  const updated = await runFotmobPoll("test");
  assert.equal(updated[0]?.syncedAt, syncedAt);

  const app = Fastify();
  await app.register(liveRoutes);
  const res = await app.inject({
    method: "GET",
    url: "/live?league=ekstraklasa&round=4",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().poll.lastSync.syncedAt, syncedAt);
  assert.equal(fotmobHttpCalls, 0);
  await app.close();
});

test("kickFotmobRefresh runs the poller after the call returns", async () => {
  await new Promise((r) => setImmediate(r));
  let ran = 0;
  setLiveFotmobSyncForTests(async () => {
    ran += 1;
    return [sampleSync("2026-08-16T19:41:00.000Z")];
  });
  kickFotmobRefresh("test-kick");
  assert.equal(ran, 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(ran, 1);
});

test("LIVE_POLLER=0 skips HTTP FotMob kick (workers own polling)", async () => {
  const prevPoller = process.env.LIVE_POLLER;
  const prevHttp = process.env.LIVE_HTTP_REFRESH;
  process.env.LIVE_POLLER = "0";
  delete process.env.LIVE_HTTP_REFRESH;
  try {
    let ran = 0;
    setLiveFotmobSyncForTests(async () => {
      ran += 1;
      return [sampleSync("2026-08-16T19:42:00.000Z")];
    });
    kickFotmobRefresh("web-should-skip");
    await new Promise((r) => setImmediate(r));
    assert.equal(ran, 0);

    const app = Fastify();
    await app.register(liveRoutes);
    const refresh = await app.inject({
      method: "POST",
      url: "/live/refresh?league=ekstraklasa&round=4",
    });
    assert.equal(refresh.statusCode, 200);
    assert.equal(refresh.json().refreshing, false);
    assert.equal(refresh.json().workerOwned, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(ran, 0);
    await app.close();
  } finally {
    if (prevPoller === undefined) delete process.env.LIVE_POLLER;
    else process.env.LIVE_POLLER = prevPoller;
    if (prevHttp === undefined) delete process.env.LIVE_HTTP_REFRESH;
    else process.env.LIVE_HTTP_REFRESH = prevHttp;
  }
});

test("stale GET /live with LIVE_POLLER=0 does not kick network sync", async () => {
  const prevPoller = process.env.LIVE_POLLER;
  const prevHttp = process.env.LIVE_HTTP_REFRESH;
  process.env.LIVE_POLLER = "0";
  delete process.env.LIVE_HTTP_REFRESH;
  try {
    let ran = 0;
    setLiveFotmobSyncForTests(async () => {
      ran += 1;
      return [sampleSync("2020-01-01T00:00:00.000Z")];
    });
    await runFotmobPoll("seed-stale");
    assert.equal(ran, 1);
    ran = 0;

    const app = Fastify();
    await app.register(liveRoutes);
    const res = await app.inject({
      method: "GET",
      url: "/live?league=ekstraklasa&round=4",
    });
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(ran, 0, "stale GET must not kick FotMob when LIVE_POLLER=0");
    await app.close();
  } finally {
    if (prevPoller === undefined) delete process.env.LIVE_POLLER;
    else process.env.LIVE_POLLER = prevPoller;
    if (prevHttp === undefined) delete process.env.LIVE_HTTP_REFRESH;
    else process.env.LIVE_HTTP_REFRESH = prevHttp;
  }
});
