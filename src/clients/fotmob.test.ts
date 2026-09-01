import assert from "node:assert/strict";
import test from "node:test";
import {
  matchPhase,
  parseFotmobFixture,
  scoresFromFotmobStatus,
} from "./fotmob.js";

test("in-play FotMob flags map to live even without reason.short", () => {
  assert.equal(
    matchPhase({
      status: { started: true, finished: false, liveTime: { short: "33’" } },
    }),
    "live",
  );
});

test("scoreStr fills list scores when home/away.score are null", () => {
  assert.deepEqual(scoresFromFotmobStatus({ scoreStr: "3 - 0" }, null, null), {
    home: 3,
    away: 0,
  });
  const parsed = parseFotmobFixture({
    id: "5803944",
    round: "4",
    home: { id: 1, name: "Legia Warszawa", score: null },
    away: { id: 2, name: "Radomiak Radom", score: null },
    status: {
      utcTime: "2026-08-14T18:30:00.000Z",
      started: true,
      finished: false,
      scoreStr: "3 - 0",
      liveTime: { short: "33’" },
    },
  });
  assert.equal(parsed?.id, 5803944);
  assert.equal(parsed?.home.score, 3);
  assert.equal(parsed?.away.score, 0);
  assert.equal(matchPhase(parsed!), "live");
});

test("kickoff already passed with NS is treated as live", () => {
  const now = Date.parse("2026-08-14T19:05:00Z");
  const realNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      matchPhase({
        status: {
          utcTime: "2026-08-14T18:30:00.000Z",
          started: false,
          finished: false,
        },
      }),
      "live",
    );
    assert.equal(
      matchPhase({
        status: {
          utcTime: "2026-08-14T18:30:00.000Z",
          started: false,
          finished: false,
          cancelled: true,
        },
      }),
      "cancelled",
    );
  } finally {
    Date.now = realNow;
  }
});

test("NS from more than 4 hours ago is not treated as live", () => {
  const now = Date.parse("2026-08-16T15:00:00Z");
  const realNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      matchPhase({
        status: {
          utcTime: "2026-08-16T10:00:00.000Z",
          started: false,
          finished: false,
        },
      }),
      "upcoming",
    );
  } finally {
    Date.now = realNow;
  }
});
