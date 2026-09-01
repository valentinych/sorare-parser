import assert from "node:assert/strict";
import test from "node:test";
import { scoreLeagueOnePlayerRound } from "./leagueOneReports.js";
import type { PlayerMatchStats } from "../lib/mantraScoring.js";

function stats(over: Partial<PlayerMatchStats> = {}): PlayerMatchStats {
  return {
    rating: 7,
    minutes: 90,
    goals: 0,
    assists: 0,
    yellowCards: 0,
    redCards: 0,
    ownGoals: 0,
    saves: 0,
    goalsConceded: 0,
    penaltiesScored: 0,
    penaltiesMissed: 0,
    penaltiesSaved: 0,
    penaltiesWon: 0,
    penaltiesConceded: 0,
    appeared: true,
    ...over,
  };
}

test("League One reports score with primary slot (first position)", () => {
  const scored = scoreLeagueOnePlayerRound({
    mantraPositions: ["ST", "FW"],
    stats: stats({ goals: 1 }),
    teamCleanSheet: false,
  });
  assert.ok(scored);
  assert.equal(scored.bs, 7);
  // ST goal bonus = +2 → TS 9
  assert.equal(scored.ts, 9);
  assert.ok(!scored.events.some((e) => e.key === "oop"));
});

test("League One reports CS uses primary slot eligibility", () => {
  const dmAm = scoreLeagueOnePlayerRound({
    mantraPositions: ["DM", "AM"],
    stats: stats(),
    teamCleanSheet: true,
  });
  assert.equal(dmAm?.events.find((e) => e.key === "cs")?.delta, 0.5);

  const amDm = scoreLeagueOnePlayerRound({
    mantraPositions: ["AM", "DM"],
    stats: stats(),
    teamCleanSheet: true,
  });
  assert.ok(!amDm?.events.some((e) => e.key === "cs"));
});

test("League One reports skip players without Mantra positions", () => {
  assert.equal(
    scoreLeagueOnePlayerRound({
      mantraPositions: [],
      stats: stats(),
      teamCleanSheet: false,
    }),
    null,
  );
});
