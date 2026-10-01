import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import type { MantraTourRound } from "../clients/mantraAuth.js";

const dir = mkdtempSync(path.join(tmpdir(), "mantra-tours-archive-"));
const dbPath = path.join(dir, "app.db");
process.env.DB_PATH = dbPath;
config.dbPath = dbPath;

const { getDb } = await import("../db/index.js");
getDb();
const {
  archiveHistoricalMantraTours,
  resetMantraToursCacheForTests,
} = await import("./syncMantraTours.js");

function tour(partial: {
  tourId: number;
  leagueId: number;
  division: string;
  round: number;
}): MantraTourRound {
  return {
    tourId: partial.tourId,
    leagueId: partial.leagueId,
    division: partial.division,
    name: partial.division,
    label: `${partial.division} | Test`,
    round: partial.round,
    live: false,
    url: `https://mantrafootball.org/tours/${partial.tourId}`,
    matches: [
      {
        matchId: partial.tourId,
        url: null,
        locked: true,
        home: {
          teamId: partial.leagueId,
          teamName: "Home",
          logoUrl: null,
          score: 80,
          scoredCount: 11,
          goals: 2,
        },
        away: {
          teamId: partial.leagueId + 1,
          teamName: "Away",
          logoUrl: null,
          score: 70,
          scoredCount: 11,
          goals: 1,
        },
      },
    ],
    deadline: null,
    deadlineLabel: null,
    syncedAt: "2026-09-24T10:00:00.000Z",
  };
}

function writeLive(slug: string, tours: MantraTourRound[]): string {
  const file = path.join(dir, `mantra-tours-${slug}.json`);
  writeFileSync(
    file,
    JSON.stringify({ syncedAt: "2026-09-24T10:00:00.000Z", tours, slug }, null, 2),
  );
  return file;
}

test("archiveHistoricalMantraTours walks back extra-league tour ids without touching live file", async () => {
  resetMantraToursCacheForTests();
  const liveTours = [
    tour({ tourId: 106, leagueId: 732, division: "A1", round: 6 }),
    tour({ tourId: 206, leagueId: 733, division: "A2", round: 6 }),
  ];
  const liveFile = writeLive("ligue-1", liveTours);
  const before = readFileSync(liveFile, "utf8");
  const fetched: number[] = [];

  const result = await archiveHistoricalMantraTours("ligue-1", {
    wantedRounds: [4, 5, 6],
    fetchTour: async (tourId, meta) => {
      fetched.push(tourId);
      const round = tourId % 100;
      return tour({
        tourId,
        leagueId: meta.leagueId!,
        division: String(meta.division),
        round,
      });
    },
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.archivedRounds, [4, 5, 6]);
  assert.deepEqual(result.missingRounds, []);
  assert.deepEqual(fetched.sort((a, b) => a - b), [104, 105, 204, 205]);
  assert.equal(readFileSync(liveFile, "utf8"), before);

  const r5 = JSON.parse(readFileSync(path.join(dir, "mantra-tours-ligue-1-r5.json"), "utf8"));
  assert.equal(r5.round, 5);
  assert.equal(r5.tours.length, 2);
  assert.ok(r5.tours.every((item: MantraTourRound) => item.round === 5));
});

test("archiveHistoricalMantraTours skips divisions already in the round archive", async () => {
  resetMantraToursCacheForTests();
  writeLive("jupiler-pro-league", [
    tour({ tourId: 308, leagueId: 641, division: "A1", round: 8 }),
  ]);
  writeFileSync(
    path.join(dir, "mantra-tours-jupiler-pro-league-r7.json"),
    JSON.stringify({
      syncedAt: "2026-09-20T00:00:00.000Z",
      round: 7,
      slug: "jupiler-pro-league",
      tours: [tour({ tourId: 307, leagueId: 641, division: "A1", round: 7 })],
    }),
  );
  let calls = 0;
  const result = await archiveHistoricalMantraTours("jupiler-pro-league", {
    wantedRounds: [7],
    fetchTour: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
  });
  assert.equal(result.error, null);
  assert.equal(calls, 0);
  assert.ok(result.skippedExisting.includes(7));
});

test("archiveHistoricalMantraTours refuses original six live leagues", async () => {
  resetMantraToursCacheForTests();
  writeLive("premier-league", [
    tour({ tourId: 6, leagueId: 684, division: "A1", round: 6 }),
  ]);
  const result = await archiveHistoricalMantraTours("premier-league", {
    wantedRounds: [1, 2],
    fetchTour: async () => {
      throw new Error("must not hit Mantra for premier-league");
    },
  });
  assert.equal(result.error, "not a tables extra league");
  assert.equal(result.fetched, 0);
});

test("archiveHistoricalMantraTours records a hole when past tour pages 404", async () => {
  resetMantraToursCacheForTests();
  writeLive("eredivisie", [
    tour({ tourId: 408, leagueId: 634, division: "A1", round: 8 }),
  ]);
  const result = await archiveHistoricalMantraTours("eredivisie", {
    wantedRounds: [1],
    fetchTour: async (tourId) => {
      throw new Error(`Mantra /tours/${tourId} → 404`);
    },
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.missingRounds, [1]);
});
