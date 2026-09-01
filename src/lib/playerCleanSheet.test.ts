import assert from "node:assert/strict";
import test from "node:test";
import {
  onPitchCleanSheet,
  parseCleanSheetEvent,
  type CleanSheetEvent,
  type CleanSheetPlayer,
} from "./playerCleanSheet.js";

function ev(
  over: Partial<CleanSheetEvent> & Pick<CleanSheetEvent, "idx" | "type">,
): CleanSheetEvent {
  return {
    time: null,
    overloadTime: null,
    isHome: null,
    ownGoal: false,
    playerInId: null,
    playerOutId: null,
    ...over,
  };
}

function player(over: Partial<CleanSheetPlayer> = {}): CleanSheetPlayer {
  return {
    phase: "finished",
    isHome: true,
    playerId: 682548,
    starter: true,
    minutes: 74,
    redCards: 0,
    isGk: false,
    concededFt: 1,
    events: [],
    ...over,
  };
}

test("FT team CS fallback when no events", () => {
  assert.equal(onPitchCleanSheet(player({ concededFt: 0, events: [] })), true);
  assert.equal(onPitchCleanSheet(player({ concededFt: 1, events: [] })), false);
  assert.equal(onPitchCleanSheet(player({ phase: "upcoming", concededFt: 0 })), false);
});

test("Aina: Forest 0-1 Leeds — subbed 74', goal 88' → on-pitch CS", () => {
  const events: CleanSheetEvent[] = [
    ev({ idx: 1, type: "Substitution", time: 74, isHome: true, playerInId: 1155130, playerOutId: 682548 }),
    ev({ idx: 2, type: "Goal", time: 88, isHome: false }),
  ];
  assert.equal(
    onPitchCleanSheet(player({ minutes: 74, concededFt: 1, events })),
    true,
  );
});

test("teammate who stayed on for the 88' goal does not get CS", () => {
  const events: CleanSheetEvent[] = [
    ev({ idx: 1, type: "Substitution", time: 74, isHome: true, playerInId: 1155130, playerOutId: 682548 }),
    ev({ idx: 2, type: "Goal", time: 88, isHome: false }),
  ];
  assert.equal(
    onPitchCleanSheet(
      player({ playerId: 766611, minutes: 90, concededFt: 1, events }),
    ),
    false,
  );
});

test("sub who came on after the conceded goal can still have on-pitch CS", () => {
  const events: CleanSheetEvent[] = [
    ev({ idx: 1, type: "Goal", time: 20, isHome: false }),
    ev({ idx: 2, type: "Substitution", time: 70, isHome: true, playerInId: 99, playerOutId: 1 }),
  ];
  assert.equal(
    onPitchCleanSheet(
      player({
        playerId: 99,
        starter: false,
        minutes: 20,
        concededFt: 1,
        events,
      }),
    ),
    true,
  );
});

test("Lindelof OG (Villa away) credited to Brighton home — on-pitch CS", () => {
  const events: CleanSheetEvent[] = [
    ev({ idx: 1, type: "Goal", time: 8, isHome: true, ownGoal: true }),
  ];
  assert.equal(onPitchCleanSheet(player({ minutes: 90, concededFt: 0, events })), true);
});

test("own goal by teammate is conceded (FotMob isHome = beneficiary)", () => {
  const events: CleanSheetEvent[] = [
    ev({ idx: 1, type: "Goal", time: 40, isHome: false, ownGoal: true }),
  ];
  assert.equal(onPitchCleanSheet(player({ minutes: 90, concededFt: 1, events })), false);
});

test("GK red card never gets CS even if FT 0-0", () => {
  assert.equal(
    onPitchCleanSheet(
      player({ isGk: true, redCards: 1, concededFt: 0, minutes: 70, events: [] }),
    ),
    false,
  );
});

test("outfield red card needs FT team CS, not merely on-pitch", () => {
  const events: CleanSheetEvent[] = [
    ev({ idx: 1, type: "Substitution", time: 70, playerOutId: 682548, playerInId: 2 }),
    ev({ idx: 2, type: "Goal", time: 80, isHome: false }),
  ];
  assert.equal(
    onPitchCleanSheet(player({ redCards: 1, minutes: 70, concededFt: 1, events })),
    false,
  );
  assert.equal(
    onPitchCleanSheet(player({ redCards: 1, minutes: 70, concededFt: 0, events: [] })),
    true,
  );
});

test("missing sub event: starter minutes < 90 vs later goal still CS", () => {
  const events: CleanSheetEvent[] = [ev({ idx: 1, type: "Goal", time: 88, isHome: false })];
  assert.equal(
    onPitchCleanSheet(player({ minutes: 74, starter: true, concededFt: 1, events })),
    true,
  );
});

test("parseCleanSheetEvent reads FotMob swap ids", () => {
  const e = parseCleanSheetEvent(
    {
      type: "Substitution",
      time: 74,
      overload_time: 0,
      is_home: 1,
      raw_json: JSON.stringify({
        swap: [
          { name: "Luca Netz", id: "1155130" },
          { name: "Ola Aina", id: "682548" },
        ],
      }),
    },
    3,
  );
  assert.equal(e.playerInId, 1155130);
  assert.equal(e.playerOutId, 682548);
  assert.equal(e.isHome, true);
});
