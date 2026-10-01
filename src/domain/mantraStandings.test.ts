import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  formatStandingsIdealPct,
  getChampionshipStandings,
  mergeDivisionStandings,
  movementFromHistory,
  normalizeMantraCrestUrl,
  officialRoundScore,
  parseDivisionResults,
  parseDivisionRoundScores,
  peekPlayedGames,
  peekRoundScoresByTeam,
  realOverIdealPct,
  resetMantraStandingsCacheForTests,
  resolveStandingsLeague,
  roundScoresFromHistory,
  sortStandingsRows,
  STANDINGS_TTL_MS,
  setStandingsScheduler,
  standingsLeagues,
  mergeIdealTsSources,
  withIdealTableStats,
  withIdealTs,
} from "./mantraStandings.js";
import {
  buildIdealDivisionTable,
  resolveIdealDivision,
} from "./mantraIdealTables.js";
import { resetComputedCacheForTests, writeComputed } from "../lib/computedCache.js";

function database() {
  return new Database(":memory:");
}

function resultRow(overrides: Record<string, unknown> = {}) {
  const team = {
    id: 1,
    human_name: "Alpha",
    logo_path: "https://mantrafootball.s3.eu-west-1.amazonaws.com/teams/alpha.png",
    ...(typeof overrides.team === "object" && overrides.team != null
      ? (overrides.team as Record<string, unknown>)
      : {}),
  };
  const { team: _ignored, ...rest } = overrides;
  return {
    matches_played: 7,
    wins: 5,
    draws: 1,
    loses: 1,
    scored_goals: 15,
    missed_goals: 9,
    goals_difference: 6,
    points: 16,
    total_score: "584.7",
    form: ["W", "W", "L", "W", "W"],
    next_opponent_id: 2,
    history: [null, { pos: 2 }, { pos: 1 }],
    team,
    ...rest,
  };
}

test.afterEach(() => {
  resetMantraStandingsCacheForTests();
  resetComputedCacheForTests();
});

test("standings catalog includes extra tables leagues", () => {
  const slugs = standingsLeagues().map((row) => row.slug);
  assert.ok(slugs.includes("championship"));
  assert.ok(slugs.includes("ligue-1"));
  assert.ok(slugs.includes("upl"));
  assert.ok(slugs.includes("brasileirao"));
  assert.ok(slugs.includes("managers"));
  assert.equal(resolveStandingsLeague("jupiler-pro-league")?.slug, "jupiler-pro-league");
  assert.equal(resolveStandingsLeague("managers"), null);
});

test("extra tables leagues return an empty snapshot on miss instead of blocking", async () => {
  const db = database();
  const view = await getChampionshipStandings("jupiler-pro-league", {
    schedule: () => {},
    database: db,
  });
  assert.equal(view.league, "jupiler-pro-league");
  assert.equal(view.cache, "miss");
  assert.equal(view.rows.length, 0);
  assert.ok(view.divisionOptions.some((row) => row.code === "A1"));
});

test("roundScoresFromHistory diffs cumulative history; null slots are missing GWs", () => {
  const scores = roundScoresFromHistory([
    null,
    { pos: 4, p: 1, sg: 2, mg: 2, w: 0, d: 1, l: 0, ts: "82.3" },
    { pos: 2, p: 4, sg: 4, mg: 3, w: 1, d: 1, l: 0, ts: "161.8" },
    { pos: 2, p: 7, sg: 7, mg: 4, w: 2, d: 1, l: 0, ts: "253.3" },
    { pos: 1, p: 10, sg: 9, mg: 5, w: 3, d: 1, l: 0, ts: "335.8" },
    { pos: 2, p: 10, sg: 10, mg: 7, w: 3, d: 1, l: 1, ts: "412.3" },
    null,
    { pos: 1, p: 13, sg: 13, mg: 8, w: 4, d: 1, l: 1, ts: "502.9" },
    { pos: 1, p: 16, sg: 15, mg: 9, w: 5, d: 1, l: 1, ts: "584.7" },
  ]);
  assert.deepEqual(
    scores.map((row) => ({ round: row.round, ts: row.ts, gf: row.gf, ga: row.ga })),
    [
      { round: 1, ts: 82.3, gf: 2, ga: 2 },
      { round: 2, ts: 79.5, gf: 2, ga: 1 },
      { round: 3, ts: 91.5, gf: 3, ga: 1 },
      { round: 4, ts: 82.5, gf: 2, ga: 1 },
      { round: 5, ts: 76.5, gf: 1, ga: 2 },
      { round: 7, ts: 90.6, gf: 3, ga: 1 },
      { round: 8, ts: 81.8, gf: 2, ga: 1 },
    ],
  );
  assert.equal(officialRoundScore(scores, 4)?.ts, 82.5);
  assert.equal(officialRoundScore(scores, 4)?.goals, 2);
  assert.equal(officialRoundScore(scores, 6), null);
  assert.equal(officialRoundScore(scores, 0), null);
  assert.deepEqual(roundScoresFromHistory(null), []);
});

test("parseDivisionRoundScores keeps per-team GW diffs from results payload", () => {
  const parsed = parseDivisionRoundScores([
    resultRow({
      team: { id: 1770, human_name: "edhar24" },
      history: [
        null,
        { pos: 4, sg: 2, mg: 2, ts: "82.3" },
        { pos: 2, sg: 4, mg: 3, ts: "161.8" },
      ],
    }),
  ]);
  assert.equal(parsed["1770"]?.find((row) => row.round === 1)?.ts, 82.3);
  assert.equal(parsed["1770"]?.find((row) => row.round === 2)?.ts, 79.5);
  assert.equal(parsed["1770"]?.find((row) => row.round === 2)?.gf, 2);
});

test("getChampionshipStandings caches per-round scores for the ideal table overlay", async () => {
  const db = database();
  const view = await getChampionshipStandings("championship", {
    database: db,
    serveStale: false,
    now: () => Date.parse("2026-09-22T10:00:00.000Z"),
    fetchResults: async (leagueId) => [
      resultRow({
        team: { id: leagueId, human_name: `Team ${leagueId}` },
        next_opponent_id: null,
        history: [
          null,
          { pos: 1, sg: 3, mg: 1, ts: "90.7" },
          { pos: 1, sg: 5, mg: 3, ts: "172.3" },
        ],
      }),
    ],
  });
  assert.equal(view.cache, "miss");
  const scores = peekRoundScoresByTeam("championship", db);
  assert.equal(scores.get(651)?.get(1)?.ts, 90.7);
  assert.equal(scores.get(651)?.get(1)?.goals, 3);
  assert.equal(scores.get(651)?.get(2)?.ts, 81.6);
  assert.equal(scores.get(651)?.get(2)?.goals, 2);
});

test("movementFromHistory is previous pos minus current pos", () => {
  assert.equal(movementFromHistory([null, { pos: 3 }, { pos: 1 }]), 2);
  assert.equal(movementFromHistory([null, { pos: 1 }, { pos: 4 }]), -3);
  assert.equal(movementFromHistory([null, { pos: 2 }]), 0);
  assert.equal(movementFromHistory(null), 0);
});

test("normalizeMantraCrestUrl keeps public Mantra HTTPS crests", () => {
  assert.equal(
    normalizeMantraCrestUrl(
      "https://mantrafootball.s3.eu-west-1.amazonaws.com/teams/alpha.png",
    ),
    "https://mantrafootball.s3.eu-west-1.amazonaws.com/teams/alpha.png",
  );
  assert.equal(normalizeMantraCrestUrl("http://evil.example/x.png"), null);
  assert.equal(normalizeMantraCrestUrl("https://evil.example/x.png"), null);
});

test("merge concatenates divisions, adds Division, and sorts by points then TS", () => {
  const a1 = [
    resultRow({
      points: 10,
      goals_difference: 5,
      scored_goals: 12,
      total_score: "80.0",
      next_opponent_id: 2,
      team: { id: 1, human_name: "Alpha" },
    }),
    resultRow({
      points: 10,
      goals_difference: 3,
      scored_goals: 10,
      total_score: "90.0",
      next_opponent_id: 1,
      team: { id: 2, human_name: "Beta" },
    }),
  ];
  const a2 = [
    resultRow({
      points: 12,
      goals_difference: 4,
      scored_goals: 11,
      total_score: "80.0",
      next_opponent_id: 4,
      team: { id: 3, human_name: "Gamma" },
    }),
    resultRow({
      points: 8,
      goals_difference: 0,
      scored_goals: 7,
      total_score: "70.0",
      next_opponent_id: 3,
      team: { id: 4, human_name: "Delta" },
    }),
  ];
  const rows = mergeDivisionStandings([
    { def: { leagueId: 651, division: "A1", name: "Cardiff" }, raw: a1 },
    { def: { leagueId: 652, division: "A2", name: "Swansea" }, raw: a2 },
  ]);

  assert.deepEqual(
    rows.map((row) => ({
      rank: row.rank,
      name: row.teamName,
      division: row.division,
      divisionRank: row.divisionRank,
      points: row.points,
    })),
    [
      { rank: 1, name: "Gamma", division: "A2", divisionRank: 1, points: 12 },
      { rank: 2, name: "Beta", division: "A1", divisionRank: 2, points: 10 },
      { rank: 3, name: "Alpha", division: "A1", divisionRank: 1, points: 10 },
      { rank: 4, name: "Delta", division: "A2", divisionRank: 2, points: 8 },
    ],
  );
  assert.equal(rows[1]?.ts, 90);
  assert.equal(rows[2]?.ts, 80);
  assert.equal(rows[1]?.movement, 1);
  assert.equal(rows[1]?.nextTeamName, "Alpha");
  assert.equal(rows[1]?.leagueName, "Cardiff");
  assert.equal(rows[0]?.division, "A2");
  assert.ok(rows.every((row) => "division" in row && row.division));
});

test("empty division code falls back to the city name", () => {
  const rows = parseDivisionResults(
    [resultRow({ team: { id: 10, human_name: "Venice FC" }, next_opponent_id: null })],
    { leagueId: 765, division: "", name: "Venice" },
  );
  assert.equal(rows[0]?.division, "Venice");
});

test("1 hour cache hit does not refetch; TTL expiry rebuilds", async () => {
  const db = database();
  let calls = 0;
  const fetchResults = async (leagueId: number) => {
    calls += 1;
    return [
      resultRow({
        points: calls,
        team: { id: leagueId, human_name: `Team ${leagueId}` },
        next_opponent_id: null,
      }),
    ];
  };
  const queued: Array<() => void | Promise<void>> = [];
  setStandingsScheduler((work) => {
    queued.push(work);
  });

  const t0 = Date.parse("2026-09-21T10:00:00.000Z");
  const first = await getChampionshipStandings("championship", {
    database: db,
    fetchResults,
    now: () => t0,
    serveStale: false,
  });
  assert.equal(first.cache, "miss");
  assert.equal(first.league, "championship");
  assert.ok(first.rows.length > 0);
  assert.ok(first.rows.every((row) => row.division));
  const afterFirst = calls;

  const hit = await getChampionshipStandings("championship", {
    database: db,
    fetchResults,
    now: () => t0 + STANDINGS_TTL_MS - 1,
    serveStale: false,
  });
  assert.equal(hit.cache, "hit");
  assert.equal(calls, afterFirst);
  assert.equal(hit.rows[0]?.points, first.rows[0]?.points);

  const expired = await getChampionshipStandings("championship", {
    database: db,
    fetchResults,
    now: () => t0 + STANDINGS_TTL_MS,
    serveStale: false,
  });
  assert.equal(expired.cache, "miss");
  assert.equal(calls, afterFirst * 2);

  const stale = await getChampionshipStandings("super-lig", {
    database: db,
    fetchResults,
    now: () => t0,
    serveStale: true,
  });
  assert.equal(stale.cache, "miss");
  const afterSuper = calls;
  const staleAgain = await getChampionshipStandings("super-lig", {
    database: db,
    fetchResults,
    now: () => t0 + STANDINGS_TTL_MS + 1,
    serveStale: true,
  });
  assert.equal(staleAgain.cache, "stale");
  assert.equal(calls, afterSuper);
  assert.equal(queued.length, 1);
  await queued[0]!();
  assert.ok(calls > afterSuper);
});

test("realOverIdealPct is TS/Ideal × 100 to two decimals; zero Ideal is dash", () => {
  assert.equal(realOverIdealPct(66.74, 69.87), 95.52);
  assert.equal(realOverIdealPct(80, 100), 80);
  assert.equal(realOverIdealPct(95.5, 100), 95.5);
  assert.equal(realOverIdealPct(584.7, 612.34), 95.49);
  assert.equal(realOverIdealPct(300.4, 360.5), 83.33);
  assert.equal(realOverIdealPct(370.7, 432.2), 85.77);
  assert.equal(realOverIdealPct(10, 0), null);
  assert.equal(realOverIdealPct(10, -1), null);
  assert.equal(formatStandingsIdealPct(95.5), "95.50%");
  assert.equal(formatStandingsIdealPct(95.52), "95.52%");
  assert.equal(formatStandingsIdealPct(80), "80.00%");
  assert.equal(formatStandingsIdealPct(null), "—");
});

test("withIdealTs joins by team id and leaves missing Ideal as dash fields", () => {
  const rows = mergeDivisionStandings([
    {
      def: { leagueId: 651, division: "A1", name: "Cardiff" },
      raw: [
        resultRow({
          points: 12,
          total_score: "100.0",
          team: { id: 1, human_name: "Alpha" },
          next_opponent_id: null,
        }),
        resultRow({
          points: 8,
          total_score: "80.0",
          team: { id: 2, human_name: "Beta" },
          next_opponent_id: null,
        }),
      ],
    },
  ]);
  const view = withIdealTs(
    {
      ok: true,
      empty: false,
      league: "championship",
      name: "Championship",
      cache: "hit",
      fetchedAt: "2026-09-21T10:00:00.000Z",
      divisions: 1,
      teams: 2,
      failedDivisions: [],
      rows,
      idealRounds: [],
      leagues: [],
      divisionOptions: [],
    },
    { byTeamId: new Map([[1, 110.5]]), realByTeamId: new Map([[1, 100]]), rounds: ["1", "2", "3"] },
  );
  assert.deepEqual(view.idealRounds, ["1", "2", "3"]);
  assert.equal(view.rows[0]?.teamName, "Alpha");
  assert.equal(view.rows[0]?.idealTs, 110.5);
  assert.equal(view.rows[0]?.idealPct, 90.5);
  assert.equal(formatStandingsIdealPct(view.rows[0]?.idealPct), "90.50%");
  assert.equal(view.rows[1]?.teamName, "Beta");
  assert.equal(view.rows[1]?.idealTs, null);
  assert.equal(view.rows[1]?.idealPct, null);
});

test("withIdealTs % uses Mantra season TS / Ideal TS, not Real XI", () => {
  const rows = mergeDivisionStandings([
    {
      def: { leagueId: 742, division: "B2", name: "Turin" },
      raw: [
        resultRow({
          points: 4,
          matches_played: 4,
          total_score: "300.4",
          team: { id: 1, human_name: "Kaliostroteam" },
          next_opponent_id: null,
        }),
      ],
    },
  ]);
  const view = withIdealTs(
    {
      ok: true,
      empty: false,
      league: "serie-a",
      name: "Serie A",
      cache: "hit",
      fetchedAt: "2026-09-21T10:00:00.000Z",
      divisions: 1,
      teams: 1,
      failedDivisions: [],
      rows,
      idealRounds: [],
      leagues: [],
      divisionOptions: [],
    },
    {
      byTeamId: new Map([[1, 360.5]]),
      realByTeamId: new Map([[1, 240]]),
      rounds: ["1", "2", "3", "4"],
    },
  );
  assert.equal(view.rows[0]?.ts, 300.4);
  assert.equal(view.rows[0]?.idealTs, 360.5);
  assert.equal(realOverIdealPct(300.4, 360.5), 83.33);
  assert.equal(view.rows[0]?.idealPct, 83.33);
  assert.notEqual(view.rows[0]?.idealPct, realOverIdealPct(240, 360.5));
  assert.equal(formatStandingsIdealPct(view.rows[0]?.idealPct), "83.33%");
});

test("mergeIdealTsSources prefers season-ideal and fills extra-league table TS", () => {
  const season = {
    byTeamId: new Map([
      [1, 460.53],
      [2, 0],
    ]),
    realByTeamId: new Map([[1, 430]]),
    rounds: ["1", "2", "3", "4", "5"],
  };
  const table = {
    byTeamId: new Map([
      [1, 400],
      [2, 399],
      [88, 471.63],
    ]),
    rounds: ["1", "2", "3", "4", "5"],
  };
  const merged = mergeIdealTsSources(season, table);
  assert.equal(merged.byTeamId.get(1), 460.53);
  assert.equal(merged.byTeamId.get(2), 0);
  assert.equal(merged.byTeamId.get(88), 471.63);
  assert.deepEqual(merged.rounds, ["1", "2", "3", "4", "5"]);
  assert.equal(merged.realByTeamId?.get(1), 430);

  const extraOnly = mergeIdealTsSources(
    { byTeamId: new Map(), rounds: [] },
    { byTeamId: new Map([[88, 471.63]]), rounds: ["1", "2", "3", "4", "5"] },
  );
  assert.equal(extraOnly.byTeamId.get(88), 471.63);
  assert.deepEqual(extraOnly.rounds, ["1", "2", "3", "4", "5"]);

  const view = withIdealTs(
    {
      ok: true,
      empty: false,
      league: "ligue-1",
      name: "Ligue 1",
      cache: "hit",
      fetchedAt: "2026-09-24T10:00:00.000Z",
      divisions: 1,
      teams: 1,
      failedDivisions: [],
      rows: [
        {
          rank: 1,
          divisionRank: 1,
          movement: 0,
          teamId: 88,
          teamName: "ComboAD",
          teamLogo: null,
          division: "C1",
          leagueId: 738,
          leagueName: "Strasbourg",
          games: 5,
          wins: 4,
          draws: 0,
          loses: 1,
          gf: 10,
          ga: 6,
          gd: 4,
          points: 12,
          ts: 440.7,
          form: [],
          nextTeamId: null,
          nextTeamName: null,
          nextTeamLogo: null,
          idealTs: null,
          idealPct: null,
          iGf: null,
          iGa: null,
          iGd: null,
          iPts: null,
        },
      ],
      idealRounds: [],
      leagues: [],
      divisionOptions: [],
    },
    extraOnly,
  );
  assert.equal(view.rows[0]?.idealTs, 471.63);
  assert.equal(view.rows[0]?.idealPct, 93.44);
  assert.deepEqual(view.idealRounds, ["1", "2", "3", "4", "5"]);
});

test("withIdealTs treats zero Ideal (failed pick) as dash, not 0.00%", () => {
  const rows = mergeDivisionStandings([
    {
      def: { leagueId: 742, division: "C6", name: "Messina" },
      raw: [
        resultRow({
          points: 4,
          matches_played: 4,
          total_score: "328.7",
          team: { id: 2532, human_name: "Di_Bomzhe" },
          next_opponent_id: null,
        }),
      ],
    },
  ]);
  const view = withIdealTs(
    {
      ok: true,
      empty: false,
      league: "serie-a",
      name: "Serie A",
      cache: "hit",
      fetchedAt: "2026-09-21T10:00:00.000Z",
      divisions: 1,
      teams: 1,
      failedDivisions: [],
      rows,
      idealRounds: [],
      leagues: [],
      divisionOptions: [],
    },
    { byTeamId: new Map([[2532, 0]]), realByTeamId: new Map([[2532, 399.72]]), rounds: ["1", "2", "3", "4", "5"] },
  );
  assert.equal(view.rows[0]?.ts, 328.7);
  assert.equal(view.rows[0]?.idealTs, null);
  assert.equal(view.rows[0]?.idealPct, null);
  assert.equal(formatStandingsIdealPct(view.rows[0]?.idealPct), "—");
});

test("sortStandingsRows first click desc, tiebreak POINTS then TS, missing Ideal last", () => {
  const rows = mergeDivisionStandings([
    {
      def: { leagueId: 651, division: "A1", name: "Cardiff" },
      raw: [
        resultRow({
          points: 10,
          total_score: "90.0",
          team: { id: 1, human_name: "Alpha" },
          next_opponent_id: null,
        }),
        resultRow({
          points: 12,
          total_score: "70.0",
          team: { id: 2, human_name: "Beta" },
          next_opponent_id: null,
        }),
        resultRow({
          points: 10,
          total_score: "80.0",
          team: { id: 3, human_name: "Gamma" },
          next_opponent_id: null,
        }),
      ],
    },
  ]);
  const withIdeal = rows.map((row) => {
    if (row.teamId === 1) return { ...row, idealTs: 100, idealPct: 90 };
    if (row.teamId === 3) return { ...row, idealTs: 120, idealPct: 66.67 };
    return { ...row, idealTs: null, idealPct: null };
  });

  const byIdealDesc = sortStandingsRows(withIdeal, "idealTs", "desc");
  assert.deepEqual(
    byIdealDesc.map((row) => row.teamName),
    ["Gamma", "Alpha", "Beta"],
  );

  const byIdealAsc = sortStandingsRows(withIdeal, "idealTs", "asc");
  assert.deepEqual(
    byIdealAsc.map((row) => row.teamName),
    ["Alpha", "Gamma", "Beta"],
  );

  const byPctDesc = sortStandingsRows(withIdeal, "idealPct", "desc");
  assert.deepEqual(
    byPctDesc.map((row) => row.teamName),
    ["Alpha", "Gamma", "Beta"],
  );

  const sameIdeal = withIdeal.map((row) =>
    row.teamName === "Beta" ? row : { ...row, idealTs: 100, idealPct: 90 },
  );
  const tied = sortStandingsRows(sameIdeal, "idealTs", "desc");
  assert.deepEqual(
    tied.map((row) => row.teamName),
    ["Alpha", "Gamma", "Beta"],
  );
  assert.equal(tied[0]?.points, 10);
  assert.equal(tied[0]?.ts, 90);
  assert.equal(tied[1]?.ts, 80);
});

test("empty A1 results are retried and then merged into the combined table", async () => {
  const db = database();
  const seen: number[] = [];
  const fetchResults = async (leagueId: number) => {
    seen.push(leagueId);
    if (leagueId === 583 && seen.filter((id) => id === 583).length === 1) return [];
    return [
      resultRow({
        team: { id: leagueId, human_name: `Team ${leagueId}` },
        next_opponent_id: null,
      }),
    ];
  };

  const view = await getChampionshipStandings("ekstraklasa", {
    database: db,
    fetchResults,
    now: () => Date.parse("2026-09-22T08:00:00.000Z"),
    serveStale: false,
  });
  assert.equal(view.failedDivisions.length, 0);
  assert.equal(view.divisions, 4);
  assert.equal(view.teams, 4);
  assert.deepEqual(
    [...new Set(view.rows.map((row) => row.division))].sort(),
    ["A1", "B1", "B2", "C1"],
  );
  assert.equal(seen.filter((id) => id === 583).length, 2);
  assert.ok(view.rows.some((row) => row.leagueId === 583 && row.division === "A1"));
});

test("incomplete standings (missing A1) are not a 1h cache hit", async () => {
  const db = database();
  let calls = 0;
  const fetchResults = async (leagueId: number) => {
    calls += 1;
    if (leagueId === 583) throw new Error("timeout");
    return [
      resultRow({
        team: { id: leagueId, human_name: `Team ${leagueId}` },
        next_opponent_id: null,
      }),
    ];
  };

  const first = await getChampionshipStandings("ekstraklasa", {
    database: db,
    fetchResults,
    now: () => Date.parse("2026-09-22T08:00:00.000Z"),
    serveStale: false,
  });
  assert.deepEqual(
    first.failedDivisions.map((item) => item.division),
    ["A1"],
  );
  assert.equal(first.failedDivisions[0]?.leagueId, 583);
  assert.ok(!first.rows.some((row) => row.division === "A1"));
  const afterFirst = calls;

  const again = await getChampionshipStandings("ekstraklasa", {
    database: db,
    fetchResults,
    now: () => Date.parse("2026-09-22T08:00:01.000Z"),
    serveStale: false,
  });
  assert.equal(again.cache, "miss");
  assert.ok(calls > afterFirst);
  assert.deepEqual(
    again.failedDivisions.map((item) => item.division),
    ["A1"],
  );
});

function emptyView(rows: ReturnType<typeof mergeDivisionStandings>) {
  return {
    ok: true,
    empty: false,
    league: "championship",
    name: "Championship",
    cache: "hit" as const,
    fetchedAt: "2026-09-22T10:00:00.000Z",
    divisions: 1,
    teams: rows.length,
    failedDivisions: [],
    rows,
    idealRounds: [],
    leagues: [],
    divisionOptions: [],
  };
}

function idealXi(goals: number) {
  return {
    mantraPlayerId: 1,
    fotmobPlayerId: 1,
    name: "Fwd",
    displayName: "Fwd",
    clubName: "Club",
    positions: ["FW"],
    slotLabel: "FW",
    baseScore: 10,
    totalScore: 10,
    events: goals > 0 ? [{ key: "goal" as const, count: goals, delta: goals * 3 }] : [],
    minutes: 90,
    rating: 7,
  };
}

test("withIdealTableStats joins iGf/iGa/iGd/iPts; missing Ideal is dash not 0", () => {
  const rows = mergeDivisionStandings([
    {
      def: { leagueId: 651, division: "A1", name: "Cardiff" },
      raw: [
        resultRow({
          points: 12,
          team: { id: 1, human_name: "Alpha" },
          next_opponent_id: null,
        }),
        resultRow({
          points: 8,
          team: { id: 2, human_name: "Beta" },
          next_opponent_id: null,
        }),
      ],
    },
  ]);
  const view = withIdealTableStats(
    emptyView(rows),
    new Map([[1, { gf: 9, ga: 4, gd: 5, points: 16 }]]),
  );
  assert.equal(view.rows[0]?.iGf, 9);
  assert.equal(view.rows[0]?.iGa, 4);
  assert.equal(view.rows[0]?.iGd, 5);
  assert.equal(view.rows[0]?.iPts, 16);
  assert.equal(view.rows[1]?.iGf, null);
  assert.equal(view.rows[1]?.iGa, null);
  assert.equal(view.rows[1]?.iGd, null);
  assert.equal(view.rows[1]?.iPts, null);
});

test("iPts matches Ideal division POINTS; a 2–2 draw is 1 iPts", () => {
  const a1 = resolveIdealDivision("super-lig", "A1")!;
  const built = buildIdealDivisionTable(a1, [
    {
      round: "6",
      toursRound: 6,
      tours: [
        {
          tourId: 1,
          leagueId: a1.leagueId,
          division: "A1",
          name: "Istanbul",
          label: "A1 | Istanbul",
          round: 6,
          live: false,
          url: "/tours/1",
          deadline: null,
          deadlineLabel: null,
          syncedAt: "2026-09-22T10:00:00.000Z",
          matches: [
            {
              matchId: 1,
              url: null,
              locked: true,
              home: { teamId: 1, teamName: "Home", logoUrl: null, score: null, scoredCount: null, goals: null },
              away: { teamId: 2, teamName: "Away", logoUrl: null, score: null, scoredCount: null, goals: null },
            },
          ],
        },
      ],
      idealRows: [
        { teamId: 1, teamName: "Home", idealTotal: 90, idealXi: [idealXi(4)] },
        { teamId: 2, teamName: "Away", idealTotal: 70, idealXi: [idealXi(0)] },
      ],
    },
    {
      round: "7",
      toursRound: 7,
      tours: [
        {
          tourId: 2,
          leagueId: a1.leagueId,
          division: "A1",
          name: "Istanbul",
          label: "A1 | Istanbul",
          round: 7,
          live: false,
          url: "/tours/2",
          deadline: null,
          deadlineLabel: null,
          syncedAt: "2026-09-22T10:00:00.000Z",
          matches: [
            {
              matchId: 2,
              url: null,
              locked: true,
              home: { teamId: 1, teamName: "Home", logoUrl: null, score: null, scoredCount: null, goals: null },
              away: { teamId: 2, teamName: "Away", logoUrl: null, score: null, scoredCount: null, goals: null },
            },
          ],
        },
      ],
      idealRows: [
        { teamId: 1, teamName: "Home", idealTotal: 80, idealXi: [idealXi(2)] },
        { teamId: 2, teamName: "Away", idealTotal: 81, idealXi: [idealXi(2)] },
      ],
    },
  ]);
  const home = built.rows.find((row) => row.teamId === 1)!;
  assert.equal(home.wins, 1);
  assert.equal(home.draws, 1);
  assert.equal(home.points, 4);
  assert.equal(home.gf, 5);
  assert.equal(home.ga, 2);
  assert.equal(home.gd, 3);

  const rows = mergeDivisionStandings([
    {
      def: a1,
      raw: [
        resultRow({
          points: 10,
          team: { id: 1, human_name: "Home" },
          next_opponent_id: null,
        }),
        resultRow({
          points: 1,
          team: { id: 2, human_name: "Away" },
          next_opponent_id: null,
        }),
      ],
    },
  ]);
  const view = withIdealTableStats(
    emptyView(rows),
    new Map(built.rows.map((row) => [row.teamId, { gf: row.gf, ga: row.ga, gd: row.gd, points: row.points }])),
  );
  const joined = view.rows.find((row) => row.teamId === 1);
  assert.equal(joined?.iPts, home.points);
  assert.equal(joined?.iPts, 4);
  assert.equal(joined?.iGf, 5);
  assert.equal(joined?.iGa, 2);
  assert.equal(joined?.iGd, 3);
  assert.equal(view.rows.find((row) => row.teamId === 2)?.iPts, 1);
});

test("sortStandingsRows by iPts tiebreaks iGd then iGf; missing last", () => {
  const rows = mergeDivisionStandings([
    {
      def: { leagueId: 651, division: "A1", name: "Cardiff" },
      raw: [
        resultRow({ points: 10, total_score: "90", team: { id: 1, human_name: "Alpha" }, next_opponent_id: null }),
        resultRow({ points: 12, total_score: "70", team: { id: 2, human_name: "Beta" }, next_opponent_id: null }),
        resultRow({ points: 8, total_score: "80", team: { id: 3, human_name: "Gamma" }, next_opponent_id: null }),
      ],
    },
  ]).map((row) => {
    if (row.teamId === 1) return { ...row, iGf: 5, iGa: 4, iGd: 1, iPts: 10 };
    if (row.teamId === 3) return { ...row, iGf: 8, iGa: 5, iGd: 3, iPts: 10 };
    return { ...row, iGf: null, iGa: null, iGd: null, iPts: null };
  });
  const byPts = sortStandingsRows(rows, "iPts", "desc");
  assert.deepEqual(
    byPts.map((row) => row.teamName),
    ["Gamma", "Alpha", "Beta"],
  );
  const sameGd = rows.map((row) =>
    row.teamId === 1 || row.teamId === 3 ? { ...row, iGd: 2, iGf: row.teamId === 3 ? 9 : 4 } : row,
  );
  const byGf = sortStandingsRows(sameGd, "iPts", "desc");
  assert.deepEqual(
    byGf.map((row) => row.teamName),
    ["Gamma", "Alpha", "Beta"],
  );
});

test("standings serve a previous prefix without refetching Mantra", async () => {
  const db = database();
  let calls = 0;
  const divisions = ["A1", "A2", "B1", "B2", "B3", "B4", "C1"];
  writeComputed(
    "mantra-standings:v2:championship",
    "v1",
    {
      fetchedAt: "2026-09-22T10:00:00.000Z",
      view: {
        ok: true,
        empty: false,
        league: "championship",
        name: "Championship",
        fetchedAt: "2026-09-22T10:00:00.000Z",
        divisions: divisions.length,
        teams: divisions.length,
        failedDivisions: [],
        rows: divisions.map((division, index) => ({
          rank: index + 1,
          divisionRank: 1,
          movement: 0,
          teamId: index + 1,
          teamName: `Team ${division}`,
          teamLogo: null,
          division,
          leagueId: 651 + index,
          leagueName: division,
          games: 5,
          wins: 5,
          draws: 0,
          loses: 0,
          gf: 10,
          ga: 2,
          gd: 8,
          points: 15,
          ts: 400,
          form: [],
          nextTeamId: null,
          nextTeamName: null,
          nextTeamLogo: null,
          idealTs: null,
          idealPct: null,
          iGf: null,
          iGa: null,
          iGd: null,
          iPts: null,
        })),
        idealRounds: [],
      },
    },
    { database: db },
  );
  const view = await getChampionshipStandings("championship", {
    database: db,
    now: () => Date.parse("2026-09-22T10:30:00.000Z"),
    fetchResults: async () => {
      calls += 1;
      return [];
    },
  });
  assert.equal(view.cache, "hit");
  assert.equal(view.rows[0]?.games, 5);
  assert.equal(calls, 0);
});

test("peekPlayedGames uses results-history round when it is ahead of GAMES", () => {
  const db = database();
  writeComputed(
    "mantra-standings:v3:championship",
    "v1",
    {
      fetchedAt: "2026-09-22T10:00:00.000Z",
      view: {
        ok: true,
        empty: false,
        league: "championship",
        name: "Championship",
        fetchedAt: "2026-09-22T10:00:00.000Z",
        divisions: 1,
        teams: 1,
        failedDivisions: [],
        rows: [{ games: 5, teamId: 1 }],
        idealRounds: [],
      },
      roundScoresByTeam: {
        "1": [
          { round: 1, ts: 80, gf: 2, ga: 1 },
          { round: 6, ts: 70, gf: 1, ga: 1 },
        ],
      },
    },
    { database: db },
  );
  assert.equal(peekPlayedGames("championship", db), 6);
});
