import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_AUCTION_RULES,
  bidStep,
  canAddPlayer,
  canAfford,
  lotShouldHammer,
  managerCanEnterNextBid,
  maxLegalBid,
  minNextBid,
  parseBidAmount,
} from "./liveAuctionRules.js";

test("official live-auction bid step follows 1-19 / 20-29 / 30-39 bands", () => {
  assert.equal(LIVE_AUCTION_RULES.startingBudget, 260);
  assert.equal(LIVE_AUCTION_RULES.squadSize, 26);
  assert.equal(LIVE_AUCTION_RULES.minGoalkeepers, 3);
  assert.equal(LIVE_AUCTION_RULES.minBid, 1);
  assert.equal(LIVE_AUCTION_RULES.hammerMs, 15_000);
  assert.equal(LIVE_AUCTION_RULES.earlyHammerFolds, 7);
  assert.equal(bidStep(1), 1);
  assert.equal(bidStep(19), 1);
  assert.equal(minNextBid(19), 20);
  assert.equal(bidStep(20), 2);
  assert.equal(minNextBid(20), 22);
  assert.equal(bidStep(29), 2);
  assert.equal(bidStep(30), 3);
  assert.equal(minNextBid(30), 33);
  assert.equal(bidStep(99), 9);
});

test("max bid keeps 1 credit for each empty slot after this win", () => {
  assert.equal(maxLegalBid(260, 0), 235);
  assert.equal(maxLegalBid(80, 10), 65);
  assert.equal(maxLegalBid(12, 25), 12);
  assert.equal(maxLegalBid(235, 25), 235);
});

test("budget and squad caps come from official starting-auction rules", () => {
  assert.equal(canAfford(260, 1), true);
  assert.equal(canAfford(10, 11), false);
  assert.equal(canAfford(5, 0), false);
  assert.equal(parseBidAmount(260), 260);
  assert.equal(parseBidAmount(261), null);
  assert.equal(parseBidAmount("12"), 12);
  assert.equal(canAddPlayer(0, 0, false), true);
  assert.equal(canAddPlayer(23, 0, false), false);
  assert.equal(canAddPlayer(23, 0, true), true);
  assert.equal(canAddPlayer(24, 2, false), true);
  assert.equal(canAddPlayer(25, 2, false), false);
  assert.equal(canAddPlayer(26, 3, true), false);
});

test("managerCanEnterNextBid follows budget, reserve, and GK-slot rules", () => {
  assert.equal(
    managerCanEnterNextBid({
      budgetLeft: 260,
      squadSize: 0,
      goalkeepers: 0,
      playerIsGk: false,
      nextBid: 2,
    }),
    true,
  );
  assert.equal(
    managerCanEnterNextBid({
      budgetLeft: 1,
      squadSize: 0,
      goalkeepers: 0,
      playerIsGk: false,
      nextBid: 2,
    }),
    false,
  );
  assert.equal(
    managerCanEnterNextBid({
      budgetLeft: 236,
      squadSize: 0,
      goalkeepers: 0,
      playerIsGk: false,
      nextBid: 236,
    }),
    false,
  );
  assert.equal(
    managerCanEnterNextBid({
      budgetLeft: 260,
      squadSize: 23,
      goalkeepers: 0,
      playerIsGk: false,
      nextBid: 1,
    }),
    false,
  );
});

test("lot hammers after 15s, 7 folds, or every rival folding", () => {
  const base = {
    now: 15_000,
    lastBidAtMs: 0,
    foldCount: 0,
    rivalCount: 7,
    foldedRivalCount: 0,
  };
  assert.equal(lotShouldHammer({ ...base, now: 14_999 }), false);
  assert.equal(lotShouldHammer(base), true);
  assert.equal(
    lotShouldHammer({ ...base, now: 1, lastBidAtMs: 0, foldCount: 7 }),
    true,
  );
  assert.equal(
    lotShouldHammer({
      ...base,
      now: 1,
      foldCount: 6,
      rivalCount: 7,
      foldedRivalCount: 6,
    }),
    false,
  );
  assert.equal(
    lotShouldHammer({
      ...base,
      now: 1,
      foldCount: 2,
      rivalCount: 2,
      foldedRivalCount: 2,
    }),
    true,
  );
});
