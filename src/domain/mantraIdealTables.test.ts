import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { MantraTourRound } from "../clients/mantraAuth.js";
import {
  buildIdealDivisionTable,
  getIdealDivisionTable,
  idealMatchOutcome,
  idealVsRealOutcomeHighlight,
  peekIdealTableOverlay,
  peekIdealTableStats,
  realGoalsForSide,
  realTsForSide,
  resetIdealTableCacheForTests,
  resolveIdealDivision,
  tourArchiveIsOfficial,
  toursMatchRequestedRound,
  warmIdealTables,
  invalidateIdealTableCache,
  setIdealTableScheduler,
  xiFantasyGoals,
  IDEAL_TABLE_TTL_MS,
} from "./mantraIdealTables.js";
import { resetMantraStandingsCacheForTests } from "./mantraStandings.js";
import { resetComputedCacheForTests, writeComputed, peekComputedPersisted } from "../lib/computedCache.js";

test.afterEach(() => {
  resetIdealTableCacheForTests();
  resetMantraStandingsCacheForTests();
  resetComputedCacheForTests();
});

function tour(overrides: Partial<MantraTourRound> & { matches: MantraTourRound["matches"] }): MantraTourRound {
  return {
    tourId: 20172,
    leagueId: 658,
    division: "A1",
    name: "Istanbul",
    label: "A1 | Istanbul",
    round: 6,
    live: false,
    url: "/tours/20172",
    deadline: null,
    deadlineLabel: null,
    syncedAt: "2026-09-21T10:00:00.000Z",
    ...overrides,
  };
}

function side(
  teamId: number,
  teamName: string,
  extra: Partial<{ score: number | null; goals: number | null; scoredCount: number | null }> = {},
) {
  return {
    teamId,
    teamName,
    logoUrl: null,
    score: extra.score ?? null,
    scoredCount: extra.scoredCount ?? null,
    goals: extra.goals ?? null,
  };
}

function xi(name: string, ts: number, goals = 0) {
  return {
    mantraPlayerId: 1,
    fotmobPlayerId: 1,
    name,
    displayName: name,
    clubName: "Club",
    positions: ["FW"],
    slotLabel: "FW",
    baseScore: ts,
    totalScore: ts,
    events: goals > 0 ? [{ key: "goal" as const, count: goals, delta: goals * 3 }] : [],
    minutes: 90,
    rating: 7,
  };
}

test("xiFantasyGoals sums open-play and penalty goals, not own goals", () => {
  assert.equal(xiFantasyGoals(null), 0);
  assert.equal(
    xiFantasyGoals([
      { events: [{ key: "goal", count: 2 }, { key: "pen", count: 1 }, { key: "og", count: 1 }] },
      { events: [{ key: "assist", count: 3 }] },
    ]),
    3,
  );
});

test("toursMatchRequestedRound rejects live fallback pairings from another round", () => {
  assert.equal(toursMatchRequestedRound("6", 6), true);
  assert.equal(toursMatchRequestedRound("6", "6"), true);
  assert.equal(toursMatchRequestedRound("1", 6), false);
  assert.equal(toursMatchRequestedRound("1", null), false);
});

test("resolveIdealDivision maps A1 and A1 | Istanbul for Super Lig", () => {
  const a1 = resolveIdealDivision("super-lig", "A1");
  assert.equal(a1?.leagueId, 658);
  assert.equal(a1?.name, "Istanbul");
  assert.equal(resolveIdealDivision("super-lig", "A1 | Istanbul")?.leagueId, 658);
  assert.equal(resolveIdealDivision("super-lig", "Z9"), null);
  assert.equal(resolveIdealDivision("super-lig", ""), null);
});

test("idealMatchOutcome uses goals, so 2–2 is a draw even if TS differs", () => {
  assert.equal(idealMatchOutcome(4, 0), "H");
  assert.equal(idealMatchOutcome(1, 3), "A");
  assert.equal(idealMatchOutcome(2, 2), "D");
  assert.equal(idealMatchOutcome(0, 0), "D");
});

test("buildIdealDivisionTable awards points from Ideal XI goals, not TS", () => {
  const a1 = resolveIdealDivision("super-lig", "A1")!;
  const built = buildIdealDivisionTable(a1, [
    {
      round: "6",
      toursRound: 6,
      tours: [
        tour({
          matches: [
            {
              matchId: 11,
              url: null,
              locked: true,
              home: side(1, "Onolitik FC"),
              away: side(2, "GianlucaDualipa"),
            },
          ],
        }),
        tour({
          leagueId: 659,
          division: "B1",
          name: "Ankara",
          label: "B1 | Ankara",
          matches: [
            {
              matchId: 99,
              url: null,
              locked: true,
              home: side(90, "Other"),
              away: side(91, "Skip me"),
            },
          ],
        }),
      ],
      idealRows: [
        {
          teamId: 1,
          teamName: "Onolitik FC",
          idealTotal: 69.87,
          formation: "3-4-3",
          idealPlayersTotal: 66.87,
          idealDefenceBonus: 3,
          idealXi: [xi("Alpha", 69.87, 1)],
        },
        {
          teamId: 2,
          teamName: "GianlucaDualipa",
          idealTotal: 100.34,
          formation: "4-3-3",
          idealXi: [xi("Beta", 100.34, 2)],
        },
        { teamId: 90, teamName: "Other", idealTotal: 200 },
      ],
    },
    {
      round: "5",
      toursRound: 5,
      tours: [
        tour({
          round: 5,
          matches: [
            {
              matchId: 10,
              url: null,
              locked: true,
              home: side(2, "GianlucaDualipa"),
              away: side(1, "Onolitik FC"),
            },
          ],
        }),
      ],
      idealRows: [
        { teamId: 1, teamName: "Onolitik FC", idealTotal: 80, idealXi: [xi("Alpha", 80, 3)] },
        { teamId: 2, teamName: "GianlucaDualipa", idealTotal: 70, idealXi: [xi("Beta", 70, 0)] },
      ],
    },
  ]);

  assert.deepEqual(built.rounds, ["6", "5"]);
  assert.equal(built.rows.length, 2);
  assert.equal(built.rows.some((row) => row.teamId === 90), false);
  const first = built.rows[0]!;
  const second = built.rows[1]!;
  assert.equal(first.teamName, "GianlucaDualipa");
  assert.equal(first.games, 2);
  assert.equal(first.wins, 1);
  assert.equal(first.draws, 0);
  assert.equal(first.loses, 1);
  assert.equal(first.points, 3);
  assert.equal(first.ts, 170.34);
  assert.deepEqual(first.form, ["W", "L"]);
  assert.equal(first.gf, 5);
  assert.equal(first.ga, 2);
  assert.equal(first.gd, 3);
  assert.equal(first.rank, 1);
  assert.equal(second.teamName, "Onolitik FC");
  assert.equal(second.points, 3);
  assert.equal(second.ts, 149.87);
  assert.deepEqual(second.form, ["L", "W"]);
  assert.equal(second.gf, 2);
  assert.equal(second.ga, 5);
  assert.equal(second.gd, -3);

  const tour6 = built.tours.find((item) => item.round === "6");
  assert.equal(tour6?.matches.length, 1);
  assert.equal(tour6?.matches[0]?.outcome, "A");
  assert.equal(tour6?.matches[0]?.home.ts, 69.87);
  assert.equal(tour6?.matches[0]?.away.ts, 100.34);
  assert.equal(tour6?.matches[0]?.home.goals, 0);
  assert.equal(tour6?.matches[0]?.away.goals, 5);
  assert.equal(tour6?.matches[0]?.home.realTs, null);
  assert.equal(tour6?.matches[0]?.away.realTs, null);
  assert.equal(tour6?.matches[0]?.home.realGoals, null);
  assert.equal(tour6?.matches[0]?.away.realGoals, null);
  assert.equal(tour6?.matches[0]?.away.idealXi[0]?.name, "Beta");
  assert.equal(tour6?.label, "A1 | Istanbul");
});

test("realTsForSide prefers results-history over tour score and never uses Real XI", () => {
  assert.equal(realTsForSide(73.8, { realXiTotal: 10, realTotal: 9 }, { ts: 82.5, goals: 2 }), 82.5);
  assert.equal(realTsForSide(44.3, { realXiTotal: 49.1 }, { ts: 82.5, goals: 2 }), 82.5);
  assert.equal(realTsForSide(73.8), 73.8);
  assert.equal(realTsForSide(0, { realXiTotal: 71.25, realTotal: 60 }), null);
  assert.equal(realTsForSide(null, { realXiTotal: 71.25, realTotal: 60 }), null);
  assert.equal(realTsForSide("", { realTotal: 68 }), null);
  assert.equal(realTsForSide(undefined, {}), null);
});

test("tourArchiveIsOfficial requires 11 scored players and rejects placeholder 0-0", () => {
  assert.equal(tourArchiveIsOfficial({ scoredCount: 11, goals: 1 }, { scoredCount: 11, goals: 0 }), true);
  assert.equal(tourArchiveIsOfficial({ scoredCount: 11 }, { scoredCount: 11 }), true);
  assert.equal(tourArchiveIsOfficial({ scoredCount: 11, goals: 0 }, { scoredCount: 11, goals: 0 }), false);
  assert.equal(tourArchiveIsOfficial({ scoredCount: 6 }, { scoredCount: 11 }), false);
  assert.equal(tourArchiveIsOfficial({ scoredCount: 0 }, { scoredCount: 0 }), false);
  assert.equal(tourArchiveIsOfficial({ scoredCount: null }, { scoredCount: 11 }), false);
});

test("realGoalsForSide hides placeholder 0-0 unless history has it", () => {
  assert.equal(realGoalsForSide(0, { ts: 82.5, goals: 2 }), 2);
  assert.equal(realGoalsForSide(0, { ts: 71.8, goals: 0 }), 0);
  assert.equal(realGoalsForSide(0, null, false), null);
  assert.equal(realGoalsForSide(2, null, true), 2);
  assert.equal(realGoalsForSide(0, null, true), null);
});

test("buildIdealDivisionTable copies Mantra tour TS and goals onto each match", () => {
  const a1 = resolveIdealDivision("super-lig", "A1")!;
  const built = buildIdealDivisionTable(a1, [
    {
      round: "6",
      toursRound: 6,
      tours: [
        tour({
          matches: [
            {
              matchId: 11,
              url: null,
              locked: true,
              home: { ...side(1, "Onolitik FC"), score: 73.8, goals: 2, scoredCount: 11 },
              away: { ...side(2, "GianlucaDualipa"), score: 71.2, goals: 1, scoredCount: 11 },
            },
          ],
        }),
      ],
      idealRows: [
        { teamId: 1, teamName: "Onolitik FC", idealTotal: 80, realXiTotal: 10, idealXi: [xi("A", 80)] },
        { teamId: 2, teamName: "GianlucaDualipa", idealTotal: 70, realTotal: 9, idealXi: [xi("B", 70)] },
      ],
    },
  ]);
  const match = built.tours[0]?.matches[0];
  assert.equal(match?.home.realTs, 73.8);
  assert.equal(match?.away.realTs, 71.2);
  assert.equal(match?.home.realGoals, 2);
  assert.equal(match?.away.realGoals, 1);
  assert.equal(match?.home.ts, 80);
});

test("buildIdealDivisionTable does not treat mid-round 0-0 / partial TS as official", () => {
  const a1 = resolveIdealDivision("super-lig", "A1")!;
  const built = buildIdealDivisionTable(a1, [
    {
      round: "4",
      toursRound: 4,
      tours: [
        tour({
          round: 4,
          matches: [
            {
              matchId: 80103,
              url: null,
              locked: true,
              home: { ...side(1, "edhar24"), score: 44.3, goals: 0, scoredCount: 6 },
              away: { ...side(2, "Дністер"), score: 32.9, goals: 0, scoredCount: 5 },
            },
          ],
        }),
      ],
      idealRows: [
        { teamId: 1, teamName: "edhar24", idealTotal: 87.22, realXiTotal: 49.1, idealXi: [xi("A", 87.22)] },
        { teamId: 2, teamName: "Дністер", idealTotal: 86.13, realTotal: 41, idealXi: [xi("B", 86.13)] },
      ],
    },
  ]);
  const match = built.tours[0]?.matches[0];
  assert.equal(match?.home.realTs, null);
  assert.equal(match?.away.realTs, null);
  assert.equal(match?.home.realGoals, null);
  assert.equal(match?.away.realGoals, null);
});

test("buildIdealDivisionTable overlays official results-history TS and goals", () => {
  const a1 = resolveIdealDivision("championship", "A1")!;
  const built = buildIdealDivisionTable(a1, [
    {
      round: "4",
      toursRound: 4,
      officialByTeamId: new Map([
        [1, { ts: 82.5, goals: 2 }],
        [2, { ts: 76.3, goals: 1 }],
      ]),
      tours: [
        tour({
          leagueId: 651,
          division: "A1",
          name: "Cardiff",
          label: "A1 | Cardiff",
          round: 4,
          matches: [
            {
              matchId: 80103,
              url: null,
              locked: true,
              home: { ...side(1, "edhar24"), score: 44.3, goals: 0, scoredCount: 6 },
              away: { ...side(2, "Фк-Дністер Заліщики"), score: 32.9, goals: 0, scoredCount: 5 },
            },
          ],
        }),
      ],
      idealRows: [
        { teamId: 1, teamName: "edhar24", idealTotal: 87.22, realXiTotal: 49.1, idealXi: [xi("A", 87.22, 2)] },
        { teamId: 2, teamName: "Фк-Дністер Заліщики", idealTotal: 86.13, realTotal: 41, idealXi: [xi("B", 86.13, 1)] },
      ],
    },
  ]);
  const match = built.tours[0]?.matches[0];
  assert.equal(match?.home.realTs, 82.5);
  assert.equal(match?.away.realTs, 76.3);
  assert.equal(match?.home.realGoals, 2);
  assert.equal(match?.away.realGoals, 1);
});

test("results-history skips frozen tour 0-0 even when scoredCount is 11", () => {
  const d9 = resolveIdealDivision("serie-a", "D9")!;
  const built = buildIdealDivisionTable(d9, [
    {
      round: "1",
      toursRound: 1,
      officialByTeamId: new Map([
        [2006, { ts: 79.0, goals: 2 }],
        [3604, { ts: 95.4, goals: 4 }],
      ]),
      tours: [
        tour({
          leagueId: 762,
          division: "D9",
          name: "Reggio Calabria",
          label: "D9 | Reggio Calabria",
          round: 1,
          matches: [
            {
              matchId: 1,
              url: null,
              locked: true,
              home: { ...side(2006, "Creative"), score: 49.1, goals: 0, scoredCount: 11 },
              away: { ...side(3604, "E_ball"), score: 41.0, goals: 0, scoredCount: 11 },
            },
          ],
        }),
      ],
      idealRows: [
        { teamId: 2006, teamName: "Creative", idealTotal: 80.98, idealXi: [xi("A", 80.98, 2)] },
        { teamId: 3604, teamName: "E_ball", idealTotal: 97.28, idealXi: [xi("B", 97.28, 1)] },
      ],
    },
  ]);
  const match = built.tours[0]?.matches[0];
  assert.equal(match?.home.realTs, 79);
  assert.equal(match?.away.realTs, 95.4);
  assert.equal(match?.home.realGoals, 2);
  assert.equal(match?.away.realGoals, 4);
});

test("when GW history exists, missing team is unknown instead of frozen archive", () => {
  const d9 = resolveIdealDivision("serie-a", "D9")!;
  const built = buildIdealDivisionTable(d9, [
    {
      round: "1",
      toursRound: 1,
      officialByTeamId: new Map([[2006, { ts: 79.0, goals: 2 }]]),
      tours: [
        tour({
          leagueId: 762,
          division: "D9",
          name: "Reggio Calabria",
          label: "D9 | Reggio Calabria",
          round: 1,
          matches: [
            {
              matchId: 1,
              url: null,
              locked: true,
              home: { ...side(2006, "Creative"), score: 49.1, goals: 0, scoredCount: 11 },
              away: { ...side(3604, "E_ball"), score: 41.0, goals: 0, scoredCount: 11 },
            },
          ],
        }),
      ],
      idealRows: [
        { teamId: 2006, teamName: "Creative", idealTotal: 80.98, idealXi: [xi("A", 80.98)] },
        { teamId: 3604, teamName: "E_ball", idealTotal: 97.28, idealXi: [xi("B", 97.28)] },
      ],
    },
  ]);
  const match = built.tours[0]?.matches[0];
  assert.equal(match?.home.realTs, 79);
  assert.equal(match?.home.realGoals, 2);
  assert.equal(match?.away.realTs, null);
  assert.equal(match?.away.realGoals, null);
});

test("2–2 is a draw in the ideal table even when Ideal TS is not equal", () => {
  const a1 = resolveIdealDivision("super-lig", "A1")!;
  const built = buildIdealDivisionTable(a1, [
    {
      round: "8",
      toursRound: 8,
      tours: [
        tour({
          round: 8,
          matches: [
            {
              matchId: 88,
              url: null,
              locked: true,
              home: side(10, "QQ"),
              away: side(11, "Team Force"),
            },
          ],
        }),
      ],
      idealRows: [
        { teamId: 10, teamName: "QQ", idealTotal: 92.3, idealXi: [xi("A", 92.3, 2)] },
        { teamId: 11, teamName: "Team Force", idealTotal: 90.89, idealXi: [xi("B", 90.89, 2)] },
      ],
    },
  ]);
  const qq = built.rows.find((row) => row.teamId === 10);
  const force = built.rows.find((row) => row.teamId === 11);
  assert.equal(built.tours[0]?.matches[0]?.outcome, "D");
  assert.equal(qq?.wins, 0);
  assert.equal(qq?.draws, 1);
  assert.equal(qq?.points, 1);
  assert.equal(force?.points, 1);
  assert.equal(qq?.gf, 3);
  assert.equal(qq?.ga, 3);
  assert.equal(qq?.ts, 92.3);
});

test("Ideal purple goals convert from TS (72/+7), not player events — Dnipro 94.39 vs Furia 86.50 is 4–3", () => {
  const e3 = resolveIdealDivision("premier-league", "E3")!;
  const built = buildIdealDivisionTable(e3, [
    {
      round: "3",
      toursRound: 3,
      tours: [
        tour({
          leagueId: e3.leagueId,
          division: "E3",
          name: "Gloucester",
          label: "E3 | Gloucester",
          round: 3,
          matches: [
            {
              matchId: 31,
              url: null,
              locked: true,
              home: side(101, "Dnipro City"),
              away: side(102, "Furia"),
            },
          ],
        }),
      ],
      idealRows: [
        { teamId: 101, teamName: "Dnipro City", idealTotal: 94.39, idealXi: [xi("A", 94.39, 2)] },
        { teamId: 102, teamName: "Furia", idealTotal: 86.5, idealXi: [xi("B", 86.5, 0)] },
      ],
    },
  ]);
  const match = built.tours[0]?.matches[0];
  assert.equal(match?.home.ts, 94.39);
  assert.equal(match?.away.ts, 86.5);
  assert.equal(match?.home.goals, 4);
  assert.equal(match?.away.goals, 3);
  assert.equal(match?.outcome, "H");
  assert.equal(xiFantasyGoals([xi("B", 86.5, 0)]), 0);
  const dnipro = built.rows.find((row) => row.teamId === 101);
  assert.equal(dnipro?.gf, 4);
  assert.equal(dnipro?.ga, 3);
  assert.equal(dnipro?.points, 3);
});

test("idealVsRealOutcomeHighlight is yellow for win↔draw and red for opposite winners", () => {
  assert.equal(idealVsRealOutcomeHighlight(1, 0, 2, 2), "yellow");
  assert.equal(idealVsRealOutcomeHighlight(2, 2, 1, 0), "yellow");
  assert.equal(idealVsRealOutcomeHighlight(2, 1, 2, 4), "red");
  assert.equal(idealVsRealOutcomeHighlight(0, 3, 1, 0), "red");
  assert.equal(idealVsRealOutcomeHighlight(2, 0, 3, 0), null);
  assert.equal(idealVsRealOutcomeHighlight(1, 1, 2, 2), null);
  assert.equal(idealVsRealOutcomeHighlight(4, 3, 2, 2), "yellow");
  assert.equal(idealVsRealOutcomeHighlight(1, 0, null, 2), null);
});

test("buildIdealDivisionTable does not count a 0–0 loss when Ideal XI could not be picked", () => {
  const a1 = resolveIdealDivision("super-lig", "A1")!;
  const built = buildIdealDivisionTable(a1, [
    {
      round: "1",
      toursRound: 1,
      tours: [
        tour({
          round: 1,
          matches: [
            {
              matchId: 1,
              url: null,
              locked: true,
              home: side(922, "Mangala Nety"),
              away: side(2532, "Di_Bomzhe"),
            },
          ],
        }),
      ],
      idealRows: [
        {
          teamId: 922,
          teamName: "Mangala Nety",
          idealTotal: 68.93,
          formation: "4-4-1-1",
          idealXi: [xi("Meret", 68.93)],
        },
        {
          teamId: 2532,
          teamName: "Di_Bomzhe",
          idealTotal: 0,
          formation: null,
          idealXi: [],
        },
      ],
    },
  ]);
  const mangala = built.rows.find((row) => row.teamId === 922);
  const bomzhe = built.rows.find((row) => row.teamId === 2532);
  assert.equal(mangala?.games, 0);
  assert.equal(mangala?.points, 0);
  assert.equal(bomzhe?.games, 0);
  assert.equal(bomzhe?.points, 0);
  assert.equal(built.tours[0]?.matches[0]?.home.ts, 68.93);
  assert.equal(built.tours[0]?.matches[0]?.away.ts, null);
});

test("missing tour archive is listed and does not invent pairings", () => {
  const a1 = resolveIdealDivision("super-lig", "A1")!;
  const built = buildIdealDivisionTable(a1, [
    {
      round: "1",
      toursRound: 6,
      tours: [
        tour({
          matches: [
            {
              matchId: 1,
              url: null,
              locked: true,
              home: side(1, "Onolitik FC"),
              away: side(2, "GianlucaDualipa"),
            },
          ],
        }),
      ],
      idealRows: [
        { teamId: 1, idealTotal: 50 },
        { teamId: 2, idealTotal: 40 },
      ],
    },
  ]);
  assert.deepEqual(built.missingTours, ["1"]);
  assert.deepEqual(built.rows, []);
  assert.deepEqual(built.tours, []);
});

test("getIdealDivisionTable skips compute until a division is chosen", async () => {
  let listed = 0;
  const view = await getIdealDivisionTable("super-lig", "", {
    listRounds: () => {
      listed += 1;
      return [{ round: "6", fullyFinished: true }];
    },
  });
  assert.equal(view.reason, "select_division");
  assert.equal(view.cache, "skip");
  assert.equal(view.rows.length, 0);
  assert.equal(view.tours.length, 0);
  assert.equal(listed, 0);
  assert.ok(view.divisions.some((item) => item.code === "A1" && item.name === "Istanbul"));
});

test("getIdealDivisionTable keeps cache after TTL when Mantra GAMES has not increased", async () => {
  let idealCalls = 0;
  const deps = {
    listRounds: () => [{ round: "6", fullyFinished: true }],
    toursForRound: () => ({
      round: 6,
      tours: [
        tour({
          matches: [
            {
              matchId: 11,
              url: null,
              locked: true,
              home: side(1, "Home FC"),
              away: side(2, "Away FC"),
            },
          ],
        }),
      ],
    }),
    idealForRound: () => {
      idealCalls += 1;
      return {
        round: "6",
        rows: [
          { teamId: 1, teamName: "Home FC", idealTotal: 90, idealXi: [xi("H", 90, 1)] },
          { teamId: 2, teamName: "Away FC", idealTotal: 70, idealXi: [xi("A", 70, 0)] },
        ],
      } as never;
    },
  };
  const t0 = Date.parse("2026-09-21T10:00:00.000Z");
  const db = new Database(":memory:");
  const first = await getIdealDivisionTable("super-lig", "A1", {
    ...deps,
    database: db,
    now: () => t0,
    serveStale: false,
  });
  assert.equal(first.cache, "miss");
  assert.equal(first.division, "A1");
  assert.equal(first.rows[0]?.teamName, "Home FC");
  assert.equal(first.rows[0]?.points, 3);
  assert.equal(first.rows[0]?.ts, 90);
  assert.equal(first.tours[0]?.matches[0]?.outcome, "H");
  const afterFirst = idealCalls;

  const hit = await getIdealDivisionTable("super-lig", "A1", {
    ...deps,
    database: db,
    now: () => t0 + IDEAL_TABLE_TTL_MS - 1,
    serveStale: false,
  });
  assert.equal(hit.cache, "hit");
  assert.equal(idealCalls, afterFirst);

  const expired = await getIdealDivisionTable("super-lig", "A1", {
    ...deps,
    database: db,
    now: () => t0 + IDEAL_TABLE_TTL_MS,
    serveStale: false,
  });
  assert.equal(expired.cache, "hit");
  assert.equal(idealCalls, afterFirst);
});

test("getIdealDivisionTable skips unfinished tours so live GWs do not rewrite the table", async () => {
  const asked: string[] = [];
  const db = new Database(":memory:");
  const view = await getIdealDivisionTable("super-lig", "A1", {
    database: db,
    now: () => Date.parse("2026-09-21T10:00:00.000Z"),
    serveStale: false,
    listRounds: () => [
      { round: "5", fullyFinished: true },
      { round: "6", fullyFinished: false },
    ],
    toursForRound: (round) => {
      asked.push(`tours:${round}`);
      return {
        round: Number(round),
        tours: [
          tour({
            round: Number(round),
            matches: [
              {
                matchId: Number(round),
                url: null,
                locked: true,
                home: side(1, "Home FC"),
                away: side(2, "Away FC"),
              },
            ],
          }),
        ],
      };
    },
    idealForRound: (round) => {
      asked.push(`ideal:${round}`);
      return {
        round,
        rows: [
          { teamId: 1, teamName: "Home FC", idealTotal: round === "6" ? 99 : 80, idealXi: [] },
          { teamId: 2, teamName: "Away FC", idealTotal: 70, idealXi: [] },
        ],
      } as never;
    },
  });
  assert.deepEqual(asked, ["tours:5", "ideal:5"]);
  assert.deepEqual(view.rounds, ["5"]);
  assert.equal(view.rows[0]?.ts, 80);
  assert.equal(view.tours.length, 1);
  assert.equal(view.tours[0]?.round, "5");
});

test("getIdealDivisionTable skips a scored GW that is not fully finished", async () => {
  const asked: string[] = [];
  const db = new Database(":memory:");
  const view = await getIdealDivisionTable("super-lig", "A1", {
    database: db,
    now: () => Date.parse("2026-09-21T10:00:00.000Z"),
    serveStale: false,
    maxRounds: 6,
    listRounds: () => [
      { round: "5", fullyFinished: true },
      { round: "6", fullyFinished: false },
    ],
    toursForRound: (round) => {
      asked.push(`tours:${round}`);
      return {
        round: Number(round),
        tours: [
          tour({
            round: Number(round),
            matches: [
              {
                matchId: Number(round),
                url: null,
                locked: true,
                home: side(1, "Home FC"),
                away: side(2, "Away FC"),
              },
            ],
          }),
        ],
      };
    },
    idealForRound: (round) => {
      asked.push(`ideal:${round}`);
      return {
        round,
        rows: [
          { teamId: 1, teamName: "Home FC", idealTotal: round === "6" ? 99 : 80, idealXi: [] },
          { teamId: 2, teamName: "Away FC", idealTotal: 70, idealXi: [] },
        ],
      } as never;
    },
  });
  assert.deepEqual(asked, ["tours:5", "ideal:5"]);
  assert.deepEqual(view.rounds, ["5"]);
  assert.equal(view.rows[0]?.ts, 80);
});

test("getIdealDivisionTable builds later FT tours and skips unfinished holes", async () => {
  const asked: string[] = [];
  const db = new Database(":memory:");
  const view = await getIdealDivisionTable("super-lig", "A1", {
    database: db,
    now: () => Date.parse("2026-09-22T10:00:00.000Z"),
    serveStale: false,
    maxRounds: 7,
    listRounds: () => [
      { round: "1", fullyFinished: true },
      { round: "2", fullyFinished: true },
      { round: "3", fullyFinished: false },
      { round: "4", fullyFinished: false },
      { round: "5", fullyFinished: true },
      { round: "8", fullyFinished: true },
      { round: "9", fullyFinished: true },
    ],
    toursForRound: (round) => {
      asked.push(`tours:${round}`);
      return {
        round: Number(round),
        tours: [
          tour({
            round: Number(round),
            matches: [
              {
                matchId: Number(round),
                url: null,
                locked: true,
                home: side(1, "Home FC"),
                away: side(2, "Away FC"),
              },
            ],
          }),
        ],
      };
    },
    idealForRound: (round) => {
      asked.push(`ideal:${round}`);
      return {
        round,
        rows: [
          { teamId: 1, teamName: "Home FC", idealTotal: 10, idealXi: [] },
          { teamId: 2, teamName: "Away FC", idealTotal: 10, idealXi: [] },
        ],
      } as never;
    },
  });
  assert.deepEqual(asked, [
    "tours:1",
    "ideal:1",
    "tours:2",
    "ideal:2",
    "tours:5",
    "ideal:5",
    "tours:8",
    "ideal:8",
    "tours:9",
    "ideal:9",
  ]);
  assert.deepEqual(view.rounds, ["1", "2", "5", "8", "9"]);
  assert.equal(
    asked.some((item) => item.endsWith(":3") || item.endsWith(":4")),
    false,
  );
});

test("invalid division does not fetch round details", async () => {
  let listed = 0;
  const view = await getIdealDivisionTable("super-lig", "ZZ", {
    listRounds: () => {
      listed += 1;
      return [{ round: "6", fullyFinished: true }];
    },
  });
  assert.equal(view.ok, false);
  assert.equal(view.reason, "invalid_division");
  assert.equal(listed, 0);
});

test("peekIdealTableStats reads cached Ideal POINTS without recomputing", async () => {
  let listed = 0;
  const db = new Database(":memory:");
  await getIdealDivisionTable("super-lig", "A1", {
    database: db,
    now: () => Date.parse("2026-09-22T10:00:00.000Z"),
    serveStale: false,
    maxRounds: 8,
    listRounds: () => {
      listed += 1;
      return [{ round: "8", fullyFinished: true }];
    },
    toursForRound: () => ({
      round: 8,
      tours: [
        tour({
          round: 8,
          matches: [
            {
              matchId: 88,
              url: null,
              locked: true,
              home: side(10, "QQ"),
              away: side(11, "Team Force"),
            },
          ],
        }),
      ],
    }),
    idealForRound: () =>
      ({
        round: "8",
        rows: [
          { teamId: 10, teamName: "QQ", idealTotal: 86.5, idealXi: [xi("A", 86.5, 0)] },
          { teamId: 11, teamName: "Team Force", idealTotal: 72, idealXi: [xi("B", 72, 5)] },
        ],
      }) as never,
  });
  const after = listed;
  const stats = peekIdealTableStats("super-lig", db);
  assert.equal(listed, after);
  assert.equal(stats.get(10)?.points, 3);
  assert.equal(stats.get(10)?.gf, 3);
  assert.equal(stats.get(11)?.gf, 1);
  assert.equal(stats.get(11)?.points, 0);
});

function idealSnapshot(
  rounds: string[],
  rows: Array<{ teamId: number; gf: number; ga: number; gd: number; points: number; ts?: number }>,
  meta: { league?: string; name?: string; division?: string } = {},
) {
  const league = meta.league ?? "super-lig";
  const division = meta.division ?? "A1";
  return {
    fetchedAt: "2026-09-22T10:00:00.000Z",
    view: {
      ok: true,
      empty: false,
      reason: null,
      league,
      name: meta.name ?? "Süper Lig",
      division,
      divisionLabel: `${division} | Istanbul`,
      fetchedAt: "2026-09-22T10:00:00.000Z",
      rounds,
      missingTours: [],
      rows: rows.map((row, index) => ({
        rank: index + 1,
        teamName: `Team ${row.teamId}`,
        teamLogo: null,
        games: rounds.length,
        wins: 0,
        draws: 0,
        loses: 0,
        ts: 100,
        avgTs: null,
        form: [],
        ...row,
      })),
      tours: [],
    },
  };
}

test("peekIdealTableStats fills i* from a previous prefix without recomputing XI", () => {
  const db = new Database(":memory:");
  writeComputed(
    "mantra-ideal-table:v3:super-lig:A1",
    "v1",
    idealSnapshot(["1", "2", "3", "4", "5"], [
      { teamId: 10, gf: 9, ga: 4, gd: 5, points: 12 },
      { teamId: 11, gf: 4, ga: 9, gd: -5, points: 3 },
    ]),
    { database: db },
  );
  const stats = peekIdealTableStats("super-lig", db);
  assert.equal(stats.get(10)?.gf, 9);
  assert.equal(stats.get(10)?.points, 12);
  assert.equal(stats.get(11)?.ga, 9);
});

test("peekIdealTableOverlay fills Ideal TS + rounds for extra-league C1", () => {
  const db = new Database(":memory:");
  writeComputed(
    "mantra-ideal-table:v4-pen:ligue-1:C1",
    "v1",
    idealSnapshot(
      ["1", "2", "3", "4", "5"],
      [{ teamId: 88, gf: 18, ga: 13, gd: 5, points: 12, ts: 471.63 }],
      { league: "ligue-1", name: "Ligue 1", division: "C1" },
    ),
    { database: db },
  );
  const overlay = peekIdealTableOverlay("ligue-1", db);
  assert.equal(overlay.stats.get(88)?.points, 12);
  assert.equal(overlay.stats.get(88)?.ts, 471.63);
  assert.equal(overlay.byTeamId.get(88), 471.63);
  assert.deepEqual(overlay.rounds, ["1", "2", "3", "4", "5"]);
});

test("getIdealDivisionTable serves the previous prefix and does not rebuild XI", async () => {
  let listed = 0;
  const db = new Database(":memory:");
  writeComputed(
    "mantra-ideal-table:v3:super-lig:A1",
    "v1",
    idealSnapshot(["1", "2", "3", "4", "5"], [{ teamId: 10, gf: 9, ga: 4, gd: 5, points: 12 }]),
    { database: db },
  );
  const view = await getIdealDivisionTable("super-lig", "A1", {
    database: db,
    listRounds: () => {
      listed += 1;
      return ["1", "2", "3", "4", "5"].map((round) => ({ round, fullyFinished: true }));
    },
  });
  assert.equal(view.cache, "hit");
  assert.equal(view.rows[0]?.points, 12);
  assert.equal(listed, 1);
});

test("getIdealDivisionTable rebuilds when cached Ideal TS is all zeros", async () => {
  let idealCalls = 0;
  const db = new Database(":memory:");
  writeComputed(
    "mantra-ideal-table:v4-pen:upl:A1",
    "v1",
    idealSnapshot(["3", "4", "5", "7"], [{ teamId: 1, gf: 0, ga: 0, gd: 0, points: 4, ts: 0 }]),
    { database: db },
  );
  const view = await getIdealDivisionTable("upl", "A1", {
    database: db,
    serveStale: false,
    listRounds: () =>
      ["3", "4", "5", "7"].map((round) => ({ round, fullyFinished: true })),
    toursForRound: (round) => ({
      round: Number(round),
      tours: [
        tour({
          leagueId: 587,
          division: "A1",
          name: "Kyiv",
          round: Number(round),
          matches: [
            {
              matchId: 1,
              url: null,
              locked: true,
              home: side(1, "Home FC", { score: 80, goals: 2 }),
              away: side(2, "Away FC", { score: 70, goals: 1 }),
            },
          ],
        }),
      ],
    }),
    idealForRound: () => {
      idealCalls += 1;
      return {
        round: "3",
        rows: [
          { teamId: 1, teamName: "Home FC", idealTotal: 90, idealXi: [xi("H", 90, 1)] },
          { teamId: 2, teamName: "Away FC", idealTotal: 70, idealXi: [xi("A", 70, 0)] },
        ],
      } as never;
    },
  });
  assert.ok(idealCalls > 0);
  assert.equal(view.cache, "miss");
  assert.ok((view.rows[0]?.ts ?? 0) > 0);
});

test("getIdealDivisionTable rebuilds when a new FotMob GW is fully finished", async () => {
  let idealCalls = 0;
  const db = new Database(":memory:");
  writeComputed(
    "mantra-ideal-table:v4-pen:super-lig:A1",
    "v1",
    idealSnapshot(["1", "2", "3", "4", "5"], [{ teamId: 1, gf: 8, ga: 3, gd: 5, points: 10 }]),
    { database: db },
  );
  let scored = ["1", "2", "3", "4", "5"].map((round) => ({ round, fullyFinished: true }));
  const deps = {
    database: db,
    serveStale: false as const,
    listRounds: () => scored,
    toursForRound: () => ({
      round: 6,
      tours: [
        tour({
          round: 6,
          matches: [
            {
              matchId: 11,
              url: null,
              locked: true,
              home: side(1, "Home FC"),
              away: side(2, "Away FC"),
            },
          ],
        }),
      ],
    }),
    idealForRound: () => {
      idealCalls += 1;
      return {
        round: "6",
        rows: [
          { teamId: 1, teamName: "Home FC", idealTotal: 90, idealXi: [xi("H", 90, 1)] },
          { teamId: 2, teamName: "Away FC", idealTotal: 70, idealXi: [xi("A", 70, 0)] },
        ],
      } as never;
    },
  };
  const kept = await getIdealDivisionTable("super-lig", "A1", deps);
  assert.equal(kept.cache, "hit");
  assert.equal(idealCalls, 0);

  scored = ["1", "2", "3", "4", "5", "6"].map((round) => ({ round, fullyFinished: true }));
  const rebuilt = await getIdealDivisionTable("super-lig", "A1", deps);
  assert.equal(rebuilt.cache, "miss");
  assert.ok(idealCalls > 0);
});

test("invalidateIdealTableCache does not delete sqlite snapshots", () => {
  const db = new Database(":memory:");
  const key = "mantra-ideal-table:v3:super-lig:A1";
  writeComputed(key, "v1", idealSnapshot(["5"], [{ teamId: 10, gf: 2, ga: 1, gd: 1, points: 3 }]), {
    database: db,
  });
  invalidateIdealTableCache({ database: db, persist: true });
  const kept = peekComputedPersisted<{ view: { rows: Array<{ gf: number }> } }>(key, { database: db });
  assert.equal(kept?.view.rows[0]?.gf, 2);
});

test("warmIdealTables does not schedule a rebuild when fallback tables cover GAMES", () => {
  const db = new Database(":memory:");
  const queued: Array<() => void | Promise<void>> = [];
  setIdealTableScheduler((work) => {
    queued.push(work);
  });
  writeComputed(
    "mantra-standings:v3:super-lig",
    "v1",
    {
      fetchedAt: "2026-09-22T12:00:00.000Z",
      view: {
        ok: true,
        empty: false,
        league: "super-lig",
        name: "Süper Lig",
        fetchedAt: "2026-09-22T12:00:00.000Z",
        divisions: 6,
        teams: 1,
        failedDivisions: [],
        rows: [{ games: 5, teamId: 1 }],
        idealRounds: [],
      },
    },
    { database: db },
  );
  for (const code of ["A1", "B1", "B2", "C1", "C2", "C3"]) {
    writeComputed(
      `mantra-ideal-table:v3:super-lig:${code}`,
      "v1",
      {
        ...idealSnapshot(["1", "2", "3", "4", "5"], [{ teamId: 1, gf: 5, ga: 4, gd: 1, points: 8 }]),
        view: {
          ...idealSnapshot(["1", "2", "3", "4", "5"], [{ teamId: 1, gf: 5, ga: 4, gd: 1, points: 8 }]).view,
          division: code,
        },
      },
      { database: db },
    );
  }
  warmIdealTables("super-lig", { database: db });
  assert.equal(queued.length, 0);
});
