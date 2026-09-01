import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  LIVE_DRAFT_EPL_CLUBS,
  LIVE_DRAFT_WISHLIST_FILTER_LIMIT,
  listLiveDraftWishlistFilters,
} from "./liveDraftWishlistFilters.js";

function memoryDb() {
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
    CREATE TABLE live_auction_awards (
      player_id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      lot_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO mantra_players
      (id, name, full_name, positions_json, club_name, average_price, tournament_id)
    VALUES
      (10, 'Salah', 'Mohamed Salah', '["W","FW"]', 'Liverpool', 80, 2),
      (11, 'Haaland', 'Erling Haaland', '["ST"]', 'Manchester City', 90, 2),
      (12, 'Alisson', 'Alisson', '["GK"]', 'Liverpool', 40, 2),
      (13, 'Raya', 'David Raya', '["GK"]', 'Arsenal', 35, 2),
      (14, 'Pope', 'Nick Pope', '["GK"]', 'Newcastle', 18, 2),
      (15, 'Nunez', 'Darwin Nunez', '["ST","FW"]', 'Liverpool', 28, 2),
      (16, 'Gakpo', 'Cody Gakpo', '["W","FW"]', 'Liverpool', 22, 2),
      (17, 'Diaz', 'Luis Diaz', '["W"]', 'Liverpool', 30, 2),
      (18, 'Jota', 'Diogo Jota', '["FW","ST"]', 'Liverpool', 25, 2),
      (19, 'Elliott', 'Harvey Elliott', '["AM","W"]', 'Liverpool', NULL, 2),
      (20, 'Isak', 'Alexander Isak', '["ST"]', 'Newcastle', 50, 2),
      (21, 'Palmer', 'Cole Palmer', '["AM"]', 'Man City', 55, 2),
      (22, 'HullStriker', 'Hull Striker', '["ST"]', 'Hull City', 12, 2),
      (23, 'IpswichMid', 'Ipswich Mid', '["ST"]', 'Ipswich', 8, 2),
      (24, 'Outside', 'Free Agent', '["ST"]', 'Outside', 1, 2),
      (99, 'Lewandowski', 'Robert Lewandowski', '["ST"]', 'Barcelona', 70, 12);
    INSERT INTO live_auction_awards (player_id, email, amount, lot_id, created_at)
    VALUES (20, 'owner@example.com', 51, 1, datetime('now'));
  `);
  return database;
}

test("wishlist filters stay empty until club or position is set", () => {
  const view = listLiveDraftWishlistFilters({}, memoryDb());
  assert.equal(view.players.length, 0);
  assert.equal(view.sort, "average_price");
  assert.deepEqual(view.clubs, [...LIVE_DRAFT_EPL_CLUBS]);
  assert.equal(view.clubs.length, 20);
  assert.equal(
    view.clubs.some((club) =>
      ["Outside", "Barcelona", "Man City"].includes(club),
    ),
    false,
  );
  assert.deepEqual(view.positions, ["GK", "W", "AM", "FW", "ST"]);
});

test("club filter returns top 5 unsold by average_price then name", () => {
  const view = listLiveDraftWishlistFilters({ club: "Liverpool" }, memoryDb());
  assert.equal(view.players.length, LIVE_DRAFT_WISHLIST_FILTER_LIMIT);
  assert.deepEqual(
    view.players.map((player) => [player.id, player.averagePrice]),
    [
      [10, 80],
      [12, 40],
      [17, 30],
      [15, 28],
      [18, 25],
    ],
  );
  assert.equal(
    view.players.some((player) => player.id === 19),
    false,
    "null average_price sorts after priced players",
  );
});

test("position filter uses native Mantra positions from the live-draft pool", () => {
  const view = listLiveDraftWishlistFilters({ position: "gk" }, memoryDb());
  assert.deepEqual(
    view.players.map((player) => player.id),
    [12, 13, 14],
  );
  assert.ok(view.players.every((player) => player.positions.includes("GK")));
});

test("club and position AND, excluding sold and non-PL players", () => {
  const liverpoolFw = listLiveDraftWishlistFilters(
    { club: "Liverpool", position: "FW" },
    memoryDb(),
  );
  assert.deepEqual(
    liverpoolFw.players.map((player) => player.id),
    [10, 15, 18, 16],
  );

  const newcastleSt = listLiveDraftWishlistFilters(
    { club: "Newcastle", position: "ST" },
    memoryDb(),
  );
  assert.deepEqual(newcastleSt.players, []);

  const citySt = listLiveDraftWishlistFilters(
    { club: "Manchester City", position: "ST" },
    memoryDb(),
  );
  assert.deepEqual(
    citySt.players.map((player) => player.id),
    [11],
  );
  assert.equal(
    citySt.players.some((player) => player.id === 99),
    false,
  );
});

test("wishlist club dropdown is the 20 EPL 2026/27 clubs, not junk or duplicates", () => {
  const view = listLiveDraftWishlistFilters({}, memoryDb());
  assert.deepEqual(view.clubs, [...LIVE_DRAFT_EPL_CLUBS]);
  assert.equal(view.clubs.filter((club) => club === "Manchester City").length, 1);
  assert.equal(view.clubs.includes("Man City"), false);
  assert.equal(view.clubs.includes("Hull City"), true);
  assert.equal(view.clubs.includes("Ipswich"), true);
  assert.equal(view.clubs.includes("Coventry City"), true);
  assert.equal(view.clubs.includes("Burnley"), false);
  assert.equal(view.clubs.includes("West Ham"), false);
  assert.equal(view.clubs.includes("Wolverhampton"), false);

  const city = listLiveDraftWishlistFilters(
    { club: "Manchester City" },
    memoryDb(),
  );
  assert.deepEqual(
    city.players.map((player) => player.id),
    [11, 21],
  );
  const alias = listLiveDraftWishlistFilters({ club: "Man City" }, memoryDb());
  assert.deepEqual(
    alias.players.map((player) => player.id),
    [11, 21],
  );
});
