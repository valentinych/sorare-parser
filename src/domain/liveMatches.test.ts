import assert from "node:assert/strict";
import test from "node:test";
import { effectiveLivePhase } from "./liveMatches.js";

test("stale NS after kickoff is served as live", () => {
  const now = Date.parse("2026-08-14T19:05:00Z");
  const realNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      effectiveLivePhase("upcoming", "2026-08-14T18:30:00.000Z", "NS"),
      "live",
    );
    assert.equal(
      effectiveLivePhase("upcoming", "2026-08-15T12:45:00Z", "NS"),
      "upcoming",
    );
    assert.equal(
      effectiveLivePhase("cancelled", "2026-08-14T18:30:00.000Z", "PP"),
      "cancelled",
    );
    assert.equal(effectiveLivePhase("finished", "2026-08-14T16:00:00Z", "FT"), "finished");
  } finally {
    Date.now = realNow;
  }
});
