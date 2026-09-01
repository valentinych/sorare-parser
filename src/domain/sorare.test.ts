import assert from "node:assert/strict";
import test from "node:test";
import type { SorarePlayer } from "../clients/sorare.js";
import {
  basisPointsToProbability,
  buildSorareExpectedXi,
  sorarePlayingProbability,
} from "./sorare.js";
import { sorareTeamKey, strictUniqueExact } from "../sync/syncSorare.js";

function player(name: string, position: string, starter: number | null): SorarePlayer {
  return {
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    displayName: name,
    position,
    nextClassicFixturePlayingStatusOdds:
      starter == null
        ? null
        : {
            starterOddsBasisPoints: starter,
            substituteOddsBasisPoints: 10_000 - starter,
            nonPlayingOddsBasisPoints: 0,
            reliability: "HIGH",
          },
  };
}

test("converts Sorare basis points and preserves missing values", () => {
  assert.equal(basisPointsToProbability(7_250), 0.725);
  assert.equal(basisPointsToProbability(null), null);
  assert.equal(sorarePlayingProbability(null), null);
});

test("normalizes legal club suffixes but does not fuzzy-match names", () => {
  assert.equal(sorareTeamKey("Beşiktaş Spor Kulübü"), "besiktas");
  assert.equal(sorareTeamKey("Arsenal FC"), "arsenal");
  const teams = [
    { id: 1, name: "Arsenal" },
    { id: 2, name: "Arsenal" },
  ];
  assert.equal(strictUniqueExact(teams, "arsenal", (team) => sorareTeamKey(team.name)), null);
  assert.equal(
    strictUniqueExact(teams.slice(0, 1), "arsenal", (team) => sorareTeamKey(team.name))?.id,
    1,
  );
});

test("builds a positional XI and ignores nullable predictions", () => {
  const players = [
    player("GK 1", "Goalkeeper", 9_000),
    ...Array.from({ length: 5 }, (_, index) =>
      player(`DEF ${index + 1}`, "Defender", 9_000 - index * 500),
    ),
    ...Array.from({ length: 4 }, (_, index) =>
      player(`MID ${index + 1}`, "Midfielder", 8_800 - index * 500),
    ),
    ...Array.from({ length: 4 }, (_, index) =>
      player(`FWD ${index + 1}`, "Forward", 8_700 - index * 500),
    ),
    player("No prediction", "Forward", null),
  ];
  const xi = buildSorareExpectedXi(players);
  assert.equal(xi.length, 11);
  assert.equal(xi.filter((row) => row.position === "Goalkeeper").length, 1);
  assert.equal(xi.filter((row) => row.position === "Defender").length, 4);
  assert.equal(xi.some((row) => row.name === "No prediction"), false);
});
