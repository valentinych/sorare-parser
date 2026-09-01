import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { footmopsRoutes } from "./footmops.js";
import { FOOTMOPS_SCHEMA } from "../domain/footmops.js";

function database(): Database.Database {
  const db = new Database(":memory:");
  db.exec(FOOTMOPS_SCHEMA);
  db.exec(`
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, first_name TEXT,
      full_name TEXT, positions_json TEXT, tm_url TEXT,
      club_id INTEGER, club_name TEXT, tournament_id INTEGER
    );
    CREATE TABLE expected11_manual_mappings (
      source_name_normalized TEXT, mantra_club_id INTEGER, mantra_player_id INTEGER,
      mapped_by_user_id INTEGER
    );
    CREATE TABLE computed_cache (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT
    );
  `);
  db.exec(`
    INSERT INTO mantra_players (id, name, first_name, full_name, club_id, club_name, tournament_id)
    VALUES (1, 'Doyle', 'Callum', 'Callum Doyle', 10, 'Wrexham', 11);
  `);
  return db;
}

test("footmops import requires bearer token and links players", async (t) => {
  const db = database();
  const app = Fastify();
  await app.register(footmopsRoutes, {
    token: () => "secret-token",
    database: () => db,
  });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const denied = await app.inject({
    method: "POST",
    url: "/api/footmops/import",
    payload: { league: "championship", tour: 2, matches: [] },
  });
  assert.equal(denied.statusCode, 401);

  const ok = await app.inject({
    method: "POST",
    url: "/api/footmops/import",
    headers: { authorization: "Bearer secret-token" },
    payload: {
      source: "sorareinside",
      sourceUrl: "https://sorareinside.com",
      league: "championship",
      tour: 9,
      extractedAt: "2026-08-28T00:00:00.000Z",
      title: "test",
      matches: [
        {
          home: "Wrexham",
          away: "",
          teams: [
            {
              name: "Wrexham",
              players: [
                { name: "Callum Doyle", percentage: 90, group: "starting" },
                { name: "Ghost", percentage: 10, group: "bench" },
              ],
            },
          ],
        },
      ],
    },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.league, "championship");
  assert.equal(body.tour, 9);
  assert.equal(body.players, 2);
  assert.equal(body.linked, 1);
  assert.equal(body.unmatched, 1);
});
