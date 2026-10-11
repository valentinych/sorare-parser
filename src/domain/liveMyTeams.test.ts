import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  LIVE_MY_TEAMS_NEED_ID,
  LIVE_MY_TEAMS_SIGN_IN,
  buildLiveMyTeams,
  classifyLiveMyTeamPlayer,
  formatLiveMyTeamScore,
  liveMyTeamChip,
  liveMyTeamMatchFinished,
  liveMyTeamMatchLive,
  liveMyTeamMatchStarted,
  mantraRosterSigma,
} from "./liveMyTeams.js";

test("classifies live, xi, and bench without inventing a lineup", () => {
  assert.equal(
    classifyLiveMyTeamPlayer({ inLineup: true, starter: true, matchLive: true, cameOn: false }),
    "live",
  );
  assert.equal(
    classifyLiveMyTeamPlayer({ inLineup: true, starter: false, matchLive: true, cameOn: true }),
    "live",
    "a sub who came on in a live match stays in LIVE",
  );
  assert.equal(
    classifyLiveMyTeamPlayer({ inLineup: true, starter: false, matchLive: true, cameOn: false }),
    "bench",
  );
  assert.equal(
    classifyLiveMyTeamPlayer({ inLineup: true, starter: true, matchLive: false, cameOn: false }),
    "xi",
    "starters who are not in a live match go to XI",
  );
  assert.equal(
    classifyLiveMyTeamPlayer({ inLineup: true, starter: false, matchLive: false, cameOn: true }),
    "bench",
    "a sub in a finished match stays on the bench column",
  );
  assert.equal(
    classifyLiveMyTeamPlayer({ inLineup: true, starter: false, matchLive: false, cameOn: true }),
    "bench",
    "NS/TBD bench stays on the bench even if a sub event is present",
  );
  assert.equal(
    classifyLiveMyTeamPlayer({ inLineup: false, starter: true, matchLive: true, cameOn: false }),
    null,
  );
  assert.equal(liveMyTeamMatchLive("live", "NS"), false);
  assert.equal(liveMyTeamMatchLive("upcoming", "TBD"), false);
  assert.equal(liveMyTeamMatchLive("live", "1H"), true);
  assert.equal(liveMyTeamMatchLive("live", "HT"), true);
  assert.equal(liveMyTeamMatchLive("live", "2H"), true);
  assert.equal(liveMyTeamMatchLive("live", "ET"), true);
  assert.equal(liveMyTeamMatchLive("live", "P"), true);
  assert.equal(liveMyTeamMatchLive("finished", "FT"), false);
  assert.equal(liveMyTeamMatchStarted("live", "NS"), false);
  assert.equal(liveMyTeamMatchStarted("finished", "FT"), true);
  assert.equal(liveMyTeamMatchFinished("finished", "FT"), true);
  assert.equal(liveMyTeamMatchFinished("live", "1H"), false);
});

test("score chip has four visual states", () => {
  assert.equal(
    liveMyTeamChip({ group: "xi", matchStarted: false, matchFinished: false, appeared: false }),
    "pending",
  );
  assert.equal(
    liveMyTeamChip({ group: "bench", matchStarted: false, matchFinished: false, appeared: false }),
    "pending",
  );
  assert.equal(
    liveMyTeamChip({ group: "bench", matchStarted: true, matchFinished: false, appeared: false }),
    "pending",
    "unused bench of a live match can still come on",
  );
  assert.equal(
    liveMyTeamChip({ group: "bench", matchStarted: true, matchFinished: true, appeared: false }),
    "unused",
  );
  assert.equal(
    liveMyTeamChip({ group: "live", matchStarted: true, matchFinished: false, appeared: true }),
    "live",
  );
  assert.equal(
    liveMyTeamChip({ group: "xi", matchStarted: true, matchFinished: true, appeared: true }),
    "played",
  );
  assert.equal(
    liveMyTeamChip({ group: "bench", matchStarted: true, matchFinished: true, appeared: true }),
    "played",
  );
});

test("my-teams score is mantra roster Σ, two decimals, and a dash when NS", () => {
  assert.equal(mantraRosterSigma({ breakdown: { base: 6.1, total: 6.3 } }), 6.3);
  assert.equal(mantraRosterSigma({ breakdown: { base: 6.3, total: 6.3 } }), 6.3);
  assert.equal(mantraRosterSigma({ breakdown: null }), null);
  assert.equal(mantraRosterSigma({}), null);
  assert.equal(formatLiveMyTeamScore(6.3), "6.30");
  assert.equal(formatLiveMyTeamScore(null), "—");
  assert.notEqual(formatLiveMyTeamScore(null), "0.00");
});

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE mantra_fantasy_teams (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      tournament_id INTEGER,
      players_json TEXT
    );
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY,
      name TEXT,
      club_name TEXT,
      fotmob_player_id INTEGER,
      tm_url TEXT
    );
    CREATE TABLE fotmob_matches (
      id INTEGER PRIMARY KEY,
      league_id INTEGER,
      round TEXT,
      kickoff TEXT,
      home_id INTEGER,
      home_name TEXT,
      away_id INTEGER,
      away_name TEXT,
      score_home INTEGER,
      score_away INTEGER,
      status_short TEXT,
      phase TEXT
    );
    CREATE TABLE fotmob_match_players (
      match_id INTEGER,
      player_id INTEGER,
      name TEXT,
      team_name TEXT,
      is_home INTEGER,
      starter INTEGER
    );
    CREATE TABLE fotmob_match_events (
      match_id INTEGER,
      event_idx INTEGER,
      type TEXT,
      raw_json TEXT,
      player_name TEXT
    );
  `);
  return db;
}

test("my-teams payload keeps only the manager's clubs and scores a lineup player to 2 decimals", () => {
  const db = memoryDb();
  db.prepare(`INSERT INTO sync_meta (key, value) VALUES ('live_round', '10'), ('live_round:premier-league', '8')`).run();
  db.prepare(
    `INSERT INTO mantra_fantasy_teams (id, user_id, tournament_id, players_json) VALUES
      (1, 205, 18, '[1,4,5,7,9,10,11]'),
      (2, 205, 2, '[2,6]'),
      (3, 999, 18, '[8]')`,
  ).run();
  const insertPlayer = db.prepare(
    `INSERT INTO mantra_players (id, name, club_name, fotmob_player_id, tm_url) VALUES (?, ?, ?, ?, ?)`,
  );
  insertPlayer.run(1, "Kowalski", "Legia Warszawa", 101, "https://www.transfermarkt.com/kowalski/profil/spieler/11");
  insertPlayer.run(4, "Bench", "Legia Warszawa", 103, null);
  insertPlayer.run(5, "Unused", "Legia Warszawa", 104, null);
  insertPlayer.run(7, "Absent", "Legia Warszawa", 107, null);
  insertPlayer.run(9, "Nowak", "Legia Warszawa", null, null);
  insertPlayer.run(2, "Smith", "Arsenal", 202, null);
  insertPlayer.run(6, "Reserve", "Arsenal", 206, null);
  insertPlayer.run(8, "Other", "Rakow", 108, null);
  insertPlayer.run(10, "Played", "Zaglebie", 110, null);
  insertPlayer.run(11, "Sat", "Zaglebie", 111, null);

  const insertMatch = db.prepare(
    `INSERT INTO fotmob_matches (
      id, league_id, round, kickoff, home_id, home_name, away_id, away_name,
      score_home, score_away, status_short, phase
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertMatch.run(1, 196, "10", "2026-10-10T16:00:00Z", 1, "Legia Warszawa", 2, "Rakow", 1, 0, "1H", "live");
  insertMatch.run(2, 196, "10", "2026-10-10T16:00:00Z", 3, "Pogon", 4, "Lech", 0, 0, "1H", "live");
  insertMatch.run(9, 196, "9", "2026-09-01T16:00:00Z", 1, "Legia Warszawa", 5, "Zaglebie", 2, 2, "FT", "finished");
  insertMatch.run(3, 47, "8", "2026-10-12T15:00:00Z", 10, "Arsenal", 11, "Chelsea", null, null, "NS", "upcoming");
  insertMatch.run(4, 47, "8", "2026-10-12T15:00:00Z", 12, "Liverpool", 13, "Spurs", 0, 0, "1H", "live");
  insertMatch.run(5, 196, "10", "2026-10-10T13:00:00Z", 20, "Zaglebie", 21, "Lechia", 1, 1, "FT", "finished");

  const insertLineup = db.prepare(
    `INSERT INTO fotmob_match_players (match_id, player_id, name, team_name, is_home, starter)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertLineup.run(1, 101, "A. Kowalski", "Legia Warszawa", 1, 1);
  insertLineup.run(1, 103, "B. Bench", "Legia Warszawa", 1, 0);
  insertLineup.run(1, 104, "C. Unused", "Legia Warszawa", 1, 0);
  insertLineup.run(1, 109, "P. Nowak", "Legia Warszawa", 1, 1);
  insertLineup.run(3, 202, "J. Smith", "Arsenal", 1, 1);
  insertLineup.run(3, 206, "R. Reserve", "Arsenal", 1, 0);
  insertLineup.run(5, 110, "D. Played", "Zaglebie", 1, 1);
  insertLineup.run(5, 111, "E. Sat", "Zaglebie", 1, 0);

  db.prepare(
    `INSERT INTO fotmob_match_events (match_id, event_idx, type, raw_json, player_name) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    1,
    1,
    "Substitution",
    JSON.stringify({
      swap: [
        { id: 103, name: "B. Bench" },
        { id: 101, name: "A. Kowalski" },
      ],
    }),
    "B. Bench",
  );

  const view = buildLiveMyTeams(db, {
    signedIn: true,
    managerId: 205,
    scoreRows: [
      { mantraPlayerId: 1, breakdown: { base: 6.1, total: 6.3 } },
      { mantraPlayerId: 10, breakdown: { base: 7.0, total: 7.1 } },
    ],
    pairs: [
      {
        leagueSlug: "league-one",
        leagueName: "League One",
        leagueFlag: "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
        matchId: 101795,
        home: { teamId: 1, teamName: "E_ball", score: 0, goals: 0, scoredCount: 0 },
        away: { teamId: 2, teamName: "Loch Ness F.C.", score: 0, goals: 0, scoredCount: 0 },
      },
    ],
  });

  assert.deepEqual(
    view.matches.map((match) => match.id),
    [1, 3, 5],
  );
  assert.equal(view.matches[0]?.leagueFlag, "🇵🇱");
  assert.equal(view.matches.find((match) => match.id === 3)?.leagueFlag, "🏴󠁧󠁢󠁥󠁮󠁧󠁿");
  assert.deepEqual(
    view.columns.live.map((player) => player.surname),
    ["Bench", "Kowalski", "Nowak"],
  );
  assert.deepEqual(
    view.columns.xi.map((player) => player.surname),
    ["Played", "Smith"],
  );
  assert.deepEqual(
    view.columns.bench.map((player) => player.surname),
    ["Sat", "Unused", "Reserve"],
  );
  assert.equal(
    view.columns.live.concat(view.columns.xi, view.columns.bench).some((player) => player.surname === "Absent"),
    false,
  );

  const kowalski = view.columns.live.find((player) => player.mantraPlayerId === 1);
  assert.equal(kowalski?.chip, "live");
  assert.equal(kowalski?.scoreText, "6.30");
  assert.equal(kowalski?.scoreTitle, "Σ");
  assert.notEqual(kowalski?.scoreText, "6.10");
  assert.match(kowalski?.scoreText || "", /^\d+\.\d{2}$/);
  assert.equal(kowalski?.profileUrl, "/player.html?id=11");
  const nowak = view.columns.live.find((player) => player.surname === "Nowak");
  assert.equal(nowak?.chip, "live");
  assert.equal(nowak?.scoreText, "—");
  assert.equal(view.columns.xi.find((player) => player.surname === "Smith")?.chip, "pending");
  assert.equal(view.columns.xi.find((player) => player.surname === "Smith")?.scoreText, "—");
  assert.equal(view.columns.bench.find((player) => player.surname === "Unused")?.chip, "pending");
  assert.equal(view.columns.bench.find((player) => player.surname === "Reserve")?.chip, "pending");
  const played = view.columns.xi.find((player) => player.surname === "Played");
  assert.equal(played?.chip, "played");
  assert.equal(played?.scoreText, "7.10");
  const sat = view.columns.bench.find((player) => player.surname === "Sat");
  assert.equal(sat?.chip, "unused");
  assert.equal(sat?.scoreText, "—");
  assert.notEqual(sat?.scoreText, "0.00");
  assert.equal(view.pairs.length, 1);
  assert.equal(view.pairs[0]?.leagueFlag, "🏴󠁧󠁢󠁷󠁬󠁳󠁿");
  assert.equal(view.pairs[0]?.home.teamName, "E_ball");
  assert.equal(view.pairs[0]?.away.teamName, "Loch Ness F.C.");

  const signedOut = buildLiveMyTeams(db, { signedIn: false, managerId: null, scoreRows: [] });
  assert.equal(signedOut.matches.length, 0);
  assert.equal(signedOut.message, LIVE_MY_TEAMS_SIGN_IN);
  const noId = buildLiveMyTeams(db, { signedIn: true, managerId: null, scoreRows: [] });
  assert.equal(noId.message, LIVE_MY_TEAMS_NEED_ID);
});
