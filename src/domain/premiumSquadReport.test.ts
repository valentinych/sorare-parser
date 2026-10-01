import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  peekComputed,
  resetComputedCacheForTests,
} from "../lib/computedCache.js";
import { FOOTMOPS_SCHEMA } from "./footmops.js";
import {
  deriveClubCode,
  getPremiumSquadReport,
  parseFotmobTour,
  PREMIUM_SQUAD_REPORT_CACHE_PREFIX,
  reportSurname,
  squadReportStatus,
} from "./premiumSquadReport.js";

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
    CREATE TABLE expected11_matches (
      id TEXT PRIMARY KEY, source_url TEXT NOT NULL, title TEXT NOT NULL,
      home_team TEXT, away_team TEXT, formations_json TEXT NOT NULL DEFAULT '[]',
      extracted_at TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE expected11_predictions (
      match_id TEXT NOT NULL, team_side TEXT NOT NULL, lineup_group TEXT NOT NULL,
      sort_order INTEGER NOT NULL, source_name TEXT NOT NULL,
      displayed_percentage REAL, player_path TEXT, mantra_player_id INTEGER,
      link_status TEXT NOT NULL,
      PRIMARY KEY (match_id, team_side, lineup_group, sort_order)
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
    CREATE TABLE mantra_auction_players (
      mantra_league_id INTEGER NOT NULL, auction_id INTEGER NOT NULL,
      player_bid_id INTEGER NOT NULL, mantra_player_id INTEGER NOT NULL,
      name TEXT NOT NULL, positions_json TEXT NOT NULL DEFAULT '[]',
      positions_italian_json TEXT NOT NULL DEFAULT '[]',
      status TEXT, final_price REAL, source_url TEXT NOT NULL DEFAULT '',
      sync_run_id TEXT NOT NULL DEFAULT 't', fetched_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (mantra_league_id, auction_id, player_bid_id)
    );
    CREATE TABLE mantra_auction_player_stages (
      mantra_league_id INTEGER NOT NULL, auction_id INTEGER NOT NULL,
      player_bid_id INTEGER NOT NULL, stage INTEGER NOT NULL,
      outcome TEXT, winning_price REAL, winning_team_id INTEGER,
      winning_team_name TEXT, sync_run_id TEXT NOT NULL DEFAULT 't',
      PRIMARY KEY (mantra_league_id, auction_id, player_bid_id, stage)
    );
  `);
  db.exec(FOOTMOPS_SCHEMA);
  return db;
}

function seedSquad(db: Database.Database) {
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_name, club_code, fotmob_player_id, tournament_id)
     VALUES
       (1, 'Alpha', 'Pat', 'Pat Alpha', '["ST"]', 'Leeds', 'LEE', 1001, 11),
       (2, 'Bench', 'Sam', 'Sam Bench', '["W"]', 'Leeds', 'LEE', 1002, 11),
       (3, 'Outed', 'Kim', 'Kim Outed', '["CB"]', 'Leeds', 'LEE', 1003, 11)`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams
       (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (10, 651, 11, 99, 'Cardiff XI', '[1,2,3]')`,
  ).run();
  db.prepare(
    `INSERT INTO fotmob_matches
       (id, league_id, round, kickoff, home_id, home_name, away_id, away_name,
        score_home, score_away, phase)
     VALUES
       (1, 48, '1', '2026-08-10T15:00:00Z', 7, 'Leeds', 8, 'Norwich', 1, 0, 'finished'),
       (2, 48, '2', '2026-08-17T15:00:00Z', 8, 'Norwich', 7, 'Leeds', 2, 0, 'finished'),
       (3, 48, '3', '2026-08-24T15:00:00Z', 7, 'Leeds', 9, 'Stoke', 0, 0, 'finished'),
       (4, 48, '4', '2026-08-31T15:00:00Z', 7, 'Leeds', 10, 'Hull', 1, 1, 'finished')`,
  ).run();
  db.prepare(
    `INSERT INTO fotmob_match_players
       (match_id, player_id, name, team_id, team_name, is_home, starter, rating, minutes,
        goals, assists, yellow_cards, red_cards, own_goals, saves, goals_conceded,
        penalties_won, penalties_conceded, penalties_scored, penalties_missed, penalties_saved)
     VALUES
       (1, 1001, 'Pat Alpha', 7, 'Leeds', 1, 1, 7.0, 90, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
       (2, 1001, 'Pat Alpha', 7, 'Leeds', 0, 1, 6.5, 70, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0),
       (3, 1001, 'Pat Alpha', 7, 'Leeds', 1, 0, 6.2, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
       (1, 1002, 'Sam Bench', 7, 'Leeds', 1, 0, 6.4, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
       (2, 1002, 'Sam Bench', 7, 'Leeds', 0, 0, 6.1, 18, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
       (3, 1002, 'Sam Bench', 7, 'Leeds', 1, 0, 6.0, 25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO fotmob_match_events
       (match_id, event_idx, time, type, is_home, raw_json)
     VALUES
       (1, 1, 78, 'Substitution', 1,
        '{"swap":[{"id":1002,"name":"Sam Bench"},{"id":1001,"name":"Pat Alpha"}]}'),
       (2, 1, 72, 'Substitution', 0,
        '{"swap":[{"id":1002,"name":"Sam Bench"},{"id":1001,"name":"Pat Alpha"}]}'),
       (3, 1, 70, 'Substitution', 1,
        '{"swap":[{"id":1001,"name":"Pat Alpha"},{"id":1004,"name":"Other"}]}')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_auction_players
       (mantra_league_id, auction_id, player_bid_id, mantra_player_id, name)
     VALUES (651, 1, 11, 1, 'Alpha'), (651, 1, 12, 2, 'Bench')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_auction_player_stages
       (mantra_league_id, auction_id, player_bid_id, stage, outcome, winning_price, winning_team_id)
     VALUES
       (651, 1, 11, 1, 'success', 19, 10),
       (651, 1, 12, 1, 'success', 7, 99)`,
  ).run();
}

const actor = { mantraManagerId: 99 };

test("reportSurname and deriveClubCode stay compact", () => {
  assert.equal(reportSurname("Dara O'Shea", "O'Shea"), "O'Shea");
  assert.equal(reportSurname("Darnell Furlong"), "Furlong");
  assert.equal(deriveClubCode("IPS", "Ipswich Town"), "IPS");
  assert.equal(deriveClubCode(null, "Ipswich Town"), "IPS");
  assert.equal(deriveClubCode(null, "Leeds"), "LEE");
});

test("parseFotmobTour reads trailing round numbers", () => {
  assert.equal(parseFotmobTour("6"), 6);
  assert.equal(parseFotmobTour("Regular Season - 12"), 12);
  assert.equal(parseFotmobTour(null), null);
});

test("squadReportStatus prefers OUT overlays and data-backed rotation", () => {
  assert.equal(
    squadReportStatus({
      clubTours: 3,
      starts: 0,
      subApps: 0,
      dnpTours: 3,
      lastStreakZero: 3,
      lastRed: false,
      missedAfterRed: false,
      footmopsOut: true,
      expected11Out: false,
      repeatedOffFor: null,
      repeatedOnFor: null,
    }).status,
    "OUT",
  );
  assert.equal(
    squadReportStatus({
      clubTours: 3,
      starts: 0,
      subApps: 3,
      dnpTours: 0,
      lastStreakZero: 0,
      lastRed: false,
      missedAfterRed: false,
      footmopsOut: false,
      expected11Out: false,
      repeatedOffFor: null,
      repeatedOnFor: "Pat Alpha",
    }).status,
    "ротация",
  );
});

test("Premium squad report uses FotMob minutes, rating, Mantra TS, and sub notes", async () => {
  const db = database();
  seedSquad(db);
  db.prepare(
    `INSERT INTO footmops_snapshots (league, tour, source, extracted_at)
     VALUES ('championship', 2, 'sorareinside', '2026-09-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO footmops_predictions
       (league, tour, club_key, source_club, source_player, lineup_group,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('championship', 2, 'leeds', 'Leeds', 'Kim Outed', 'out', NULL, 3, 'linked')`,
  ).run();

  const view = await getPremiumSquadReport(
    { teamId: 10, now: new Date("2026-09-12T00:00:00Z") },
    actor,
    db,
  );
  assert.equal(view.ok, true);
  assert.equal(view.ratingSource, "fotmob");
  assert.equal(view.sofaScore, false);
  assert.deepEqual(view.tours, [1, 2, 3, 4]);

  const alpha = view.players.find((p) => p.mantraPlayerId === 1);
  assert.ok(alpha);
  assert.deepEqual(
    alpha.minutesByTour.map((cell) => cell.minutes),
    [90, 70, 20, null],
  );
  assert.equal(alpha.ratingAvg, 6.6);
  assert.equal(alpha.ratingSource, "fotmob");
  assert.ok(alpha.mantraTsAvg != null && alpha.mantraTsAvg > 6);
  assert.equal(alpha.auctionPrice, 19);
  assert.ok(alpha.formScore >= 0 && alpha.formScore <= 10);
  assert.equal(Math.round(alpha.formScore * 100) / 100, alpha.formScore);
  assert.ok(alpha.formScore > 4);
  assert.equal(alpha.surname, "Alpha");
  assert.equal(alpha.clubCode, "LEE");
  assert.ok(alpha.subNotes.map((note) => note.label).join(" ").includes("T1 ↓ Bench"));
  assert.ok(alpha.subNotes.map((note) => note.label).join(" ").includes("T3 ↑ Other"));

  const bench = view.players.find((p) => p.mantraPlayerId === 2);
  assert.ok(bench);
  assert.equal(bench.auctionPrice, null);
  assert.equal(bench.status, "ротация");
  assert.match(bench.reason || "", /выходит вместо Pat Alpha/);

  const outed = view.players.find((p) => p.mantraPlayerId === 3);
  assert.ok(outed);
  assert.equal(outed.status, "OUT");
  assert.equal(outed.formScore, 0);
  assert.equal(outed.auctionPrice, null);
  assert.equal(outed.injury?.label, "OUT");
  assert.equal(outed.injury?.expectedReturn, null);
  assert.deepEqual(
    outed.minutesByTour.map((cell) => cell.minutes),
    [0, 0, 0, null],
  );
});

test("Premium squad report caches one hour per squad and rebuilds when fresh", async () => {
  const db = database();
  seedSquad(db);
  const now = new Date("2026-09-12T00:00:00Z");
  const first = await getPremiumSquadReport({ teamId: 10, now }, actor, db);
  db.prepare(`UPDATE fotmob_match_players SET minutes = 1 WHERE player_id = 1001`).run();
  const cached = await getPremiumSquadReport({ teamId: 10, now }, actor, db);
  assert.deepEqual(
    cached.players.find((p) => p.mantraPlayerId === 1)?.minutesByTour,
    first.players.find((p) => p.mantraPlayerId === 1)?.minutesByTour,
  );
  assert.ok(peekComputed(`${PREMIUM_SQUAD_REPORT_CACHE_PREFIX}10`));
  const fresh = await getPremiumSquadReport({ teamId: 10, now, fresh: true }, actor, db);
  assert.equal(
    fresh.players.find((p) => p.mantraPlayerId === 1)?.minutesByTour[0]?.minutes,
    1,
  );
});
