import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildFootmopsSnapshotFromSorareCaptures,
  mapSorareLeagueLabelToSlug,
  normalizeFootmopsImportPayload,
  parseSorareFootmopsPublishRequest,
} from "./sorareFootmopsPublish.js";

test("mapSorareLeagueLabelToSlug maps common SorareInside labels", () => {
  assert.equal(
    mapSorareLeagueLabelToSlug("England - Premier League"),
    "premier-league",
  );
  assert.equal(
    mapSorareLeagueLabelToSlug("England - Championship"),
    "championship",
  );
  assert.equal(mapSorareLeagueLabelToSlug("championship"), "championship");
  assert.equal(mapSorareLeagueLabelToSlug("Türkiye - Süper Lig"), "super-lig");
  assert.equal(mapSorareLeagueLabelToSlug("Turkey - Super Lig"), "super-lig");
  assert.equal(mapSorareLeagueLabelToSlug("Unknown Cup"), null);
});

test("buildFootmopsSnapshotFromSorareCaptures stops DNP after page chrome", () => {
  const root = path.join(os.tmpdir(), `sorare-fm-chrome-${Date.now()}`);
  mkdirSync(path.join(root, "4"), { recursive: true });
  writeFileSync(
    path.join(root, "4", "juventus.json"),
    JSON.stringify({
      capturedAt: "2026-09-11T14:10:58.716Z",
      teamName: "Juventus FC",
      leagueLabel: "Italy - Serie A",
      round: 4,
      probabilities: [
        { name: "Pierre Kalulu", percentage: 70, group: "starting" },
        { name: "Bremer", percentage: null, group: "out" },
        { name: "Jhon Lucumí", percentage: null, group: "out" },
        { name: "SorareInside.com", percentage: null, group: "out" },
        { name: "First published: 6 days ago", percentage: null, group: "out" },
        { name: "Manuel Locatelli", percentage: null, group: "out" },
        { name: "Kenan Yıldız", percentage: null, group: "out" },
      ],
    }),
  );

  const snapshot = buildFootmopsSnapshotFromSorareCaptures(root, {
    league: "serie-a",
    tour: 4,
  });
  assert.deepEqual(
    snapshot.matches[0]!.teams[0]!.players.map((row) => row.name),
    ["Pierre Kalulu", "Bremer", "Jhon Lucumí"],
  );
  assert.equal(
    snapshot.matches[0]!.teams[0]!.players.find((row) => row.name === "Bremer")
      ?.group,
    "out",
  );

  rmSync(root, { recursive: true, force: true });
});

test("buildFootmopsSnapshotFromSorareCaptures filters by league and skips junk", () => {
  const root = path.join(os.tmpdir(), `sorare-fm-${Date.now()}`);
  mkdirSync(path.join(root, "3"), { recursive: true });
  writeFileSync(
    path.join(root, "3", "cardiff-city.json"),
    JSON.stringify({
      capturedAt: "2026-08-28T12:00:00.000Z",
      teamName: "Cardiff City FC",
      leagueLabel: "England - Championship",
      round: 3,
      probabilities: [
        { name: "Player A", percentage: 80, group: "starting" },
        { name: "Player B", percentage: 20, group: "bench" },
        { name: "% + PS", percentage: 10, group: "bench" },
        { name: "Injured", percentage: null, group: "out" },
      ],
    }),
  );
  writeFileSync(
    path.join(root, "3", "arsenal.json"),
    JSON.stringify({
      teamName: "Arsenal FC",
      leagueLabel: "England - Premier League",
      probabilities: [
        { name: "Saka", percentage: 90, group: "starting" },
      ],
    }),
  );

  const snapshot = buildFootmopsSnapshotFromSorareCaptures(root, {
    league: "championship",
    tour: 3,
  });
  assert.equal(snapshot.league, "championship");
  assert.equal(snapshot.tour, 3);
  assert.equal(snapshot.matches.length, 1);
  assert.equal(snapshot.matches[0]!.teams[0]!.name, "Cardiff City FC");
  assert.deepEqual(snapshot.matches[0]!.teams[0]!.players, [
    { name: "Player A", percentage: 80, group: "starting" },
    { name: "Player B", percentage: 20, group: "bench" },
    { name: "Injured", percentage: null, group: "out" },
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("parseSorareFootmopsPublishRequest accepts scopes and leagueLabel", () => {
  assert.deepEqual(
    parseSorareFootmopsPublishRequest({
      scopes: [{ leagueLabel: "England - Championship", tour: 3 }],
    }),
    [{ league: "championship", tour: 3 }],
  );
  assert.deepEqual(
    parseSorareFootmopsPublishRequest({ league: "premier-league", tour: 2 }),
    [{ league: "premier-league", tour: 2 }],
  );
});

test("normalizeFootmopsImportPayload validates league and players", () => {
  const snapshot = normalizeFootmopsImportPayload({
    league: "championship",
    tour: 2,
    matches: [
      {
        home: "Cardiff",
        away: "",
        teams: [
          {
            name: "Cardiff",
            players: [
              { name: "Alpha", percentage: 70, group: "starting" },
              { name: "Bravo", percentage: 30, group: "bench" },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(snapshot.league, "championship");
  assert.equal(snapshot.matches[0]!.teams[0]!.players.length, 2);
});
