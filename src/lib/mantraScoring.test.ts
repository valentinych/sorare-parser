import assert from "node:assert/strict";
import test from "node:test";
import { fantasyGoalsFromTeamScore, scorePlayer, type PlayerMatchStats } from "./mantraScoring.js";

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

test("CS requires at least 60 FotMob minutes (Mantra: ≥60, not >60)", () => {
  const sixty = scorePlayer({
    native: ["RB"],
    slotAccepted: ["RB"],
    stats: stats({ minutes: 60 }),
    teamCleanSheet: true,
  });
  assert.ok(sixty?.events.some((e) => e.key === "cs"));
  assert.equal(sixty?.events.find((e) => e.key === "cs")?.delta, 1);

  const fiftyNine = scorePlayer({
    native: ["RB"],
    slotAccepted: ["RB"],
    stats: stats({ minutes: 59 }),
    teamCleanSheet: true,
  });
  assert.ok(!fiftyNine?.events.some((e) => e.key === "cs"));
});

test("CS eligible for GK/DEF/DM/WB, not MID/ATT", () => {
  const winger = scorePlayer({
    native: ["W"],
    slotAccepted: ["W"],
    stats: stats({ minutes: 90 }),
    teamCleanSheet: true,
  });
  assert.ok(!winger?.events.some((e) => e.key === "cs"));

  const dm = scorePlayer({
    native: ["DM"],
    slotAccepted: ["DM"],
    stats: stats({ minutes: 90 }),
    teamCleanSheet: true,
  });
  assert.equal(dm?.events.find((e) => e.key === "cs")?.delta, 0.5);
});

test("CS uses Dream Team slot, not only native: DM/AM in AM has no CS", () => {
  const hinshelwood = {
    native: ["DM", "AM"],
    stats: stats({ rating: 9.01, minutes: 90, goals: 2 }),
    teamCleanSheet: true,
  };

  const inAm = scorePlayer({ ...hinshelwood, slotAccepted: ["AM"] });
  assert.ok(!inAm?.events.some((e) => e.key === "cs"));
  assert.equal(inAm?.total, 14.01);

  const inDm = scorePlayer({ ...hinshelwood, slotAccepted: ["DM"] });
  assert.equal(inDm?.events.find((e) => e.key === "cs")?.delta, 0.5);
  assert.equal(inDm?.total, 14.51);

  const cbInCb = scorePlayer({
    native: ["CB"],
    slotAccepted: ["CB"],
    stats: stats({ minutes: 90 }),
    teamCleanSheet: true,
  });
  assert.equal(cbInCb?.events.find((e) => e.key === "cs")?.delta, 1.0);

  const amInAm = scorePlayer({
    native: ["AM"],
    slotAccepted: ["AM"],
    stats: stats({ minutes: 90 }),
    teamCleanSheet: true,
  });
  assert.ok(!amInAm?.events.some((e) => e.key === "cs"));

  const amInAmFw = scorePlayer({
    native: ["AM"],
    slotAccepted: ["AM", "FW"],
    stats: stats({ minutes: 90 }),
    teamCleanSheet: true,
  });
  assert.ok(!amInAmFw?.events.some((e) => e.key === "cs"));
});

test("fantasyGoalsFromTeamScore is 72 for 1 goal, then +7 (Mantra match scoreline)", () => {
  assert.equal(fantasyGoalsFromTeamScore(71.99), 0);
  assert.equal(fantasyGoalsFromTeamScore(72), 1);
  assert.equal(fantasyGoalsFromTeamScore(78.99), 1);
  assert.equal(fantasyGoalsFromTeamScore(79), 2);
  assert.equal(fantasyGoalsFromTeamScore(84.9), 2);
  assert.equal(fantasyGoalsFromTeamScore(83.9), 2);
  assert.equal(fantasyGoalsFromTeamScore(86.5), 3);
  assert.equal(fantasyGoalsFromTeamScore(94.39), 4);
  assert.equal(fantasyGoalsFromTeamScore(98.98), 4);
  assert.equal(fantasyGoalsFromTeamScore(88.73), 3);
});
