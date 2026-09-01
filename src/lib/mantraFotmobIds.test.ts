import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { config } from "../config.js";

const dbPath = `/tmp/mantra-fotmob-ids-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.unlinkSync(`${dbPath}${suffix}`);
  } catch {
    /* missing is fine */
  }
}
config.dbPath = dbPath;

const { getDb } = await import("../db/index.js");
const {
  canonicalClubName,
  clubsMatch,
  syncMantraFotmobIds,
  unmatchedMantraFotmob,
} = await import("./mantraFotmobIds.js");

const db = getDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS fotmob_matches (
    id INTEGER PRIMARY KEY,
    league_id INTEGER,
    round TEXT,
    home_name TEXT,
    away_name TEXT
  );
  CREATE TABLE IF NOT EXISTS fotmob_match_players (
    match_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    name TEXT,
    team_name TEXT,
    PRIMARY KEY (match_id, player_id)
  );
`);

function insertMantra(row: {
  id: number;
  name: string;
  firstName?: string | null;
  club: string | null;
  fotmobId?: number | null;
}): void {
  db.prepare(
    `INSERT INTO mantra_players (id, name, first_name, full_name, club_name, tournament_id, fotmob_player_id)
     VALUES (@id, @name, @firstName, @fullName, @club, 21, @fotmobId)`,
  ).run({
    id: row.id,
    name: row.name,
    firstName: row.firstName ?? null,
    fullName: row.firstName ? `${row.firstName} ${row.name}` : row.name,
    club: row.club,
    fotmobId: row.fotmobId ?? null,
  });
}

function insertFotmob(row: {
  matchId: number;
  playerId: number;
  name: string;
  team: string;
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO fotmob_matches (id, league_id, round, home_name, away_name)
     VALUES (?, 71, '1', ?, 'Away')`,
  ).run(row.matchId, row.team);
  db.prepare(
    `INSERT INTO fotmob_match_players (match_id, player_id, name, team_name)
     VALUES (?, ?, ?, ?)`,
  ).run(row.matchId, row.playerId, row.name, row.team);
}

test("AC Milan aliases to Milan in both directions", () => {
  assert.equal(canonicalClubName("AC Milan"), "milan");
  assert.equal(canonicalClubName("Milan"), "milan");
  assert.ok(clubsMatch("AC Milan", "Milan"));
  assert.ok(clubsMatch("Milan", "AC Milan"));
  assert.equal(clubsMatch("AC Milan", "Inter"), false);
});

test("Super Lig club aliases survive Turkish characters and extra tokens", () => {
  assert.equal(canonicalClubName("İstanbul Başakşehir"), "basaksehir");
  assert.equal(canonicalClubName("Basaksehir"), "basaksehir");
  assert.equal(canonicalClubName("Çaykur Rizespor"), "rizespor");
  assert.equal(canonicalClubName("Gaziantep FK"), "gaziantep");
  assert.equal(canonicalClubName("Kasımpaşa"), "kasimpasa");
  assert.ok(clubsMatch("Basaksehir", "Istanbul Basaksehir"));
  assert.ok(clubsMatch("Kasimpasa", "Kasımpaşa SK"));
  assert.ok(clubsMatch("Rizespor", "Çaykur Rizespor"));
  assert.ok(clubsMatch("Gaziantep", "Gaziantep FK"));
  assert.ok(clubsMatch("Gaziantep", "Gaziantep F.K."));
  assert.ok(clubsMatch("Amed", "Amed SK"));
  assert.ok(clubsMatch("Corum", "Çorum FK"));
  assert.ok(clubsMatch("Erzurumspor", "Erzurumspor FK"));
  assert.equal(clubsMatch("Galatasaray", "Fenerbahce"), false);
  assert.equal(clubsMatch("Corum", "Galatasaray"), false);
});

test("sync links unique club+name Super Lig XI and leaves unlinked with reasons", () => {
  insertMantra({ id: 30, name: "Muldur", firstName: "Mert", club: "Fenerbahce" });
  insertMantra({ id: 1601, name: "Nubel", firstName: "Alexander", club: "Besiktas" });
  insertMantra({ id: 99, name: "Yılmaz", club: "Galatasaray" });
  insertMantra({ id: 100, name: "Yılmaz", firstName: "Berat", club: "Galatasaray" });
  insertMantra({ id: 200, name: "Yılmaz", club: "Fenerbahce" });
  insertMantra({ id: 300, name: "Loan", club: "Corum" });
  insertMantra({ id: 400, name: "NoClub", club: null });

  insertFotmob({
    matchId: 1,
    playerId: 901,
    name: "Mert Müldür",
    team: "Fenerbahce",
  });
  insertFotmob({
    matchId: 2,
    playerId: 902,
    name: "Alexander Nübel",
    team: "Beşiktaş",
  });
  insertFotmob({
    matchId: 3,
    playerId: 903,
    name: "Barış Alper Yılmaz",
    team: "Galatasaray SK",
  });
  insertFotmob({
    matchId: 3,
    playerId: 904,
    name: "Berat Yılmaz",
    team: "Galatasaray SK",
  });

  const before = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mantra_players
       WHERE tournament_id = 21 AND fotmob_player_id IS NOT NULL`,
    )
    .get() as { n: number };
  assert.equal(before.n, 0);

  const result = syncMantraFotmobIds(21, 71);
  assert.equal(result.linked, 3);
  assert.equal(result.total, 3);

  const muldur = db
    .prepare(`SELECT fotmob_player_id AS id FROM mantra_players WHERE id = 30`)
    .get() as { id: number };
  const nubel = db
    .prepare(`SELECT fotmob_player_id AS id FROM mantra_players WHERE id = 1601`)
    .get() as { id: number };
  const berat = db
    .prepare(`SELECT fotmob_player_id AS id FROM mantra_players WHERE id = 100`)
    .get() as { id: number };
  assert.equal(muldur.id, 901);
  assert.equal(nubel.id, 902);
  assert.equal(berat.id, 904);

  const unmatched = unmatchedMantraFotmob(21, 71);
  const byId = new Map(unmatched.map((row) => [row.id, row]));
  assert.equal(byId.get(200)?.reason, "name-below-threshold");
  assert.equal(byId.get(300)?.reason, "no-club-match");
  assert.equal(byId.get(400)?.reason, "missing-club");
  // Shirt "Yılmaz" is no longer ambiguous once Berat is linked; a second pass
  // can uniquely attach the leftover FotMob Yılmaz.
  const second = syncMantraFotmobIds(21, 71);
  assert.equal(second.linked, 1);
  const shirtGs = db
    .prepare(`SELECT fotmob_player_id AS id FROM mantra_players WHERE id = 99`)
    .get() as { id: number | null };
  assert.equal(shirtGs.id, 903);

  const shirtYilmaz = db
    .prepare(`SELECT fotmob_player_id AS id FROM mantra_players WHERE id = 200`)
    .get() as { id: number | null };
  assert.equal(shirtYilmaz.id, null);
});

test("linked XI players have a FotMob id; unlinked XI players do not", () => {
  const linked = db
    .prepare(
      `SELECT id, name, fotmob_player_id AS fotmobId
       FROM mantra_players
       WHERE tournament_id = 21 AND id IN (30, 1601, 300)`,
    )
    .all() as Array<{ id: number; name: string; fotmobId: number | null }>;
  const byId = new Map(linked.map((row) => [row.id, row]));
  assert.ok(byId.get(30)?.fotmobId);
  assert.ok(byId.get(1601)?.fotmobId);
  assert.equal(byId.get(300)?.fotmobId ?? null, null);
});

test("Alisson links to Alisson Becker; Beck does not contest that FotMob id", () => {
  insertMantra({ id: 746, name: "Alisson", club: "Liverpool" });
  insertMantra({ id: 747, name: "Beck", firstName: "Owen", club: "Liverpool" });
  insertFotmob({
    matchId: 10,
    playerId: 319784,
    name: "Alisson Becker",
    team: "Liverpool",
  });
  insertFotmob({
    matchId: 10,
    playerId: 555,
    name: "Owen Beck",
    team: "Liverpool",
  });

  const result = syncMantraFotmobIds(21, 71);
  assert.ok(result.linked >= 2);

  const alisson = db
    .prepare(`SELECT fotmob_player_id AS id FROM mantra_players WHERE id = 746`)
    .get() as { id: number | null };
  const beck = db
    .prepare(`SELECT fotmob_player_id AS id FROM mantra_players WHERE id = 747`)
    .get() as { id: number | null };
  assert.equal(alisson.id, 319784);
  assert.equal(beck.id, 555);
});

test("Chelsea Pedro Junqueira shirt aliases to FotMob João Pedro", () => {
  insertMantra({ id: 967, name: "Pedro Junqueira", club: "Chelsea" });
  insertFotmob({
    matchId: 20,
    playerId: 1021382,
    name: "João Pedro",
    team: "Chelsea",
  });
  insertFotmob({
    matchId: 20,
    playerId: 843040,
    name: "Pedro Neto",
    team: "Chelsea",
  });

  const result = syncMantraFotmobIds(21, 71);
  assert.ok(result.linked >= 1);

  const pedro = db
    .prepare(`SELECT fotmob_player_id AS id FROM mantra_players WHERE id = 967`)
    .get() as { id: number | null };
  assert.equal(pedro.id, 1021382);
});
