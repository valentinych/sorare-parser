import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { resetLiveDraftPresence } from "../domain/liveDraftPresence.js";
import {
  listLiveDraftWishlist,
  removeLiveDraftWishlist,
  upsertLiveDraftWishlist,
} from "../domain/liveDraftWishlist.js";
import {
  listLiveDraftWishlistFilters,
  LIVE_DRAFT_EPL_CLUBS,
} from "../domain/liveDraftWishlistFilters.js";
import { liveDraftRoutes, type LiveDraftActor } from "./liveDraft.js";

function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
): LiveDraftActor | null {
  const role = request.headers["x-test-role"];
  if (!role) {
    reply.code(401).send({ error: "authentication_required" });
    return null;
  }
  if (role !== "entitled") {
    reply.code(403).send({ error: "live_draft_forbidden" });
    return null;
  }
  const email = String(request.headers["x-test-email"] || "owner@example.com");
  return { id: 1, email };
}

test("live draft status API enforces 401, 403, and allowlisted 200", async (t) => {
  const app = Fastify();
  await app.register(liveDraftRoutes, {
    authorize,
    statusView: () => ({
      enabled: true,
      entitled: true,
      configured: false,
    }),
  });
  t.after(() => app.close());

  const unauthenticated = await app.inject({
    method: "GET",
    url: "/api/live-draft/status",
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error, "authentication_required");

  const forbidden = await app.inject({
    method: "GET",
    url: "/api/live-draft/status",
    headers: { "x-test-role": "other" },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error, "live_draft_forbidden");
  assert.equal(forbidden.json().configured, undefined);

  const authorized = await app.inject({
    method: "GET",
    url: "/api/live-draft/status",
    headers: { "x-test-role": "entitled" },
  });
  assert.equal(authorized.statusCode, 200);
  assert.deepEqual(authorized.json(), {
    enabled: true,
    entitled: true,
    configured: false,
  });

  const forbiddenRoom = await app.inject({
    method: "GET",
    url: "/api/live-draft/room",
    headers: { "x-test-role": "other" },
  });
  assert.equal(forbiddenRoom.statusCode, 403);
  assert.equal(forbiddenRoom.json().error, "live_draft_forbidden");
  assert.equal(forbiddenRoom.json().managers, undefined);
  assert.equal(forbiddenRoom.json().namedTeams, undefined);
  assert.equal(forbiddenRoom.json().players, undefined);

  const anonymousPlayers = await app.inject({
    method: "GET",
    url: "/api/live-draft/players?q=salah",
  });
  assert.equal(anonymousPlayers.statusCode, 401);
  assert.equal(anonymousPlayers.json().error, "authentication_required");
  assert.equal(anonymousPlayers.json().players, undefined);

  const forbiddenName = await app.inject({
    method: "POST",
    url: "/api/live-draft/team-name",
    headers: { "x-test-role": "other" },
    payload: { teamName: "Hacked" },
  });
  assert.equal(forbiddenName.statusCode, 403);
  assert.equal(forbiddenName.json().error, "live_draft_forbidden");

  const othersName = await app.inject({
    method: "POST",
    url: "/api/live-draft/team-name",
    headers: { "x-test-role": "entitled" },
    payload: { teamName: "Hacked", email: "aharodnik@gmail.com" },
  });
  assert.equal(othersName.statusCode, 403);
  assert.equal(othersName.json().error, "not_owner");
});

test("live draft heartbeat API enforces 401, 403, and allowlisted 200", async (t) => {
  resetLiveDraftPresence();
  const app = Fastify();
  await app.register(liveDraftRoutes, { authorize });
  t.after(() => {
    resetLiveDraftPresence();
    return app.close();
  });

  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/live-draft/heartbeat",
    payload: { pingMs: 40 },
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error, "authentication_required");

  const forbidden = await app.inject({
    method: "POST",
    url: "/api/live-draft/heartbeat",
    headers: { "x-test-role": "other" },
    payload: { pingMs: 40 },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error, "live_draft_forbidden");

  const authorized = await app.inject({
    method: "POST",
    url: "/api/live-draft/heartbeat",
    headers: { "x-test-role": "entitled" },
    payload: { pingMs: 41.6 },
  });
  assert.equal(authorized.statusCode, 200);
  assert.deepEqual(authorized.json(), { ok: true, pingMs: 42 });
});

test("live draft fold API enforces 401 and 403", async (t) => {
  const app = Fastify();
  await app.register(liveDraftRoutes, { authorize });
  t.after(() => app.close());

  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/live-draft/fold",
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error, "authentication_required");
  assert.equal(unauthenticated.json().lot, undefined);

  const forbidden = await app.inject({
    method: "POST",
    url: "/api/live-draft/fold",
    headers: { "x-test-role": "other" },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error, "live_draft_forbidden");
  assert.equal(forbidden.json().lot, undefined);
});

test("live draft correct and proxy APIs enforce 401 and 403", async (t) => {
  const app = Fastify();
  await app.register(liveDraftRoutes, { authorize });
  t.after(() => app.close());

  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/live-draft/correct",
    payload: { playerId: 10, amount: 8 },
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error, "authentication_required");

  const forbiddenCorrect = await app.inject({
    method: "POST",
    url: "/api/live-draft/correct",
    headers: { "x-test-role": "other" },
    payload: { playerId: 10, amount: 8 },
  });
  assert.equal(forbiddenCorrect.statusCode, 403);
  assert.equal(forbiddenCorrect.json().error, "live_draft_forbidden");

  const nonAdminCorrect = await app.inject({
    method: "POST",
    url: "/api/live-draft/correct",
    headers: { "x-test-role": "entitled", "x-test-email": "owner@example.com" },
    payload: { playerId: 10, amount: 8 },
  });
  assert.equal(nonAdminCorrect.statusCode, 403);
  assert.equal(nonAdminCorrect.json().error, "not_admin");

  const forbiddenNominateAs = await app.inject({
    method: "POST",
    url: "/api/live-draft/nominate",
    headers: { "x-test-role": "entitled", "x-test-email": "owner@example.com" },
    payload: { playerId: 10, amount: 1, asEmail: "aharodnik@gmail.com" },
  });
  assert.equal(forbiddenNominateAs.statusCode, 403);
  assert.equal(forbiddenNominateAs.json().error, "not_admin");

  const forbiddenBidAs = await app.inject({
    method: "POST",
    url: "/api/live-draft/bid",
    headers: { "x-test-role": "entitled", "x-test-email": "owner@example.com" },
    payload: { amount: 2, asEmail: "aharodnik@gmail.com" },
  });
  assert.equal(forbiddenBidAs.statusCode, 403);
  assert.equal(forbiddenBidAs.json().error, "not_admin");

  const unauthenticatedRelease = await app.inject({
    method: "POST",
    url: "/api/live-draft/release",
    payload: { playerId: 10, email: "owner@example.com" },
  });
  assert.equal(unauthenticatedRelease.statusCode, 401);
  assert.equal(unauthenticatedRelease.json().error, "authentication_required");

  const forbiddenRelease = await app.inject({
    method: "POST",
    url: "/api/live-draft/release",
    headers: { "x-test-role": "other" },
    payload: { playerId: 10, email: "owner@example.com" },
  });
  assert.equal(forbiddenRelease.statusCode, 403);
  assert.equal(forbiddenRelease.json().error, "live_draft_forbidden");

  const nonAdminRelease = await app.inject({
    method: "POST",
    url: "/api/live-draft/release",
    headers: { "x-test-role": "entitled", "x-test-email": "owner@example.com" },
    payload: { playerId: 10, email: "owner@example.com" },
  });
  assert.equal(nonAdminRelease.statusCode, 403);
  assert.equal(nonAdminRelease.json().error, "not_admin");

  const unauthenticatedAutopick = await app.inject({
    method: "POST",
    url: "/api/live-draft/autopick",
  });
  assert.equal(unauthenticatedAutopick.statusCode, 401);
  assert.equal(unauthenticatedAutopick.json().error, "authentication_required");

  const forbiddenAutopick = await app.inject({
    method: "POST",
    url: "/api/live-draft/autopick",
    headers: { "x-test-role": "other" },
  });
  assert.equal(forbiddenAutopick.statusCode, 403);
  assert.equal(forbiddenAutopick.json().error, "live_draft_forbidden");

  const nonAdminAutopick = await app.inject({
    method: "POST",
    url: "/api/live-draft/autopick",
    headers: { "x-test-role": "entitled", "x-test-email": "owner@example.com" },
  });
  assert.equal(nonAdminAutopick.statusCode, 403);
  assert.equal(nonAdminAutopick.json().error, "not_admin");
});

test("live draft stop API enforces 401 and 403", async (t) => {
  const app = Fastify();
  await app.register(liveDraftRoutes, { authorize });
  t.after(() => app.close());

  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/live-draft/stop",
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error, "authentication_required");
  assert.equal(unauthenticated.json().paused, undefined);

  const forbidden = await app.inject({
    method: "POST",
    url: "/api/live-draft/stop",
    headers: { "x-test-role": "other" },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error, "live_draft_forbidden");
  assert.equal(forbidden.json().paused, undefined);
});

function wishlistMemoryDb() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT,
      first_name TEXT,
      positions_json TEXT,
      club_name TEXT,
      club_logo TEXT,
      avatar_path TEXT,
      tournament_id INTEGER
    );
    INSERT INTO mantra_players
      (id, name, full_name, positions_json, club_name, tournament_id)
    VALUES
      (10, 'Salah', 'Mohamed Salah', '["W","FW"]', 'Liverpool', 2),
      (11, 'Haaland', 'Erling Haaland', '["ST"]', 'Manchester City', 2);
  `);
  return database;
}

test("live draft wishlist API enforces 401, 403, upsert, remove, and isolation", async (t) => {
  const db = wishlistMemoryDb();
  const app = Fastify();
  await app.register(liveDraftRoutes, {
    authorize,
    wishlist: {
      list: (email) => listLiveDraftWishlist(email, db),
      upsert: (email, playerId, targetBid) =>
        upsertLiveDraftWishlist(email, playerId, targetBid, db),
      remove: (email, playerId) => removeLiveDraftWishlist(email, playerId, db),
    },
  });
  t.after(() => app.close());

  const unauthenticated = await app.inject({
    method: "GET",
    url: "/api/live-draft/wishlist",
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error, "authentication_required");
  assert.equal(unauthenticated.json().items, undefined);

  const forbiddenGet = await app.inject({
    method: "GET",
    url: "/api/live-draft/wishlist",
    headers: { "x-test-role": "other" },
  });
  assert.equal(forbiddenGet.statusCode, 403);
  assert.equal(forbiddenGet.json().error, "live_draft_forbidden");
  assert.equal(forbiddenGet.json().items, undefined);

  const forbiddenPost = await app.inject({
    method: "POST",
    url: "/api/live-draft/wishlist",
    headers: { "x-test-role": "other" },
    payload: { playerId: 10, targetBid: 15 },
  });
  assert.equal(forbiddenPost.statusCode, 403);
  assert.equal(forbiddenPost.json().error, "live_draft_forbidden");

  const ownerHeaders = { "x-test-role": "entitled" };
  const otherHeaders = {
    "x-test-role": "entitled",
    "x-test-email": "other@example.com",
  };

  const added = await app.inject({
    method: "POST",
    url: "/api/live-draft/wishlist",
    headers: ownerHeaders,
    payload: { playerId: 10, targetBid: 15 },
  });
  assert.equal(added.statusCode, 200);
  assert.equal(added.json().items.length, 1);
  assert.equal(added.json().items[0].playerId, 10);
  assert.equal(added.json().items[0].targetBid, 15);

  const upserted = await app.inject({
    method: "POST",
    url: "/api/live-draft/wishlist",
    headers: ownerHeaders,
    payload: { playerId: 10, targetBid: 22 },
  });
  assert.equal(upserted.statusCode, 200);
  assert.equal(upserted.json().items.length, 1);
  assert.equal(upserted.json().items[0].targetBid, 22);

  const otherAdded = await app.inject({
    method: "POST",
    url: "/api/live-draft/wishlist",
    headers: otherHeaders,
    payload: { playerId: 11, targetBid: 40 },
  });
  assert.equal(otherAdded.statusCode, 200);
  assert.deepEqual(
    otherAdded.json().items.map((item: { playerId: number }) => item.playerId),
    [11],
  );

  const ownerList = await app.inject({
    method: "GET",
    url: "/api/live-draft/wishlist",
    headers: ownerHeaders,
  });
  assert.equal(ownerList.statusCode, 200);
  assert.deepEqual(
    ownerList.json().items.map((item: { playerId: number; targetBid: number }) => [
      item.playerId,
      item.targetBid,
    ]),
    [[10, 22]],
  );

  const removed = await app.inject({
    method: "DELETE",
    url: "/api/live-draft/wishlist?playerId=10",
    headers: ownerHeaders,
  });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json().items, []);

  const otherStillHas = await app.inject({
    method: "GET",
    url: "/api/live-draft/wishlist",
    headers: otherHeaders,
  });
  assert.equal(otherStillHas.json().items[0].playerId, 11);
});

function wishlistFilterMemoryDb() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT,
      first_name TEXT,
      positions_json TEXT,
      club_name TEXT,
      club_logo TEXT,
      avatar_path TEXT,
      average_price REAL,
      tournament_id INTEGER
    );
    INSERT INTO mantra_players
      (id, name, full_name, positions_json, club_name, average_price, tournament_id)
    VALUES
      (10, 'Salah', 'Mohamed Salah', '["W","FW"]', 'Liverpool', 80, 2),
      (11, 'Haaland', 'Erling Haaland', '["ST"]', 'Manchester City', 90, 2),
      (12, 'Alisson', 'Alisson', '["GK"]', 'Liverpool', 40, 2);
  `);
  return database;
}

test("live draft wishlist filters API enforces 401, 403, and top-5 AND", async (t) => {
  const db = wishlistFilterMemoryDb();
  const app = Fastify();
  await app.register(liveDraftRoutes, {
    authorize,
    wishlistFilters: {
      list: (query) => listLiveDraftWishlistFilters(query, db),
    },
  });
  t.after(() => app.close());

  const unauthenticated = await app.inject({
    method: "GET",
    url: "/api/live-draft/wishlist-filters",
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error, "authentication_required");
  assert.equal(unauthenticated.json().players, undefined);

  const forbidden = await app.inject({
    method: "GET",
    url: "/api/live-draft/wishlist-filters?club=Liverpool",
    headers: { "x-test-role": "other" },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error, "live_draft_forbidden");
  assert.equal(forbidden.json().players, undefined);

  const empty = await app.inject({
    method: "GET",
    url: "/api/live-draft/wishlist-filters",
    headers: { "x-test-role": "entitled" },
  });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json().players, []);
  assert.deepEqual(empty.json().clubs, [...LIVE_DRAFT_EPL_CLUBS]);
  assert.equal(empty.json().sort, "average_price");

  const filtered = await app.inject({
    method: "GET",
    url: "/api/live-draft/wishlist-filters?club=Liverpool&position=GK",
    headers: { "x-test-role": "entitled" },
  });
  assert.equal(filtered.statusCode, 200);
  assert.deepEqual(
    filtered.json().players.map((player: { id: number }) => player.id),
    [12],
  );
});
