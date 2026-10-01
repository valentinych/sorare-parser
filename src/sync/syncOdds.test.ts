import assert from "node:assert/strict";
import test from "node:test";
import type { AfOddsBookmaker } from "../clients/apiFootball.js";
import {
  anytimeScorersFromBet,
  parseFixtureOdds,
  popularScoreFromBet,
  topScoresFromBet,
} from "./syncOdds.js";

const matchWinner: AfOddsBookmaker["bets"][number] = {
  id: 1,
  name: "Match Winner",
  values: [
    { value: "Home", odd: "1.18" },
    { value: "Draw", odd: "7.50" },
    { value: "Away", odd: "15.00" },
  ],
};

test("popularScoreFromBet picks shortest Exact Score odds and skips buckets", () => {
  assert.equal(
    popularScoreFromBet({
      id: 10,
      name: "Exact Score",
      values: [
        { value: "1:0", odd: "8.00" },
        { value: "2:0", odd: "6.00" },
        { value: "2-1", odd: "11.00" },
        { value: "Any Other Home Win", odd: "3.50" },
      ],
    }),
    "2:0",
  );
  assert.equal(popularScoreFromBet(undefined), null);
});

test("topScoresFromBet returns top-3 with de-vigged probs", () => {
  const top = topScoresFromBet(
    {
      id: 10,
      name: "Exact Score",
      values: [
        { value: "1:0", odd: "8.00" },
        { value: "2:0", odd: "6.00" },
        { value: "2-1", odd: "11.00" },
        { value: "0:0", odd: "9.00" },
        { value: "Any Other Home Win", odd: "3.50" },
      ],
    },
    3,
  );
  assert.deepEqual(
    top?.map((r) => r.score),
    ["2:0", "1:0", "0:0"],
  );
  assert.ok(top && top[0]!.prob > top[1]!.prob);
});

test("anytimeScorersFromBet ranks by raw 1/odd and tags sides", () => {
  const sideByName = new Map<string, "home" | "away">([
    ["randal kolo muani", "home"],
    ["edon zhegrova", "away"],
  ]);
  const rows = anytimeScorersFromBet(
    {
      id: 92,
      name: "Anytime Goal Scorer",
      values: [
        { value: "Edon Zhegrova", odd: "2.75" },
        { value: "Randal Kolo Muani", odd: "2.50" },
        { value: "Giacomo Raspadori", odd: "4.00" },
        { value: "", odd: "1.10" },
      ],
    },
    sideByName,
    3,
  );
  assert.deepEqual(
    rows?.map((r) => ({ name: r.name, side: r.side, prob: r.prob })),
    [
      { name: "Randal Kolo Muani", side: "home", prob: 0.4 },
      { name: "Edon Zhegrova", side: "away", prob: 0.3636 },
      { name: "Giacomo Raspadori", side: undefined, prob: 0.25 },
    ],
  );
  assert.equal(anytimeScorersFromBet(undefined), null);
});

test("parseFixtureOdds keeps 1X2 bookmaker and falls back for Exact Score", () => {
  const bookmakers: AfOddsBookmaker[] = [
    {
      id: 8,
      name: "Bet365",
      bets: [
        matchWinner,
        {
          id: 27,
          name: "Clean Sheet - Home",
          values: [
            { value: "Yes", odd: "1.62" },
            { value: "No", odd: "2.20" },
          ],
        },
        {
          id: 28,
          name: "Clean Sheet - Away",
          values: [
            { value: "Yes", odd: "11.00" },
            { value: "No", odd: "1.05" },
          ],
        },
      ],
    },
    {
      id: 1,
      name: "10Bet",
      bets: [
        matchWinner,
        {
          id: 10,
          name: "Exact Score",
          values: [
            { value: "1:0", odd: "5.75" },
            { value: "2:0", odd: "4.75" },
            { value: "3:0", odd: "5.25" },
          ],
        },
      ],
    },
  ];
  const parsed = parseFixtureOdds(bookmakers);
  assert.equal(parsed?.bookmaker, "Bet365");
  assert.equal(parsed?.popularScore, "2:0");
  assert.deepEqual(
    parsed?.topScores?.map((r) => r.score),
    ["2:0", "3:0", "1:0"],
  );
  assert.ok(parsed?.homeCsProb != null && parsed.homeCsProb > 0.5);
  assert.equal(parsed?.anytimeScorers, null);
});

test("parseFixtureOdds falls back across bookmakers for Anytime Goal Scorer", () => {
  const bookmakers: AfOddsBookmaker[] = [
    {
      id: 8,
      name: "Bet365",
      bets: [matchWinner],
    },
    {
      id: 1,
      name: "10Bet",
      bets: [
        matchWinner,
        {
          id: 92,
          name: "Anytime Goal Scorer",
          values: [
            { value: "Lautaro Martinez", odd: "1.80" },
            { value: "Marcus Thuram", odd: "2.20" },
            { value: "Dušan Vlahović", odd: "2.10" },
          ],
        },
        {
          id: 231,
          name: "Home Anytime Goal Scorer",
          values: [
            { value: "Lautaro Martinez", odd: "1.80" },
            { value: "Marcus Thuram", odd: "2.20" },
          ],
        },
        {
          id: 218,
          name: "Away Anytime Goal Scorer",
          values: [{ value: "Dušan Vlahović", odd: "2.10" }],
        },
      ],
    },
  ];
  const parsed = parseFixtureOdds(bookmakers);
  assert.equal(parsed?.bookmaker, "Bet365");
  assert.deepEqual(
    parsed?.anytimeScorers?.map((r) => ({ name: r.name, side: r.side })),
    [
      { name: "Lautaro Martinez", side: "home" },
      { name: "Dušan Vlahović", side: "away" },
      { name: "Marcus Thuram", side: "home" },
    ],
  );
});
