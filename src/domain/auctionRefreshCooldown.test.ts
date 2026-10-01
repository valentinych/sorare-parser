import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  AUCTION_REFRESH_COOLDOWN_MS,
  auctionRefreshCooldownKey,
  getAuctionRefreshCooldown,
  markAuctionRefreshDone,
} from "./auctionRefreshCooldown.js";

function database() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
  return db;
}

test("too soon is blocked, after 30 min is allowed, leagues are independent", () => {
  const db = database();
  let nowMs = Date.parse("2026-10-01T12:00:00.000Z");
  const now = () => new Date(nowMs);
  const opts = { database: db, now };

  assert.equal(getAuctionRefreshCooldown(583, opts).remainingMs, 0);
  assert.equal(getAuctionRefreshCooldown(583, opts).lastRefreshedAt, null);
  assert.equal(getAuctionRefreshCooldown(584, opts).remainingMs, 0);

  const marked = markAuctionRefreshDone(583, opts);
  assert.equal(marked.lastRefreshedAt, "2026-10-01T12:00:00.000Z");
  assert.equal(marked.remainingMs, AUCTION_REFRESH_COOLDOWN_MS);
  assert.equal(marked.availableAt, "2026-10-01T12:30:00.000Z");
  assert.equal(
    db.prepare(`SELECT value FROM sync_meta WHERE key = ?`).get(auctionRefreshCooldownKey(583))
      ?.value,
    "2026-10-01T12:00:00.000Z",
  );

  nowMs += 12 * 60 * 1000;
  const tooSoon = getAuctionRefreshCooldown(583, opts);
  assert.equal(tooSoon.remainingMs, 18 * 60 * 1000);
  assert.equal(tooSoon.lastRefreshedAt, "2026-10-01T12:00:00.000Z");
  assert.ok(tooSoon.remainingMs > 0);

  assert.equal(getAuctionRefreshCooldown(584, opts).remainingMs, 0);
  const other = markAuctionRefreshDone(584, opts);
  assert.equal(other.lastRefreshedAt, "2026-10-01T12:12:00.000Z");
  assert.equal(getAuctionRefreshCooldown(583, opts).remainingMs, 18 * 60 * 1000);

  nowMs = Date.parse("2026-10-01T12:00:00.000Z") + AUCTION_REFRESH_COOLDOWN_MS;
  const ready = getAuctionRefreshCooldown(583, opts);
  assert.equal(ready.remainingMs, 0);
  assert.equal(ready.lastRefreshedAt, "2026-10-01T12:00:00.000Z");
  assert.equal(ready.availableAt, null);
  assert.ok(getAuctionRefreshCooldown(584, opts).remainingMs > 0);
});
