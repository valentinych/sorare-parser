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

test("Premium XI score weights ratings against XI% and slot CS", async () => {
  const {
    PREMIUM_XI_WEIGHTS: weights,
    premiumPlayerScore,
    premiumXiProb,
  } = await import(helperPath);
  const starter = {
    positions: ["ST"],
    seasonAvgRating: 7,
    last5AvgRating: 7.2,
    displayedPercentage: 85,
    matchLabel: "Д vs Foo",
    winProbability: 0.5,
    cleanSheetProbability: 0.3,
    opponentCleanSheetProbability: 0.2,
    teamScoreProbability: 0.7,
  };
  const expected =
    weights.season * 0.7 +
    weights.form * 0.72 +
    weights.xi * 0.85 +
    weights.win * 0.5 +
    weights.cs * 0.3 * 0 +
    weights.goals * 0.7 * 1;
  const scored = premiumPlayerScore(starter);
  assert.equal(scored.total, Number(expected.toFixed(2)));
  assert.equal(scored.csFactor, 0);
  assert.equal(scored.goalWeight, 1);
  assert.equal(premiumXiProb({ ...starter, footmopsGroup: "out" }), 0);
  assert.equal(premiumPlayerScore({ ...starter, footmopsGroup: "out" }).xiProb, 0);
  assert.equal(premiumPlayerScore({}).total, Number((-weights.noFixture).toFixed(2)));
  assert.equal(premiumPlayerScore({ positions: ["CB"] }, ["CB"]).csFactor, 1 / 1.5);
  assert.equal(premiumPlayerScore({ positions: ["CB"] }, ["CM"]).csFactor, 0);
  assert.equal(premiumPlayerScore({ positions: ["WB"] }, ["WB"]).csFactor, 0.5 / 1.5);
  assert.equal(premiumPlayerScore({ positions: ["WB"] }, ["W"]).csFactor, 0);
  const noGoalsColumn = premiumPlayerScore({
    positions: ["ST"],
    matchLabel: "Д vs Foo",
    opponentCleanSheetProbability: 0.25,
  });
  assert.equal(noGoalsColumn.pGoals, 0.75);
  assert.equal(premiumXiProb({ ...starter, lineupGroup: "out" }), 0);
});

test("Premium XI picker maximizes score under Mantra slots and skips no-fixture", async () => {
  const { pickBestPremiumXi } = await import(helperPath);
  const formations = ALL_FORMATIONS.map(formation);
  function withMatch(item, extra = {}) {
    return {
      ...item,
      seasonAvgRating: 7,
      last5AvgRating: 7,
      displayedPercentage: 70,
      matchLabel: "Д vs Foo",
      winProbability: 0.4,
      ...extra,
    };
  }
  const squad = valid433().map((item) => withMatch(item));
  const betterSt = withMatch(player(12, ["ST"], "Hot Striker"), {
    displayedPercentage: 20,
    last5AvgRating: 9,
  });
  const lockedSt = withMatch(player(11, ["ST"], "Locked Striker"), {
    displayedPercentage: 99,
  });
  const fitted = pickBestPremiumXi(
    [...squad.filter((item) => item.mantraPlayerId !== 11), lockedSt, betterSt],
    formations,
    ALL_POSITIONS,
  );
  assert.equal(fitted.error, null);
  assert.ok(fitted.best);
  const starterIds = fitted.best.assignments.map(
    (item) => item.player.mantraPlayerId,
  );
  assert.equal(starterIds.length, 11);
  assert.ok(starterIds.includes(11));
  assert.equal(starterIds.includes(12), false);

  const noMatchGk = withMatch(player(99, ["GK"], "Idle GK"), {
    displayedPercentage: 99,
    last5AvgRating: 9,
    seasonAvgRating: 9,
    matchLabel: null,
    opponent: null,
    kickoff: null,
  });
  const withSpareGk = pickBestPremiumXi(
    [...squad, noMatchGk],
    formations,
    ALL_POSITIONS,
  );
  assert.ok(withSpareGk.best);
  assert.equal(
    withSpareGk.best.assignments.some(
      (item) => item.player.mantraPlayerId === 99,
    ),
    false,
  );
  assert.ok(
    withSpareGk.best.assignments.some(
      (item) => item.player.mantraPlayerId === 1,
    ),
  );

  const illegal = pickBestPremiumXi(
    Array.from({ length: 11 }, (_, index) =>
      withMatch(player(index + 1, ["ST"])),
    ),
    formations,
    ALL_POSITIONS,
  );
  assert.match(illegal.error, /схему Mantra/);
  assert.equal(illegal.best, null);
});

test("Premium XI picker never starts OUT when another player can fill the slot", async () => {
  const { pickBestPremiumXi, premiumPlayerScore } = await import(helperPath);
  const formations = ALL_FORMATIONS.map(formation);
  function withMatch(item, extra = {}) {
    return {
      ...item,
      seasonAvgRating: 7,
      last5AvgRating: 7,
      displayedPercentage: 70,
      matchLabel: "Д vs Kocaelispor",
      winProbability: 0.5,
      ...extra,
    };
  }
  const squad = valid433().map((item) => withMatch(item));
  const osimhen = withMatch(player(11, ["ST"], "Victor Osimhen"), {
    seasonAvgRating: 8,
    last5AvgRating: 8,
    displayedPercentage: null,
    footmopsGroup: "out",
  });
  const sowe = withMatch(player(12, ["ST"], "Ali Sowe"), {
    seasonAvgRating: 6,
    last5AvgRating: 6,
    displayedPercentage: 40,
  });
  const henrique = withMatch(player(13, ["FW", "ST"], "Andre Henrique"), {
    seasonAvgRating: 6.2,
    last5AvgRating: 5.8,
    displayedPercentage: 55,
  });
  const outScore = premiumPlayerScore(osimhen);
  assert.equal(outScore.xiProb, 0);
  assert.ok(outScore.total > 0);

  const picked = pickBestPremiumXi(
    [...squad.filter((item) => item.mantraPlayerId !== 11), osimhen, sowe, henrique],
    formations,
    ALL_POSITIONS,
  );
  assert.equal(picked.error, null);
  assert.ok(picked.best);
  const starterIds = picked.best.assignments.map(
    (item) => item.player.mantraPlayerId,
  );
  assert.equal(starterIds.includes(11), false);
  assert.ok(starterIds.includes(12) || starterIds.includes(13));
  assert.ok(
    picked.best.extras.some((item) => item.mantraPlayerId === 11),
  );

  const expected11Out = pickBestPremiumXi(
    [
      ...squad.filter((item) => item.mantraPlayerId !== 11),
      withMatch(player(11, ["ST"], "Victor Osimhen"), {
        seasonAvgRating: 8,
        last5AvgRating: 8,
        displayedPercentage: null,
        lineupGroup: "out",
      }),
      sowe,
    ],
    formations,
    ALL_POSITIONS,
  );
  assert.equal(
    expected11Out.best?.assignments.some(
      (item) => item.player.mantraPlayerId === 11,
    ),
    false,
  );
  assert.ok(
    expected11Out.best?.assignments.some(
      (item) => item.player.mantraPlayerId === 12,
    ),
  );

  const onlyOutSt = pickBestPremiumXi(
    [...squad.filter((item) => item.mantraPlayerId !== 11), osimhen],
    formations,
    ALL_POSITIONS,
  );
  const onlyOutIds = (onlyOutSt.best?.assignments || []).map(
    (item) => item.player.mantraPlayerId,
  );
  assert.equal(onlyOutIds.includes(11), false);
});

function withMatch(item, extra = {}) {
  return {
    ...item,
    seasonAvgRating: 7,
    last5AvgRating: 7,
    displayedPercentage: 70,
    matchLabel: "Д vs Foo",
    winProbability: 0.4,
    ...extra,
  };
}

test("Premium bench never includes OUT, keeps 1 GK, and stays disjoint from XI", async () => {
  const { pickBestPremiumXi } = await import(helperPath);
  const formations = ALL_FORMATIONS.map(formation);
  const squad = valid433().map((item) => withMatch(item));
  const outCb = withMatch(player(21, ["CB"], "OUT Centre"), {
    footmopsGroup: "out",
    displayedPercentage: null,
    seasonAvgRating: 9,
    last5AvgRating: 9,
  });
  const e11OutW = withMatch(player(22, ["W"], "OUT Winger"), {
    lineupGroup: "out",
    displayedPercentage: null,
    seasonAvgRating: 9,
  });
  const spareGkA = withMatch(player(31, ["GK"], "Spare GK A"), {
    displayedPercentage: 40,
  });
  const spareGkB = withMatch(player(32, ["GK"], "Spare GK B"), {
    displayedPercentage: 55,
  });
  const spareGkC = withMatch(player(33, ["GK"], "Spare GK C"), {
    displayedPercentage: 30,
  });
  const spareCb = withMatch(player(41, ["CB"], "Spare CB"), {
    displayedPercentage: 45,
  });
  const picked = pickBestPremiumXi(
    [...squad, outCb, e11OutW, spareGkA, spareGkB, spareGkC, spareCb],
    formations,
    ALL_POSITIONS,
  );
  assert.ok(picked.best);
  const xiIds = new Set(
    picked.best.assignments.map((item: any) => item.player.mantraPlayerId),
  );
  const bench = picked.best.bench || [];
  const benchIds = bench.map((item: any) => item.player.mantraPlayerId);
  const benchGks = bench.filter((item: any) =>
    (item.player.positions || []).includes("GK"),
  );

  assert.equal(benchIds.includes(21), false);
  assert.equal(benchIds.includes(22), false);
  assert.ok(
    picked.best.extras.some((item: any) => item.mantraPlayerId === 21),
  );
  assert.equal(benchGks.length, 1);
  assert.equal(benchGks[0].player.mantraPlayerId, 32);
  assert.equal(benchIds.some((id: number) => xiIds.has(id)), false);
  assert.equal(new Set(benchIds).size, benchIds.length);
});

test("Premium bench prefers a coverage CB over extra wingers", async () => {
  const { pickBestPremiumXi } = await import(helperPath);
  const formations = ALL_FORMATIONS.map(formation);
  const squad = valid433().map((item) => withMatch(item));
  const spareGk = withMatch(player(30, ["GK"], "Bench GK"), {
    displayedPercentage: 40,
  });
  const spareCb = withMatch(player(40, ["CB"], "Coverage CB"), {
    displayedPercentage: 35,
    last5AvgRating: 6,
  });
  const extraWingers = Array.from({ length: 8 }, (_, index) =>
    withMatch(player(50 + index, ["W"], `Extra Winger ${index + 1}`), {
      displayedPercentage: 60,
    }),
  );
  const picked = pickBestPremiumXi(
    [...squad, spareGk, spareCb, ...extraWingers],
    formations,
    ALL_POSITIONS,
  );
  assert.ok(picked.best);
  const xiIds = new Set(
    picked.best.assignments.map((item: any) => item.player.mantraPlayerId),
  );
  const bench = picked.best.bench || [];
  const benchIds = bench.map((item: any) => item.player.mantraPlayerId);
  const benchGks = bench.filter((item: any) =>
    (item.player.positions || []).includes("GK"),
  );
  const benchField = bench.filter(
    (item: any) => !(item.player.positions || []).includes("GK"),
  );

  assert.equal(xiIds.has(40), false);
  assert.ok(benchIds.includes(40));
  assert.equal(benchGks.length, 1);
  assert.equal(benchField.length, 8);
  assert.equal(benchField.filter((item: any) => item.player.mantraPlayerId === 40).length, 1);
  assert.ok(
    benchField.filter((item: any) =>
      (item.player.positions || []).includes("W"),
    ).length <= 7,
  );
});

test("Premium bench leaves seats empty instead of filling with OUT", async () => {
  const { pickBestPremiumXi } = await import(helperPath);
  const formations = ALL_FORMATIONS.map(formation);
  const squad = valid433().map((item) => withMatch(item));
  const spareGk = withMatch(player(30, ["GK"], "Bench GK"), {
    displayedPercentage: 40,
  });
  const spareW = withMatch(player(51, ["W"], "Only spare W"), {
    displayedPercentage: 50,
  });
  const outCb = withMatch(player(99, ["CB"], "OUT CB"), {
    footmopsGroup: "out",
    displayedPercentage: null,
    seasonAvgRating: 9,
    last5AvgRating: 9,
  });
  const picked = pickBestPremiumXi(
    [...squad, spareGk, spareW, outCb],
    formations,
    ALL_POSITIONS,
  );
  assert.ok(picked.best);
  const bench = picked.best.bench || [];
  assert.equal(bench.length, 2);
  assert.deepEqual(
    bench.map((item: any) => item.player.mantraPlayerId).sort(),
    [30, 51],
  );
  assert.ok(
    picked.best.extras.some((item: any) => item.mantraPlayerId === 99),
  );
});
