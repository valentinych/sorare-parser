import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";
import {
  extractExpected11MatchUrls,
  getExpected11IngestView,
  getExpected11TourMatchIds,
  importExpected11ForTour,
  listExpected11Tours,
  parseExpected11Html,
  parseExpected11ImportScope,
  parseExpected11SourceUrl,
  parseExpected11UrlList,
  rebuildExpected11Tour,
  saveExpected11TourUrls,
  Expected11IngestError,
} from "./expected11Ingest.js";
import { leagueBySlug } from "../lib/afLeagues.js";

const lineupHtml = readFileSync(
  new URL("./fixtures/expected11-lineup.html", import.meta.url),
  "utf8",
);

function tourMatch(
  id: string,
  slug: string,
  title: string,
  extractedAt = "2026-08-19T18:46:27.033Z",
) {
  const [homeTeam, awayTeam] = title.split(" vs ");
  return {
    sourceUrl: `https://expected11.com/match/${id}/${slug}`,
    extractedAt,
    id,
    title,
    homeTeam: homeTeam ?? null,
    awayTeam: awayTeam ?? null,
    formations: [] as string[],
    teams: [
      {
        side: "home" as const,
        name: homeTeam ?? title,
        logoUrl: null,
        lineup: { starting: [], bench: [], out: [] },
        notes: {},
        author: null,
      },
    ],
  };
}

function database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE mantra_players (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, first_name TEXT,
      full_name TEXT, positions_json TEXT, tm_url TEXT, club_id INTEGER, club_name TEXT
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
    CREATE TABLE fotmob_matches (
      id INTEGER PRIMARY KEY, league_id INTEGER, round TEXT, kickoff TEXT, phase TEXT
    );
  `);
  return db;
}

test("rejects empty or non-expected11 URLs before fetching", async () => {
  assert.throws(
    () => parseExpected11SourceUrl(""),
    (error) =>
      error instanceof Expected11IngestError && error.code === "invalid_expected11_url",
  );
  assert.throws(
    () => parseExpected11SourceUrl("https://example.com/match/1"),
    (error) =>
      error instanceof Expected11IngestError && error.code === "invalid_expected11_url",
  );
  assert.equal(
    parseExpected11SourceUrl(
      "https://expected11.com/match/19729166/wolves-vs-blackburn",
    ),
    "https://expected11.com/match/19729166/wolves-vs-blackburn",
  );
});

test("parses multiple expected11 URLs from textarea text", () => {
  assert.deepEqual(
    parseExpected11UrlList(`
      https://expected11.com/match/11/a
      https://expected11.com/match/22/b
      https://expected11.com/match/11/a
    `),
    [
      "https://expected11.com/match/11/a",
      "https://expected11.com/match/22/b",
    ],
  );
});

test("extracts unique Expected11 match URLs from a listing page", () => {
  assert.deepEqual(
    extractExpected11MatchUrls(`
      <a href="/match/11/tour-home-vs-away">Tour</a>
      <a href="https://expected11.com/match/22/championship-home-vs-away">Ch</a>
      <a href="/match/11/tour-home-vs-away">dup</a>
    `),
    [
      "https://expected11.com/match/11/tour-home-vs-away",
      "https://expected11.com/match/22/championship-home-vs-away",
    ],
  );
});

test("persists URLs by championship and tour without fetching", () => {
  const db = database();
  const urls = [
    "https://expected11.com/match/11/a",
    "https://expected11.com/match/22/b",
  ];
  const saved = saveExpected11TourUrls(
    { league: "GB2", tour: 3, urls: urls.join("\n") },
    db,
  );
  assert.equal(saved.import, null);
  assert.deepEqual(saved.ingest.urls, urls);
  assert.equal(saved.ingest.league, "championship");
  assert.equal(saved.ingest.tour, 3);

  saveExpected11TourUrls(
    {
      league: "championship",
      tour: 4,
      urls: "https://expected11.com/match/33/c",
    },
    db,
  );
  const tour3 = getExpected11IngestView(
    { includeUrls: true, league: "championship", tour: 3 },
    db,
  );
  const tour4 = getExpected11IngestView(
    { includeUrls: true, league: "championship", tour: 4 },
    db,
  );
  assert.deepEqual(tour3.urls, urls);
  assert.deepEqual(tour4.urls, ["https://expected11.com/match/33/c"]);
  assert.equal(tour3.tours.length, 2);
});

test("rebuilds from saved URLs without re-entering them", async () => {
  const db = database();
  const matchUrl = "https://expected11.com/match/11/tour-home-vs-away";
  saveExpected11TourUrls(
    { league: "championship", tour: 3, urls: matchUrl },
    db,
  );
  const fetched: string[] = [];
  const result = await rebuildExpected11Tour(
    { league: "championship", tour: 3 },
    {
      database: db,
      now: new Date("2026-08-19T12:00:00.000Z"),
      parseMatches: async (urls, { extractedAt }) => {
        fetched.push(...urls);
        return urls.map((url) => parseExpected11Html(lineupHtml, url, extractedAt));
      },
    },
  );
  assert.deepEqual(fetched, [matchUrl]);
  assert.equal(result.import?.importedMatches, 1);
  assert.deepEqual(getExpected11TourMatchIds("championship", 3, db), ["11"]);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM expected11_matches`).get() as { n: number }).n,
    1,
  );
});

test("rebuild skips URLs without predictions and keeps other matches", async () => {
  const db = database();
  const good = "https://expected11.com/match/11/good";
  const empty = "https://expected11.com/match/22/empty";
  const otherTour = "https://expected11.com/match/33/other";
  await rebuildExpected11Tour(
    { league: "championship", tour: 3, urls: `${good}\n${empty}` },
    {
      database: db,
      now: new Date("2026-08-19T12:00:00.000Z"),
      parseMatches: async (urls, { extractedAt }) =>
        urls.map((url) =>
          url === empty
            ? parseExpected11Html("<html><body>No XI yet</body></html>", url, extractedAt)
            : parseExpected11Html(lineupHtml, url, extractedAt),
        ),
    },
  );
  await rebuildExpected11Tour(
    { league: "premier-league", tour: 1, urls: otherTour },
    {
      database: db,
      now: new Date("2026-08-19T12:00:00.000Z"),
      parseMatches: async (urls, { extractedAt }) =>
        urls.map((url) => parseExpected11Html(lineupHtml, url, extractedAt)),
    },
  );
  const again = await rebuildExpected11Tour(
    { league: "championship", tour: 3 },
    {
      database: db,
      now: new Date("2026-08-19T13:00:00.000Z"),
      parseMatches: async (urls, { extractedAt }) =>
        urls.map((url) =>
          url === empty
            ? parseExpected11Html(
                "<html><body>Still empty</body></html>",
                url,
                extractedAt,
              )
            : parseExpected11Html(lineupHtml, url, extractedAt),
        ),
    },
  );
  assert.equal(
    again.ingest.skipped?.some(
      (row) =>
        row.url === empty && row.error === "expected11_match_has_no_predictions",
    ),
    true,
  );
  assert.deepEqual(
    db
      .prepare(`SELECT id FROM expected11_matches ORDER BY CAST(id AS INTEGER)`)
      .all()
      .map((row) => (row as { id: string }).id),
    ["11", "33"],
  );
  assert.deepEqual(getExpected11TourMatchIds("championship", 3, db), ["11"]);
  assert.deepEqual(getExpected11TourMatchIds("premier-league", 1, db), ["33"]);
});

test("rebuild tags a login wall separately from empty predictions", async () => {
  const db = database();
  const blocked = "https://expected11.com/match/22/login";
  const result = await rebuildExpected11Tour(
    { league: "championship", tour: 3, urls: blocked },
    {
      database: db,
      now: new Date("2026-08-19T12:00:00.000Z"),
      parseMatches: async (urls, { extractedAt }) =>
        urls.map((url) =>
          parseExpected11Html(
            `<html><body>
              <div class="layout-auth-controls__signed-out"><a href="/sign-in">Sign in</a></div>
              <div class="match-view match-view--loading"></div>
            </body></html>`,
            url,
            extractedAt,
          ),
        ),
    },
  );
  assert.equal(result.import, null);
  assert.equal(result.ingest.skipped?.[0]?.error, "expected11_login_required");
  assert.equal(result.ingest.lastError, "expected11_login_required");
});

test("rebuild saves a match stub when teams exist without XI percentages", async () => {
  const db = database();
  const stubUrl = "https://expected11.com/match/50/millwall-vs-norwich-city";
  const result = await rebuildExpected11Tour(
    { league: "championship", tour: 3, urls: stubUrl },
    {
      database: db,
      now: new Date("2026-08-19T12:00:00.000Z"),
      parseMatches: async (urls, { extractedAt }) =>
        urls.map((url) =>
          parseExpected11Html(
            `<html>
              <head><title>Millwall vs Norwich City | Expected 11</title></head>
              <body>
                <a class="match-view__team-label--home">Millwall</a>
                <a class="match-view__team-label--away">Norwich City</a>
                <article class="match-view__squad-team match-view__squad-team--home">
                  <h3>Millwall</h3>
                  <section><h4>Starting</h4><ol></ol></section>
                  <section><h4>Bench</h4><ol></ol></section>
                  <section><h4>Out</h4><ol></ol></section>
                </article>
                <article class="match-view__squad-team match-view__squad-team--away">
                  <h3>Norwich City</h3>
                  <section><h4>Starting</h4><ol></ol></section>
                  <section><h4>Bench</h4><ol></ol></section>
                  <section><h4>Out</h4><ol></ol></section>
                </article>
              </body>
            </html>`,
            url,
            extractedAt,
          ),
        ),
    },
  );
  assert.equal(result.import?.importedMatches, 1);
  assert.equal(result.import?.importedPlayers, 0);
  assert.deepEqual(getExpected11TourMatchIds("championship", 3, db), ["50"]);
  const row = db
    .prepare(`SELECT home_team, away_team FROM expected11_matches WHERE id = '50'`)
    .get() as { home_team: string; away_team: string };
  assert.equal(row.home_team, "Millwall");
  assert.equal(row.away_team, "Norwich City");
});

test("rebuild imports paywalled team stubs and reports login_required", async () => {
  const db = database();
  const url = "https://expected11.com/match/50/millwall-vs-norwich-city";
  const result = await rebuildExpected11Tour(
    { league: "championship", tour: 3, urls: url },
    {
      database: db,
      now: new Date("2026-08-19T12:00:00.000Z"),
      parseMatches: async (urls, { extractedAt }) =>
        urls.map((matchUrl) =>
          parseExpected11Html(
            `<html>
              <head><title>Millwall vs Norwich City | Expected 11</title></head>
              <body>
                <a href="/sign-in">Sign in</a>
                <a class="match-view__team-label--home">Millwall</a>
                <a class="match-view__team-label--away">Norwich City</a>
                <div class="lineup-access-cta">This predicted lineup is not public yet</div>
                <article class="match-view__squad-team match-view__squad-team--home">
                  <h3>Millwall</h3>
                  <section><h4>Starting</h4><ol></ol></section>
                </article>
                <article class="match-view__squad-team match-view__squad-team--away">
                  <h3>Norwich City</h3>
                  <section><h4>Starting</h4><ol></ol></section>
                </article>
              </body>
            </html>`,
            matchUrl,
            extractedAt,
          ),
        ),
    },
  );
  assert.equal(result.import?.importedMatches, 1);
  assert.equal(result.import?.importedPlayers, 0);
  assert.equal(result.ingest.lastError, "expected11_login_required");
  assert.deepEqual(getExpected11TourMatchIds("championship", 3, db), ["50"]);
});

test("rebuild reports a missing browser instead of empty predictions", async () => {
  const db = database();
  const result = await rebuildExpected11Tour(
    {
      league: "championship",
      tour: 3,
      urls: "https://expected11.com/match/11/tour",
    },
    {
      database: db,
      parseMatches: async () => {
        throw new Expected11IngestError("expected11_browser_unavailable", 503);
      },
    },
  );
  assert.equal(result.import, null);
  assert.equal(result.ingest.skipped?.[0]?.error, "expected11_browser_unavailable");
  const stored = db
    .prepare(`SELECT urls_json, match_ids_json, skipped_json FROM expected11_ingest_tours`)
    .get() as { urls_json: string; match_ids_json: string; skipped_json: string };
  assert.equal(JSON.parse(stored.urls_json).length, 1);
  assert.deepEqual(JSON.parse(stored.match_ids_json), []);
  assert.equal(JSON.parse(stored.skipped_json)[0].error, "expected11_browser_unavailable");
});

test("lists schedule tours with start and end dates and nearest current tour", () => {
  const db = database();
  const league = leagueBySlug("championship")!;
  db.exec(`
    INSERT INTO fixtures (id, date, round, home_team_id, away_team_id, status, league_id, season)
    VALUES
      (1, '2026-08-15T14:00:00.000Z', 'Regular Season - 2', 1, 2, 'FT', 40, 2026),
      (2, '2026-08-16T14:00:00.000Z', 'Regular Season - 2', 3, 4, 'FT', 40, 2026),
      (3, '2026-08-22T14:00:00.000Z', 'Regular Season - 3', 1, 3, 'NS', 40, 2026),
      (4, '2026-08-23T16:00:00.000Z', 'Regular Season - 3', 2, 4, 'NS', 40, 2026);
  `);
  const tours = listExpected11Tours(league, db, 2026);
  assert.deepEqual(
    tours.map((tour) => ({
      round: tour.round,
      startAt: tour.startAt,
      endAt: tour.endAt,
      current: tour.current,
    })),
    [
      {
        round: 2,
        startAt: "2026-08-15T14:00:00.000Z",
        endAt: "2026-08-16T14:00:00.000Z",
        current: false,
      },
      {
        round: 3,
        startAt: "2026-08-22T14:00:00.000Z",
        endAt: "2026-08-23T16:00:00.000Z",
        current: true,
      },
    ],
  );
});

test("published snapshot binds match IDs and URLs to a championship tour", () => {
  const db = database();
  saveExpected11TourUrls(
    {
      league: "premier-league",
      tour: 1,
      urls: "https://expected11.com/match/33/other",
    },
    db,
  );
  const result = importExpected11ForTour(
    {
      schemaVersion: 2,
      extractedAt: "2026-08-19T18:46:27.033Z",
      matches: [
        {
          sourceUrl: "https://expected11.com/match/19729150/millwall-vs-norwich-city",
          extractedAt: "2026-08-19T18:46:27.033Z",
          id: "19729150",
          title: "Millwall vs Norwich City",
          homeTeam: "Millwall",
          awayTeam: "Norwich City",
          formations: [],
          teams: [
            {
              side: "home",
              name: "Millwall",
              logoUrl: null,
              lineup: { starting: [], bench: [], out: [] },
              notes: {},
              author: null,
            },
          ],
        },
      ],
    },
    "GB2",
    2,
    db,
  );
  assert.equal(result.league, "championship");
  assert.equal(result.tour, 2);
  assert.equal(result.importedMatches, 1);
  assert.deepEqual(getExpected11TourMatchIds("championship", 2, db), ["19729150"]);
  const other = getExpected11IngestView(
    { includeUrls: true, league: "premier-league", tour: 1 },
    db,
  );
  assert.deepEqual(other.urls, ["https://expected11.com/match/33/other"]);
  const view = getExpected11IngestView(
    { includeUrls: true, league: "championship", tour: 2 },
    db,
  );
  assert.equal(view.matchCount, 1);
  assert.deepEqual(view.urls, [
    "https://expected11.com/match/19729150/millwall-vs-norwich-city",
  ]);
  assert.equal(view.lastError, null);
});

test("published snapshot records stub URLs without failing the tour bind", () => {
  const db = database();
  const result = importExpected11ForTour(
    {
      schemaVersion: 2,
      extractedAt: "2026-08-19T21:47:21.386Z",
      matches: [
        {
          sourceUrl: "https://expected11.com/match/19729150/millwall-vs-norwich-city",
          extractedAt: "2026-08-19T21:47:21.386Z",
          id: "19729150",
          title: "Millwall vs Norwich City",
          homeTeam: "Millwall",
          awayTeam: "Norwich City",
          formations: [],
          teams: [
            {
              side: "home",
              name: "Millwall",
              logoUrl: null,
              lineup: {
                starting: [
                  {
                    name: "Player",
                    displayedPercentage: 80,
                    playerPath: "/player/1/player",
                  },
                ],
                bench: [],
                out: [],
              },
              notes: {},
              author: null,
            },
          ],
        },
      ],
      skipped: [
        {
          url: "https://expected11.com/match/19746637/erzurumspor-fk-vs-galatasaray",
          error: "expected11_match_has_no_predictions",
        },
      ],
    },
    "championship",
    2,
    db,
  );
  assert.equal(result.importedMatches, 1);
  assert.equal(result.importedPlayers, 1);
  assert.equal(result.skipped?.length, 1);
  const view = getExpected11IngestView(
    { includeUrls: true, league: "championship", tour: 2 },
    db,
  );
  assert.equal(view.matchCount, 1);
  assert.deepEqual(view.skipped, [
    {
      url: "https://expected11.com/match/19746637/erzurumspor-fk-vs-galatasaray",
      error: "expected11_match_has_no_predictions",
    },
  ]);
  assert.ok(
    view.urls?.includes(
      "https://expected11.com/match/19729150/millwall-vs-norwich-city",
    ),
  );
});

test("published snapshot merges extra matches into an existing tour", () => {
  const db = database();
  importExpected11ForTour(
    {
      schemaVersion: 2,
      extractedAt: "2026-08-19T18:46:27.033Z",
      matches: [
        tourMatch("19729150", "millwall-vs-norwich-city", "Millwall vs Norwich City"),
      ],
    },
    "championship",
    2,
    db,
  );
  const result = importExpected11ForTour(
    {
      schemaVersion: 2,
      extractedAt: "2026-08-19T21:10:00.000Z",
      matches: [
        tourMatch(
          "19729166",
          "wolves-vs-blackburn",
          "Wolves vs Blackburn",
          "2026-08-19T21:10:00.000Z",
        ),
      ],
      skipped: [
        {
          url: "https://expected11.com/match/19746637/erzurumspor-fk-vs-galatasaray",
          error: "expected11_match_has_no_predictions",
        },
      ],
    },
    "championship",
    2,
    db,
  );
  assert.equal(result.importedMatches, 1);
  assert.deepEqual(getExpected11TourMatchIds("championship", 2, db), [
    "19729150",
    "19729166",
  ]);
  const view = getExpected11IngestView(
    { includeUrls: true, league: "championship", tour: 2 },
    db,
  );
  assert.equal(view.matchCount, 2);
  assert.deepEqual(view.urls, [
    "https://expected11.com/match/19729150/millwall-vs-norwich-city",
    "https://expected11.com/match/19729166/wolves-vs-blackburn",
    "https://expected11.com/match/19746637/erzurumspor-fk-vs-galatasaray",
  ]);
  assert.deepEqual(view.skipped, [
    {
      url: "https://expected11.com/match/19746637/erzurumspor-fk-vs-galatasaray",
      error: "expected11_match_has_no_predictions",
    },
  ]);
});

test("later predicted import clears a previous stub skip without dropping other matches", () => {
  const db = database();
  importExpected11ForTour(
    {
      schemaVersion: 2,
      extractedAt: "2026-08-19T18:46:27.033Z",
      matches: [
        tourMatch("19729150", "millwall-vs-norwich-city", "Millwall vs Norwich City"),
      ],
      skipped: [
        {
          url: "https://expected11.com/match/19729166/wolves-vs-blackburn",
          error: "expected11_match_has_no_predictions",
        },
      ],
    },
    "championship",
    2,
    db,
  );
  importExpected11ForTour(
    {
      schemaVersion: 2,
      extractedAt: "2026-08-19T21:10:00.000Z",
      matches: [
        tourMatch(
          "19729166",
          "wolves-vs-blackburn",
          "Wolves vs Blackburn",
          "2026-08-19T21:10:00.000Z",
        ),
      ],
    },
    "championship",
    2,
    db,
  );
  const view = getExpected11IngestView(
    { includeUrls: true, league: "championship", tour: 2 },
    db,
  );
  assert.deepEqual(getExpected11TourMatchIds("championship", 2, db), [
    "19729150",
    "19729166",
  ]);
  assert.deepEqual(view.skipped, []);
});

test("import scope requires championship and tour", () => {
  assert.deepEqual(parseExpected11ImportScope({ league: "championship", tour: 2 }), {
    league: "championship",
    tour: 2,
  });
  assert.deepEqual(parseExpected11ImportScope({ championship: "GB2", tour: 2 }), {
    league: "championship",
    tour: 2,
  });
  assert.throws(
    () => parseExpected11ImportScope({ league: "championship" }),
    (error) =>
      error instanceof Expected11IngestError && error.code === "invalid_expected11_tour",
  );
});
