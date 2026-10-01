import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { writeComputed, resetComputedCacheForTests } from "../lib/computedCache.js";
import { resetMantraStandingsCacheForTests } from "./mantraStandings.js";
import { readFile } from "node:fs/promises";
import {
  aggregateManagerRow,
  getManagersStandings,
  groupTeamsByManager,
  managerKey,
  parseManagerNicknameHtml,
  playedMatches,
  perMatchAvg,
  perMatchTimes100,
  MANAGERS_PER100_KEYS,
  syncManagerNicknames,
  upsertManagerNickname,
  type ManagerTeamRow,
} from "./mantraManagers.js";

function team(overrides: Partial<ManagerTeamRow> = {}): ManagerTeamRow {
  return {
    managerId: "u:1",
    teamId: 1,
    teamName: "Alpha",
    teamLogo: null,
    leagueSlug: "championship",
    leagueName: "Championship",
    flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
    division: "C1",
    divisionRank: 2,
    games: 10,
    wins: 5,
    draws: 2,
    loses: 3,
    gf: 12,
    ga: 9,
    gd: 3,
    points: 17,
    ts: 100,
    idealTs: 110,
    idealPct: 90.91,
    iGf: 14,
    iGa: 8,
    iGd: 6,
    iPts: 20,
    form: ["W", "D", "L"],
    idealRank: 3,
    idealGames: 10,
    idealWins: 6,
    idealDraws: 1,
    idealLoses: 3,
    idealAvgTs: 11,
    idealForm: ["W", "W", "L"],
    ...overrides,
  };
}

test.afterEach(() => {
  resetMantraStandingsCacheForTests();
  resetComputedCacheForTests();
});

test("perMatchAvg is sum/games without rounding", () => {
  assert.equal(perMatchAvg(16, 7), 16 / 7);
  assert.equal(perMatchAvg(10, 3), 10 / 3);
  assert.equal(perMatchAvg(148, 16), 9.25);
  assert.equal(perMatchAvg(29, 16), 1.8125);
  assert.equal(perMatchAvg(5, 16), 0.3125);
  assert.equal(perMatchAvg(9, 11), 9 / 11);
  assert.equal(perMatchAvg(0, 0), null);
});

test("perMatchTimes100 shows per-match averages on 100 matches, hundredths", () => {
  assert.equal(perMatchTimes100(1.5), 150);
  assert.equal(perMatchTimes100(1.5)?.toFixed(2), "150.00");
  assert.equal(perMatchTimes100(0.5), 50);
  assert.equal(perMatchTimes100(5 / 16)?.toFixed(2), "31.25");
  assert.equal(perMatchTimes100(9 / 11)?.toFixed(2), "81.82");
  assert.equal(perMatchTimes100(null), null);
  const row = aggregateManagerRow([
    team({
      games: 10,
      wins: 6,
      draws: 2,
      loses: 2,
      gf: 20,
      ga: 10,
      gd: 10,
      points: 20,
      ts: 100,
      idealTs: 110,
      iGf: 22,
      iGa: 8,
      iGd: 14,
      iPts: 24,
    }),
    team({
      teamId: 2,
      games: 6,
      wins: 2,
      draws: 3,
      loses: 1,
      gf: 9,
      ga: 7,
      gd: 2,
      points: 9,
      ts: 48,
      idealTs: 60,
      iGf: 10,
      iGa: 6,
      iGd: 4,
      iPts: 12,
    }),
  ]);
  assert.ok(row);
  assert.equal(row.games, 16);
  assert.equal(row.wins, 0.5);
  assert.equal(perMatchTimes100(row.wins)?.toFixed(2), "50.00");
  assert.equal(row.draws, 5 / 16);
  assert.equal(perMatchTimes100(row.draws)?.toFixed(2), "31.25");
  assert.equal(perMatchTimes100(row.points)?.toFixed(2), "181.25");
  assert.equal(perMatchTimes100(row.ptsDiff)?.toFixed(2), "-43.75");
  assert.equal(row.ts, 9.25);
  assert.equal(row.idealTs, 10.63);
  assert.equal(row.idealPct, 87.06);
  assert.equal(row.games, 16);
  assert.equal(row.clubs, 2);
  for (const key of MANAGERS_PER100_KEYS) {
    assert.notEqual(key, "games");
    assert.notEqual(key, "clubs");
    assert.notEqual(key, "ts");
    assert.notEqual(key, "idealTs");
    assert.notEqual(key, "idealPct");
  }
});

test("manager with two clubs weights by played matches (sum then divide)", () => {
  const a = team({
    teamId: 1,
    teamName: "Alpha",
    games: 10,
    wins: 6,
    draws: 2,
    loses: 2,
    gf: 20,
    ga: 10,
    gd: 10,
    points: 20,
    ts: 100,
    idealTs: 110,
    iGf: 22,
    iGa: 8,
    iGd: 14,
    iPts: 24,
  });
  const b = team({
    teamId: 2,
    teamName: "Beta",
    leagueSlug: "ligue-1",
    leagueName: "Ligue 1",
    flag: "🇫🇷",
    division: "C1",
    games: 6,
    wins: 2,
    draws: 3,
    loses: 1,
    gf: 9,
    ga: 7,
    gd: 2,
    points: 9,
    ts: 48,
    idealTs: 60,
    iGf: 10,
    iGa: 6,
    iGd: 4,
    iPts: 12,
  });
  const row = aggregateManagerRow([a, b]);
  assert.ok(row);
  assert.equal(row.games, 16);
  assert.equal(row.wins, 0.5);
  assert.equal(row.draws, 5 / 16);
  assert.equal(row.loses, 3 / 16);
  assert.equal(row.gf, 29 / 16);
  assert.equal(row.ga, 17 / 16);
  assert.equal(row.gd, 0.75);
  assert.equal(row.points, 29 / 16);
  assert.equal(row.ts, 9.25);
  assert.equal(row.idealTs, 10.63);
  assert.equal(row.iPts, 2.25);
  assert.equal(row.ptsDiff, 29 / 16 - 2.25);
  assert.equal(row.idealPct, 87.06);
  assert.deepEqual(row.teamIds, [1, 2]);
  assert.equal(row.clubs, 2);
});

test("9 wins in 11 games is 81.82 per 100, not rounded to 82.00", () => {
  const row = aggregateManagerRow([
    team({
      games: 11,
      wins: 9,
      draws: 1,
      loses: 1,
      points: 28,
      ts: 99,
      idealTs: null,
      iPts: null,
    }),
  ]);
  assert.ok(row);
  assert.equal(row.wins, 9 / 11);
  assert.equal(perMatchTimes100(row.wins)?.toFixed(2), "81.82");
  assert.notEqual(perMatchTimes100(row.wins)?.toFixed(2), "82.00");
});

test("manager club count is a headcount of cached fantasy teams", () => {
  const two = aggregateManagerRow([
    team({ teamId: 1 }),
    team({ teamId: 2, leagueSlug: "ligue-1" }),
  ]);
  const one = aggregateManagerRow([team({ teamId: 9, managerId: "u:9" })]);
  assert.ok(two);
  assert.ok(one);
  assert.equal(two.clubs, 2);
  assert.equal(one.clubs, 1);
  assert.ok(!(MANAGERS_PER100_KEYS as readonly string[]).includes("clubs"));
});

test("% vs ideal is sum TS / sum IdealTS, not an average of percents", () => {
  const a = team({ games: 10, ts: 100, idealTs: 110, idealPct: 90.91 });
  const b = team({
    teamId: 2,
    games: 6,
    ts: 48,
    idealTs: 60,
    idealPct: 80,
  });
  const row = aggregateManagerRow([a, b]);
  assert.equal(row?.idealPct, 87.06);
  assert.notEqual(row?.idealPct, 85.46);
});

test("missing Ideal is dash, not 0, and does not dilute the other club", () => {
  const withIdeal = team({
    games: 10,
    ts: 100,
    points: 20,
    idealTs: 110,
    iGf: 14,
    iGa: 8,
    iGd: 6,
    iPts: 24,
  });
  const missing = team({
    teamId: 2,
    teamName: "Beta",
    games: 6,
    ts: 48,
    points: 9,
    idealTs: null,
    idealPct: null,
    iGf: null,
    iGa: null,
    iGd: null,
    iPts: null,
  });
  const row = aggregateManagerRow([withIdeal, missing]);
  assert.equal(row?.games, 16);
  assert.equal(row?.points, 29 / 16);
  assert.equal(row?.ts, 9.25);
  assert.equal(row?.idealTs, 11);
  assert.equal(row?.iPts, 2.4);
  assert.equal(row?.idealPct, 90.91);
  assert.equal(row?.ptsDiff, 29 / 16 - 2.4);
  const none = aggregateManagerRow([missing]);
  assert.equal(none?.idealTs, null);
  assert.equal(none?.iPts, null);
  assert.equal(none?.idealPct, null);
  assert.equal(none?.ptsDiff, null);
});

test("no Ideal → dash for Ideal TS, i*, %, not 0", () => {
  const row = aggregateManagerRow([
    team({
      games: 4,
      ts: 336,
      points: 12,
      idealTs: null,
      idealPct: null,
      iGf: 0,
      iGa: 0,
      iGd: 0,
      iPts: 4,
      idealGames: 4,
      idealAvgTs: null,
    }),
  ]);
  assert.equal(row?.games, 4);
  assert.equal(row?.ts, 84);
  assert.equal(row?.idealTs, null);
  assert.equal(row?.iGf, null);
  assert.equal(row?.iGa, null);
  assert.equal(row?.iGd, null);
  assert.equal(row?.iPts, null);
  assert.equal(row?.idealPct, null);
  assert.equal(row?.ptsDiff, null);
});

test("zeros on a club without Ideal do not dilute paired i* or %", () => {
  const withIdeal = team({
    games: 10,
    ts: 100,
    points: 20,
    idealTs: 110,
    idealGames: 10,
    idealAvgTs: 11,
    iGf: 14,
    iGa: 8,
    iGd: 6,
    iPts: 24,
  });
  const fakeZeros = team({
    teamId: 2,
    teamName: "Beta",
    games: 6,
    ts: 48,
    points: 9,
    idealTs: null,
    idealPct: null,
    iGf: 0,
    iGa: 0,
    iGd: 0,
    iPts: 0,
  });
  const row = aggregateManagerRow([withIdeal, fakeZeros]);
  assert.equal(row?.idealPct, 90.91);
  assert.equal(row?.idealTs, 11);
  assert.equal(row?.iPts, 2.4);
  assert.equal(row?.iGf, 1.4);
});

test("Ideal covering fewer GWs than real TS does not inflate % over 100", () => {
  const row = aggregateManagerRow([
    team({
      games: 11,
      ts: 872.85,
      points: 20,
      idealTs: 589.71,
      idealGames: 7,
      idealAvgTs: 84.24,
      iGf: 10,
      iPts: 14,
    }),
  ]);
  assert.equal(row?.ts, 79.35);
  assert.equal(row?.idealTs, 84.24);
  assert.equal(row?.idealPct, 94.19);
  assert.ok((row?.idealPct ?? 0) <= 100);
});

test("incomplete Ideal (real TS beats Ideal on that window) is treated as missing", () => {
  const row = aggregateManagerRow([
    team({
      games: 10,
      ts: 110,
      idealTs: 100,
      idealGames: 10,
      idealAvgTs: 10,
      iGf: 8,
      iPts: 12,
    }),
  ]);
  assert.equal(row?.idealTs, null);
  assert.equal(row?.idealPct, null);
  assert.equal(row?.iPts, null);
  assert.equal(row?.ptsDiff, null);
});

test("broken extra-league Ideal is dropped; % uses only clubs whose Ideal covers real TS", () => {
  const brokenLaLiga = team({
    teamName: "Кролики",
    leagueSlug: "la-liga",
    leagueName: "La Liga",
    games: 6,
    ts: 462.8,
    idealTs: 147.35,
    idealGames: 5,
    idealAvgTs: 29.47,
    idealPct: 314.08,
    iGf: 0,
    iPts: 2,
    points: 6,
  });
  const goodPl = team({
    teamId: 2,
    teamName: "Golden Whisky United",
    leagueSlug: "premier-league",
    leagueName: "Premier League",
    games: 5,
    ts: 410,
    idealTs: 442.31,
    idealGames: 5,
    idealAvgTs: 88.46,
    idealPct: 92.7,
    iGf: 14,
    iPts: 6,
    points: 8,
  });
  const row = aggregateManagerRow([brokenLaLiga, goodPl]);
  assert.equal(row?.games, 11);
  assert.equal(row?.ts, 79.35);
  assert.equal(row?.idealTs, 88.46);
  assert.equal(row?.idealPct, 92.7);
  assert.ok((row?.idealPct ?? 0) <= 100);
  const onlyBroken = aggregateManagerRow([brokenLaLiga]);
  assert.equal(onlyBroken?.idealTs, null);
  assert.equal(onlyBroken?.idealPct, null);
  assert.equal(onlyBroken?.iGf, null);
});

test("groupTeamsByManager merges clubs that share a user id", () => {
  const rows = groupTeamsByManager([
    team({ managerId: "u:7", teamId: 1, teamName: "One", games: 8, points: 16, ts: 80 }),
    team({ managerId: "u:7", teamId: 2, teamName: "Two", games: 4, points: 4, ts: 32 }),
    team({ managerId: "t:9", teamId: 9, teamName: "Solo", games: 5, points: 15, ts: 50 }),
  ]);
  assert.equal(rows.length, 2);
  const merged = rows.find((row) => row.managerId === "u:7");
  assert.equal(merged?.games, 12);
  assert.equal(merged?.points, 20 / 12);
  assert.deepEqual(merged?.teamIds.slice().sort((a, b) => a - b), [1, 2]);
});

test("getManagersStandings peeks extra leagues and does not fetch Mantra", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE computed_cache (
    key TEXT PRIMARY KEY, version TEXT NOT NULL, body_json TEXT NOT NULL, built_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE mantra_fantasy_teams (
    id INTEGER PRIMARY KEY, league_id INTEGER, user_id INTEGER, name TEXT, players_json TEXT
  )`);
  db.exec(`INSERT INTO mantra_fantasy_teams (id, league_id, user_id, name, players_json)
    VALUES (101, 651, 77, 'Alpha', '[]'), (201, 738, 77, 'Alpha FR', '[]'), (301, 732, 88, 'Other', '[]')`);

  function snapshot(
    slug: string,
    name: string,
    rows: Array<{
      teamId: number;
      teamName: string;
      division: string;
      leagueId: number;
      games: number;
      points: number;
      ts: number;
    }>,
  ) {
    writeComputed(
      `mantra-standings:v3:${slug}`,
      "v1",
      {
        fetchedAt: "2026-09-24T10:00:00.000Z",
        view: {
          ok: true,
          empty: false,
          league: slug,
          name,
          fetchedAt: "2026-09-24T10:00:00.000Z",
          divisions: 1,
          teams: rows.length,
          failedDivisions: [],
          rows: rows.map((row, index) => ({
            rank: index + 1,
            divisionRank: 4,
            movement: 0,
            teamId: row.teamId,
            teamName: row.teamName,
            teamLogo: null,
            division: row.division,
            leagueId: row.leagueId,
            leagueName: row.division,
            games: row.games,
            wins: row.games,
            draws: 0,
            loses: 0,
            gf: 8,
            ga: 5,
            gd: 3,
            points: row.points,
            ts: row.ts,
            form: [],
            nextTeamId: null,
            nextTeamName: null,
            nextTeamLogo: null,
            idealTs: null,
            idealPct: null,
            iGf: null,
            iGa: null,
            iGd: null,
            iPts: null,
          })),
          idealRounds: [],
        },
      },
      { database: db },
    );
  }

  snapshot("championship", "Championship", [
    {
      teamId: 101,
      teamName: "Alpha",
      division: "C1",
      leagueId: 651,
      games: 8,
      points: 16,
      ts: 80,
    },
  ]);
  snapshot("ligue-1", "Ligue 1", [
    {
      teamId: 201,
      teamName: "Alpha FR",
      division: "C1",
      leagueId: 738,
      games: 6,
      points: 9,
      ts: 48,
    },
    {
      teamId: 301,
      teamName: "Other",
      division: "A1",
      leagueId: 732,
      games: 6,
      points: 12,
      ts: 54,
    },
  ]);

  const view = getManagersStandings({ database: db });
  assert.equal(view.league, "managers");
  assert.equal(view.cache, "stale");
  const alpha = view.rows.find((row) => row.managerId === "u:77");
  assert.ok(alpha);
  assert.equal(alpha.games, 14);
  assert.equal(alpha.points, 25 / 14);
  assert.equal(alpha.teams.length, 2);
  assert.equal(alpha.clubs, 2);
  assert.ok(alpha.teams.some((item) => item.leagueSlug === "ligue-1"));
  assert.ok(alpha.teams.some((item) => item.flag === "🇫🇷"));
  assert.ok(view.leagues.some((item) => item.slug === "managers"));
  assert.ok(view.leagues.some((item) => item.slug === "brasileirao"));
  assert.equal(managerKey(77, 101), "u:77");

  const persisted = db.prepare(`SELECT COUNT(*) AS n FROM mantra_table_rows`).get() as {
    n: number;
  };
  assert.equal(persisted.n, 3);
});

test("parseManagerNicknameHtml reads Valentinych from the profile page", () => {
  const html = `<div class="manager-data"><div class="manager-name">Valentinych</div></div>`;
  assert.equal(parseManagerNicknameHtml(html), "Valentinych");
  assert.equal(parseManagerNicknameHtml(`<form id="new_user"><input name="user[password]"></form>`), null);
});

test("playedMatches prefers W+D+L over the games column", () => {
  assert.equal(playedMatches({ wins: 3, draws: 1, loses: 2, games: 9 }), 6);
  assert.equal(playedMatches({ wins: 0, draws: 0, loses: 0, games: 8 }), 8);
});

test("stored Mantra nickname wins over fantasy team name", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE computed_cache (
    key TEXT PRIMARY KEY, version TEXT NOT NULL, body_json TEXT NOT NULL, built_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE mantra_fantasy_teams (
    id INTEGER PRIMARY KEY, league_id INTEGER, user_id INTEGER, name TEXT, players_json TEXT
  )`);
  db.exec(`INSERT INTO mantra_fantasy_teams (id, league_id, user_id, name, players_json)
    VALUES (101, 651, 205, 'Some Club Name', '[]')`);
  upsertManagerNickname(db, 205, "Valentinych");
  writeComputed(
    "mantra-standings:v3:championship",
    "v1",
    {
      fetchedAt: "2026-09-24T10:00:00.000Z",
      view: {
        ok: true,
        empty: false,
        league: "championship",
        name: "Championship",
        fetchedAt: "2026-09-24T10:00:00.000Z",
        divisions: 1,
        teams: 1,
        failedDivisions: [],
        rows: [
          {
            rank: 1,
            divisionRank: 4,
            movement: 0,
            teamId: 101,
            teamName: "Some Club Name",
            teamLogo: null,
            division: "C1",
            leagueId: 651,
            leagueName: "C1",
            games: 7,
            wins: 4,
            draws: 1,
            loses: 2,
            gf: 8,
            ga: 5,
            gd: 3,
            points: 13,
            ts: 70,
            form: [],
            nextTeamId: null,
            nextTeamName: null,
            nextTeamLogo: null,
            idealTs: null,
            idealPct: null,
            iGf: null,
            iGa: null,
            iGd: null,
            iPts: null,
          },
        ],
        idealRounds: [],
      },
    },
    { database: db },
  );
  const view = getManagersStandings({ database: db });
  const row = view.rows.find((item) => item.managerId === "u:205");
  assert.ok(row);
  assert.equal(row.managerName, "Valentinych");
  assert.equal(row.games, 7);
});

test("syncManagerNicknames stores profiles and does not refetch cached ids", async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE mantra_fantasy_teams (
    id INTEGER PRIMARY KEY, league_id INTEGER, user_id INTEGER, name TEXT, players_json TEXT
  )`);
  db.exec(`INSERT INTO mantra_fantasy_teams (id, league_id, user_id, name, players_json)
    VALUES (1, 651, 205, 'A', '[]'), (2, 738, 9, 'B', '[]')`);
  const seen: number[] = [];
  const n = await syncManagerNicknames({
    database: db,
    fetchNickname: async (id) => {
      seen.push(id);
      return id === 205 ? "Valentinych" : `user-${id}`;
    },
  });
  assert.equal(n, 2);
  assert.deepEqual(seen, [9, 205]);
  const again: number[] = [];
  const second = await syncManagerNicknames({
    database: db,
    fetchNickname: async (id) => {
      again.push(id);
      return "nope";
    },
  });
  assert.equal(second, 0);
  assert.deepEqual(again, []);
  const stored = db
    .prepare(`SELECT nickname FROM mantra_managers WHERE id = 205`)
    .get() as { nickname: string };
  assert.equal(stored.nickname, "Valentinych");
});

test("GET managers path does not import the signed-in Mantra client", async () => {
  const src = await readFile(new URL("./mantraManagers.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /mantraAuth/);
  assert.doesNotMatch(src, /fetchMantraManagerHtml/);
  const route = await readFile(new URL("../routes/mantraStandings.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /syncManagerNicknames|fetchMantraManagerHtml/);
});
