import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { resetComputedCacheForTests } from "../lib/computedCache.js";
import {
  ensureManagerPremiumSquads,
  resetManagerPremiumSquadsForTests,
  type PremiumSquadsClient,
} from "./syncManagerPremiumSquads.js";

test.afterEach(() => {
  resetComputedCacheForTests();
  resetManagerPremiumSquadsForTests();
});

function database() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE mantra_leagues (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, division TEXT,
      tournament_id INTEGER, synced_at TEXT
    );
    CREATE TABLE mantra_fantasy_teams (
      id INTEGER PRIMARY KEY, league_id INTEGER, tournament_id INTEGER,
      user_id INTEGER, name TEXT, players_json TEXT, code TEXT,
      logo_path TEXT, budget REAL, synced_at TEXT
    );
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, first_name TEXT,
      full_name TEXT, positions_json TEXT, club_id INTEGER, club_name TEXT,
      tournament_id INTEGER
    );
  `);
  return db;
}

function listPlayer(row: {
  id: number;
  name: string;
  clubId: number;
  clubName: string;
  firstName?: string | null;
}): import("../clients/mantra.js").MantraListPlayer {
  return {
    id: row.id,
    name: row.name,
    firstName: row.firstName ?? null,
    positions: ["ST"],
    positionsItal: [],
    clubId: row.clubId,
    clubName: row.clubName,
    clubCode: null,
    clubLogo: null,
    clubTmUrl: null,
    avatarPath: null,
    baseScore: 0,
    totalScore: 0,
    appearances: 0,
    averagePrice: null,
    leagues: [],
    teamsCount: 0,
  };
}

function client(opts: {
  teams?: Map<number, { id: number; name: string; leagueId: number; userId: number; playerIds: number[] }>;
  leagueTeams?: Map<number, Array<{ id: number; name: string; logoPath: string | null }>>;
  playersByTournament?: Map<number, Array<ReturnType<typeof listPlayer>>>;
  profiles?: Map<number, ReturnType<typeof listPlayer>>;
}): PremiumSquadsClient & {
  teamFetches: number[];
  leagueFetches: number[];
  listFetches: number[];
  profileFetches: number[];
} {
  const teamFetches: number[] = [];
  const leagueFetches: number[] = [];
  const listFetches: number[] = [];
  const profileFetches: number[] = [];
  return {
    teamFetches,
    leagueFetches,
    listFetches,
    profileFetches,
    fetchLeagueTeams: async (leagueId) => {
      leagueFetches.push(leagueId);
      return opts.leagueTeams?.get(leagueId) ?? [];
    },
    fetchFantasyTeam: async (teamId) => {
      teamFetches.push(teamId);
      const team = opts.teams?.get(teamId);
      if (!team) throw new Error(`missing team ${teamId}`);
      return {
        id: team.id,
        name: team.name,
        logoPath: null,
        code: "X",
        leagueId: team.leagueId,
        userId: team.userId,
        budget: 1,
        playerIds: team.playerIds,
      };
    },
    fetchAllMantraPlayers: opts.playersByTournament
      ? async (tournamentId) => {
          listFetches.push(tournamentId);
          return opts.playersByTournament?.get(tournamentId) ?? [];
        }
      : undefined,
    fetchMantraProfile: opts.profiles
      ? async (playerId) => {
          profileFetches.push(playerId);
          const player = opts.profiles?.get(playerId);
          if (!player) throw new Error(`missing profile ${playerId}`);
          return {
            ...player,
            tmUrl: null,
            tmPrice: null,
            birthDate: null,
            age: null,
            height: null,
            nationality: null,
            number: null,
          };
        }
      : undefined,
  };
}

test("first load uses SQLite squads and does not hit Mantra", async () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (5009, 786, 2, 205, 'Loch Ness F.C.', '[1,2]')`,
  ).run();
  const api = client({});
  const first = await ensureManagerPremiumSquads(205, { database: db, client: api });
  const second = await ensureManagerPremiumSquads(205, { database: db, client: api });
  assert.equal(first.fetched, false);
  assert.equal(first.teams, 1);
  assert.equal(second.fetched, false);
  assert.deepEqual(api.teamFetches, []);
  assert.deepEqual(api.leagueFetches, []);
});

test("empty cache fetches this manager once, then stays cached", async () => {
  const db = database();
  const api = client({
    leagueTeams: new Map([
      [786, [{ id: 5009, name: "Loch Ness F.C.", logoPath: null }]],
    ]),
    teams: new Map([
      [
        5009,
        { id: 5009, name: "Loch Ness F.C.", leagueId: 786, userId: 205, playerIds: [491, 1758] },
      ],
    ]),
  });
  const first = await ensureManagerPremiumSquads(205, { database: db, client: api });
  const teamFetchesAfterFirst = api.teamFetches.length;
  const second = await ensureManagerPremiumSquads(205, { database: db, client: api });
  assert.equal(first.fetched, true);
  assert.equal(first.teams, 1);
  assert.equal(second.fetched, false);
  assert.equal(api.teamFetches.length, teamFetchesAfterFirst);
  assert.ok(api.teamFetches.includes(5009));
  const row = db
    .prepare(`SELECT user_id AS userId, players_json AS players FROM mantra_fantasy_teams WHERE id = 5009`)
    .get() as { userId: number; players: string };
  assert.equal(row.userId, 205);
  assert.equal(row.players, "[491,1758]");
});

test("refresh re-fetches this manager squad and does not adopt another manager", async () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_leagues (id, name, tournament_id) VALUES (786, 'Bournemouth', 2)`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (5009, 786, 2, 205, 'Loch Ness F.C.', '[]'),
            (1925, 786, 2, 1, 'Other', '[9]')`,
  ).run();
  const api = client({
    teams: new Map([
      [5009, { id: 5009, name: "Loch Ness F.C.", leagueId: 786, userId: 205, playerIds: [491] }],
    ]),
    leagueTeams: new Map([
      [
        786,
        [
          { id: 5009, name: "Loch Ness F.C.", logoPath: null },
          { id: 1925, name: "Other", logoPath: null },
        ],
      ],
    ]),
  });
  const refresh = await ensureManagerPremiumSquads(205, {
    force: true,
    database: db,
    client: api,
  });
  assert.equal(refresh.fetched, true);
  assert.deepEqual(api.teamFetches, [5009]);
  const mine = db
    .prepare(`SELECT players_json AS players FROM mantra_fantasy_teams WHERE id = 5009`)
    .get() as { players: string };
  const other = db
    .prepare(`SELECT user_id AS userId, players_json AS players FROM mantra_fantasy_teams WHERE id = 1925`)
    .get() as { userId: number; players: string };
  assert.equal(mine.players, "[491]");
  assert.equal(other.userId, 1);
  assert.equal(other.players, "[9]");
});

test("refresh ingests Mantra club names and missing squad profiles", async () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_leagues (id, name, tournament_id) VALUES (658, 'Istanbul', 21)`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (9, 658, 21, 205, 'Lochnespor', '[30,99]')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_players (id, name, first_name, full_name, club_id, club_name, tournament_id)
     VALUES (30, 'Muldur', 'Mert', 'Mert Muldur', 375, 'Fenerbahce', 21)`,
  ).run();
  const api = client({
    teams: new Map([
      [9, { id: 9, name: "Lochnespor", leagueId: 658, userId: 205, playerIds: [30, 99] }],
    ]),
    playersByTournament: new Map([
      [
        21,
        [
          listPlayer({
            id: 30,
            name: "Muldur",
            firstName: "Mert",
            clubId: 414,
            clubName: "Eyüp Spor Kulübü",
          }),
        ],
      ],
    ]),
    profiles: new Map([
      [
        99,
        listPlayer({
          id: 99,
          name: "Osimhen",
          firstName: "Victor",
          clubId: 253,
          clubName: "Galatasaray SK",
        }),
      ],
    ]),
  });
  await ensureManagerPremiumSquads(205, { force: true, database: db, client: api });
  assert.deepEqual(api.listFetches, [21]);
  assert.deepEqual(api.profileFetches, [99]);
  const muldur = db
    .prepare(`SELECT club_id AS clubId, club_name AS clubName FROM mantra_players WHERE id = 30`)
    .get() as { clubId: number; clubName: string };
  const osimhen = db
    .prepare(`SELECT club_id AS clubId, club_name AS clubName, tournament_id AS tournamentId FROM mantra_players WHERE id = 99`)
    .get() as { clubId: number; clubName: string; tournamentId: number };
  assert.equal(muldur.clubId, 414);
  assert.equal(muldur.clubName, "Eyüp Spor Kulübü");
  assert.equal(osimhen.clubId, 253);
  assert.equal(osimhen.clubName, "Galatasaray SK");
  assert.equal(osimhen.tournamentId, 21);
});

test("cached premium load does not pull Mantra club names", async () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams (id, league_id, tournament_id, user_id, name, players_json)
     VALUES (9, 658, 21, 205, 'Lochnespor', '[30]')`,
  ).run();
  const api = client({
    playersByTournament: new Map([[21, []]]),
    profiles: new Map(),
  });
  const first = await ensureManagerPremiumSquads(205, { database: db, client: api });
  assert.equal(first.fetched, false);
  assert.deepEqual(api.listFetches, []);
  assert.deepEqual(api.profileFetches, []);
});
