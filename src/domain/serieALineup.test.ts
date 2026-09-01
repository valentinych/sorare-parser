import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  clubKey,
  importSerieALineupSnapshot,
  mergePlayersByHighestPct,
  parseFantacalcioArticle,
  serieALineupForAfPlayers,
  serieALineupScoreBonus,
  serieALineupSnapshotVersion,
  SERIE_A_LINEUP_SCHEMA,
  SERIE_A_XI_LEAGUE_ID,
  type SerieALineupSnapshot,
} from "./serieALineup.js";

const FANTACALCIO_HTML = `
<aside class="text-type-aside"><h2>JUVENTUS</h2>
<p><strong>Allenatore</strong>: Luciano Spalletti</p>
<p><strong>Modulo</strong>: 4-2-3-1</p>
<p><strong>Probabile formazione</strong> (da dx a sx): Di Gregorio; Kalulu, Bremer, Kelly, Cambiaso; Locatelli, McKennie; Conceicao, Alajbegovic, Yildiz; Kolo Muani.</p>
<p><strong>Ballottaggi</strong>: Kelly/Celik; McKennie/Thuram</p>
</aside>
<aside class="text-type-aside"><h2>ATALANTA</h2>
<p><strong>Allenatore</strong>: Maurizio Sarri</p>
<p><strong>Modulo</strong>: 4-3-3</p>
<p><strong>Probabile formazione</strong>: Carnesecchi; Zappacosta, Kristensen, Scalvini, Bernasconi; Samardzic, Gaetano, Ederson; De Ketelaere, Scamacca, Raspadori.</p>
<p><strong>Ballottaggi</strong>: Zappacosta/Bellanova</p>
</aside>
`;

function database(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SERIE_A_LINEUP_SCHEMA);
  db.exec(`
    CREATE TABLE season_teams (
      season INTEGER, team_id INTEGER, name TEXT, league_id INTEGER
    );
    CREATE TABLE squad_players (
      season INTEGER, team_id INTEGER, player_id INTEGER, name TEXT
    );
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY, tournament_id INTEGER, club_id INTEGER,
      club_name TEXT, name TEXT, first_name TEXT, full_name TEXT
    );
  `);
  db.prepare(`INSERT INTO season_teams VALUES (2026, 496, 'Juventus', 135)`).run();
  db.prepare(`INSERT INTO season_teams VALUES (2026, 499, 'Atalanta', 135)`).run();
  db.prepare(`INSERT INTO squad_players VALUES (2026, 496, 1, 'Manuel Locatelli')`).run();
  db.prepare(`INSERT INTO squad_players VALUES (2026, 496, 2, 'Kenan Yıldız')`).run();
  db.prepare(`INSERT INTO squad_players VALUES (2026, 496, 3, 'Pierre Kalulu')`).run();
  db.prepare(`INSERT INTO squad_players VALUES (2026, 499, 10, 'Marco Carnesecchi')`).run();
  db.prepare(
    `INSERT INTO mantra_players VALUES (100, 1, 8, 'Juventus', 'Locatelli', 'Manuel', 'Manuel Locatelli')`,
  ).run();
  db.prepare(
    `INSERT INTO mantra_players VALUES (101, 1, 1, 'Atalanta', 'Carnesecchi', 'Marco', 'Marco Carnesecchi')`,
  ).run();
  return db;
}

test("fantacalcio parser extracts starters and ballottaggi without inventing %", () => {
  const snapshot = parseFantacalcioArticle(FANTACALCIO_HTML, "2026-08-06T00:00:00.000Z");
  assert.equal(snapshot.source, "fantacalcio");
  assert.equal(snapshot.clubs.length, 2);
  const juve = snapshot.clubs.find((club) => club.name === "JUVENTUS")!;
  const locatelli = juve.players.find((player) => player.name === "Locatelli")!;
  assert.equal(locatelli.lineupGroup, "starting");
  assert.equal(locatelli.displayedPercentage, null);
  const celik = juve.players.find((player) => /celik/i.test(player.name))!;
  assert.equal(celik.lineupGroup, "bench");
  assert.equal(celik.displayedPercentage, null);
  assert.ok(juve.players.some((player) => player.name === "Yildiz"));
});

test("duplicate source rows keep the highest listed % and raw labels", () => {
  const merged = mergePlayersByHighestPct([
    {
      name: "P. Kalulu",
      displayedPercentage: 20,
      lineupGroup: "bench",
      slot: "RB",
      rawLabel: "Kalulu 20% RB",
    },
    {
      name: "P. Kalulu",
      displayedPercentage: 40,
      lineupGroup: "bench",
      slot: "LB",
      rawLabel: "Kalulu 40% LB",
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.displayedPercentage, 40);
  assert.match(merged[0]!.rawLabel ?? "", /20%/);
  assert.match(merged[0]!.rawLabel ?? "", /40%/);
});

test("strict join is club-scoped: surname matches inside club, not across clubs", () => {
  const db = database();
  db.prepare(`INSERT INTO squad_players VALUES (2026, 499, 11, 'Manuel Locatelli')`).run();
  const snapshot: SerieALineupSnapshot = {
    source: "sorareinside",
    sourceUrl: "https://sorareinside.com",
    title: "test",
    extractedAt: "2026-08-16T00:00:00.000Z",
    clubs: [
      {
        name: "Juventus FC",
        formation: "4-2-3-1",
        coach: null,
        players: [
          {
            name: "Manuel Locatelli",
            displayedPercentage: 90,
            lineupGroup: "starting",
            slot: "CM",
            rawLabel: "Locatelli 90%",
          },
          {
            name: "Kenan Yıldız",
            displayedPercentage: 90,
            lineupGroup: "starting",
            slot: "CAM",
            rawLabel: "Yıldız 90%",
          },
          {
            name: "Nobody Known",
            displayedPercentage: 50,
            lineupGroup: "bench",
            slot: null,
            rawLabel: "Nobody 50%",
          },
        ],
      },
      {
        name: "Atalanta Bergamasca Calcio",
        formation: "4-3-3",
        coach: null,
        players: [
          {
            name: "Marco Carnesecchi",
            displayedPercentage: 90,
            lineupGroup: "starting",
            slot: "GK",
            rawLabel: "Carnesecchi 90%",
          },
        ],
      },
    ],
  };
  const imported = importSerieALineupSnapshot(snapshot, db, {
    season: 2026,
    rebuildCache: false,
  });
  assert.equal(imported.linked, 3);
  assert.equal(imported.unmatched, 1);
  const juveLocatelli = serieALineupForAfPlayers(SERIE_A_XI_LEAGUE_ID, [1], db).get(1);
  assert.equal(juveLocatelli?.sorareInside?.displayedPercentage, 90);
  const atalantaFakeLocatelli = serieALineupForAfPlayers(SERIE_A_XI_LEAGUE_ID, [11], db).get(11);
  assert.equal(atalantaFakeLocatelli, undefined);
  assert.equal(clubKey("Hellas Verona FC"), "verona");
  assert.equal(clubKey("Bologna FC 1909"), "bologna");
  assert.equal(clubKey("FC Internazionale Milano"), "inter");
});

test("missing percentages stay null and are score-neutral", () => {
  assert.equal(serieALineupScoreBonus(null), 0);
  assert.equal(
    serieALineupScoreBonus({
      fantacalcio: {
        displayedPercentage: null,
        lineupGroup: "starting",
        sourceName: "Locatelli",
        rawLabel: "XI",
        sourceUrl: "https://example.com",
        extractedAt: "2026-08-06T00:00:00.000Z",
        importedAt: "2026-08-16T00:00:00.000Z",
      },
      sorareInside: null,
    }),
    0,
  );
  assert.equal(
    serieALineupScoreBonus({
      fantacalcio: null,
      sorareInside: {
        displayedPercentage: 90,
        lineupGroup: "starting",
        sourceName: "Locatelli",
        rawLabel: "90%",
        sourceUrl: "https://sorareinside.com",
        extractedAt: "2026-08-16T00:00:00.000Z",
        importedAt: "2026-08-16T00:00:00.000Z",
      },
    }),
    160,
  );
});

test("snapshot version changes after import", () => {
  const db = database();
  assert.equal(serieALineupSnapshotVersion(db), null);
  importSerieALineupSnapshot(
    {
      source: "fantacalcio",
      sourceUrl: "https://www.fantacalcio.it/news",
      title: "xi",
      extractedAt: "2026-08-06T00:00:00.000Z",
      clubs: [
        {
          name: "Juventus",
          formation: null,
          coach: null,
          players: [
            {
              name: "Manuel Locatelli",
              displayedPercentage: null,
              lineupGroup: "starting",
              slot: "CM",
              rawLabel: "XI",
            },
          ],
        },
      ],
    },
    db,
    { season: 2026, rebuildCache: false },
  );
  const version = serieALineupSnapshotVersion(db);
  assert.ok(version?.includes("2026-08-06"));
});
