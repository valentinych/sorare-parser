import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { FormationPlan } from "../lib/roles.js";
import {
  expected11SnapshotVersion,
  expected11XiPredictionsForAfPlayers,
  type Expected11XiPrediction,
} from "./expected11Xi.js";
import {
  effectiveStarterEvidence,
  selectXiWithExpected11Availability,
  type RankedPlayer,
} from "./predictSeasonXi.js";

function database(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE player_values (
      af_player_id INTEGER, tm_player_id TEXT, team_id INTEGER
    );
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY, tournament_id INTEGER, club_id INTEGER,
      club_name TEXT, tm_url TEXT
    );
    CREATE TABLE expected11_matches (
      id TEXT PRIMARY KEY, source_url TEXT, title TEXT, home_team TEXT,
      away_team TEXT, extracted_at TEXT, imported_at TEXT
    );
    CREATE TABLE expected11_teams (
      match_id TEXT, side TEXT, source_name TEXT, mantra_club_id INTEGER,
      mantra_club_name TEXT, link_status TEXT
    );
    CREATE TABLE expected11_predictions (
      match_id TEXT, team_side TEXT, lineup_group TEXT, sort_order INTEGER,
      displayed_percentage REAL, player_path TEXT, mantra_player_id INTEGER,
      link_status TEXT
    );
    CREATE TABLE fixtures (
      id INTEGER PRIMARY KEY, date TEXT, home_team_id INTEGER, away_team_id INTEGER,
      league_id INTEGER, season INTEGER, status TEXT
    );
    CREATE TABLE fixture_odds (
      fixture_id INTEGER PRIMARY KEY, kickoff TEXT, home_odd REAL, draw_odd REAL,
      away_odd REAL, bookmaker TEXT
    );
    CREATE TABLE season_teams (
      season INTEGER, team_id INTEGER, name TEXT, league_id INTEGER
    );
    CREATE TABLE expected11_manual_mappings (
      updated_at TEXT
    );
  `);
  return db;
}

function insertMatch(
  db: Database.Database,
  id: string,
  home: string,
  away: string,
  extractedAt: string,
  importedAt: string,
) {
  db.prepare(
    `INSERT INTO expected11_matches
       (id, source_url, title, home_team, away_team, extracted_at, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `https://expected11.com/match/${id}/source`,
    `${home} vs ${away}`,
    home,
    away,
    extractedAt,
    importedAt,
  );
}

function insertTeam(
  db: Database.Database,
  matchId: string,
  clubId: number,
  name: string,
) {
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, mantra_club_id, mantra_club_name, link_status)
     VALUES (?, 'home', ?, ?, ?, 'linked')`,
  ).run(matchId, name, clubId, name);
}

function insertPrediction(
  db: Database.Database,
  matchId: string,
  mantraPlayerId: number,
  group: string,
  percentage: number | null,
) {
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, displayed_percentage,
        player_path, mantra_player_id, link_status)
     VALUES (?, 'home', ?, 0, ?, '/player/test', ?, 'linked')`,
  ).run(matchId, group, percentage, mantraPlayerId);
}

test("strict links choose nearest future, latest unknown, and stale provenance", () => {
  const db = database();
  const mantra = db.prepare(
    `INSERT INTO mantra_players
       (id, tournament_id, club_id, club_name, tm_url)
     VALUES (?, 11, ?, ?, ?)`,
  );
  mantra.run(10, 100, "Home", "https://transfermarkt.com/a/profil/spieler/101");
  mantra.run(11, 100, "Home", null);
  mantra.run(12, 200, "Unknown", "https://transfermarkt.com/c/profil/spieler/103");
  mantra.run(13, 300, "Past", "https://transfermarkt.com/d/profil/spieler/104");
  mantra.run(14, 200, "Unknown", "https://transfermarkt.com/e/profil/spieler/105");
  const value = db.prepare(
    `INSERT INTO player_values (af_player_id, tm_player_id, team_id) VALUES (?, ?, ?)`,
  );
  value.run(1, "101", 1);
  value.run(2, "102", 1);
  value.run(3, "103", 2);
  value.run(4, "104", 3);
  value.run(5, "105", 2);

  insertMatch(db, "100", "Home", "Away", "2026-08-10T10:00:00Z", "2026-08-10T10:01:00Z");
  insertMatch(db, "101", "Home", "Later", "2026-08-11T10:00:00Z", "2026-08-11T10:01:00Z");
  insertMatch(db, "200", "Unknown", "Mystery", "2026-08-09T10:00:00Z", "2026-08-09T10:01:00Z");
  insertMatch(db, "201", "Unknown", "Mystery 2", "2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z");
  insertMatch(db, "300", "Past", "Old", "2026-08-08T10:00:00Z", "2026-08-08T10:01:00Z");
  for (const [id, clubId, name] of [
    ["100", 100, "Home"],
    ["101", 100, "Home"],
    ["200", 200, "Unknown"],
    ["201", 200, "Unknown"],
    ["300", 300, "Past"],
  ] as const) {
    insertTeam(db, id, clubId, name);
  }
  insertPrediction(db, "100", 10, "starting", 70);
  insertPrediction(db, "100", 11, "starting", 99);
  insertPrediction(db, "101", 10, "starting", 90);
  insertPrediction(db, "200", 12, "bench", 40);
  insertPrediction(db, "201", 12, "bench", 60);
  insertPrediction(db, "201", 14, "out", null);
  insertPrediction(db, "300", 13, "starting", 88);

  const seasonTeam = db.prepare(
    `INSERT INTO season_teams (season, team_id, name, league_id)
     VALUES (2026, ?, ?, 40)`,
  );
  for (const [id, name] of [
    [1, "Home"],
    [2, "Away"],
    [3, "Later"],
    [4, "Past"],
    [5, "Old"],
  ] as const) {
    seasonTeam.run(id, name);
  }
  const fixture = db.prepare(
    `INSERT INTO fixtures
       (id, date, home_team_id, away_team_id, league_id, season, status)
     VALUES (?, ?, ?, ?, 40, 2026, ?)`,
  );
  fixture.run(1, "2026-08-15T12:00:00Z", 1, 2, "NS");
  fixture.run(2, "2026-08-16T12:00:00Z", 1, 3, "NS");
  fixture.run(3, "2026-08-12T12:00:00Z", 4, 5, "FT");

  const result = expected11XiPredictionsForAfPlayers(40, [1, 2, 3, 4, 5], {
    now: new Date("2026-08-13T12:00:00Z"),
    database: db,
  });
  assert.equal(result.get(1)?.sourceMatchId, "100");
  assert.equal(result.get(1)?.displayedPercentage, 70);
  assert.equal(result.get(1)?.starterProbability, 0.7);
  assert.equal(result.get(1)?.updatedAt, "2026-08-10T10:01:00Z");
  assert.equal(result.has(2), false, "name-only rows must not join");
  assert.equal(result.get(3)?.sourceMatchId, "201");
  assert.equal(result.get(3)?.freshness, "unknown");
  assert.equal(result.get(3)?.kickoffKnown, false);
  assert.equal(result.get(3)?.starterProbability, 0.6);
  assert.equal(result.get(5)?.lineupGroup, "out");
  assert.equal(result.get(5)?.displayedPercentage, null);
  assert.equal(result.get(5)?.starterProbability, null);
  assert.equal(result.get(4)?.freshness, "stale");
  assert.equal(result.get(4)?.displayedPercentage, 88);
  assert.equal(result.get(4)?.starterProbability, null);
  assert.equal(result.get(4)?.influencedSelection, false);
});

test("starting XI without a stored percentage is treated as 66%", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_players
       (id, tournament_id, club_id, club_name, tm_url)
     VALUES (10, 11, 100, 'Home', 'https://transfermarkt.com/a/profil/spieler/101')`,
  ).run();
  db.prepare(
    `INSERT INTO player_values (af_player_id, tm_player_id, team_id) VALUES (1, '101', 1)`,
  ).run();
  insertMatch(db, "100", "Home", "Away", "2026-08-10T10:00:00Z", "2026-08-10T10:01:00Z");
  insertTeam(db, "100", 100, "Home");
  insertPrediction(db, "100", 10, "starting", null);
  db.prepare(
    `INSERT INTO season_teams (season, team_id, name, league_id)
     VALUES (2026, 1, 'Home', 40), (2026, 2, 'Away', 40)`,
  ).run();
  db.prepare(
    `INSERT INTO fixtures (id, date, league_id, season, home_team_id, away_team_id)
     VALUES (1, '2026-08-16', 40, 2026, 1, 2)`,
  ).run();

  const result = expected11XiPredictionsForAfPlayers(40, [1], {
    now: new Date("2026-08-13T12:00:00Z"),
    database: db,
  });
  assert.equal(result.get(1)?.lineupGroup, "starting");
  assert.equal(result.get(1)?.displayedPercentage, 66);
  assert.equal(result.get(1)?.starterProbability, 0.66);
  assert.equal(result.get(1)?.influencedSelection, true);
});

function expected(group: "starting" | "bench" | "out"): Expected11XiPrediction {
  return {
    mantraPlayerId: 1,
    sourceMatchId: "1",
    sourceMatchUrl: "https://expected11.com/match/1",
    sourceMatchTitle: "A vs B",
    sourceClub: "A",
    opponent: "B",
    lineupGroup: group,
    displayedPercentage: group === "out" ? null : 60,
    starterProbability: group === "out" ? null : 0.6,
    expected11PlayerUrl: null,
    extractedAt: "2026-08-13T00:00:00Z",
    importedAt: "2026-08-13T00:01:00Z",
    updatedAt: "2026-08-13T00:01:00Z",
    kickoff: null,
    kickoffKnown: false,
    freshness: "unknown",
    provenance: "expected11",
    influencedSelection: true,
    influenceReason: group === "out" ? "out_exclusion" : "starter_probability",
    outFallback: false,
  };
}

function player(
  id: number,
  role: "GK" | "ST",
  score: number,
  e11: Expected11XiPrediction | null = null,
): RankedPlayer {
  return {
    playerId: id,
    name: `Player ${id}`,
    role,
    roleLabel: role,
    sideRole: null,
    activeRoles: [role],
    group: role === "GK" ? "GK" : "ATT",
    score,
    strength: score,
    valueScore: score,
    marketValueEur: 1_000_000,
    minutes: 900,
    rating: null,
    goals: 0,
    assists: 0,
    matchedValue: true,
    isNew: false,
    joinedAt: null,
    expected11: e11,
  };
}

test("Expected11 overrides official odds once; OUT excludes first and falls back validly", () => {
  const e11 = expected("starting");
  assert.deepEqual(
    effectiveStarterEvidence(
      { starterProbability: 0.9, reliability: "high" },
      e11,
    ),
    { probability: 0.6, reliability: "expected11", source: "expected11" },
  );
  assert.deepEqual(
    effectiveStarterEvidence(
      { starterProbability: 0.9, reliability: "high" },
      null,
    ),
    { probability: 0.9, reliability: "high", source: "official_sorare" },
  );

  const plan: FormationPlan = {
    code: "test",
    slots: [
      { id: "GK", role: "GK", label: "GK", x: 50, y: 90 },
      { id: "ST", role: "ST", label: "ST", x: 50, y: 10 },
    ],
  };
  const out = player(1, "GK", 100, expected("out"));
  const available = player(2, "GK", 50);
  const striker = player(3, "ST", 50);
  const selected = selectXiWithExpected11Availability(
    [out, available, striker],
    plan,
  );
  assert.deepEqual(selected.map((slot) => slot.starter.playerId), [2, 3]);
  assert.equal(selected.length, plan.slots.length);

  const fallback = selectXiWithExpected11Availability([out, striker], plan);
  assert.deepEqual(fallback.map((slot) => slot.starter.playerId), [1, 3]);
  assert.equal(fallback[0]?.starter.expected11?.outFallback, true);

  const deterministic = selectXiWithExpected11Availability(
    [player(5, "GK", 50), player(4, "GK", 50), striker],
    plan,
  );
  assert.equal(deterministic[0]?.starter.playerId, 4);
});

test("snapshot version changes after a manual mapping update", () => {
  const db = database();
  insertMatch(db, "1", "A", "B", "2026-08-13T00:00:00Z", "2026-08-13T00:01:00Z");
  const before = expected11SnapshotVersion(db);
  db.prepare(`INSERT INTO expected11_manual_mappings (updated_at) VALUES (?)`).run(
    "2026-08-13T00:02:00Z",
  );
  const after = expected11SnapshotVersion(db);
  assert.notEqual(after, before);
  assert.match(after!, /2026-08-13T00:02:00Z/);
});
