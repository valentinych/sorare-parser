import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";

const dir = mkdtempSync(path.join(tmpdir(), "mantra-tours-cache-"));
const dbPath = path.join(dir, "app.db");
process.env.DB_PATH = dbPath;
config.dbPath = dbPath;

const { setMeta } = await import("../db/index.js");
const { mantraToursSyncedMetaKey } = await import("../lib/liveLeagues.js");
const {
  getMantraToursCached,
  resetMantraToursCacheForTests,
} = await import("./syncMantraTours.js");

test("getMantraToursCached reloads when live-poll advances sync_meta", () => {
  resetMantraToursCacheForTests();

  const file = path.join(dir, "mantra-tours-championship.json");
  const staleAt = "2026-08-29T15:02:00.000Z";
  const freshAt = "2026-08-29T16:07:00.000Z";
  const tour = (score: number) => [
    {
      tourId: 1,
      leagueId: 1,
      division: "A1",
      name: "Test",
      label: "A1 | Test",
      round: 3,
      live: false,
      url: "https://example/tours/1",
      matches: [
        {
          matchId: 80099,
          url: "https://example/matches/80099",
          locked: true,
          home: {
            teamId: 1,
            teamName: "Home",
            logoUrl: null,
            score,
            scoredCount: 11,
            goals: 2,
          },
          away: {
            teamId: 2,
            teamName: "Away",
            logoUrl: null,
            score: 80,
            scoredCount: 11,
            goals: 1,
          },
        },
      ],
      deadline: null,
      deadlineLabel: null,
      syncedAt: staleAt,
    },
  ];

  writeFileSync(
    file,
    JSON.stringify({ syncedAt: staleAt, tours: tour(83.3), slug: "championship" }),
  );
  setMeta(mantraToursSyncedMetaKey("championship"), staleAt);

  const first = getMantraToursCached("championship");
  assert.equal(first.syncedAt, staleAt);
  assert.equal(first.tours[0]?.matches[0]?.home.score, 83.3);

  writeFileSync(
    file,
    JSON.stringify({ syncedAt: freshAt, tours: tour(88.8), slug: "championship" }),
  );
  setMeta(mantraToursSyncedMetaKey("championship"), freshAt);

  const second = getMantraToursCached("championship");
  assert.equal(second.syncedAt, freshAt);
  assert.equal(second.tours[0]?.matches[0]?.home.score, 88.8);
});
