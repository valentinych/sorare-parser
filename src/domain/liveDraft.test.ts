import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { getLiveDraftStatus } from "./liveDraft.js";

function memoryDb() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE live_draft (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      configured INTEGER NOT NULL DEFAULT 0,
      league TEXT NOT NULL DEFAULT 'premier-league',
      status TEXT NOT NULL DEFAULT 'unconfigured',
      participants_json TEXT NOT NULL DEFAULT '[]',
      rules_json TEXT,
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return database;
}

test("live draft status starts unconfigured and can hold later rules/state", () => {
  const database = memoryDb();
  const status = getLiveDraftStatus(true, database);
  assert.deepEqual(status, {
    enabled: true,
    entitled: true,
    configured: false,
  });
  const row = database
    .prepare(
      `SELECT participants_json, rules_json, state_json FROM live_draft WHERE id = 1`,
    )
    .get() as {
    participants_json: string;
    rules_json: string | null;
    state_json: string;
  };
  assert.equal(row.participants_json, "[]");
  assert.equal(row.rules_json, null);
  assert.equal(row.state_json, "{}");
});
