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
  assert.equal(mapSorareLeagueLabelToSlug("Unknown Cup"), null);
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
        { name: "Injured", percentage: 0, group: "out" },
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
