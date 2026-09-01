import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_FORMATIONS,
  ALL_POSITIONS,
  FORMATION_SLOTS,
} from "../lib/mantraFormations.js";

const helperPath = "../../public-tm/premium-formations.js";

function player(
  mantraPlayerId: number,
  positions: string[],
  displayName = `Player ${mantraPlayerId}`,
) {
  return {
    mantraPlayerId,
    positions,
    position: positions[0],
    clubName: "Club",
    displayName,
  };
}

function formation(name: string) {
  return {
    name,
    slots: FORMATION_SLOTS[name]!.map((slot) => ({
      label: slot.label,
      accepted: slot.accepted,
    })),
  };
}

function valid433() {
  return [
    player(1, ["GK"]),
    player(2, ["RB"]),
    player(3, ["CB"]),
    player(4, ["CB"]),
    player(5, ["LB"]),
    player(6, ["DM", "CM"], "A Versatile"),
    player(7, ["DM"], "B Holding"),
    player(8, ["DM"], "C Holding"),
    player(9, ["W"]),
    player(10, ["W"]),
    player(11, ["ST"]),
  ];
}

test("Premium formation matcher fills exactly 11 actual Mantra slots", async () => {
  const { matchPremiumFormation } = await import(helperPath);
  const result = matchPremiumFormation(
    valid433(),
    formation("4-3-3"),
    ALL_POSITIONS,
  );

  assert.equal(result.compatible, true);
  assert.equal(result.assignments.length, 11);
  assert.equal(new Set(result.assignments.map((item: any) => item.player.mantraPlayerId)).size, 11);
  assert.deepEqual(result.deficits, []);
});

test("Premium formation matcher leaves selections beyond XI as extras", async () => {
  const { matchPremiumFormation } = await import(helperPath);
  const result = matchPremiumFormation(
    [...valid433(), player(12, ["W"], "Bench Winger")],
    formation("4-3-3"),
    ALL_POSITIONS,
  );

  assert.equal(result.compatible, true);
  assert.equal(result.assignments.length, 11);
  assert.equal(result.extras.length, 1);
});

test("Premium formation matcher reports no compatible formation and deficits", async () => {
  const { closestPremiumFormation, compatiblePremiumFormations } =
    await import(helperPath);
  const players = Array.from({ length: 11 }, (_, index) =>
    player(index + 1, ["ST"]),
  );
  const formations = ALL_FORMATIONS.map(formation);

  assert.deepEqual(
    compatiblePremiumFormations(players, formations, ALL_POSITIONS),
    [],
  );
  const closest = closestPremiumFormation(players, formations, ALL_POSITIONS);
  assert.ok(closest);
  assert.ok(closest.deficits.length > 0);
  assert.ok(closest.matchedSlots < 11);
});

test("Premium formation matcher reroutes a multi-position player instead of failing greedily", async () => {
  const { matchPremiumFormation } = await import(helperPath);
  const result = matchPremiumFormation(
    valid433(),
    formation("4-3-3"),
    ALL_POSITIONS,
  );
  const versatile = result.assignments.find(
    (item: any) => item.player.mantraPlayerId === 6,
  );

  assert.equal(result.compatible, true);
  assert.equal(versatile.slot.label, "CM");
});

test("Premium formation matcher enforces distinct stable player IDs", async () => {
  const { matchPremiumFormation } = await import(helperPath);
  const duplicate = {
    ...player(11, ["ST"]),
    displayName: "Duplicate API row",
  };
  const result = matchPremiumFormation(
    [...valid433().slice(0, 10), player(11, ["ST"]), duplicate],
    formation("4-3-3"),
    ALL_POSITIONS,
  );

  assert.equal(result.compatible, true);
  assert.equal(result.assignments.length, 11);
  assert.equal(new Set(result.assignments.map((item: any) => item.player.mantraPlayerId)).size, 11);

  const missingDistinct = matchPremiumFormation(
    [...valid433().slice(0, 10), { ...player(10, ["ST"]), displayName: "Duplicate" }],
    formation("4-3-3"),
    ALL_POSITIONS,
  );
  assert.equal(missingDistinct.compatible, false);
});

test("Premium formation assignment and catalog order are deterministic", async () => {
  const { compatiblePremiumFormations, matchPremiumFormation } =
    await import(helperPath);
  const players = valid433();
  const first = matchPremiumFormation(players, formation("4-3-3"), ALL_POSITIONS);
  const second = matchPremiumFormation(
    players.slice().reverse(),
    formation("4-3-3"),
    ALL_POSITIONS,
  );

  assert.deepEqual(
    first.assignments.map((item: any) => item.player.mantraPlayerId),
    second.assignments.map((item: any) => item.player.mantraPlayerId),
  );
  const compatible = compatiblePremiumFormations(
    players,
    ALL_FORMATIONS.map(formation),
    ALL_POSITIONS,
  );
  const order = new Map(ALL_FORMATIONS.map((name, index) => [name, index]));
  assert.deepEqual(
    compatible.map((item: any) => item.formation),
    compatible
      .map((item: any) => item.formation)
      .slice()
      .sort((a: string, b: string) => order.get(a)! - order.get(b)!),
  );
});

test("Premium lineup generator requires 1 GK plus 10 outfield who fill a Mantra scheme", async () => {
  const { generatePremiumLineups } = await import(helperPath);
  const formations = ALL_FORMATIONS.map(formation);

  const short = generatePremiumLineups(valid433().slice(0, 10), formations, ALL_POSITIONS);
  assert.match(short.error, /1 вратарь и 10 полевых/);
  assert.deepEqual(short.compatible, []);

  const noGk = generatePremiumLineups(
    valid433().map((item, index) =>
      index === 0 ? player(1, ["CB"], "Outfield keeper") : item,
    ),
    formations,
    ALL_POSITIONS,
  );
  assert.match(noGk.error, /1 вратарь и 10 полевых/);
  assert.deepEqual(noGk.compatible, []);

  const noScheme = generatePremiumLineups(
    Array.from({ length: 11 }, (_, index) =>
      player(index + 1, index === 0 ? ["GK"] : ["ST"]),
    ),
    formations,
    ALL_POSITIONS,
  );
  assert.match(noScheme.error, /не заполняют ни одну схему/);
  assert.deepEqual(noScheme.compatible, []);

  const fitted = generatePremiumLineups(
    [...valid433(), player(12, ["W", "FW"], "Extra")],
    formations,
    ALL_POSITIONS,
  );
  assert.equal(fitted.error, null);
  assert.ok(fitted.compatible.some((item: { formation: string }) => item.formation === "4-3-3"));
  const assigned = fitted.compatible.find(
    (item: { formation: string }) => item.formation === "4-3-3",
  );
  assert.ok(assigned);
  assert.equal(assigned.assignments.length, 11);
  assert.equal(assigned.extras.length, 1);
});

test("Premium selection count survives sorting and visible filtering", async () => {
  const { premiumSelectionCounts } = await import(helperPath);
  const selected = new Set([1, 2, 3]);
  const rows = valid433().slice(0, 4);

  assert.deepEqual(premiumSelectionCounts(selected, rows), {
    total: 3,
    visible: 3,
  });
  assert.deepEqual(
    premiumSelectionCounts(selected, rows.slice().reverse()),
    { total: 3, visible: 3 },
  );
  assert.deepEqual(
    premiumSelectionCounts(
      selected,
      rows.filter((row) => row.mantraPlayerId === 1),
    ),
    { total: 3, visible: 1 },
  );
});
