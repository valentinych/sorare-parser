import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { loadMantraGwPlayerScores, upsertMantraGwPlayerScores } from "./mantraGwScores.js";

test("upsertMantraGwPlayerScores keeps the higher total per player and round", () => {
  const db = new Database(":memory:");
  upsertMantraGwPlayerScores(
    "upl",
    3,
    [
      { playerId: 7974, total: 8.5, base: 6.5 },
      { playerId: 2317, total: 7.4, base: 7.4 },
    ],
    db,
  );
  upsertMantraGwPlayerScores(
    "upl",
    3,
    [{ playerId: 7974, total: 9.1, base: 6.8 }],
    db,
  );
  const loaded = loadMantraGwPlayerScores("upl", 3, db);
  assert.equal(loaded.get(7974)?.total, 9.1);
  assert.equal(loaded.get(7974)?.base, 6.8);
  assert.equal(loaded.get(2317)?.total, 7.4);
  assert.equal(loadMantraGwPlayerScores("upl", 4, db).size, 0);
});
