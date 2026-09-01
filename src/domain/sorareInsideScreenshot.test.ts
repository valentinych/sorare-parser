import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clubFileSlug,
  findLineupClubAnchorInHtml,
  isSorareInsideGamesApiUrl,
  lineupTeamLabelsMatch,
  leagueLabel,
  listSorareCapturedClubs,
  mergeSorareInsideProbabilities,
  remainingSorareCaptureSides,
  isSorareSideCapturedOnDisk,
  parseBenchAndDnpPlayerLists,
  parseProbabilitiesFromModalText,
  parseSorareInsideCaptureRequest,
  parseSorareInsideDiscoverRequest,
  parseSorareInsideExpandRequest,
  parseSorareInsideGamesPayload,
  parseSorareInsideGwSlug,
  parseSorareInsideLineupsUrl,
  sorareTourClubGreenScreenshotPath,
  sorareTourClubScreenshotPath,
} from "./sorareInsideScreenshot.js";

test("parseSorareInsideLineupsUrl accepts full URL and bare slug", () => {
  const fromUrl = parseSorareInsideLineupsUrl(
    "https://sorareinside.com/lineups?gwSlug=football-28-aug-1-sep-2026&foo=1",
  );
  assert.equal(fromUrl.gwSlug, "football-28-aug-1-sep-2026");
  assert.equal(
    fromUrl.url,
    "https://sorareinside.com/lineups?gwSlug=football-28-aug-1-sep-2026",
  );

  const fromSlug = parseSorareInsideLineupsUrl("football-28-aug-1-sep-2026");
  assert.equal(fromSlug.gwSlug, "football-28-aug-1-sep-2026");
  assert.match(fromSlug.url, /gwSlug=football-28-aug-1-sep-2026/);
});

test("parseSorareInsideGwSlug rejects junk", () => {
  assert.throws(() => parseSorareInsideGwSlug(""), /non-empty/);
  assert.throws(() => parseSorareInsideGwSlug("bad slug!"), /Invalid/);
});

test("parseSorareInsideDiscoverRequest requires url or gwSlug", () => {
  assert.equal(
    parseSorareInsideDiscoverRequest({ gwSlug: "football-28-aug-1-sep-2026" }).gwSlug,
    "football-28-aug-1-sep-2026",
  );
  assert.throws(() => parseSorareInsideDiscoverRequest({}), /url|gwSlug/);
});

test("parseSorareInsideExpandRequest validates rounds", () => {
  const parsed = parseSorareInsideExpandRequest({
    leagues: [
      { id: "liga-pro", round: 3 },
      { id: "liga-pro", round: 4 },
      { id: "bundesliga", round: "2" },
    ],
  });
  assert.deepEqual(parsed.leagues, [
    { id: "liga-pro", round: 3 },
    { id: "bundesliga", round: 2 },
  ]);
  assert.throws(
    () => parseSorareInsideExpandRequest({ leagues: [{ id: "x" }] }),
    /round/,
  );
});

test("lineupTeamLabelsMatch treats FC suffix and ellipsis as the same club", () => {
  assert.equal(lineupTeamLabelsMatch("Middlesbrough", "Middlesbrough FC"), true);
  assert.equal(lineupTeamLabelsMatch("Middlesbrough FC", "Middlesbrough"), true);
  assert.equal(lineupTeamLabelsMatch("Middlesbrough…", "Middlesbrough FC"), true);
  assert.equal(lineupTeamLabelsMatch("Middlesbrough...", "Middlesbrough FC"), true);
  assert.equal(lineupTeamLabelsMatch("Millwall FC", "Millwall"), true);
  assert.equal(lineupTeamLabelsMatch("Blackburn Rovers", "Middlesbrough FC"), false);
  assert.equal(lineupTeamLabelsMatch("Manchester", "Manchester City"), false);
});

test("lineupTeamLabelsMatch accepts short / fixture labels like Preston", () => {
  assert.equal(lineupTeamLabelsMatch("Preston", "Preston North End FC"), true);
  assert.equal(lineupTeamLabelsMatch("Preston North End", "Preston North End FC"), true);
  assert.equal(
    lineupTeamLabelsMatch("Preston North End vs Hull City", "Preston North End FC"),
    true,
  );
  assert.equal(
    lineupTeamLabelsMatch("Hull City vs Preston North End", "Preston North End FC"),
    true,
  );
  assert.equal(lineupTeamLabelsMatch("Ipswich", "Ipswich Town"), true);
  assert.equal(lineupTeamLabelsMatch("Blackburn", "Preston North End FC"), false);
});

test("lineupTeamLabelsMatch accepts Championship vs-rows and West Brom truncation", () => {
  const row = [
    "Updated 10 minutes ago",
    "Wed, Sep 2 – 8:45 PM",
    "Updated 2 days ago",
    "West Bromwich Albion FC",
    "vs",
    "Charlton Athletic FC",
  ].join("\n");
  assert.equal(lineupTeamLabelsMatch(row, "West Bromwich Albion FC"), true);
  assert.equal(
    lineupTeamLabelsMatch(
      "West Bromwich Albion FC vs Charlton Athletic FC",
      "West Bromwich Albion FC",
    ),
    true,
  );
  assert.equal(
    lineupTeamLabelsMatch("West Bromwich Albion", "West Bromwich Albion FC"),
    true,
  );
  assert.equal(lineupTeamLabelsMatch("West Brom", "West Bromwich Albion FC"), true);
  assert.equal(
    lineupTeamLabelsMatch(
      "Preston North End FC vs Bristol City FC",
      "Preston North End FC",
    ),
    true,
  );
});

test("findLineupClubAnchorInHtml clicks the visible Championship anchor, not the Select option", () => {
  const html = readFileSync(
    new URL("./sorareInsideLineupRow.fixture.html", import.meta.url),
    "utf8",
  );
  const birmingham = findLineupClubAnchorInHtml(html, "Birmingham City FC");
  assert.equal(birmingham.ok, true);
  assert.equal(birmingham.text, "Birmingham City FC");
  assert.equal(birmingham.tag, "A");
  assert.match(String(birmingham.cls), /mantine-Anchor-root/);

  const westBrom = findLineupClubAnchorInHtml(html, "West Bromwich Albion FC");
  assert.equal(westBrom.ok, true);
  assert.equal(westBrom.text, "West Bromwich Albion FC");

  const preston = findLineupClubAnchorInHtml(html, "Preston North End FC");
  assert.equal(preston.ok, true);
  assert.equal(preston.text, "Preston North End FC");

  assert.equal(findLineupClubAnchorInHtml(html, "Not A Club FC").ok, false);
});

test("parseSorareInsideCaptureRequest + path helpers", () => {
  const req = parseSorareInsideCaptureRequest({
    gameId: "g1",
    side: "home",
    round: 3,
    teamName: "Millwall FC",
  });
  assert.equal(req.round, 3);
  assert.equal(clubFileSlug(req.teamName!), "millwall");
  assert.equal(sorareTourClubScreenshotPath(3, "Millwall FC"), "3/millwall.png");
  assert.equal(
    sorareTourClubGreenScreenshotPath(3, "Millwall FC"),
    "3/millwall-green.png",
  );
});

test("leagueLabel formats region - competition", () => {
  assert.equal(
    leagueLabel("Argentina", "Liga Professional Argentina"),
    "Argentina - Liga Professional Argentina",
  );
  assert.equal(leagueLabel("England", "England Premier League"), "England Premier League");
});

test("parseSorareInsideGamesPayload flattens regions", () => {
  const { leagues, matches } = parseSorareInsideGamesPayload({
    data: [
      {
        regionCode: "AR",
        regionName: "Argentina",
        competitions: [
          {
            id: "liga-pro",
            name: "Liga Professional Argentina",
            games: [
              {
                id: "game-1",
                date: "2026-08-29T00:00:00.000Z",
                homeTeam: { name: "Boca Juniors", slug: "boca-juniors" },
                awayTeam: { name: "River Plate", slug: "river-plate" },
                homeTeamLineup: { id: "lu-home" },
                awayTeamLineup: { id: null },
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(leagues.length, 1);
  assert.equal(leagues[0].label, "Argentina - Liga Professional Argentina");
  assert.equal(leagues[0].lineupCount, 1);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].home.lineupId, "lu-home");
  assert.equal(matches[0].away.lineupId, null);
});

test("isSorareInsideGamesApiUrl", () => {
  assert.equal(
    isSorareInsideGamesApiUrl(
      "https://platform-api.sorareinside.com/games?gameweekSlug=football-28-aug-1-sep-2026",
    ),
    true,
  );
  assert.equal(
    isSorareInsideGamesApiUrl("https://platform-api.sorareinside.com/lineups"),
    false,
  );
});

test("parseProbabilitiesFromModalText extracts player percentages", () => {
  const players = parseProbabilitiesFromModalText(`
Boca Juniors
Marcos Rojo 75%
Edinson Cavani 90%
Some note without percent
Foo 101%
`);
  assert.deepEqual(
    players.map((p) => [p.name, p.percentage]),
    [
      ["Marcos Rojo", 75],
      ["Edinson Cavani", 90],
    ],
  );
});

test("parseProbabilitiesFromModalText accepts name and % on adjacent lines", () => {
  const players = parseProbabilitiesFromModalText(`
Starting XI
Cole Palmer
85%
Nicolas Jackson
60%
Comments
`);
  assert.deepEqual(
    players.map((p) => [p.name, p.percentage]),
    [
      ["Cole Palmer", 85],
      ["Nicolas Jackson", 60],
    ],
  );
});

test("parseBenchAndDnpPlayerLists defaults bench to 10% and DNP to out", () => {
  const players = parseBenchAndDnpPlayerLists(`
Bench Players
Dermot Mee
Thomas Heaton 25%
Joshua Zirkzee
DNP Players
Manuel Ugarte
Amad Diallo
Comments
`);
  assert.deepEqual(
    players.map((p) => [p.name, p.percentage, p.rawLabel, p.group]),
    [
      ["Dermot Mee", 10, "10%", "bench"],
      ["Thomas Heaton", 25, "Thomas Heaton 25%", "bench"],
      ["Joshua Zirkzee", 10, "10%", "bench"],
      ["Manuel Ugarte", null, "out", "out"],
      ["Amad Diallo", null, "out", "out"],
    ],
  );
});

test("listSorareCapturedClubs reads png/json from tour folder", () => {
  const root = mkdtempSync(join(tmpdir(), "sorare-cap-"));
  const tourDir = join(root, "2");
  mkdirSync(tourDir, { recursive: true });
  writeFileSync(join(tourDir, "southampton.png"), "x");
  writeFileSync(join(tourDir, "southampton-green.png"), "x");
  writeFileSync(
    join(tourDir, "southampton.json"),
    JSON.stringify({
      capturedAt: "2026-08-28T12:00:00.000Z",
      probabilities: [{ name: "A", percentage: 80 }],
    }),
  );
  const clubs = listSorareCapturedClubs(root, 2);
  assert.equal(clubs.length, 1);
  assert.deepEqual(clubs[0], {
    clubSlug: "southampton",
    png: true,
    green: true,
    json: true,
    probabilities: 1,
    capturedAt: "2026-08-28T12:00:00.000Z",
  });
  assert.deepEqual(listSorareCapturedClubs(root, 9), []);
});

test("remainingSorareCaptureSides skips clubs that already have png or json", () => {
  const root = mkdtempSync(join(tmpdir(), "sorare-remain-"));
  const tourDir = join(root, "3");
  mkdirSync(tourDir, { recursive: true });
  writeFileSync(join(tourDir, "millwall.png"), "x");
  writeFileSync(join(tourDir, "millwall.json"), "{}");
  writeFileSync(join(tourDir, "southampton.png"), "x");
  writeFileSync(join(tourDir, "leeds-united.json"), "{}");
  writeFileSync(join(tourDir, "only-green-green.png"), "x");
  const clubs = listSorareCapturedClubs(root, 3);
  const bySlug = Object.fromEntries(clubs.map((c) => [c.clubSlug, c]));
  assert.equal(isSorareSideCapturedOnDisk(bySlug.millwall), true);
  assert.equal(isSorareSideCapturedOnDisk(bySlug.southampton), true);
  assert.equal(isSorareSideCapturedOnDisk(bySlug["leeds-united"]), true);
  assert.equal(isSorareSideCapturedOnDisk(bySlug["only-green"]), false);
  assert.equal(isSorareSideCapturedOnDisk(undefined), false);
  const side = (teamName: string, lineupId: string | null) => ({
    teamName,
    teamSlug: null,
    lineupId,
    pictureUrl: null,
  });
  const remaining = remainingSorareCaptureSides(
    [
      {
        gameId: "g1",
        leagueId: "champ",
        leagueLabel: "Championship",
        date: null,
        home: side("Millwall FC", "h1"),
        away: side("West Bromwich Albion", "a1"),
      },
      {
        gameId: "g2",
        leagueId: "champ",
        leagueLabel: "Championship",
        date: null,
        home: side("TBD", null),
        away: side("Only Green", "a2"),
      },
      {
        gameId: "g3",
        leagueId: "champ",
        leagueLabel: "Championship",
        date: null,
        home: side("Southampton FC", "h3"),
        away: side("Leeds United", "a3"),
      },
    ],
    new Map([["champ", 3]]),
    new Map([[3, bySlug]]),
  );
  assert.deepEqual(
    remaining.map((r) => `${r.side}:${clubFileSlug(r.teamName)}`),
    ["away:west-bromwich-albion", "away:only-green"],
  );
});

test("mergeSorareInsideProbabilities prefers pitch names over bench/dnp", () => {
  const merged = mergeSorareInsideProbabilities(
    [{ name: "Bruno Fernandes", percentage: 90, rawLabel: "90%", group: "starting" }],
    [
      { name: "Bruno Fernandes", percentage: 10, rawLabel: "10%", group: "bench" },
      { name: "Joshua Zirkzee", percentage: 10, rawLabel: "10%", group: "bench" },
      { name: "Amad Diallo", percentage: null, rawLabel: "out", group: "out" },
    ],
  );
  assert.deepEqual(
    merged.map((p) => [p.name, p.percentage, p.group]),
    [
      ["Bruno Fernandes", 90, "starting"],
      ["Joshua Zirkzee", 10, "bench"],
      ["Amad Diallo", null, "out"],
    ],
  );
});

test("parseSorareOutputDir resolves relative and absolute folders", async () => {
  const {
    displaySorareOutputDir,
    loadSorareOutputDirConfig,
    parseSorareOutputDir,
    saveSorareOutputDirConfig,
  } = await import("./sorareInsideScreenshot.js");
  const root = mkdtempSync(join(tmpdir(), "sorare-out-"));
  assert.equal(
    parseSorareOutputDir("data/sorare/output", root),
    join(root, "data/sorare/output"),
  );
  const abs = join(root, "shots");
  assert.equal(parseSorareOutputDir(abs, root), abs);
  assert.throws(() => parseSorareOutputDir("  ", root), /outputDir/);
  assert.equal(
    displaySorareOutputDir(join(root, "data/sorare/output"), root),
    "data/sorare/output",
  );
  assert.equal(loadSorareOutputDirConfig(root), null);
  saveSorareOutputDirConfig(root, abs);
  assert.equal(loadSorareOutputDirConfig(root), abs);
});
