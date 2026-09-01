import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPenaltiesFromEvents,
  classifyPenaltyEvent,
  penaltyMissedFromStatsBlock,
  type FotmobPlayerRating,
} from "./fotmob.js";
import { MANTRA_SCORING, scorePlayer, type PlayerMatchStats } from "../lib/mantraScoring.js";

function blankStats(over: Partial<PlayerMatchStats>): PlayerMatchStats {
  return {
    rating: 6,
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

function blankPlayer(over: Partial<FotmobPlayerRating> = {}): FotmobPlayerRating {
  return {
    playerId: 953517,
    name: "Marius Mouandilmadji",
    teamId: 9750,
    teamName: "Samsunspor",
    isHome: true,
    shirtNumber: "9",
    positionId: 105,
    rating: 7.77,
    starter: true,
    minutes: 90,
    goals: 0,
    assists: 0,
    yellowCards: 0,
    redCards: 0,
    ownGoals: 0,
    saves: 0,
    goalsConceded: 0,
    penaltiesWon: 0,
    penaltiesConceded: 0,
    penaltiesScored: 0,
    penaltiesMissed: 0,
    penaltiesSaved: 0,
    ...over,
  };
}

test("FotMob label 'Missed penalty' / key missed_penalty is read as a miss", () => {
  assert.equal(
    penaltyMissedFromStatsBlock({
      "Missed penalty": { key: "missed_penalty", stat: { value: 1, type: "integer" } },
    }),
    1,
  );
  assert.equal(
    penaltyMissedFromStatsBlock({
      "Penalties missed": { stat: { value: 2, type: "integer" } },
    }),
    2,
  );
  assert.equal(penaltyMissedFromStatsBlock({ Goals: { stat: { value: 1 } } }), 0);
});

test("MissedPenalty event is a miss — never scored-penalty or Goal", () => {
  const raw = {
    type: "MissedPenalty",
    time: 58,
    isPenaltyShootoutEvent: false,
    player: { id: 953517, name: "Marius Mouandilmadji" },
    homeScore: 2,
    awayScore: 2,
    // a "penalty" flag on a miss must not flip it to scored
    goalDescription: "Penalty",
    goalDescriptionKey: "penalty",
  };
  assert.equal(classifyPenaltyEvent({ type: "MissedPenalty", playerId: 953517, raw }), "missed");

  const p = blankPlayer({ goals: 0 });
  applyPenaltiesFromEvents([p], [{ type: "MissedPenalty", playerId: 953517, raw }]);
  assert.equal(p.penaltiesMissed, 1);
  assert.equal(p.penaltiesScored, 0);
  assert.equal(p.goals, 0);
});

test("Goal + goalDescriptionKey penalty is scored-pen; shootout and OG are ignored", () => {
  assert.equal(
    classifyPenaltyEvent({
      type: "Goal",
      playerId: 953517,
      ownGoal: false,
      raw: {
        type: "Goal",
        goalDescription: "Penalty",
        goalDescriptionKey: "penalty",
        isPenaltyShootoutEvent: false,
        homeScore: 0,
        awayScore: 1,
        newScore: [1, 1],
      },
    }),
    "scored",
  );
  assert.equal(
    classifyPenaltyEvent({
      type: "Goal",
      playerId: 1,
      raw: { type: "Goal", goalDescriptionKey: "penalty", isPenaltyShootoutEvent: true },
    }),
    null,
  );
  assert.equal(
    classifyPenaltyEvent({
      type: "Goal",
      playerId: 1,
      ownGoal: true,
      raw: { type: "Goal", goalDescriptionKey: "penalty" },
    }),
    null,
  );
  assert.equal(
    classifyPenaltyEvent({
      type: "Goal",
      playerId: 1,
      raw: { type: "Goal", goalDescriptionKey: null },
    }),
    null,
  );
});

test("scorePlayer: missed penalty awards penMiss only — no goal / no pen scored", () => {
  const bd = scorePlayer({
    native: ["ST"],
    slotAccepted: ["ST", "FW"],
    stats: blankStats({ penaltiesMissed: 1 }),
    teamCleanSheet: false,
  });
  assert.ok(bd);
  assert.equal(bd!.events.some((e) => e.key === "goal"), false);
  assert.equal(bd!.events.some((e) => e.key === "pen"), false);
  const miss = bd!.events.find((e) => e.key === "penMiss");
  assert.deepEqual(miss, { key: "penMiss", count: 1, delta: MANTRA_SCORING.penaltyMissed });
  assert.equal(bd!.total, 6 + MANTRA_SCORING.penaltyMissed);
});

test("bare Penalty / Goal+pen with no score change is not a scored goal", () => {
  assert.equal(classifyPenaltyEvent({ type: "Penalty", playerId: 1, raw: { type: "Penalty" } }), null);
  assert.equal(
    classifyPenaltyEvent({
      type: "Goal",
      playerId: 1,
      raw: {
        type: "Goal",
        goalDescriptionKey: "penalty",
        homeScore: 2,
        awayScore: 2,
        newScore: [2, 2],
      },
    }),
    "missed",
  );
  assert.equal(
    classifyPenaltyEvent({
      type: "Goal",
      playerId: 1,
      raw: { type: "Goal", goalDescriptionKey: "penalty" },
    }),
    null,
  );
});

test("Mouandilmadji 5904712: 30' Goal+pen scored, 58' MissedPenalty is miss — goals stay 1", () => {
  const p = blankPlayer({ goals: 1 });
  applyPenaltiesFromEvents(
    [p],
    [
      {
        type: "Goal",
        playerId: 953517,
        ownGoal: false,
        raw: {
          type: "Goal",
          time: 30,
          goalDescription: "Penalty",
          goalDescriptionKey: "penalty",
          suffix: "Pen",
          isPenaltyShootoutEvent: false,
          homeScore: 0,
          awayScore: 1,
          newScore: [1, 1],
        },
      },
      {
        type: "MissedPenalty",
        playerId: 953517,
        raw: {
          type: "MissedPenalty",
          time: 58,
          isPenaltyShootoutEvent: false,
          homeScore: 2,
          awayScore: 2,
        },
      },
    ],
  );
  assert.equal(p.goals, 1);
  assert.equal(p.penaltiesScored, 1);
  assert.equal(p.penaltiesMissed, 1);

  const bd = scorePlayer({
    native: ["ST"],
    slotAccepted: ["ST", "FW"],
    stats: blankStats({
      rating: 7.77,
      goals: p.goals,
      penaltiesScored: p.penaltiesScored,
      penaltiesMissed: p.penaltiesMissed,
    }),
    teamCleanSheet: false,
  });
  assert.ok(bd);
  assert.equal(bd!.events.some((e) => e.key === "goal"), false);
  assert.equal(bd!.events.find((e) => e.key === "pen")?.count, 1);
  assert.equal(bd!.events.find((e) => e.key === "penMiss")?.count, 1);
  assert.equal(bd!.total, 7.77 + MANTRA_SCORING.goal.ST + MANTRA_SCORING.penaltyMissed);
});

test("Benedyczak 5904705: one penalty Goal is +2 only → 9.59, one ⚽🅿️ event", () => {
  const p = blankPlayer({
    playerId: 920861,
    name: "Adrian Benedyczak",
    rating: 7.59,
    goals: 1,
  });
  applyPenaltiesFromEvents(
    [p],
    [
      {
        type: "Goal",
        playerId: 920861,
        ownGoal: false,
        raw: {
          type: "Goal",
          time: 55,
          goalDescription: "Penalty",
          goalDescriptionKey: "penalty",
          suffix: "Pen",
          isPenaltyShootoutEvent: false,
          homeScore: 0,
          awayScore: 1,
          newScore: [1, 1],
        },
      },
    ],
  );
  assert.equal(p.goals, 1);
  assert.equal(p.penaltiesScored, 1);

  const bd = scorePlayer({
    native: ["ST", "FW"],
    slotAccepted: ["ST", "FW"],
    stats: blankStats({
      rating: 7.59,
      goals: p.goals,
      penaltiesScored: p.penaltiesScored,
    }),
    teamCleanSheet: false,
  });
  assert.ok(bd);
  assert.equal(bd!.events.some((e) => e.key === "goal"), false);
  assert.deepEqual(bd!.events.filter((e) => e.key === "goal" || e.key === "pen"), [
    { key: "pen", count: 1, delta: MANTRA_SCORING.goal.ST },
  ]);
  assert.equal(bd!.total, 9.59);
  assert.equal(bd!.parts.some((s) => s.startsWith("pen +")), false);
});

test("open-play Goal + separate scored pen: two events, points = rating + 2 goals (no pen stack)", () => {
  const bd = scorePlayer({
    native: ["ST"],
    slotAccepted: ["ST", "FW"],
    stats: blankStats({
      rating: 7,
      goals: 2,
      penaltiesScored: 1,
    }),
    teamCleanSheet: false,
  });
  assert.ok(bd);
  assert.deepEqual(bd!.events.find((e) => e.key === "goal"), {
    key: "goal",
    count: 1,
    delta: MANTRA_SCORING.goal.ST,
  });
  assert.deepEqual(bd!.events.find((e) => e.key === "pen"), {
    key: "pen",
    count: 1,
    delta: MANTRA_SCORING.goal.ST,
  });
  assert.equal(bd!.total, 7 + MANTRA_SCORING.goal.ST * 2);
});

test("Mouandilmadji real stats: pen goal + miss + penWon — no penScored stack", () => {
  const bd = scorePlayer({
    native: ["ST"],
    slotAccepted: ["ST", "FW"],
    stats: blankStats({
      rating: 7.77,
      goals: 1,
      penaltiesScored: 1,
      penaltiesMissed: 1,
      penaltiesWon: 1,
    }),
    teamCleanSheet: false,
  });
  assert.ok(bd);
  assert.equal(bd!.events.some((e) => e.key === "goal"), false);
  assert.equal(bd!.events.find((e) => e.key === "pen")?.count, 1);
  assert.equal(bd!.events.find((e) => e.key === "penWon")?.count, 1);
  assert.equal(bd!.events.find((e) => e.key === "penMiss")?.count, 1);
  assert.equal(
    bd!.total,
    7.77 + MANTRA_SCORING.goal.ST + MANTRA_SCORING.penaltyEarned + MANTRA_SCORING.penaltyMissed,
  );
});
