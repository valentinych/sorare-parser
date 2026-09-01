import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import {
  MANTRA_AUCTION_SCHEMA,
  MAX_MANTRA_AUCTION_IMPORT_BYTES,
} from "../domain/mantraAuctions.js";
import { mantraAuctionRoutes } from "./mantraAuctions.js";

function database() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY,
      tm_url TEXT,
      avatar_path TEXT
    );
    ${MANTRA_AUCTION_SCHEMA}
  `);
  return db;
}

function seedPayload() {
  return {
    schemaVersion: 1,
    operation: "seed",
    runId: "auctions-route-test-001",
    startedAt: "2026-08-11T12:00:00.000Z",
    scopes: [
      { key: "super-lig", name: "Süper Lig", mantraLeagueIds: [658] },
      { key: "championship", name: "Championship", mantraLeagueIds: [651] },
      { key: "ekstraklasa", name: "Ekstraklasa", mantraLeagueIds: [583] },
    ],
  };
}

test("auction import distinguishes missing and invalid credentials", async (t) => {
  const db = database();
  const app = Fastify();
  await app.register(mantraAuctionRoutes, {
    database: () => db,
    token: () => "test-secret",
  });
  t.after(() => app.close());

  const missing = await app.inject({
    method: "POST",
    url: "/api/auctions/import",
    payload: seedPayload(),
  });
  assert.equal(missing.statusCode, 401);

  const invalid = await app.inject({
    method: "POST",
    url: "/api/auctions/import",
    headers: { authorization: "Bearer wrong" },
    payload: seedPayload(),
  });
  assert.equal(invalid.statusCode, 403);

  const accepted = await app.inject({
    method: "POST",
    url: "/api/auctions/import",
    headers: { authorization: "Bearer test-secret" },
    payload: seedPayload(),
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().importedScopes, 3);
});

test("auction import rejects malformed and oversized bodies", async (t) => {
  const db = database();
  const app = Fastify();
  await app.register(mantraAuctionRoutes, {
    database: () => db,
    token: () => "test-secret",
  });
  t.after(() => app.close());

  const malformed = await app.inject({
    method: "POST",
    url: "/api/auctions/import",
    headers: { authorization: "Bearer test-secret" },
    payload: { schemaVersion: 1, operation: "seed" },
  });
  assert.equal(malformed.statusCode, 400);

  const oversized = await app.inject({
    method: "POST",
    url: "/api/auctions/import",
    headers: {
      authorization: "Bearer test-secret",
      "content-type": "application/json",
    },
    payload: JSON.stringify({ value: "x".repeat(MAX_MANTRA_AUCTION_IMPORT_BYTES + 1) }),
  });
  assert.equal(oversized.statusCode, 413);
});

test("public auction routes validate pagination and return seeded scopes", async (t) => {
  const db = database();
  const app = Fastify();
  await app.register(mantraAuctionRoutes, {
    database: () => db,
    token: () => "test-secret",
  });
  t.after(() => app.close());
  await app.inject({
    method: "POST",
    url: "/api/auctions/import",
    headers: { authorization: "Bearer test-secret" },
    payload: seedPayload(),
  });

  const scopes = await app.inject({ method: "GET", url: "/api/auctions/scopes" });
  assert.equal(scopes.statusCode, 200);
  assert.equal(scopes.json().scopes.length, 3);
  assert.equal(scopes.json().scopes[0].failedCount, 0);
  assert.equal(scopes.json().scopes[0].lastRetryAt, null);
  assert.equal("lastError" in scopes.json().scopes[0], false);

  const coverage = await app.inject({
    method: "GET",
    url: "/api/auctions/coverage?scope=championship",
  });
  assert.equal(coverage.statusCode, 200);
  assert.deepEqual(coverage.json(), { leagues: [] });

  const invalidCoverage = await app.inject({
    method: "GET",
    url: "/api/auctions/coverage?scope=unknown",
  });
  assert.equal(invalidCoverage.statusCode, 400);

  const invalid = await app.inject({
    method: "GET",
    url: "/api/auctions/658/2739/players?limit=101",
  });
  assert.equal(invalid.statusCode, 400);

  const all = await app.inject({
    method: "GET",
    url: "/api/auctions/all/players?scope=super-lig&sort=maxBid&direction=desc",
  });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().mode, "all");
  assert.equal(all.json().scopeKey, "super-lig");
  assert.equal(all.json().total, 0);

  const invalidAll = await app.inject({
    method: "GET",
    url: "/api/auctions/all/players?scope=unknown",
  });
  assert.equal(invalidAll.statusCode, 400);

  for (const url of [
    "/api/auctions/all/players/name/history?scope=super-lig",
    "/api/auctions/all/players/1/history?scope=unknown",
    "/api/auctions/all/players/1/history?scope=super-lig&offset=-1",
    "/api/auctions/all/players/1/history?scope=super-lig&limit=201",
  ]) {
    const invalidHistory = await app.inject({ method: "GET", url });
    assert.equal(invalidHistory.statusCode, 400, url);
  }
  const missingHistory = await app.inject({
    method: "GET",
    url: "/api/auctions/all/players/1/history?scope=super-lig",
  });
  assert.equal(missingHistory.statusCode, 404);

  for (const url of [
    "/api/auctions/658/2739/teams",
    "/api/auctions/name/2739/teams?scope=super-lig",
    "/api/auctions/658/2739/teams?scope=unknown",
    "/api/auctions/658/2739/teams/2/report?scope=super-lig&limit=51",
    "/api/auctions/658/2739/teams/0/report?scope=super-lig",
    "/api/auctions/658/2739/ideal-picks",
    "/api/auctions/name/2739/ideal-picks?scope=super-lig",
    "/api/auctions/658/2739/ideal-picks/0?scope=super-lig",
    "/api/auctions/658/2739/ideal-picks/2?scope=unknown",
  ]) {
    const invalidTeamReport = await app.inject({ method: "GET", url });
    assert.equal(invalidTeamReport.statusCode, 400, url);
  }
  const missingAuctionTeams = await app.inject({
    method: "GET",
    url: "/api/auctions/658/2739/teams?scope=super-lig",
  });
  assert.equal(missingAuctionTeams.statusCode, 404);

  for (const query of [
    "bidRecordsMin=-1",
    "stagesMin=3&stagesMax=2",
    "bidAmountMin=10&bidAmountMax=9.99",
    "sort=unsafe",
    "direction=sideways",
  ]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/auctions/658/2739/players?${query}`,
    });
    assert.equal(response.statusCode, 400, query);
  }
});

test("ideal-pick routes return bounded summary and scoped manager detail", async (t) => {
  const db = database();
  db.exec(`
    INSERT INTO mantra_auction_jobs
      (scope_key, scope_name, mantra_league_ids_json, run_id, status, phase,
       started_at, updated_at, completed_at)
    VALUES
      ('super-lig', 'Süper Lig', '[658]', 'route-ideal', 'complete', 'complete',
       '2026-08-11T12:00:00.000Z', '2026-08-11T12:00:00.000Z',
       '2026-08-11T12:00:00.000Z');
    INSERT INTO mantra_auctions
      (mantra_league_id, auction_id, scope_key, sync_run_id, status, label,
       league_label, source_url, fetched_at, completed_at)
    VALUES
      (658, 2739, 'super-lig', 'route-ideal', 'FINISHED', 'Auction',
       'League', 'https://mantrafootball.org/leagues/658/auctions/2739',
       '2026-08-11T12:00:00.000Z', '2026-08-11T12:00:00.000Z');
    INSERT INTO mantra_auction_stages
      (mantra_league_id, auction_id, stage, source_url, player_bid_ids_json,
       sync_run_id, fetched_at)
    VALUES
      (658, 2739, 1,
       'https://mantrafootball.org/leagues/658/auctions/2739?round=1',
       '[10]', 'route-ideal', '2026-08-11T12:00:00.000Z');
    INSERT INTO mantra_auction_players
      (mantra_league_id, auction_id, player_bid_id, mantra_player_id, first_name,
       name, avatar_url, positions_json, positions_italian_json, status,
       final_price, source_url, sync_run_id, fetched_at)
    VALUES
      (658, 2739, 10, 100, 'Route', 'Player', NULL, '["CM"]', '["C"]',
       'success', 5, 'https://mantrafootball.org/api/player_bids/10',
       'route-ideal', '2026-08-11T12:00:00.000Z');
    INSERT INTO mantra_auction_player_stages
      (mantra_league_id, auction_id, player_bid_id, stage, outcome, winning_price,
       winning_team_id, winning_team_name, sync_run_id)
    VALUES (658, 2739, 10, 1, 'success', 5, 2, 'Winner', 'route-ideal');
    INSERT INTO mantra_auction_bids
      (mantra_league_id, auction_id, player_bid_id, stage, bid_id, bid_order,
       status, price, fantasy_team_id, fantasy_team_name, sync_run_id)
    VALUES
      (658, 2739, 10, 1, 1, 1, 'failed', 4, 1, 'Manager', 'route-ideal'),
      (658, 2739, 10, 1, 2, 2, 'success', 5, 2, 'Winner', 'route-ideal');
  `);
  const app = Fastify();
  await app.register(mantraAuctionRoutes, {
    database: () => db,
    token: () => "test-secret",
  });
  t.after(() => app.close());

  const summary = await app.inject({
    method: "GET",
    url: "/api/auctions/658/2739/ideal-picks?scope=super-lig",
  });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json().teams.length, 2);
  assert.equal("picks" in summary.json().teams[0], false);

  const detail = await app.inject({
    method: "GET",
    url: "/api/auctions/658/2739/ideal-picks/1?scope=super-lig",
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().picks.length, 1);
  assert.equal(detail.json().picks[0].actualRelationship, "same_stage_outbid");
  assert.equal(detail.json().summary.selectedCount, summary.json().teams[0].selectedCount);

  const crossScope = await app.inject({
    method: "GET",
    url: "/api/auctions/658/2739/ideal-picks?scope=championship",
  });
  assert.equal(crossScope.statusCode, 404);
});
