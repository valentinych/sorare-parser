import assert from "node:assert/strict";
import test from "node:test";
import {
  availabilityFactor,
  lastZeroStreak,
  minutesComponent,
  premiumFormScore,
  ratingComponent,
  roundFormScore,
  startRegularityComponent,
  tsComponent,
} from "./premiumFormScore.js";

test("form score stays on 0.00–10.00 with hundredths", () => {
  const score = premiumFormScore({
    totalMinutes: 90 * 8,
    clubTours: 8,
    minutesByTour: Array.from({ length: 8 }, () => ({ minutes: 90, starter: true })),
    ratingAvg: 8.5,
    mantraTsAvg: 9,
  });
  assert.equal(score, 10);
  assert.equal(roundFormScore(7.126), 7.13);
  assert.equal(roundFormScore(7.124), 7.12);
  assert.equal(roundFormScore(-1), 0);
  assert.ok(score <= 10);
});

test("missing FotMob/TS and 0 minutes do not mint a fake 10", () => {
  assert.equal(
    premiumFormScore({
      totalMinutes: 0,
      clubTours: 6,
      minutesByTour: Array.from({ length: 6 }, () => ({ minutes: 0, starter: false })),
      ratingAvg: 9.9,
      mantraTsAvg: 10,
    }),
    0,
  );
  assert.equal(ratingComponent(null), 0);
  assert.equal(tsComponent(undefined), 0);
  const noRatings = premiumFormScore({
    totalMinutes: 90 * 6,
    clubTours: 6,
    minutesByTour: Array.from({ length: 6 }, () => ({ minutes: 90, starter: true })),
    ratingAvg: null,
    mantraTsAvg: null,
  });
  assert.ok(noRatings > 0);
  assert.ok(noRatings < 6);
});

test("OUT / injured availability caps a historically strong player", () => {
  const healthy = premiumFormScore({
    totalMinutes: 90 * 8,
    clubTours: 8,
    minutesByTour: Array.from({ length: 8 }, () => ({ minutes: 90, starter: true })),
    ratingAvg: 7.4,
    mantraTsAvg: 7.2,
  });
  const injured = premiumFormScore({
    totalMinutes: 90 * 8,
    clubTours: 8,
    minutesByTour: [
      ...Array.from({ length: 5 }, () => ({ minutes: 90, starter: true })),
      { minutes: 0, starter: false },
      { minutes: 0, starter: false },
      { minutes: 0, starter: false },
    ],
    ratingAvg: 7.4,
    mantraTsAvg: 7.2,
    lastStreakZero: 3,
    unavailable: true,
  });
  assert.ok(healthy > 6);
  assert.ok(injured < 2);
  assert.ok(injured < healthy * 0.3);
  assert.equal(availabilityFactor({ totalMinutes: 800, lastStreakZero: 3, unavailable: true }), 0.12);
});

test("start regularity prefers a current XI run over old starts", () => {
  const current = startRegularityComponent([
    { minutes: 0, starter: false },
    { minutes: 0, starter: false },
    { minutes: 0, starter: false },
    { minutes: 90, starter: true },
    { minutes: 90, starter: true },
    { minutes: 90, starter: true },
  ]);
  const faded = startRegularityComponent([
    { minutes: 90, starter: true },
    { minutes: 90, starter: true },
    { minutes: 90, starter: true },
    { minutes: 0, starter: false },
    { minutes: 0, starter: false },
    { minutes: 0, starter: false },
  ]);
  assert.ok(current > faded);
  assert.ok(minutesComponent(270, 3) === 1);
  assert.equal(lastZeroStreak([{ minutes: 90, starter: true }, { minutes: 0, starter: false }]), 1);
});
