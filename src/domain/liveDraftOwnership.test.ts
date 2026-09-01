import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  LIVE_DRAFT_SQUAD_IDS,
  applyLiveDraftTaken,
  listLiveDraftSquads,
  liveDraftAwardsVersion,
  loadLiveDraftAwards,
} from "./liveDraftOwnership.js";

function memoryDb() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE live_auction_awards (
      player_id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      lot_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE live_auction_team_names (
      email TEXT PRIMARY KEY,
      team_name TEXT NOT NULL,
      squad_id INTEGER,
      updated_at TEXT NOT NULL
    );
    INSERT INTO live_auction_team_names (email, team_name, squad_id, updated_at) VALUES
      ('a@x.test', 'Loch Ness FC', 5009, datetime('now')),
      ('b@x.test', 'Bromley FC', 2033, datetime('now'));
    INSERT INTO live_auction_awards (player_id, email, amount, lot_id, created_at) VALUES
      (1661, 'a@x.test', 88, 1, datetime('now')),
      (542, 'b@x.test', 66, 2, datetime('now'));
  `);
  return database;
}

test("loadLiveDraftAwards joins buyer team name and squad id", () => {
  const awards = loadLiveDraftAwards(memoryDb());
  assert.equal(awards.size, 2);
  assert.deepEqual(awards.get(1661), {
    playerId: 1661,
    email: "a@x.test",
    amount: 88,
    teamName: "Loch Ness FC",
    squadId: 5009,
  });
});

test("applyLiveDraftTaken marks a sold player taken in all 8 squads", () => {
  const award = loadLiveDraftAwards(memoryDb()).get(1661);
  const taken = applyLiveDraftTaken([684], award);
  assert.ok(taken.includes(684));
  for (const id of LIVE_DRAFT_SQUAD_IDS) assert.ok(taken.includes(id));
  assert.deepEqual(applyLiveDraftTaken([684], undefined), [684]);
});

test("listLiveDraftSquads exposes the 8 managers as filter options", () => {
  const squads = listLiveDraftSquads(memoryDb());
  assert.equal(squads.length, 2);
  assert.equal(squads[0]?.id, 2033);
  assert.equal(squads[0]?.label, "Live · Bromley FC");
  assert.equal(squads[1]?.id, 5009);
});

test("liveDraftAwardsVersion is the award count", () => {
  assert.equal(liveDraftAwardsVersion(memoryDb()), "2");
  assert.equal(liveDraftAwardsVersion(new Database(":memory:")), "0");
});
