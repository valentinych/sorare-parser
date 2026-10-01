import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { resetComputedCacheForTests } from "../lib/computedCache.js";
import {
  aggregateMantraDomaFotmobStats,
  fotmobPositionShort,
  getMantraDomaStats,
  MANTRA_DOMA_STATS_CACHE_KEY,
} from "./mantraDomaStats.js";
import { peekComputed } from "../lib/computedCache.js";

test.afterEach(() => {
  resetComputedCacheForTests();
});

function database(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE fotmob_matches (
      id INTEGER PRIMARY KEY, league_id INTEGER, round TEXT, kickoff TEXT,
      home_id INTEGER, home_name TEXT, away_id INTEGER, away_name TEXT,
      score_home INTEGER, score_away INTEGER, phase TEXT
    );
    CREATE TABLE fotmob_match_players (
      match_id INTEGER NOT NULL, player_id INTEGER NOT NULL, name TEXT,
      team_id INTEGER, team_name TEXT, is_home INTEGER, starter INTEGER,
      position_id INTEGER, rating REAL, minutes INTEGER, goals INTEGER, assists INTEGER,
      yellow_cards INTEGER, red_cards INTEGER, own_goals INTEGER, saves INTEGER,
      goals_conceded INTEGER, penalties_won INTEGER, penalties_conceded INTEGER,
      penalties_scored INTEGER, penalties_missed INTEGER, penalties_saved INTEGER,
      PRIMARY KEY (match_id, player_id)
    );
  `);
  return db;
}

function insertMatch(
  db: Database.Database,
  id: number,
  round: string,
  kickoff: string,
  opts: { homeId?: number; awayId?: number; leagueId?: number } = {},
) {
  db.prepare(
    `INSERT INTO fotmob_matches
       (id, league_id, round, kickoff, home_id, home_name, away_id, away_name,
        score_home, score_away, phase)
     VALUES (?, ?, ?, ?, ?, 'Leeds', ?, 'Norwich', 1, 0, 'finished')`,
  ).run(id, opts.leagueId ?? 108, round, kickoff, opts.homeId ?? 7, opts.awayId ?? 8);
}

function insertPlayer(
  db: Database.Database,
  matchId: number,
  playerId: number,
  fields: {
    minutes?: number;
    starter?: number;
    rating?: number | null;
    goals?: number;
    assists?: number;
    yellow?: number;
    red?: number;
    teamId?: number;
    positionId?: number | null;
  } = {},
) {
  db.prepare(
    `INSERT INTO fotmob_match_players
       (match_id, player_id, name, team_id, team_name, is_home, starter, position_id, rating, minutes,
        goals, assists, yellow_cards, red_cards, own_goals, saves, goals_conceded,
        penalties_won, penalties_conceded, penalties_scored, penalties_missed, penalties_saved)
     VALUES (?, ?, 'P', ?, 'Leeds', 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
  ).run(
    matchId,
    playerId,
    fields.teamId ?? 7,
    fields.starter ?? 1,
    fields.positionId ?? null,
    fields.rating ?? null,
    fields.minutes ?? 0,
    fields.goals ?? 0,
    fields.assists ?? 0,
    fields.yellow ?? 0,
    fields.red ?? 0,
  );
}

function seedSeason(db: Database.Database) {
  insertMatch(db, 1, "Round 1", "2026-08-10T15:00:00Z");
  insertMatch(db, 2, "Round 2", "2026-08-17T15:00:00Z");
  insertMatch(db, 3, "Round 3", "2026-08-24T15:00:00Z");
  insertMatch(db, 4, "Round 4", "2026-08-31T15:00:00Z");

  insertPlayer(db, 1, 1001, {
    minutes: 90,
    rating: 7.0,
    goals: 1,
    assists: 1,
    yellow: 1,
    positionId: 104,
  });
  insertPlayer(db, 2, 1001, {
    minutes: 45,
    starter: 0,
    rating: 6.5,
    assists: 1,
    positionId: 65,
  });
  insertPlayer(db, 3, 2000, { minutes: 90, rating: 6.0, teamId: 8 });
  insertPlayer(db, 4, 1001, {
    minutes: 90,
    rating: 7.4,
    goals: 1,
    red: 1,
    positionId: 104,
  });
}

test("aggregates minutes, assists, cards and skips missing players", () => {
  const db = database();
  seedSeason(db);
  const now = new Date("2026-09-23T12:00:00Z");
  const stats = aggregateMantraDomaFotmobStats(db, now, [1001, 9999]);

  assert.equal(stats["9999"], undefined);

  const row = stats["1001"];
  assert.ok(row);
  assert.equal(row.min, 225);
  assert.deepEqual(row.bars, [90, 45, 0, 90]);
  assert.deepEqual(row.rnd, [1, 2, 3, 4]);
  assert.equal(row.g, 2);
  assert.equal(row.a, 2);
  assert.equal(row.y, 1);
  assert.equal(row.red, 1);
  assert.equal(row.apps, 3);
  assert.equal(row.st, 2);
  assert.equal(row.rating, 7);
  assert.equal(row.last5, 7);
  assert.equal(row.pos, "ST");
  assert.equal(row.rounds.length, 4);
  assert.equal(row.rounds[2]?.round, 3);
  assert.equal(row.rounds[2]?.minutes, null);
  assert.equal(row.rounds[0]?.minutes, 90);
  assert.equal(row.rounds[0]?.pos, "ST");
  assert.equal(row.rounds[1]?.pos, "DM");
  assert.equal(row.rounds[1]?.minutes, 45);
  assert.equal(row.rounds[3]?.pos, "ST");
});

test("zero minutes and missing sheet are DNP null, not 0", () => {
  const db = database();
  insertMatch(db, 1, "Round 1", "2026-08-10T15:00:00Z");
  insertMatch(db, 2, "Round 2", "2026-08-17T15:00:00Z");
  insertPlayer(db, 1, 1001, { minutes: 0, rating: null, positionId: 70 });
  insertPlayer(db, 2, 2000, { minutes: 90, rating: 6.0, teamId: 8 });
  const stats = aggregateMantraDomaFotmobStats(db, new Date("2026-09-23T12:00:00Z"), [1001]);
  const row = stats["1001"];
  assert.ok(row);
  assert.equal(row.min, 0);
  assert.equal(row.rounds[0]?.minutes, null);
  assert.equal(row.rounds[1]?.minutes, null);
  assert.equal(row.pos, null);
});

test("fotmobPositionShort maps lineup position_id", () => {
  assert.equal(fotmobPositionShort(104), "ST");
  assert.equal(fotmobPositionShort(65), "DM");
  assert.equal(fotmobPositionShort(11), "GK");
  assert.equal(fotmobPositionShort(33), "CB");
  assert.equal(fotmobPositionShort(88), "W");
  assert.equal(fotmobPositionShort(999), null);
  assert.equal(fotmobPositionShort(null), null);
});

test("getMantraDomaStats caches under mantra-doma:stats", () => {
  const db = database();
  seedSeason(db);
  const now = new Date("2026-09-23T12:00:00Z");
  const first = getMantraDomaStats({ database: db, now });
  assert.equal(first.ok, true);
  assert.equal(first.source, "fotmob");
  assert.equal(first.leagueId, 108);
  assert.deepEqual(first.tours, [1, 2, 3, 4]);
  assert.equal(first.players["1001"]?.min, 225);
  assert.equal(first.players["1001"]?.pos, "ST");
  assert.equal(first.players["1001"]?.rounds[2]?.minutes, null);
  assert.ok(peekComputed(MANTRA_DOMA_STATS_CACHE_KEY));

  db.prepare(`UPDATE fotmob_match_players SET minutes = 10 WHERE player_id = 1001 AND match_id = 1`).run();
  const cached = getMantraDomaStats({ database: db, now });
  assert.equal(cached.players["1001"]?.min, 225);
});

test("tours include kicked-off upcoming fixtures even without player sheets", () => {
  const db = database();
  seedSeason(db);
  insertMatch(db, 5, "5", "2026-09-06T14:00:00Z");
  db.prepare(`UPDATE fotmob_matches SET phase = 'upcoming' WHERE id = 5`).run();
  insertMatch(db, 6, "6", "2026-09-12T14:00:00Z");
  db.prepare(`UPDATE fotmob_matches SET phase = 'upcoming' WHERE id = 6`).run();
  insertMatch(db, 7, "7", "2026-09-19T14:00:00Z");
  db.prepare(`UPDATE fotmob_matches SET phase = 'upcoming' WHERE id = 7`).run();
  insertMatch(db, 8, "8", "2026-09-26T14:00:00Z");
  db.prepare(`UPDATE fotmob_matches SET phase = 'upcoming' WHERE id = 8`).run();

  const now = new Date("2026-09-23T12:00:00Z");
  const view = getMantraDomaStats({ database: db, now });
  assert.deepEqual(view.tours, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(view.players["1001"]?.rounds.length, 4);
  assert.equal(
    view.players["1001"]?.rounds.filter((cell) => cell.round === 7).length,
    0,
  );
});
