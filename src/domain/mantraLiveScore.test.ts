import assert from "node:assert/strict";
import test from "node:test";
import { scoringClubRound } from "./mantraLiveScore.js";

test("League One mantra tour number does not score the finished FotMob gameweek", () => {
  assert.equal(
    scoringClubRound({
      requested: "2",
      liveRound: "10",
      requestedInPlay: false,
      liveInPlay: true,
      currentLineupRound: "2",
    }),
    "10",
  );
  assert.equal(
    scoringClubRound({
      requested: null,
      liveRound: "10",
      requestedInPlay: false,
      liveInPlay: true,
      currentLineupRound: "2",
    }),
    "10",
  );
  assert.equal(
    scoringClubRound({
      requested: "10",
      liveRound: "10",
      requestedInPlay: true,
      liveInPlay: true,
      currentLineupRound: "2",
    }),
    "10",
  );
});

test("an older FotMob round with its own lineup archive stays on that round", () => {
  assert.equal(
    scoringClubRound({
      requested: "8",
      liveRound: "9",
      requestedInPlay: false,
      liveInPlay: true,
      currentLineupRound: "9",
    }),
    "8",
  );
  assert.equal(
    scoringClubRound({
      requested: "8",
      liveRound: "9",
      requestedInPlay: false,
      liveInPlay: false,
      currentLineupRound: "9",
    }),
    "8",
  );
});

test("current mantra file stays on the FotMob gameweek after it finishes", () => {
  assert.equal(
    scoringClubRound({
      requested: "2",
      liveRound: "10",
      requestedInPlay: false,
      liveInPlay: false,
      currentLineupRound: "2",
    }),
    "10",
  );
});
