import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { PlayerMatchStats } from "../lib/mantraScoring.js";
import {
  alignRealToIdealSlots,
  breakdownFromMantraGwTotal,
  finishedRoundsAlignedToGames,
  floorIdealAtActual,
  idealRoundSetEquals,
  listScoredFotmobRounds,
  loadSeasonIdealTotals,
  lockedTourSquadIds,
  pickIdeal,
  resolveTourSquadIds,
  sumIdealTotalsByTeam,
  sumSeasonIdealByTeam,
  sumTotalsByTeam,
  type ScoredSquadPlayer,
} from "./mantraIdealVsReal.js";

test("sumIdealTotalsByTeam adds per-tour Ideal XI by team id", () => {
  const summed = sumIdealTotalsByTeam([
    {
      rows: [
        { teamId: 1, idealTotal: 69.87 },
        { teamId: 2, idealTotal: 100.34 },
      ],
    },
    {
      rows: [
        { teamId: 1, idealTotal: 70.13 },
        { teamId: 3, idealTotal: 50 },
      ],
    },
    { rows: [{ teamId: 1, idealTotal: null }] },
  ]);
  assert.equal(summed.get(1), 140);
  assert.equal(summed.get(2), 100.34);
  assert.equal(summed.get(3), 50);
  assert.equal(summed.has(99), false);
});

test("sumIdealTotalsByTeam skips failed Ideal picks (0 + no XI) so they stay unmatched", () => {
  const summed = sumIdealTotalsByTeam([
    {
      rows: [
        { teamId: 2532, idealTotal: 0, formation: null, idealXi: [] },
        { teamId: 2108, idealTotal: 63.58, formation: "3-4-3", idealXi: [{ name: "De Gea" }] },
      ],
    },
    {
      rows: [
        { teamId: 2532, idealTotal: 0, formation: null, idealXi: [] },
        { teamId: 2108, idealTotal: 48.47, formation: "4-4-2" },
      ],
    },
  ]);
  assert.equal(summed.get(2108), 112.05);
  assert.equal(summed.has(2532), false);
});

test("sumTotalsByTeam skips Real on failed Ideal so % is not 11-man Real / missing Ideal", () => {
  const rounds = [
    {
      rows: [
        {
          teamId: 2532,
          idealTotal: 0,
          realTotal: 80,
          formation: null,
          idealXi: [],
        },
        {
          teamId: 2108,
          idealTotal: 63.58,
          realTotal: 60,
          formation: "3-4-3",
          idealXi: [{ name: "De Gea" }],
        },
      ],
    },
  ];
  const real = sumTotalsByTeam(rounds, "realTotal");
  assert.equal(real.has(2532), false);
  assert.equal(real.get(2108), 60);
});

function stats(rating: number): PlayerMatchStats {
  return {
    rating,
    minutes: 90,
    goals: 0,
    assists: 0,
    yellowCards: 0,
    redCards: 0,
    ownGoals: 0,
    saves: 0,
    goalsConceded: 0,
    penaltiesScored: 0,
    penaltiesMissed: 0,
    penaltiesSaved: 0,
    penaltiesWon: 0,
    penaltiesConceded: 0,
    appeared: true,
  };
}

let squadSeq = 1;
function squadPlayer(positions: string[], rating: number, name?: string): ScoredSquadPlayer {
  const id = squadSeq++;
  return {
    mantraPlayerId: id,
    fotmobPlayerId: id,
    name: name || `P${id}`,
    displayName: name || `P${id}`,
    clubName: "Club",
    positions,
    stats: stats(rating),
    teamCleanSheet: false,
    minutes: 90,
    rating,
  };
}

/** 4-4-2 outfield: RB, 2×CB, LB, WB, 2×CM, W, 2×FW. */
function outfield442(secondCb: boolean): ScoredSquadPlayer[] {
  const rows: ScoredSquadPlayer[] = [
    squadPlayer(["RB"], 6.1, "RB"),
    squadPlayer(["CB"], 6.2, "CB1"),
  ];
  if (secondCb) rows.push(squadPlayer(["CB"], 6.3, "CB2"));
  rows.push(
    squadPlayer(["LB"], 6.4, "LB"),
    squadPlayer(["WB"], 6.5, "WB"),
    squadPlayer(["CM"], 6.6, "CM1"),
    squadPlayer(["CM"], 6.7, "CM2"),
    squadPlayer(["W"], 6.8, "W"),
    squadPlayer(["FW"], 6.9, "FW1"),
    squadPlayer(["FW"], 7.0, "FW2"),
  );
  return rows;
}

test("pickIdeal missing GK still returns 10-player ideal > 0", () => {
  const ideal = pickIdeal(outfield442(true));
  assert.ok(ideal);
  assert.equal(ideal.starters.length, 10);
  assert.equal(ideal.starters.some((p) => p.slotLabel === "GK"), false);
  assert.ok(ideal.totalScore > 0);
  assert.ok(ideal.formation);
});

test("pickIdeal missing one CB returns 10-player sum", () => {
  const pool = [squadPlayer(["GK"], 7.5, "GK"), ...outfield442(false)];
  const ideal = pickIdeal(pool);
  assert.ok(ideal);
  assert.equal(ideal.starters.length, 10);
  assert.equal(ideal.starters.some((p) => p.positions.includes("GK")), true);
  const playersSum = ideal.starters.reduce((s, p) => s + p.breakdown.total, 0);
  assert.equal(ideal.playersTotal, Math.round(playersSum * 100) / 100);
  assert.ok(ideal.totalScore > 0);
});

test("pickIdeal full squad still returns 11", () => {
  const pool = [squadPlayer(["GK"], 7.5, "GK"), ...outfield442(true)];
  const ideal = pickIdeal(pool);
  assert.ok(ideal);
  assert.equal(ideal.starters.length, 11);
  assert.equal(ideal.starters.filter((p) => p.slotLabel === "GK").length, 1);
  assert.ok(ideal.totalScore > 0);
});

test("pickIdeal from locked XI+bench is not below the posted 11", () => {
  const gk = squadPlayer(["GK"], 8.94, "Raya");
  gk.stats = { ...gk.stats!, penaltiesSaved: 1 };
  gk.teamCleanSheet = true;
  const magalhaes = squadPlayer(["CB"], 8.5, "Magalhaes");
  magalhaes.teamCleanSheet = true;
  const benchWinger = squadPlayer(["W"], 6.0, "Estevao");
  const ideal = pickIdeal([gk, magalhaes, ...outfield442(true), benchWinger]);
  assert.ok(ideal);
  assert.equal(ideal.starters.length, 11);
  assert.ok(ideal.starters.some((p) => p.name === "Magalhaes"));
  const raya = ideal.starters.find((p) => p.name === "Raya");
  assert.ok(raya?.breakdown.events.some((e) => e.key === "penSave"));
  assert.equal(ideal.starters.some((p) => p.name === "Estevao"), false);
  assert.ok(ideal.totalScore >= 80);
});

test("alignRealToIdealSlots drops Real's empty Ideal slot (GK) from %", () => {
  const ideal = {
    formation: "4-4-2",
    starters: [
      { slotLabel: "RB" },
      { slotLabel: "CB" },
      { slotLabel: "CB" },
      { slotLabel: "LB" },
      { slotLabel: "WB" },
      { slotLabel: "DM/CM" },
      { slotLabel: "CM" },
      { slotLabel: "WB/W" },
      { slotLabel: "FW/ST" },
      { slotLabel: "FW/ST" },
    ],
  };
  const realXi = [
    { slotLabel: "GK", totalScore: 8, baseScore: 8 },
    { slotLabel: "RB", totalScore: 6, baseScore: 6 },
    { slotLabel: "CB", totalScore: 6, baseScore: 6 },
    { slotLabel: "CB", totalScore: 6, baseScore: 6 },
    { slotLabel: "LB", totalScore: 6, baseScore: 6 },
    { slotLabel: "WB", totalScore: 6, baseScore: 6 },
    { slotLabel: "DM/CM", totalScore: 6, baseScore: 6 },
    { slotLabel: "CM", totalScore: 6, baseScore: 6 },
    { slotLabel: "WB/W", totalScore: 6, baseScore: 6 },
    { slotLabel: "FW/ST", totalScore: 6, baseScore: 6 },
    { slotLabel: "FW/ST", totalScore: 6, baseScore: 6 },
  ];
  const aligned = alignRealToIdealSlots(ideal, realXi, {
    total: 74,
    playersTotal: 74,
    defenceBonus: 0,
  });
  assert.equal(aligned.playersTotal, 60);
  assert.equal(aligned.total, 60);
});

test("alignRealToIdealSlots keeps full Real when Ideal is 11", () => {
  const starters = Array.from({ length: 11 }, () => ({ slotLabel: "FW" }));
  const aligned = alignRealToIdealSlots(
    { formation: "4-4-2", starters },
    [{ slotLabel: "GK", totalScore: 8, baseScore: 8 }],
    { total: 80, playersTotal: 77, defenceBonus: 3 },
  );
  assert.equal(aligned.total, 80);
  assert.equal(aligned.playersTotal, 77);
  assert.equal(aligned.defenceBonus, 3);
});

test("listScoredFotmobRounds keeps finished and live tours, flags fully finished", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE fotmob_matches (
      id INTEGER PRIMARY KEY,
      league_id INTEGER,
      round TEXT,
      phase TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO fotmob_matches (id, league_id, round, phase) VALUES (?, ?, ?, ?)`,
  );
  insert.run(1, 48, "1", "finished");
  insert.run(2, 48, "1", "finished");
  insert.run(3, 48, "6", "finished");
  insert.run(4, 48, "6", "live");
  insert.run(5, 48, "7", "upcoming");
  insert.run(6, 71, "2", "finished");

  const rounds = listScoredFotmobRounds(48, db);
  assert.deepEqual(rounds, [
    { round: "1", fullyFinished: true },
    { round: "6", fullyFinished: false },
  ]);
});

test("loadSeasonIdealTotals sums only fully finished tours and matching Real XI", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE fotmob_matches (
      id INTEGER PRIMARY KEY,
      league_id INTEGER,
      round TEXT,
      phase TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO fotmob_matches (id, league_id, round, phase) VALUES (?, ?, ?, ?)`,
  );
  insert.run(1, 48, "1", "finished");
  insert.run(2, 48, "2", "finished");
  insert.run(3, 48, "6", "live");

  const computed: string[] = [];
  const totals = loadSeasonIdealTotals("championship", {
    database: db,
    computeRound: (round, slug, fullyFinished) => {
      computed.push(`${slug}:${round}:${fullyFinished ? "done" : "live"}`);
      if (round === "6") {
        return {
          round,
          rows: [{ teamId: 10, idealTotal: 20, realTotal: 18 } as never],
        };
      }
      return {
        round,
        rows: [
          { teamId: 10, idealTotal: 50, realTotal: 45 } as never,
          { teamId: 11, idealTotal: 40, realTotal: 38 } as never,
        ],
      };
    },
  });

  assert.deepEqual(computed, ["championship:1:done", "championship:2:done"]);
  assert.deepEqual(totals.rounds, ["1", "2"]);
  assert.equal(totals.byTeamId.get(10), 100);
  assert.equal(totals.byTeamId.get(11), 80);
  assert.equal(totals.realByTeamId.get(10), 90);
  assert.equal(totals.realByTeamId.get(11), 76);
  assert.equal(totals.byTeamId.get(10)! > totals.realByTeamId.get(10)!, true);
});

test("lockedTourSquadIds is XI + bench and skips not-in-squad", () => {
  assert.deepEqual(
    lockedTourSquadIds({
      lineup: [{ playerId: 1 }, { playerId: 2 }],
      squad: [{ playerId: 1 }, { playerId: 3 }],
      substitutes: [{ playerId: 4 }, { playerId: null }],
    }),
    [1, 3, 4, 2],
  );
  assert.equal(
    lockedTourSquadIds({
      lineup: [{ playerId: 1 }],
      squad: [{ playerId: 1 }],
      substitutes: [{ playerId: 4 }],
    }).includes(99),
    false,
  );
});

test("resolveTourSquadIds uses locked pool only when asked and non-empty", () => {
  assert.deepEqual(resolveTourSquadIds([10, 11], [1, 2, 3], true), [1, 2, 3]);
  assert.deepEqual(resolveTourSquadIds([10, 11], [], true), [10, 11]);
  assert.deepEqual(resolveTourSquadIds([10, 11], [1, 2], false), [10, 11]);
});

test("floorIdealAtActual keeps picked Ideal when it beats Real XI", () => {
  assert.equal(floorIdealAtActual(70, 60), 70);
  assert.equal(floorIdealAtActual(50, 80), 80);
  assert.equal(floorIdealAtActual(0, 66.74), 66.74);
});

test("sumSeasonIdealByTeam floors each tour at actual XI so Ideal >= Real", () => {
  const summed = sumSeasonIdealByTeam([
    {
      rows: [
        { teamId: 1, idealTotal: 50, realTotal: 80, realXiTotal: 80, formation: "4-4-2" },
        { teamId: 2, idealTotal: 0, realTotal: 70, realXiTotal: 70, formation: null, idealXi: [] },
      ],
    },
    {
      rows: [
        { teamId: 1, idealTotal: 70, realTotal: 60, realXiTotal: 60, formation: "3-5-2" },
      ],
    },
  ]);
  assert.equal(summed.get(1), 150);
  assert.equal(summed.get(2), 70);
});

test("finishedRoundsAlignedToGames keeps later FT tours and drops unfinished holes", () => {
  const scored = [
    { round: "1", fullyFinished: true },
    { round: "2", fullyFinished: true },
    { round: "3", fullyFinished: false },
    { round: "4", fullyFinished: false },
    { round: "5", fullyFinished: true },
    { round: "6", fullyFinished: true },
    { round: "7", fullyFinished: true },
    { round: "8", fullyFinished: true },
    { round: "9", fullyFinished: true },
  ];
  assert.deepEqual(
    finishedRoundsAlignedToGames(scored, 7).map((item) => item.round),
    ["1", "2", "5", "6", "7", "8", "9"],
  );
  assert.deepEqual(
    finishedRoundsAlignedToGames(scored, 9).map((item) => item.round),
    ["1", "2", "5", "6", "7", "8", "9"],
  );
  assert.deepEqual(
    finishedRoundsAlignedToGames(
      [
        { round: "1", fullyFinished: true },
        { round: "2", fullyFinished: true },
        { round: "3", fullyFinished: true },
        { round: "4", fullyFinished: true },
        { round: "5", fullyFinished: false },
      ],
      5,
    ).map((item) => item.round),
    ["1", "2", "3", "4"],
  );
  assert.deepEqual(
    finishedRoundsAlignedToGames(scored, undefined).map((item) => item.round),
    ["1", "2", "5", "6", "7", "8", "9"],
  );
});

test("idealRoundSetEquals ignores order and treats unfinished extras as a miss", () => {
  assert.equal(idealRoundSetEquals(["1", "2", "8", "9"], ["9", "8", "2", "1"]), true);
  assert.equal(
    idealRoundSetEquals(["1", "2", "3", "4", "5", "6", "7", "8", "9"], [
      "1",
      "2",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]),
    false,
  );
});

test("loadSeasonIdealTotals sums fully finished rounds, ignoring a GAMES cap", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE fotmob_matches (
      id INTEGER PRIMARY KEY,
      league_id INTEGER,
      round TEXT,
      phase TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO fotmob_matches (id, league_id, round, phase) VALUES (?, ?, ?, ?)`,
  );
  insert.run(1, 48, "1", "finished");
  insert.run(2, 48, "2", "finished");
  insert.run(3, 48, "3", "finished");
  insert.run(4, 48, "4", "finished");
  insert.run(5, 48, "5", "finished");
  insert.run(6, 48, "6", "live");

  const computed: string[] = [];
  const totals = loadSeasonIdealTotals("championship", {
    database: db,
    maxRounds: 4,
    computeRound: (round, slug, fullyFinished) => {
      computed.push(`${slug}:${round}:${fullyFinished ? "done" : "live"}`);
      return {
        round,
        rows: [
          {
            teamId: 10,
            idealTotal: 40,
            realTotal: 50,
            realXiTotal: 50,
            formation: "4-3-3",
          } as never,
        ],
      };
    },
  });

  assert.deepEqual(computed, [
    "championship:1:done",
    "championship:2:done",
    "championship:3:done",
    "championship:4:done",
    "championship:5:done",
  ]);
  assert.deepEqual(totals.rounds, ["1", "2", "3", "4", "5"]);
  assert.equal(totals.byTeamId.get(10), 250);
});

test("loadSeasonIdealTotals skips an unfinished GW even if Mantra GAMES already counts it", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE fotmob_matches (
      id INTEGER PRIMARY KEY,
      league_id INTEGER,
      round TEXT,
      phase TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO fotmob_matches (id, league_id, round, phase) VALUES (?, ?, ?, ?)`,
  );
  insert.run(1, 55, "1", "finished");
  insert.run(2, 55, "2", "finished");
  insert.run(3, 55, "3", "finished");
  insert.run(4, 55, "4", "finished");
  insert.run(5, 55, "5", "live");

  const computed: string[] = [];
  const totals = loadSeasonIdealTotals("serie-a", {
    database: db,
    maxRounds: 5,
    computeRound: (round, slug, fullyFinished) => {
      computed.push(`${slug}:${round}:${fullyFinished ? "done" : "live"}`);
      return {
        round,
        rows: [
          {
            teamId: 10,
            idealTotal: 40,
            realTotal: 37,
            realXiTotal: 37,
            formation: "4-3-3",
          } as never,
        ],
      };
    },
  });

  assert.deepEqual(computed, [
    "serie-a:1:done",
    "serie-a:2:done",
    "serie-a:3:done",
    "serie-a:4:done",
  ]);
  assert.deepEqual(totals.rounds, ["1", "2", "3", "4"]);
  assert.equal(totals.byTeamId.get(10), 160);
});

test("UPL finished window is 3,4,5,7 — skips unfinished 1,2,6", () => {
  const scored = [
    { round: "1", fullyFinished: false },
    { round: "2", fullyFinished: false },
    { round: "3", fullyFinished: true },
    { round: "4", fullyFinished: true },
    { round: "5", fullyFinished: true },
    { round: "6", fullyFinished: false },
    { round: "7", fullyFinished: true },
  ];
  assert.deepEqual(
    finishedRoundsAlignedToGames(scored, 4).map((item) => item.round),
    ["3", "4", "5", "7"],
  );
});

function gwPlayer(positions: string[], total: number, name: string, base = 6.5): ScoredSquadPlayer {
  const id = squadSeq++;
  return {
    mantraPlayerId: id,
    fotmobPlayerId: null,
    name,
    displayName: name,
    clubName: "UPL",
    positions,
    stats: {
      ...stats(0),
      rating: 0,
      yellowCards: 1,
      minutes: null,
    },
    teamCleanSheet: false,
    minutes: 90,
    rating: 0,
    mantraGwTotal: total,
    mantraGwBase: base,
  };
}

test("mantra GW total is the complete score — FotMob 0 rating and YC are ignored", () => {
  const bd = breakdownFromMantraGwTotal(9.5, 6.5);
  assert.equal(bd.total, 9.5);
  assert.equal(bd.base, 6.5);
  assert.equal(bd.events.length, 0);
  const gk = gwPlayer(["GK"], 8.5, "Bilyk");
  const rest = [
    gwPlayer(["RB"], 6.1, "RB"),
    gwPlayer(["CB"], 6.2, "CB1"),
    gwPlayer(["CB"], 6.3, "CB2"),
    gwPlayer(["LB"], 6.4, "LB"),
    gwPlayer(["WB"], 6.5, "WB"),
    gwPlayer(["CM"], 7.9, "CM1"),
    gwPlayer(["CM"], 6.6, "CM2"),
    gwPlayer(["W"], 7.0, "W"),
    gwPlayer(["FW"], 6.3, "FW1"),
    gwPlayer(["ST"], 6.8, "ST"),
  ];
  const ideal = pickIdeal([gk, ...rest]);
  assert.ok(ideal);
  const playerSum = [gk, ...rest].reduce((s, p) => s + (p.mantraGwTotal ?? 0), 0);
  assert.ok(ideal!.totalScore + 1e-9 >= playerSum);
  const bilyk = ideal!.starters.find((p) => p.name === "Bilyk");
  assert.equal(bilyk?.breakdown.total, 8.5);
  assert.equal(bilyk?.breakdown.events.length, 0);
});

test("locked full XI: Ideal TS >= posted Mantra TS, and floor covers a hole", () => {
  const posted = 79.2;
  const xi = [
    gwPlayer(["GK"], 8.5, "GK"),
    gwPlayer(["RB"], 6.1, "RB"),
    gwPlayer(["CB"], 6.2, "CB1"),
    gwPlayer(["CB"], 6.3, "CB2"),
    gwPlayer(["LB"], 6.4, "LB"),
    gwPlayer(["WB"], 6.5, "WB"),
    gwPlayer(["CM"], 7.9, "CM1"),
    gwPlayer(["CM"], 6.6, "CM2"),
    gwPlayer(["W"], 7.0, "W"),
    gwPlayer(["FW"], 6.3, "FW1"),
    gwPlayer(["ST"], 6.8, "ST"),
  ];
  const picked = pickIdeal(xi);
  assert.ok(picked);
  const floored = floorIdealAtActual(picked!.totalScore, posted);
  assert.ok(floored + 1e-9 >= posted);
  assert.equal(floorIdealAtActual(48.1, posted), posted);
});

test("UPL combined % is not 135% when Ideal uses the same 4 finished GWs", () => {
  const real = 79.2 + 88.9 + 88.9 + 82.9;
  const summed = sumSeasonIdealByTeam([
    {
      rows: [
        {
          teamId: 4445,
          idealTotal: 48.1,
          realTotal: 79.2,
          realXiTotal: 79.2,
          formation: "4-3-3",
          idealXi: [{ name: "Bilyk" }],
        },
      ],
    },
    {
      rows: [
        {
          teamId: 4445,
          idealTotal: 90,
          realTotal: 88.9,
          realXiTotal: 88.9,
          formation: "3-5-1-1",
          idealXi: [{ name: "Bilyk" }],
        },
      ],
    },
    {
      rows: [
        {
          teamId: 4445,
          idealTotal: 88.9,
          realTotal: 88.9,
          realXiTotal: 88.9,
          formation: "3-5-2",
          idealXi: [{ name: "Bilyk" }],
        },
      ],
    },
    {
      rows: [
        {
          teamId: 4445,
          idealTotal: 82.9,
          realTotal: 82.9,
          realXiTotal: 82.9,
          formation: "3-5-2",
          idealXi: [{ name: "Bilyk" }],
        },
      ],
    },
  ]);
  const idealTs = summed.get(4445)!;
  assert.ok(idealTs + 1e-9 >= real);
  const pct = Math.round((real / idealTs) * 1000) / 10;
  assert.ok(pct <= 100);
  assert.notEqual(pct, 135.3);
});
