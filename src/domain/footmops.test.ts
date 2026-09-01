import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { resetComputedCacheForTests, peekComputed } from "../lib/computedCache.js";
import { PREMIUM_ODDS_CACHE_KEY, getExpected11PremiumView } from "./expected11Premium.js";
import { writeComputed } from "../lib/computedCache.js";
import {
  footmopsByPlayer,
  importFootmopsSnapshot,
  type FootmopsSnapshot,
} from "./footmops.js";

test.afterEach(() => {
  resetComputedCacheForTests();
});

function database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, first_name TEXT,
      full_name TEXT, positions_json TEXT, tm_url TEXT,
      club_id INTEGER, club_name TEXT, tournament_id INTEGER
    );
    CREATE TABLE expected11_teams (
      match_id TEXT NOT NULL, side TEXT NOT NULL, source_name TEXT,
      logo_url TEXT, notes_json TEXT DEFAULT '{}', author TEXT,
      mantra_club_id INTEGER, mantra_club_name TEXT, link_status TEXT,
      PRIMARY KEY (match_id, side)
    );
    CREATE TABLE expected11_predictions (
      match_id TEXT NOT NULL, team_side TEXT NOT NULL, lineup_group TEXT,
      sort_order INTEGER, source_name TEXT, displayed_percentage REAL,
      player_path TEXT, mantra_player_id INTEGER, link_status TEXT,
      PRIMARY KEY (match_id, team_side, lineup_group, sort_order)
    );
    CREATE TABLE expected11_manual_mappings (
      source_name_normalized TEXT, mantra_club_id INTEGER, mantra_player_id INTEGER,
      mapped_by_user_id INTEGER
    );
    CREATE TABLE app_users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE mantra_leagues (id INTEGER PRIMARY KEY, name TEXT, division TEXT);
    CREATE TABLE mantra_fantasy_teams (
      id INTEGER PRIMARY KEY, league_id INTEGER, tournament_id INTEGER,
      user_id INTEGER, name TEXT, players_json TEXT
    );
    CREATE TABLE expected11_matches (
      id TEXT PRIMARY KEY, source_url TEXT, title TEXT, home_team TEXT,
      away_team TEXT, formations_json TEXT DEFAULT '[]', extracted_at TEXT,
      imported_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE fixtures (
      id INTEGER PRIMARY KEY, date TEXT, round TEXT, home_team_id INTEGER,
      away_team_id INTEGER, status TEXT, league_id INTEGER, season INTEGER
    );
    CREATE TABLE fixture_odds (
      fixture_id INTEGER PRIMARY KEY, kickoff TEXT, home_odd REAL,
      draw_odd REAL, away_odd REAL, bookmaker TEXT,
      home_cs_prob REAL, away_cs_prob REAL, popular_score TEXT
    );
    CREATE TABLE season_teams (
      season INTEGER, team_id INTEGER, name TEXT, league_id INTEGER
    );
  `);
  return db;
}

function snapshot(): FootmopsSnapshot {
  return {
    source: "sorareinside",
    sourceUrl: "https://sorareinside.com",
    league: "championship",
    tour: 2,
    extractedAt: "2026-08-22T10:00:00.000Z",
    title: "test",
    matches: [
      {
        home: "Wrexham",
        away: "Wolverhampton Wanderers",
        teams: [
          {
            name: "Wrexham",
            players: [
              { name: "Matthew James", percentage: 60, group: "starting" },
              { name: "B. Whiteman", percentage: 40, group: "bench" },
              { name: "Matthew James", percentage: 20, group: "bench" },
            ],
          },
          {
            name: "Wolverhampton Wanderers",
            players: [
              { name: "Toti", percentage: 60, group: "starting" },
              { name: "André", percentage: 90, group: "starting" },
              { name: "R. Jiménez", percentage: 40, group: "bench" },
              { name: "Ghost Player", percentage: 10, group: "bench" },
            ],
          },
        ],
      },
    ],
  };
}

function seedPlayers(db: Database.Database) {
  db.exec(`
    INSERT INTO mantra_players (id, name, first_name, full_name, club_id, club_name, tournament_id)
    VALUES
      (1, 'James', 'Matty', 'Matty James', 358, 'Wrexham', 11),
      (2, 'Whiteman', 'Ben', 'Ben Whiteman', 358, 'Wrexham', 11),
      (3, 'Gomes', 'Toti', 'Toti Gomes', 40, 'Wolverhampton', 11),
      (4, 'Andre', 'Trindade', 'Trindade Andre', 40, 'Wolverhampton', 11),
      (5, 'Jimenez', 'Raul', 'Raul Jimenez', 40, 'Wolverhampton', 11);
  `);
}

test("footmops import keeps starter %, stores bench alts, and aliases Wolves", () => {
  const db = database();
  seedPlayers(db);
  const result = importFootmopsSnapshot(snapshot(), db, { bustCache: false });
  assert.equal(result.linked, 5);
  assert.equal(result.unmatched, 1);
  assert.deepEqual(
    result.unmatchedPlayers.map((row) => row.name),
    ["Ghost Player"],
  );
  const byPlayer = footmopsByPlayer(db);
  assert.equal(byPlayer.get(1)?.displayedPercentage, 60);
  assert.equal(byPlayer.get(1)?.lineupGroup, "starting");
  assert.equal(byPlayer.get(2)?.displayedPercentage, 40);
  assert.equal(byPlayer.get(3)?.displayedPercentage, 60);
  assert.equal(byPlayer.get(4)?.displayedPercentage, 90);
  assert.equal(byPlayer.get(5)?.displayedPercentage, 40);
});

test("premium Championship rows expose футмопс and import busts odds-join cache", () => {
  const db = database();
  seedPlayers(db);
  db.exec(`
    INSERT INTO mantra_leagues (id, name, division) VALUES (1, 'Champ', 'A1');
    INSERT INTO mantra_fantasy_teams (id, league_id, tournament_id, user_id, name, players_json)
    VALUES (1, 1, 11, 99, 'Taffs', '[2,3]');
  `);
  writeComputed(
    PREMIUM_ODDS_CACHE_KEY,
    "seed",
    { fixtures: [], expected11: [], rounds: [] },
    { database: db },
  );
  const imported = importFootmopsSnapshot(snapshot(), db);
  assert.equal(peekComputed(PREMIUM_ODDS_CACHE_KEY), undefined);
  assert.equal(imported.linked, 5);
  const view = getExpected11PremiumView(
    { now: new Date("2026-08-22T12:00:00Z") },
    { id: 1, email: "owner@example.com", mantraManagerId: 99 },
    db,
  );
  const whiteman = view.rows.find((row) => row.mantraPlayerId === 2);
  const toti = view.rows.find((row) => row.mantraPlayerId === 3);
  assert.equal(whiteman?.footmopsPercentage, 40);
  assert.equal(toti?.footmopsPercentage, 60);
  assert.equal(view.counts.footmops, 2);
});
