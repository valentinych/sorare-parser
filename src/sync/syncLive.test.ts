import assert from "node:assert/strict";
import test from "node:test";
import type { FotmobFixtureMatch } from "../clients/fotmob.js";
import { MAX_LIVE_DETAILS_REFRESH, pickCurrentRound, selectMatchesToRefresh } from "./syncLive.js";

function match(
  round: string,
  phase: "live" | "finished" | "upcoming",
  utcTime: string,
): FotmobFixtureMatch {
  return {
    id: Number(round) * 10,
    round,
    roundName: `Round ${round}`,
    pageUrl: null,
    home: { id: 1, name: "Home", score: phase === "upcoming" ? null : 1 },
    away: { id: 2, name: "Away", score: phase === "upcoming" ? null : 0 },
    status: {
      utcTime,
      started: phase === "live" || phase === "finished",
      finished: phase === "finished",
    },
  };
}

test("pickCurrentRound stays on last finished until next kickoff", () => {
  const now = "2026-08-14T17:00:00Z";
  const matches = [
    match("3", "finished", "2026-08-09T18:15:00Z"),
    match("4", "upcoming", "2026-08-14T18:30:00Z"),
  ];
  const realNow = Date.now;
  Date.now = () => Date.parse(now);
  try {
    assert.equal(pickCurrentRound(matches), "3");
  } finally {
    Date.now = realNow;
  }
});

test("pickCurrentRound advances when next round is live", () => {
  const matches = [
    match("3", "finished", "2026-08-09T18:15:00Z"),
    match("4", "live", "2026-08-14T18:30:00Z"),
  ];
  assert.equal(pickCurrentRound(matches), "4");
});

test("pickCurrentRound advances when kickoff passed even if FotMob still says NS", () => {
  const now = "2026-08-14T19:05:00Z";
  const matches = [
    match("3", "finished", "2026-08-09T18:15:00Z"),
    match("4", "upcoming", "2026-08-14T18:30:00Z"),
  ];
  const realNow = Date.now;
  Date.now = () => Date.parse(now);
  try {
    assert.equal(pickCurrentRound(matches), "4");
  } finally {
    Date.now = realNow;
  }
});

test("selectMatchesToRefresh keeps in-play and skips far-future upcoming", () => {
  const now = "2026-08-16T15:30:00Z";
  const matches = [
    match("1", "live", "2026-08-16T15:00:00Z"),
    match("1", "upcoming", "2026-08-17T19:00:00Z"),
  ];
  matches[0]!.id = 101;
  matches[1]!.id = 102;
  const realNow = Date.now;
  Date.now = () => Date.parse(now);
  try {
    const ids = selectMatchesToRefresh(matches).map((m) => m.id);
    assert.deepEqual(ids, [101]);
  } finally {
    Date.now = realNow;
  }
});

test("selectMatchesToRefresh caps details pulls so one league cannot stall the poller", () => {
  const now = "2026-08-16T15:30:00Z";
  const matches = Array.from({ length: MAX_LIVE_DETAILS_REFRESH + 8 }, (_, i) => {
    const row = match("1", "live", "2026-08-16T15:00:00Z");
    row.id = 1000 + i;
    return row;
  });
  const realNow = Date.now;
  Date.now = () => Date.parse(now);
  try {
    assert.equal(selectMatchesToRefresh(matches).length, MAX_LIVE_DETAILS_REFRESH);
  } finally {
    Date.now = realNow;
  }
});
