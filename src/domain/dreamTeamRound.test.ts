import assert from "node:assert/strict";
import test from "node:test";
import { FORMATION_SLOTS } from "../lib/mantraFormations.js";
import type { PlayerMatchStats } from "../lib/mantraScoring.js";
import {
  fillDreamTeamFormation,
  scoreForDreamTeamSlot,
  type DreamTeamPoolPlayer,
} from "./dreamTeamRound.js";

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

function poolPlayer(
  id: number,
  positions: string[],
  over: Partial<PlayerMatchStats> & { teamCleanSheet?: boolean; name?: string } = {},
): DreamTeamPoolPlayer {
  const { teamCleanSheet = true, name = `P${id}`, ...statOver } = over;
  const s = stats(statOver);
  return {
    fotmobPlayerId: id,
    mantraPlayerId: id,
    name,
    displayName: name,
    clubName: "Club",
    positions,
    stats: s,
    teamCleanSheet,
    goals: s.goals,
    minutes: s.minutes,
    rating: s.rating,
  };
}

test("Dream Team AM slot drops CS that a DM/AM would get in DM", () => {
  const hinshelwood = poolPlayer(9, ["DM", "AM"], {
    name: "Hinshelwood",
    rating: 9.01,
    goals: 2,
  });
  const amSlot = FORMATION_SLOTS["3-4-2-1"]!.find((s) => s.label === "AM")!;
  const dmSlot = FORMATION_SLOTS["3-4-2-1"]!.find((s) => s.label === "DM")!;

  const inAm = scoreForDreamTeamSlot(hinshelwood, amSlot);
  assert.ok(!inAm?.events.some((e) => e.key === "cs"));
  assert.equal(inAm?.total, 14.01);

  const inDm = scoreForDreamTeamSlot(hinshelwood, dmSlot);
  assert.equal(inDm?.events.find((e) => e.key === "cs")?.delta, 0.5);
  assert.equal(inDm?.total, 14.51);
});

test("3-4-2-1 Dream Team scores the occupied slot and keeps CS icons in sync", () => {
  const pool: DreamTeamPoolPlayer[] = [
    poolPlayer(1, ["GK"], { rating: 8.44 }),
    poolPlayer(2, ["CB"], { rating: 8.22 }),
    poolPlayer(3, ["CB"], { rating: 8.01 }),
    poolPlayer(4, ["CB"], { rating: 8.52 }),
    poolPlayer(5, ["WB"], { rating: 8.61 }),
    poolPlayer(6, ["DM"], { rating: 8.35 }),
    poolPlayer(7, ["CM"], { rating: 8.39 }),
    poolPlayer(8, ["W"], { rating: 8.29 }),
    poolPlayer(9, ["DM", "AM"], { name: "Hinshelwood", rating: 9.01, goals: 2 }),
    poolPlayer(10, ["FW"], { rating: 9.08 }),
    poolPlayer(11, ["ST"], { rating: 8.5 }),
  ];

  const xi = fillDreamTeamFormation("3-4-2-1", pool);
  assert.ok(xi);
  const am = xi!.starters.find((p) => p.slotLabel === "AM");
  assert.equal(am?.name, "Hinshelwood");
  assert.equal(am?.breakdown.total, 14.01);
  assert.ok(!am?.breakdown.events.some((e) => e.key === "cs"));

  const cb = xi!.starters.find((p) => p.slotLabel === "CB" && p.fotmobPlayerId === 4);
  assert.equal(cb?.breakdown.events.find((e) => e.key === "cs")?.delta, 1.0);

  const dm = xi!.starters.find((p) => p.slotLabel === "DM");
  assert.equal(dm?.breakdown.events.find((e) => e.key === "cs")?.delta, 0.5);

  const fw = xi!.starters.find((p) => p.slotLabel === "AM/FW");
  assert.ok(!fw?.breakdown.events.some((e) => e.key === "cs"));

  // 8.44+1.5 + 8.22+1 + 8.01+1 + 8.52+1 + 8.61+0.5 + 8.35+0.5
  // + 8.39 + 8.29 + 14.01 + 9.08 + 8.50 = 103.92; DB from CB bases 8.25 → +5
  assert.equal(xi!.playersTotal, 103.92);
  assert.equal(xi!.defenceBonus, 5);
  assert.equal(xi!.defenceAvg, 8.25);
  assert.equal(xi!.totalScore, 108.92);
});
