import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { LiveAuctionError } from "./liveAuction.js";
import {
  listLiveDraftWishlist,
  removeLiveDraftWishlist,
  upsertLiveDraftWishlist,
} from "./liveDraftWishlist.js";

const owner = "Owner@example.com";
const other = "other@example.com";

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
      tournament_id INTEGER
    );
    INSERT INTO mantra_players
      (id, name, full_name, positions_json, club_name, tournament_id)
    VALUES
      (10, 'Salah', 'Mohamed Salah', '["W","FW"]', 'Liverpool', 2),
      (11, 'Haaland', 'Erling Haaland', '["ST"]', 'Manchester City', 2),
      (99, 'Lewandowski', 'Robert Lewandowski', '["ST"]', 'Barcelona', 12);
  `);
  return database;
}

test("wishlist add, upsert bid, and remove stay on one manager", () => {
  const db = memoryDb();
  assert.deepEqual(listLiveDraftWishlist(owner, db), { items: [] });

  const added = upsertLiveDraftWishlist(owner, 10, 15, db);
  assert.equal(added.items.length, 1);
  assert.equal(added.items[0]?.playerId, 10);
  assert.equal(added.items[0]?.targetBid, 15);
  assert.equal(added.items[0]?.player.name, "Mohamed Salah");
  assert.deepEqual(added.items[0]?.player.positions, ["W", "FW"]);

  const upserted = upsertLiveDraftWishlist("owner@example.com", "10", "22", db);
  assert.equal(upserted.items.length, 1);
  assert.equal(upserted.items[0]?.targetBid, 22);

  upsertLiveDraftWishlist(owner, 11, 40, db);
  assert.deepEqual(
    listLiveDraftWishlist(owner, db).items.map((item) => item.playerId),
    [10, 11],
  );

  const removed = removeLiveDraftWishlist(owner, 10, db);
  assert.deepEqual(
    removed.items.map((item) => [item.playerId, item.targetBid]),
    [[11, 40]],
  );
});

test("wishlist lists are isolated between managers", () => {
  const db = memoryDb();
  upsertLiveDraftWishlist(owner, 10, 12, db);
  upsertLiveDraftWishlist(other, 11, 30, db);

  const ownerList = listLiveDraftWishlist(owner, db);
  const otherList = listLiveDraftWishlist(other, db);
  assert.deepEqual(
    ownerList.items.map((item) => [item.playerId, item.targetBid]),
    [[10, 12]],
  );
  assert.deepEqual(
    otherList.items.map((item) => [item.playerId, item.targetBid]),
    [[11, 30]],
  );

  removeLiveDraftWishlist(other, 11, db);
  assert.equal(listLiveDraftWishlist(owner, db).items.length, 1);
  assert.equal(listLiveDraftWishlist(other, db).items.length, 0);
});

test("sold players drop off the personal wishlist", () => {
  const db = memoryDb();
  upsertLiveDraftWishlist(owner, 10, 15, db);
  upsertLiveDraftWishlist(owner, 11, 40, db);
  db.exec(`
    INSERT INTO live_auction_awards (player_id, email, amount, lot_id, created_at)
    VALUES (10, 'owner@example.com', 20, 1, datetime('now'));
  `);
  assert.deepEqual(
    listLiveDraftWishlist(owner, db).items.map((item) => item.playerId),
    [11],
  );
});

test("wishlist rejects bad bids and non-PL players", () => {
  const db = memoryDb();
  assert.throws(
    () => upsertLiveDraftWishlist(owner, 10, 0, db),
    (error: unknown) =>
      error instanceof LiveAuctionError && error.code === "invalid_amount",
  );
  assert.throws(
    () => upsertLiveDraftWishlist(owner, 10, 1.5, db),
    (error: unknown) =>
      error instanceof LiveAuctionError && error.code === "invalid_amount",
  );
  assert.throws(
    () => upsertLiveDraftWishlist(owner, 0, 5, db),
    (error: unknown) =>
      error instanceof LiveAuctionError && error.code === "invalid_player",
  );
  assert.throws(
    () => upsertLiveDraftWishlist(owner, 99, 5, db),
    (error: unknown) =>
      error instanceof LiveAuctionError &&
      error.code === "player_not_found" &&
      error.status === 404,
  );
  assert.deepEqual(listLiveDraftWishlist(owner, db), { items: [] });
});
