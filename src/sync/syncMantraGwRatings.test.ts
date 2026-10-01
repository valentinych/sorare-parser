import assert from "node:assert/strict";
import test from "node:test";
import { fotmobIdsFromMantraScores, mantraGwScoresFromPlayers, mantraScoreFromLabel } from "./syncMantraGwRatings.js";
import { isNativeFotmobRating } from "../domain/mantraGwScores.js";

test("mantraScoreFromLabel keeps positive GW scores and drops dashes/zeros", () => {
  assert.equal(mantraScoreFromLabel("7.5"), 7.5);
  assert.equal(mantraScoreFromLabel("10,25"), 10.25);
  assert.equal(mantraScoreFromLabel("—"), null);
  assert.equal(mantraScoreFromLabel("0"), null);
  assert.equal(mantraScoreFromLabel(""), null);
  assert.equal(mantraScoreFromLabel(null), null);
});

test("fotmobIdsFromMantraScores maps owned players and keeps the higher score", () => {
  const links = new Map([
    [10, 1001],
    [11, 1002],
  ]);
  const out = fotmobIdsFromMantraScores(
    [
      { playerId: 10, scoreLabel: "6.5" },
      { playerId: 10, scoreLabel: "8.0" },
      { playerId: 11, scoreLabel: "—" },
      { playerId: 99, scoreLabel: "9.0" },
      { playerId: null, scoreLabel: "7.0" },
    ],
    links,
  );
  assert.equal(out.get(1001), 8);
  assert.equal(out.has(1002), false);
  assert.equal(out.size, 1);
});

test("mantraGwScoresFromPlayers keeps posted total + base by mantra id", () => {
  const rows = mantraGwScoresFromPlayers([
    { playerId: 7974, scoreLabel: "8.5", baseLabel: "6.5" },
    { playerId: 7974, scoreLabel: "9.0", baseLabel: "6.8" },
    { playerId: 1, scoreLabel: "—", baseLabel: "6.0" },
    { playerId: null, scoreLabel: "7.0", baseLabel: "6.0" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.playerId, 7974);
  assert.equal(rows[0]?.total, 9);
  assert.equal(rows[0]?.base, 6.8);
});

test("isNativeFotmobRating rejects UPL-style 0/null minutes copies", () => {
  assert.equal(isNativeFotmobRating(7.2, 90), true);
  assert.equal(isNativeFotmobRating(13.4, null), false);
  assert.equal(isNativeFotmobRating(0, 90), false);
  assert.equal(isNativeFotmobRating(null, 90), false);
  assert.equal(isNativeFotmobRating(6.5, 0), false);
});
