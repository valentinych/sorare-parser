import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  accordionTextMatchesCompetition,
  clubFileSlug,
  findLineupClubAnchorInHtml,
  findLineupAccordionInHtml,
  isSorareInsideGamesApiUrl,
  lineupTeamLabelsMatch,
  leagueLabel,
  listSorareCapturedClubs,
  mergeSorareInsideProbabilities,
  remainingSorareCaptureSides,
  isSorareSideCapturedOnDisk,
  parseBenchAndDnpPlayerLists,
  parseProbabilitiesFromModalText,
  parseProbabilitiesFromPitchCards,
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

test("lineupTeamLabelsMatch strips 1./SV/FC/TSG and folds umlauts for Bundesliga", () => {
  assert.equal(lineupTeamLabelsMatch("1. FSV Mainz 05", "1. FSV Mainz 05"), true);
  assert.equal(lineupTeamLabelsMatch("Mainz 05", "1. FSV Mainz 05"), true);
  assert.equal(lineupTeamLabelsMatch("FC Bayern München", "FC Bayern München"), true);
  assert.equal(lineupTeamLabelsMatch("Bayern Munich", "FC Bayern München"), true);
  assert.equal(lineupTeamLabelsMatch("Borussia Mönchengladbach", "Borussia Mönchengladbach"), true);
  assert.equal(lineupTeamLabelsMatch("Gladbach", "Borussia Mönchengladbach"), true);
  assert.equal(lineupTeamLabelsMatch("Sport-Club Freiburg", "Sport-Club Freiburg"), true);
  assert.equal(lineupTeamLabelsMatch("SC Freiburg", "Sport-Club Freiburg"), true);
  assert.equal(lineupTeamLabelsMatch("Elversberg", "SV 07 Elversberg"), true);
  assert.equal(lineupTeamLabelsMatch("1. FC Köln", "1. FC Köln"), true);
  assert.equal(lineupTeamLabelsMatch("Union Berlin", "1. FC Union Berlin"), true);
  assert.equal(lineupTeamLabelsMatch("Hoffenheim", "TSG Hoffenheim"), true);
  assert.equal(
    lineupTeamLabelsMatch("Borussia Dortmund", "Borussia Mönchengladbach"),
    false,
  );
});

test("findLineupAccordionInHtml picks Germany Bundesliga, not Austria or 2. Bundesliga", () => {
  const html = readFileSync(
    new URL("./sorareInsideBundesligaRow.fixture.html", import.meta.url),
    "utf8",
  );
  const germany = findLineupAccordionInHtml(html, "Bundesliga", "Germany", "Germany - Bundesliga");
  assert.equal(germany.ok, true);
  assert.match(String(germany.text), /1\. Bundesliga|Bundesliga/);
  assert.doesNotMatch(String(germany.text), /2\. Bundesliga/);

  const austria = findLineupAccordionInHtml(html, "Bundesliga", "Austria", "Austria - Bundesliga");
  assert.equal(austria.ok, true);
  assert.match(String(austria.text), /Bundesliga/);
});

test("findLineupClubAnchorInHtml clicks Bundesliga vs-row Anchor, not the Select option", () => {
  const html = readFileSync(
    new URL("./sorareInsideBundesligaRow.fixture.html", import.meta.url),
    "utf8",
  );
  const mainz = findLineupClubAnchorInHtml(html, "1. FSV Mainz 05");
  assert.equal(mainz.ok, true);
  assert.equal(mainz.text, "1. FSV Mainz 05");
  assert.equal(mainz.tag, "A");
  assert.match(String(mainz.cls), /mantine-Anchor-root/);

  const bayern = findLineupClubAnchorInHtml(html, "FC Bayern München");
  assert.equal(bayern.ok, true);
  assert.match(String(bayern.text), /Bayern/);
  assert.match(String(bayern.cls), /mantine-Anchor-root/);

  const gladbach = findLineupClubAnchorInHtml(html, "Borussia Mönchengladbach");
  assert.equal(gladbach.ok, true);
  assert.match(String(gladbach.text), /Mönchengladbach|Gladbach/);

  const freiburg = findLineupClubAnchorInHtml(html, "Sport-Club Freiburg");
  assert.equal(freiburg.ok, true);
  assert.match(String(freiburg.cls), /mantine-Anchor-root/);

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

test("accordion competition match keeps Bundesliga distinct from Bundesliga 2", () => {
  assert.equal(accordionTextMatchesCompetition("Germany - Bundesliga", "Bundesliga"), true);
  assert.equal(accordionTextMatchesCompetition("Bundesliga", "Bundesliga"), true);
  assert.equal(accordionTextMatchesCompetition("1. Bundesliga", "Bundesliga"), true);
  assert.equal(accordionTextMatchesCompetition("Germany - 1. Bundesliga", "Bundesliga"), true);
  assert.equal(accordionTextMatchesCompetition("Germany - Bundesliga 2", "Bundesliga"), false);
  assert.equal(accordionTextMatchesCompetition("2. Bundesliga", "Bundesliga"), false);
  assert.equal(accordionTextMatchesCompetition("Germany - 2. Bundesliga", "Bundesliga"), false);
  assert.equal(accordionTextMatchesCompetition("2. Bundesliga", "2. Bundesliga"), true);
  assert.equal(
    accordionTextMatchesCompetition("Germany - Bundesliga 2", "Germany - Bundesliga"),
    false,
  );
  assert.equal(
    accordionTextMatchesCompetition("Germany - Bundesliga", "Germany - Bundesliga"),
    true,
  );
  // Same hardening for other division pairs.
  assert.equal(accordionTextMatchesCompetition("Spain - Liga 2", "Liga"), false);
  assert.equal(accordionTextMatchesCompetition("Spain - Liga", "Liga"), true);
  assert.equal(accordionTextMatchesCompetition("Championship", "Championship"), true);
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

test("parseProbabilitiesFromModalText maps pitch badge % above the starter name", () => {
  const players = parseProbabilitiesFromModalText(`
80%
53 all
Mohamed Salah
M. Mimaroğlu 20%
80%
Aral Şimşir
N. Saviolo 20%
`);
  const salah = players.find((p) => p.name === "Mohamed Salah");
  const simsir = players.find((p) => p.name === "Aral Şimşir");
  assert.equal(salah?.percentage, 80);
  assert.equal(simsir?.percentage, 80);
});

test("parseProbabilitiesFromPitchCards maps OUT badge to out, not bench 10%", () => {
  const players = parseProbabilitiesFromPitchCards([
    `OUT\nVictor Osimhen`,
    `Victor Osimhen\nOUT`,
    `80%\n53 all\nMohamed Salah\nM. Mimaroğlu 20%`,
  ]);
  const osimhen = players.filter((p) => p.name === "Victor Osimhen");
  assert.equal(osimhen.length, 1);
  assert.equal(osimhen[0]?.group, "out");
  assert.equal(osimhen[0]?.percentage, null);
  assert.equal(players.find((p) => p.name === "Mohamed Salah")?.percentage, 80);
});

test("parseBenchAndDnpPlayerLists does not default OUT/DNP names to 10%", () => {
  const players = parseBenchAndDnpPlayerLists(`
Bench Players
Dermot Mee
Victor Osimhen
OUT
DNP Players
Jayden Oosterwolde
`);
  const osimhen = players.find((p) => p.name === "Victor Osimhen");
  const oosterwolde = players.find((p) => p.name === "Jayden Oosterwolde");
  const mee = players.find((p) => p.name === "Dermot Mee");
  assert.equal(mee?.group, "bench");
  assert.equal(mee?.percentage, 10);
  assert.equal(osimhen?.group, "out");
  assert.equal(osimhen?.percentage, null);
  assert.equal(oosterwolde?.group, "out");
  assert.equal(oosterwolde?.percentage, null);
});

test("parseProbabilitiesFromPitchCards keeps starter badge % and treats grey alt as bench", () => {
  const players = parseProbabilitiesFromPitchCards([
    `80%\n53 all\nMohamed Salah\nM. Mimaroğlu 20%`,
    `60%\n53 all\nPaul Onuachu\nFranculino Djú 40%`,
    `Marcos Rojo 75%`,
  ]);
  assert.deepEqual(
    players.map((p) => [p.name, p.percentage, p.group]),
    [
      ["Mohamed Salah", 80, "starting"],
      ["M. Mimaroğlu", 20, "bench"],
      ["Paul Onuachu", 60, "starting"],
      ["Franculino Djú", 40, "bench"],
      ["Marcos Rojo", 75, "starting"],
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
