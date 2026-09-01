import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  backfillMantraTmUrlsFromSquad,
  backfillStartingXiFallbackPercentages,
  Expected11ImportError,
  getExpected11View,
  importExpected11,
  MAX_EXPECTED11_IMPORT_BYTES,
  normalizeExpected11Import,
  relinkUnmatchedExpected11Teams,
} from "./expected11Import.js";

function database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      first_name TEXT,
      full_name TEXT,
      positions_json TEXT,
      tm_url TEXT,
      club_id INTEGER,
      club_name TEXT
    );
    CREATE TABLE expected11_matches (
      id TEXT PRIMARY KEY, source_url TEXT NOT NULL, title TEXT NOT NULL,
      home_team TEXT, away_team TEXT, formations_json TEXT NOT NULL,
      extracted_at TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE expected11_teams (
      match_id TEXT NOT NULL, side TEXT NOT NULL, source_name TEXT NOT NULL,
      logo_url TEXT, notes_json TEXT NOT NULL, author TEXT,
      mantra_club_id INTEGER, mantra_club_name TEXT, link_status TEXT NOT NULL,
      PRIMARY KEY (match_id, side),
      FOREIGN KEY (match_id) REFERENCES expected11_matches(id) ON DELETE CASCADE
    );
    CREATE TABLE expected11_predictions (
      match_id TEXT NOT NULL, team_side TEXT NOT NULL, lineup_group TEXT NOT NULL,
      sort_order INTEGER NOT NULL, source_name TEXT NOT NULL,
      displayed_percentage REAL, player_path TEXT, mantra_player_id INTEGER,
      link_status TEXT NOT NULL,
      PRIMARY KEY (match_id, team_side, lineup_group, sort_order),
      FOREIGN KEY (match_id, team_side)
        REFERENCES expected11_teams(match_id, side) ON DELETE CASCADE
    );
    CREATE TABLE expected11_manual_mappings (
      source_name_normalized TEXT NOT NULL,
      mantra_club_id INTEGER NOT NULL,
      mantra_player_id INTEGER NOT NULL,
      mapped_by_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source_name_normalized, mantra_club_id)
    );
  `);
  return db;
}

function payload(players: Array<{ name: string; displayedPercentage: number | null }>) {
  return {
    schemaVersion: 2,
    extractedAt: "2026-08-10T21:37:30.701Z",
    matches: [
      {
        sourceUrl: "https://expected11.com/match/19729166/home-vs-away",
        extractedAt: "2026-08-10T21:37:30.701Z",
        status: "ok",
        match: {
          id: "19729166",
          title: "Home vs Away",
          homeTeam: "Home FC",
          awayTeam: "Away FC",
          formations: ["4-3-3"],
        },
        teams: [
          {
            side: "home",
            name: "Home FC",
            logoUrl: null,
            lineup: {
              starting: players.map((player, index) => ({
                ...player,
                raw: { playerPath: `/player/${index + 1}/player` },
              })),
              bench: [],
              out: [],
            },
            notes: {},
            author: null,
          },
        ],
      },
    ],
  };
}

test("persists strict club-scoped exact links and reports ambiguous names", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(1, "Doe", "Jane", "Jane Doe", '["GK","CB"]', 10, "Home FC");
  db.prepare(`UPDATE mantra_players SET tm_url = ? WHERE id = 1`).run(
    "https://www.transfermarkt.com/jane-doe/profil/spieler/606718",
  );
  const insert = db.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(2, "Same", "Alex", "Alex Same", '["CB"]', 10, "Home FC");
  insert.run(3, "Same", "Alex", "Alex Same", '["DM"]', 10, "Home FC");

  const normalized = normalizeExpected11Import(
    payload([
      { name: "Jäne Doe", displayedPercentage: 80 },
      { name: "Alex Same", displayedPercentage: 60 },
      { name: "Doe", displayedPercentage: 40 },
    ]),
  );
  const result = importExpected11(normalized, db);
  const view = getExpected11View(db);

  assert.deepEqual(
    { linked: result.linked, unmatched: result.unmatched, ambiguous: result.ambiguous },
    { linked: 1, unmatched: 1, ambiguous: 1 },
  );
  assert.equal(view.matches[0]?.teams[0]?.players[0]?.surname, "Doe");
  assert.equal(view.matches[0]?.teams[0]?.players[0]?.position, "GK");
  assert.deepEqual(view.matches[0]?.teams[0]?.players[0]?.positions, ["GK", "CB"]);
  assert.equal(
    view.matches[0]?.teams[0]?.players[0]?.profileUrl,
    "/player.html?id=606718",
  );
  assert.notEqual(
    view.matches[0]?.teams[0]?.players[0]?.profilePlayerId,
    String(view.matches[0]?.teams[0]?.players[0]?.mantraPlayerId),
  );
  assert.equal(view.matches[0]?.teams[0]?.players[2]?.linkStatus, "unmatched");
  assert.equal(view.matches[0]?.teams[0]?.players[2]?.profileUrl, null);
});

test("re-import of the same match overwrites Expected11 percentages", () => {
  const db = database();
  importExpected11(
    normalizeExpected11Import(payload([{ name: "Ladislav Krejci", displayedPercentage: 80 }])),
    db,
    { replaceAll: false },
  );
  const updated = payload([{ name: "Ladislav Krejci", displayedPercentage: 40 }]);
  updated.extractedAt = "2026-08-21T13:20:00.000Z";
  updated.matches[0]!.extractedAt = "2026-08-21T13:20:00.000Z";
  importExpected11(normalizeExpected11Import(updated), db, { replaceAll: false });

  const pct = db
    .prepare(
      `SELECT displayed_percentage AS pct, COUNT(*) AS n FROM expected11_predictions
       WHERE source_name = 'Ladislav Krejci'`,
    )
    .get() as { pct: number; n: number };
  assert.equal(pct.n, 1);
  assert.equal(pct.pct, 40);
});

test("returns sanitized narratives only for the requested match", () => {
  const db = database();
  const input = payload([{ name: "Jane Doe", displayedPercentage: 80 }]);
  input.matches[0]!.teams[0]!.notes = {
    teamAnalysis: {
      label: "Team Analysis",
      text: "First paragraph.\n\n<img src=x onerror=alert(1)>",
    },
    injuriesAndRecovery: null,
    suspensionsAndIneligibilities: {
      label: "Suspensions & Ineligibilities",
      text: "One suspension.",
    },
    additionalNotes: {
      label: "Additional notes",
      text: "Late update.",
    },
  };
  (input.matches[0]!.teams[0]! as unknown as { author: string | null }).author =
    "Analyst";

  importExpected11(normalizeExpected11Import(input), db);
  const aggregate = getExpected11View(db);
  const selected = getExpected11View(db, { narrativeMatchId: "19729166" });
  const selectedNotes = selected.matches[0]!.teams[0]!.notes;

  assert.equal("notes" in aggregate.matches[0]!.teams[0]!, false);
  assert.equal(
    selectedNotes?.teamAnalysis?.text,
    "First paragraph.\n\n<img src=x onerror=alert(1)>",
  );
  assert.equal(
    selectedNotes?.additionalNotes?.text,
    "Late update.",
  );
  assert.equal(selected.matches[0]!.teams[0]!.author, "Analyst");
  assert.equal(selected.matches[0]!.sourceUrl, input.matches[0]!.sourceUrl);
  assert.equal(selected.matches[0]!.extractedAt, input.matches[0]!.extractedAt);
});

test("uses explicit aliases but never fuzzy-matches", () => {
  const db = database();
  const insert = db.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(1, "Gomes", "Toti", "Toti Gomes", '["CB"]', 20, "Wolverhampton");
  insert.run(2, "Bentley", "Daniel", "Daniel Bentley", '["GK"]', 20, "Wolverhampton");
  const input = payload([
    { name: "Toti", displayedPercentage: 70 },
    { name: "Dan Bentley", displayedPercentage: 60 },
  ]);
  input.matches[0]!.teams[0]!.name = "Wolverhampton Wanderers";

  const result = importExpected11(normalizeExpected11Import(input), db);
  assert.deepEqual(
    { linked: result.linked, unmatched: result.unmatched },
    { linked: 1, unmatched: 1 },
  );
});

test("links every verified team alias and preserves club collisions", () => {
  const aliases = [
    ["AC Milan", "Milan"],
    ["AFC Bournemouth", "Bournemouth"],
    ["Bolton Wanderers", "Bolton"],
    ["Brighton & Hove Albion", "Brighton"],
    ["Charlton Athletic", "Charlton"],
    ["Derby County", "Derby"],
    ["Ipswich Town", "Ipswich"],
    ["Leeds United", "Leeds"],
    ["Lincoln City", "Lincoln"],
    ["Newcastle United", "Newcastle"],
    ["Norwich City", "Norwich"],
    ["Tottenham Hotspur", "Tottenham"],
    ["West Bromwich Albion", "West Bromwich"],
    ["West Ham United", "West Ham"],
    ["Wolverhampton Wanderers", "Wolverhampton"],
    ["VfB Stuttgart", "Stuttgart"],
    ["Hamburger SV", "Hamburger"],
    ["Borussia Mönchengladbach", "Borussia Mbach"],
    ["FSV Mainz 05", "Mainz 05"],
    ["Eintracht Frankfurt", "Eintracht"],
    ["TSG Hoffenheim", "Hoffenheim"],
    ["Bayer 04 Leverkusen", "Bayer Leverkusen"],
  ] as const;

  for (const [sourceName, mantraName] of aliases) {
    const db = database();
    db.prepare(
      `INSERT INTO mantra_players
        (id, name, first_name, full_name, positions_json, club_id, club_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, "Player", "Test", "Test Player", '["GK"]', 10, mantraName);
    const input = payload([{ name: "Test Player", displayedPercentage: 80 }]);
    input.matches[0]!.teams[0]!.name = sourceName;
    const result = importExpected11(normalizeExpected11Import(input), db);
    assert.equal(result.teamLinked, 1, sourceName);
  }

  const collisionDb = database();
  const insert = collisionDb.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(1, "One", "Player", "Player One", '["GK"]', 10, "Bolton");
  insert.run(2, "Two", "Player", "Player Two", '["GK"]', 20, "Bolton");
  const collisionInput = payload([{ name: "Test Player", displayedPercentage: 80 }]);
  collisionInput.matches[0]!.teams[0]!.name = "Bolton Wanderers";
  const collision = importExpected11(
    normalizeExpected11Import(collisionInput),
    collisionDb,
  );
  assert.equal(collision.teamAmbiguous, 1);
  assert.equal(collision.teamLinked, 0);
});

test("relinks unmatched EPL club aliases without a full snapshot import", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name, tm_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    840687,
    "Dunk",
    "Lewis",
    "Lewis Dunk",
    '["CB"]',
    24,
    "Brighton",
    "https://www.transfermarkt.com/lewis-dunk/profil/spieler/148153",
  );
  db.prepare(
    `INSERT INTO expected11_matches
       (id, source_url, title, home_team, away_team, formations_json, extracted_at)
     VALUES ('1', 'https://expected11.com/match/1/brighton', 'Brighton vs Bournemouth',
             'Brighton & Hove Albion', 'AFC Bournemouth', '[]', '2026-08-19T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, notes_json, mantra_club_id, mantra_club_name, link_status)
     VALUES ('1', 'home', 'Brighton & Hove Albion', '{}', NULL, NULL, 'unmatched')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('1', 'home', 'starting', 0, 'Lewis Dunk', 90, NULL, 'unmatched')`,
  ).run();

  const result = relinkUnmatchedExpected11Teams(db);
  assert.deepEqual(result, { teamsLinked: 1, playersLinked: 1 });
  const view = getExpected11View(db);
  assert.equal(view.matches[0]?.teams[0]?.linkStatus, "linked");
  assert.equal(view.matches[0]?.teams[0]?.mantraClubName, "Brighton");
  assert.equal(view.matches[0]?.teams[0]?.players[0]?.linkStatus, "linked");
  assert.equal(
    view.matches[0]?.teams[0]?.players[0]?.profileUrl,
    "/player.html?id=148153",
  );
});

test("relinks unmatched AC Milan club aliases without a full snapshot import", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name, tm_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    2363,
    "Maignan",
    "Mike",
    "Mike Maignan",
    '["GK"]',
    11,
    "Milan",
    "https://www.transfermarkt.com/mike-maignan/profil/spieler/182906",
  );
  db.prepare(
    `INSERT INTO expected11_matches
       (id, source_url, title, home_team, away_team, formations_json, extracted_at)
     VALUES ('19713610', 'https://expected11.com/match/19713610/torino-vs-ac-milan',
             'Torino vs AC Milan', 'Torino', 'AC Milan', '[]', '2026-08-20T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, notes_json, mantra_club_id, mantra_club_name, link_status)
     VALUES ('19713610', 'away', 'AC Milan', '{}', NULL, NULL, 'unmatched')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('19713610', 'away', 'starting', 0, 'Mike Maignan', 90, NULL, 'unmatched')`,
  ).run();

  const result = relinkUnmatchedExpected11Teams(db);
  assert.deepEqual(result, { teamsLinked: 1, playersLinked: 1 });
  const view = getExpected11View(db);
  assert.equal(view.matches[0]?.teams[0]?.linkStatus, "linked");
  assert.equal(view.matches[0]?.teams[0]?.mantraClubName, "Milan");
  assert.equal(view.matches[0]?.teams[0]?.players[0]?.linkStatus, "linked");
  assert.equal(
    view.matches[0]?.teams[0]?.players[0]?.profileUrl,
    "/player.html?id=182906",
  );

  const reverseDb = database();
  reverseDb.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(1, "Maignan", "Mike", "Mike Maignan", '["GK"]', 11, "AC Milan");
  const reverseInput = payload([{ name: "Mike Maignan", displayedPercentage: 90 }]);
  reverseInput.matches[0]!.teams[0]!.name = "Milan";
  const reverse = importExpected11(normalizeExpected11Import(reverseInput), reverseDb);
  assert.equal(reverse.teamLinked, 1);
  assert.equal(reverse.linked, 1);
  assert.equal(
    getExpected11View(reverseDb).matches[0]?.teams[0]?.mantraClubName,
    "AC Milan",
  );
});

test("relinks unmatched Super Lig club aliases without a full snapshot import", () => {
  const db = database();
  const insert = db.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name, tm_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    1,
    "Kadioglu",
    "Ferdi",
    "Ferdi Kadioglu",
    '["LB"]',
    372,
    "Basaksehir",
    "https://www.transfermarkt.com/ferdi-kadioglu/profil/spieler/369316",
  );
  insert.run(2, "Maxi", "Alex", "Alex Maxi", '["ST"]', 376, "Gaziantep", null);
  insert.run(3, "Sor", "Yira", "Yira Sor", '["RW"]', 414, "Amed", null);
  insert.run(4, "Renkber", "Taha", "Taha Renkber", '["GK"]', 415, "Corum", null);

  db.prepare(
    `INSERT INTO expected11_matches
       (id, source_url, title, home_team, away_team, formations_json, extracted_at)
     VALUES ('19746645', 'https://expected11.com/match/19746645/trabzonspor-vs-istanbul-basaksehir',
             'Trabzonspor vs İstanbul Başakşehir', 'Trabzonspor', 'İstanbul Başakşehir',
             '[]', '2026-08-19T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, notes_json, mantra_club_id, mantra_club_name, link_status)
     VALUES ('19746645', 'away', 'İstanbul Başakşehir', '{}', NULL, NULL, 'unmatched')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('19746645', 'away', 'starting', 0, 'Ferdi Kadioglu', 80, NULL, 'unmatched')`,
  ).run();

  const result = relinkUnmatchedExpected11Teams(db);
  assert.deepEqual(result, { teamsLinked: 1, playersLinked: 1 });
  const view = getExpected11View(db);
  assert.equal(view.matches[0]?.teams[0]?.mantraClubName, "Basaksehir");
  assert.equal(view.matches[0]?.teams[0]?.linkStatus, "linked");
  assert.equal(
    view.matches[0]?.teams[0]?.players[0]?.profileUrl,
    "/player.html?id=369316",
  );

  const aliases = [
    ["Gaziantep F.K.", "Gaziantep", "Alex Maxi"],
    ["Amed SK", "Amed", "Yira Sor"],
    ["Çorum FK", "Corum", "Taha Renkber"],
    ["Galatasaray SK", "Galatasaray", "Pedro Lucas"],
    ["Erzurumspor FK", "Erzurumspor", "Ertugrul Goalie"],
  ] as const;
  insert.run(5, "Lucas", "Pedro", "Pedro Lucas", '["AM"]', 253, "Galatasaray", null);
  insert.run(6, "Goalie", "Ertugrul", "Ertugrul Goalie", '["GK"]', 416, "Erzurumspor", null);
  for (const [sourceClub, mantraClub, sourceName] of aliases) {
    const input = payload([{ name: sourceName, displayedPercentage: 50 }]);
    input.matches[0]!.teams[0]!.name = sourceClub;
    const imported = importExpected11(normalizeExpected11Import(input), db);
    assert.equal(imported.teamLinked, 1, sourceClub);
    assert.equal(imported.linked, 1, `${sourceClub}: ${sourceName}`);
    assert.equal(
      getExpected11View(db).matches[0]?.teams[0]?.mantraClubName,
      mantraClub,
      sourceClub,
    );
  }
});

test("relinks unmatched Super Lig players on already-linked clubs", () => {
  const db = database();
  db.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(14876, "Talisca", "Anderson", "Anderson Talisca", '["AM"]', 375, "Fenerbahce");
  db.prepare(
    `INSERT INTO expected11_matches
       (id, source_url, title, home_team, away_team, formations_json, extracted_at)
     VALUES ('19746639', 'https://expected11.com/match/19746639/fenerbahce-vs-konyaspor',
             'Fenerbahçe vs Konyaspor', 'Fenerbahçe', 'Konyaspor', '[]', '2026-08-19T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, notes_json, mantra_club_id, mantra_club_name, link_status)
     VALUES ('19746639', 'home', 'Fenerbahçe', '{}', 375, 'Fenerbahce', 'linked')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('19746639', 'home', 'starting', 0, 'Talisca', 90, NULL, 'unmatched')`,
  ).run();

  const result = relinkUnmatchedExpected11Teams(db);
  assert.deepEqual(result, { teamsLinked: 0, playersLinked: 1 });
  assert.equal(getExpected11View(db).matches[0]?.teams[0]?.players[0]?.linkStatus, "linked");
});

test("relinks unmatched Bundesliga club aliases without a full snapshot import", () => {
  const db = database();
  const insert = db.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name, tm_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    1,
    "Undav",
    "Deniz",
    "Deniz Undav",
    '["ST"]',
    62,
    "Stuttgart",
    "https://www.transfermarkt.com/deniz-undav/profil/spieler/402048",
  );
  insert.run(2, "Königsdörffer", "Ransford", "Ransford Königsdörffer", '["ST"]', 355, "Hamburger", null);
  insert.run(3, "Plea", "Alassane", "Alassane Plea", '["ST"]', 53, "Borussia Mbach", null);
  insert.run(4, "Burkardt", "Jonathan", "Jonathan Burkardt", '["ST"]', 59, "Mainz 05", null);
  insert.run(5, "Ekitike", "Hugo", "Hugo Ekitike", '["ST"]', 54, "Eintracht", null);
  insert.run(6, "Kramaric", "Andrej", "Andrej Kramaric", '["ST"]', 57, "Hoffenheim", null);
  insert.run(7, "Wirtz", "Florian", "Florian Wirtz", '["AM"]', 50, "Bayer Leverkusen", null);

  db.prepare(
    `INSERT INTO expected11_matches
       (id, source_url, title, home_team, away_team, formations_json, extracted_at)
     VALUES ('19735187', 'https://expected11.com/match/19735187/fc-bayern-munchen-vs-vfb-stuttgart',
             'FC Bayern München vs VfB Stuttgart', 'FC Bayern München', 'VfB Stuttgart',
             '[]', '2026-08-28T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, notes_json, mantra_club_id, mantra_club_name, link_status)
     VALUES ('19735187', 'away', 'VfB Stuttgart', '{}', NULL, NULL, 'unmatched')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('19735187', 'away', 'starting', 0, 'Deniz Undav', 90, NULL, 'unmatched')`,
  ).run();

  const result = relinkUnmatchedExpected11Teams(db);
  assert.deepEqual(result, { teamsLinked: 1, playersLinked: 1 });
  assert.equal(getExpected11View(db).matches[0]?.teams[0]?.mantraClubName, "Stuttgart");
  assert.equal(
    getExpected11View(db).matches[0]?.teams[0]?.players[0]?.profileUrl,
    "/player.html?id=402048",
  );

  const aliases = [
    ["Hamburger SV", "Hamburger", "Ransford Königsdörffer"],
    ["Borussia Mönchengladbach", "Borussia Mbach", "Alassane Plea"],
    ["FSV Mainz 05", "Mainz 05", "Jonathan Burkardt"],
    ["Eintracht Frankfurt", "Eintracht", "Hugo Ekitike"],
    ["TSG Hoffenheim", "Hoffenheim", "Andrej Kramaric"],
    ["Bayer 04 Leverkusen", "Bayer Leverkusen", "Florian Wirtz"],
  ] as const;
  for (const [sourceClub, mantraClub, sourceName] of aliases) {
    const input = payload([{ name: sourceName, displayedPercentage: 50 }]);
    input.matches[0]!.teams[0]!.name = sourceClub;
    const imported = importExpected11(normalizeExpected11Import(input), db);
    assert.equal(imported.teamLinked, 1, sourceClub);
    assert.equal(imported.linked, 1, `${sourceClub}: ${sourceName}`);
    assert.equal(
      getExpected11View(db).matches[0]?.teams[0]?.mantraClubName,
      mantraClub,
      sourceClub,
    );
  }
});

test("backfills Super Lig tm_url from TR1 squads for profile links", () => {
  const db = database();
  db.exec(`
    ALTER TABLE mantra_players ADD COLUMN tournament_id INTEGER;
    CREATE TABLE tm_clubs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE tm_competition_clubs (
      competition_id TEXT NOT NULL, club_id TEXT NOT NULL,
      PRIMARY KEY (competition_id, club_id)
    );
    CREATE TABLE tm_squad_players (
      club_id TEXT NOT NULL, player_id TEXT NOT NULL, name TEXT,
      relative_url TEXT, PRIMARY KEY (club_id, player_id)
    );
  `);
  db.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name, tournament_id)
     VALUES (30, 'Muldur', 'Mert', 'Mert Muldur', '["RB"]', 375, 'Fenerbahce', 21)`,
  ).run();
  db.prepare(`INSERT INTO tm_clubs (id, name) VALUES ('36', 'Fenerbahce')`).run();
  db.prepare(
    `INSERT INTO tm_competition_clubs (competition_id, club_id) VALUES ('TR1', '36')`,
  ).run();
  db.prepare(
    `INSERT INTO tm_squad_players (club_id, player_id, name, relative_url)
     VALUES ('36', '369316', 'Mert Müldür', '/mert-muldur/profil/spieler/369316')`,
  ).run();

  assert.deepEqual(backfillMantraTmUrlsFromSquad(db, 21), { filled: 1 });
  db.prepare(
    `INSERT INTO expected11_matches
       (id, source_url, title, home_team, away_team, formations_json, extracted_at)
     VALUES ('1', 'https://expected11.com/match/1/fenerbahce', 'Fenerbahçe vs Konyaspor',
             'Fenerbahçe', 'Konyaspor', '[]', '2026-08-19T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_teams
       (match_id, side, source_name, notes_json, mantra_club_id, mantra_club_name, link_status)
     VALUES ('1', 'home', 'Fenerbahçe', '{}', 375, 'Fenerbahce', 'linked')`,
  ).run();
  db.prepare(
    `INSERT INTO expected11_predictions
       (match_id, team_side, lineup_group, sort_order, source_name,
        displayed_percentage, mantra_player_id, link_status)
     VALUES ('1', 'home', 'starting', 0, 'Mert Müldür', 90, 30, 'linked')`,
  ).run();

  assert.equal(
    getExpected11View(db).matches[0]?.teams[0]?.players[0]?.profileUrl,
    "/player.html?id=369316",
  );
});

test("links verified club-scoped player aliases without crossing clubs", () => {
  const aliases = [
    ["Bristol City", "Bristol City", "Jed Fernley Wallace", "Jed Wallace"],
    ["Millwall", "Millwall", "Benicio Baker", "Benicio Baker-Boaitey"],
    ["Charlton Athletic", "Charlton", "Karlan Laughton Ahearne-Grant", "Karlan Grant"],
    ["Charlton Athletic", "Charlton", "Matty Godden", "Matt Godden"],
    ["Charlton Athletic", "Charlton", "I. Fullah", "Ibrahim Fullah"],
    ["Lincoln City", "Lincoln", "Josh Honohan", "Joshua Honohan"],
    ["West Bromwich Albion", "West Bromwich", "Max Edward O’Leary", "Max O'Leary"],
    ["West Bromwich Albion", "West Bromwich", "Callum John Styles", "Callum Styles"],
    ["West Bromwich Albion", "West Bromwich", "Nathaniel Harry Phillips", "Nathaniel Phillips"],
    ["West Bromwich Albion", "West Bromwich", "Isaac Jude Price", "Isaac Price"],
    ["West Bromwich Albion", "West Bromwich", "Alex James Mowatt", "Alex Mowatt"],
    ["West Bromwich Albion", "West Bromwich", "Aune Selland Heggebø", "Aune Heggebo"],
    ["West Bromwich Albion", "West Bromwich", "Christopher James Mepham", "Chris Mepham"],
    ["West Bromwich Albion", "West Bromwich", "Michael Andrew Johnston", "Michael Johnston"],
    ["West Bromwich Albion", "West Bromwich", "Jayson Patrick Molumby", "Jayson Molumby"],
    ["West Bromwich Albion", "West Bromwich", "Oliver David Bostock", "Oliver Bostock"],
    ["Portsmouth", "Portsmouth", "Rocco Shein", "Rocco Robert Shein"],
    ["Queens Park Rangers", "Queens Park Rangers", "Amadou Mbengue", "Amadou Salif Mbengue"],
    ["Queens Park Rangers", "Queens Park Rangers", "Esquerdinha", "Joao Esquerdinha"],
    ["Queens Park Rangers", "Queens Park Rangers", "R. Burrell", "Rumarn Burrell"],
    ["Swansea City", "Swansea City", "Moussa Yeo", "Moussa Kounfolo Yeo"],
    ["Swansea City", "Swansea City", "Ronald", "Ronald Pereira"],
    ["Sheffield United", "Sheffield United", "Tom Cannon", "Thomas Cannon"],
    ["Burnley", "Burnley", "Benjamin Amos", "Ben Amos"],
    ["Burnley", "Burnley", "Max Weiß", "Max Weiss"],
    ["Burnley", "Burnley", "Hannibal", "Hannibal Mejbri"],
    ["West Ham United", "West Ham", "Maximilian Kilman", "Max Kilman"],
    ["West Ham United", "West Ham", "Pablo", "Felipe Pablo"],
    ["Wrexham", "Wrexham", "Daniel Edward Peter Imray", "Danny Imray"],
    ["Alanyaspor", "Alanyaspor", "Ruan", "Ruan Duarte"],
    ["Alanyaspor", "Alanyaspor", "Maestro", "Antonio Maestro"],
    ["Beşiktaş", "Besiktas", "Amir Murillo", "Michael Murillo"],
    ["Fenerbahçe", "Fenerbahce", "Talisca", "Anderson Talisca"],
    ["Gençlerbirliği", "Genclerbirligi", "Thalisson", "Kelven Thalisson"],
    ["Göztepe", "Goztepe", "Juan", "Santos Juan"],
    ["Göztepe", "Goztepe", "Malcom Bokele", "Malcom Bokele Mputu"],
    ["Kocaelispor", "Kocaelispor", "Show", "Manuel Show"],
    ["Samsunspor", "Samsunspor", "Haluk Mustafa Tan", "Mustafa Tan"],
    ["Trabzonspor", "Trabzonspor", "Sidny Lopes Cabral", "Sidny Cabral"],
    ["Trabzonspor", "Trabzonspor", "Noah Jose Saviolo", "Noah Saviolo"],
    ["Chelsea", "Chelsea", "João Pedro", "Joao Pedro Junqueira"],
  ] as const;

  for (const [sourceClub, mantraClub, sourceName, fullName] of aliases) {
    const db = database();
    const parts = fullName.split(" ");
    const surname = parts.pop()!;
    const firstName = parts.join(" ");
    db.prepare(
      `INSERT INTO mantra_players
        (id, name, first_name, full_name, positions_json, club_id, club_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, surname, firstName, fullName, '["MID"]', 10, mantraClub);
    const input = payload([{ name: sourceName, displayedPercentage: 50 }]);
    input.matches[0]!.teams[0]!.name = sourceClub;
    const result = importExpected11(normalizeExpected11Import(input), db);
    assert.equal(result.linked, 1, `${sourceClub}: ${sourceName}`);
  }

  const scopedDb = database();
  scopedDb.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(1, "Pablo", "Felipe", "Felipe Pablo", '["CB"]', 10, "Burnley");
  const scopedInput = payload([{ name: "Pablo", displayedPercentage: 50 }]);
  scopedInput.matches[0]!.teams[0]!.name = "Burnley";
  const scoped = importExpected11(normalizeExpected11Import(scopedInput), scopedDb);
  assert.equal(scoped.unmatched, 1);
});

test("returns aggregate and per-match counts for the imported snapshot", () => {
  const db = database();
  const insert = db.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(1, "Doe", "Jane", "Jane Doe", '["GK"]', 10, "Home FC");
  insert.run(2, "Roe", "John", "John Roe", '["CB"]', 20, "Away FC");

  const input = payload([
    { name: "Jane Doe", displayedPercentage: 80 },
    { name: "Missing Player", displayedPercentage: 20 },
  ]);
  const awayMatch = structuredClone(input.matches[0]!);
  awayMatch.sourceUrl = "https://expected11.com/match/19729167/away-vs-home";
  awayMatch.match.id = "19729167";
  awayMatch.match.title = "Away vs Home";
  awayMatch.teams[0]!.name = "Away FC";
  awayMatch.teams[0]!.lineup.starting = [
    {
      name: "John Roe",
      displayedPercentage: 70,
      raw: { playerPath: "/player/3/player" },
    },
  ];
  input.matches.push(awayMatch);

  importExpected11(normalizeExpected11Import(input), db);
  const view = getExpected11View(db);

  assert.deepEqual(view.aggregate, {
    matches: 2,
    teams: 2,
    clubs: 2,
    linked: 2,
    unmatched: 1,
    ambiguous: 0,
  });
  assert.deepEqual(view.matches.map((match) => match.counts), [
    { linked: 1, unmatched: 0, ambiguous: 0 },
    { linked: 1, unmatched: 1, ambiguous: 0 },
  ]);
});

test("replaces the previous snapshot and uses verified club aliases", () => {
  const db = database();
  const insert = db.prepare(
    `INSERT INTO mantra_players
      (id, name, first_name, full_name, positions_json, club_id, club_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(1, "Grieves", "Jack", "Jack Grieves", '["ST"]', 10, "Watford");
  insert.run(
    2,
    "Welington",
    "Damascena",
    "Damascena Welington",
    '["LB"]',
    20,
    "Southampton",
  );

  const watford = payload([{ name: "J. Grieves", displayedPercentage: null }]);
  watford.matches[0]!.teams[0]!.name = "Watford";
  const first = importExpected11(normalizeExpected11Import(watford), db);
  assert.equal(first.linked, 1);

  const southampton = payload([{ name: "Welington", displayedPercentage: 20 }]);
  southampton.matches[0]!.sourceUrl =
    "https://expected11.com/match/19729167/southampton-vs-away";
  southampton.matches[0]!.match.id = "19729167";
  southampton.matches[0]!.teams[0]!.name = "Southampton";
  const second = importExpected11(normalizeExpected11Import(southampton), db);
  const view = getExpected11View(db);

  assert.equal(second.scope, "snapshot");
  assert.equal(second.linked, 1);
  assert.deepEqual(view.matches.map((match) => match.id), ["19729167"]);
});

test("starting XI without a percentage is stored and shown as 66%", () => {
  const db = database();
  const input = payload([
    { name: "George Wickens", displayedPercentage: null },
    { name: "Tendayi Darikwa", displayedPercentage: 82 },
  ]);
  input.matches[0]!.teams[0]!.lineup.bench = [
    {
      name: "José Sá",
      displayedPercentage: null,
      raw: { playerPath: "/player/9/jose-sa" },
    },
  ];
  input.matches[0]!.teams[0]!.lineup.out = [
    {
      name: "Hee-chan Hwang",
      displayedPercentage: 0,
      raw: { playerPath: "/player/10/hee-chan-hwang" },
    },
  ];
  const normalized = normalizeExpected11Import(input);
  assert.equal(normalized.matches[0]?.teams[0]?.lineup.starting[0]?.displayedPercentage, 66);
  assert.equal(normalized.matches[0]?.teams[0]?.lineup.starting[1]?.displayedPercentage, 82);
  assert.equal(normalized.matches[0]?.teams[0]?.lineup.bench[0]?.displayedPercentage, null);
  assert.equal(normalized.matches[0]?.teams[0]?.lineup.out[0]?.displayedPercentage, 0);

  importExpected11(normalized, db);
  const home = getExpected11View(db).matches[0]?.teams[0]?.players;
  assert.equal(
    home?.find((player) => player.sourceName === "George Wickens")?.displayedPercentage,
    66,
  );
  assert.equal(
    home?.find((player) => player.sourceName === "Tendayi Darikwa")?.displayedPercentage,
    82,
  );
  assert.equal(
    home?.find((player) => player.sourceName === "José Sá")?.displayedPercentage,
    null,
  );
  assert.equal(
    home?.find((player) => player.sourceName === "Hee-chan Hwang")?.displayedPercentage,
    0,
  );

  db.prepare(
    `UPDATE expected11_predictions
     SET displayed_percentage = NULL
     WHERE source_name = 'George Wickens'`,
  ).run();
  assert.equal(
    getExpected11View(db).matches[0]?.teams[0]?.players.find(
      (player) => player.sourceName === "George Wickens",
    )?.displayedPercentage,
    66,
  );
  assert.equal(backfillStartingXiFallbackPercentages(db), 1);
  assert.equal(
    (
      db
        .prepare(
          `SELECT displayed_percentage AS pct FROM expected11_predictions
           WHERE source_name = 'George Wickens'`,
        )
        .get() as { pct: number }
    ).pct,
    66,
  );
});

test("skips stub matches instead of failing a snapshot that has players", () => {
  const input = payload([{ name: "Jane Doe", displayedPercentage: 80 }]);
  input.matches.push({
    sourceUrl: "https://expected11.com/match/19746637/erzurumspor-fk-vs-galatasaray",
    extractedAt: input.extractedAt,
    status: "no-predictions",
    match: {
      id: "19746637",
      title: "Erzurumspor FK vs Galatasaray",
      homeTeam: "Erzurumspor FK",
      awayTeam: "Galatasaray",
      formations: [],
    },
    teams: [],
  });
  const normalized = normalizeExpected11Import(input);
  assert.equal(normalized.matches.length, 1);
  assert.equal(normalized.matches[0]?.id, "19729166");
  assert.deepEqual(normalized.skipped, [
    {
      url: "https://expected11.com/match/19746637/erzurumspor-fk-vs-galatasaray",
      error: "expected11_match_has_no_predictions",
    },
  ]);
  const imported = importExpected11(normalized, database());
  assert.equal(imported.importedMatches, 1);
  assert.equal(imported.importedPlayers, 1);
  assert.equal(imported.skipped?.length, 1);

  assert.throws(
    () =>
      normalizeExpected11Import({
        ...input,
        matches: [input.matches[1]],
      }),
    (error) =>
      error instanceof Expected11ImportError &&
      error.code === "expected11_no_predicted_matches",
  );
});

test("rejects restricted URLs, malformed percentages, and secret-like fields", () => {
  const input = payload([{ name: "Jane Doe", displayedPercentage: 80 }]);
  input.matches[0]!.sourceUrl = "https://example.com/match/19729166/home-vs-away";
  assert.throws(() => normalizeExpected11Import(input), /invalid_expected11_url/);

  const invalidPercentage = payload([
    { name: "Jane Doe", displayedPercentage: 101 },
  ]);
  assert.throws(
    () => normalizeExpected11Import(invalidPercentage),
    /invalid_expected11_percentage/,
  );

  assert.throws(
    () => normalizeExpected11Import({ ...payload([]), token: "must-not-pass" }),
    /forbidden_expected11_field/,
  );
});

test("domain validation rejects payloads above the route limit", () => {
  assert.throws(
    () =>
      normalizeExpected11Import({
        ...payload([]),
        padding: "x".repeat(MAX_EXPECTED11_IMPORT_BYTES),
      }),
    (error) =>
      error instanceof Expected11ImportError &&
      error.code === "expected11_payload_too_large" &&
      error.status === 413,
  );
});
