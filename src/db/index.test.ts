import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateMantraAuctionJobs } from "./index.js";

test("auction job migration preserves rows and foreign keys while adding partial", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE mantra_auction_jobs (
      scope_key TEXT PRIMARY KEY,
      scope_name TEXT NOT NULL,
      mantra_league_ids_json TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending','discovering','running','complete','error')
      ),
      phase TEXT NOT NULL,
      completed_units INTEGER NOT NULL DEFAULT 0,
      total_units INTEGER,
      percent REAL,
      last_error TEXT,
      request_starts INTEGER NOT NULL DEFAULT 0,
      retries INTEGER NOT NULL DEFAULT 0,
      responses_429 INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE mantra_auctions (
      mantra_league_id INTEGER NOT NULL,
      auction_id INTEGER NOT NULL,
      scope_key TEXT NOT NULL REFERENCES mantra_auction_jobs(scope_key),
      PRIMARY KEY (mantra_league_id, auction_id)
    );
    INSERT INTO mantra_auction_jobs VALUES (
      'championship', 'Championship', '[653]', 'auctions-migration-test',
      'error', 'paused', 818, 832, 98.3, 'raw error', 10, 2, 0,
      '2026-08-11T12:00:00.000Z', '2026-08-11T13:00:00.000Z', NULL
    );
    INSERT INTO mantra_auctions VALUES (653, 2714, 'championship');
  `);

  migrateMantraAuctionJobs(db);
  db.prepare(
    `UPDATE mantra_auction_jobs
     SET status = 'partial', failed_count = 14, last_retry_at = ?
     WHERE scope_key = 'championship'`,
  ).run("2026-08-11T18:00:00.000Z");

  const row = db
    .prepare(
      `SELECT status, completed_units AS completed, failed_count AS failedCount,
              last_retry_at AS lastRetryAt
       FROM mantra_auction_jobs WHERE scope_key = 'championship'`,
    )
    .get();
  assert.deepEqual(row, {
    status: "partial",
    completed: 818,
    failedCount: 14,
    lastRetryAt: "2026-08-11T18:00:00.000Z",
  });
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});
