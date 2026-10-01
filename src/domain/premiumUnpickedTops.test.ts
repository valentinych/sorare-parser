import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  peekComputed,
  resetComputedCacheForTests,
} from "../lib/computedCache.js";
import { FOOTMOPS_SCHEMA } from "./footmops.js";
import { ALL_POSITIONS } from "../lib/mantraFormations.js";
import {
  getPremiumUnpickedTops,
  PREMIUM_UNPICKED_TOPS_CACHE_PREFIX,
  topUnpickedByPosition,
  UNPICKED_TOP_PER_POS,
  type UnpickedTopPlayer,
} from "./premiumUnpickedTops.js";

test.afterEach(() => {
  resetComputedCacheForTests();
});

function database(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, first_name TEXT,
      full_name TEXT, positions_json TEXT, club_name TEXT, club_code TEXT,
      fotmob_player_id INTEGER, tournament_id INTEGER
    );
    CREATE TABLE mantra_fantasy_teams (
      id INTEGER PRIMARY KEY, league_id INTEGER, tournament_id INTEGER,
      user_id INTEGER, name TEXT, players_json TEXT
    );
    CREATE TABLE fotmob_matches (
      id INTEGER PRIMARY KEY, league_id INTEGER, round TEXT, kickoff TEXT,
      home_id INTEGER, home_name TEXT, away_id INTEGER, away_name TEXT,
      score_home INTEGER, score_away INTEGER, phase TEXT
    );
    CREATE TABLE fotmob_match_players (
      match_id INTEGER NOT NULL, player_id INTEGER NOT NULL, name TEXT,
      team_id INTEGER, team_name TEXT, is_home INTEGER, starter INTEGER,
      rating REAL, minutes INTEGER, goals INTEGER, assists INTEGER,
      yellow_cards INTEGER, red_cards INTEGER, own_goals INTEGER, saves INTEGER,
      goals_conceded INTEGER, penalties_won INTEGER, penalties_conceded INTEGER,
      penalties_scored INTEGER, penalties_missed INTEGER, penalties_saved INTEGER,
      PRIMARY KEY (match_id, player_id)
    );
    CREATE TABLE fotmob_match_events (
      match_id INTEGER NOT NULL, event_idx INTEGER NOT NULL, time INTEGER,
      overload_time INTEGER, type TEXT, is_home INTEGER, player_id INTEGER,
      player_name TEXT, card TEXT, home_score INTEGER, away_score INTEGER,
      raw_json TEXT, PRIMARY KEY (match_id, event_idx)
    );
  `);
  db.exec(FOOTMOPS_SCHEMA);
  return db;
}

function insertPlayer(
  db: Database.Database,
  id: number,
  name: string,
  positions: string,
  fotmobId: number,
) {
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_name, club_code, fotmob_player_id, tournament_id)
     VALUES (?, ?, 'X', ?, ?, 'Leeds', 'LEE', ?, 11)`,
  ).run(id, name, `X ${name}`, positions, fotmobId);
}

function insertStats(
  db: Database.Database,
  fotmobId: number,
  rating: number,
  minutes: number,
  starter: number,
) {
  db.prepare(
    `INSERT INTO fotmob_match_players
       (match_id, player_id, name, team_id, team_name, is_home, starter, rating, minutes,
        goals, assists, yellow_cards, red_cards, own_goals, saves, goals_conceded,
        penalties_won, penalties_conceded, penalties_scored, penalties_missed, penalties_saved)
     VALUES (1, ?, 'P', 7, 'Leeds', 1, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
  ).run(fotmobId, starter, rating, minutes);
}

function seedLeague(db: Database.Database) {
  insertPlayer(db, 1, "PickedST", '["ST"]', 2001);
  insertPlayer(db, 2, "PickedOther", '["W"]', 2002);
  insertPlayer(db, 10, "FreeAlpha", '["ST"]', 2010);
  insertPlayer(db, 11, "FreeBravo", '["ST"]', 2011);
  insertPlayer(db, 12, "FreeCharlie", '["ST"]', 2012);
  insertPlayer(db, 13, "FreeDelta", '["ST"]', 2013);
  insertPlayer(db, 14, "FreeEcho", '["ST"]', 2014);
  insertPlayer(db, 15, "FreeFoxtrot", '["ST"]', 2015);
  insertPlayer(db, 20, "DualWing", '["RB","WB"]', 2020);
  insertPlayer(db, 21, "ZeroMin", '["GK"]', 2021);
  insertPlayer(db, 99, "OtherTour", '["ST"]', 2099);
  db.prepare(`UPDATE mantra_players SET tournament_id = 2 WHERE id = 99`).run();

  db.prepare(
    `INSERT INTO mantra_fantasy_teams
       (id, league_id, tournament_id, user_id, name, players_json)
     VALUES
       (10, 651, 11, 99, 'Cardiff XI', '[1,2]'),
       (11, 651, 11, 88, 'Rival XI', '[20]')`,
  ).run();

  db.prepare(
    `INSERT INTO fotmob_matches
       (id, league_id, round, kickoff, home_id, home_name, away_id, away_name,
        score_home, score_away, phase)
     VALUES (1, 48, '1', '2026-08-10T15:00:00Z', 7, 'Leeds', 8, 'Norwich', 1, 0, 'finished')`,
  ).run();

  insertStats(db, 2010, 8.2, 90, 1);
  insertStats(db, 2011, 7.8, 90, 1);
  insertStats(db, 2012, 7.4, 90, 1);
  insertStats(db, 2013, 7.1, 90, 1);
  insertStats(db, 2014, 6.9, 80, 1);
  insertStats(db, 2015, 6.4, 20, 0);
  insertStats(db, 2020, 7.6, 90, 1);
  insertStats(db, 2021, 8.9, 0, 0);
  insertStats(db, 2001, 9.5, 90, 1);
}

const actor = { mantraManagerId: 99 };

test("topUnpickedByPosition caps at 5 and keeps duals in each slot", () => {
  const players: UnpickedTopPlayer[] = Array.from({ length: 6 }, (_, i) => ({
    mantraPlayerId: i + 1,
    displayName: `ST ${i}`,
    surname: `S${i}`,
    clubCode: "LEE",
    clubName: "Leeds",
    positions: ["ST"],
    position: "ST",
    minutesByTour: [],
    ratingAvg: 8 - i * 0.1,
    ratingSource: "fotmob",
    mantraTsAvg: 7,
    formScore: 9 - i,
  }));
  players.push({
    mantraPlayerId: 50,
    displayName: "Dual",
    surname: "Dual",
    clubCode: "LEE",
    clubName: "Leeds",
    positions: ["RB", "WB"],
    position: "RB",
    minutesByTour: [],
    ratingAvg: 7,
    ratingSource: "fotmob",
    mantraTsAvg: 7,
    formScore: 8,
  });
  const groups = topUnpickedByPosition(players);
  assert.deepEqual(
    groups.map((group) => group.position),
    [...ALL_POSITIONS],
  );
  const st = groups.find((group) => group.position === "ST");
  assert.equal(st?.players.length, UNPICKED_TOP_PER_POS);
  assert.equal(st?.players[0]?.formScore, 9);
  const rb = groups.find((group) => group.position === "RB");
  const wb = groups.find((group) => group.position === "WB");
  assert.equal(rb?.players.some((player) => player.mantraPlayerId === 50), true);
  assert.equal(wb?.players.some((player) => player.mantraPlayerId === 50), true);
});

test("unpicked tops drop league picks, keep tournament pool, score 0.00–10.00", async () => {
  const db = database();
  seedLeague(db);
  const view = await getPremiumUnpickedTops(
    { teamId: 10, now: new Date("2026-09-12T00:00:00Z") },
    actor,
    db,
  );
  assert.equal(view.ok, true);
  assert.equal(view.leagueId, 651);
  const ids = view.groups.flatMap((group) => group.players.map((player) => player.mantraPlayerId));
  assert.equal(ids.includes(1), false);
  assert.equal(ids.includes(2), false);
  assert.equal(ids.includes(20), false);
  assert.equal(ids.includes(99), false);

  const st = view.groups.find((group) => group.position === "ST");
  assert.equal(st?.players.length, 5);
  assert.equal(st?.players.some((player) => player.mantraPlayerId === 15), false);
  assert.equal(st?.players[0]?.mantraPlayerId, 10);
  for (const player of view.groups.flatMap((group) => group.players)) {
    assert.ok(player.formScore >= 0 && player.formScore <= 10);
    assert.equal(Math.round(player.formScore * 100) / 100, player.formScore);
  }

  const gk = view.groups.find((group) => group.position === "GK");
  assert.equal(gk?.players[0]?.mantraPlayerId, 21);
  assert.equal(gk?.players[0]?.formScore, 0);

  assert.ok(peekComputed(`${PREMIUM_UNPICKED_TOPS_CACHE_PREFIX}651`));
});
