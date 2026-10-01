import assert from "node:assert/strict";
import test from "node:test";
import { applyMissedPenaltySavesToRows } from "./fotmobPenaltyOverlay.js";

test("MissedPenalty credits the opposing GK who recorded a save", () => {
  const raya = {
    match_id: 5795453,
    player_id: 562727,
    penalties_scored: 0,
    penalties_missed: 0,
    penalties_saved: 0,
    is_home: 0,
    saves: 2,
  };
  const leFee = {
    match_id: 5795453,
    player_id: 1049999,
    penalties_scored: 0,
    penalties_missed: 0,
    penalties_saved: 0,
    is_home: 1,
    saves: 0,
  };
  applyMissedPenaltySavesToRows(
    [
      {
        match_id: 5795453,
        player_id: 1049999,
        type: "MissedPenalty",
        is_home: 1,
        raw_json: JSON.stringify({ type: "MissedPenalty", isPenaltyShootoutEvent: false }),
      },
    ],
    [raya, leFee],
  );
  assert.equal(raya.penalties_saved, 1);
  assert.equal(leFee.penalties_saved, 0);
});

test("MissedPenalty does not credit a GK with 0 saves (wide miss)", () => {
  const gk = {
    match_id: 1,
    player_id: 10,
    penalties_scored: 0,
    penalties_missed: 0,
    penalties_saved: 0,
    is_home: 0,
    saves: 0,
  };
  applyMissedPenaltySavesToRows(
    [
      {
        match_id: 1,
        player_id: 20,
        type: "MissedPenalty",
        is_home: 1,
        raw_json: JSON.stringify({ type: "MissedPenalty", isPenaltyShootoutEvent: false }),
      },
    ],
    [gk],
  );
  assert.equal(gk.penalties_saved, 0);
});

test("MissedPenalty uses raw isHome when the events.is_home column is null", () => {
  const raya = {
    match_id: 5795453,
    player_id: 562727,
    penalties_scored: 0,
    penalties_missed: 0,
    penalties_saved: 0,
    is_home: 0,
    saves: 2,
  };
  applyMissedPenaltySavesToRows(
    [
      {
        match_id: 5795453,
        player_id: 1049999,
        type: "MissedPenalty",
        is_home: null,
        raw_json: JSON.stringify({
          type: "MissedPenalty",
          isHome: true,
          isPenaltyShootoutEvent: false,
        }),
      },
    ],
    [raya],
  );
  assert.equal(raya.penalties_saved, 1);
});

test("MissedPenalty credits a linked Mantra GK even if FotMob saves column is 0", () => {
  const raya = {
    match_id: 1,
    player_id: 562727,
    penalties_scored: 0,
    penalties_missed: 0,
    penalties_saved: 0,
    is_home: 0,
    saves: 0,
  };
  applyMissedPenaltySavesToRows(
    [
      {
        match_id: 1,
        player_id: 20,
        type: "MissedPenalty",
        is_home: 1,
        raw_json: JSON.stringify({ type: "MissedPenalty", isPenaltyShootoutEvent: false }),
      },
    ],
    [raya],
    new Set([562727]),
  );
  assert.equal(raya.penalties_saved, 1);
});
