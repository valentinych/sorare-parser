import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  Expected11MappingError,
  fixtureForMatch,
  getExpected11MappingView,
  getExpected11PremiumView,
  invalidatePremiumOddsJoinCache,
  loadFotmobRatingAvgs,
  nextUpcomingRound,
  normalizedImplied1x2,
  PREMIUM_ODDS_CACHE_KEY,
  relinkPremiumSquadMappings,
  removeExpected11ManualMapping,
  saveExpected11ManualMapping,
  seasonStartIso,
} from "./expected11Premium.js";
import {
  peekComputed,
  peekComputedPersisted,
  resetComputedCacheForTests,
  writeComputed,
} from "../lib/computedCache.js";
import {
  backfillStartingXiFallbackPercentages,
  importExpected11,
  normalizeExpected11Import,
} from "./expected11Import.js";

test.afterEach(() => {
  resetComputedCacheForTests();
});

function database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE app_users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL
    );
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, first_name TEXT,
      full_name TEXT, positions_json TEXT, tm_url TEXT, club_id INTEGER, club_name TEXT,
      tournament_id INTEGER, fotmob_player_id INTEGER
    );
    CREATE TABLE expected11_matches (
      id TEXT PRIMARY KEY, source_url TEXT NOT NULL, title TEXT NOT NULL,
      home_team TEXT, away_team TEXT, formations_json TEXT NOT NULL DEFAULT '[]',
      extracted_at TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE expected11_teams (
      match_id TEXT NOT NULL, side TEXT NOT NULL, source_name TEXT NOT NULL,
      logo_url TEXT, notes_json TEXT NOT NULL DEFAULT '{}', author TEXT,
      mantra_club_id INTEGER, mantra_club_name TEXT, link_status TEXT NOT NULL,
      PRIMARY KEY (match_id, side)
    );
    CREATE TABLE expected11_predictions (
      match_id TEXT NOT NULL, team_side TEXT NOT NULL, lineup_group TEXT NOT NULL,
      sort_order INTEGER NOT NULL, source_name TEXT NOT NULL,
      displayed_percentage REAL, player_path TEXT, mantra_player_id INTEGER,
      link_status TEXT NOT NULL,
      PRIMARY KEY (match_id, team_side, lineup_group, sort_order)
    );
    CREATE TABLE expected11_manual_mappings (
      source_name_normalized TEXT NOT NULL, mantra_club_id INTEGER NOT NULL,
      mantra_player_id INTEGER NOT NULL, mapped_by_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source_name_normalized, mantra_club_id)
    );
    CREATE TABLE expected11_ingest_tours (
      league TEXT NOT NULL, tour INTEGER NOT NULL,
      urls_json TEXT NOT NULL DEFAULT '[]', extracted_at TEXT, imported_at TEXT,
      match_ids_json TEXT NOT NULL DEFAULT '[]', skipped_json TEXT NOT NULL DEFAULT '[]',
      last_error TEXT, PRIMARY KEY (league, tour)
    );
    CREATE TABLE fixtures (
      id INTEGER PRIMARY KEY, date TEXT, round TEXT, home_team_id INTEGER,
      away_team_id INTEGER, status TEXT, league_id INTEGER, season INTEGER
    );
    CREATE TABLE fixture_odds (
      fixture_id INTEGER PRIMARY KEY, kickoff TEXT, home_odd REAL,
      draw_odd REAL, away_odd REAL, bookmaker TEXT,
      home_cs_prob REAL, away_cs_prob REAL,
      home_score_prob REAL, away_score_prob REAL, popular_score TEXT
    );
    CREATE TABLE season_teams (
      season INTEGER, team_id INTEGER, name TEXT, league_id INTEGER
    );
    CREATE TABLE mantra_leagues (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, division TEXT, tournament_id INTEGER
    );
    CREATE TABLE mantra_fantasy_teams (
      id INTEGER PRIMARY KEY, league_id INTEGER, tournament_id INTEGER,
      user_id INTEGER, name TEXT, players_json TEXT
    );
  `);
  return db;
}

function insertMatch(
  db: Database.Database,
  id: string,
  home: string,
  away: string,
  extractedAt = "2026-08-10T12:00:00Z",
) {
  db.prepare(
    `INSERT INTO expected11_matches
       (id, source_url, title, home_team, away_team, extracted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `https://expected11.com/match/${id}/match`,
    `${home} vs ${away}`,
    home,
    away,
    extractedAt,
  );
}

test("manual mapping is club-scoped, reversible, and recounts immediately", () => {
  const db = database();
  db.prepare(`INSERT INTO app_users (id, email) VALUES (1, 'owner@example.com')`).run();
  const insertPlayer = db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 11)`,
  );
  insertPlayer.run(1, "Doe", "Jane", "Jane Doe", '["GK"]', 10, "Home");
  insertPlayer.run(2, "Roe", "John", "John Roe", '["CB"]', 10, "Home");
  insertPlayer.run(3, "Away", "Alex", "Alex Away", '["ST"]', 20, "Away");
  insertMatch(db, "1", "Home", "Away");
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, mantra_club_id, mantra_club_name, link_status)
     VALUES ('1', 'home', 'Home', 10, 'Home', 'linked')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('1', 'home', 'starting', 0, 'Mystery Player', 70, NULL, 'unmatched'),
            ('1', 'home', 'bench', 0, 'Other Mystery', 10, NULL, 'unmatched')`,
  ).run();

  const view = getExpected11MappingView(db);
  assert.deepEqual(
    view.groups[0]?.candidates.map((candidate) => candidate.id),
    [1, 2],
  );
  assert.throws(
    () =>
      saveExpected11ManualMapping(
        { sourceName: "Mystery Player", mantraClubId: 10, mantraPlayerId: 3 },
        { id: 1, email: "owner@example.com", mantraManagerId: null },
        db,
      ),
    (error) =>
      error instanceof Expected11MappingError &&
      error.code === "mapping_target_wrong_club",
  );

  const saved = saveExpected11ManualMapping(
    { sourceName: "Mystery Player", mantraClubId: 10, mantraPlayerId: 2 },
    { id: 1, email: "owner@example.com", mantraManagerId: null },
    db,
  );
  assert.deepEqual(saved.counts, {
    total: 2,
    linked: 1,
    unmatched: 1,
    ambiguous: 0,
  });
  assert.equal(saved.mapping.mantraPlayerName, "John Roe");
  assert.ok(saved.mapping.updatedAt);
  assert.equal(
    (
      db
        .prepare(
          `SELECT mantra_player_id AS id FROM expected11_predictions
           WHERE source_name = 'Mystery Player'`,
        )
        .get() as { id: number }
    ).id,
    2,
  );
  assert.equal(
    (
      db
        .prepare(
          `SELECT mantra_player_id AS id FROM expected11_predictions
           WHERE source_name = 'Other Mystery'`,
        )
        .get() as { id: number | null }
    ).id,
    null,
  );

  const removed = removeExpected11ManualMapping(
    { sourceName: "Mystery Player", mantraClubId: 10 },
    db,
  );
  assert.deepEqual(removed.counts, {
    total: 2,
    linked: 0,
    unmatched: 2,
    ambiguous: 0,
  });
});

test("manual mapping takes precedence over exact name matching", () => {
  const db = database();
  db.prepare(`INSERT INTO app_users (id, email) VALUES (1, 'owner@example.com')`).run();
  const insert = db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (?, ?, ?, ?, '[]', 10, 'Home', 11)`,
  );
  insert.run(1, "Doe", "Jane", "Jane Doe");
  insert.run(2, "Roe", "John", "John Roe");
  insertMatch(db, "1", "Home", "Away");
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, mantra_club_id, mantra_club_name, link_status)
     VALUES ('1', 'home', 'Home', 10, 'Home', 'linked')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('1', 'home', 'starting', 0, 'Jane Doe', 80, 1, 'linked')`,
  ).run();
  saveExpected11ManualMapping(
    { sourceName: "Jane Doe", mantraClubId: 10, mantraPlayerId: 2 },
    { id: 1, email: "owner@example.com", mantraManagerId: null },
    db,
  );
  const row = db
    .prepare(`SELECT mantra_player_id AS id FROM expected11_predictions`)
    .get() as { id: number };
  assert.equal(row.id, 2);
});

test("mapping view tags unmatched groups and manual links with league", () => {
  const db = database();
  db.prepare(`INSERT INTO app_users (id, email) VALUES (1, 'owner@example.com')`).run();
  const insertPlayer = db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (?, ?, ?, ?, '["ST"]', ?, ?, ?)`,
  );
  insertPlayer.run(1, "Doe", "Jane", "Jane Doe", 10, "Home", 11);
  insertPlayer.run(2, "Roe", "John", "John Roe", 20, "Away", 2);
  insertMatch(db, "1", "Home", "Visitors");
  insertMatch(db, "2", "Away", "Visitors");
  const insertTeam = db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, mantra_club_id, mantra_club_name, link_status)
     VALUES (?, 'home', ?, ?, ?, 'linked')`,
  );
  insertTeam.run("1", "Home", 10, "Home");
  insertTeam.run("2", "Away", 20, "Away");
  const insertPred = db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES (?, 'home', 'starting', 0, ?, 70, NULL, 'unmatched')`,
  );
  insertPred.run("1", "Mystery Champ");
  insertPred.run("2", "Mystery PL");
  db.prepare(
    `INSERT INTO expected11_ingest_tours (league, tour, match_ids_json)
     VALUES ('championship', 1, '["1"]'), ('premier-league', 1, '["2"]')`,
  ).run();

  const view = getExpected11MappingView(db);
  assert.ok(view.leagues.some((league) => league.slug === "championship"));
  assert.ok(view.leagues.some((league) => league.slug === "premier-league"));
  assert.ok(view.leagues.some((league) => league.slug === "ekstraklasa"));
  assert.equal(
    view.leagues.some((league) => league.slug === "la-liga"),
    false,
  );
  const byClub = Object.fromEntries(
    view.groups.map((group) => [group.mantraClubName, [group.league, group.leagueName]]),
  );
  assert.deepEqual(byClub, {
    Home: ["championship", "Championship"],
    Away: ["premier-league", "Premier League"],
  });

  const saved = saveExpected11ManualMapping(
    { sourceName: "Mystery Champ", mantraClubId: 10, mantraPlayerId: 1 },
    { id: 1, email: "owner@example.com", mantraManagerId: null },
    db,
  );
  assert.equal(saved.mapping.league, "championship");
  const linked = getExpected11MappingView(db);
  assert.equal(linked.groups.length, 1);
  assert.equal(linked.groups[0]?.league, "premier-league");
  assert.equal(linked.mappings[0]?.league, "championship");
});

test("Premium lists manager squads for nearest tour with Expected11 %, win, CS, and stored Exact Score", () => {
  const db = database();
  const player = db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  player.run(1, "One", "Player", "Player One", '["GK"]', 10, "Home", 11);
  player.run(2, "Two", "Player", "Player Two", '["ST"]', 20, "Away", 11);
  player.run(3, "Three", "Player", "Player Three", '["CB"]', 30, "No Odds", 11);
  player.run(4, "Other", "League", "League Other", '["ST"]', 40, "Other", 2);
  db.prepare(`UPDATE mantra_players SET tm_url = ? WHERE id = 1`).run(
    "https://www.transfermarkt.com/player-one/profil/spieler/777001",
  );

  insertMatch(db, "100", "Home", "Away");
  insertMatch(db, "101", "Home", "Future", "2026-08-10T13:00:00Z");
  insertMatch(db, "102", "No Odds", "Unknown");
  const team = db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, notes_json, author,
        mantra_club_id, mantra_club_name, link_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'linked')`,
  );
  team.run(
    "100",
    "home",
    "Home",
    JSON.stringify({
      teamAnalysis: { label: "Team Analysis", text: "Strong shape" },
    }),
    "Analyst",
    10,
    "Home",
  );
  team.run("100", "away", "Away", "{}", null, 20, "Away");
  team.run("101", "home", "Home", "{}", null, 10, "Home");
  team.run("102", "home", "No Odds", "{}", null, 30, "No Odds");
  const prediction = db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, player_path, mantra_player_id, link_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'linked')`,
  );
  prediction.run("100", "home", "starting", 0, "Player One", 80, "/player/1/p", 1);
  prediction.run("100", "home", "bench", 0, "Player One", 20, "/player/1/p", 1);
  prediction.run("100", "away", "starting", 0, "Player Two", 65, null, 2);
  prediction.run("101", "home", "starting", 0, "Player One", 90, null, 1);
  prediction.run("102", "home", "starting", 0, "Player Three", null, null, 3);

  const seasonTeam = db.prepare(
    `INSERT INTO season_teams (season, team_id, name, league_id)
     VALUES (2026, ?, ?, 40)`,
  );
  seasonTeam.run(10, "Home");
  seasonTeam.run(20, "Away");
  seasonTeam.run(50, "Future");
  seasonTeam.run(30, "No Odds");
  seasonTeam.run(60, "Unknown");
  const fixture = db.prepare(
    `INSERT INTO fixtures
       (id, date, round, home_team_id, away_team_id, status, league_id, season)
     VALUES (?, ?, 'Regular Season - 1', ?, ?, 'NS', 40, 2026)`,
  );
  fixture.run(500, "2026-08-12T18:00:00Z", 10, 20);
  fixture.run(501, "2026-08-13T18:00:00Z", 10, 50);
  fixture.run(502, "2026-08-12T20:00:00Z", 30, 60);
  db.prepare(
    `INSERT INTO fixture_odds
       (fixture_id, kickoff, home_odd, draw_odd, away_odd, bookmaker,
        home_cs_prob, away_cs_prob, home_score_prob, away_score_prob, popular_score)
     VALUES (500, '2026-08-12T18:00:00Z', 2, 4, 4, 'Book', 0.4, 0.25, 0.72, 0.55, '2:0')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams
       (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (1, 651, 11, 99, 'Cardiff XI', '[1,3,5]')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (5, 'Five', 'Player', 'Player Five', '["W","FW"]', 10, 'Home', 11)`,
  ).run();

  const actor = { id: 1, email: "owner@example.com", mantraManagerId: 99 };
  const view = getExpected11PremiumView(
    { tournamentId: 11, now: new Date("2026-08-11T00:00:00Z") },
    actor,
    db,
  );
  assert.equal(view.leagues[0]?.name, "Championship");
  assert.equal(view.managerIdConfigured, true);
  assert.equal(view.gaps.popularScore, false);
  assert.deepEqual(
    view.rows.map((row) => row.mantraPlayerId),
    [3, 1, 5],
  );
  const home = view.rows.find((row) => row.mantraPlayerId === 1)!;
  assert.equal(home.managerTeamName, "Cardiff XI");
  assert.equal(home.displayedPercentage, 80);
  assert.equal(home.lineupGroup, "starting");
  assert.equal(home.winProbability, 0.5);
  assert.equal(home.cleanSheetProbability, 0.4);
  assert.equal(home.opponentCleanSheetProbability, 0.25);
  assert.equal(home.teamScoreProbability, 0.72);
  assert.equal(home.popularScore, "2:0");
  assert.equal(home.seasonAvgRating, null);
  assert.equal(home.last5AvgRating, null);
  assert.equal(home.mantraProfileUrl, "/player.html?id=777001");
  assert.equal(home.round, 1);
  const noOdds = view.rows.find((row) => row.mantraPlayerId === 3)!;
  assert.equal(noOdds.winProbability, null);
  assert.equal(noOdds.cleanSheetProbability, null);
  assert.equal(noOdds.popularScore, null);
  assert.equal(noOdds.displayedPercentage, 66);
  assert.equal(noOdds.lineupGroup, "starting");
  const noExpected11 = view.rows.find((row) => row.mantraPlayerId === 5)!;
  assert.equal(noExpected11.displayedPercentage, null);
  assert.equal(noExpected11.winProbability, 0.5);
  assert.deepEqual(noExpected11.positions, ["W", "FW"]);
  assert.equal(noExpected11.position, "W");
  assert.ok(view.formations.some((formation) => formation.name === "4-3-3"));
  assert.ok(view.positionOrder.includes("GK"));
  assert.equal(
    view.rows.find((row) => row.mantraPlayerId === 2),
    undefined,
  );

  const anonymous = getExpected11PremiumView(
    { now: new Date("2026-08-11T00:00:00Z") },
    { id: 2, email: "other@example.com", mantraManagerId: null },
    db,
  );
  assert.deepEqual(anonymous.rows, []);
  assert.equal(anonymous.managerIdConfigured, false);
});

test("Premium PL tour 1 joins AF odds when Mantra club is Coventry City", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (1, 'Saka', 'Bukayo', 'Bukayo Saka', '["W"]', 21, 'Arsenal', 2),
            (2, 'Wright', 'Haji', 'Haji Wright', '["ST"]', 145, 'Coventry City', 2)`,
  ).run();
  db.prepare(
    `INSERT INTO season_teams (season, team_id, name, league_id)
     VALUES (2026, 42, 'Arsenal', 39), (2026, 1346, 'Coventry', 39)`,
  ).run();
  db.prepare(
    `INSERT INTO fixtures
       (id, date, round, home_team_id, away_team_id, status, league_id, season)
     VALUES (1557367, '2026-08-21T19:00:00Z', 'Regular Season - 1', 42, 1346, 'NS', 39, 2026)`,
  ).run();
  db.prepare(
    `INSERT INTO fixture_odds
       (fixture_id, kickoff, home_odd, draw_odd, away_odd, bookmaker,
        home_cs_prob, away_cs_prob, popular_score)
     VALUES (1557367, '2026-08-21T19:00:00Z', 1.18, 7.5, 15, 'Bet365', 0.62, 0.09, '2:0')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams
       (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (1, 1, 2, 99, 'PL XI', '[1,2]')`,
  ).run();

  const view = getExpected11PremiumView(
    { tournamentId: 2, now: new Date("2026-08-19T12:00:00Z") },
    { id: 1, email: "owner@example.com", mantraManagerId: 99 },
    db,
  );
  assert.equal(view.leagues[0]?.name, "Premier League");
  const arsenal = view.rows.find((row) => row.mantraPlayerId === 1)!;
  const coventry = view.rows.find((row) => row.mantraPlayerId === 2)!;
  assert.equal(arsenal.round, 1);
  assert.equal(arsenal.matchLabel, "Д vs Coventry");
  assert.equal(arsenal.winProbability, 0.8091);
  assert.equal(arsenal.cleanSheetProbability, 0.62);
  assert.equal(arsenal.opponentCleanSheetProbability, 0.09);
  assert.equal(arsenal.popularScore, "2:0");
  assert.equal(coventry.matchLabel, "Г vs Arsenal");
  assert.equal(coventry.winProbability, 0.0636);
  assert.equal(coventry.cleanSheetProbability, 0.09);
  assert.equal(coventry.popularScore, "2:0");
});

test("Premium team filter labels Mantra leagues and lists every club in those leagues", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_leagues (id, name, division, tournament_id)
     VALUES (730, 'Bath', NULL, 2), (684, 'London', 'A1', 2)`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams
       (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (1, 730, 2, 99, 'PL XI', '[1]'),
            (2, 684, 2, 99, 'PL XI', '[2]')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (1, 'Saka', 'Bukayo', 'Bukayo Saka', '["W"]', 21, 'Arsenal', 2),
            (2, 'Wright', 'Haji', 'Haji Wright', '["ST"]', 145, 'Coventry City', 2),
            (3, 'Haaland', 'Erling', 'Erling Haaland', '["ST"]', 50, 'Manchester City', 2),
            (4, 'Salah', 'Mohamed', 'Mohamed Salah', '["W"]', 40, 'Liverpool', 2)`,
  ).run();

  const view = getExpected11PremiumView(
    { now: new Date("2026-08-19T12:00:00Z") },
    { id: 1, email: "owner@example.com", mantraManagerId: 99 },
    db,
  );

  assert.deepEqual(
    view.teams.map((team) => [team.id, team.label, team.leagueName, team.competitionName]),
    [
      [1, "PL XI · Bath", "Bath", "Premier League"],
      [2, "PL XI · London A1", "London A1", "Premier League"],
    ],
  );
  assert.notEqual(view.teams[0]?.label, view.teams[1]?.label);
  assert.equal(view.rows.find((row) => row.mantraPlayerId === 1)?.managerLeagueName, "Bath");
  assert.equal(
    view.rows.find((row) => row.mantraPlayerId === 2)?.managerLeagueName,
    "London A1",
  );
  assert.deepEqual(
    view.clubs.map((club) => club.name),
    ["Arsenal", "Coventry City", "Liverpool", "Manchester City"],
  );
  assert.equal(view.clubs.length, 4);
  assert.ok(view.clubs.some((club) => club.name === "Manchester City"));
  assert.ok(!view.rows.some((row) => row.clubName === "Manchester City"));
});

test("Premium includes England 3 teams and skips /tables-only championships", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_leagues (id, name, division, tournament_id)
     VALUES (795, 'Winchester', 'C1', 26), (732, 'Paris', 'A1', 4)`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams
       (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (10, 795, 26, 99, 'E3 XI', '[10]'),
            (11, 732, 4, 99, 'L1 XI', '[11]')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (10, 'Clarke', 'Jack', 'Jack Clarke', '["W"]', 1, 'Ipswich', 26),
            (11, 'Mbappe', 'Kylian', 'Kylian Mbappe', '["ST"]', 2, 'PSG', 4)`,
  ).run();

  const view = getExpected11PremiumView(
    { now: new Date("2026-08-19T12:00:00Z") },
    { id: 1, email: "owner@example.com", mantraManagerId: 99 },
    db,
  );
  assert.deepEqual(
    view.teams.map((team) => [team.id, team.label, team.competitionName]),
    [[10, "E3 XI · Winchester C1", "League One"]],
  );
  assert.equal(view.leagues[0]?.name, "League One");
  assert.equal(view.leagues[0]?.tournamentId, 26);
  assert.ok(!view.teams.some((team) => team.competitionName === "Ligue 1"));
});

test("Premium keeps a Mantra league team with no upcoming fixtures", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_leagues (id, name, division, tournament_id)
     VALUES (717, 'Lincoln', 'E6', 2), (786, 'Bournemouth', NULL, 2)`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams
       (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (396, 717, 2, 205, 'Loch Ness F.C.', '[1]'),
            (5009, 786, 2, 205, 'Loch Ness F.C.', '[]')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (1, 'Saka', 'Bukayo', 'Bukayo Saka', '["W"]', 21, 'Arsenal', 2)`,
  ).run();

  const view = getExpected11PremiumView(
    { now: new Date("2026-08-19T12:00:00Z") },
    { id: 1, email: "owner@example.com", mantraManagerId: 205 },
    db,
  );

  assert.deepEqual(
    view.teams.map((team) => [team.id, team.label]),
    [
      [396, "Loch Ness F.C. · Lincoln E6"],
      [5009, "Loch Ness F.C. · Bournemouth"],
    ],
  );
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0]?.managerLeagueName, "Lincoln E6");
});

test("next upcoming round skips a fully finished tour", () => {
  const db = database();
  const fixture = db.prepare(
    `INSERT INTO fixtures
       (id, date, round, home_team_id, away_team_id, status, league_id, season)
     VALUES (?, ?, ?, ?, ?, ?, 39, 2026)`,
  );
  fixture.run(1, "2026-08-15T14:00:00Z", "Regular Season - 1", 1, 2, "FT");
  fixture.run(2, "2026-08-15T16:00:00Z", "Regular Season - 1", 3, 4, "FT");
  fixture.run(3, "2026-08-22T14:00:00Z", "Regular Season - 2", 1, 4, "NS");
  assert.equal(nextUpcomingRound(db, 39, 2026, Date.parse("2026-08-21T12:00:00Z")), 2);
});

test("stale NS leftovers are knownPast so last week's Expected11 % does not stick", () => {
  const fixtures = [
    {
      id: 1,
      kickoff: "2026-08-23T16:30:00Z",
      league_id: 135,
      season: 2026,
      round: "Regular Season - 1",
      status: "NS",
      home_name: "Frosinone",
      away_name: "Juventus",
      home_odd: null,
      draw_odd: null,
      away_odd: null,
      bookmaker: null,
      home_cs_prob: null,
      away_cs_prob: null,
      popular_score: null,
    },
  ];
  const now = Date.parse("2026-09-11T16:00:00Z");
  assert.equal(
    fixtureForMatch(
      { homeTeam: "Frosinone", awayTeam: "Juventus" },
      fixtures,
      now,
    ).knownPast,
    true,
  );
  assert.equal(
    fixtureForMatch(
      { homeTeam: "Frosinone", awayTeam: "Juventus" },
      fixtures,
      now,
    ).fixture,
    null,
  );
});

test("Premium drops last tour's Expected11 90% when the next Serie A round has no parse", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (488, 'Bremer', 'Gleison', 'Gleison Bremer', '["CB"]', 8, 'Juventus', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO season_teams (season, team_id, name, league_id)
     VALUES (2026, 512, 'Frosinone', 135), (2026, 496, 'Juventus', 135),
            (2026, 487, 'Sassuolo', 135)`,
  ).run();
  db.prepare(
    `INSERT INTO fixtures
       (id, date, round, home_team_id, away_team_id, status, league_id, season)
     VALUES (1, '2026-08-23T16:30:00Z', 'Regular Season - 1', 512, 496, 'NS', 135, 2026),
            (2, '2026-09-12T16:00:00Z', 'Regular Season - 4', 487, 496, 'NS', 135, 2026)`,
  ).run();
  insertMatch(db, "19713615", "Frosinone", "Juventus", "2026-08-21T14:22:48Z");
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, mantra_club_id, mantra_club_name, link_status)
     VALUES ('19713615', 'away', 'Juventus', 8, 'Juventus', 'linked')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('19713615', 'away', 'starting', 0, 'Bremer', 90, 488, 'linked')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams
       (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (1, 742, 1, 99, 'Rome XI', '[488]')`,
  ).run();

  const view = getExpected11PremiumView(
    { now: new Date("2026-09-11T16:00:00Z"), tournamentId: 1 },
    { id: 1, email: "owner@example.com", mantraManagerId: 99 },
    db,
  );
  const row = view.rows[0]!;
  assert.equal(row.round, 4);
  assert.equal(row.displayedPercentage, null);
  assert.equal(row.lineupGroup, null);
  assert.equal(row.opponent, "Sassuolo");
});

test("next upcoming round skips last week's NS leftovers and keeps this weekend", () => {
  const db = database();
  const fixture = db.prepare(
    `INSERT INTO fixtures
       (id, date, round, home_team_id, away_team_id, status, league_id, season)
     VALUES (?, ?, ?, ?, ?, ?, 40, 2026)`,
  );
  fixture.run(1, "2026-08-14T19:00:00Z", "Regular Season - 1", 1, 2, "NS");
  fixture.run(2, "2026-08-17T19:00:00Z", "Regular Season - 1", 3, 4, "NS");
  fixture.run(3, "2026-08-22T14:00:00Z", "Regular Season - 2", 1, 4, "NS");
  const now = Date.parse("2026-08-21T12:00:00Z");
  assert.equal(nextUpcomingRound(db, 40, 2026, now), 2);
  db.prepare(
    `INSERT INTO fixtures
       (id, date, round, home_team_id, away_team_id, status, league_id, season)
     VALUES (4, '2026-08-21T19:00:00Z', 'Regular Season - 1', 5, 6, 'NS', 39, 2026)`,
  ).run();
  assert.equal(nextUpcomingRound(db, 39, 2026, now), 1);
});

test("Premium uses the next unfinished tour for opponent and odds, not the last played", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (1, 'Saka', 'Bukayo', 'Bukayo Saka', '["W"]', 21, 'Arsenal', 2)`,
  ).run();
  db.prepare(
    `INSERT INTO season_teams (season, team_id, name, league_id)
     VALUES (2026, 42, 'Arsenal', 39), (2026, 1346, 'Coventry', 39),
            (2026, 50, 'Liverpool', 39)`,
  ).run();
  db.prepare(
    `INSERT INTO fixtures
       (id, date, round, home_team_id, away_team_id, status, league_id, season)
     VALUES (1, '2026-08-15T14:00:00Z', 'Regular Season - 1', 42, 1346, 'FT', 39, 2026),
            (2, '2026-08-22T14:00:00Z', 'Regular Season - 2', 50, 42, 'NS', 39, 2026)`,
  ).run();
  db.prepare(
    `INSERT INTO fixture_odds
       (fixture_id, kickoff, home_odd, draw_odd, away_odd, bookmaker,
        home_cs_prob, away_cs_prob, popular_score)
     VALUES (1, '2026-08-15T14:00:00Z', 1.2, 7, 12, 'Old', 0.7, 0.1, '3:0'),
            (2, '2026-08-22T14:00:00Z', 2.5, 3.4, 2.8, 'Book', 0.3, 0.28, '1:1')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams
       (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (1, 1, 2, 99, 'PL XI', '[1]')`,
  ).run();

  const view = getExpected11PremiumView(
    { now: new Date("2026-08-21T12:00:00Z") },
    { id: 1, email: "owner@example.com", mantraManagerId: 99 },
    db,
  );
  const row = view.rows[0]!;
  assert.equal(row.round, 2);
  assert.equal(row.matchLabel, "Г vs Liverpool");
  assert.equal(row.popularScore, "1:1");
  assert.equal(row.bookmaker, "Book");
  assert.ok(row.winProbability != null);
  assert.notEqual(row.popularScore, "3:0");
});

test("in-play weekend fixture stays current, finished one is past", () => {
  const fixtures = [
    {
      id: 1,
      kickoff: "2026-08-21T19:00:00Z",
      league_id: 39,
      season: 2026,
      round: "Regular Season - 1",
      status: "1H",
      home_name: "Arsenal",
      away_name: "Coventry",
      home_odd: 1.2,
      draw_odd: 7,
      away_odd: 12,
      bookmaker: "Book",
      home_cs_prob: 0.5,
      away_cs_prob: 0.1,
      popular_score: "2:0",
    },
    {
      id: 2,
      kickoff: "2026-08-15T14:00:00Z",
      league_id: 39,
      season: 2026,
      round: "Regular Season - 1",
      status: "FT",
      home_name: "Brighton",
      away_name: "Bournemouth",
      home_odd: null,
      draw_odd: null,
      away_odd: null,
      bookmaker: null,
      home_cs_prob: null,
      away_cs_prob: null,
      popular_score: null,
    },
  ];
  const now = Date.parse("2026-08-21T19:30:00Z");
  assert.equal(
    fixtureForMatch(
      { homeTeam: "Arsenal", awayTeam: "Coventry" },
      fixtures,
      now,
    ).fixture?.id,
    1,
  );
  assert.equal(
    fixtureForMatch(
      { homeTeam: "Brighton", awayTeam: "AFC Bournemouth" },
      fixtures,
      now,
    ).knownPast,
    true,
  );
});

test("normalized 1X2 math rejects incomplete odds", () => {
  assert.deepEqual(normalizedImplied1x2(2, 4, 4), {
    home: 0.5,
    draw: 0.25,
    away: 0.25,
  });
  assert.equal(normalizedImplied1x2(2, null, 4), null);
});

test("Expected11 EPL club aliases match AF fixture names", () => {
  const fixtures = [
    {
      id: 1,
      kickoff: "2026-08-22T14:00:00Z",
      league_id: 39,
      season: 2026,
      round: "Regular Season - 1",
      status: "NS",
      home_name: "Brighton",
      away_name: "Bournemouth",
      home_odd: null,
      draw_odd: null,
      away_odd: null,
      bookmaker: null,
      home_cs_prob: null,
      away_cs_prob: null,
      popular_score: null,
    },
    {
      id: 2,
      kickoff: "2026-08-23T14:00:00Z",
      league_id: 39,
      season: 2026,
      round: "Regular Season - 1",
      status: "NS",
      home_name: "Newcastle",
      away_name: "Ipswich",
      home_odd: null,
      draw_odd: null,
      away_odd: null,
      bookmaker: null,
      home_cs_prob: null,
      away_cs_prob: null,
      popular_score: null,
    },
  ];
  const now = Date.parse("2026-08-19T12:00:00Z");
  assert.equal(
    fixtureForMatch(
      { homeTeam: "Brighton & Hove Albion", awayTeam: "AFC Bournemouth" },
      fixtures,
      now,
    ).fixture?.id,
    1,
  );
  assert.equal(
    fixtureForMatch(
      { homeTeam: "Newcastle United", awayTeam: "Ipswich Town" },
      fixtures,
      now,
    ).fixture?.id,
    2,
  );
  const superLig = [
    {
      id: 3,
      kickoff: "2026-08-22T18:00:00Z",
      league_id: 203,
      season: 2026,
      round: "Regular Season - 2",
      status: "NS",
      home_name: "Basaksehir",
      away_name: "Gaziantep",
      home_odd: null,
      draw_odd: null,
      away_odd: null,
      bookmaker: null,
      home_cs_prob: null,
      away_cs_prob: null,
      popular_score: null,
    },
  ];
  assert.equal(
    fixtureForMatch(
      { homeTeam: "İstanbul Başakşehir", awayTeam: "Gaziantep F.K." },
      superLig,
      now,
    ).fixture?.id,
    3,
  );
  const serieA = [
    {
      id: 4,
      kickoff: "2026-08-22T18:00:00Z",
      league_id: 135,
      season: 2026,
      round: "Regular Season - 1",
      status: "NS",
      home_name: "Torino",
      away_name: "Milan",
      home_odd: null,
      draw_odd: null,
      away_odd: null,
      bookmaker: null,
      home_cs_prob: null,
      away_cs_prob: null,
      popular_score: null,
    },
  ];
  assert.equal(
    fixtureForMatch(
      { homeTeam: "Torino", awayTeam: "AC Milan" },
      serieA,
      now,
    ).fixture?.id,
    4,
  );
});

function seedKrejciPremium(db: Database.Database) {
  db.prepare(`INSERT INTO app_users (id, email) VALUES (1, 'owner@example.com')`).run();
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (1, 'Krejci', 'Ladislav', 'Ladislav Krejci', '["CB"]', 10, 'Wolverhampton', 11)`,
  ).run();
  insertMatch(db, "197", "Wolverhampton", "Cardiff");
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, mantra_club_id, mantra_club_name, link_status)
     VALUES ('197', 'home', 'Wolverhampton', 10, 'Wolverhampton', 'linked')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('197', 'home', 'bench', 0, 'Ladislav Krejci', 80, 1, 'linked')`,
  ).run();
  db.prepare(
    `INSERT INTO season_teams (season, team_id, name, league_id)
     VALUES (2026, 10, 'Wolverhampton', 40), (2026, 20, 'Cardiff', 40)`,
  ).run();
  db.prepare(
    `INSERT INTO fixtures
       (id, date, round, home_team_id, away_team_id, status, league_id, season)
     VALUES (1, '2026-08-22T14:00:00Z', 'Regular Season - 2', 10, 20, 'NS', 40, 2026)`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_leagues (id, name, division, tournament_id)
     VALUES (651, 'Cardiff', 'A1', 11)`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams
       (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (1, 651, 11, 99, 'Loch Ness F.C.', '[1]')`,
  ).run();
}

test("premium keeps the later same-role Expected11 % instead of the higher one", () => {
  const db = database();
  seedKrejciPremium(db);
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('197', 'home', 'bench', 1, 'Ladislav Krejci', 40, 1, 'linked')`,
  ).run();
  const view = getExpected11PremiumView(
    { now: new Date("2026-08-21T12:00:00Z") },
    { id: 1, email: "owner@example.com", mantraManagerId: 99 },
    db,
  );
  assert.equal(view.rows[0]?.displayedPercentage, 40);
  assert.equal(view.rows[0]?.lineupGroup, "bench");
});

test("premium odds-join cache keeps Expected11 % until parse invalidates it", () => {
  const db = database();
  seedKrejciPremium(db);
  const now = new Date("2026-08-21T12:00:00Z");
  const actor = { id: 1, email: "owner@example.com", mantraManagerId: 99 };

  const first = getExpected11PremiumView({ now }, actor, db);
  assert.equal(first.rows[0]?.displayedPercentage, 80);
  assert.equal(first.rows[0]?.lineupGroup, "bench");

  db.prepare(
    `UPDATE expected11_predictions SET displayed_percentage = 45 WHERE mantra_player_id = 1`,
  ).run();
  const stale = getExpected11PremiumView({ now }, actor, db);
  assert.equal(stale.rows[0]?.displayedPercentage, 80);

  invalidatePremiumOddsJoinCache(db);
  const fresh = getExpected11PremiumView({ now }, actor, db);
  assert.equal(fresh.rows[0]?.displayedPercentage, 45);
});

test("web GET does not rebuild premium odds-join on cache miss", () => {
  const prev = process.env.COMPUTE_ENQUEUE;
  process.env.COMPUTE_ENQUEUE = "0";
  try {
    const db = database();
    seedKrejciPremium(db);
    const now = new Date("2026-08-21T12:00:00Z");
    const actor = { id: 1, email: "owner@example.com", mantraManagerId: 99 };
    const started = Date.now();
    const view = getExpected11PremiumView({ now }, actor, db);
    assert.ok(Date.now() - started < 500);
    assert.equal(view.rows[0]?.winProbability, null);
    assert.equal(peekComputed(PREMIUM_ODDS_CACHE_KEY), undefined);
  } finally {
    if (prev == null) delete process.env.COMPUTE_ENQUEUE;
    else process.env.COMPUTE_ENQUEUE = prev;
  }
});

test("Expected11 import, mapping, and 66% backfill drop premium odds-join but keep squad cache", () => {
  const db = database();
  seedKrejciPremium(db);
  const squadKey = "premium:squads:99";
  const seedJoin = () => {
    writeComputed(
      PREMIUM_ODDS_CACHE_KEY,
      "rounds:test|ttl:1",
      { fixtures: [], expected11: [], rounds: [] },
      { database: db },
    );
    writeComputed(squadKey, "1", { teamIds: [1] }, { database: db });
  };

  seedJoin();
  assert.equal(backfillStartingXiFallbackPercentages(db), 0);
  assert.ok(peekComputed(PREMIUM_ODDS_CACHE_KEY));

  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('197', 'home', 'starting', 1, 'Starter No Pct', NULL, NULL, 'unmatched')`,
  ).run();
  assert.equal(backfillStartingXiFallbackPercentages(db), 1);
  assert.equal(peekComputed(PREMIUM_ODDS_CACHE_KEY), undefined);
  assert.equal(peekComputedPersisted(PREMIUM_ODDS_CACHE_KEY, { database: db }), undefined);
  assert.deepEqual(peekComputed(squadKey), { teamIds: [1] });

  seedJoin();
  importExpected11(
    normalizeExpected11Import({
      schemaVersion: 2,
      extractedAt: "2026-08-21T12:00:00Z",
      league: "championship",
      tour: 2,
      matches: [
        {
          sourceUrl: "https://expected11.com/match/198/wolves-vs-cardiff",
          extractedAt: "2026-08-21T12:00:00Z",
          status: "ok",
          match: {
            id: "198",
            title: "Wolverhampton vs Cardiff",
            homeTeam: "Wolverhampton",
            awayTeam: "Cardiff",
            formations: ["4-3-3"],
          },
          teams: [
            {
              side: "home",
              name: "Wolverhampton",
              logoUrl: null,
              lineup: {
                starting: [],
                bench: [
                  {
                    name: "Ladislav Krejci",
                    displayedPercentage: 45,
                    raw: { playerPath: "/player/1/krejci" },
                  },
                ],
                out: [],
              },
              notes: {},
              author: null,
            },
          ],
        },
      ],
    }),
    db,
    { replaceAll: false },
  );
  assert.equal(peekComputed(PREMIUM_ODDS_CACHE_KEY), undefined);
  assert.equal(peekComputedPersisted(PREMIUM_ODDS_CACHE_KEY, { database: db }), undefined);
  assert.deepEqual(peekComputedPersisted(squadKey, { database: db }), { teamIds: [1] });

  seedJoin();
  saveExpected11ManualMapping(
    { sourceName: "Ladislav Krejci", mantraClubId: 10, mantraPlayerId: 1 },
    { id: 1, email: "owner@example.com", mantraManagerId: 99 },
    db,
  );
  assert.equal(peekComputed(PREMIUM_ODDS_CACHE_KEY), undefined);
  assert.deepEqual(peekComputed(squadKey), { teamIds: [1] });

  seedJoin();
  removeExpected11ManualMapping({ sourceName: "Ladislav Krejci", mantraClubId: 10 }, db);
  assert.equal(peekComputed(PREMIUM_ODDS_CACHE_KEY), undefined);
  assert.deepEqual(peekComputed(squadKey), { teamIds: [1] });
});

test("premium squad relink maps newly ingested club names and drops odds cache", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (30, 'Muldur', 'Mert', 'Mert Muldur', '["RB"]', 414, 'Eyüp Spor Kulübü', 21)`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_matches
       (id, source_url, title, home_team, away_team, formations_json, extracted_at)
     VALUES ('19746645', 'https://expected11.com/match/19746645/fenerbahce-vs-eyupspor',
             'Fenerbahçe vs Eyüpspor', 'Fenerbahçe', 'Eyüpspor', '[]', '2026-08-19T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, notes_json, mantra_club_id, mantra_club_name, link_status)
     VALUES ('19746645', 'away', 'Eyüpspor', '{}', NULL, NULL, 'unmatched')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('19746645', 'away', 'starting', 0, 'Mert Muldur', 80, NULL, 'unmatched')`,
  ).run();
  writeComputed(
    PREMIUM_ODDS_CACHE_KEY,
    "rounds:test|ttl:1",
    { fixtures: [], expected11: [], rounds: [] },
    { database: db },
  );

  const result = relinkPremiumSquadMappings(db);
  assert.equal(result.teams.teamsLinked, 1);
  assert.equal(result.teams.playersLinked, 1);
  const team = db
    .prepare(
      `SELECT mantra_club_id AS clubId, mantra_club_name AS clubName, link_status AS status
       FROM expected11_teams WHERE match_id = '19746645'`,
    )
    .get() as { clubId: number; clubName: string; status: string };
  assert.equal(team.clubId, 414);
  assert.equal(team.clubName, "Eyüp Spor Kulübü");
  assert.equal(team.status, "linked");
  const player = db
    .prepare(
      `SELECT mantra_player_id AS playerId, link_status AS status
       FROM expected11_predictions WHERE match_id = '19746645'`,
    )
    .get() as { playerId: number; status: string };
  assert.equal(player.playerId, 30);
  assert.equal(player.status, "linked");
  assert.equal(peekComputed(PREMIUM_ODDS_CACHE_KEY), undefined);
});

test("seasonStartIso uses July 1 UTC as the football season boundary", () => {
  assert.equal(seasonStartIso(new Date("2026-09-12T00:00:00Z")), "2026-07-01");
  assert.equal(seasonStartIso(new Date("2026-06-30T23:00:00Z")), "2025-07-01");
});

test("Premium FotMob ratings average this season and last 5 games", () => {
  const db = database();
  db.exec(`
    CREATE TABLE fotmob_matches (
      id INTEGER PRIMARY KEY, kickoff TEXT, phase TEXT
    );
    CREATE TABLE fotmob_match_players (
      match_id INTEGER NOT NULL, player_id INTEGER NOT NULL, rating REAL,
      PRIMARY KEY (match_id, player_id)
    );
  `);
  db.prepare(
    `INSERT INTO mantra_players
       (id, name, first_name, full_name, positions_json, club_id, club_name,
        tournament_id, fotmob_player_id)
     VALUES (1, 'One', 'Player', 'Player One', '["ST"]', 10, 'Home', 11, 1001)`,
  ).run();
  db.prepare(
    `INSERT INTO fotmob_matches (id, kickoff, phase) VALUES
      (1, '2025-12-01T15:00:00Z', 'finished'),
      (2, '2026-08-10T15:00:00Z', 'finished'),
      (3, '2026-08-17T15:00:00Z', 'finished'),
      (4, '2026-08-24T15:00:00Z', 'finished'),
      (5, '2026-08-31T15:00:00Z', 'finished'),
      (6, '2026-09-07T15:00:00Z', 'finished'),
      (7, '2026-09-10T15:00:00Z', 'finished')`,
  ).run();
  db.prepare(
    `INSERT INTO fotmob_match_players (match_id, player_id, rating) VALUES
      (1, 1001, 9.0),
      (2, 1001, 5.0),
      (3, 1001, 8.0),
      (4, 1001, 8.0),
      (5, 1001, 8.0),
      (6, 1001, 8.0),
      (7, 1001, 8.0)`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_leagues (id, name, division, tournament_id) VALUES (651, 'Champ', 'A', 11)`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams
       (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (1, 651, 11, 99, 'Cardiff XI', '[1]')`,
  ).run();

  const now = new Date("2026-09-12T00:00:00Z");
  const avgs = loadFotmobRatingAvgs(db, [1001], now);
  assert.deepEqual(avgs.get(1001), { seasonAvg: 7.5, last5Avg: 8.0 });

  const view = getExpected11PremiumView({ tournamentId: 11, now }, {
    id: 1,
    email: "owner@example.com",
    mantraManagerId: 99,
  }, db);
  assert.equal(view.rows[0]?.seasonAvgRating, 7.5);
  assert.equal(view.rows[0]?.last5AvgRating, 8.0);
});
