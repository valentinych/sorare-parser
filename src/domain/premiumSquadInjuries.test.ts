import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { resetComputedCacheForTests } from "../lib/computedCache.js";
import {
  afAbsenceRelevant,
  classifyAbsence,
  overlaySquadInjuries,
} from "./premiumSquadInjuries.js";
import type { PremiumSquadReportView, SquadReportPlayer } from "./premiumSquadReport.js";

test.afterEach(() => {
  resetComputedCacheForTests();
});

function player(partial: Partial<SquadReportPlayer>): SquadReportPlayer {
  return {
    mantraPlayerId: 1,
    displayName: "Kim Outed",
    surname: "Outed",
    clubCode: "LEE",
    positions: ["CB"],
    position: "CB",
    clubName: "Leeds",
    fotmobPlayerId: 1003,
    fotmobTeamId: 7,
    minutesByTour: [
      { tour: 1, minutes: 0, starter: false },
      { tour: 2, minutes: 0, starter: false },
    ],
    ratingAvg: null,
    ratingSource: "fotmob",
    mantraTsAvg: null,
    formScore: 0,
    auctionPrice: null,
    status: "OUT",
    reason: "футмопс",
    injury: { label: "OUT", expectedReturn: null, source: "footmops" },
    subNotes: [],
    ...partial,
  };
}

function view(players: SquadReportPlayer[]): PremiumSquadReportView {
  return {
    ok: true,
    teamId: 10,
    teamName: "Cardiff XI",
    tours: [1, 2],
    players,
    ratingSource: "fotmob",
    sofaScore: false,
    cachedAt: new Date().toISOString(),
    message: null,
    gaps: { sofaScore: true, fotmobInjuryReturn: true },
  };
}

test("classifyAbsence maps cards vs injury vs doubtful", () => {
  assert.equal(classifyAbsence("Red Card", "Missing Fixture"), "suspension");
  assert.equal(classifyAbsence("Knee Injury"), "injury");
  assert.equal(classifyAbsence("Doubtful"), "doubtful");
  assert.equal(afAbsenceRelevant("Inactive", "Missing Fixture"), false);
  assert.equal(afAbsenceRelevant("Hamstring Injury", "Missing Fixture"), true);
  assert.equal(afAbsenceRelevant("Red Card", "Missing Fixture"), true);
});

test("overlay prefers FotMob return date and API-Football reason without HTTP", async () => {
  const db = new Database(":memory:");
  const out = await overlaySquadInjuries(view([player({})]), {
    now: new Date("2026-09-22T00:00:00Z"),
    afLeagueId: 40,
    database: db,
    deps: {
      hasAfKey: () => true,
      season: 2026,
      fetchAfInjuries: async () => [
        {
          player: {
            id: 9,
            name: "Kim Outed",
            type: "Missing Fixture",
            reason: "Hamstring",
          },
          team: { id: 1, name: "Leeds United" },
          fixture: {
            id: 1,
            date: "2026-09-20T14:00:00Z",
            timestamp: Date.parse("2026-09-20T14:00:00Z") / 1000,
          },
        },
      ],
      fetchFotmobTeamInjuries: async () => [
        {
          playerId: 1003,
          name: "Kim Outed",
          injured: true,
          injuryName: null,
          expectedReturn: "Early October 2026",
        },
      ],
    },
  });
  const row = out.players[0];
  assert.equal(row?.status, "травма");
  assert.equal(row?.injury?.expectedReturn, "Early October 2026");
  assert.equal(row?.injury?.source, "fotmob");
  assert.match(row?.injury?.detail || "", /Hamstring|травма/);
  assert.equal(out.injuryMeta?.apiFootball, "hit");
  assert.equal(out.injuryMeta?.fotmob, "hit");
  assert.equal(out.gaps.apiFootballKey, false);
  assert.equal(out.gaps.fotmobInjuryReturn, false);
});

test("overlay skips API-Football when key is missing and still uses FotMob", async () => {
  const db = new Database(":memory:");
  let afCalls = 0;
  const out = await overlaySquadInjuries(view([player({})]), {
    now: new Date("2026-09-22T00:00:00Z"),
    afLeagueId: 40,
    database: db,
    deps: {
      hasAfKey: () => false,
      fetchAfInjuries: async () => {
        afCalls += 1;
        return [];
      },
      fetchFotmobTeamInjuries: async () => [
        {
          playerId: 1003,
          name: "Kim Outed",
          injured: true,
          injuryName: null,
          expectedReturn: "Unknown",
        },
      ],
    },
  });
  assert.equal(afCalls, 0);
  assert.equal(out.injuryMeta?.apiFootball, "no_key");
  assert.equal(out.players[0]?.status, "травма");
  assert.equal(out.players[0]?.injury?.expectedReturn, "неизвестно");
  assert.equal(out.gaps.apiFootballKey, true);
});

test("slow FotMob injuries still return the base squad rows", async () => {
  const db = new Database(":memory:");
  const out = await overlaySquadInjuries(view([player({ status: "—", injury: null })]), {
    now: new Date("2026-09-22T00:00:00Z"),
    afLeagueId: 40,
    database: db,
    budgetMs: 60,
    deps: {
      hasAfKey: () => false,
      fetchAfInjuries: async () => [],
      fetchFotmobTeamInjuries: (_teamId, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve([
              {
                playerId: 1003,
                name: "Kim Outed",
                injured: true,
                injuryName: null,
                expectedReturn: "Early October 2026",
              },
            ]);
          }, 2_000);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
    },
  });
  assert.equal(out.players[0]?.mantraPlayerId, 1);
  assert.equal(out.players[0]?.status, "—");
  assert.notEqual(out.players[0]?.injury?.source, "fotmob");
});
