import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { MANTRA_AUCTION_SCHEMA } from "../domain/mantraAuctions.js";
import {
  listComputedKeys,
  resetComputedCacheForTests,
  writeComputed,
} from "../lib/computedCache.js";
import {
  auctionScopeForLeague,
  refreshPremiumLeagueAfterAuction,
} from "./refreshPremiumLeagueAfterAuction.js";

test.afterEach(() => {
  resetComputedCacheForTests();
});

function database() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE mantra_leagues (
      id INTEGER PRIMARY KEY, name TEXT, tournament_id INTEGER
    );
    CREATE TABLE mantra_fantasy_teams (
      id INTEGER PRIMARY KEY, league_id INTEGER, tournament_id INTEGER, name TEXT
    );
    CREATE TABLE computed_cache (
      key TEXT PRIMARY KEY, version TEXT NOT NULL, body_json TEXT NOT NULL, built_at TEXT NOT NULL
    );
    ${MANTRA_AUCTION_SCHEMA}
    INSERT INTO mantra_leagues (id, name, tournament_id) VALUES (583, 'Warsaw', 18);
    INSERT INTO mantra_fantasy_teams (id, league_id, tournament_id, name)
      VALUES (10, 583, 18, 'Mine'), (11, 583, 18, 'Other'), (99, 584, 18, 'Krakow');
  `);
  return db;
}

test("auctionScopeForLeague maps one division, not the whole tournament", () => {
  const scope = auctionScopeForLeague(583);
  assert.equal(scope?.key, "ekstraklasa");
  assert.equal(scope?.tournamentId, 18);
  assert.ok(scope?.leagueIds.includes(583));
  assert.equal(auctionScopeForLeague(795), null);
});

test("refreshPremiumLeagueAfterAuction syncs one league and busts only that league's caches", async () => {
  const db = database();
  writeComputed("premium:unpicked-tops:583", "v", { n: 1 }, { database: db });
  writeComputed("premium:unpicked-tops:584", "v", { n: 1 }, { database: db });
  writeComputed("premium:squad-report:10", "v", { n: 1 }, { database: db });
  writeComputed("premium:squad-report:11", "v", { n: 1 }, { database: db });
  writeComputed("premium:squad-report:99", "v", { n: 1 }, { database: db });
  writeComputed("board:keep", "v", { n: 1 }, { database: db });

  const leagueCalls: Array<{ tournamentId: number; leagueIds?: number[] }> = [];
  const auctionCalls: Array<{ leagueId: number; auctionId: number }> = [];

  const result = await refreshPremiumLeagueAfterAuction(
    { leagueId: 583, tournamentId: 18, teamId: 10 },
    {
      database: db,
      syncFantasyTeams: async (tournamentId, opts) => {
        leagueCalls.push({ tournamentId, leagueIds: opts?.leagueIds });
        return 2;
      },
      getHtml: async () => "",
      collectAuction: async (leagueId, auctionId) => {
        auctionCalls.push({ leagueId, auctionId });
        throw new Error("Auction page exposed no stages");
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.league, 583);
  assert.equal(result.tournamentId, 18);
  assert.equal(result.teams, 2);
  assert.deepEqual(leagueCalls, [{ tournamentId: 18, leagueIds: [583] }]);
  assert.ok(auctionCalls.every((call) => call.leagueId === 583));
  assert.equal(result.auctions.imported, 0);
  assert.match(String(result.auctions.warning), /Auction page exposed no stages|no_auctions|empty/);

  const keys = listComputedKeys("", { database: db }).sort();
  assert.deepEqual(keys, [
    "board:keep",
    "premium:squad-report:99",
    "premium:unpicked-tops:584",
  ]);
});

test("empty auction HTML still refreshes squads for that league", async () => {
  const db = database();
  let teamsPulled = 0;
  const result = await refreshPremiumLeagueAfterAuction(
    { leagueId: 583, tournamentId: 18 },
    {
      database: db,
      syncFantasyTeams: async (tournamentId, opts) => {
        assert.equal(tournamentId, 18);
        assert.deepEqual(opts?.leagueIds, [583]);
        teamsPulled = 7;
        return 7;
      },
      getHtml: async () => {
        throw new Error("HTTP 404");
      },
      collectAuction: async () => {
        throw new Error("login-wall");
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.teams, 7);
  assert.equal(teamsPulled, 7);
  assert.ok(result.auctions.warning);
});
