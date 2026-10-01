import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  AUCTION_REFRESH_COOLDOWN_MS,
  getAuctionRefreshCooldown,
  markAuctionRefreshDone,
} from "../domain/auctionRefreshCooldown.js";
import {
  expected11PremiumRoutes,
  resetPremiumAuctionRefreshLockForTests,
  type Expected11PremiumActor,
} from "./expected11Premium.js";

function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
): Expected11PremiumActor | null {
  const role = request.headers["x-test-role"];
  if (!role) {
    reply.code(401).send({ error: "authentication_required" });
    return null;
  }
  if (role !== "entitled") {
    reply.code(403).send({ error: "expected11_premium_forbidden" });
    return null;
  }
  return {
    id: 1,
    email: "owner@example.com",
    mantraManagerId: 99,
  };
}

function authorizeAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Expected11PremiumActor | null {
  const role = request.headers["x-test-role"];
  if (!role) {
    reply.code(401).send({ error: "authentication_required" });
    return null;
  }
  if (role !== "admin") {
    reply.code(403).send({ error: "expected11_admin_forbidden" });
    return null;
  }
  return {
    id: 1,
    email: "aharodnik@gmail.com",
    mantraManagerId: 99,
  };
}

test("Mapping and Premium APIs enforce 401, 403, and authorized access", async (t) => {
  const app = Fastify();
  await app.register(expected11PremiumRoutes, {
    authorize,
    mappingView: () => ({ counts: { linked: 1 }, groups: [], mappings: [] }) as never,
    premiumView: () => ({ rows: [{ mantraPlayerId: 1 }] }) as never,
  });
  t.after(() => app.close());

  for (const url of ["/api/expected11/mapping", "/api/expected11/premium"]) {
    const unauthenticated = await app.inject({ method: "GET", url });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.json().error, "authentication_required");

    const forbidden = await app.inject({
      method: "GET",
      url,
      headers: { "x-test-role": "other" },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error, "expected11_premium_forbidden");

    const authorized = await app.inject({
      method: "GET",
      url,
      headers: { "x-test-role": "entitled" },
    });
    assert.equal(authorized.statusCode, 200);
  }
});

test("authorized Mapping mutations pass session actor and payload", async (t) => {
  const app = Fastify();
  let saved:
    | {
        sourceName: string;
        mantraClubId: number;
        mantraPlayerId: number;
        actor: Expected11PremiumActor;
      }
    | undefined;
  let removed: { sourceName: string; mantraClubId: number } | undefined;
  await app.register(expected11PremiumRoutes, {
    authorize,
    saveMapping: (
      input: {
        sourceName: string;
        mantraClubId: number;
        mantraPlayerId: number;
      },
      actor: Expected11PremiumActor,
    ) => {
      saved = { ...input, actor };
      return { ok: true } as never;
    },
    removeMapping: (input: { sourceName: string; mantraClubId: number }) => {
      removed = input;
      return { ok: true } as never;
    },
  });
  t.after(() => app.close());

  const save = await app.inject({
    method: "PUT",
    url: "/api/expected11/mapping",
    headers: {
      "x-test-role": "entitled",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: {
      sourceName: "Player",
      mantraClubId: 10,
      mantraPlayerId: 20,
    },
  });
  assert.equal(save.statusCode, 200);
  assert.equal(saved?.sourceName, "Player");
  assert.equal(saved?.actor.email, "owner@example.com");

  const remove = await app.inject({
    method: "DELETE",
    url: "/api/expected11/mapping",
    headers: {
      "x-test-role": "entitled",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: { sourceName: "Player", mantraClubId: 10 },
  });
  assert.equal(remove.statusCode, 200);
  assert.deepEqual(removed, { sourceName: "Player", mantraClubId: 10 });
});

test("Premium refresh is same-origin POST and forces a squad pull", async (t) => {
  const app = Fastify();
  const pulls: Array<{ id: number; force: boolean }> = [];
  await app.register(expected11PremiumRoutes, {
    authorize,
    premiumView: () => ({ rows: [{ mantraPlayerId: 7 }] }) as never,
    ensureSquads: (actor, force) => {
      pulls.push({ id: actor.mantraManagerId ?? 0, force });
    },
  });
  t.after(() => app.close());

  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh",
  });
  assert.equal(unauthenticated.statusCode, 401);

  const crossOrigin = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh",
    headers: {
      "x-test-role": "entitled",
      origin: "https://evil.example",
      host: "localhost:3000",
    },
  });
  assert.equal(crossOrigin.statusCode, 403);

  const first = await app.inject({
    method: "GET",
    url: "/api/expected11/premium",
    headers: { "x-test-role": "entitled" },
  });
  const refresh = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh",
    headers: {
      "x-test-role": "entitled",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(refresh.statusCode, 200);
  assert.equal(refresh.json().rows[0]?.mantraPlayerId, 7);
  assert.deepEqual(pulls, [
    { id: 99, force: false },
    { id: 99, force: true },
  ]);
});

test("Premium squad report is entitled-only and requires teamId", async (t) => {
  const app = Fastify();
  await app.register(expected11PremiumRoutes, {
    authorize,
    squadReport: (options, actor) => ({
      ok: true,
      teamId: options.teamId,
      fresh: options.fresh ?? false,
      managerId: actor.mantraManagerId,
      players: [{ mantraPlayerId: 1, ratingSource: "fotmob" }],
      sofaScore: false,
    }),
  });
  t.after(() => app.close());

  const unauthenticated = await app.inject({
    method: "GET",
    url: "/api/expected11/premium/squad-report?teamId=10",
  });
  assert.equal(unauthenticated.statusCode, 401);

  const forbidden = await app.inject({
    method: "GET",
    url: "/api/expected11/premium/squad-report?teamId=10",
    headers: { "x-test-role": "other" },
  });
  assert.equal(forbidden.statusCode, 403);

  const missingTeam = await app.inject({
    method: "GET",
    url: "/api/expected11/premium/squad-report",
    headers: { "x-test-role": "entitled" },
  });
  assert.equal(missingTeam.statusCode, 400);

  const ok = await app.inject({
    method: "GET",
    url: "/api/expected11/premium/squad-report?teamId=10&fresh=1",
    headers: { "x-test-role": "entitled" },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().teamId, 10);
  assert.equal(ok.json().fresh, true);
  assert.equal(ok.json().sofaScore, false);
});

test("GET /api/expected11/premium does not wait for a hanging Mantra squad pull", async (t) => {
  const app = Fastify();
  let auctionPulls = 0;
  await app.register(expected11PremiumRoutes, {
    authorize,
    premiumView: () => ({ rows: [{ mantraPlayerId: 3 }] }) as never,
    ensureSquads: () => new Promise(() => {}),
    refreshAuctionStatus: () => {
      auctionPulls += 1;
      return new Promise(() => {});
    },
  });
  t.after(() => app.close());
  const started = Date.now();
  const res = await app.inject({
    method: "GET",
    url: "/api/expected11/premium",
    headers: { "x-test-role": "entitled" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().rows[0]?.mantraPlayerId, 3);
  assert.equal(auctionPulls, 0);
  assert.ok(Date.now() - started < 500);
});

test("admin auction refresh is 401/403 and POST is scoped to one league", async (t) => {
  resetPremiumAuctionRefreshLockForTests();
  const app = Fastify();
  const pulls: Array<{ leagueId: number; tournamentId?: number | null; teamId?: number | null }> =
    [];
  await app.register(expected11PremiumRoutes, {
    authorize,
    authorizeAdmin,
    lookupTeamLeague: (teamId) =>
      teamId === 10 ? { leagueId: 583, tournamentId: 18 } : null,
    refreshAuctionStatus: (input) => {
      pulls.push(input);
      return {
        ok: true,
        league: input.leagueId,
        tournamentId: input.tournamentId ?? 18,
        teamId: input.teamId ?? null,
        auctions: {
          discovered: 1,
          imported: 1,
          players: 4,
          warning: "league html empty",
        },
        teams: 8,
      };
    },
    auctionRefreshCooldown: () => ({
      lastRefreshedAt: null,
      remainingMs: 0,
      availableAt: null,
    }),
    markAuctionRefresh: () => ({
      lastRefreshedAt: "2026-10-01T12:00:00.000Z",
      remainingMs: AUCTION_REFRESH_COOLDOWN_MS,
      availableAt: "2026-10-01T12:30:00.000Z",
    }),
  });
  t.after(() => {
    resetPremiumAuctionRefreshLockForTests();
    return app.close();
  });

  const unauthenticatedGet = await app.inject({
    method: "GET",
    url: "/api/expected11/premium/refresh-auctions?leagueId=583",
  });
  assert.equal(unauthenticatedGet.statusCode, 401);

  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh-auctions",
  });
  assert.equal(unauthenticated.statusCode, 401);

  const nonAdmin = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh-auctions",
    headers: {
      "x-test-role": "entitled",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: { teamId: 10 },
  });
  assert.equal(nonAdmin.statusCode, 403);
  assert.equal(nonAdmin.json().error, "expected11_admin_forbidden");

  const missing = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh-auctions",
    headers: {
      "x-test-role": "admin",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: {},
  });
  assert.equal(missing.statusCode, 400);

  const ok = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh-auctions",
    headers: {
      "x-test-role": "admin",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: { teamId: 10 },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ok, true);
  assert.equal(ok.json().league, 583);
  assert.equal(ok.json().teams, 8);
  assert.equal(ok.json().lastRefreshedAt, "2026-10-01T12:00:00.000Z");
  assert.equal(ok.json().remainingMs, AUCTION_REFRESH_COOLDOWN_MS);
  assert.deepEqual(pulls, [{ leagueId: 583, tournamentId: 18, teamId: 10 }]);

  pulls.length = 0;
  const byLeague = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh-auctions",
    headers: {
      "x-test-role": "admin",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: { leagueId: 584 },
  });
  assert.equal(byLeague.statusCode, 200);
  assert.equal(byLeague.json().league, 584);
  assert.deepEqual(pulls, [{ leagueId: 584, tournamentId: null, teamId: null }]);
});

test("auction refresh cooldown is 30 min per league in sqlite", async (t) => {
  resetPremiumAuctionRefreshLockForTests();
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
  let nowMs = Date.parse("2026-10-01T12:00:00.000Z");
  const now = () => new Date(nowMs);
  const pulls: number[] = [];
  const app = Fastify();
  await app.register(expected11PremiumRoutes, {
    authorize,
    authorizeAdmin,
    refreshAuctionStatus: (input) => {
      pulls.push(input.leagueId);
      return {
        ok: true,
        league: input.leagueId,
        tournamentId: null,
        teamId: null,
        auctions: { discovered: 0, imported: 0, players: 0, warning: null },
        teams: 1,
      };
    },
    auctionRefreshCooldown: (leagueId) =>
      getAuctionRefreshCooldown(leagueId, { database: db, now }),
    markAuctionRefresh: (leagueId) => markAuctionRefreshDone(leagueId, { database: db, now }),
  });
  t.after(() => {
    resetPremiumAuctionRefreshLockForTests();
    return app.close();
  });

  const admin = {
    "x-test-role": "admin",
    origin: "http://localhost:3000",
    host: "localhost:3000",
  };

  const idle = await app.inject({
    method: "GET",
    url: "/api/expected11/premium/refresh-auctions?leagueId=583",
    headers: { "x-test-role": "admin" },
  });
  assert.equal(idle.statusCode, 200);
  assert.equal(idle.json().remainingMs, 0);
  assert.equal(idle.json().lastRefreshedAt, null);

  const first = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh-auctions",
    headers: admin,
    payload: { leagueId: 583 },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().lastRefreshedAt, "2026-10-01T12:00:00.000Z");
  assert.equal(first.json().remainingMs, AUCTION_REFRESH_COOLDOWN_MS);

  const tooSoon = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh-auctions",
    headers: admin,
    payload: { leagueId: 583 },
  });
  assert.equal(tooSoon.statusCode, 429);
  assert.equal(tooSoon.json().error, "auction_refresh_cooldown");
  assert.equal(tooSoon.json().remainingMs, AUCTION_REFRESH_COOLDOWN_MS);
  assert.deepEqual(pulls, [583]);

  const otherLeague = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh-auctions",
    headers: admin,
    payload: { leagueId: 584 },
  });
  assert.equal(otherLeague.statusCode, 200);
  assert.deepEqual(pulls, [583, 584]);

  nowMs += AUCTION_REFRESH_COOLDOWN_MS;
  const ready = await app.inject({
    method: "POST",
    url: "/api/expected11/premium/refresh-auctions",
    headers: admin,
    payload: { leagueId: 583 },
  });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(pulls, [583, 584, 583]);
});

test("Premium unpicked tops is entitled-only and does not wait on Mantra", async (t) => {
  let pulled = 0;
  const app = Fastify();
  await app.register(expected11PremiumRoutes, {
    authorize,
    ensureSquads: () => {
      pulled += 1;
      return new Promise(() => {});
    },
    unpickedTops: (options, actor) => ({
      ok: true,
      teamId: options.teamId,
      managerId: actor.mantraManagerId,
      groups: [{ position: "ST", players: [] }],
      sofaScore: false,
    }),
  });
  t.after(() => app.close());

  const unauthenticated = await app.inject({
    method: "GET",
    url: "/api/expected11/premium/unpicked-tops?teamId=10",
  });
  assert.equal(unauthenticated.statusCode, 401);

  const missingTeam = await app.inject({
    method: "GET",
    url: "/api/expected11/premium/unpicked-tops",
    headers: { "x-test-role": "entitled" },
  });
  assert.equal(missingTeam.statusCode, 400);

  const started = Date.now();
  const ok = await app.inject({
    method: "GET",
    url: "/api/expected11/premium/unpicked-tops?teamId=10",
    headers: { "x-test-role": "entitled" },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().teamId, 10);
  assert.equal(ok.json().sofaScore, false);
  assert.equal(pulled, 0);
  assert.ok(Date.now() - started < 500);
});
