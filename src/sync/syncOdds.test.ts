import assert from "node:assert/strict";
import test from "node:test";
import type { AfOddsBookmaker } from "../clients/apiFootball.js";
import { parseFixtureOdds, popularScoreFromBet } from "./syncOdds.js";

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
  assert.ok(parsed?.homeCsProb != null && parsed.homeCsProb > 0.5);
});
